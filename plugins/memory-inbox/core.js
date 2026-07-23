/**
 * EVE Memory Confirmation Inbox v1.3.0
 * ------------------------------------------------------------
 * New long-term facts and important events are queued for review before
 * they are written into EVEMemory. Includes an independent home-screen app.
 */
(function (window, document) {
  'use strict';
  if (window.EVEMemoryInbox?.version) return;

  const VERSION = '1.3.0';
  const SETTINGS_KEY = 'eve_memory_inbox_settings_v1';
  const STORE_KEY = 'eve_memory_inbox_store_v1';
  const SCREEN_ID = 'eve-memory-inbox-screen';
  const ICON_ID = 'eve-memory-inbox-home-app';
  const STYLE_ID = 'eve-memory-inbox-style';
  const MAX_SOURCE_TEXT = 1200;

  const DEFAULTS = Object.freeze({
    enabled: true,
    captureFacts: true,
    captureEvents: true,
    suppressDirectExtraction: true,
    rememberRejected: true,
    minConfidence: 0.58,
    maxPending: 200,
    showSource: true,
    previousAutoExtract: null,
    debug: false
  });

  let settings = load(SETTINGS_KEY, DEFAULTS);
  let store = load(STORE_KEY, {
    schema: 1,
    candidates: [],
    rejectedFingerprints: [],
    updatedAt: 0
  });
  store.candidates = Array.isArray(store.candidates) ? store.candidates : [];
  store.rejectedFingerprints = Array.isArray(store.rejectedFingerprints) ? store.rejectedFingerprints : [];
  let initialized = false;
  const disposers = [];

  function clone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }
  function load(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      return parsed && typeof parsed === 'object' ? Object.assign({}, clone(fallback), parsed) : clone(fallback);
    } catch (_) { return clone(fallback); }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); return true; }
    catch (error) { console.warn('[EVEMemoryInbox] 保存设置失败', error); return false; }
  }
  function saveStore() {
    store.updatedAt = Date.now();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); return true; }
    catch (error) { console.warn('[EVEMemoryInbox] 保存待确认记忆失败', error); return false; }
  }
  function clean(value, max = 600) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  }
  function slug(value) {
    return clean(value, 120).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'memory';
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
  }
  function uid(prefix = 'candidate') { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
  function normalizeIds(values) {
    const list = Array.isArray(values) ? values : (values ? [values] : []);
    return Array.from(new Set(list.map(value => clean(value, 200)).filter(Boolean))).slice(0, 40);
  }
  function normalizeTags(values) {
    const list = Array.isArray(values) ? values : String(values || '').split(',');
    return Array.from(new Set(list.map(slug).filter(Boolean))).slice(0, 20);
  }
  function emit(name, detail = {}) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
  }
  function on(target, name, handler, options) {
    target.addEventListener(name, handler, options);
    disposers.push(() => target.removeEventListener(name, handler, options));
  }
  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    if (window.showToast) return window.showToast(message, type);
    console.log('[EVEMemoryInbox]', message);
  }
  function log(...args) { if (settings.debug) console.log('[EVEMemoryInbox]', ...args); }
  function memory() { return window.EVEMemory || null; }
  function currentScope() {
    return window.EVEAdapter?.getCurrentChat?.().scope || memory()?.getCurrentScope?.() || 'global';
  }
  function currentChat() {
    return window.EVEAdapter?.getCurrentChat?.() || { id:'', name:'当前角色', scope:currentScope(), open:false };
  }
  function fingerprint(input) {
    const item = input || {};
    return [
      clean(item.scope || currentScope(), 120).toLowerCase(),
      clean(item.kind || 'fact', 20).toLowerCase(),
      clean(item.type || item.category || item.key || '', 80).toLowerCase(),
      clean(item.value || item.title || item.description || '', 300).toLowerCase()
    ].join('|');
  }
  function rejectedSet() { return new Set(Array.isArray(store.rejectedFingerprints) ? store.rejectedFingerprints : []); }
  function pending() { return store.candidates.filter(item => item.status === 'pending'); }
  function findExistingMemory(candidate) {
    const all = memory()?.getAll?.();
    if (!all) return null;
    const target = clean(candidate.value || candidate.title, 300).toLowerCase();
    if (candidate.kind === 'fact') return (all.facts || []).find(item => clean(item.value, 300).toLowerCase() === target && item.scope === candidate.scope) || null;
    return (all.events || []).find(item => clean(item.title, 300).toLowerCase() === target && item.scope === candidate.scope) || null;
  }
  function trimStore() {
    store.candidates.sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const pendingItems = store.candidates.filter(item => item.status === 'pending').slice(0, Math.max(20, settings.maxPending));
    const history = store.candidates.filter(item => item.status !== 'pending').slice(0, 150);
    store.candidates = [...pendingItems, ...history];
    store.rejectedFingerprints = Array.from(new Set(store.rejectedFingerprints || [])).slice(-500);
  }

  function addCandidate(input) {
    if (!settings.enabled) return null;
    const item = Object.assign({}, input || {});
    item.kind = item.kind === 'event' ? 'event' : 'fact';
    item.scope = clean(item.scope || currentScope(), 120) || 'global';
    item.value = clean(item.value, 240);
    item.title = clean(item.title, 180);
    item.description = clean(item.description || item.sourceText, 600);
    item.sourceText = clean(item.sourceText, MAX_SOURCE_TEXT);
    item.sourceMessageIds = normalizeIds(item.sourceMessageIds);
    item.confidence = clamp(item.confidence == null ? 0.7 : item.confidence, 0, 1);
    item.importance = clamp(item.importance || 3, 1, 5);
    item.tags = normalizeTags(item.tags || ['pending-confirmation']);
    if (item.confidence < settings.minConfidence) return null;
    if (item.kind === 'fact' && !item.value) return null;
    if (item.kind === 'event' && !item.title) return null;

    item.fingerprint = fingerprint(item);
    if (settings.rememberRejected && rejectedSet().has(item.fingerprint)) return null;
    if (findExistingMemory(item)) return null;

    const existing = store.candidates.find(candidate => candidate.fingerprint === item.fingerprint && candidate.status === 'pending');
    if (existing) {
      existing.updatedAt = Date.now();
      existing.seenCount = (existing.seenCount || 1) + 1;
      existing.confidence = Math.max(existing.confidence || 0, item.confidence);
      existing.importance = Math.max(existing.importance || 1, item.importance);
      existing.sourceMessageIds = Array.from(new Set([...(existing.sourceMessageIds || []), ...item.sourceMessageIds]));
      if (item.sourceText) existing.sourceText = item.sourceText;
      saveStore();
      updateBadge();
      emit('eve:memory-inbox-updated', { action:'merged', candidate:clone(existing), stats:getStats() });
      return clone(existing);
    }

    const candidate = {
      id: uid(item.kind),
      fingerprint: item.fingerprint,
      status: 'pending',
      kind: item.kind,
      scope: item.scope,
      type: slug(item.type || (item.kind === 'event' ? 'event' : 'fact')),
      key: slug(item.key || item.type || item.kind),
      category: slug(item.category || (item.kind === 'event' ? 'mentioned-event' : 'fact')),
      value: item.value,
      title: item.title,
      description: item.description,
      sourceText: item.sourceText,
      source: clean(item.source || 'user-message', 80),
      sourceMessageIds: item.sourceMessageIds,
      confidence: item.confidence,
      importance: item.importance,
      tags: item.tags,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      seenCount: 1
    };
    store.candidates.unshift(candidate);
    trimStore();
    saveStore();
    updateBadge();
    emit('eve:memory-inbox-updated', { action:'added', candidate:clone(candidate), stats:getStats() });
    return clone(candidate);
  }

  function estimateImportance(text) {
    let score = 2;
    const value = String(text || '');
    if (/生日|纪念日|紀念日|结婚|結婚|生病|住院|考试|考試|毕业|畢業|搬家|旅行|工作|入学|入學|家人|宠物|寵物/.test(value)) score += 2;
    if (/很重要|不要忘|记住|記住|第一次|最后一次|最後一次|永远|永遠/.test(value)) score += 1;
    return clamp(score, 1, 5);
  }

  function suggestFromText(text, options = {}) {
    if (!settings.enabled) return [];
    const sourceText = clean(text, MAX_SOURCE_TEXT);
    if (!sourceText) return [];
    const scope = clean(options.scope || currentScope(), 120) || 'global';
    const sourceMessageIds = normalizeIds(options.sourceMessageIds || options.messageId);
    const created = [];

    const factPatterns = [
      { type:'identity', key:'name', confidence:.92, importance:5, re:/(?:我叫|我的名字是|叫我)([^，。！？,.!?\n]{1,24})/g, format:m => `使用者的名字是${m[1].trim()}` },
      { type:'birthday', key:'birthday', confidence:.95, importance:5, re:/(?:我的生日是|我生日(?:在|是)?)(\d{1,2}月\d{1,2}日|\d{1,2}[\/.\-]\d{1,2})/g, format:m => `使用者的生日是${m[1]}` },
      { type:'preference', key:'likes', confidence:.78, importance:3, re:/我(?:很|最|也)?喜(?:欢|歡)([^，。！？,.!?\n]{1,60})/g, format:m => `使用者喜欢${m[1].trim()}` },
      { type:'preference', key:'dislikes', confidence:.8, importance:3, re:/我(?:很|最)?(?:不喜欢|不喜歡|讨厌|討厭)([^，。！？,.!?\n]{1,60})/g, format:m => `使用者不喜欢${m[1].trim()}` },
      { type:'location', key:'lives-in', confidence:.86, importance:4, re:/我(?:住在|住)([^，。！？,.!?\n]{1,50})/g, format:m => `使用者住在${m[1].trim()}` },
      { type:'identity', key:'job-or-study', confidence:.78, importance:4, re:/我是(?:一名|一个|一個)?([^，。！？,.!?\n]{1,42}(?:学生|學生|老师|老師|设计师|設計師|画家|畫家|工程师|工程師|大学生|大學生))/g, format:m => `使用者是${m[1].trim()}` },
      { type:'goal', key:'wants', confidence:.62, importance:3, re:/我(?:想要|希望)([^，。！？,.!?\n]{2,70})/g, format:m => `使用者希望${m[1].trim()}` }
    ];

    if (settings.captureFacts) {
      for (const pattern of factPatterns) {
        pattern.re.lastIndex = 0;
        let match;
        while ((match = pattern.re.exec(sourceText)) && created.length < 10) {
          const value = clean(pattern.format(match), 200);
          if (value.length < 4) continue;
          const candidate = addCandidate({
            kind:'fact', scope, type:pattern.type, key:pattern.key, value,
            confidence:pattern.confidence, importance:pattern.importance,
            tags:['auto-suggested'], source:'memory-inbox', sourceText, sourceMessageIds
          });
          if (candidate) created.push(candidate);
        }
      }
    }

    if (settings.captureEvents) {
      const eventPatterns = [
        { confidence:.78, re:/(?:明天|后天|後天|下周|下週|今天|今晚|这周|這週).{0,16}(?:要|会|會|准备|準備|打算)([^。！？!?\n]{2,90})/g },
        { confidence:.74, re:/(?:刚刚|剛剛|今天|昨天|前天).{0,16}(?:去了|完成了|考完了|发生了|發生了|收到)([^。！？!?\n]{2,90})/g },
        { confidence:.66, re:/(?:下个月|下個月|今年|明年).{0,16}(?:要|会|會|准备|準備|打算)([^。！？!?\n]{2,90})/g }
      ];
      for (const pattern of eventPatterns) {
        pattern.re.lastIndex = 0;
        let match;
        while ((match = pattern.re.exec(sourceText)) && created.length < 12) {
          const title = clean(match[0], 180);
          const candidate = addCandidate({
            kind:'event', scope, title, description:sourceText,
            category:'mentioned-event', confidence:pattern.confidence,
            importance:estimateImportance(title), tags:['auto-suggested'],
            source:'memory-inbox', sourceText, sourceMessageIds
          });
          if (candidate) created.push(candidate);
        }
      }
    }

    if (created.length) render();
    return created;
  }

  function get(id) { return clone(store.candidates.find(item => item.id === id) || null); }
  function list(options = {}) {
    const status = options.status || 'pending';
    const scope = options.scope || null;
    return clone(store.candidates.filter(item => (!status || item.status === status) && (!scope || item.scope === scope)));
  }
  function approve(id) {
    const candidate = store.candidates.find(item => item.id === id);
    if (!candidate || candidate.status !== 'pending') return null;
    const api = memory();
    if (!api) throw new Error('扩展记忆模块未载入');
    let saved;
    if (candidate.kind === 'event') {
      saved = api.addEvent({
        scope:candidate.scope, title:candidate.title, description:candidate.description,
        category:candidate.category, source:'memory-inbox-approved',
        sourceMessageIds:candidate.sourceMessageIds, importance:candidate.importance,
        tags:[...(candidate.tags || []), 'confirmed']
      });
    } else {
      saved = api.addFact({
        scope:candidate.scope, type:candidate.type, key:candidate.key, value:candidate.value,
        source:'memory-inbox-approved', sourceMessageIds:candidate.sourceMessageIds,
        confidence:candidate.confidence, importance:candidate.importance,
        tags:[...(candidate.tags || []), 'confirmed']
      });
    }
    candidate.status = 'approved';
    candidate.reviewedAt = Date.now();
    candidate.memoryId = saved?.id || '';
    saveStore(); updateBadge(); render();
    emit('eve:memory-inbox-updated', { action:'approved', candidate:clone(candidate), memory:clone(saved), stats:getStats() });
    return clone(saved);
  }
  function reject(id) {
    const candidate = store.candidates.find(item => item.id === id);
    if (!candidate || candidate.status !== 'pending') return false;
    candidate.status = 'rejected';
    candidate.reviewedAt = Date.now();
    if (settings.rememberRejected && candidate.fingerprint) store.rejectedFingerprints.push(candidate.fingerprint);
    trimStore(); saveStore(); updateBadge(); render();
    emit('eve:memory-inbox-updated', { action:'rejected', candidate:clone(candidate), stats:getStats() });
    return true;
  }
  function approveAll(options = {}) {
    const targets = store.candidates.filter(item => item.status === 'pending' && (!options.scope || item.scope === options.scope));
    let count = 0;
    for (const item of targets) { try { if (approve(item.id)) count++; } catch (error) { console.warn(error); } }
    return count;
  }
  function rejectAll(options = {}) {
    const targets = store.candidates.filter(item => item.status === 'pending' && (!options.scope || item.scope === options.scope));
    let count = 0;
    for (const item of targets) if (reject(item.id)) count++;
    return count;
  }
  function edit(id, patch = {}) {
    const candidate = store.candidates.find(item => item.id === id);
    if (!candidate || candidate.status !== 'pending') return null;
    if ('value' in patch) candidate.value = clean(patch.value, 240);
    if ('title' in patch) candidate.title = clean(patch.title, 180);
    if ('description' in patch) candidate.description = clean(patch.description, 600);
    if ('importance' in patch) candidate.importance = clamp(patch.importance, 1, 5);
    if ('confidence' in patch) candidate.confidence = clamp(patch.confidence, 0, 1);
    if ('tags' in patch) candidate.tags = normalizeTags(patch.tags);
    candidate.fingerprint = fingerprint(candidate);
    candidate.updatedAt = Date.now();
    saveStore(); render();
    emit('eve:memory-inbox-updated', { action:'edited', candidate:clone(candidate), stats:getStats() });
    return clone(candidate);
  }
  function purgeByMessage(messageId) {
    const id = clean(messageId, 200);
    if (!id) return 0;
    const before = store.candidates.length;
    store.candidates = store.candidates.filter(item => !(item.status === 'pending' && (item.sourceMessageIds || []).includes(id)));
    const removed = before - store.candidates.length;
    if (removed) { saveStore(); updateBadge(); render(); emit('eve:memory-inbox-updated', { action:'purged', messageId:id, removed, stats:getStats() }); }
    return removed;
  }

  function applyExtractionMode() {
    const api = memory();
    if (!api?.getSettings || !api?.configure) return false;
    const current = api.getSettings();
    if (settings.enabled && settings.suppressDirectExtraction) {
      if (settings.previousAutoExtract === null || settings.previousAutoExtract === undefined) {
        settings.previousAutoExtract = current.autoExtract !== false;
        saveSettings();
      }
      if (current.autoExtract !== false) api.configure({ autoExtract:false });
    } else if (settings.previousAutoExtract !== null && settings.previousAutoExtract !== undefined) {
      const restore = Boolean(settings.previousAutoExtract);
      if (current.autoExtract !== restore) api.configure({ autoExtract:restore });
      settings.previousAutoExtract = null;
      saveSettings();
    }
    return true;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .home-section.top-right .eve-apps-grid-4{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:3px 9px;width:100%;height:100%;padding:1px;align-items:center}
      .home-section.top-right .eve-apps-grid-4 .mini-app{min-width:0;min-height:0;font-size:10px!important;line-height:1.1}
      .home-section.top-right .eve-apps-grid-4 .mini-app-icon{width:42px!important;height:42px!important;border-radius:13px!important;margin-bottom:2px}
      .home-section.top-right .eve-apps-grid-4 .mini-app-icon i{font-size:21px!important}
      #${ICON_ID} .mini-app-icon{position:relative;background:linear-gradient(135deg,#ff9f43,#ff6b6b)}
      #${ICON_ID} .mini-app-icon i{color:#fff}
      .eve-memory-inbox-badge{position:absolute;top:-4px;right:-6px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#ff3b30;color:#fff;font-size:10px;line-height:17px;text-align:center;font-weight:700;box-shadow:0 1px 4px #0005;display:none}
      #${SCREEN_ID}{background:var(--body-bg,#fff)}
      #${SCREEN_ID} .eve-memory-inbox-content{padding:0;overflow-y:auto;background:var(--color-gray-bg-light,#f7f7f8)}
      .eve-memory-inbox-toolbar{display:flex;gap:7px;align-items:center;padding:10px 12px;background:var(--secondary-bg,#fff);border-bottom:1px solid var(--color-border,#eee);position:sticky;top:0;z-index:3}
      .eve-memory-inbox-toolbar button{border:0;border-radius:9px;padding:7px 9px;font-size:12px;background:rgba(255,149,0,.12);color:#b66400}
      .eve-memory-inbox-toolbar [data-count]{margin-left:auto;font-size:12px;opacity:.65}
      .eve-memory-inbox-list{padding:12px 12px 90px}
      .eve-memory-card{background:var(--secondary-bg,#fff);border-radius:15px;padding:13px;margin-bottom:10px;border:1px solid rgba(0,0,0,.07);box-shadow:0 3px 11px rgba(0,0,0,.045)}
      .eve-memory-card-top{display:flex;gap:8px;align-items:center;margin-bottom:8px}
      .eve-memory-kind{font-size:10px;font-weight:700;padding:3px 7px;border-radius:8px;background:rgba(255,149,0,.12);color:#b66400}
      .eve-memory-confidence{margin-left:auto;font-size:11px;opacity:.55}
      .eve-memory-value{font-weight:700;line-height:1.5;word-break:break-word;margin-bottom:6px}
      .eve-memory-source{font-size:11px;line-height:1.45;opacity:.58;padding:8px;border-radius:10px;background:rgba(0,0,0,.035);word-break:break-word}
      .eve-memory-meta{font-size:10px;opacity:.5;margin-top:7px}
      .eve-memory-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:10px}
      .eve-memory-actions button{border:0;border-radius:10px;padding:8px 5px;font-size:12px;background:rgba(0,0,0,.055)}
      .eve-memory-actions [data-approve]{background:rgba(52,199,89,.13);color:#218d3d;font-weight:700}
      .eve-memory-actions [data-reject]{color:#c43b35}
      .eve-memory-empty{text-align:center;padding:78px 25px;color:#888}
      .eve-memory-empty i{display:block;font-size:42px;color:#ff9f43;margin-bottom:12px}
      .eve-memory-inbox-header-actions{position:absolute;right:19px;top:52px;transform:translateY(-50%);display:flex;gap:8px}
      .eve-memory-inbox-header-actions button{border:0;background:transparent;font-size:17px;color:#333;padding:5px}
      body[data-theme="dark"] #${SCREEN_ID} .eve-memory-inbox-content{background:#1a1a1a}
      body[data-theme="dark"] .eve-memory-card,body[data-theme="dark"] .eve-memory-inbox-toolbar{background:#292929;color:#eee;border-color:#444}
      body[data-theme="dark"] .eve-memory-inbox-header-actions button{color:#fff}
      body[data-theme="dark"] .eve-memory-source{background:#333}
    `;
    document.head.appendChild(style);
  }
  function ensureHomeIcon() {
    const existing = document.getElementById(ICON_ID);
    if (existing) {
      if (!existing.dataset.eveHomeBound) {
        existing.dataset.eveHomeBound = `memory-inbox-${VERSION}`;
        existing.addEventListener('click', event => { event.preventDefault(); open(); });
      }
      updateBadge();
      return true;
    }
    const grid = document.querySelector('#eve-home-feature-grid, .home-section.top-right .eve-home-feature-grid, .home-section.top-right .apps-grid-2, .home-section.top-right .apps-grid');
    if (!grid) return false;
    grid.id = 'eve-home-feature-grid';
    grid.classList.remove('apps-grid-2', 'apps-grid', 'eve-apps-grid-4', 'eve-apps-grid-6');
    grid.classList.add('eve-home-feature-grid');
    const link = document.createElement('a');
    link.href = '#'; link.className = 'mini-app'; link.id = ICON_ID;
    link.innerHTML = '<div class="mini-app-icon"><svg class="eve-home-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4z"></path><path d="M4 14h4l2 3h4l2-3h4"></path></svg><span class="eve-memory-inbox-badge" data-badge></span></div><span>待确认</span>';
    link.dataset.eveHomeBound = `memory-inbox-${VERSION}`;
    link.addEventListener('click', event => { event.preventDefault(); open(); });
    grid.appendChild(link); updateBadge();
    return true;
  }
  function statusBarMarkup() {
    return '<div class="app-status-bar"><div class="app-status-time"></div><div class="app-status-right"><div class="app-signal-icon signal-icon"><div class="signal-row"><div class="signal-bar"></div><div class="signal-bar"></div><div class="signal-bar"></div><div class="signal-bar"></div></div></div><div class="app-battery-container"><div class="app-battery-icon"><div class="app-battery-level"></div></div></div></div></div>';
  }
  function ensureScreen() {
    if (document.getElementById(SCREEN_ID)) return true;
    const wallpaper = document.querySelector('#phone-screen .wallpaper') || document.getElementById('phone-screen');
    if (!wallpaper) return false;
    const screen = document.createElement('div');
    screen.id = SCREEN_ID; screen.className = 'app-screen';
    screen.innerHTML = `<div class="app-top-container">${statusBarMarkup()}<div class="app-header"><button class="back-button" data-back>‹</button><div class="app-title">记忆待确认</div><div class="eve-memory-inbox-header-actions"><button data-settings title="设置"><i class="fas fa-cog"></i></button></div></div></div><div class="app-content eve-memory-inbox-content"><div class="eve-memory-inbox-toolbar"><button data-approve-all>全部保留</button><button data-reject-all>全部忽略</button><span data-count></span></div><div class="eve-memory-inbox-list" data-list></div></div>`;
    wallpaper.appendChild(screen);
    screen.querySelector('[data-back]').onclick = close;
    screen.querySelector('[data-settings]').onclick = openSettings;
    screen.querySelector('[data-approve-all]').onclick = () => {
      const count = approveAll({ scope:currentScope() });
      toast(`已保留 ${count} 条记忆`); render();
    };
    screen.querySelector('[data-reject-all]').onclick = () => {
      if (!confirm('忽略当前角色的全部待确认记忆？')) return;
      const count = rejectAll({ scope:currentScope() });
      toast(`已忽略 ${count} 条建议`); render();
    };
    return true;
  }
  function open() {
    ensureHomeIcon();
    if (!ensureScreen()) return toast('待确认记忆界面尚未准备好', 'error');
    try { if (typeof showApp === 'function') showApp(SCREEN_ID); else document.getElementById(SCREEN_ID).style.display = 'flex'; }
    catch (_) { document.getElementById(SCREEN_ID).style.display = 'flex'; }
    render(); emit('eve:memory-inbox-opened', { scope:currentScope(), chat:currentChat() });
  }
  function close() {
    try { if (typeof hideApp === 'function') return hideApp(SCREEN_ID); } catch (_) {}
    const screen = document.getElementById(SCREEN_ID); if (screen) screen.style.display = 'none';
  }
  function editCandidate(candidate) {
    const current = candidate.kind === 'event' ? candidate.title : candidate.value;
    const value = prompt(candidate.kind === 'event' ? '修改事件内容' : '修改记忆内容', current);
    if (value === null || !clean(value)) return;
    const importance = prompt('重要程度 1～5', String(candidate.importance || 3));
    const patch = { importance:clamp(importance || candidate.importance, 1, 5) };
    if (candidate.kind === 'event') patch.title = value; else patch.value = value;
    edit(candidate.id, patch); render();
  }
  function render() {
    ensureHomeIcon(); ensureScreen();
    const screen = document.getElementById(SCREEN_ID); if (!screen) return;
    const scope = currentScope();
    const items = store.candidates.filter(item => item.status === 'pending' && item.scope === scope);
    const listNode = screen.querySelector('[data-list]');
    const countNode = screen.querySelector('[data-count]');
    if (countNode) countNode.textContent = `${items.length} 条待确认`;
    listNode.innerHTML = '';
    if (!items.length) {
      listNode.innerHTML = '<div class="eve-memory-empty"><i class="fas fa-check-circle"></i>暂时没有待确认记忆<br><small>明确的喜好、身份与重要计划会先出现在这里</small></div>';
      updateBadge(); return;
    }
    for (const candidate of items) {
      const card = document.createElement('div'); card.className = 'eve-memory-card';
      const main = candidate.kind === 'event' ? candidate.title : candidate.value;
      card.innerHTML = `<div class="eve-memory-card-top"><span class="eve-memory-kind">${candidate.kind === 'event' ? '事件' : '长期资料'}</span><span class="eve-memory-confidence">置信度 ${Math.round((candidate.confidence || 0) * 100)}%</span></div><div class="eve-memory-value">${escapeHtml(main)}</div>${settings.showSource && candidate.sourceText ? `<div class="eve-memory-source">来源：${escapeHtml(candidate.sourceText)}</div>` : ''}<div class="eve-memory-meta">重要度 ${candidate.importance || 3} · ${escapeHtml(candidate.type || candidate.category || '')}</div><div class="eve-memory-actions"><button data-edit>修改</button><button data-reject>忽略</button><button data-approve>保留</button></div>`;
      card.querySelector('[data-edit]').onclick = () => editCandidate(candidate);
      card.querySelector('[data-reject]').onclick = () => reject(candidate.id);
      card.querySelector('[data-approve]').onclick = () => { try { approve(candidate.id); toast('已写入长期记忆'); } catch (error) { toast(error.message || String(error), 'error'); } };
      listNode.appendChild(card);
    }
    updateBadge();
  }
  function updateBadge() {
    const badge = document.querySelector(`#${ICON_ID} [data-badge]`); if (!badge) return;
    const count = pending().length;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.style.display = count ? 'block' : 'none';
  }
  function openSettings() {
    document.getElementById('eve-memory-inbox-settings-modal')?.remove();
    const overlay = document.createElement('div'); overlay.id = 'eve-memory-inbox-settings-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#0008;display:flex;align-items:center;justify-content:center;padding:15px';
    overlay.innerHTML = `<div style="width:min(480px,100%);max-height:88vh;overflow:auto;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;padding:18px"><div style="display:flex;align-items:center;margin-bottom:16px"><b style="flex:1;font-size:17px">记忆待确认设置</b><button data-close>✕</button></div><label style="display:flex;justify-content:space-between;margin:12px 0"><span>启用待确认记忆</span><input type="checkbox" data-enabled ${settings.enabled ? 'checked' : ''}></label><label style="display:flex;justify-content:space-between;margin:12px 0"><span>识别长期资料</span><input type="checkbox" data-facts ${settings.captureFacts ? 'checked' : ''}></label><label style="display:flex;justify-content:space-between;margin:12px 0"><span>识别重要事件与计划</span><input type="checkbox" data-events ${settings.captureEvents ? 'checked' : ''}></label><label style="display:flex;justify-content:space-between;margin:12px 0"><span>确认前不直接写入记忆</span><input type="checkbox" data-suppress ${settings.suppressDirectExtraction ? 'checked' : ''}></label><label style="display:flex;justify-content:space-between;margin:12px 0"><span>记住已忽略的建议</span><input type="checkbox" data-rejected ${settings.rememberRejected ? 'checked' : ''}></label><label style="display:block;margin:14px 0">最低识别置信度 <b data-confidence-value>${Math.round(settings.minConfidence * 100)}%</b><input type="range" min="40" max="95" value="${Math.round(settings.minConfidence * 100)}" data-confidence style="width:100%"></label><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px"><button data-cancel>取消</button><button data-save style="border:0;border-radius:9px;background:#4a84c1;color:white;padding:8px 18px">保存</button></div></div>`;
    document.body.appendChild(overlay);
    const closeModal = () => overlay.remove();
    overlay.querySelector('[data-close]').onclick = closeModal;
    overlay.querySelector('[data-cancel]').onclick = closeModal;
    overlay.onclick = event => { if (event.target === overlay) closeModal(); };
    const range = overlay.querySelector('[data-confidence]');
    range.oninput = () => overlay.querySelector('[data-confidence-value]').textContent = `${range.value}%`;
    overlay.querySelector('[data-save]').onclick = () => {
      configure({
        enabled:overlay.querySelector('[data-enabled]').checked,
        captureFacts:overlay.querySelector('[data-facts]').checked,
        captureEvents:overlay.querySelector('[data-events]').checked,
        suppressDirectExtraction:overlay.querySelector('[data-suppress]').checked,
        rememberRejected:overlay.querySelector('[data-rejected]').checked,
        minConfidence:Number(range.value) / 100
      });
      closeModal(); toast('设置已保存'); render();
    };
  }
  function configure(next = {}) {
    settings = Object.assign({}, DEFAULTS, settings, next || {});
    settings.enabled = Boolean(settings.enabled);
    settings.captureFacts = Boolean(settings.captureFacts);
    settings.captureEvents = Boolean(settings.captureEvents);
    settings.suppressDirectExtraction = Boolean(settings.suppressDirectExtraction);
    settings.rememberRejected = Boolean(settings.rememberRejected);
    settings.minConfidence = clamp(settings.minConfidence, .4, .95);
    settings.maxPending = clamp(settings.maxPending, 20, 1000);
    saveSettings(); applyExtractionMode(); updateBadge(); render();
    emit('eve:memory-inbox-settings-updated', { settings:getSettings(), stats:getStats() });
    return getSettings();
  }
  function getSettings() { return clone(settings); }
  function getStats() {
    return {
      version:VERSION, initialized, enabled:settings.enabled,
      pending:store.candidates.filter(item => item.status === 'pending').length,
      approved:store.candidates.filter(item => item.status === 'approved').length,
      rejected:store.candidates.filter(item => item.status === 'rejected').length,
      scope:currentScope(), directAutoExtract:memory()?.getSettings?.().autoExtract,
      icon:Boolean(document.getElementById(ICON_ID)), screen:Boolean(document.getElementById(SCREEN_ID))
    };
  }
  function init() {
    if (initialized) return Promise.resolve(getStats());
    initialized = true;
    ensureStyle(); ensureHomeIcon(); ensureScreen(); applyExtractionMode();
    on(window, 'eve:memory-ready', applyExtractionMode);
    on(window, 'eve:user-message-committed', event => {
      const text = clean(event.detail?.text, MAX_SOURCE_TEXT);
      if (!text || !settings.enabled) return;
      suggestFromText(text, {
        scope:event.detail?.scope || event.detail?.chat?.scope || currentScope(),
        sourceMessageIds:[event.detail?.messageId || event.detail?.id].filter(Boolean)
      });
    });
    on(window, 'eve:message-recalled', event => purgeByMessage(event.detail?.messageId));
    on(window, 'eve:adapter-ready', () => { ensureHomeIcon(); updateBadge(); });
    on(window, 'eve:chat-opened', render);
    const retry = setInterval(() => { const icon=ensureHomeIcon(), screen=ensureScreen(); if (icon && screen) clearInterval(retry); }, 500);
    setTimeout(() => clearInterval(retry), 30000);
    window.EVE ||= {}; window.EVE.memoryInbox = window.EVEMemoryInbox;
    emit('eve:memory-inbox-ready', getStats());
    log('Ready', getStats());
    return Promise.resolve(getStats());
  }
  function destroy() {
    disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} });
    document.getElementById(ICON_ID)?.remove();
    document.getElementById(SCREEN_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    initialized = false;
  }

  window.EVEMemoryInbox = Object.freeze({
    version:VERSION, init, destroy, configure, getSettings,
    suggestFromText, addCandidate, list, get, approve, reject, approveAll, rejectAll,
    edit, purgeByMessage, open, close, render, updateBadge, openSettings, getStats
  });

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init, { once:true })
    : init();
})(window, document);
