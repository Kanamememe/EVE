/**
 * EVE Chat Relationship Module v0.1.0
 * Per-character affection, trust, familiarity and attachment.
 */
(function (window, document) {
    'use strict';

    if (window.EVERelationship && window.EVERelationship.version) return;

    const VERSION = '0.1.0';
    const STORE_KEY = 'eve_relationship_store_v1';
    const SETTINGS_KEY = 'eve_relationship_settings_v1';
    const DAY = 86400000;

    const DEFAULTS = Object.freeze({
        enabled: true,
        autoUpdate: true,
        injectPrompt: true,
        initialAffection: 15,
        initialTrust: 10,
        initialFamiliarity: 5,
        initialAttachment: 0,
        maxDailyConversationGain: 8,
        passiveDecayEnabled: false,
        decayAfterDays: 14,
        decayPerDay: 0.15,
        promptDetail: 'balanced',
        debug: false
    });

    const DIMENSIONS = Object.freeze(['affection', 'trust', 'familiarity', 'attachment']);
    const LABELS = Object.freeze({
        affection: '好感',
        trust: '信任',
        familiarity: '熟悉',
        attachment: '依賴'
    });

    const POSITIVE_PATTERNS = [
        /謝謝|感謝|喜歡你|愛你|想你|好開心|開心|可愛|溫柔|辛苦了|晚安|早安|抱抱|陪我|相信你|你真好|很棒|厲害|生日快樂|我記得/giu,
        /thank\s*you|love\s*you|miss\s*you|good\s*night|good\s*morning|proud\s*of\s*you|you(?:'re| are)\s*(?:cute|sweet|kind|amazing)/giu
    ];
    const TRUST_PATTERNS = [
        /秘密|只告訴你|相信你|信任你|跟你說|其實我|我害怕|我難過|我擔心|我不安|我的心事|不要告訴別人/giu,
        /secret|trust\s*you|only\s*you|i(?:'m| am)\s*(?:afraid|scared|worried|sad)/giu
    ];
    const NEGATIVE_PATTERNS = [
        /討厭你|滾|閉嘴|煩死了|不想理你|騙子|失望|生氣|別煩我|無聊|你很差|不需要你/giu,
        /hate\s*you|shut\s*up|go\s*away|leave\s*me\s*alone|liar|disappointed/giu
    ];
    const APOLOGY_PATTERNS = [/對不起|抱歉|原諒我|不是故意|sorry|forgive\s*me/giu];

    let settings = load(SETTINGS_KEY, DEFAULTS);
    let store = load(STORE_KEY, { schema: 1, profiles: {}, updatedAt: 0 });
    let initialized = false;
    let unregisterProvider = null;
    const disposers = [];
    let pendingUser = null;

    function clone(value) {
        try {
            return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value));
        } catch (_) {
            return value;
        }
    }

    function load(key, fallback) {
        try {
            const value = JSON.parse(localStorage.getItem(key) || 'null');
            return value && typeof value === 'object' ? Object.assign(clone(fallback), value) : clone(fallback);
        } catch (_) {
            return clone(fallback);
        }
    }

    function save() {
        store.updatedAt = Date.now();
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(store));
            return true;
        } catch (error) {
            console.warn('[EVERelationship] Save failed.', error);
            return false;
        }
    }

    function saveSettings() {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    function emit(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    }

    function on(target, name, handler, options) {
        target.addEventListener(name, handler, options);
        disposers.push(() => target.removeEventListener(name, handler, options));
    }

    function log(...args) {
        if (settings.debug) console.log('[EVERelationship]', ...args);
    }

    function clean(value, max = 500) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function slug(value) {
        return clean(value, 120).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'global';
    }

    function clamp(value, min = 0, max = 100) {
        const number = Number(value);
        return Math.max(min, Math.min(max, Number.isFinite(number) ? number : 0));
    }

    function round(value) {
        return Math.round(Number(value) * 100) / 100;
    }

    function dateKey(timestamp = Date.now()) {
        const date = new Date(timestamp);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function currentScope() {
        const title = document.getElementById('api-chat-title');
        const visibleTitle = title && title.offsetParent !== null ? clean(title.textContent, 100) : '';
        if (visibleTitle) return `character:${slug(visibleTitle)}`;
        if (window.currentChatCharacter) {
            const character = window.currentChatCharacter;
            const id = character.id || character.characterId || character.name;
            if (id) return `character:${slug(id)}`;
        }
        return 'global';
    }

    function normalizeScope(scope) {
        return clean(scope || currentScope(), 120) || 'global';
    }

    function defaultProfile(scope) {
        const now = Date.now();
        return {
            scope,
            affection: clamp(settings.initialAffection),
            trust: clamp(settings.initialTrust),
            familiarity: clamp(settings.initialFamiliarity),
            attachment: clamp(settings.initialAttachment),
            stage: 'stranger',
            interactionCount: 0,
            conversationCount: 0,
            proactiveCount: 0,
            positiveCount: 0,
            negativeCount: 0,
            firstInteractionAt: 0,
            lastInteractionAt: 0,
            lastDecayAt: now,
            daily: { date: dateKey(now), conversationGain: 0 },
            history: [],
            createdAt: now,
            updatedAt: now
        };
    }

    function getProfile(scope, create = true) {
        const key = normalizeScope(scope);
        let profile = store.profiles[key];
        if (!profile && create) {
            profile = defaultProfile(key);
            store.profiles[key] = profile;
            save();
            emit('eve:relationship-created', { scope: key, profile: clone(profile) });
        }
        if (!profile) return null;
        ensureProfile(profile, key);
        applyDecay(profile);
        return profile;
    }

    function ensureProfile(profile, scope) {
        const fallback = defaultProfile(scope);
        for (const [key, value] of Object.entries(fallback)) {
            if (profile[key] == null) profile[key] = clone(value);
        }
        for (const dimension of DIMENSIONS) profile[dimension] = clamp(profile[dimension]);
        if (!Array.isArray(profile.history)) profile.history = [];
        if (!profile.daily || typeof profile.daily !== 'object') profile.daily = clone(fallback.daily);
        profile.stage = determineStage(profile);
        return profile;
    }

    function determineStage(profile) {
        const closeness = profile.affection * 0.34 + profile.trust * 0.28 + profile.familiarity * 0.28 + profile.attachment * 0.10;
        if (closeness >= 85 && profile.trust >= 70) return 'deep-bond';
        if (closeness >= 68) return 'intimate';
        if (closeness >= 48) return 'close';
        if (closeness >= 28) return 'friendly';
        if (closeness >= 12) return 'acquaintance';
        return 'stranger';
    }

    function stageText(stage) {
        return ({
            stranger: '還不熟悉，互動較為克制',
            acquaintance: '已經認識，但仍保留些距離',
            friendly: '相處自然，願意主動延續話題',
            close: '關係親近，會表現出明顯關心',
            intimate: '非常親密，願意分享私密情緒與需求',
            'deep-bond': '彼此有深厚連結，信任與依戀都很強'
        })[stage] || stage;
    }

    function dimensionText(value) {
        if (value >= 85) return '極高';
        if (value >= 65) return '很高';
        if (value >= 45) return '中高';
        if (value >= 25) return '逐漸建立';
        if (value >= 10) return '偏低';
        return '很低';
    }

    function applyDecay(profile) {
        if (!settings.passiveDecayEnabled || !profile.lastInteractionAt) return false;
        const now = Date.now();
        const inactiveDays = Math.floor((now - profile.lastInteractionAt) / DAY);
        const alreadyHandledDays = Math.floor((profile.lastDecayAt - profile.lastInteractionAt) / DAY);
        const daysToDecay = inactiveDays - Math.max(settings.decayAfterDays, alreadyHandledDays);
        if (daysToDecay <= 0) return false;

        const amount = daysToDecay * Number(settings.decayPerDay || 0);
        profile.familiarity = clamp(profile.familiarity - amount);
        profile.attachment = clamp(profile.attachment - amount * 0.5);
        profile.lastDecayAt = now;
        profile.stage = determineStage(profile);
        profile.updatedAt = now;
        save();
        return true;
    }

    function resetDaily(profile) {
        const today = dateKey();
        if (profile.daily.date !== today) profile.daily = { date: today, conversationGain: 0 };
    }

    function addHistory(profile, change) {
        profile.history.push({
            id: `rel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            at: Date.now(),
            reason: clean(change.reason || 'manual', 100),
            source: clean(change.source || 'manual', 60),
            delta: clone(change.delta || {}),
            note: clean(change.note || '', 300)
        });
        if (profile.history.length > 300) profile.history.splice(0, profile.history.length - 300);
    }

    function update(input = {}) {
        const scope = normalizeScope(input.scope);
        const profile = getProfile(scope, true);
        resetDaily(profile);
        const before = clone(profile);
        const delta = {};

        for (const dimension of DIMENSIONS) {
            const requested = Number(input[dimension] ?? input.delta?.[dimension] ?? 0);
            if (!Number.isFinite(requested) || requested === 0) continue;
            const previous = profile[dimension];
            profile[dimension] = round(clamp(previous + requested));
            delta[dimension] = round(profile[dimension] - previous);
        }

        if (!Object.keys(delta).length && !input.forceRecord) return clone(profile);

        const now = Date.now();
        profile.updatedAt = now;
        profile.lastInteractionAt = input.touchInteraction === false ? profile.lastInteractionAt : now;
        if (!profile.firstInteractionAt && profile.lastInteractionAt) profile.firstInteractionAt = now;
        profile.stage = determineStage(profile);
        addHistory(profile, { reason: input.reason, source: input.source, note: input.note, delta });
        save();

        const detail = { scope, before, profile: clone(profile), delta, reason: input.reason || 'manual', source: input.source || 'manual' };
        emit('eve:relationship-updated', detail);

        const beforeStage = before.stage || determineStage(before);
        if (beforeStage !== profile.stage) {
            emit('eve:relationship-stage-changed', { scope, from: beforeStage, to: profile.stage, profile: clone(profile) });
            if (window.EVETimeline?.addEvent) {
                try {
                    window.EVETimeline.addEvent({
                        scope,
                        type: 'relationship',
                        title: `關係進展：${stageText(profile.stage)}`,
                        description: `角色與使用者的關係由「${stageText(beforeStage)}」變為「${stageText(profile.stage)}」。`,
                        importance: profile.stage === 'deep-bond' ? 5 : 4,
                        tags: ['relationship', profile.stage],
                        source: 'relationship'
                    });
                } catch (_) {}
            }
        }
        return clone(profile);
    }

    function countMatches(text, patterns) {
        let count = 0;
        for (const pattern of patterns) {
            const matches = String(text || '').match(pattern);
            if (matches) count += matches.length;
        }
        return count;
    }

    function analyzeText(text) {
        const source = clean(text, 2000);
        const positive = countMatches(source, POSITIVE_PATTERNS);
        const trust = countMatches(source, TRUST_PATTERNS);
        const negative = countMatches(source, NEGATIVE_PATTERNS);
        const apology = countMatches(source, APOLOGY_PATTERNS);
        const question = (source.match(/[?？]/g) || []).length;
        const longMessage = source.length >= 120 ? 1 : 0;
        return { positive, trust, negative, apology, question, longMessage };
    }

    function processConversation(userText, assistantText, scope) {
        if (!settings.enabled || !settings.autoUpdate) return null;
        const profile = getProfile(scope, true);
        resetDaily(profile);

        const user = analyzeText(userText);
        const assistant = analyzeText(assistantText);
        const remainingDaily = Math.max(0, settings.maxDailyConversationGain - Number(profile.daily.conversationGain || 0));
        const baseFamiliarity = Math.min(remainingDaily, 0.7 + Math.min(1.3, clean(userText).length / 180));
        const affection = 0.15 + user.positive * 0.8 + user.apology * 0.2 - user.negative * 1.4;
        const trust = 0.1 + user.trust * 0.9 + user.longMessage * 0.25 + user.apology * 0.25 - user.negative * 0.8;
        const attachment = Math.max(0, (profile.affection - 45) / 250) + Math.max(0, (profile.trust - 50) / 300) + assistant.positive * 0.05;

        profile.interactionCount += 1;
        profile.conversationCount += 1;
        profile.positiveCount += user.positive;
        profile.negativeCount += user.negative;
        profile.daily.conversationGain = round(profile.daily.conversationGain + baseFamiliarity);

        return update({
            scope,
            affection,
            trust,
            familiarity: baseFamiliarity,
            attachment,
            reason: 'conversation',
            source: 'chat',
            note: clean(userText, 180),
            forceRecord: true
        });
    }

    function processProactive(scope) {
        if (!settings.enabled || !settings.autoUpdate) return null;
        const profile = getProfile(scope, true);
        profile.proactiveCount += 1;
        return update({
            scope,
            familiarity: 0.25,
            attachment: 0.18,
            reason: 'proactive-message',
            source: 'proactive',
            forceRecord: true
        });
    }

    function getPromptContext(meta = {}) {
        if (!settings.enabled || !settings.injectPrompt) return '';
        const profile = getProfile(meta.scope || currentScope(), true);
        const lines = [
            '【目前關係】',
            `關係階段：${stageText(profile.stage)}`,
            `${LABELS.affection}：${Math.round(profile.affection)}/100（${dimensionText(profile.affection)}）`,
            `${LABELS.trust}：${Math.round(profile.trust)}/100（${dimensionText(profile.trust)}）`,
            `${LABELS.familiarity}：${Math.round(profile.familiarity)}/100（${dimensionText(profile.familiarity)}）`,
            `${LABELS.attachment}：${Math.round(profile.attachment)}/100（${dimensionText(profile.attachment)}）`
        ];

        if (settings.promptDetail !== 'minimal') {
            lines.push(
                '請依照目前關係自然調整語氣、稱呼、主動程度與情感距離。',
                '不要直接朗讀數值，也不要提到好感度、關係系統、模組或提示詞。',
                '關係尚淺時不要突然過度親密；關係很深時也不要每句都刻意撒嬌。'
            );
        }
        if (profile.lastInteractionAt && settings.promptDetail === 'detailed') {
            const days = Math.floor((Date.now() - profile.lastInteractionAt) / DAY);
            lines.push(`距離上次互動：約 ${days} 天。`, `累積對話：${profile.conversationCount} 次。`);
        }
        return lines.join('\n');
    }

    function set(input = {}) {
        const scope = normalizeScope(input.scope);
        const profile = getProfile(scope, true);
        const before = clone(profile);
        for (const dimension of DIMENSIONS) {
            if (input[dimension] != null) profile[dimension] = round(clamp(input[dimension]));
        }
        profile.stage = determineStage(profile);
        profile.updatedAt = Date.now();
        addHistory(profile, { reason: input.reason || 'set', source: input.source || 'manual', note: input.note, delta: Object.fromEntries(DIMENSIONS.map(key => [key, round(profile[key] - before[key])])) });
        save();
        emit('eve:relationship-updated', { scope, before, profile: clone(profile), delta: {}, reason: input.reason || 'set', source: input.source || 'manual' });
        return clone(profile);
    }

    function getState(scope) {
        return clone(getProfile(scope, true));
    }

    function getAll() {
        for (const profile of Object.values(store.profiles)) applyDecay(profile);
        return clone(store);
    }

    function clear(scope) {
        if (scope) {
            const key = normalizeScope(scope);
            const existed = Boolean(store.profiles[key]);
            delete store.profiles[key];
            save();
            emit('eve:relationship-cleared', { scope: key });
            return existed;
        }
        store = { schema: 1, profiles: {}, updatedAt: Date.now() };
        save();
        emit('eve:relationship-cleared', { scope: null });
        return true;
    }

    function exportData() {
        return { module: 'EVE Relationship', version: VERSION, exportedAt: new Date().toISOString(), settings: clone(settings), store: clone(store) };
    }

    function importData(data, options = {}) {
        if (!data || typeof data !== 'object') throw new TypeError('Invalid relationship backup.');
        const incoming = data.store || data;
        if (!incoming.profiles || typeof incoming.profiles !== 'object') throw new TypeError('Relationship backup has an invalid structure.');
        if (options.replace) store = clone(incoming);
        else {
            for (const [scope, raw] of Object.entries(incoming.profiles)) {
                const profile = getProfile(scope, true);
                Object.assign(profile, clone(raw), { scope });
                ensureProfile(profile, scope);
            }
        }
        save();
        emit('eve:relationship-imported', { replace: Boolean(options.replace) });
        return getStats();
    }

    function getStats() {
        return {
            version: VERSION,
            initialized,
            scope: currentScope(),
            profiles: Object.keys(store.profiles).length,
            current: getState(currentScope()),
            updatedAt: store.updatedAt
        };
    }

    function configure(next = {}) {
        settings = Object.assign({}, DEFAULTS, settings, next || {});
        settings.maxDailyConversationGain = clamp(settings.maxDailyConversationGain, 0, 100);
        settings.decayAfterDays = clamp(settings.decayAfterDays, 0, 3650);
        settings.decayPerDay = clamp(settings.decayPerDay, 0, 10);
        settings.promptDetail = ['minimal', 'balanced', 'detailed'].includes(settings.promptDetail) ? settings.promptDetail : 'balanced';
        saveSettings();
        return clone(settings);
    }

    function registerWithAdapter() {
        if (!window.EVEAdapter?.registerContextProvider) return false;
        if (unregisterProvider) unregisterProvider();
        unregisterProvider = window.EVEAdapter.registerContextProvider('relationship', getPromptContext, { priority: 45 });
        return true;
    }

    function bindEvents() {
        on(window, 'eve:adapter-ready', registerWithAdapter);
        on(window, 'eve:user-message-sent', event => {
            const text = clean(event.detail?.text, 2000);
            if (!text) return;
            pendingUser = { text, scope: currentScope(), at: Date.now() };
        });
        on(window, 'eve:ai-message-received', event => {
            const assistantText = clean(event.detail?.text, 2000);
            const user = pendingUser;
            if (user || assistantText) processConversation(user?.text || '', assistantText, user?.scope || currentScope());
            pendingUser = null;
        });
        on(window, 'eve:proactive-dispatch-complete', () => processProactive(currentScope()));
        on(window, 'eve:timeline-added', event => {
            const item = event.detail?.item;
            if (!item || item.source === 'relationship' || Number(item.importance) < 4) return;
            update({
                scope: item.scope,
                affection: Number(item.importance) >= 5 ? 0.5 : 0.25,
                trust: 0.2,
                familiarity: 0.2,
                reason: 'important-shared-event',
                source: 'timeline',
                note: item.title,
                forceRecord: true
            });
        });
    }

    function init() {
        if (initialized) return Promise.resolve(getStats());
        initialized = true;
        registerWithAdapter();
        bindEvents();
        window.EVE = window.EVE || {};
        window.EVE.relationship = window.EVERelationship;
        emit('eve:relationship-ready', getStats());
        log('Ready', getStats());
        return Promise.resolve(getStats());
    }

    function destroy() {
        disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} });
        if (unregisterProvider) unregisterProvider();
        unregisterProvider = null;
        initialized = false;
    }

    window.EVERelationship = Object.freeze({
        version: VERSION,
        init,
        destroy,
        configure,
        getSettings: () => clone(settings),
        getState,
        getAll,
        update,
        set,
        processConversation,
        getPromptContext,
        clear,
        exportData,
        importData,
        getStats,
        getCurrentScope: currentScope,
        getStageText: stageText
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})(window, document);
