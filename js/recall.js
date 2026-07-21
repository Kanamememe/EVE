/**
 * EVE Chat Recall Module v0.8.0
 * Enables recall for user and character messages and removes linked extension
 * memory/timeline records. Native EVE recall rendering is kept intact.
 */
(function (window, document) {
  'use strict';
  if (window.EVERecall?.version) return;

  const VERSION = '0.8.0';
  const SETTINGS_KEY = 'eve_recall_settings_v2';
  const DEFAULTS = Object.freeze({
    enabled: true,
    allowAssistantRecall: true,
    purgeExtensionMemory: true,
    purgeExtensionTimeline: true,
    purgeNativeSourceLinkedMemory: true,
    nativeTextFallback: false,
    debug: false
  });
  const NATIVE_MEMORY_STORES = Object.freeze([
    'workingMemory','episodicMemory','episodicMemories','memorySummaries',
    'memoryEvents','coreMemory','coreMemories','crossAppTimeline'
  ]);

  let settings = read();
  let initialized = false;
  let originalShowMobileMenu = null;
  let originalDeleteMessage = null;
  let originalInternalRecall = null;
  const initiated = new Set();

  function read() { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (_) { return Object.assign({}, DEFAULTS); } }
  function configure(next = {}) {
    settings = Object.assign({}, DEFAULTS, settings, next || {});
    ['enabled','allowAssistantRecall','purgeExtensionMemory','purgeExtensionTimeline','purgeNativeSourceLinkedMemory','nativeTextFallback','debug'].forEach(key => settings[key] = Boolean(settings[key]));
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    emit('eve:recall-settings-updated', { settings:getSettings() });
    return getSettings();
  }
  function getSettings() { return Object.assign({}, settings); }
  function clean(value, max = 2000) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
  function clone(value) { try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); } catch (_) { return value; } }
  function emit(name, detail = {}) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} }
  function log(...args) { if (settings.debug) console.log('[EVERecall]', ...args); }
  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    if (window.showToast) return window.showToast(message, type);
  }
  function currentCharacter() {
    try { if (typeof currentChatCharacter !== 'undefined' && currentChatCharacter) return currentChatCharacter; } catch (_) {}
    return window.currentChatCharacter || null;
  }
  function legacyMessages(characterId) {
    try { if (typeof chatMessages !== 'undefined') return chatMessages[characterId] || []; } catch (_) {}
    return [];
  }
  function getMessage(messageId, characterId = currentCharacter()?.id) {
    return window.EVEAdapter?.getLegacyMessage?.(messageId)
      || legacyMessages(characterId).find(item => String(item.id) === String(messageId))
      || null;
  }
  function inferSelectedMessageId() {
    const bar = document.getElementById('message-action-bar');
    return bar?.closest?.('[data-message-id]')?.getAttribute('data-message-id') || '';
  }
  function isUserMessage(message) { return String(message?.sender || '').toLowerCase() === 'sent' || message?.isUser === true; }
  function messageText(message) { return clean(message?.content || message?.text || message?.emojiDescription || '', 3000); }

  function addAssistantRecallAction(messageId) {
    if (!settings.enabled || !settings.allowAssistantRecall) return;
    const message = getMessage(messageId);
    if (!message || isUserMessage(message) || message.isRecalled || message.type === 'recalled') return;
    const bar = document.getElementById('message-action-bar');
    if (!bar || bar.textContent.includes('撤回')) return;
    const template = bar.firstElementChild;
    const item = template ? template.cloneNode(false) : document.createElement('div');
    item.removeAttribute?.('onclick');
    item.textContent = '撤回';
    if (!template) item.style.cssText = 'padding:8px 12px;cursor:pointer;white-space:nowrap';
    item.dataset.eveRecallAction = '1';
    item.addEventListener('click', event => {
      event.stopPropagation();
      try { if (typeof hideMessageActionBar === 'function') hideMessageActionBar(); } catch (_) {}
      recall(messageId);
    });
    bar.appendChild(item);
  }

  function installMenuHook() {
    if (typeof window.showMobileMessageMenu !== 'function' || originalShowMobileMenu) return false;
    originalShowMobileMenu = window.showMobileMessageMenu;
    window.showMobileMessageMenu = function(messageId, event) {
      const result = originalShowMobileMenu.apply(this, arguments);
      setTimeout(() => addAssistantRecallAction(messageId), 0);
      return result;
    };
    return true;
  }

  function installDeleteHook() {
    if (typeof window.deleteMessage !== 'function' || originalDeleteMessage) return false;
    originalDeleteMessage = window.deleteMessage;
    window.deleteMessage = async function(messageId) {
      const resolved = clean(messageId || inferSelectedMessageId(), 200);
      if (resolved) initiated.add(resolved);
      try { return await originalDeleteMessage.apply(this, arguments); }
      finally { if (resolved) setTimeout(() => initiated.delete(resolved), 1500); }
    };
    return true;
  }

  function installInternalHook() {
    if (typeof window._internalRecallMessage !== 'function' || originalInternalRecall) return false;
    originalInternalRecall = window._internalRecallMessage;
    window._internalRecallMessage = async function(characterId, message) {
      const snapshot = clone(message || {});
      const id = clean(snapshot.id, 200);
      const userInitiated = initiated.has(id);
      const result = await originalInternalRecall.apply(this, arguments);
      if (settings.enabled && userInitiated && id) {
        try { await purgeLinkedData(characterId, snapshot); }
        catch (error) { console.warn('[EVERecall] 同步清理失败', error); }
      }
      return result;
    };
    return true;
  }

  function recordMatchesMessage(record, messageId, text, characterId, allowText) {
    if (!record || typeof record !== 'object') return false;
    const recordCharacterId = clean(record.characterId, 200);
    const ids = Array.isArray(record.characterIds) ? record.characterIds.map(String) : [];
    if (characterId && recordCharacterId && recordCharacterId !== String(characterId)) return false;
    if (characterId && ids.length && !ids.includes(String(characterId))) return false;

    const directFields = ['messageId','sourceMessageId','relatedMessageId','originalMessageId','contextId'];
    if (directFields.some(field => clean(record[field], 200) === messageId)) return true;
    const arrays = ['messageIds','sourceMessageIds','relatedMessageIds'];
    if (arrays.some(field => Array.isArray(record[field]) && record[field].map(String).includes(messageId))) return true;

    const serialized = (() => { try { return JSON.stringify(record); } catch (_) { return ''; } })();
    if (messageId && serialized.includes(`"${messageId}"`)) return true;
    if (!allowText || text.length < 8) return false;
    const fields = ['content','fact','summary','context','description','title','eventData'];
    const sample = text.slice(0, 180);
    return fields.some(field => {
      const value = typeof record[field] === 'string' ? clean(record[field], 4000) : (() => { try { return JSON.stringify(record[field] || ''); } catch (_) { return ''; } })();
      return value && (value === text || value.includes(sample));
    });
  }

  async function purgeNative(characterId, message) {
    if (!settings.purgeNativeSourceLinkedMemory || !window.db) return 0;
    const messageId = clean(message?.id, 200), text = messageText(message);
    let removed = 0;
    for (const storeName of NATIVE_MEMORY_STORES) {
      const table = window.db[storeName];
      if (!table?.toArray) continue;
      try {
        const records = await table.toArray();
        const matches = records.filter(record => recordMatchesMessage(record, messageId, text, characterId, settings.nativeTextFallback));
        const keys = matches.map(record => record.id).filter(key => key !== undefined && key !== null);
        if (keys.length && table.bulkDelete) { await table.bulkDelete(keys); removed += keys.length; }
        else if (keys.length && table.delete) { for (const key of keys) await table.delete(key); removed += keys.length; }
      } catch (error) { log(`清理 ${storeName} 失败`, error); }
    }
    return removed;
  }

  async function purgeLinkedData(characterId, message) {
    const messageId = clean(message?.id, 200), text = messageText(message);
    let memoryRemoved = 0, timelineRemoved = 0, nativeRemoved = 0;
    if (settings.purgeExtensionMemory && window.EVEMemory?.removeByMessage) memoryRemoved = Number(window.EVEMemory.removeByMessage(messageId, text)) || 0;
    if (settings.purgeExtensionTimeline && window.EVETimeline?.removeByMessage) timelineRemoved = Number(window.EVETimeline.removeByMessage(messageId, text)) || 0;
    nativeRemoved = await purgeNative(characterId, message);
    const detail = { messageId, characterId, message:clone(message), memoryRemoved, timelineRemoved, nativeRemoved, timestamp:Date.now() };
    emit('eve:message-recalled', detail);
    if (memoryRemoved || timelineRemoved || nativeRemoved) toast(`已撤回，并清理关联资料（记忆 ${memoryRemoved + nativeRemoved}，时间线 ${timelineRemoved}）`, 'success');
    return detail;
  }

  async function recall(messageId) {
    if (!settings.enabled) return false;
    const id = clean(messageId, 200), message = getMessage(id);
    if (!id || !message) { toast('找不到这条消息', 'error'); return false; }
    if (!isUserMessage(message) && !settings.allowAssistantRecall) { toast('角色消息撤回未开启', 'error'); return false; }
    if (typeof window.deleteMessage !== 'function') { toast('原生撤回功能不可用', 'error'); return false; }
    return window.deleteMessage(id);
  }

  function retryHooks() {
    installMenuHook(); installDeleteHook(); installInternalHook();
    if (!originalShowMobileMenu || !originalDeleteMessage || !originalInternalRecall) setTimeout(retryHooks, 1000);
  }
  function init() {
    if (initialized) return Promise.resolve(getDiagnostics());
    initialized = true; retryHooks();
    window.EVE ||= {}; window.EVE.recall = window.EVERecall;
    emit('eve:recall-ready', getDiagnostics());
    return Promise.resolve(getDiagnostics());
  }
  function getDiagnostics() {
    return { version:VERSION, initialized, settings:getSettings(), menuHook:Boolean(originalShowMobileMenu), deleteHook:Boolean(originalDeleteMessage), internalHook:Boolean(originalInternalRecall) };
  }
  function destroy() {
    if (originalShowMobileMenu) window.showMobileMessageMenu = originalShowMobileMenu;
    if (originalDeleteMessage) window.deleteMessage = originalDeleteMessage;
    if (originalInternalRecall) window._internalRecallMessage = originalInternalRecall;
    originalShowMobileMenu = originalDeleteMessage = originalInternalRecall = null; initialized = false;
  }

  window.EVERecall = Object.freeze({ version:VERSION, init, destroy, configure, getSettings, getDiagnostics, recall, purgeLinkedData });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
