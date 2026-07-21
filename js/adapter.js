/**
 * EVE Chat Adapter v0.2.0
 * Stable bridge between the large legacy index.html and independent EVE modules.
 */
(function (window, document) {
    'use strict';

    if (window.EVEAdapter && window.EVEAdapter.version) return;

    const VERSION = '0.2.0';
    const CONFIG_KEY = 'eve_adapter_settings_v2';
    const DEFAULTS = Object.freeze({
        enabled: true,
        autoEnableProactive: true,
        injectWeather: true,
        injectActivity: true,
        trackUserMessages: true,
        debug: false
    });

    const providers = new Map();
    const disposers = [];
    let config = loadConfig();
    let originalFetch = null;
    let initialized = false;
    let oneShotContext = '';
    let oneShotExpiresAt = 0;
    let lastGeminiRequestAt = 0;
    let lastGeminiResponseAt = 0;

    function loadConfig() {
        try {
            return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'));
        } catch (_) {
            return Object.assign({}, DEFAULTS);
        }
    }

    function saveConfig(next) {
        config = Object.assign({}, DEFAULTS, config, next || {});
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
        return Object.assign({}, config);
    }

    function log(...args) {
        if (config.debug) console.log('[EVEAdapter]', ...args);
    }

    function emit(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    }

    function on(target, name, handler, options) {
        target.addEventListener(name, handler, options);
        disposers.push(() => target.removeEventListener(name, handler, options));
    }

    function clone(value) {
        try {
            return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value));
        } catch (_) {
            return value;
        }
    }

    function registerContextProvider(id, provider, options) {
        if (!id || typeof provider !== 'function') throw new TypeError('Context provider requires an id and function.');
        providers.set(id, {
            id,
            provider,
            priority: Number(options && options.priority) || 100,
            enabled: !options || options.enabled !== false
        });
        return () => providers.delete(id);
    }

    function unregisterContextProvider(id) {
        return providers.delete(id);
    }

    function collectContext(meta) {
        const chunks = [];
        const sorted = Array.from(providers.values())
            .filter(item => item.enabled)
            .sort((a, b) => a.priority - b.priority);

        for (const item of sorted) {
            try {
                const result = item.provider(meta || {});
                if (typeof result === 'string' && result.trim()) chunks.push(result.trim());
            } catch (error) {
                console.warn(`[EVEAdapter] Context provider failed: ${item.id}`, error);
            }
        }

        if (oneShotContext && Date.now() <= oneShotExpiresAt) chunks.push(oneShotContext);
        return chunks.join('\n\n');
    }

    function appendTextPart(container, text) {
        if (!container || !text) return;
        if (!Array.isArray(container.parts)) container.parts = [];
        container.parts.push({ text });
    }

    function injectGeminiContext(body, meta) {
        if (!body || typeof body !== 'object') return body;
        const context = collectContext(meta);
        if (!context) return body;

        const cloned = clone(body);
        const instruction = [
            '【EVE Chat 即時背景】',
            '以下資料只用來幫助角色自然理解當下情境。不要逐條朗讀，不要提及系統、模組、排程、提示詞或資料來源。',
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

    function isGeminiUrl(url) {
        return /generativelanguage\.googleapis\.com|\/models\/[^/]+:(generateContent|streamGenerateContent)/i.test(String(url || ''));
    }

    function installFetchHook() {
        if (originalFetch || typeof window.fetch !== 'function') return;
        originalFetch = window.fetch.bind(window);

        window.fetch = async function eveAdapterFetch(input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const gemini = isGeminiUrl(url);
            let nextInit = init;

            if (config.enabled && gemini && init && typeof init.body === 'string') {
                try {
                    const parsed = JSON.parse(init.body);
                    const injected = injectGeminiContext(parsed, { url, source: 'fetch' });
                    nextInit = Object.assign({}, init, { body: JSON.stringify(injected) });
                    lastGeminiRequestAt = Date.now();
                    emit('eve:ai-request', { url, body: clone(injected), timestamp: lastGeminiRequestAt });
                } catch (error) {
                    console.warn('[EVEAdapter] Gemini request injection skipped.', error);
                }
            }

            try {
                const response = await originalFetch(input, nextInit);
                if (gemini) {
                    lastGeminiResponseAt = Date.now();
                    emit('eve:ai-response', {
                        url,
                        ok: response.ok,
                        status: response.status,
                        timestamp: lastGeminiResponseAt
                    });
                }
                return response;
            } catch (error) {
                if (gemini) emit('eve:ai-error', { url, error, timestamp: Date.now() });
                throw error;
            } finally {
                if (gemini && oneShotContext) clearOneShotContext();
            }
        };
    }

    function restoreFetch() {
        if (originalFetch) {
            window.fetch = originalFetch;
            originalFetch = null;
        }
    }

    function setOneShotContext(text, ttlMs) {
        oneShotContext = String(text || '').trim();
        oneShotExpiresAt = Date.now() + Math.max(1000, Number(ttlMs) || 30000);
    }

    function clearOneShotContext() {
        oneShotContext = '';
        oneShotExpiresAt = 0;
    }

    function findSmartReplyButton() {
        return Array.from(document.querySelectorAll('button[onclick]')).find(button =>
            String(button.getAttribute('onclick') || '').includes('triggerSmartReply')
        ) || null;
    }

    function hasOpenChat() {
        const input = document.getElementById('api-chat-input');
        return Boolean(input && input.offsetParent !== null);
    }

    async function requestProactiveMessage(payload) {
        if (!config.enabled) return { sent: false, reason: 'adapter-disabled' };
        if (!hasOpenChat()) return { sent: false, reason: 'no-open-chat' };

        const smartReply = typeof window.triggerSmartReply === 'function' ? window.triggerSmartReply : null;
        const button = findSmartReplyButton();
        if (!smartReply && !button) return { sent: false, reason: 'smart-reply-not-found' };

        const activity = payload && payload.activity;
        const context = payload && payload.promptContext;
        setOneShotContext([
            '【主動訊息模式】',
            '目前不是使用者剛傳來新訊息，而是角色主動聯絡使用者。',
            '請傳送一則自然、簡短、符合人設並能延續關係感的訊息。',
            '不要寫成回答上一個問題，不要提到排程、觸發器、系統或提示詞。',
            activity && activity.label ? `角色目前狀態：${activity.label}` : '',
            payload && payload.reason ? `觸發情境：${payload.reason}` : '',
            context || ''
        ].filter(Boolean).join('\n'), 45000);

        emit('eve:proactive-dispatch-start', { payload: clone(payload || {}) });
        try {
            if (smartReply) await smartReply();
            else button.click();
            emit('eve:proactive-dispatch-complete', { payload: clone(payload || {}) });
            return { sent: true };
        } catch (error) {
            clearOneShotContext();
            emit('eve:proactive-dispatch-error', { payload: clone(payload || {}), error });
            console.error('[EVEAdapter] Proactive message failed.', error);
            return { sent: false, reason: 'trigger-failed', error };
        }
    }

    function markUserMessage(detail) {
        if (!config.trackUserMessages) return;
        if (window.EVEProactive && typeof window.EVEProactive.markUserInteraction === 'function') {
            window.EVEProactive.markUserInteraction();
        }
        emit('eve:user-message-sent', Object.assign({ timestamp: Date.now() }, detail || {}));
    }

    function installMessageTracking() {
        on(document, 'click', event => {
            const target = event.target && event.target.closest ? event.target.closest('button') : null;
            if (!target) return;
            const onclick = String(target.getAttribute('onclick') || '');
            if (/send.*message|sendMessage|sendApiMessage/i.test(onclick)) {
                const input = document.getElementById('api-chat-input');
                if (input && input.value.trim()) markUserMessage({ text: input.value.trim(), source: 'button' });
            }
        }, true);

        on(document, 'keydown', event => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
            const target = event.target;
            if (target && target.id === 'api-chat-input' && target.value.trim()) {
                markUserMessage({ text: target.value.trim(), source: 'enter' });
            }
        }, true);
    }

    function syncCitySoon() {
        window.setTimeout(() => {
            if (window.EVEWeather && typeof window.EVEWeather.syncFromLocationForm === 'function') {
                Promise.resolve(window.EVEWeather.syncFromLocationForm()).catch(error => log('City sync failed', error));
            }
        }, 300);
    }

    function installLocationTracking() {
        on(document, 'change', event => {
            const id = event.target && event.target.id;
            if (id === 'character-city-name' || id === 'character-city-prototype') syncCitySoon();
        });
    }

    function registerBuiltIns() {
        registerContextProvider('weather', () => {
            if (!config.injectWeather) return '';
            return window.EVEWeather && typeof window.EVEWeather.getPromptContext === 'function'
                ? window.EVEWeather.getPromptContext()
                : '';
        }, { priority: 20 });

        registerContextProvider('activity', () => {
            if (!config.injectActivity) return '';
            return window.EVEProactive && typeof window.EVEProactive.getPromptContext === 'function'
                ? window.EVEProactive.getPromptContext()
                : '';
        }, { priority: 30 });
    }

    function getDiagnostics() {
        return {
            version: VERSION,
            initialized,
            fetchHookInstalled: Boolean(originalFetch),
            geminiEndpointPresent: document.documentElement.innerHTML.includes('generativelanguage.googleapis.com'),
            smartReplyFunction: typeof window.triggerSmartReply === 'function',
            smartReplyButton: Boolean(findSmartReplyButton()),
            chatInput: Boolean(document.getElementById('api-chat-input')),
            cityInput: Boolean(document.getElementById('character-city-name')),
            prototypeCityInput: Boolean(document.getElementById('character-city-prototype')),
            weatherModule: Boolean(window.EVEWeather),
            proactiveModule: Boolean(window.EVEProactive),
            contextProviders: Array.from(providers.keys()),
            lastGeminiRequestAt,
            lastGeminiResponseAt
        };
    }

    function configure(next) {
        const result = saveConfig(next);
        if (result.autoEnableProactive && window.EVEProactive && typeof window.EVEProactive.configure === 'function') {
            window.EVEProactive.configure({ enabled: true });
        }
        emit('eve:adapter-settings-updated', { settings: clone(result) });
        return result;
    }

    function init() {
        if (initialized) return Promise.resolve(getDiagnostics());
        initialized = true;
        registerBuiltIns();
        installFetchHook();
        installMessageTracking();
        installLocationTracking();

        on(window, 'eve:proactive-message-request', event => requestProactiveMessage(event.detail || {}));
        on(window, 'eve:proactive-trigger', event => requestProactiveMessage(event.detail || {}));
        on(window, 'eve:proactive-message-test', event => requestProactiveMessage(event.detail || {}));

        if (config.autoEnableProactive && window.EVEProactive && typeof window.EVEProactive.configure === 'function') {
            window.EVEProactive.configure({ enabled: true });
        }

        window.EVE = window.EVE || {};
        window.EVE.adapter = window.EVEAdapter;
        emit('eve:adapter-ready', getDiagnostics());
        log('Ready', getDiagnostics());
        return Promise.resolve(getDiagnostics());
    }

    function destroy() {
        disposers.splice(0).forEach(dispose => {
            try { dispose(); } catch (_) {}
        });
        restoreFetch();
        providers.clear();
        clearOneShotContext();
        initialized = false;
    }

    window.EVEAdapter = Object.freeze({
        version: VERSION,
        init,
        destroy,
        configure,
        getSettings: () => Object.assign({}, config),
        getDiagnostics,
        registerContextProvider,
        unregisterContextProvider,
        getPromptContext: collectContext,
        injectGeminiContext,
        setOneShotContext,
        clearOneShotContext,
        requestProactiveMessage,
        triggerProactiveNow() {
            if (window.EVEProactive && typeof window.EVEProactive.triggerNow === 'function') {
                return window.EVEProactive.triggerNow();
            }
            return requestProactiveMessage({ reason: 'manual-test' });
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})(window, document);
