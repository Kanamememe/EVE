/** EVE Chat Browser Notifications v0.9.0 */
(function (window, document) {
  'use strict';
  if (window.EVENotifications?.version) return;
  const VERSION = '0.9.0';
  const STORAGE_KEY = 'eve_notification_settings_v09';
  const DEFAULTS = Object.freeze({
    enabled:false,
    chatEnabled:true,
    momentEnabled:true,
    proactiveEnabled:true,
    bridgeOriginal:true,
    previewEnabled:true,
    onlyWhenHidden:true,
    vibrate:true
  });
  let settings = load();
  let initialized = false;
  let registration = null;
  let nativePush = null;
  const fingerprints = new Map();
  const listeners = [];

  function load() { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); } catch (_) { return Object.assign({}, DEFAULTS); } }
  function save(next = {}) {
    settings = Object.assign({}, settings, next || {});
    for (const key of ['enabled','chatEnabled','momentEnabled','proactiveEnabled','bridgeOriginal','previewEnabled','onlyWhenHidden','vibrate']) settings[key] = Boolean(settings[key]);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
    window.dispatchEvent(new CustomEvent('eve:notification-settings-updated', { detail:{ settings:getSettings() } }));
    return getSettings();
  }
  function getSettings() { return Object.assign({}, settings); }
  function permission() { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; }
  function clean(value, max = 300) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
  function visible() { return document.visibilityState === 'visible' && (typeof document.hasFocus !== 'function' || document.hasFocus()); }
  function shouldShow() { return settings.enabled && permission() === 'granted' && (!settings.onlyWhenHidden || !visible()); }
  function dedupe(title, body, tag) {
    const key = `${tag}|${title}|${body}`; const old = fingerprints.get(key) || 0;
    if (Date.now() - old < 3000) return false;
    fingerprints.set(key, Date.now());
    for (const [item, time] of fingerprints) if (Date.now() - time > 30000) fingerprints.delete(item);
    return true;
  }
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return null;
    try {
      registration = await navigator.serviceWorker.register('./eve-sw.js', { scope:'./' });
      return registration;
    } catch (error) { console.warn('[EVENotifications] Service Worker 注册失败：', error); return null; }
  }
  async function requestPermission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    const result = await Notification.requestPermission();
    if (result === 'granted') save({ enabled:true });
    window.dispatchEvent(new CustomEvent('eve:notification-permission', { detail:{ permission:result } }));
    return result;
  }
  async function show(options = {}) {
    const title = clean(options.title || 'EVE Chat', 100) || 'EVE Chat';
    const originalBody = clean(options.body || '', 500);
    const body = settings.previewEnabled ? originalBody : '你收到了一条新消息';
    const tag = clean(options.tag || `eve-${options.type || 'notice'}`, 120);
    if (!shouldShow() || !dedupe(title, body, tag)) return { shown:false, reason:permission() !== 'granted' ? 'permission' : 'visibility-or-duplicate' };
    const notificationOptions = {
      body,
      tag,
      renotify:Boolean(options.renotify),
      data:Object.assign({ url:location.href, type:options.type || 'notice' }, options.data || {}),
      silent:!settings.vibrate,
      vibrate:settings.vibrate ? [120, 60, 120] : undefined
    };
    try {
      const reg = registration || await navigator.serviceWorker?.getRegistration?.('./') || await registerServiceWorker();
      if (reg?.showNotification) await reg.showNotification(title, notificationOptions);
      else {
        const notice = new Notification(title, notificationOptions);
        notice.onclick = () => { window.focus(); notice.close(); };
      }
      window.dispatchEvent(new CustomEvent('eve:notification-shown', { detail:{ title, body, tag, options:notificationOptions } }));
      return { shown:true };
    } catch (error) {
      console.error('[EVENotifications] 显示通知失败：', error);
      return { shown:false, reason:String(error?.message || error) };
    }
  }
  function characterFromDetail(detail = {}) {
    return detail.character || detail.chat?.character || (() => { try { return typeof currentChatCharacter !== 'undefined' ? currentChatCharacter : null; } catch (_) { return null; } })();
  }
  function bind(target, event, handler) { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); }
  function installEvents() {
    bind(window, 'eve:ai-message-committed', event => {
      if (!settings.chatEnabled) return;
      const detail = event.detail || {}, character = characterFromDetail(detail);
      show({ title:character?.name || '角色新消息', body:detail.text || '发来一条消息', type:'chat', tag:`chat-${character?.id || detail.scope || 'current'}`, data:{ characterId:character?.id, messageId:detail.messageId } });
    });
    bind(window, 'eve:moment-interaction', event => {
      if (!settings.momentEnabled) return;
      const detail = event.detail || {};
      const action = detail.type === 'reply' ? '回复了你的评论' : detail.type === 'like' ? '赞了你的动态' : '评论了动态';
      show({ title:detail.actorName || '动态新互动', body:detail.text ? `${action}：${detail.text}` : action, type:'moment', tag:`moment-${detail.momentId || 'interaction'}`, data:{ momentId:detail.momentId } });
    });
    bind(window, 'eve:proactive-message-sent', event => {
      if (!settings.proactiveEnabled || !event.detail?.text) return;
      show({ title:event.detail.characterName || '角色主动找你', body:event.detail.text, type:'proactive', tag:'proactive-message' });
    });
    bind(navigator.serviceWorker || window, 'message', event => {
      const data = event.data || {};
      if (data.type === 'eve-notification-click' && data.url) {
        try { location.href = data.url; } catch (_) {}
      }
    });
  }
  function wrapOriginalPush() {
    if (!settings.bridgeOriginal) return;
    let current;
    try { current = typeof createPushNotification === 'function' ? createPushNotification : window.createPushNotification; } catch (_) { current = window.createPushNotification; }
    if (typeof current !== 'function' || current.__eveNotificationWrapped) return;
    nativePush = current;
    const wrapped = function (character, message, delay = 0) {
      const result = nativePush.apply(this, arguments);
      setTimeout(() => show({ title:character?.name || 'EVE Chat', body:typeof message === 'string' ? message : message?.text || message?.content || '有一条新通知', type:'native', tag:`native-${character?.id || 'eve'}` }), Number(delay) || 0);
      return result;
    };
    wrapped.__eveNotificationWrapped = true;
    window.createPushNotification = wrapped;
  }
  async function test() {
    if (permission() !== 'granted') {
      const result = await requestPermission();
      if (result !== 'granted') return { shown:false, reason:result };
    }
    const previous = settings.onlyWhenHidden;
    settings.onlyWhenHidden = false;
    const result = await show({ title:'EVE Chat 通知测试', body:'如果你看到这条通知，浏览器通知已正常工作。', type:'test', tag:`test-${Date.now()}` });
    settings.onlyWhenHidden = previous;
    return result;
  }
  function diagnostics() {
    return {
      version:VERSION, initialized, settings:getSettings(), permission:permission(), supported:typeof Notification !== 'undefined',
      serviceWorkerSupported:'serviceWorker' in navigator, serviceWorkerRegistered:Boolean(registration), originalBridge:Boolean(window.createPushNotification?.__eveNotificationWrapped)
    };
  }
  async function init() {
    if (initialized) return diagnostics(); initialized = true;
    await registerServiceWorker(); installEvents(); wrapOriginalPush();
    let tries = 0; const timer = setInterval(() => { tries += 1; wrapOriginalPush(); if (tries >= 20 || window.createPushNotification?.__eveNotificationWrapped) clearInterval(timer); }, 500);
    window.EVE ||= {}; window.EVE.notifications = window.EVENotifications;
    window.dispatchEvent(new CustomEvent('eve:notifications-ready', { detail:diagnostics() }));
    return diagnostics();
  }
  function destroy() {
    listeners.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
    if (nativePush) window.createPushNotification = nativePush;
    initialized = false;
  }

  window.EVENotifications = Object.freeze({ version:VERSION, init, destroy, configure:save, getSettings, getDiagnostics:diagnostics, requestPermission, show, test, getPermission:permission });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
