/**
 * EVE Chat Memory Module v0.8.0
 * Long-term facts, recent events, conversation moments and prompt retrieval.
 */
(function (window, document) {
    'use strict';

    if (window.EVEMemory && window.EVEMemory.version) return;

    const VERSION = '0.8.0';
    const STORE_KEY = 'eve_memory_store_v1';
    const SETTINGS_KEY = 'eve_memory_settings_v1';
    const MAX_TEXT = 600;
    const DAY = 86400000;

    const DEFAULTS = Object.freeze({
        enabled: true,
        autoExtract: true,
        recordConversationMoments: true,
        maxFactsPerPrompt: 12,
        maxEventsPerPrompt: 8,
        maxMomentsPerPrompt: 4,
        maxStoredFacts: 500,
        maxStoredEvents: 500,
        maxStoredMoments: 300,
        recentEventDays: 45,
        minImportanceForPrompt: 2,
        defaultScope: 'global',
        debug: false
    });

    let settings = load(SETTINGS_KEY, DEFAULTS);
    let store = load(STORE_KEY, {
        schema: 1,
        facts: [],
        events: [],
        moments: [],
        updatedAt: 0
    });
    let initialized = false;
    let unregisterProvider = null;
    let pendingUserMessage = null;
    const disposers = [];

    function load(key, fallback) {
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || 'null');
            return parsed && typeof parsed === 'object'
                ? Object.assign({}, fallback, parsed)
                : clone(fallback);
        } catch (_) {
            return clone(fallback);
        }
    }

    function clone(value) {
        try {
            return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value));
        } catch (_) {
            return value;
        }
    }

    function save() {
        store.updatedAt = Date.now();
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(store));
            return true;
        } catch (error) {
            console.warn('[EVEMemory] Save failed.', error);
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
        if (settings.debug) console.log('[EVEMemory]', ...args);
    }

    function cleanText(value, max = MAX_TEXT) {
        return String(value == null ? '' : value)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, max);
    }

    function slug(value) {
        return cleanText(value, 120)
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_-]+/gu, '-')
            .replace(/^-+|-+$/g, '') || 'memory';
    }

    function uid(prefix) {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, Number(value) || 0));
    }

    function currentScope() {
        const adapterScope = window.EVEAdapter?.getCurrentChat?.().scope;
        if (adapterScope && adapterScope !== 'global') return adapterScope;
        const title = document.getElementById('api-chat-title');
        const visibleTitle = title && title.offsetParent !== null ? cleanText(title.textContent, 100) : '';
        if (visibleTitle) return `character:${slug(visibleTitle)}`;
        return settings.defaultScope || 'global';
    }

    function normalizeScope(scope) {
        return cleanText(scope || currentScope(), 120) || 'global';
    }

    function normalizeTags(tags) {
        const values = Array.isArray(tags) ? tags : String(tags || '').split(',');
        return Array.from(new Set(values.map(tag => slug(tag)).filter(Boolean))).slice(0, 20);
    }

    function normalizeSourceIds(ids) {
        const values = Array.isArray(ids) ? ids : (ids ? [ids] : []);
        return Array.from(new Set(values.map(id => cleanText(id, 200)).filter(Boolean))).slice(0, 40);
    }

    function dedupeKey(type, key, value, scope) {
        return [scope, type, slug(key || type), cleanText(value, 250).toLowerCase()].join('|');
    }

    function trimStore() {
        store.facts.sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt));
        store.events.sort((a, b) => (b.importance - a.importance) || (b.occurredAt - a.occurredAt));
        store.moments.sort((a, b) => b.createdAt - a.createdAt);
        store.facts = store.facts.slice(0, settings.maxStoredFacts);
        store.events = store.events.slice(0, settings.maxStoredEvents);
        store.moments = store.moments.slice(0, settings.maxStoredMoments);
    }

    function addFact(input) {
        const item = typeof input === 'string' ? { value: input } : (input || {});
        const value = cleanText(item.value || item.text);
        if (!value) throw new TypeError('Memory fact requires a value.');

        const scope = normalizeScope(item.scope);
        const type = slug(item.type || 'fact');
        const key = slug(item.key || type);
        const now = Date.now();
        const fingerprint = dedupeKey(type, key, value, scope);
        const existing = store.facts.find(fact => fact.fingerprint === fingerprint);

        if (existing) {
            existing.updatedAt = now;
            existing.lastSeenAt = now;
            existing.seenCount = (existing.seenCount || 1) + 1;
            existing.importance = Math.max(existing.importance || 1, clamp(item.importance || 3, 1, 5));
            existing.tags = Array.from(new Set([...(existing.tags || []), ...normalizeTags(item.tags)]));
            existing.sourceMessageIds = Array.from(new Set([...(existing.sourceMessageIds || []), ...normalizeSourceIds(item.sourceMessageIds)]));
            save();
            emit('eve:memory-updated', { kind: 'fact', item: clone(existing) });
            return clone(existing);
        }

        const fact = {
            id: uid('fact'),
            fingerprint,
            scope,
            type,
            key,
            value,
            source: cleanText(item.source || 'manual', 60),
            importance: clamp(item.importance || 3, 1, 5),
            confidence: clamp(item.confidence == null ? 0.8 : item.confidence, 0, 1),
            tags: normalizeTags(item.tags),
            sourceMessageIds: normalizeSourceIds(item.sourceMessageIds),
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
            seenCount: 1,
            archived: false
        };

        store.facts.push(fact);
        trimStore();
        save();
        emit('eve:memory-added', { kind: 'fact', item: clone(fact) });
        return clone(fact);
    }

    function addEvent(input) {
        const item = typeof input === 'string' ? { title: input } : (input || {});
        const title = cleanText(item.title || item.text, 180);
        if (!title) throw new TypeError('Memory event requires a title.');

        const scope = normalizeScope(item.scope);
        const occurredAt = Number(item.occurredAt || item.date) || Date.now();
        const fingerprint = [scope, title.toLowerCase(), new Date(occurredAt).toISOString().slice(0, 10)].join('|');
        const existing = store.events.find(event => event.fingerprint === fingerprint);
        if (existing) {
            existing.updatedAt = Date.now();
            existing.importance = Math.max(existing.importance, clamp(item.importance || 3, 1, 5));
            if (item.description) existing.description = cleanText(item.description);
            existing.sourceMessageIds = Array.from(new Set([...(existing.sourceMessageIds || []), ...normalizeSourceIds(item.sourceMessageIds)]));
            save();
            emit('eve:memory-updated', { kind: 'event', item: clone(existing) });
            return clone(existing);
        }

        const event = {
            id: uid('event'),
            fingerprint,
            scope,
            title,
            description: cleanText(item.description || '', 500),
            category: slug(item.category || 'life-event'),
            source: cleanText(item.source || 'manual', 60),
            sourceMessageIds: normalizeSourceIds(item.sourceMessageIds),
            importance: clamp(item.importance || 3, 1, 5),
            tags: normalizeTags(item.tags),
            occurredAt,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            archived: false
        };

        store.events.push(event);
        trimStore();
        save();
        emit('eve:memory-added', { kind: 'event', item: clone(event) });
        return clone(event);
    }

    function addMoment(input) {
        const item = input || {};
        const userText = cleanText(item.userText, 500);
        const assistantText = cleanText(item.assistantText, 500);
        if (!userText && !assistantText) return null;

        const moment = {
            id: uid('moment'),
            scope: normalizeScope(item.scope),
            userText,
            assistantText,
            summary: cleanText(item.summary || summarizeMoment(userText, assistantText), 300),
            importance: clamp(item.importance || estimateImportance(`${userText} ${assistantText}`), 1, 5),
            tags: normalizeTags(item.tags),
            sourceMessageIds: normalizeSourceIds(item.sourceMessageIds),
            createdAt: Date.now(),
            archived: false
        };

        const duplicate = store.moments.find(existing =>
            existing.scope === moment.scope &&
            existing.userText === moment.userText &&
            Math.abs(existing.createdAt - moment.createdAt) < 10 * 60 * 1000
        );
        if (duplicate) {
            duplicate.sourceMessageIds = Array.from(new Set([...(duplicate.sourceMessageIds || []), ...moment.sourceMessageIds]));
            duplicate.assistantText ||= moment.assistantText;
            duplicate.summary ||= moment.summary;
            save();
            return clone(duplicate);
        }

        store.moments.push(moment);
        trimStore();
        save();
        emit('eve:memory-added', { kind: 'moment', item: clone(moment) });
        return clone(moment);
    }

    function summarizeMoment(userText, assistantText) {
        if (userText && assistantText) return `使用者提到「${userText.slice(0, 120)}」，角色回應了這件事。`;
        if (userText) return `使用者提到「${userText.slice(0, 150)}」。`;
        return `角色曾說「${assistantText.slice(0, 150)}」。`;
    }

    function estimateImportance(text) {
        const value = String(text || '');
        let score = 1;
        if (/生日|紀念日|结婚|結婚|分手|告白|生病|住院|考試|考试|畢業|毕业|搬家|旅行|工作|入學|入学|家人|寵物|宠物/.test(value)) score += 2;
        if (/很重要|不要忘|記住|记住|永遠|永远|第一次|最後一次|最后一次/.test(value)) score += 1;
        if (/喜歡|喜欢|討厭|讨厌|害怕|夢想|梦想|希望/.test(value)) score += 1;
        return clamp(score, 1, 5);
    }

    function extractFacts(text, options = {}) {
        if (!settings.autoExtract) return [];
        const sourceText = cleanText(text, 1000);
        if (!sourceText) return [];
        const scope = normalizeScope(options.scope);
        const created = [];
        const patterns = [
            { type: 'identity', key: 'name', re: /(?:我叫|我的名字是|叫我)([^，。！？,.!?\n]{1,24})/g, format: m => `使用者的名字是${m[1].trim()}` },
            { type: 'birthday', key: 'birthday', re: /(?:我的生日是|我生日(?:在|是)?)(\d{1,2}月\d{1,2}日|\d{1,2}[\/.-]\d{1,2})/g, format: m => `使用者的生日是${m[1]}` },
            { type: 'preference', key: 'likes', re: /我(?:很|最|也)?喜(?:歡|欢)([^，。！？,.!?\n]{1,60})/g, format: m => `使用者喜歡${m[1].trim()}` },
            { type: 'preference', key: 'dislikes', re: /我(?:很|最)?(?:不喜歡|不喜欢|討厭|讨厌)([^，。！？,.!?\n]{1,60})/g, format: m => `使用者不喜歡${m[1].trim()}` },
            { type: 'location', key: 'lives-in', re: /我(?:住在|住)([^，。！？,.!?\n]{1,50})/g, format: m => `使用者住在${m[1].trim()}` },
            { type: 'identity', key: 'job-or-study', re: /我是(?:一名|個|个)?([^，。！？,.!?\n]{1,40}(?:學生|学生|老師|老师|設計師|设计师|畫家|画家|工程師|工程师|大學生|大学生))/g, format: m => `使用者是${m[1].trim()}` },
            { type: 'goal', key: 'wants', re: /我(?:想要|想|希望)([^，。！？,.!?\n]{2,70})/g, format: m => `使用者希望${m[1].trim()}` }
        ];

        for (const pattern of patterns) {
            pattern.re.lastIndex = 0;
            let match;
            while ((match = pattern.re.exec(sourceText)) && created.length < 8) {
                const value = cleanText(pattern.format(match), 180);
                if (value.length < 4) continue;
                created.push(addFact({
                    scope,
                    type: pattern.type,
                    key: pattern.key,
                    value,
                    source: options.source || 'auto-user-message',
                    importance: pattern.type === 'birthday' || pattern.type === 'identity' ? 4 : 3,
                    confidence: 0.72,
                    tags: ['auto-extracted'],
                    sourceMessageIds: options.sourceMessageIds
                }));
            }
        }

        const eventPatterns = [
            /(?:明天|後天|后天|下週|下周|今天|今晚|這週|这周).{0,12}(?:要|會|会|準備|准备|打算)([^。！？!?\n]{2,90})/g,
            /(?:剛剛|刚刚|今天|昨天|前天).{0,12}(?:去了|完成了|考完了|發生了|发生了|收到)([^。！？!?\n]{2,90})/g
        ];
        for (const regex of eventPatterns) {
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(sourceText)) && created.length < 10) {
                created.push(addEvent({
                    scope,
                    title: cleanText(match[0], 160),
                    description: sourceText,
                    category: 'mentioned-event',
                    source: options.source || 'auto-user-message',
                    importance: estimateImportance(match[0]),
                    tags: ['auto-extracted'],
                    sourceMessageIds: options.sourceMessageIds
                }));
            }
        }

        return created;
    }

    function tokenize(text) {
        const normalized = String(text || '').toLowerCase();
        const words = normalized.match(/[\p{L}\p{N}]{2,}/gu) || [];
        return Array.from(new Set(words)).slice(0, 80);
    }

    function relevanceScore(item, queryTokens, scope) {
        let score = (item.importance || 1) * 3;
        if (item.scope === scope) score += 6;
        else if (item.scope === 'global') score += 3;
        else score -= 4;

        const haystack = [item.value, item.title, item.description, item.summary, ...(item.tags || [])].join(' ').toLowerCase();
        for (const token of queryTokens) if (haystack.includes(token)) score += 4;
        const age = Date.now() - (item.updatedAt || item.occurredAt || item.createdAt || 0);
        score += Math.max(0, 3 - age / (30 * DAY));
        return score;
    }

    function retrieve(options = {}) {
        const scope = normalizeScope(options.scope);
        const queryTokens = tokenize(options.query || '');
        const includeGlobal = options.includeGlobal !== false;
        const allowedScope = item => !item.archived && (item.scope === scope || (includeGlobal && item.scope === 'global'));

        const facts = store.facts
            .filter(allowedScope)
            .filter(item => item.importance >= settings.minImportanceForPrompt)
            .map(item => ({ item, score: relevanceScore(item, queryTokens, scope) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, options.factLimit || settings.maxFactsPerPrompt)
            .map(entry => clone(entry.item));

        const cutoff = Date.now() - settings.recentEventDays * DAY;
        const events = store.events
            .filter(allowedScope)
            .filter(item => item.occurredAt >= cutoff || item.importance >= 4)
            .map(item => ({ item, score: relevanceScore(item, queryTokens, scope) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, options.eventLimit || settings.maxEventsPerPrompt)
            .map(entry => clone(entry.item));

        const moments = store.moments
            .filter(allowedScope)
            .map(item => ({ item, score: relevanceScore(item, queryTokens, scope) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, options.momentLimit || settings.maxMomentsPerPrompt)
            .map(entry => clone(entry.item));

        return { scope, facts, events, moments };
    }

    function formatDate(timestamp) {
        try {
            return new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric' }).format(new Date(timestamp));
        } catch (_) {
            return new Date(timestamp).toLocaleDateString();
        }
    }

    function getPromptContext(meta = {}) {
        if (!settings.enabled) return '';
        const query = cleanText(meta.userText || meta.query || pendingUserMessage?.text || '', 500);
        const result = retrieve({ query, scope: meta.scope || meta.chat?.scope });
        const lines = [];

        if (result.facts.length) {
            lines.push('【長期記憶】');
            result.facts.forEach(item => lines.push(`- ${item.value}`));
        }
        if (result.events.length) {
            lines.push('【近期與重要事件】');
            result.events.forEach(item => lines.push(`- ${formatDate(item.occurredAt)}：${item.title}${item.description ? `（${item.description.slice(0, 120)}）` : ''}`));
        }
        if (result.moments.length) {
            lines.push('【共同經歷】');
            result.moments.forEach(item => lines.push(`- ${item.summary}`));
        }
        if (!lines.length) return '';

        lines.push('請自然運用記憶，不要逐條背誦，不要聲稱擁有資料庫，也不要把不確定的記憶當成絕對事實。');
        return lines.join('\n');
    }

    function removeByMessage(messageId, text) {
        const id = cleanText(messageId, 200);
        const sample = cleanText(text, 1000);
        let removed = 0;

        // Facts can be supported by more than one message.  When one source is
        // recalled, keep the fact only if another independent source remains.
        store.facts = store.facts.filter(item => {
            const sources = normalizeSourceIds(item.sourceMessageIds);
            if (id && sources.includes(id)) {
                const remaining = sources.filter(source => source !== id);
                if (remaining.length) {
                    item.sourceMessageIds = remaining;
                    return true;
                }
                removed += 1;
                return false;
            }
            if (!sources.length && sample.length >= 6) {
                const value = cleanText(item.value, 1200);
                const short = sample.slice(0, 180);
                if (value && (value === sample || value.includes(short))) {
                    removed += 1;
                    return false;
                }
            }
            return true;
        });

        // Events and conversation moments contain the wording/context of all
        // their source messages.  If any source message is recalled, remove the
        // whole derived record so the recalled text cannot remain in prompts.
        function purgeDerived(items) {
            return items.filter(item => {
                const sources = normalizeSourceIds(item.sourceMessageIds);
                if (id && sources.includes(id)) {
                    removed += 1;
                    return false;
                }
                if (!sources.length && sample.length >= 6) {
                    const fields = [item.title,item.description,item.userText,item.assistantText,item.summary]
                        .map(value => cleanText(value, 1200));
                    const short = sample.slice(0, 180);
                    if (fields.some(value => value && (value === sample || value.includes(short)))) {
                        removed += 1;
                        return false;
                    }
                }
                return true;
            });
        }
        store.events = purgeDerived(store.events);
        store.moments = purgeDerived(store.moments);

        if (removed) {
            save();
            emit('eve:memory-purged-by-message', { messageId:id, removed });
        }
        return removed;
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        })[char]);
    }

    function openManager() {
        document.getElementById('eve-memory-manager')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'eve-memory-manager';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999996;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:14px';
        const panel = document.createElement('div');
        panel.style.cssText = 'width:min(680px,100%);max-height:90vh;display:flex;flex-direction:column;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;overflow:hidden;box-shadow:0 15px 50px #0004';
        panel.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #ddd">
            <b style="flex:1">扩展记忆管理</b>
            <input data-search placeholder="搜索" style="width:150px;padding:7px;border:1px solid #ccc;border-radius:8px">
            <button data-add type="button">＋</button><button data-close type="button">✕</button>
          </div>
          <div data-list style="overflow:auto;padding:8px 14px;min-height:180px"></div>
          <div style="padding:12px 16px;border-top:1px solid #ddd;display:flex;justify-content:space-between">
            <small>只显示当前角色与全局扩展记忆</small><button data-clear type="button" style="color:#c33">清空当前角色</button>
          </div>`;
        overlay.append(panel);
        document.body.append(overlay);

        const render = () => {
            const query = cleanText(panel.querySelector('[data-search]').value, 100).toLowerCase();
            const scope = currentScope();
            const items = [
                ...store.facts.map(item => ({ ...item, kind:'长期', label:item.value })),
                ...store.events.map(item => ({ ...item, kind:'事件', label:item.title })),
                ...store.moments.map(item => ({ ...item, kind:'对话', label:item.summary }))
            ].filter(item => item.scope === scope || item.scope === 'global')
             .filter(item => !query || cleanText(item.label, 1200).toLowerCase().includes(query))
             .sort((a,b) => (b.updatedAt || b.occurredAt || b.createdAt) - (a.updatedAt || a.occurredAt || a.createdAt));
            const list = panel.querySelector('[data-list]');
            list.innerHTML = '';
            for (const item of items) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;gap:9px;align-items:flex-start;padding:10px 2px;border-bottom:1px solid #ddd';
                row.innerHTML = `<small style="min-width:36px;opacity:.6">${item.kind}</small><span style="flex:1;line-height:1.45">${escapeHtml(item.label)}</span><button type="button">删除</button>`;
                row.querySelector('button').onclick = () => { remove(item.id); render(); };
                list.append(row);
            }
            if (!items.length) list.innerHTML = '<div style="padding:36px;text-align:center;opacity:.6">暂无扩展记忆</div>';
        };
        panel.querySelector('[data-search]').oninput = render;
        panel.querySelector('[data-close]').onclick = () => overlay.remove();
        overlay.onclick = event => { if (event.target === overlay) overlay.remove(); };
        panel.querySelector('[data-add]').onclick = () => {
            const value = prompt('要让角色记住什么？');
            if (value) { addFact({ value, importance:4, source:'manual' }); render(); }
        };
        panel.querySelector('[data-clear]').onclick = () => {
            if (confirm('确定清空当前角色的扩展记忆？')) { clear({ scope:currentScope() }); render(); }
        };
        render();
    }

    function remove(id) {
        const before = store.facts.length + store.events.length + store.moments.length;
        store.facts = store.facts.filter(item => item.id !== id);
        store.events = store.events.filter(item => item.id !== id);
        store.moments = store.moments.filter(item => item.id !== id);
        const changed = before !== store.facts.length + store.events.length + store.moments.length;
        if (changed) {
            save();
            emit('eve:memory-removed', { id });
        }
        return changed;
    }

    function clear(options = {}) {
        const scope = options.scope ? normalizeScope(options.scope) : null;
        if (!scope) {
            store = { schema: 1, facts: [], events: [], moments: [], updatedAt: Date.now() };
        } else {
            store.facts = store.facts.filter(item => item.scope !== scope);
            store.events = store.events.filter(item => item.scope !== scope);
            store.moments = store.moments.filter(item => item.scope !== scope);
        }
        save();
        emit('eve:memory-cleared', { scope });
        return true;
    }

    function exportData() {
        return clone({ version: VERSION, exportedAt: new Date().toISOString(), settings, store });
    }

    function importData(data, options = {}) {
        if (!data || typeof data !== 'object') throw new TypeError('Invalid memory backup.');
        const incoming = data.store || data;
        if (!Array.isArray(incoming.facts) || !Array.isArray(incoming.events) || !Array.isArray(incoming.moments)) {
            throw new TypeError('Memory backup has an invalid structure.');
        }
        if (options.replace) {
            store = clone(incoming);
        } else {
            for (const fact of incoming.facts) addFact(fact);
            for (const event of incoming.events) addEvent(event);
            for (const moment of incoming.moments) addMoment(moment);
        }
        trimStore();
        save();
        emit('eve:memory-imported', { replace: Boolean(options.replace) });
        return getStats();
    }

    function getStats() {
        return {
            version: VERSION,
            initialized,
            scope: currentScope(),
            facts: store.facts.length,
            events: store.events.length,
            moments: store.moments.length,
            updatedAt: store.updatedAt
        };
    }

    function configure(next = {}) {
        settings = Object.assign({}, DEFAULTS, settings, next);
        settings.maxFactsPerPrompt = clamp(settings.maxFactsPerPrompt, 0, 100);
        settings.maxEventsPerPrompt = clamp(settings.maxEventsPerPrompt, 0, 100);
        settings.maxMomentsPerPrompt = clamp(settings.maxMomentsPerPrompt, 0, 100);
        settings.minImportanceForPrompt = clamp(settings.minImportanceForPrompt, 1, 5);
        saveSettings();
        trimStore();
        save();
        return clone(settings);
    }

    function registerWithAdapter() {
        if (!window.EVEAdapter || typeof window.EVEAdapter.registerContextProvider !== 'function') return false;
        if (unregisterProvider) unregisterProvider();
        unregisterProvider = window.EVEAdapter.registerContextProvider('memory', getPromptContext, { priority: 40 });
        return true;
    }

    function init() {
        if (initialized) return Promise.resolve(getStats());
        initialized = true;
        registerWithAdapter();

        on(window, 'eve:adapter-ready', registerWithAdapter);
        on(window, 'eve:user-message-sent', event => {
            const text = cleanText(event.detail?.text, 1000);
            if (!text) return;
            pendingUserMessage = {
                text,
                scope: event.detail?.chat?.scope || currentScope(),
                at: Date.now(),
                messageId: cleanText(event.detail?.messageId, 200)
            };
        });
        on(window, 'eve:user-message-committed', event => {
            const text = cleanText(event.detail?.text, 1000);
            if (!text) return;
            pendingUserMessage = {
                text,
                scope: event.detail?.scope || currentScope(),
                at: Date.now(),
                messageId: cleanText(event.detail?.messageId, 200)
            };
            extractFacts(text, {
                scope: pendingUserMessage.scope,
                source: 'user-message',
                sourceMessageIds: [pendingUserMessage.messageId]
            });
        });
        on(window, 'eve:ai-message-committed', event => {
            const assistantText = cleanText(event.detail?.text, 1000);
            if (!settings.recordConversationMoments || (!pendingUserMessage && !assistantText)) return;
            const user = pendingUserMessage;
            addMoment({
                scope: user?.scope || event.detail?.scope || currentScope(),
                userText: user?.text || '',
                assistantText,
                sourceMessageIds: [user?.messageId, event.detail?.messageId].filter(Boolean),
                importance: estimateImportance(`${user?.text || ''} ${assistantText}`)
            });
            pendingUserMessage = null;
        });

        window.EVE = window.EVE || {};
        window.EVE.memory = window.EVEMemory;
        emit('eve:memory-ready', getStats());
        log('Ready', getStats());
        return Promise.resolve(getStats());
    }

    function destroy() {
        disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} });
        if (unregisterProvider) unregisterProvider();
        unregisterProvider = null;
        initialized = false;
    }

    window.EVEMemory = Object.freeze({
        version: VERSION,
        init,
        destroy,
        configure,
        getSettings: () => clone(settings),
        addFact,
        addEvent,
        addMoment,
        extractFacts,
        retrieve,
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
