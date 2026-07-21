/**
 * EVE Chat Proactive Module v0.8.0
 * Fixed/random proactive-message scheduling with quiet hours, idle checks,
 * daily limits, local activity and catch-up after browser suspension.
 */
(function (window, document) {
  'use strict';
  if (window.EVEProactive?.version) return;

  const VERSION = '0.8.0';
  const SETTINGS_KEY = 'eve_proactive_settings_v2';
  const STATE_KEY = 'eve_proactive_state_v2';
  const LOG_KEY = 'eve_proactive_log_v2';
  const MINUTE = 60000;
  const DEFAULTS = Object.freeze({
    enabled: false,
    intervalMode: 'random',
    fixedIntervalMinutes: 180,
    randomMinMinutes: 90,
    randomMaxMinutes: 300,
    idleRequiredMinutes: 45,
    delayMinMinutes: 1,
    delayMaxMinutes: 8,
    quietHoursEnabled: true,
    quietStartHour: 0,
    quietEndHour: 8,
    dailyLimit: 4,
    onlyWhenChatOpen: false,
    catchUpAfterResume: true,
    includeEnvironment: true,
    debug: false
  });
  const ACTIVITIES = Object.freeze([
    { id:'sleeping', icon:'🌙', label:'睡觉中', start:0, end:7, allow:false, prompt:'角色目前正在睡觉。' },
    { id:'waking', icon:'☀️', label:'刚起床', start:7, end:9, allow:true, prompt:'角色刚起床，状态有些慵懒。' },
    { id:'morning', icon:'💼', label:'忙碌中', start:9, end:12, allow:true, prompt:'角色正在处理上午的工作或日常安排。' },
    { id:'lunch', icon:'🍜', label:'午餐时间', start:12, end:14, allow:true, prompt:'角色正在吃午餐或短暂休息。' },
    { id:'afternoon', icon:'☕', label:'正在活动', start:14, end:18, allow:true, prompt:'角色正在进行下午的工作、学习或外出活动。' },
    { id:'dinner', icon:'🍽️', label:'晚餐时间', start:18, end:20, allow:true, prompt:'角色正在吃晚餐，或刚结束晚餐。' },
    { id:'relaxing', icon:'🏠', label:'休息中', start:20, end:23, allow:true, prompt:'角色已经结束白天的事情，正在休息。' },
    { id:'late-night', icon:'🌃', label:'准备睡觉', start:23, end:24, allow:true, prompt:'时间已晚，角色正在放松并准备睡觉。' }
  ]);

  let settings = load(SETTINGS_KEY, DEFAULTS);
  let state = load(STATE_KEY, {
    nextDueAt: 0, pendingAt: 0, lastUserInteractionAt: Date.now(), lastSentAt: 0,
    dailyDate: '', dailyCount: 0, lastActivityId: ''
  });
  let timer = null;
  let delayTimer = null;
  let activityTimer = null;
  let currentActivity = null;
  let initialized = false;
  const disposers = [];

  function clone(value) { try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); } catch (_) { return value; } }
  function load(key, fallback) { try { const x = JSON.parse(localStorage.getItem(key) || 'null'); return x && typeof x === 'object' ? Object.assign(clone(fallback), x) : clone(fallback); } catch (_) { return clone(fallback); } }
  function persist() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (_) {} }
  function emit(name, detail = {}) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} }
  function on(target, name, handler, options) { target.addEventListener(name, handler, options); disposers.push(() => target.removeEventListener(name, handler, options)); }
  function log(...args) { if (settings.debug) console.log('[EVEProactive]', ...args); }
  function clean(value, max = 1000) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
  function clamp(value, min, max, fallback) { const n = Number(value); return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback)); }
  function randomInt(min, max) { const a = Math.ceil(Math.min(min, max)), b = Math.floor(Math.max(min, max)); return Math.floor(Math.random() * (b - a + 1)) + a; }

  function getEnvironment() { return window.EVEWeather?.getEnvironment?.() || window.EVE?.environment || null; }
  function localHour() {
    const time = getEnvironment()?.character?.localTime || getEnvironment()?.localTime;
    const match = String(time || '').match(/^(\d{1,2}):/);
    return match ? Math.max(0, Math.min(23, Number(match[1]))) : new Date().getHours();
  }
  function localDate() {
    const date = getEnvironment()?.character?.localDate || getEnvironment()?.localDate;
    return /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : new Date().toISOString().slice(0, 10);
  }
  function baseActivity() { const hour = localHour(); return ACTIVITIES.find(x => hour >= x.start && hour < x.end) || ACTIVITIES[0]; }
  function updateActivity(force = false) {
    const next = Object.assign({}, baseActivity());
    const weather = getEnvironment()?.character || getEnvironment();
    const label = String(weather?.weather || '');
    if (/雨|雷/.test(label) && ['afternoon','relaxing'].includes(next.id)) {
      next.icon = '🌧️'; next.label = '在室内躲雨'; next.prompt += ' 外面正在下雨，因此角色更可能待在室内。';
    }
    if (/雪/.test(label)) next.prompt += ' 外面正在下雪。';
    const changed = !currentActivity || currentActivity.id !== next.id || currentActivity.label !== next.label;
    currentActivity = next; state.lastActivityId = next.id; persist();
    window.EVE ||= {}; window.EVE.activity = clone(next);
    if (changed || force) emit('eve:activity-updated', { activity: clone(next) });
    return clone(next);
  }
  function getActivity() { return currentActivity ? clone(currentActivity) : updateActivity(); }
  function resetDaily() { if (state.dailyDate !== localDate()) { state.dailyDate = localDate(); state.dailyCount = 0; persist(); } }
  function quiet() {
    if (!settings.quietHoursEnabled) return false;
    const h = localHour(), start = settings.quietStartHour, end = settings.quietEndHour;
    if (start === end) return false;
    return start < end ? h >= start && h < end : h >= start || h < end;
  }
  function currentChatOpen() { return Boolean(window.EVEAdapter?.getCurrentChat?.().open || document.getElementById('api-chat-input')?.offsetParent); }
  function eligibility(options = {}) {
    resetDaily(); const activity = getActivity();
    if (!settings.enabled && !options.force) return { allowed:false, reason:'disabled', activity };
    if (state.dailyCount >= settings.dailyLimit && !options.force) return { allowed:false, reason:'daily-limit', activity };
    if (quiet() && !options.force) return { allowed:false, reason:'quiet-hours', activity };
    if (!activity.allow && !options.force) return { allowed:false, reason:'sleeping', activity };
    if (settings.onlyWhenChatOpen && !currentChatOpen() && !options.force) return { allowed:false, reason:'chat-closed', activity };
    const idle = Date.now() - Number(state.lastUserInteractionAt || 0);
    if (idle < settings.idleRequiredMinutes * MINUTE && !options.force) return { allowed:false, reason:'not-idle', activity, idleMinutes:Math.floor(idle / MINUTE) };
    return { allowed:true, reason:'eligible', activity, idleMinutes:Math.floor(idle / MINUTE) };
  }
  function intervalMinutes() { return settings.intervalMode === 'fixed' ? settings.fixedIntervalMinutes : randomInt(settings.randomMinMinutes, settings.randomMaxMinutes); }
  function schedule(minutes = intervalMinutes()) {
    clearTimeout(timer); timer = null;
    if (!settings.enabled) { state.nextDueAt = 0; persist(); return 0; }
    state.nextDueAt = Date.now() + Math.max(1, minutes) * MINUTE; persist();
    timer = setTimeout(checkDue, Math.min(2147483647, Math.max(1000, state.nextDueAt - Date.now())));
    emit('eve:proactive-scheduled', { nextDueAt: state.nextDueAt, minutes });
    return state.nextDueAt;
  }
  async function dispatch(payload) {
    const adapter = window.EVEProactiveAdapter;
    // Use one dispatch path only.  Earlier builds emitted the request event and
    // called the adapter directly, which could create two proactive replies.
    if (!adapter?.sendMessage) {
      emit('eve:proactive-message-request', payload);
      return { sent:false, reason:'adapter-not-ready' };
    }
    emit('eve:proactive-dispatch-start', { payload:clone(payload) });
    try {
      const result = await adapter.sendMessage(payload);
      if (result?.sent !== false) {
        resetDaily(); state.lastSentAt = Date.now(); state.dailyCount += 1; persist();
        appendLog({ at:Date.now(), success:true, payload:{ reason:payload.reason, activity:payload.activity?.id } });
      }
      emit('eve:proactive-dispatch-complete', { payload:clone(payload), result:clone(result) });
      return result;
    } catch (error) {
      appendLog({ at:Date.now(), success:false, error:String(error.message || error) });
      emit('eve:proactive-dispatch-error', { payload:clone(payload), error });
      return { sent:false, reason:'dispatch-error', error };
    }
  }
  function appendLog(entry) {
    const logData = load(LOG_KEY, { entries:[] }); logData.entries ||= []; logData.entries.unshift(entry); logData.entries = logData.entries.slice(0, 100);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(logData)); } catch (_) {}
  }
  function payload(reason, check) {
    return {
      id:`proactive_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
      reason, createdAt:new Date().toISOString(), activity:check.activity,
      environment:settings.includeEnvironment ? getEnvironment() : null,
      idleMinutes:check.idleMinutes,
      promptContext:[
        '【主动聊天情境】', `角色当前状态：${check.activity.icon} ${check.activity.label}`, check.activity.prompt,
        '请根据角色人设与最近聊天内容，自然地主动发送一则简短消息。',
        '不要提到系统、排程、触发器或“主动聊天功能”；不要每次都用问句。'
      ].join('\n')
    };
  }
  async function queue(reason, options = {}) {
    const check = eligibility(options);
    if (!check.allowed) { log('跳过', check.reason); schedule(check.reason === 'not-idle' ? 15 : 30); return { sent:false, reason:check.reason }; }
    clearTimeout(delayTimer); delayTimer = null;
    const delay = options.immediate ? 0 : randomInt(settings.delayMinMinutes, settings.delayMaxMinutes);
    state.pendingAt = Date.now() + delay * MINUTE; persist();
    return new Promise(resolve => {
      const run = async () => { state.pendingAt = 0; persist(); const result = await dispatch(payload(reason, check)); schedule(); resolve(result); };
      if (!delay) run(); else delayTimer = setTimeout(run, delay * MINUTE);
    });
  }
  function checkDue() {
    if (!settings.enabled) return;
    if (state.nextDueAt && Date.now() + 1000 < state.nextDueAt) { schedule(Math.max(1, (state.nextDueAt - Date.now()) / MINUTE)); return; }
    queue('scheduled');
  }
  function catchUp() {
    if (!settings.enabled || !settings.catchUpAfterResume || !state.nextDueAt) return;
    if (Date.now() >= state.nextDueAt) queue('resume-catch-up');
    else { clearTimeout(timer); timer = setTimeout(checkDue, Math.max(1000, state.nextDueAt - Date.now())); }
  }
  function markUserInteraction() {
    state.lastUserInteractionAt = Date.now();
    if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; state.pendingAt = 0; emit('eve:proactive-cancelled', { reason:'user-interaction' }); }
    persist();
  }
  function getPromptContext() {
    if (!settings.enabled) return '';
    const a = getActivity();
    return ['【角色当前生活状态】', `${a.icon} ${a.label}`, a.prompt, '这只是背景状态，请自然参考，不要机械汇报。'].join('\n');
  }
  function configure(next = {}) {
    settings = Object.assign({}, DEFAULTS, settings, next || {});
    settings.enabled = Boolean(settings.enabled); settings.quietHoursEnabled = Boolean(settings.quietHoursEnabled);
    settings.onlyWhenChatOpen = Boolean(settings.onlyWhenChatOpen); settings.catchUpAfterResume = Boolean(settings.catchUpAfterResume);
    settings.intervalMode = settings.intervalMode === 'fixed' ? 'fixed' : 'random';
    settings.fixedIntervalMinutes = clamp(settings.fixedIntervalMinutes, 5, 10080, 180);
    settings.randomMinMinutes = clamp(settings.randomMinMinutes, 5, 10080, 90);
    settings.randomMaxMinutes = clamp(settings.randomMaxMinutes, settings.randomMinMinutes, 10080, 300);
    settings.idleRequiredMinutes = clamp(settings.idleRequiredMinutes, 0, 10080, 45);
    settings.delayMinMinutes = clamp(settings.delayMinMinutes, 0, 1440, 1);
    settings.delayMaxMinutes = clamp(settings.delayMaxMinutes, settings.delayMinMinutes, 1440, 8);
    settings.quietStartHour = clamp(settings.quietStartHour, 0, 23, 0);
    settings.quietEndHour = clamp(settings.quietEndHour, 0, 23, 8);
    settings.dailyLimit = Math.floor(clamp(settings.dailyLimit, 0, 100, 4));
    persist(); if (settings.enabled) schedule(); else { clearTimeout(timer); state.nextDueAt = 0; persist(); }
    emit('eve:proactive-settings-updated', { settings:getSettings() });
    return getSettings();
  }
  function getSettings() { return clone(settings); }
  function getState() { resetDaily(); return clone(Object.assign({}, state, { initialized, activity:getActivity(), eligibility:eligibility() })); }
  function triggerNow(options = {}) { return queue(options.reason || 'manual', { force:options.force !== false, immediate:options.immediate !== false }); }
  function init() {
    if (initialized) return Promise.resolve(getState());
    initialized = true; updateActivity(true);
    activityTimer = setInterval(updateActivity, 5 * MINUTE);
    on(window, 'eve:environment-updated', updateActivity);
    on(window, 'eve:user-message-sent', markUserInteraction);
    on(window, 'eve:user-message-committed', markUserInteraction);
    on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') catchUp(); });
    on(window, 'focus', catchUp);
    window.EVE ||= {}; window.EVE.proactive = window.EVEProactive;
    emit('eve:proactive-ready', { version:VERSION, settings:getSettings(), state:getState() });
    if (settings.enabled) state.nextDueAt ? catchUp() : schedule();
    return Promise.resolve(getState());
  }
  function destroy() { clearTimeout(timer); clearTimeout(delayTimer); clearInterval(activityTimer); disposers.splice(0).forEach(fn => { try { fn(); } catch (_) {} }); initialized = false; }

  window.EVEProactive = Object.freeze({ version:VERSION, init, destroy, configure, getSettings, getState, getActivity, getPromptContext, markUserInteraction, triggerNow, scheduleNext:schedule, checkEligibility:eligibility, getLog:() => clone(load(LOG_KEY,{entries:[]}).entries || []) });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
