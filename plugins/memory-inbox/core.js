/**
 * EVE Memory Confirmation Inbox v1.3.0
 * 自动提取的长期事实／事件先进入待确认匣，确认后才写入 EVEMemory。
 * 对话共同经历仍由原记忆模块自动维护。
 */
(function (window, document) {
  'use strict';
  if (window.EVEMemoryInbox?.version) return;

  const VERSION = '1.3.0';
  const SETTINGS_KEY = 'eve_memory_inbox_settings_v1';
  const STORE_KEY = 'eve_memory_inbox_store_v1';
  const STYLE_ID = 'eve-memory-inbox-style';
  const DEFAULTS = Object.freeze({
    enabled: true,
    confirmationMode: true,
    queueFacts: true,
    queueEvents: true,
    autoApproveThreshold: 0,
    maxPending: 250,
    showDockBadge: true,
    debug: false
  });

  let settings = readJson(SETTINGS_KEY, DEFAULTS);
  let store = readJson(STORE_KEY, { pending: [], decisions: [], updatedAt: 0 });
  let initialized = false;
  let observer = null;
  const disposers = [];

  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      return parsed && typeof parsed === 'object' ? Object.assign({}, fallback, parsed) : Object.assign({}, fallback);
    } catch (_) { return Object.assign({}, fallback); }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }
  function clone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }
  function clean(value, max = 1000) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
  function slug(value) { return clean(value, 120).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'memory'; }
  function uid(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
  function emit(name, detail = {}) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} }
  function on(target, name, handler, options) { target.addEventListener(name, handler, options); disposers.push(() => target.removeEventListener(name, handler, options)); }
  function log(...args) { if (settings.debug) console.log('[EVEMemoryInbox]', ...args); }
  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    if (window.showToast) return window.showToast(message, type);
    console.log('[EVEMemoryInbox]', message);
  }
  function memory() { return window.EVEMemory || null; }
  function currentScope() {
    return clean(memory()?.getCurrentScope?.() || window.EVEAdapter?.getCurrentChat?.().scope || 'global', 160) || 'global';
  }
  function normalizeIds(ids) {
    return Array.from(new Set((Array.isArray(ids) ? ids : ids ? [ids] : []).map(value => clean(value, 200)).filter(Boolean)));
  }
  function persist() {
    store.updatedAt = Date.now();
    store.pending = Array.isArray(store.pending) ? store.pending.slice(-settings.maxPending) : [];
    store.decisions = Array.isArray(store.decisions) ? store.decisions.slice(-300) : [];
    writeJson(STORE_KEY, store);
    updateBadge();
    emit('eve:memory-inbox-updated', getStats());
  }
  function getSettings() { return Object.assign({}, settings); }
  function syncMemoryMode() {
    const api = memory();
    if (!api?.configure) return false;
    // confirmationMode 开启时，关闭原模块的直接自动写入；手动与已确认写入不受影响。
    api.configure({ autoExtract: !(settings.enabled && settings.confirmationMode) });
    return true;
  }
  function configure(patch = {}) {
    settings = Object.assign({}, DEFAULTS, settings, patch || {});
    ['enabled', 'confirmationMode', 'queueFacts', 'queueEvents', 'showDockBadge', 'debug'].forEach(key => { settings[key] = Boolean(settings[key]); });
    settings.autoApproveThreshold = clamp(settings.autoApproveThreshold, 0, 1);
    settings.maxPending = Math.max(20, Math.min(1000, Number(settings.maxPending) || 250));
    writeJson(SETTINGS_KEY, settings);
    syncMemoryMode();
    persist();
    emit('eve:memory-inbox-settings-updated', { settings: getSettings() });
    return getSettings();
  }

  function existingFingerprints() {
    const all = memory()?.getAll?.() || { facts: [], events: [] };
    const set = new Set();
    for (const fact of all.facts || []) set.add(`fact|${fact.scope}|${slug(fact.key || fact.type)}|${clean(fact.value, 250).toLowerCase()}`);
    for (const event of all.events || []) set.add(`event|${event.scope}|${clean(event.title, 250).toLowerCase()}`);
    for (const item of store.pending || []) set.add(item.fingerprint);
    return set;
  }
  function makeCandidate(kind, payload, meta = {}) {
    const scope = clean(payload.scope || meta.scope || currentScope(), 160) || 'global';
    payload.scope = scope;
    const fingerprint = kind === 'fact'
      ? `fact|${scope}|${slug(payload.key || payload.type)}|${clean(payload.value, 250).toLowerCase()}`
      : `event|${scope}|${clean(payload.title, 250).toLowerCase()}`;
    return {
      id: uid('pending'), kind, scope, fingerprint,
      payload: clone(payload),
      sourceText: clean(meta.sourceText, 1000),
      sourceMessageIds: normalizeIds(meta.sourceMessageIds),
      confidence: clamp(payload.confidence == null ? meta.confidence || 0.7 : payload.confidence, 0, 1),
      createdAt: Date.now()
    };
  }

  function extractCandidates(text, options = {}) {
    const sourceText = clean(text, 1200);
    if (!sourceText || !settings.enabled || !settings.confirmationMode) return [];
    const scope = clean(options.scope || currentScope(), 160) || 'global';
    const ids = normalizeIds(options.sourceMessageIds || options.messageId);
    const candidates = [];

    if (settings.queueFacts) {
      const patterns = [
        { type: 'identity', key: 'name', re: /(?:我叫|我的名字是|叫我)([^，。！？,.!?\n]{1,24})/g, format: m => `使用者的名字是${m[1].trim()}`, importance: 4, confidence: .9 },
        { type: 'birthday', key: 'birthday', re: /(?:我的生日是|我生日(?:在|是)?)(\d{1,2}月\d{1,2}日|\d{1,2}[\/.-]\d{1,2})/g, format: m => `使用者的生日是${m[1]}`, importance: 4, confidence: .9 },
        { type: 'preference', key: 'likes', re: /我(?:很|最|也)?喜(?:歡|欢)([^，。！？,.!?\n]{1,60})/g, format: m => `使用者喜歡${m[1].trim()}`, importance: 3, confidence: .76 },
        { type: 'preference', key: 'dislikes', re: /我(?:很|最)?(?:不喜歡|不喜欢|討厭|讨厌)([^，。！？,.!?\n]{1,60})/g, format: m => `使用者不喜歡${m[1].trim()}`, importance: 3, confidence: .78 },
        { type: 'location', key: 'lives-in', re: /我(?:住在|住)([^，。！？,.!?\n]{1,50})/g, format: m => `使用者住在${m[1].trim()}`, importance: 3, confidence: .78 },
        { type: 'identity', key: 'job-or-study', re: /我是(?:一名|個|个)?([^，。！？,.!?\n]{1,40}(?:學生|学生|老師|老师|設計師|设计师|畫家|画家|工程師|工程师|大學生|大学生))/g, format: m => `使用者是${m[1].trim()}`, importance: 4, confidence: .78 },
        { type: 'goal', key: 'wants', re: /我(?:想要|想|希望)([^，。！？,.!?\n]{2,70})/g, format: m => `使用者希望${m[1].trim()}`, importance: 3, confidence: .68 }
      ];
      for (const pattern of patterns) {
        pattern.re.lastIndex = 0;
        let match;
        while ((match = pattern.re.exec(sourceText)) && candidates.length < 8) {
          const value = clean(pattern.format(match), 180);
          if (value.length < 4) continue;
          candidates.push(makeCandidate('fact', {
            scope, type: pattern.type, key: pattern.key, value,
            source: 'memory-inbox-approved', importance: pattern.importance,
            confidence: pattern.confidence, tags: ['confirmed-extraction'], sourceMessageIds: ids
          }, { scope, sourceText, sourceMessageIds: ids, confidence: pattern.confidence }));
        }
      }
    }

    if (settings.queueEvents) {
      const eventPatterns = [
        { re: /(?:明天|後天|后天|下週|下周|今天|今晚|這週|这周).{0,12}(?:要|會|会|準備|准备|打算)([^。！？!?\n]{2,90})/g, confidence: .7 },
        { re: /(?:剛剛|刚刚|今天|昨天|前天).{0,12}(?:去了|完成了|考完了|發生了|发生了|收到)([^。！？!?\n]{2,90})/g, confidence: .72 }
      ];
      for (const pattern of eventPatterns) {
        pattern.re.lastIndex = 0;
        let match;
        while ((match = pattern.re.exec(sourceText)) && candidates.length < 10) {
          candidates.push(makeCandidate('event', {
            scope, title: clean(match[0], 160), description: sourceText,
            category: 'mentioned-event', source: 'memory-inbox-approved',
            importance: /很重要|不要忘|第一次|生日|考試|考试|旅行|生病/.test(match[0]) ? 4 : 3,
            confidence: pattern.confidence, tags: ['confirmed-extraction'],
            sourceMessageIds: ids
          }, { scope, sourceText, sourceMessageIds: ids, confidence: pattern.confidence }));
        }
      }
    }
    return candidates;
  }

  function queueFromText(text, options = {}) {
    const fingerprints = existingFingerprints();
    const candidates = extractCandidates(text, options).filter(item => !fingerprints.has(item.fingerprint));
    const queued = [];
    for (const candidate of candidates) {
      if (settings.autoApproveThreshold > 0 && candidate.confidence >= settings.autoApproveThreshold) {
        const result = approveCandidate(candidate, { removeFromStore: false });
        if (result) queued.push(Object.assign({}, candidate, { autoApproved: true }));
      } else {
        store.pending.push(candidate);
        fingerprints.add(candidate.fingerprint);
        queued.push(candidate);
      }
    }
    if (queued.length) persist();
    return clone(queued);
  }

  function approveCandidate(candidate, options = {}) {
    const api = memory();
    if (!api) return false;
    let result = null;
    if (candidate.kind === 'fact') result = api.addFact?.(candidate.payload);
    if (candidate.kind === 'event') result = api.addEvent?.(candidate.payload);
    if (!result) return false;
    if (options.removeFromStore !== false) store.pending = store.pending.filter(item => item.id !== candidate.id);
    store.decisions.push({ id: candidate.id, action: 'approved', at: Date.now(), memoryId: result.id || '', fingerprint: candidate.fingerprint });
    persist();
    emit('eve:memory-inbox-approved', { candidate: clone(candidate), memory: clone(result) });
    return clone(result);
  }
  function approve(id, patch = {}) {
    const candidate = store.pending.find(item => item.id === id);
    if (!candidate) return false;
    candidate.payload = Object.assign({}, candidate.payload, patch || {});
    return approveCandidate(candidate);
  }
  function reject(id) {
    const candidate = store.pending.find(item => item.id === id);
    if (!candidate) return false;
    store.pending = store.pending.filter(item => item.id !== id);
    store.decisions.push({ id, action: 'rejected', at: Date.now(), fingerprint: candidate.fingerprint });
    persist();
    emit('eve:memory-inbox-rejected', { candidate: clone(candidate) });
    return true;
  }
  function approveAll(options = {}) {
    const list = getPending(options);
    let count = 0;
    for (const item of list) if (approve(item.id)) count += 1;
    return count;
  }
  function rejectAll(options = {}) {
    const ids = getPending(options).map(item => item.id);
    ids.forEach(reject);
    return ids.length;
  }
  function getPending(options = {}) {
    const scope = clean(options.scope || '', 160);
    return clone((store.pending || [])
      .filter(item => !scope || item.scope === scope || (options.includeGlobal !== false && item.scope === 'global'))
      .sort((a, b) => b.createdAt - a.createdAt));
  }
  function removeByMessage(messageId) {
    const id = clean(messageId, 200);
    if (!id) return 0;
    const before = store.pending.length;
    store.pending = store.pending.filter(item => !normalizeIds(item.sourceMessageIds).includes(id));
    const removed = before - store.pending.length;
    if (removed) persist();
    return removed;
  }
  function clearPending(options = {}) {
    const scope = clean(options.scope || '', 160);
    if (!scope) store.pending = [];
    else store.pending = store.pending.filter(item => item.scope !== scope);
    persist();
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style'); style.id = STYLE_ID;
    style.textContent = `
      .eve-memory-inbox-badge{position:absolute;right:-5px;top:-5px;min-width:18px;height:18px;padding:0 4px;border-radius:10px;background:#ff3b30;color:#fff;font-size:10px;line-height:18px;text-align:center;font-weight:700;box-shadow:0 1px 5px #0005;display:none;z-index:3}
      .dock-app-icon:has(.eve-memory-inbox-badge){position:relative}
      #eve-memory-inbox .eve-memory-inbox-card{border-bottom:1px solid #ddd;padding:12px 14px}
      #eve-memory-inbox .eve-memory-inbox-type{display:inline-block;font-size:10px;padding:3px 7px;border-radius:8px;background:rgba(74,132,193,.12);color:#4a84c1;margin-right:6px}
      #eve-memory-inbox .eve-memory-inbox-confidence{font-size:11px;opacity:.55}
      #eve-memory-inbox .eve-memory-inbox-value{font-weight:700;line-height:1.45;margin-top:7px}
      #eve-memory-inbox .eve-memory-inbox-source{font-size:11px;line-height:1.45;opacity:.62;margin-top:6px;padding:7px 9px;border-radius:9px;background:rgba(0,0,0,.045)}
      #eve-memory-inbox .eve-memory-inbox-actions{display:flex;gap:7px;justify-content:flex-end;margin-top:9px}
      #eve-memory-inbox .eve-memory-inbox-actions button{border:0;border-radius:9px;padding:7px 10px;background:rgba(0,0,0,.06)}
      #eve-memory-inbox .eve-memory-inbox-actions [data-approve]{background:#4a84c1;color:#fff}
      body[data-theme="dark"] #eve-memory-inbox .eve-memory-inbox-source{background:rgba(255,255,255,.07)}
    `;
    document.head.append(style);
  }
  function memoryDockIcon() {
    return document.querySelector('.dock-app[onclick*="memory-viewer-screen"] .dock-app-icon') ||
      [...document.querySelectorAll('.dock-app')].find(item => /记忆|記憶/.test(item.textContent || ''))?.querySelector('.dock-app-icon');
  }
  function injectBadge() {
    if (!settings.showDockBadge) return false;
    const icon = memoryDockIcon(); if (!icon) return false;
    let badge = icon.querySelector('.eve-memory-inbox-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'eve-memory-inbox-badge';
      badge.setAttribute('role', 'button');
      badge.title = '待确认记忆';
      badge.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openInbox(); });
      icon.append(badge);
    }
    return true;
  }
  function updateBadge() {
    injectBadge();
    const badge = memoryDockIcon()?.querySelector('.eve-memory-inbox-badge');
    if (!badge) return;
    const count = (store.pending || []).length;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.style.display = settings.showDockBadge && count ? 'block' : 'none';
  }
  function enhanceMemoryManager() {
    const manager = document.getElementById('eve-memory-manager');
    if (!manager || manager.querySelector('[data-eve-memory-inbox-open]')) return;
    const header = manager.querySelector('div > div');
    if (!header) return;
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.eveMemoryInboxOpen = '1';
    button.textContent = `待确认 ${store.pending.length}`;
    button.onclick = () => openInbox();
    header.insertBefore(button, header.lastElementChild);
  }
  function editCandidate(candidate) {
    const current = candidate.kind === 'fact' ? candidate.payload.value : candidate.payload.title;
    const next = prompt(candidate.kind === 'fact' ? '修改要保存的记忆' : '修改事件标题', current);
    if (next === null || !clean(next)) return false;
    if (candidate.kind === 'fact') candidate.payload.value = clean(next, 300);
    else candidate.payload.title = clean(next, 220);
    candidate.fingerprint = candidate.kind === 'fact'
      ? `fact|${candidate.scope}|${slug(candidate.payload.key || candidate.payload.type)}|${candidate.payload.value.toLowerCase()}`
      : `event|${candidate.scope}|${candidate.payload.title.toLowerCase()}`;
    persist();
    return true;
  }
  function openInbox() {
    document.getElementById('eve-memory-inbox')?.remove();
    const overlay = document.createElement('div'); overlay.id = 'eve-memory-inbox';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:12px';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:min(680px,100%);max-height:92vh;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 18px 60px #0006';
    panel.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #ddd"><b style="flex:1">待确认记忆</b><button data-approve-all>全部保留</button><button data-reject-all>全部忽略</button><button data-close>✕</button></div><div style="padding:9px 14px;border-bottom:1px solid #ddd;font-size:12px;opacity:.7">AI 自动提取的长期事实与事件会先放在这里，确认后才进入正式记忆。对话共同经历仍会自动保存。</div><div data-list style="overflow:auto;min-height:260px"></div><div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid #ddd"><label style="flex:1;font-size:12px"><input data-mode type="checkbox" ${settings.confirmationMode ? 'checked' : ''}> 自动提取先进入待确认匣</label><button data-clear style="color:#c33">清空待确认</button></div>`;
    overlay.append(panel); document.body.append(overlay);

    const render = () => {
      const scope = currentScope();
      const items = getPending({ scope, includeGlobal: true });
      const list = panel.querySelector('[data-list]'); list.innerHTML = '';
      if (!items.length) {
        list.innerHTML = '<div style="padding:55px 20px;text-align:center;opacity:.62">目前没有待确认记忆</div>';
        return;
      }
      for (const item of items) {
        const value = item.kind === 'fact' ? item.payload.value : item.payload.title;
        const card = document.createElement('div'); card.className = 'eve-memory-inbox-card';
        card.innerHTML = `<div><span class="eve-memory-inbox-type">${item.kind === 'fact' ? '长期事实' : '事件'}</span><span class="eve-memory-inbox-confidence">置信度 ${Math.round(item.confidence * 100)}%</span></div><div class="eve-memory-inbox-value">${escapeHtml(value)}</div>${item.sourceText ? `<div class="eve-memory-inbox-source">来源：${escapeHtml(item.sourceText)}</div>` : ''}<div class="eve-memory-inbox-actions"><button data-reject>忽略</button><button data-edit>修改</button><button data-approve>保留</button></div>`;
        card.querySelector('[data-reject]').onclick = () => { reject(item.id); render(); };
        card.querySelector('[data-edit]').onclick = () => { const live = store.pending.find(entry => entry.id === item.id); if (live && editCandidate(live)) render(); };
        card.querySelector('[data-approve]').onclick = () => { approve(item.id); render(); };
        list.append(card);
      }
    };
    const close = () => overlay.remove();
    panel.querySelector('[data-close]').onclick = close;
    overlay.onclick = event => { if (event.target === overlay) close(); };
    panel.querySelector('[data-approve-all]').onclick = () => { const count = approveAll({ scope: currentScope(), includeGlobal: true }); toast(`已保留 ${count} 条记忆`); render(); };
    panel.querySelector('[data-reject-all]').onclick = () => { if (!confirm('忽略当前列表里的全部待确认记忆？')) return; const count = rejectAll({ scope: currentScope(), includeGlobal: true }); toast(`已忽略 ${count} 条`); render(); };
    panel.querySelector('[data-clear]').onclick = () => { if (confirm('清空所有待确认记忆？')) { clearPending(); render(); } };
    panel.querySelector('[data-mode]').onchange = event => configure({ confirmationMode: event.target.checked });
    render();
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function getStats() {
    return {
      version: VERSION, initialized,
      enabled: settings.enabled,
      confirmationMode: settings.confirmationMode,
      pending: (store.pending || []).length,
      decisions: (store.decisions || []).length,
      memoryLoaded: Boolean(memory()),
      memoryAutoExtract: memory()?.getSettings?.().autoExtract
    };
  }
  function bindEvents() {
    on(window, 'eve:user-message-committed', event => {
      if (!settings.enabled || !settings.confirmationMode) return;
      const detail = event.detail || {};
      const message = detail.message || {};
      const text = clean(detail.text || message.text || message.content, 1200); if (!text) return;
      const messageId = detail.messageId || detail.id || message.messageId || message.id;
      queueFromText(text, {
        scope: detail.scope || detail.chat?.scope || message.scope || currentScope(),
        messageId,
        sourceMessageIds: [messageId].filter(Boolean)
      });
    });
    on(window, 'eve:message-recalled', event => {
      const detail = event.detail || {};
      removeByMessage(detail.messageId || detail.id || detail.message?.messageId || detail.message?.id);
    });
    on(window, 'eve:memory-ready', syncMemoryMode);
    on(window, 'eve:memory-inbox-updated', () => { updateBadge(); enhanceMemoryManager(); });
  }
  function init() {
    if (initialized) return Promise.resolve(getStats());
    initialized = true;
    injectStyle(); bindEvents(); syncMemoryMode();
    const retry = setInterval(() => { if (injectBadge()) { clearInterval(retry); updateBadge(); } }, 500);
    setTimeout(() => clearInterval(retry), 30000);
    observer = new MutationObserver(() => enhanceMemoryManager());
    observer.observe(document.body, { childList: true, subtree: true });
    updateBadge();
    window.EVE ||= {}; window.EVE.memoryInbox = window.EVEMemoryInbox;
    emit('eve:memory-inbox-ready', getStats());
    log('Ready', getStats());
    return Promise.resolve(getStats());
  }
  function destroy() {
    disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} });
    observer?.disconnect(); observer = null;
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById('eve-memory-inbox')?.remove();
    memoryDockIcon()?.querySelector('.eve-memory-inbox-badge')?.remove();
    initialized = false;
  }

  window.EVEMemoryInbox = Object.freeze({
    version: VERSION, init, destroy, configure, getSettings, getStats,
    extractCandidates, queueFromText, getPending, approve, reject,
    approveAll, rejectAll, removeByMessage, clearPending, openInbox
  });
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init, { once: true })
    : init();
})(window, document);
