/**
 * EVE Chat Timeline Module v0.8.0
 * Shared-history timeline, milestones and prompt context.
 */
(function (window, document) {
    'use strict';

    if (window.EVETimeline && window.EVETimeline.version) return;

    const VERSION = '0.8.0';
    const STORE_KEY = 'eve_timeline_store_v1';
    const SETTINGS_KEY = 'eve_timeline_settings_v1';
    const DAY = 86400000;

    const DEFAULTS = Object.freeze({
        enabled: true,
        autoRecord: true,
        recordConversationSessions: true,
        recordProactiveMessages: true,
        recordEnvironmentChanges: true,
        syncImportantToMemory: true,
        maxStoredEvents: 1200,
        maxPromptEvents: 10,
        promptRecentDays: 60,
        minPromptImportance: 2,
        sessionWindowMinutes: 30,
        defaultScope: 'global',
        debug: false
    });

    let settings = load(SETTINGS_KEY, DEFAULTS);
    let store = load(STORE_KEY, {
        schema: 1,
        events: [],
        milestones: {},
        updatedAt: 0
    });
    let initialized = false;
    let unregisterProvider = null;
    let pendingUser = null;
    let lastEnvironmentSignature = '';
    const disposers = [];

    function clone(value) {
        try {
            return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value));
        } catch (_) { return value; }
    }

    function load(key, fallback) {
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || 'null');
            return parsed && typeof parsed === 'object' ? Object.assign(clone(fallback), parsed) : clone(fallback);
        } catch (_) { return clone(fallback); }
    }

    function save() {
        store.updatedAt = Date.now();
        store.events.sort((a, b) => b.occurredAt - a.occurredAt);
        store.events = store.events.slice(0, Math.max(50, Number(settings.maxStoredEvents) || 1200));
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(store));
            return true;
        } catch (error) {
            console.warn('[EVETimeline] Save failed.', error);
            return false;
        }
    }

    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    }

    function emit(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    }

    function on(target, name, handler, options) {
        target.addEventListener(name, handler, options);
        disposers.push(() => target.removeEventListener(name, handler, options));
    }

    function log(...args) {
        if (settings.debug) console.log('[EVETimeline]', ...args);
    }

    function clean(value, max = 500) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function slug(value) {
        return clean(value, 120).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'timeline';
    }

    function uid() {
        return `timeline_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, Number(value) || 0));
    }

    function currentScope() {
        const adapterScope = window.EVEAdapter?.getCurrentChat?.().scope;
        if (adapterScope && adapterScope !== 'global') return adapterScope;
        if (window.EVEMemory && typeof window.EVEMemory.getCurrentScope === 'function') {
            try { return window.EVEMemory.getCurrentScope(); } catch (_) {}
        }
        const title = document.getElementById('api-chat-title');
        const visible = title && title.offsetParent !== null ? clean(title.textContent, 100) : '';
        return visible ? `character:${slug(visible)}` : (settings.defaultScope || 'global');
    }

    function normalizeScope(scope) {
        return clean(scope || currentScope(), 140) || 'global';
    }

    function normalizeTags(tags) {
        const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
        return Array.from(new Set(list.map(slug).filter(Boolean))).slice(0, 20);
    }

    function normalizeSourceIds(ids) {
        const list = Array.isArray(ids) ? ids : (ids ? [ids] : []);
        return Array.from(new Set(list.map(id => clean(id, 200)).filter(Boolean))).slice(0, 40);
    }

    function dayKey(timestamp) {
        return new Date(Number(timestamp) || Date.now()).toISOString().slice(0, 10);
    }

    function fingerprint(item) {
        return [item.scope, item.type, clean(item.title, 160).toLowerCase(), dayKey(item.occurredAt)].join('|');
    }

    function addEvent(input) {
        const source = typeof input === 'string' ? { title: input } : (input || {});
        const title = clean(source.title || source.text, 180);
        if (!title) throw new TypeError('Timeline event requires a title.');

        const event = {
            id: source.id || uid(),
            scope: normalizeScope(source.scope),
            type: slug(source.type || source.category || 'event'),
            title,
            description: clean(source.description || '', 700),
            importance: clamp(source.importance == null ? 3 : source.importance, 1, 5),
            tags: normalizeTags(source.tags),
            source: clean(source.source || 'manual', 80),
            occurredAt: Number(source.occurredAt || source.date) || Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            count: Math.max(1, Number(source.count) || 1),
            pinned: Boolean(source.pinned),
            archived: Boolean(source.archived),
            sourceMessageIds: normalizeSourceIds(source.sourceMessageIds),
            metadata: clone(source.metadata || {})
        };
        event.fingerprint = source.fingerprint || fingerprint(event);

        const duplicate = store.events.find(existing => existing.fingerprint === event.fingerprint);
        if (duplicate) {
            duplicate.updatedAt = Date.now();
            duplicate.occurredAt = Math.max(duplicate.occurredAt, event.occurredAt);
            duplicate.importance = Math.max(duplicate.importance, event.importance);
            duplicate.count = (duplicate.count || 1) + event.count;
            duplicate.tags = Array.from(new Set([...(duplicate.tags || []), ...event.tags]));
            duplicate.sourceMessageIds = Array.from(new Set([...(duplicate.sourceMessageIds || []), ...event.sourceMessageIds]));
            if (event.description) duplicate.description = event.description;
            if (event.pinned) duplicate.pinned = true;
            duplicate.metadata = Object.assign({}, duplicate.metadata || {}, event.metadata || {});
            save();
            emit('eve:timeline-updated', { item: clone(duplicate) });
            return clone(duplicate);
        }

        store.events.push(event);
        save();
        emit('eve:timeline-added', { item: clone(event) });

        if (settings.syncImportantToMemory && event.importance >= 4 && window.EVEMemory?.addEvent) {
            try {
                window.EVEMemory.addEvent({
                    scope: event.scope,
                    title: event.title,
                    description: event.description,
                    category: `timeline-${event.type}`,
                    importance: event.importance,
                    tags: [...event.tags, 'timeline'],
                    occurredAt: event.occurredAt,
                    source: 'timeline',
                    sourceMessageIds: event.sourceMessageIds
                });
            } catch (error) { log('Memory sync skipped', error); }
        }
        return clone(event);
    }

    function addMilestone(key, input) {
        const milestoneKey = `${normalizeScope(input?.scope)}|${slug(key)}`;
        if (store.milestones[milestoneKey]) {
            const existing = store.events.find(item => item.id === store.milestones[milestoneKey]);
            return existing ? clone(existing) : null;
        }
        const item = addEvent(Object.assign({
            type: 'milestone',
            importance: 5,
            pinned: true,
            tags: ['milestone']
        }, input || {}));
        store.milestones[milestoneKey] = item.id;
        save();
        emit('eve:timeline-milestone', { key: slug(key), item: clone(item) });
        return item;
    }

    function recordConversation(userText, assistantText, scope, sourceMessageIds = []) {
        if (!settings.recordConversationSessions) return null;
        const normalizedScope = normalizeScope(scope);
        const now = Date.now();
        const windowMs = Math.max(5, Number(settings.sessionWindowMinutes) || 30) * 60000;
        const recent = store.events.find(item =>
            item.scope === normalizedScope && item.type === 'conversation' && now - item.occurredAt <= windowMs
        );
        const important = /第一次|生日|紀念|纪念|告白|結婚|结婚|分手|生病|住院|考試|考试|畢業|毕业|旅行|搬家|工作|入學|入学|不要忘|記住|记住/.test(`${userText} ${assistantText}`);

        if (recent) {
            recent.occurredAt = now;
            recent.updatedAt = now;
            recent.count = (recent.count || 1) + 1;
            recent.importance = Math.max(recent.importance || 2, important ? 4 : 2);
            recent.description = clean(`最近的對話：${userText || assistantText}`, 300);
            recent.metadata = Object.assign({}, recent.metadata, { lastUserText: clean(userText, 300), lastAssistantText: clean(assistantText, 300) });
            recent.sourceMessageIds = Array.from(new Set([...(recent.sourceMessageIds || []), ...normalizeSourceIds(sourceMessageIds)]));
            save();
            emit('eve:timeline-updated', { item: clone(recent) });
            return clone(recent);
        }

        return addEvent({
            scope: normalizedScope,
            type: 'conversation',
            title: important ? '進行了一次重要對話' : '進行了一次對話',
            description: clean(userText ? `使用者提到：「${userText}」` : `角色主動說：「${assistantText}」`, 500),
            importance: important ? 4 : 2,
            tags: important ? ['conversation', 'important'] : ['conversation'],
            source: 'chat',
            sourceMessageIds,
            metadata: { lastUserText: clean(userText, 300), lastAssistantText: clean(assistantText, 300) }
        });
    }

    function recordEnvironment(detail) {
        if (!settings.recordEnvironmentChanges) return;
        const env = detail?.environment || detail || window.EVEWeather?.getEnvironment?.();
        if (!env) return;
        const place = env.character || env;
        const city = clean(place.displayName || place.location?.name || place.city || place.location || '', 80);
        const weather = clean(place.weather?.description || place.weather?.label || place.weather?.key || place.weather || '', 80);
        const temp = place.weather?.temperature ?? place.temperature;
        const signature = [currentScope(), city, weather, temp].join('|');
        if (!city && !weather) return;
        if (signature === lastEnvironmentSignature) return;
        lastEnvironmentSignature = signature;

        addEvent({
            type: 'environment',
            title: city ? `角色所在地更新為${city}` : `當時天氣是${weather}`,
            description: [weather, temp != null ? `${temp}°C` : ''].filter(Boolean).join('，'),
            importance: 1,
            tags: ['environment', city ? 'location' : 'weather'],
            source: 'weather',
            metadata: { city, weather, temperature: temp }
        });
    }

    function list(options = {}) {
        const scope = options.scope === '*' ? null : normalizeScope(options.scope);
        const types = options.types ? new Set((Array.isArray(options.types) ? options.types : [options.types]).map(slug)) : null;
        const from = Number(options.from) || 0;
        const to = Number(options.to) || Infinity;
        return store.events
            .filter(item => !item.archived)
            .filter(item => !scope || item.scope === scope || (options.includeGlobal && item.scope === 'global'))
            .filter(item => !types || types.has(item.type))
            .filter(item => item.occurredAt >= from && item.occurredAt <= to)
            .sort((a, b) => b.occurredAt - a.occurredAt)
            .slice(0, Number(options.limit) || 100)
            .map(clone);
    }

    function formatDate(timestamp) {
        try {
            return new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(timestamp));
        } catch (_) { return new Date(timestamp).toLocaleDateString(); }
    }

    function getPromptContext(meta = {}) {
        if (!settings.enabled) return '';
        const cutoff = Date.now() - Math.max(1, Number(settings.promptRecentDays) || 60) * DAY;
        const scope = normalizeScope(meta.scope || meta.chat?.scope);
        const items = store.events
            .filter(item => !item.archived && (item.scope === scope || item.scope === 'global'))
            .filter(item => item.pinned || item.importance >= settings.minPromptImportance)
            .filter(item => item.pinned || item.occurredAt >= cutoff)
            .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.importance - a.importance) || (b.occurredAt - a.occurredAt))
            .slice(0, Math.max(0, Number(settings.maxPromptEvents) || 10));
        if (!items.length) return '';

        const lines = ['【共同時間線】'];
        items.forEach(item => {
            const count = item.count > 1 ? `（共${item.count}次）` : '';
            lines.push(`- ${formatDate(item.occurredAt)}：${item.title}${count}${item.description ? `；${item.description.slice(0, 140)}` : ''}`);
        });
        lines.push('這些是雙方曾共同經歷的時間點。請只在自然相關時提起，不要逐條朗讀，也不要把推測當成事實。');
        return lines.join('\n');
    }

    function removeByMessage(messageId, text) {
        const id = clean(messageId, 200);
        const sample = clean(text, 1000);
        let removed = 0;
        store.events = store.events.filter(item => {
            const sources = normalizeSourceIds(item.sourceMessageIds);
            // A timeline event is a narrative derived from its entire source
            // exchange.  Recalling any source removes the whole event, so no
            // fragment of the recalled message remains in later prompts.
            if (id && sources.includes(id)) {
                removed += 1;
                return false;
            }
            if (!sources.length && sample.length >= 6) {
                const fields = [item.title,item.description,item.metadata?.lastUserText,item.metadata?.lastAssistantText]
                    .map(value => clean(value, 1200));
                if (fields.some(value => value && (value === sample || value.includes(sample.slice(0, 180))))) {
                    removed += 1;
                    return false;
                }
            }
            return true;
        });
        if (removed) {
            const existingIds = new Set(store.events.map(item => item.id));
            Object.keys(store.milestones).forEach(key => {
                if (!existingIds.has(store.milestones[key])) delete store.milestones[key];
            });
            save();
            emit('eve:timeline-purged-by-message', { messageId:id, removed });
        }
        return removed;
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        })[char]);
    }

    function openManager() {
        document.getElementById('eve-timeline-manager')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'eve-timeline-manager';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999996;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:14px';
        const panel = document.createElement('div');
        panel.style.cssText = 'width:min(700px,100%);max-height:90vh;display:flex;flex-direction:column;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;overflow:hidden;box-shadow:0 15px 50px #0004';
        panel.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #ddd">
            <b style="flex:1">共同时间线</b>
            <input data-search placeholder="搜索事件" style="width:160px;padding:7px;border:1px solid #ccc;border-radius:8px">
            <button data-add type="button">＋</button><button data-close type="button">✕</button>
          </div>
          <div data-list style="overflow:auto;padding:8px 14px;min-height:180px"></div>
          <div style="padding:12px 16px;border-top:1px solid #ddd;display:flex;justify-content:space-between">
            <small>记录聊天、主动消息和重要环境变化</small><button data-clear type="button" style="color:#c33">清空当前角色</button>
          </div>`;
        overlay.append(panel);
        document.body.append(overlay);
        const render = () => {
            const query = clean(panel.querySelector('[data-search]').value, 100).toLowerCase();
            const items = list({ scope:currentScope(), includeGlobal:true, limit:500 })
                .filter(item => !query || `${item.title} ${item.description}`.toLowerCase().includes(query));
            const target = panel.querySelector('[data-list]');
            target.innerHTML = '';
            for (const item of items) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;gap:9px;align-items:flex-start;padding:10px 2px;border-bottom:1px solid #ddd';
                row.innerHTML = `<small style="min-width:74px;opacity:.6">${escapeHtml(formatDate(item.occurredAt))}</small><span style="flex:1;line-height:1.45"><b>${escapeHtml(item.title)}</b>${item.description ? `<br><small>${escapeHtml(item.description)}</small>` : ''}</span><button type="button">删除</button>`;
                row.querySelector('button').onclick = () => { remove(item.id); render(); };
                target.append(row);
            }
            if (!items.length) target.innerHTML = '<div style="padding:36px;text-align:center;opacity:.6">暂无扩展时间线事件</div>';
        };
        panel.querySelector('[data-search]').oninput = render;
        panel.querySelector('[data-close]').onclick = () => overlay.remove();
        overlay.onclick = event => { if (event.target === overlay) overlay.remove(); };
        panel.querySelector('[data-add]').onclick = () => {
            const title = prompt('事件标题');
            if (title) { addEvent({ title, importance:3, source:'manual' }); render(); }
        };
        panel.querySelector('[data-clear]').onclick = () => {
            if (confirm('确定清空当前角色的扩展时间线？')) { clear({ scope:currentScope() }); render(); }
        };
        render();
    }

    function remove(id) {
        const before = store.events.length;
        store.events = store.events.filter(item => item.id !== id);
        Object.keys(store.milestones).forEach(key => { if (store.milestones[key] === id) delete store.milestones[key]; });
        if (store.events.length === before) return false;
        save();
        emit('eve:timeline-removed', { id });
        return true;
    }

    function clear(options = {}) {
        const scope = options.scope ? normalizeScope(options.scope) : null;
        if (!scope) {
            store = { schema: 1, events: [], milestones: {}, updatedAt: Date.now() };
        } else {
            const ids = new Set(store.events.filter(item => item.scope === scope).map(item => item.id));
            store.events = store.events.filter(item => item.scope !== scope);
            Object.keys(store.milestones).forEach(key => { if (ids.has(store.milestones[key])) delete store.milestones[key]; });
        }
        save();
        emit('eve:timeline-cleared', { scope });
        return true;
    }

    function exportData() {
        return clone({ version: VERSION, exportedAt: new Date().toISOString(), settings, store });
    }

    function importData(data, options = {}) {
        if (!data || typeof data !== 'object') throw new TypeError('Invalid timeline backup.');
        const incoming = data.store || data;
        if (!Array.isArray(incoming.events)) throw new TypeError('Timeline backup has an invalid structure.');
        if (options.replace) {
            store = { schema: 1, events: clone(incoming.events), milestones: clone(incoming.milestones || {}), updatedAt: Date.now() };
        } else {
            incoming.events.forEach(addEvent);
            Object.assign(store.milestones, incoming.milestones || {});
        }
        save();
        emit('eve:timeline-imported', { replace: Boolean(options.replace) });
        return getStats();
    }

    function configure(next = {}) {
        settings = Object.assign({}, DEFAULTS, settings, next || {});
        settings.maxStoredEvents = clamp(settings.maxStoredEvents, 50, 10000);
        settings.maxPromptEvents = clamp(settings.maxPromptEvents, 0, 50);
        settings.promptRecentDays = clamp(settings.promptRecentDays, 1, 3650);
        settings.minPromptImportance = clamp(settings.minPromptImportance, 1, 5);
        settings.sessionWindowMinutes = clamp(settings.sessionWindowMinutes, 5, 1440);
        saveSettings();
        save();
        return clone(settings);
    }

    function registerWithAdapter() {
        if (!window.EVEAdapter?.registerContextProvider) return false;
        if (unregisterProvider) unregisterProvider();
        unregisterProvider = window.EVEAdapter.registerContextProvider('timeline', getPromptContext, { priority: 50 });
        return true;
    }

    function getStats() {
        const scope = currentScope();
        return {
            version: VERSION,
            initialized,
            scope,
            totalEvents: store.events.length,
            scopeEvents: store.events.filter(item => item.scope === scope).length,
            milestones: Object.keys(store.milestones).length,
            updatedAt: store.updatedAt
        };
    }

    function bindEvents() {
        on(window, 'eve:adapter-ready', registerWithAdapter);
        on(window, 'eve:user-message-committed', event => {
            const text = clean(event.detail?.text, 1000);
            if (!text) return;
            pendingUser = {
                text,
                scope: event.detail?.scope || currentScope(),
                at: Date.now(),
                messageId: clean(event.detail?.messageId, 200)
            };
            addMilestone('first-user-message', {
                scope: pendingUser.scope,
                title: '第一次开始聊天',
                description: clean(`使用者第一次说：「${text}」`, 300),
                source: 'chat',
                sourceMessageIds: [pendingUser.messageId]
            });
        });
        on(window, 'eve:ai-message-committed', event => {
            const assistantText = clean(event.detail?.text, 1000);
            const user = pendingUser;
            if (user || assistantText) {
                recordConversation(
                    user?.text || '',
                    assistantText,
                    user?.scope || event.detail?.scope || currentScope(),
                    [user?.messageId, event.detail?.messageId].filter(Boolean)
                );
            }
            pendingUser = null;
        });
        on(window, 'eve:proactive-dispatch-complete', event => {
            if (!settings.recordProactiveMessages) return;
            addMilestone('first-proactive-message', {
                title: '角色第一次主動聯絡使用者',
                description: '角色在沒有收到新訊息時，第一次主動開啟了對話。',
                source: 'proactive'
            });
            addEvent({
                type: 'proactive',
                title: '角色主動聯絡了使用者',
                description: clean(event.detail?.payload?.reason || '', 200),
                importance: 3,
                tags: ['proactive'],
                source: 'proactive'
            });
        });
        on(window, 'eve:environment-updated', event => recordEnvironment(event.detail));
        on(window, 'eve:weather-updated', event => recordEnvironment(event.detail));
        on(window, 'eve:location-updated', event => recordEnvironment(event.detail));
        on(window, 'eve:memory-added', event => {
            const detail = event.detail || {};
            if (detail.kind !== 'event' || detail.item?.source === 'timeline') return;
            const item = detail.item;
            if (!item || Number(item.importance) < 4) return;
            addEvent({
                scope: item.scope,
                type: 'memory-event',
                title: item.title,
                description: item.description,
                importance: item.importance,
                tags: [...(item.tags || []), 'memory'],
                occurredAt: item.occurredAt,
                source: 'memory',
                sourceMessageIds: item.sourceMessageIds
            });
        });
    }

    function init() {
        if (initialized) return Promise.resolve(getStats());
        initialized = true;
        registerWithAdapter();
        bindEvents();
        window.EVE = window.EVE || {};
        window.EVE.timeline = window.EVETimeline;
        emit('eve:timeline-ready', getStats());
        log('Ready', getStats());
        return Promise.resolve(getStats());
    }

    function destroy() {
        disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} });
        if (unregisterProvider) unregisterProvider();
        unregisterProvider = null;
        initialized = false;
    }

    window.EVETimeline = Object.freeze({
        version: VERSION,
        init,
        destroy,
        configure,
        getSettings: () => clone(settings),
        addEvent,
        addMilestone,
        recordConversation,
        list,
        getPromptContext,
        remove,
        removeByMessage,
        openManager,
        clear,
        exportData,
        importData,
        getStats,
        getAll: () => clone(store),
        getCurrentScope: currentScope
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})(window, document);
