/**
 * EVE Chat v0.1 - Integration Adapter
 * Connects weather.js / proactive.js to the existing EVE Chat without rewriting its core.
 */
(function (window, document) {
    'use strict';

    const CONFIG_KEY = 'eve_adapter_settings_v1';
    const DEFAULTS = {
        enabled: true,
        autoEnableProactive: true,
        debug: false
    };

    let oneShotInstruction = '';
    let originalFetch = null;

    function loadConfig() {
        try {
            return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'));
        } catch (_) {
            return Object.assign({}, DEFAULTS);
        }
    }

    function log() {
        if (!loadConfig().debug) return;
        console.log('[EVE Adapter]', ...arguments);
    }

    function buildContext() {
        const chunks = [];
        if (window.EVEWeather && typeof window.EVEWeather.getPromptContext === 'function') {
            const weather = window.EVEWeather.getPromptContext();
            if (weather) chunks.push(weather);
        }
        if (window.EVEProactive && typeof window.EVEProactive.getPromptContext === 'function') {
            const activity = window.EVEProactive.getPromptContext();
            if (activity) chunks.push(activity);
        }
        if (oneShotInstruction) chunks.push(oneShotInstruction);
        return chunks.filter(Boolean).join('\n\n');
    }

    function appendTextPart(container, text) {
        if (!text) return;
        if (!container.parts || !Array.isArray(container.parts)) container.parts = [];
        container.parts.push({ text });
    }

    function injectGeminiContext(body) {
        if (!body || typeof body !== 'object') return body;
        const context = buildContext();
        if (!context) return body;

        const cloned = JSON.parse(JSON.stringify(body));
        const instruction = [
            '以下是 EVE Chat 提供的即時背景資訊。請自然地融入角色反應，但不要逐條朗讀，也不要聲稱自己正在讀取系統資料。',
            context
        ].join('\n\n');

        if (cloned.systemInstruction && typeof cloned.systemInstruction === 'object') {
            appendTextPart(cloned.systemInstruction, instruction);
        } else if (cloned.system_instruction && typeof cloned.system_instruction === 'object') {
            appendTextPart(cloned.system_instruction, instruction);
        } else {
            cloned.systemInstruction = { parts: [{ text: instruction }] };
        }
        return cloned;
    }

    function installFetchHook() {
        if (originalFetch || typeof window.fetch !== 'function') return;
        originalFetch = window.fetch.bind(window);
        window.fetch = async function (input, init) {
            try {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                if (/generativelanguage\.googleapis\.com|gemini/i.test(url) && init && typeof init.body === 'string') {
                    const parsed = JSON.parse(init.body);
                    init = Object.assign({}, init, { body: JSON.stringify(injectGeminiContext(parsed)) });
                }
            } catch (error) {
                log('Prompt context injection skipped:', error);
            }

            try {
                return await originalFetch(input, init);
            } finally {
                // A proactive instruction applies to only one Gemini request.
                oneShotInstruction = '';
            }
        };
    }

    function findSmartReplyButton() {
        const buttons = Array.from(document.querySelectorAll('button[onclick]'));
        return buttons.find(btn => (btn.getAttribute('onclick') || '').includes('triggerSmartReply')) || null;
    }

    async function requestProactiveMessage(payload) {
        if (!loadConfig().enabled) return false;
        const smartReply = typeof window.triggerSmartReply === 'function'
            ? window.triggerSmartReply
            : null;
        const button = findSmartReplyButton();

        if (!smartReply && !button) {
            console.warn('[EVE Adapter] 找不到 triggerSmartReply，已保留事件供後續版本接線。');
            return false;
        }

        const activity = payload && payload.activity ? payload.activity : null;
        oneShotInstruction = [
            '[主動訊息模式]',
            '請讓目前聊天中的角色主動傳一則自然、簡短且符合人設的訊息給使用者。',
            '這不是使用者剛傳來的新訊息，不要把它寫成問答回覆，也不要提到系統、排程或觸發器。',
            activity && activity.label ? `角色當前狀態：${activity.label}` : '',
            payload && payload.reason ? `觸發情境：${payload.reason}` : ''
        ].filter(Boolean).join('\n');

        try {
            if (smartReply) {
                await smartReply();
            } else {
                button.click();
            }
            return true;
        } catch (error) {
            oneShotInstruction = '';
            console.error('[EVE Adapter] 主動訊息觸發失敗：', error);
            return false;
        }
    }

    function markInteraction() {
        if (window.EVEProactive && typeof window.EVEProactive.markUserInteraction === 'function') {
            window.EVEProactive.markUserInteraction();
        }
    }

    function syncCitySoon() {
        setTimeout(function () {
            if (window.EVEWeather && typeof window.EVEWeather.syncFromLocationForm === 'function') {
                window.EVEWeather.syncFromLocationForm().catch(() => {});
            }
        }, 300);
    }

    function init() {
        installFetchHook();

        document.addEventListener('click', markInteraction, { passive: true });
        document.addEventListener('keydown', markInteraction, { passive: true });
        document.addEventListener('touchstart', markInteraction, { passive: true });

        document.addEventListener('change', function (event) {
            const id = event.target && event.target.id;
            if (id === 'character-city-name' || id === 'character-city-prototype') syncCitySoon();
        });

        window.addEventListener('eve:proactive-message-request', function (event) {
            requestProactiveMessage(event.detail || {});
        });

        window.EVEProactiveAdapter = {
            sendMessage: requestProactiveMessage
        };

        const config = loadConfig();
        if (config.autoEnableProactive && window.EVEProactive && typeof window.EVEProactive.configure === 'function') {
            window.EVEProactive.configure({ enabled: true });
        }

        window.EVEAdapter = {
            configure(next) {
                const merged = Object.assign({}, loadConfig(), next || {});
                localStorage.setItem(CONFIG_KEY, JSON.stringify(merged));
                return merged;
            },
            getSettings: loadConfig,
            getPromptContext: buildContext,
            triggerProactiveNow() {
                if (window.EVEProactive && typeof window.EVEProactive.triggerNow === 'function') {
                    return window.EVEProactive.triggerNow();
                }
                return requestProactiveMessage({ reason: 'manual-test' });
            }
        };

        log('Initialized');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})(window, document);
