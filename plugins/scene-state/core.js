/**
 * EVE Scene State v1.2.0
 * 管理短期场景锚点，避免角色在同一段对话中突然换地点、重复动作或忘记在场人物。
 */
(function (window, document) {
  'use strict';
  if (window.EVESceneState?.version) return;

  const VERSION = '1.2.0';
  const SETTINGS_KEY = 'eve_scene_state_settings_v1';
  const STORE_KEY = 'eve_scene_state_store_v1';
  const DEFAULTS = Object.freeze({
    enabled: true,
    promptEnabled: true,
    autoDetect: true,
    expireHours: 12,
    maxPendingActions: 6,
    maxTemporaryFacts: 8,
    recordMajorChangesToTimeline: true,
    debug: false
  });

  let settings = readJson(SETTINGS_KEY, DEFAULTS);
  let store = readJson(STORE_KEY, {});
  let initialized = false;
  let adapterBound = false;
  let manager = null;
  const disposers = [];

  function readJson(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value && typeof value === 'object' ? Object.assign(Array.isArray(fallback) ? [] : {}, fallback, value) : (Array.isArray(fallback) ? fallback.slice() : Object.assign({}, fallback)); }
    catch (_) { return Array.isArray(fallback) ? fallback.slice() : Object.assign({}, fallback); }
  }
  function writeJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; } }
  function clean(value, max = 500) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
  function unique(values, max = 20) { return Array.from(new Set((values || []).map(value => clean(value, 160)).filter(Boolean))).slice(0, max); }
  function clone(value) { try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); } catch (_) { return value; } }
  function emit(name, detail = {}) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} }
  function log(...args) { if (settings.debug) console.log('[EVESceneState]', ...args); }
  function on(target, name, handler, options) { target.addEventListener(name, handler, options); disposers.push(() => target.removeEventListener(name, handler, options)); }
  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    if (window.showToast) return window.showToast(message, type);
    console.log('[EVESceneState]', message);
  }
  function currentChat() { return window.EVEAdapter?.getCurrentChat?.() || { scope:'global', id:'', name:'', open:false }; }
  function scopeKey(scope) { return clean(scope || currentChat().scope || 'global', 200) || 'global'; }
  function normalizeMode(value) { return ['unknown','text-chat','face-to-face','voice-call','video-call'].includes(value) ? value : 'unknown'; }
  function defaultState(scope = scopeKey()) {
    const chat = currentChat();
    return {
      version:1,
      scope,
      mode:'text-chat',
      location:'',
      participants:unique([chat.name], 10),
      currentActivity:'',
      currentEvent:'',
      pendingActions:[],
      temporaryFacts:[],
      lockedFields:[],
      createdAt:Date.now(),
      updatedAt:Date.now(),
      lastSourceMessageId:''
    };
  }
  function normalizeAction(item) {
    if (typeof item === 'string') return { text:clean(item, 220), sourceMessageId:'', createdAt:Date.now(), status:'pending' };
    return { text:clean(item?.text, 220), sourceMessageId:clean(item?.sourceMessageId, 160), createdAt:Number(item?.createdAt) || Date.now(), status:['pending','completed','cancelled'].includes(item?.status) ? item.status : 'pending' };
  }
  function normalizeFact(item) {
    if (typeof item === 'string') return { text:clean(item, 220), sourceMessageId:'', createdAt:Date.now() };
    return { text:clean(item?.text, 220), sourceMessageId:clean(item?.sourceMessageId, 160), createdAt:Number(item?.createdAt) || Date.now() };
  }
  function normalizeState(raw, scope = scopeKey()) {
    const base = Object.assign(defaultState(scope), raw || {});
    base.scope = scope;
    base.mode = normalizeMode(base.mode);
    base.location = clean(base.location, 120);
    base.participants = unique(base.participants, 12);
    base.currentActivity = clean(base.currentActivity, 220);
    base.currentEvent = clean(base.currentEvent, 300);
    base.pendingActions = (base.pendingActions || []).map(normalizeAction).filter(item => item.text).slice(-settings.maxPendingActions);
    base.temporaryFacts = (base.temporaryFacts || []).map(normalizeFact).filter(item => item.text).slice(-settings.maxTemporaryFacts);
    base.lockedFields = unique(base.lockedFields, 20);
    base.createdAt = Number(base.createdAt) || Date.now();
    base.updatedAt = Number(base.updatedAt) || Date.now();
    return base;
  }
  function expired(state) { return Date.now() - Number(state?.updatedAt || 0) > settings.expireHours * 60 * 60 * 1000; }
  function getState(scope = scopeKey(), options = {}) {
    const key = scopeKey(scope);
    let state = normalizeState(store[key], key);
    if (expired(state) && !options.keepExpired) {
      const participants = state.participants;
      state = defaultState(key);
      state.participants = participants.length ? participants : state.participants;
      store[key] = state; persist();
    }
    return clone(state);
  }
  function persist() { writeJson(STORE_KEY, store); }
  function configure(next = {}) {
    settings = Object.assign({}, DEFAULTS, settings, next || {});
    ['enabled','promptEnabled','autoDetect','recordMajorChangesToTimeline','debug'].forEach(key => settings[key] = Boolean(settings[key]));
    settings.expireHours = Math.max(1, Math.min(168, Number(settings.expireHours) || 12));
    settings.maxPendingActions = Math.max(1, Math.min(20, Number(settings.maxPendingActions) || 6));
    settings.maxTemporaryFacts = Math.max(1, Math.min(30, Number(settings.maxTemporaryFacts) || 8));
    writeJson(SETTINGS_KEY, settings);
    emit('eve:scene-state-settings-updated', { settings:getSettings() });
    return getSettings();
  }
  function getSettings() { return Object.assign({}, settings); }

  function recordMajorChange(previous, next, changes, options = {}) {
    if (!settings.recordMajorChangesToTimeline || options.silentTimeline || !window.EVETimeline?.addEvent) return;
    const major = [];
    if (changes.location && next.location) major.push(`地点变为${next.location}`);
    if (changes.mode) major.push(`互动形式变为${modeLabel(next.mode)}`);
    if (!major.length) return;
    try {
      window.EVETimeline.addEvent({
        scope:next.scope,
        type:'scene-change',
        title:'场景状态变化',
        description:major.join('，'),
        importance:2,
        tags:['scene'],
        sourceMessageIds:[options.sourceMessageId].filter(Boolean)
      });
    } catch (_) {}
  }
  function update(patch = {}, options = {}) {
    const scope = scopeKey(options.scope || patch.scope);
    const previous = getState(scope, { keepExpired:true });
    const next = normalizeState(Object.assign({}, previous), scope);
    const changes = {};
    const locked = new Set(next.lockedFields || []);
    for (const key of ['mode','location','participants','currentActivity','currentEvent']) {
      if (!(key in patch) || (!options.force && locked.has(key))) continue;
      let value = patch[key];
      if (key === 'mode') value = normalizeMode(value);
      else if (key === 'participants') value = unique(value, 12);
      else value = clean(value, key === 'currentEvent' ? 300 : 220);
      if (JSON.stringify(next[key]) !== JSON.stringify(value)) { next[key] = value; changes[key] = true; }
    }
    if (Array.isArray(patch.pendingActions)) next.pendingActions = patch.pendingActions.map(normalizeAction).filter(item => item.text).slice(-settings.maxPendingActions);
    if (Array.isArray(patch.temporaryFacts)) next.temporaryFacts = patch.temporaryFacts.map(normalizeFact).filter(item => item.text).slice(-settings.maxTemporaryFacts);
    if (Array.isArray(patch.lockedFields)) next.lockedFields = unique(patch.lockedFields, 20);
    if (patch.addPendingAction) {
      const action = normalizeAction({ text:patch.addPendingAction, sourceMessageId:options.sourceMessageId });
      if (action.text && !next.pendingActions.some(item => item.text === action.text && item.status === 'pending')) next.pendingActions.push(action);
      next.pendingActions = next.pendingActions.slice(-settings.maxPendingActions);
    }
    if (patch.addTemporaryFact) {
      const fact = normalizeFact({ text:patch.addTemporaryFact, sourceMessageId:options.sourceMessageId });
      if (fact.text && !next.temporaryFacts.some(item => item.text === fact.text)) next.temporaryFacts.push(fact);
      next.temporaryFacts = next.temporaryFacts.slice(-settings.maxTemporaryFacts);
    }
    if (patch.completeAction) {
      const term = clean(patch.completeAction, 120);
      next.pendingActions = next.pendingActions.map(item => item.text.includes(term) ? Object.assign({}, item, { status:'completed' }) : item).filter(item => item.status === 'pending');
    }
    next.updatedAt = Date.now();
    next.lastSourceMessageId = clean(options.sourceMessageId || patch.lastSourceMessageId || next.lastSourceMessageId, 160);
    store[scope] = next; persist();
    recordMajorChange(previous, next, changes, options);
    emit('eve:scene-state-updated', { previous:clone(previous), state:clone(next), changes, source:options.source || 'manual' });
    return clone(next);
  }
  function clear(scope = scopeKey()) {
    const key = scopeKey(scope); store[key] = defaultState(key); persist();
    emit('eve:scene-state-cleared', { scope:key, state:clone(store[key]) });
    return clone(store[key]);
  }
  function modeLabel(mode) { return ({ 'unknown':'未确定','text-chat':'文字聊天','face-to-face':'面对面','voice-call':'语音通话','video-call':'视频通话' })[mode] || '未确定'; }

  const LOCATION_STOP = /^(想|做|说|看|等|忙|睡|吃|问|考虑|担心|找|聊|开会|比赛|训练|任务|路上)$/;
  function inferMode(text, state) {
    const source = clean(text, 2000);
    if (/视频(?:通话|电话)|视讯|开视频|镜头/.test(source)) return 'video-call';
    if (/语音通话|打电话|电话里|接通电话|通话中/.test(source)) return 'voice-call';
    if (/当面|见到你|见面|抱住|牵住|牵手|坐到你|靠在你|在你身边|一起回家|同一张床|餐桌对面/.test(source)) return 'face-to-face';
    if (/挂断|结束通话|视频结束/.test(source)) return 'text-chat';
    return state.mode;
  }
  function inferLocation(text) {
    const source = clean(text, 2000);
    const patterns = [
      /(?:我们|我|你|他|她)?(?:现在|刚刚|已经)?(?:在|到了|到达|回到|来到)\s*([^，。！？!?\n]{2,24})/,
      /(?:从|离开)\s*([^，。！？!?\n]{2,20})(?:回到|来到|去)\s*([^，。！？!?\n]{2,20})/
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      const candidate = clean(match?.[2] || match?.[1], 60).replace(/(?:这里|那边|这边|那儿|那裡)$/,'');
      if (candidate && !LOCATION_STOP.test(candidate) && !/^(一起|什么|哪里|哪儿)/.test(candidate)) return candidate;
    }
    if (/到家|回家了|刚回家/.test(source)) return '家';
    if (/赛道|围场|维修区|车队基地/.test(source)) return source.match(/赛道|围场|维修区|车队基地/)?.[0] || '';
    return '';
  }
  function inferActivity(text) {
    const source = clean(text, 2000);
    const match = source.match(/(?:正在|还在|刚开始|准备开始)\s*([^，。！？!?\n]{2,30})/);
    if (match?.[1] && !/想|说|问/.test(match[1])) return clean(match[1], 80);
    const map = [
      [/开会|会议/, '开会'], [/训练|模拟器/, '训练'], [/比赛|排位|正赛/, '比赛'], [/吃饭|午饭|晚饭|早餐/, '吃饭'],
      [/开车|骑车|路上/, '在路上'], [/做饭|厨房/, '做饭'], [/洗澡/, '洗澡'], [/睡觉|准备睡/, '休息'], [/任务/, '执行任务']
    ];
    for (const [pattern, label] of map) if (pattern.test(source)) return label;
    return '';
  }
  function inferPending(text) {
    const source = clean(text, 2000);
    const results = [];
    const patterns = [
      /(?:等我|等会儿?|待会儿?|一会儿?|之后|晚点|明天|下次|比赛后|结束以后|回去以后)[^，。！？!?\n]{0,50}/g,
      /(?:答应你|约好了?|说好了?)[^，。！？!?\n]{0,45}/g,
      /(?:我会|我要|准备|打算)[^，。！？!?\n]{2,45}/g
    ];
    for (const pattern of patterns) for (const match of source.matchAll(pattern)) results.push(clean(match[0], 100));
    return unique(results, 4);
  }
  function inferTemporaryFact(text) {
    const source = clean(text, 2000);
    const results = [];
    for (const pattern of [/(?:今天|今晚|明天|后天|这周|周末)[^，。！？!?\n]{2,55}/g, /(?:刚刚|刚才|现在)[^，。！？!?\n]{2,45}/g]) {
      for (const match of source.matchAll(pattern)) results.push(clean(match[0], 100));
    }
    return unique(results, 3);
  }
  function inferFromText(text, options = {}) {
    if (!settings.enabled || !settings.autoDetect || !clean(text)) return getState(options.scope);
    const scope = scopeKey(options.scope);
    const state = getState(scope);
    const patch = {};
    const mode = inferMode(text, state); if (mode !== state.mode) patch.mode = mode;
    const location = inferLocation(text); if (location) patch.location = location;
    const activity = inferActivity(text); if (activity) patch.currentActivity = activity;
    const pending = inferPending(text); if (pending.length) patch.pendingActions = [...state.pendingActions, ...pending.map(value => ({ text:value, sourceMessageId:options.sourceMessageId, createdAt:Date.now(), status:'pending' }))];
    const facts = inferTemporaryFact(text); if (facts.length) patch.temporaryFacts = [...state.temporaryFacts, ...facts.map(value => ({ text:value, sourceMessageId:options.sourceMessageId, createdAt:Date.now() }))];
    if (options.sender === 'assistant' && clean(text).length <= 160) patch.currentEvent = clean(text, 160);
    return Object.keys(patch).length ? update(patch, Object.assign({}, options, { source:'auto-detect' })) : state;
  }

  function getPromptContext(meta = {}) {
    if (!settings.enabled || !settings.promptEnabled) return '';
    const state = getState(meta.chat?.scope);
    const lines = [
      '【当前场景状态｜短期一致性约束】',
      `互动形式：${modeLabel(state.mode)}`,
      state.location ? `当前地点：${state.location}` : '',
      state.participants.length ? `当前在场人物：${state.participants.join('、')}` : '',
      state.currentActivity ? `当前正在进行：${state.currentActivity}` : '',
      state.currentEvent ? `当前事件：${state.currentEvent}` : '',
      state.pendingActions.length ? `尚未完成的动作或约定：${state.pendingActions.filter(item => item.status === 'pending').map(item => item.text).join('；')}` : '',
      state.temporaryFacts.length ? `本场景临时事实：${state.temporaryFacts.map(item => item.text).join('；')}` : '',
      '当前场景优先于日常行程和泛用背景。除非最新消息明确改变地点、互动形式或事件，否则不要让角色突然出现在另一个地点、重复已完成动作或把面对面互动误写成远程聊天',
      '不要逐条朗读场景状态；只需让回复与它保持一致'
    ].filter(Boolean);
    return lines.join('\n');
  }
  function bindAdapter() {
    if (adapterBound || !window.EVEAdapter?.registerContextProvider) return false;
    window.EVEAdapter.registerContextProvider('scene-state', getPromptContext, { priority:6 });
    adapterBound = true; return true;
  }
  function bindEvents() {
    on(window, 'eve:user-message-committed', event => inferFromText(event.detail?.text, { scope:event.detail?.scope, sourceMessageId:event.detail?.messageId, sender:'user' }));
    on(window, 'eve:ai-message-committed', event => inferFromText(event.detail?.text, { scope:event.detail?.scope, sourceMessageId:event.detail?.messageId, sender:'assistant' }));
    on(window, 'eve:message-recalled', event => {
      const ids = new Set([event.detail?.messageId].filter(Boolean));
      if (!ids.size) return;
      for (const [scope, raw] of Object.entries(store)) {
        const state = normalizeState(raw, scope);
        state.pendingActions = state.pendingActions.filter(item => !ids.has(item.sourceMessageId));
        state.temporaryFacts = state.temporaryFacts.filter(item => !ids.has(item.sourceMessageId));
        if (ids.has(state.lastSourceMessageId)) state.currentEvent = '';
        store[scope] = state;
      }
      persist();
    });
  }

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[char]); }
  function openManager() {
    manager?.remove();
    const state = getState();
    const overlay = document.createElement('div'); manager = overlay; overlay.id = 'eve-scene-state-manager';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:12px';
    const panel = document.createElement('div'); panel.style.cssText = 'width:min(620px,100%);max-height:94vh;overflow:auto;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;box-shadow:0 18px 60px #0006';
    panel.innerHTML = `
      <div style="display:flex;align-items:center;padding:14px 16px;border-bottom:1px solid #ddd"><b style="flex:1">当前场景状态</b><button data-close>✕</button></div>
      <div style="padding:14px 16px;display:grid;gap:12px">
        <label>互动形式<select data-mode style="width:100%;padding:9px;margin-top:5px"><option value="unknown">未确定</option><option value="text-chat">文字聊天</option><option value="face-to-face">面对面</option><option value="voice-call">语音通话</option><option value="video-call">视频通话</option></select></label>
        <label>当前地点<input data-location value="${escapeHtml(state.location)}" style="width:100%;box-sizing:border-box;padding:9px;margin-top:5px"></label>
        <label>在场人物（逗号分隔）<input data-participants value="${escapeHtml(state.participants.join('，'))}" style="width:100%;box-sizing:border-box;padding:9px;margin-top:5px"></label>
        <label>当前活动<input data-activity value="${escapeHtml(state.currentActivity)}" style="width:100%;box-sizing:border-box;padding:9px;margin-top:5px"></label>
        <label>当前事件<textarea data-event rows="3" style="width:100%;box-sizing:border-box;padding:9px;margin-top:5px">${escapeHtml(state.currentEvent)}</textarea></label>
        <label>尚未完成的动作或约定（每行一项）<textarea data-pending rows="5" style="width:100%;box-sizing:border-box;padding:9px;margin-top:5px">${escapeHtml(state.pendingActions.filter(item => item.status === 'pending').map(item => item.text).join('\n'))}</textarea></label>
        <label>临时事实（每行一项）<textarea data-facts rows="5" style="width:100%;box-sizing:border-box;padding:9px;margin-top:5px">${escapeHtml(state.temporaryFacts.map(item => item.text).join('\n'))}</textarea></label>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button data-clear type="button">清空场景</button><button data-save type="button" style="background:#4a84c1;color:#fff;border:0;border-radius:8px;padding:8px 18px">保存</button></div>
      </div>`;
    panel.querySelector('[data-mode]').value = state.mode;
    overlay.append(panel); document.body.append(overlay);
    const close = () => overlay.remove();
    panel.querySelector('[data-close]').onclick = close; overlay.onclick = event => { if (event.target === overlay) close(); };
    panel.querySelector('[data-clear]').onclick = () => { if (confirm('清空当前角色的场景状态？')) { clear(); close(); toast('场景状态已清空'); } };
    panel.querySelector('[data-save]').onclick = () => {
      update({
        mode:panel.querySelector('[data-mode]').value,
        location:panel.querySelector('[data-location]').value,
        participants:panel.querySelector('[data-participants]').value.split(/[,，\n]/),
        currentActivity:panel.querySelector('[data-activity]').value,
        currentEvent:panel.querySelector('[data-event]').value,
        pendingActions:panel.querySelector('[data-pending]').value.split('\n').filter(Boolean),
        temporaryFacts:panel.querySelector('[data-facts]').value.split('\n').filter(Boolean)
      }, { force:true, source:'manager' });
      close(); toast('场景状态已保存');
    };
  }

  function getDiagnostics() { return { version:VERSION, initialized, adapterBound, settings:getSettings(), state:getState() }; }
  function init() {
    if (initialized) return Promise.resolve(getDiagnostics());
    initialized = true; bindEvents();
    if (!bindAdapter()) {
      const timer = setInterval(() => { if (bindAdapter()) clearInterval(timer); }, 500);
      setTimeout(() => clearInterval(timer), 30000);
    }
    window.EVE ||= {}; window.EVE.sceneState = window.EVESceneState;
    emit('eve:scene-state-ready', getDiagnostics());
    return Promise.resolve(getDiagnostics());
  }
  function destroy() { disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} }); manager?.remove(); manager = null; initialized = false; }

  window.EVESceneState = Object.freeze({
    version:VERSION, init, destroy, configure, getSettings, getState, update, clear, inferFromText, getPromptContext, openManager, getDiagnostics
  });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
