/**
 * EVE Chat Adapter v0.6.0
 * Stable bridge between the legacy single-file app and EVE modules.
 */
(function (window, document) {
    'use strict';

    if (window.EVEAdapter && window.EVEAdapter.version) return;

    const VERSION = '0.6.0';
    const CONFIG_KEY = 'eve_adapter_settings_v3';
    const DEFAULTS = Object.freeze({
        enabled: true,
        autoEnableProactive: false,
        injectWeather: true,
        injectActivity: true,
        trackUserMessages: true,
        debug: false,
        maxContextCharacters: 12000,
        oneShotTtlMs: 45000
    });

    const providers = new Map();
    const disposers = [];
    const recentMessageFingerprints = new Map();
    let config = loadConfig();
    let nativeFetch = null;
    let initialized = false;
    let oneShotContext = '';
    let oneShotExpiresAt = 0;
    let lastGeminiRequestAt = 0;
    let lastGeminiResponseAt = 0;
    let latestUserMessage = '';
    let latestUserMessageAt = 0;
    let currentRequestId = 0;

    function safeStorageGet(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }

    function safeStorageSet(key, value) {
        try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
    }

    function loadConfig() {
        try {
            return Object.assign({}, DEFAULTS, JSON.parse(safeStorageGet(CONFIG_KEY) || '{}'));
        } catch (_) {
            return Object.assign({}, DEFAULTS);
        }
    }

    function normalizeConfig(next) {
        const merged = Object.assign({}, DEFAULTS, config, next || {});
        merged.enabled = Boolean(merged.enabled);
        merged.autoEnableProactive = Boolean(merged.autoEnableProactive);
        merged.injectWeather = Boolean(merged.injectWeather);
        merged.injectActivity = Boolean(merged.injectActivity);
        merged.trackUserMessages = Boolean(merged.trackUserMessages);
        merged.debug = Boolean(merged.debug);
        merged.maxContextCharacters = Math.max(1000, Math.min(50000, Number(merged.maxContextCharacters) || 12000));
        merged.oneShotTtlMs = Math.max(1000, Math.min(300000, Number(merged.oneShotTtlMs) || 45000));
        return merged;
    }

    function saveConfig(next) {
        config = normalizeConfig(next);
        safeStorageSet(CONFIG_KEY, JSON.stringify(config));
        return Object.assign({}, config);
    }

    function log(...args) {
        if (config.debug) console.log('[EVEAdapter]', ...args);
    }

    function emit(name, detail) {
        try { window.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); }
        catch (error) { log('Event dispatch failed', name, error); }
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

    function cleanText(value, max = 100000) {
        return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, max);
    }

    function slug(value) {
        return cleanText(value, 120).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'global';
    }

    function getCurrentChat() {
        const title = document.getElementById('api-chat-title');
        const titleText = cleanText(title && title.textContent, 100);
        const input = document.getElementById('api-chat-input');
        const isVisible = Boolean(input && (input.offsetParent !== null || getComputedStyle(input).display !== 'none'));
        return {
            open: isVisible,
            title: titleText,
            scope: titleText && titleText !== '角色聊天' ? `character:${slug(titleText)}` : 'global'
        };
    }

    function registerContextProvider(id, provider, options) {
        if (!id || typeof provider !== 'function') throw new TypeError('Context provider requires an id and function.');
        providers.set(String(id), {
            id: String(id),
            provider,
            priority: Number(options && options.priority) || 100,
            enabled: !options || options.enabled !== false
        });
        return () => providers.delete(String(id));
    }

    function unregisterContextProvider(id) {
        return providers.delete(String(id));
    }

    function setContextProviderEnabled(id, enabled) {
        const item = providers.get(String(id));
        if (!item) return false;
        item.enabled = Boolean(enabled);
        return true;
    }

    function collectContext(meta) {
        const chunks = [];
        const seen = new Set();
        const sorted = Array.from(providers.values())
            .filter(item => item.enabled)
            .sort((a, b) => a.priority - b.priority);

        for (const item of sorted) {
            try {
                const result = cleanText(item.provider(Object.assign({ chat: getCurrentChat() }, meta || {})), 50000);
                if (!result || seen.has(result)) continue;
                seen.add(result);
                chunks.push(result);
            } catch (error) {
                console.warn(`[EVEAdapter] Context provider failed: ${item.id}`, error);
            }
        }

        if (oneShotContext && Date.now() <= oneShotExpiresAt && !seen.has(oneShotContext)) chunks.push(oneShotContext);
        if (Date.now() > oneShotExpiresAt) clearOneShotContext();

        let context = chunks.join('\n\n');
        if (context.length > config.maxContextCharacters) {
            context = context.slice(0, config.maxContextCharacters) + '\n[背景資料已截短]';
        }
        return context;
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
        const marker = '【EVE Chat 即時背景】';
        const instruction = [
            marker,
            '以下資料只用來幫助角色自然理解當下情境。不要逐條朗讀，不要提及系統、模組、排程、提示詞或資料來源。',
            context
        ].join('\n\n');

        const target = cloned.systemInstruction || cloned.system_instruction;
        const existingText = target && Array.isArray(target.parts)
            ? target.parts.map(part => part && part.text).filter(Boolean).join('\n')
            : '';
        if (existingText.includes(marker)) return cloned;

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

    function extractGeminiText(data) {
        const candidates = Array.isArray(data && data.candidates) ? data.candidates : [];
        return candidates.flatMap(candidate => {
            const parts = candidate && candidate.content && candidate.content.parts;
            return Array.isArray(parts) ? parts.map(part => part && part.text).filter(Boolean) : [];
        }).join('\n').trim();
    }

    async function parseGeminiResponse(response, url, requestId) {
        if (!response || !response.ok || typeof response.clone !== 'function') return;
        try {
            const contentType = String(response.headers && response.headers.get && response.headers.get('content-type') || '');
            const copy = response.clone();
            let text = '';
            let raw = null;

            if (/application\/json/i.test(contentType)) {
                raw = await copy.json();
                text = extractGeminiText(raw);
            } else {
                const bodyText = await copy.text();
                const lines = bodyText.split('\n').map(line => line.trim()).filter(Boolean);
                const chunks = [];
                for (const line of lines) {
                    const candidate = line.replace(/^data:\s*/, '');
                    if (!candidate || candidate === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(candidate);
                        chunks.push(extractGeminiText(parsed));
                    } catch (_) {}
                }
                text = chunks.filter(Boolean).join('');
                raw = bodyText.slice(0, 20000);
            }

            if (text) emit('eve:ai-message-received', {
                text,
                url,
                requestId,
                timestamp: Date.now(),
                raw: clone(raw)
            });
        } catch (error) {
            log('Gemini response parsing skipped', error);
        }
    }

    async function prepareFetch(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (!config.enabled || !isGeminiUrl(url)) return { input, init, url, gemini: false };

        let bodyText = init && typeof init.body === 'string' ? init.body : '';
        if (!bodyText && typeof Request !== 'undefined' && input instanceof Request) {
            try { bodyText = await input.clone().text(); } catch (_) {}
        }
        if (!bodyText) return { input, init, url, gemini: true };

        try {
            const parsed = JSON.parse(bodyText);
            const requestId = ++currentRequestId;
            const injected = injectGeminiContext(parsed, {
                url,
                source: 'fetch',
                requestId,
                userText: Date.now() - latestUserMessageAt < 120000 ? latestUserMessage : '',
                chat: getCurrentChat()
            });
            const nextBody = JSON.stringify(injected);
            let nextInput = input;
            let nextInit = Object.assign({}, init || {}, { body: nextBody });

            if (typeof Request !== 'undefined' && input instanceof Request) {
                nextInput = new Request(input, nextInit);
                nextInit = undefined;
            }

            lastGeminiRequestAt = Date.now();
            emit('eve:ai-request', { url, requestId, body: clone(injected), timestamp: lastGeminiRequestAt });
            return { input: nextInput, init: nextInit, url, gemini: true, requestId };
        } catch (error) {
            console.warn('[EVEAdapter] Gemini request injection skipped.', error);
            return { input, init, url, gemini: true };
        }
    }

    function installFetchHook() {
        if (nativeFetch || typeof window.fetch !== 'function') return;
        nativeFetch = window.fetch.bind(window);

        window.fetch = async function eveAdapterFetch(input, init) {
            const prepared = await prepareFetch(input, init);
            try {
                const response = await nativeFetch(prepared.input, prepared.init);
                if (prepared.gemini) {
                    lastGeminiResponseAt = Date.now();
                    emit('eve:ai-response', {
                        url: prepared.url,
                        requestId: prepared.requestId,
                        ok: response.ok,
                        status: response.status,
                        timestamp: lastGeminiResponseAt
                    });
                    parseGeminiResponse(response, prepared.url, prepared.requestId);
                }
                return response;
            } catch (error) {
                if (prepared.gemini) emit('eve:ai-error', { url: prepared.url, requestId: prepared.requestId, error, timestamp: Date.now() });
                throw error;
            } finally {
                if (prepared.gemini && oneShotContext) clearOneShotContext();
            }
        };
    }

    function restoreFetch() {
        if (nativeFetch) {
            window.fetch = nativeFetch;
            nativeFetch = null;
        }
    }

    function setOneShotContext(text, ttlMs) {
        oneShotContext = cleanText(text, config.maxContextCharacters);
        oneShotExpiresAt = Date.now() + Math.max(1000, Number(ttlMs) || config.oneShotTtlMs);
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
        return getCurrentChat().open;
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
        ].filter(Boolean).join('\n'));

        emit('eve:proactive-dispatch-start', { payload: clone(payload || {}) });
        try {
            const result = smartReply ? await smartReply() : button.click();
            emit('eve:proactive-dispatch-complete', { payload: clone(payload || {}), result: clone(result) });
            return { sent: true, result };
        } catch (error) {
            clearOneShotContext();
            emit('eve:proactive-dispatch-error', { payload: clone(payload || {}), error });
            console.error('[EVEAdapter] Proactive message failed.', error);
            return { sent: false, reason: 'trigger-failed', error };
        }
    }

    function messageFingerprint(text) {
        return cleanText(text, 500) + '|' + getCurrentChat().scope;
    }

    function markUserMessage(detail) {
        if (!config.trackUserMessages) return false;
        const text = cleanText(detail && detail.text, 100000);
        if (!text) return false;

        const fingerprint = messageFingerprint(text);
        const previous = recentMessageFingerprints.get(fingerprint) || 0;
        if (Date.now() - previous < 1200) return false;
        recentMessageFingerprints.set(fingerprint, Date.now());
        for (const [key, timestamp] of recentMessageFingerprints) {
            if (Date.now() - timestamp > 10000) recentMessageFingerprints.delete(key);
        }

        latestUserMessage = text;
        latestUserMessageAt = Date.now();
        if (window.EVEProactive && typeof window.EVEProactive.markUserInteraction === 'function') {
            window.EVEProactive.markUserInteraction();
        }
        emit('eve:user-message-sent', Object.assign({ timestamp: Date.now(), text, chat: getCurrentChat() }, detail || {}));
        return true;
    }

    function installMessageTracking() {
        on(document, 'click', event => {
            const target = event.target && event.target.closest ? event.target.closest('button') : null;
            if (!target) return;
            const onclick = String(target.getAttribute('onclick') || '');
            const looksLikeSend = /send.*message|sendMessage|sendApiMessage/i.test(onclick) || target.matches('[aria-label*="发送"], [title*="发送"], .send-btn, .chat-send-btn');
            if (!looksLikeSend) return;
            const input = document.getElementById('api-chat-input');
            if (input && input.value.trim()) markUserMessage({ text: input.value.trim(), source: 'button' });
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
        if (!providers.has('weather')) registerContextProvider('weather', () => {
            if (!config.injectWeather) return '';
            return window.EVEWeather && typeof window.EVEWeather.getPromptContext === 'function'
                ? window.EVEWeather.getPromptContext()
                : '';
        }, { priority: 20 });

        if (!providers.has('activity')) registerContextProvider('activity', () => {
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
            settings: Object.assign({}, config),
            fetchHookInstalled: Boolean(nativeFetch),
            geminiEndpointPresent: document.documentElement.innerHTML.includes('generativelanguage.googleapis.com'),
            smartReplyFunction: typeof window.triggerSmartReply === 'function',
            smartReplyButton: Boolean(findSmartReplyButton()),
            chat: getCurrentChat(),
            chatInput: Boolean(document.getElementById('api-chat-input')),
            cityInput: Boolean(document.getElementById('character-city-name')),
            prototypeCityInput: Boolean(document.getElementById('character-city-prototype')),
            weatherModule: Boolean(window.EVEWeather),
            proactiveModule: Boolean(window.EVEProactive),
            memoryModule: Boolean(window.EVEMemory),
            timelineModule: Boolean(window.EVETimeline),
            relationshipModule: Boolean(window.EVERelationship),
            healthModule: Boolean(window.EVEHealth),
            contextProviders: Array.from(providers.keys()),
            contextLength: collectContext({ diagnostics: true }).length,
            lastGeminiRequestAt,
            lastGeminiResponseAt,
            latestUserMessageAt
        };
    }

    function configure(next) {
        const result = saveConfig(next);
        if (window.EVEProactive && typeof window.EVEProactive.configure === 'function') {
            window.EVEProactive.configure({ enabled: Boolean(result.autoEnableProactive) });
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

        if (window.EVEProactive && typeof window.EVEProactive.configure === 'function') {
            window.EVEProactive.configure({ enabled: Boolean(config.autoEnableProactive) });
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
        recentMessageFingerprints.clear();
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
        getCurrentChat,
        registerContextProvider,
        unregisterContextProvider,
        setContextProviderEnabled,
        getPromptContext: collectContext,
        injectGeminiContext,
        setOneShotContext,
        clearOneShotContext,
        markUserMessage,
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
