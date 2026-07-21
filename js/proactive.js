/**
 * EVE Chat - AI 主動聊天與生活狀態模組
 * 檔名：proactive.js
 *
 * 依賴：
 * - weather.js（可選，但建議先載入）
 *
 * 功能：
 * 1. 根據角色所在地時間判斷睡覺、吃飯、工作、休息等狀態
 * 2. 支援固定間隔與隨機間隔主動訊息
 * 3. 支援延遲發送
 * 4. 預設不直接修改 EVE Chat 原本聊天邏輯
 * 5. 透過事件或 Adapter 與原本聊天系統串接
 *
 * 在 index.html 的 </body> 前依序加入：
 * <script src="js/weather.js"></script>
 * <script src="js/proactive.js"></script>
 */

(function (window, document) {
    'use strict';

    const SETTINGS_KEY = 'eve_proactive_settings_v1';
    const STATE_KEY = 'eve_proactive_state_v1';
    const LOG_KEY = 'eve_proactive_log_v1';

    const DEFAULT_SETTINGS = {
        enabled: false,

        // fixed：固定間隔；random：隨機間隔
        intervalMode: 'random',
        fixedIntervalMinutes: 180,
        randomMinMinutes: 90,
        randomMaxMinutes: 300,

        // 觸發後額外延遲多久才真正發送
        delayMinMinutes: 1,
        delayMaxMinutes: 8,

        // 使用者多久沒有互動後才允許主動聊天
        idleRequiredMinutes: 60,

        // 夜間避免打擾
        quietHoursEnabled: true,
        quietStartHour: 0,
        quietEndHour: 8,

        // 每天最多主動發送次數
        dailyLimit: 4,

        // 是否將時間、天氣、生活狀態交給 AI
        includeEnvironment: true,
        includeActivity: true,

        // 是否自動更新狀態
        statusEnabled: true,
        statusRefreshMinutes: 5
    };

    const ACTIVITIES = [
        {
            id: 'sleeping',
            icon: '🌙',
            label: '睡覺中',
            start: 0,
            end: 7,
            prompt: '角色目前正在睡覺。除非是特殊情況，暫時不要主動發送訊息。'
        },
        {
            id: 'waking',
            icon: '☀️',
            label: '剛起床',
            start: 7,
            end: 9,
            prompt: '角色剛起床，狀態還有些慵懶。'
        },
        {
            id: 'working',
            icon: '💼',
            label: '忙碌中',
            start: 9,
            end: 12,
            prompt: '角色正在處理白天的工作或日常安排。'
        },
        {
            id: 'lunch',
            icon: '🍜',
            label: '吃午餐',
            start: 12,
            end: 14,
            prompt: '角色正在吃午餐或短暫休息。'
        },
        {
            id: 'afternoon',
            icon: '☕',
            label: '正在活動',
            start: 14,
            end: 18,
            prompt: '角色正在進行下午的工作、學習或外出活動。'
        },
        {
            id: 'dinner',
            icon: '🍽️',
            label: '吃晚餐',
            start: 18,
            end: 20,
            prompt: '角色正在吃晚餐或剛結束晚餐。'
        },
        {
            id: 'relaxing',
            icon: '🏠',
            label: '休息中',
            start: 20,
            end: 23,
            prompt: '角色已經結束白天的事情，正在家中休息。'
        },
        {
            id: 'late-night',
            icon: '🌃',
            label: '準備睡覺',
            start: 23,
            end: 24,
            prompt: '時間已晚，角色正在放鬆並準備睡覺。'
        }
    ];

    let mainTimer = null;
    let delayedTimer = null;
    let statusTimer = null;
    let currentActivity = null;

    function safeParse(value, fallback) {
        try {
            return value ? JSON.parse(value) : fallback;
        } catch (error) {
            console.warn('[EVEProactive] 儲存資料解析失敗：', error);
            return fallback;
        }
    }

    function loadSettings() {
        return Object.assign(
            {},
            DEFAULT_SETTINGS,
            safeParse(localStorage.getItem(SETTINGS_KEY), {})
        );
    }

    function saveSettings(partialSettings) {
        const next = Object.assign({}, loadSettings(), partialSettings || {});
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
        return next;
    }

    function loadState() {
        return Object.assign(
            {
                lastUserInteractionAt: Date.now(),
                lastProactiveAt: 0,
                nextScheduledAt: 0,
                dailyDate: '',
                dailyCount: 0
            },
            safeParse(localStorage.getItem(STATE_KEY), {})
        );
    }

    function saveState(partialState) {
        const next = Object.assign({}, loadState(), partialState || {});
        localStorage.setItem(STATE_KEY, JSON.stringify(next));
        return next;
    }

    function randomInt(min, max) {
        const low = Math.ceil(Math.min(min, max));
        const high = Math.floor(Math.max(min, max));
        return Math.floor(Math.random() * (high - low + 1)) + low;
    }

    function getEnvironment() {
        if (window.EVEWeather && typeof window.EVEWeather.getEnvironment === 'function') {
            return window.EVEWeather.getEnvironment();
        }

        return window.EVE && window.EVE.environment
            ? window.EVE.environment
            : null;
    }

    function getLocalHour() {
        const environment = getEnvironment();

        if (environment && environment.localTime) {
            const hour = Number(String(environment.localTime).split(':')[0]);
            if (Number.isFinite(hour)) return hour;
        }

        return new Date().getHours();
    }

    function getLocalDateKey() {
        const environment = getEnvironment();
        if (environment && environment.localDate) {
            return environment.localDate;
        }

        const now = new Date();
        return [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0')
        ].join('-');
    }

    function getActivityByHour(hour) {
        return ACTIVITIES.find(function (activity) {
            return hour >= activity.start && hour < activity.end;
        }) || ACTIVITIES[0];
    }

    function applyWeatherVariation(activity) {
        const environment = getEnvironment();
        if (!environment) return Object.assign({}, activity);

        const next = Object.assign({}, activity);

        if (
            ['小雨', '中雨', '大雨', '陣雨', '強陣雨', '雷雨'].some(function (word) {
                return String(environment.weather || '').includes(word);
            }) &&
            ['afternoon', 'relaxing'].includes(next.id)
        ) {
            next.icon = '🌧️';
            next.label = '在室內躲雨';
            next.prompt += ' 外面正在下雨，因此角色目前更可能待在室內。';
        }

        if (
            Number(environment.temperature) <= 8 &&
            ['waking', 'afternoon', 'relaxing'].includes(next.id)
        ) {
            next.label = next.id === 'waking' ? '賴床中' : '待在溫暖的地方';
            next.prompt += ' 天氣寒冷，角色傾向待在溫暖的室內。';
        }

        if (
            Number(environment.temperature) >= 30 &&
            ['afternoon', 'relaxing'].includes(next.id)
        ) {
            next.label = '正在避暑';
            next.prompt += ' 天氣炎熱，角色正待在較涼快的地方。';
        }

        return next;
    }

    function updateActivity() {
        const hour = getLocalHour();
        const activity = applyWeatherVariation(getActivityByHour(hour));
        const changed =
            !currentActivity ||
            currentActivity.id !== activity.id ||
            currentActivity.label !== activity.label;

        currentActivity = Object.assign({}, activity, {
            localHour: hour,
            updatedAt: new Date().toISOString()
        });

        window.EVE = window.EVE || {};
        window.EVE.activity = currentActivity;

        if (changed) {
            window.dispatchEvent(
                new CustomEvent('eve:activity-updated', {
                    detail: currentActivity
                })
            );
        }

        return currentActivity;
    }

    function isQuietHour(hour, settings) {
        if (!settings.quietHoursEnabled) return false;

        const start = Number(settings.quietStartHour);
        const end = Number(settings.quietEndHour);

        if (start === end) return false;

        if (start < end) {
            return hour >= start && hour < end;
        }

        return hour >= start || hour < end;
    }

    function normalizeDailyCount(state) {
        const today = getLocalDateKey();

        if (state.dailyDate !== today) {
            return saveState({
                dailyDate: today,
                dailyCount: 0
            });
        }

        return state;
    }

    function getIdleMinutes() {
        const state = loadState();
        return Math.max(
            0,
            Math.floor((Date.now() - Number(state.lastUserInteractionAt || 0)) / 60000)
        );
    }

    function canTrigger() {
        const settings = loadSettings();
        let state = normalizeDailyCount(loadState());

        if (!settings.enabled) {
            return { allowed: false, reason: 'disabled' };
        }

        if (Number(state.dailyCount) >= Number(settings.dailyLimit)) {
            return { allowed: false, reason: 'daily-limit' };
        }

        const activity = updateActivity();
        if (activity.id === 'sleeping') {
            return { allowed: false, reason: 'sleeping' };
        }

        const hour = getLocalHour();
        if (isQuietHour(hour, settings)) {
            return { allowed: false, reason: 'quiet-hours' };
        }

        const idleMinutes = getIdleMinutes();
        if (idleMinutes < Number(settings.idleRequiredMinutes)) {
            return {
                allowed: false,
                reason: 'not-idle-enough',
                idleMinutes: idleMinutes
            };
        }

        return {
            allowed: true,
            settings: settings,
            state: state,
            activity: activity,
            idleMinutes: idleMinutes
        };
    }

    function getNextIntervalMinutes(settings) {
        if (settings.intervalMode === 'fixed') {
            return Math.max(10, Number(settings.fixedIntervalMinutes) || 180);
        }

        return randomInt(
            Math.max(10, Number(settings.randomMinMinutes) || 90),
            Math.max(10, Number(settings.randomMaxMinutes) || 300)
        );
    }

    function clearMainTimer() {
        if (mainTimer) {
            clearTimeout(mainTimer);
            mainTimer = null;
        }
    }

    function clearDelayedTimer() {
        if (delayedTimer) {
            clearTimeout(delayedTimer);
            delayedTimer = null;
        }
    }

    function scheduleNext() {
        clearMainTimer();

        const settings = loadSettings();
        if (!settings.enabled) return;

        const minutes = getNextIntervalMinutes(settings);
        const nextScheduledAt = Date.now() + minutes * 60 * 1000;

        saveState({ nextScheduledAt: nextScheduledAt });

        mainTimer = setTimeout(function () {
            attemptTrigger();
        }, minutes * 60 * 1000);

        console.info(`[EVEProactive] 下次檢查：約 ${minutes} 分鐘後`);
    }

    function buildPromptContext() {
        const settings = loadSettings();
        const activity = updateActivity();
        const sections = [];

        sections.push('【主動聊天情境】');
        sections.push(`角色目前狀態：${activity.icon} ${activity.label}`);

        if (settings.includeActivity) {
            sections.push(activity.prompt);
        }

        if (
            settings.includeEnvironment &&
            window.EVEWeather &&
            typeof window.EVEWeather.getPromptContext === 'function'
        ) {
            const environmentPrompt = window.EVEWeather.getPromptContext();
            if (environmentPrompt) sections.push(environmentPrompt);
        }

        sections.push(
            '請根據角色人設與最近聊天內容，自然地主動傳送一則短訊息。',
            '不要提到系統、排程、天氣 API 或「主動聊天功能」。',
            '不要每次都使用問句，也可以分享正在做的事、感受或一個生活片段。',
            '訊息應自然且符合角色關係，不要突然過度熱情。'
        );

        return sections.join('\n');
    }

    function createPayload() {
        return {
            type: 'proactive-message-request',
            createdAt: new Date().toISOString(),
            activity: updateActivity(),
            environment: getEnvironment(),
            promptContext: buildPromptContext(),
            idleMinutes: getIdleMinutes()
        };
    }

    async function requestSend(payload) {
        /**
         * 最推薦的串接方式：
         *
         * window.EVEProactiveAdapter = {
         *   sendMessage: async function(payload) {
         *      // 在這裡呼叫 EVE Chat 原本的 Gemini 生成函式
         *   }
         * };
         */
        if (
            window.EVEProactiveAdapter &&
            typeof window.EVEProactiveAdapter.sendMessage === 'function'
        ) {
            return window.EVEProactiveAdapter.sendMessage(payload);
        }

        // 沒有 Adapter 時，只發出事件，不會破壞原本聊天功能。
        window.dispatchEvent(
            new CustomEvent('eve:proactive-message-request', {
                detail: payload
            })
        );

        return { queued: true, via: 'event' };
    }

    function appendLog(entry) {
        const log = safeParse(localStorage.getItem(LOG_KEY), []);
        log.unshift(entry);
        localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, 100)));
    }

    async function sendNow() {
        const check = canTrigger();

        if (!check.allowed) {
            console.info('[EVEProactive] 本次略過：', check.reason);
            scheduleNext();
            return null;
        }

        const payload = createPayload();

        try {
            const result = await requestSend(payload);
            const state = normalizeDailyCount(loadState());

            saveState({
                lastProactiveAt: Date.now(),
                dailyDate: getLocalDateKey(),
                dailyCount: Number(state.dailyCount || 0) + 1
            });

            appendLog({
                success: true,
                sentAt: new Date().toISOString(),
                payload: payload
            });

            window.dispatchEvent(
                new CustomEvent('eve:proactive-message-sent', {
                    detail: {
                        payload: payload,
                        result: result
                    }
                })
            );

            return result;
        } catch (error) {
            console.error('[EVEProactive] 主動訊息發送失敗：', error);

            appendLog({
                success: false,
                sentAt: new Date().toISOString(),
                error: error.message,
                payload: payload
            });

            throw error;
        } finally {
            scheduleNext();
        }
    }

    function attemptTrigger() {
        const check = canTrigger();

        if (!check.allowed) {
            console.info('[EVEProactive] 暫不觸發：', check.reason);
            scheduleNext();
            return;
        }

        const settings = loadSettings();
        const delayMinutes = randomInt(
            Math.max(0, Number(settings.delayMinMinutes) || 0),
            Math.max(0, Number(settings.delayMaxMinutes) || 0)
        );

        clearDelayedTimer();

        if (delayMinutes <= 0) {
            sendNow();
            return;
        }

        console.info(`[EVEProactive] 已觸發，將延遲 ${delayMinutes} 分鐘發送`);

        delayedTimer = setTimeout(function () {
            sendNow();
        }, delayMinutes * 60 * 1000);
    }

    function markUserInteraction() {
        saveState({
            lastUserInteractionAt: Date.now()
        });
    }

    function attachInteractionListeners() {
        const events = ['pointerdown', 'keydown', 'touchstart'];

        events.forEach(function (eventName) {
            document.addEventListener(
                eventName,
                function () {
                    markUserInteraction();
                },
                { passive: true }
            );
        });

        // 原本聊天程式也可以主動呼叫：
        // EVEProactive.markUserInteraction()
    }

    function startStatusTimer() {
        if (statusTimer) {
            clearInterval(statusTimer);
            statusTimer = null;
        }

        const settings = loadSettings();
        if (!settings.statusEnabled) return;

        const minutes = Math.max(
            1,
            Number(settings.statusRefreshMinutes) || 5
        );

        updateActivity();

        statusTimer = setInterval(function () {
            updateActivity();
        }, minutes * 60 * 1000);
    }

    function start() {
        const settings = loadSettings();

        startStatusTimer();

        if (settings.enabled) {
            scheduleNext();
        }
    }

    function stop() {
        clearMainTimer();
        clearDelayedTimer();

        if (statusTimer) {
            clearInterval(statusTimer);
            statusTimer = null;
        }
    }

    function configure(partialSettings) {
        const settings = saveSettings(partialSettings);

        stop();
        start();

        window.dispatchEvent(
            new CustomEvent('eve:proactive-settings-updated', {
                detail: settings
            })
        );

        return settings;
    }

    function getStatusText() {
        const activity = currentActivity || updateActivity();
        return `${activity.icon} ${activity.label}`;
    }

    function getLog() {
        return safeParse(localStorage.getItem(LOG_KEY), []);
    }

    function init() {
        updateActivity();
        attachInteractionListeners();
        start();
    }

    window.EVEProactive = {
        init,
        start,
        stop,
        configure,
        getSettings: loadSettings,
        getState: loadState,
        getActivity: function () {
            return currentActivity || updateActivity();
        },
        getStatusText,
        getPromptContext: buildPromptContext,
        markUserInteraction,
        triggerNow: sendNow,
        testTrigger: function () {
            const payload = createPayload();

            window.dispatchEvent(
                new CustomEvent('eve:proactive-message-test', {
                    detail: payload
                })
            );

            return payload;
        },
        getLog
    };

    // 天氣更新時同步刷新角色狀態。
    window.addEventListener('eve:environment-updated', function () {
        updateActivity();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})(window, document);
