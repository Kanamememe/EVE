/**
 * EVE Chat Response Recovery v1.3.1
 * ------------------------------------------------------------
 * - Keeps failed character replies out of the chat UI.
 * - Retries transient AI requests silently.
 * - Reissues the native smart-reply command when legacy parsing fails.
 * - Removes partial assistant messages produced by a failed generation.
 *
 * Safety-policy blocks are diagnosed and suppressed, but are not retried as a
 * way to bypass model protections.
 */
(function (window, document) {
  'use strict';
  if (window.EVEResponseRecovery?.version) return;

  const VERSION = '1.3.1';
  const SETTINGS_KEY = 'eve_response_recovery_settings_v1';
  const LOG_KEY = 'eve_response_recovery_log_v1';

  const DEFAULTS = Object.freeze({
    enabled: true,
    suppressFailureMessages: true,
    cleanStoredFailureMessages: true,
    autoRetry: true,
    requestRetries: 1,
    commandRetries: 2,
    baseDelayMs: 1400,
    backoffMultiplier: 1.8,
    maxDelayMs: 10000,
    jitterMs: 450,
    retryHttp408: true,
    retryHttp429: true,
    retryHttp5xx: true,
    retryEmptyResponse: true,
    retryMalformedOutput: true,
    showFinalToast: true,
    debug: false
  });

  const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
  const SAFETY_REASONS = new Set([
    'SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'IMAGE_SAFETY',
    'SPII', 'RECITATION', 'MODEL_ARMOR'
  ]);

  const FAILURE_PATTERNS = [
    /^\s*\[(?:AI|角色)?(?:回复|回覆|响应|回應|生成|续写|續寫)?失败\s*[:：]/i,
    /抱歉[，,\s]*(?:AI)?(?:响应|回應|回复|回覆)?生成失败/i,
    /AI(?:响应|回應|回复|回覆)生成失败/i,
    /空响应次数达到上限/i,
    /空回覆次數達到上限/i,
    /^\s*API\s*Error\s*[:：]/i,
    /^\s*\[(?:API|网络|網路)请求失败/i
  ];

  let settings = readSettings();
  let initialized = false;
  let previousFetch = null;
  let wrappedFetch = null;
  let hookTimer = null;
  let observer = null;
  let pendingRetryTimer = null;
  let currentInvocation = null;
  let latestUser = null;
  let lastFailure = null;
  let lastFailedAnchor = null;
  let settleTimer = null;
  const commandAttempts = new Map();
  const originalFunctions = new Map();
  const disposers = [];
  const stats = {
    requestRetries: 0,
    commandRetries: 0,
    suppressedMessages: 0,
    removedPartialMessages: 0,
    recoveredReplies: 0,
    finalFailures: 0,
    safetyStops: 0,
    storedFailuresCleaned: 0
  };

  function readSettings() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
    } catch (_) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettings(next = {}) {
    settings = Object.assign({}, DEFAULTS, settings, next || {});
    [
      'enabled', 'suppressFailureMessages', 'cleanStoredFailureMessages',
      'autoRetry', 'retryHttp408', 'retryHttp429', 'retryHttp5xx',
      'retryEmptyResponse', 'retryMalformedOutput', 'showFinalToast', 'debug'
    ].forEach(key => { settings[key] = Boolean(settings[key]); });
    settings.requestRetries = clampInt(settings.requestRetries, 0, 5, 1);
    settings.commandRetries = clampInt(settings.commandRetries, 0, 5, 2);
    settings.baseDelayMs = clampInt(settings.baseDelayMs, 200, 30000, 1400);
    settings.maxDelayMs = clampInt(settings.maxDelayMs, settings.baseDelayMs, 120000, 10000);
    settings.jitterMs = clampInt(settings.jitterMs, 0, 5000, 450);
    settings.backoffMultiplier = Math.max(1, Math.min(4, Number(settings.backoffMultiplier) || 1.8));
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    emit('eve:response-recovery-settings-updated', { settings: getSettings() });
    return getSettings();
  }

  function clampInt(value, min, max, fallback) {
    const parsed = Number(value);
    return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.round(parsed) : fallback));
  }

  function clean(value, max = 50000) {
    return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  }

  function clone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }

  function emit(name, detail = {}) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
  }

  function log(...args) {
    if (settings.debug) console.log('[EVEResponseRecovery]', ...args);
  }

  function toast(message, type = 'error') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    try { if (window.showToast) return window.showToast(message, type); } catch (_) {}
    console[type === 'error' ? 'warn' : 'log']('[EVEResponseRecovery]', message);
  }

  function on(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    disposers.push(() => target.removeEventListener(event, handler, options));
  }

  function getGlobalFunction(name) {
    try {
      if (typeof window[name] === 'function') return window[name];
      return (0, eval)(`typeof ${name} === 'function' ? ${name} : null`);
    } catch (_) { return null; }
  }

  function setGlobalFunction(name, fn) {
    try { window[name] = fn; } catch (_) {}
    try { (0, eval)(`${name} = window[${JSON.stringify(name)}]`); } catch (_) {}
  }

  function currentCharacter() {
    try { if (typeof currentChatCharacter !== 'undefined' && currentChatCharacter) return currentChatCharacter; } catch (_) {}
    return window.currentChatCharacter || null;
  }

  function currentChatId() {
    return clean(currentCharacter()?.id, 200);
  }

  function legacyMessageMap() {
    try { if (typeof chatMessages !== 'undefined' && chatMessages) return chatMessages; } catch (_) {}
    return window.chatMessages || null;
  }

  function messageList(characterId = currentChatId()) {
    const map = legacyMessageMap();
    return map && characterId ? (map[characterId] || []) : [];
  }

  function messageId(message) {
    return clean(message?.id || message?.messageId || message?.originalMessageId, 240);
  }

  function messageText(message) {
    if (!message) return '';
    const value = message.content ?? message.message ?? message.text ?? message.reply ?? '';
    if (typeof value === 'string') return clean(value, 20000);
    if (Array.isArray(value)) {
      return clean(value.map(item => typeof item === 'string' ? item : item?.text || item?.content || item?.message || '').filter(Boolean).join('\n'), 20000);
    }
    if (value && typeof value === 'object') return clean(value.text || value.content || value.message || JSON.stringify(value), 20000);
    return clean(value, 20000);
  }

  function isAssistantMessage(message) {
    const sender = clean(message?.sender || message?.role || message?.from, 50).toLowerCase();
    if (['sent', 'user', 'me', 'self'].includes(sender)) return false;
    if (['received', 'assistant', 'ai', 'character', 'bot'].includes(sender)) return true;
    return Boolean(message && (message.isAI || message.isAssistant || message.characterId));
  }

  function isFailureText(text) {
    const value = clean(text, 3000);
    return Boolean(value && FAILURE_PATTERNS.some(pattern => pattern.test(value)));
  }

  function isFailureMessage(message) {
    if (!message || !isAssistantMessage(message)) return false;
    if (message.isError || message.error === true || message.status === 'error' || message.type === 'error' || message.isErrorMessage) return true;
    return isFailureText(messageText(message));
  }

  function lastUserMessage(characterId = currentChatId()) {
    const list = messageList(characterId);
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      const sender = clean(message?.sender, 30).toLowerCase();
      if (sender === 'sent' || sender === 'user') {
        return { id: messageId(message), text: messageText(message), timestamp: Number(message?.timestamp) || Date.now(), index };
      }
    }
    return latestUser && (!characterId || latestUser.characterId === characterId) ? clone(latestUser) : null;
  }

  function retryKey(characterId, anchor) {
    return `${characterId || 'global'}|${anchor?.id || anchor?.timestamp || clean(anchor?.text, 100) || 'latest'}`;
  }

  function appendLog(entry) {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (_) {}
    if (!Array.isArray(rows)) rows = [];
    rows.unshift(Object.assign({ at: new Date().toISOString() }, entry));
    rows = rows.slice(0, 120);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(rows)); } catch (_) {}
  }

  function getLogs() {
    try {
      const rows = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      return Array.isArray(rows) ? rows : [];
    } catch (_) { return []; }
  }

  function delayForAttempt(attempt, retryAfterMs = 0) {
    if (retryAfterMs > 0) return Math.min(settings.maxDelayMs, retryAfterMs);
    const base = settings.baseDelayMs * Math.pow(settings.backoffMultiplier, Math.max(0, attempt - 1));
    const jitter = settings.jitterMs ? Math.floor(Math.random() * settings.jitterMs) : 0;
    return Math.min(settings.maxDelayMs, Math.round(base + jitter));
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }

  function isAIEndpoint(url) {
    const value = String(url || '');
    return /generativelanguage\.googleapis\.com/i.test(value) ||
      /\/models\/[^/]+:(generateContent|streamGenerateContent)/i.test(value) ||
      /\/chat\/completions(?:\?|$)/i.test(value);
  }

  async function snapshotRequest(input, init) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '';
    let bodyText = typeof init?.body === 'string' ? init.body : '';
    if (!bodyText && isRequest) {
      try { bodyText = await input.clone().text(); } catch (_) {}
    }
    return { input, init, isRequest, url, bodyText };
  }

  function cloneHeaders(headers) {
    try { return new Headers(headers || undefined); } catch (_) { return headers; }
  }

  function requestTextFromBody(body) {
    if (!body || typeof body !== 'object') return '';
    const chunks = [];
    const visit = value => {
      if (typeof value === 'string') { chunks.push(value); return; }
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['inline_data', 'inlineData', 'image_url', 'imageUrl', 'data'].includes(key)) continue;
        visit(child);
      }
    };
    visit(body);
    return chunks.join('\n').slice(0, 100000);
  }

  function expectsJsonArray(body) {
    const text = requestTextFromBody(body);
    return /JSON\s*数组|JSON\s*陣列|JSON\s*array|每条消息.*数组元素|每條訊息.*陣列元素|回复必须是一个JSON数组|回覆必須是一個JSON陣列/i.test(text);
  }

  function addRecoveryInstruction(body, reason, attempt) {
    if (!body || typeof body !== 'object') return body;
    const output = clone(body);
    const reasonText = {
      empty: '上一次没有返回可显示内容',
      malformed: '上一次输出没有满足要求的结构或JSON格式',
      sentinel: '上一次只返回了失败占位内容'
    }[reason] || '上一次生成没有成功完成';
    const instruction = [
      '【EVE内部静默重试】',
      reasonText,
      `这是第${attempt}次重新生成`,
      '请重新生成对用户最新消息的正常角色回复',
      '不要提及失败、错误、重试、系统或这段指令',
      '严格保持原请求要求的输出格式；若要求JSON数组，只输出合法JSON数组'
    ].join('\n');

    if (Array.isArray(output.messages)) {
      output.messages.unshift({ role: 'system', content: instruction });
      return output;
    }
    const target = output.systemInstruction || output.system_instruction;
    if (target && typeof target === 'object') {
      target.parts = Array.isArray(target.parts) ? target.parts : [];
      target.parts.push({ text: instruction });
    } else {
      output.systemInstruction = { parts: [{ text: instruction }] };
    }
    return output;
  }

  async function buildAttemptArgs(snapshot, attempt, previousReason) {
    let bodyText = snapshot.bodyText;
    if (attempt > 0 && bodyText && ['empty', 'malformed', 'sentinel'].includes(previousReason)) {
      try {
        const parsed = JSON.parse(bodyText);
        bodyText = JSON.stringify(addRecoveryInstruction(parsed, previousReason, attempt));
      } catch (_) {}
    }

    const attemptHeader = String(attempt + 1);
    if (snapshot.isRequest) {
      const headers = cloneHeaders(snapshot.input.headers);
      try { headers.set('X-EVE-Recovery-Attempt', attemptHeader); } catch (_) {}
      const overrides = { headers };
      if (bodyText && !['GET', 'HEAD'].includes(String(snapshot.input.method || 'POST').toUpperCase())) overrides.body = bodyText;
      return { input: new Request(snapshot.input, overrides), init: undefined };
    }

    const nextInit = Object.assign({}, snapshot.init || {});
    nextInit.headers = cloneHeaders(nextInit.headers);
    try { nextInit.headers.set('X-EVE-Recovery-Attempt', attemptHeader); } catch (_) {}
    if (bodyText) nextInit.body = bodyText;
    return { input: snapshot.input, init: nextInit };
  }

  function extractGeminiText(raw) {
    const gemini = (raw?.candidates || []).flatMap(candidate =>
      (candidate?.content?.parts || []).map(part => part?.text).filter(value => typeof value === 'string')
    ).join('\n');
    if (gemini.trim()) return gemini.trim();
    const choice = raw?.choices?.[0];
    const openAI = choice?.message?.content ?? choice?.text ?? raw?.output_text ?? raw?.text ?? raw?.content;
    return typeof openAI === 'string' ? openAI.trim() : '';
  }

  function parseLooseJson(text) {
    let source = clean(text, 100000).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    for (let pass = 0; pass < 2; pass += 1) {
      try {
        const parsed = JSON.parse(source);
        if (typeof parsed === 'string') { source = parsed.trim(); continue; }
        return parsed;
      } catch (_) {}
      const startArray = source.indexOf('['), endArray = source.lastIndexOf(']');
      if (startArray >= 0 && endArray > startArray) {
        try { return JSON.parse(source.slice(startArray, endArray + 1)); } catch (_) {}
      }
      const startObject = source.indexOf('{'), endObject = source.lastIndexOf('}');
      if (startObject >= 0 && endObject > startObject) {
        try { return JSON.parse(source.slice(startObject, endObject + 1)); } catch (_) {}
      }
      break;
    }
    return null;
  }

  function responseSafetyReason(raw) {
    const reasons = [];
    if (raw?.promptFeedback?.blockReason) reasons.push(raw.promptFeedback.blockReason);
    for (const candidate of raw?.candidates || []) if (candidate?.finishReason) reasons.push(candidate.finishReason);
    if (raw?.choices?.[0]?.finish_reason) reasons.push(raw.choices[0].finish_reason);
    return reasons.map(value => String(value).toUpperCase()).find(value => SAFETY_REASONS.has(value)) || '';
  }

  function parseRetryAfter(response) {
    const value = response?.headers?.get?.('retry-after');
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
  }

  function shouldRetryHttp(status) {
    if (status === 408) return settings.retryHttp408;
    if (status === 429) return settings.retryHttp429;
    if (status >= 500 && status <= 599) return settings.retryHttp5xx;
    return RETRYABLE_HTTP.has(status) && settings.retryHttp5xx;
  }

  async function classifyResponse(response, bodyObject) {
    if (!response) return { ok: false, retryable: true, reason: 'network', message: '没有收到响应' };
    if (!response.ok) {
      return {
        ok: false,
        retryable: shouldRetryHttp(response.status),
        reason: `http-${response.status}`,
        message: `HTTP ${response.status}`,
        retryAfterMs: parseRetryAfter(response)
      };
    }

    const type = response.headers?.get?.('content-type') || '';
    try {
      if (/application\/json/i.test(type)) {
        const raw = await response.clone().json();
        const safety = responseSafetyReason(raw);
        if (safety) return { ok: false, retryable: false, safety: true, reason: 'safety', message: safety, raw };
        if (raw?.error) {
          const status = Number(raw.error.code) || response.status;
          return { ok: false, retryable: shouldRetryHttp(status), reason: `api-${status}`, message: raw.error.message || 'API错误', raw };
        }
        const text = extractGeminiText(raw);
        if (!text) return { ok: false, retryable: settings.retryEmptyResponse, reason: 'empty', message: '模型返回空内容', raw };
        if (isFailureText(text)) return { ok: false, retryable: true, reason: 'sentinel', message: text, raw };
        if (expectsJsonArray(bodyObject)) {
          const parsed = parseLooseJson(text);
          if (!Array.isArray(parsed)) return { ok: false, retryable: settings.retryMalformedOutput, reason: 'malformed', message: '回复不是有效JSON数组', raw };
        }
        return { ok: true, retryable: false, reason: 'success', textLength: text.length, raw };
      }

      const rawText = await response.clone().text();
      if (/text\/event-stream|application\/x-ndjson/i.test(type) || /\bdata:\s*\{/m.test(rawText)) {
        const chunks = [];
        let safety = '';
        for (const line of rawText.split('\n')) {
          const source = line.trim().replace(/^data:\s*/, '');
          if (!source || source === '[DONE]') continue;
          try {
            const raw = JSON.parse(source);
            safety ||= responseSafetyReason(raw);
            const text = extractGeminiText(raw);
            if (text) chunks.push(text);
          } catch (_) {}
        }
        if (safety) return { ok: false, retryable: false, safety: true, reason: 'safety', message: safety };
        const text = chunks.join('').trim();
        if (!text) return { ok: false, retryable: settings.retryEmptyResponse, reason: 'empty', message: '串流响应没有内容' };
        if (isFailureText(text)) return { ok: false, retryable: true, reason: 'sentinel', message: text };
        if (expectsJsonArray(bodyObject) && !Array.isArray(parseLooseJson(text))) {
          return { ok: false, retryable: settings.retryMalformedOutput, reason: 'malformed', message: '串流回复不是有效JSON数组' };
        }
        return { ok: true, retryable: false, reason: 'success', textLength: text.length };
      }
      return { ok: true, retryable: false, reason: 'success' };
    } catch (error) {
      return { ok: false, retryable: settings.retryMalformedOutput, reason: 'malformed', message: error?.message || '响应解析失败' };
    }
  }

  async function fetchWithRetry(input, init) {
    const snapshot = await snapshotRequest(input, init);
    if (!settings.enabled || !settings.autoRetry || !isAIEndpoint(snapshot.url)) return previousFetch(input, init);

    let bodyObject = null;
    try { bodyObject = snapshot.bodyText ? JSON.parse(snapshot.bodyText) : null; } catch (_) {}
    let lastResponse = null;
    let lastError = null;
    let previousReason = '';
    const totalAttempts = settings.requestRetries + 1;

    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      if (attempt > 0) {
        const delay = delayForAttempt(attempt, lastFailure?.retryAfterMs || 0);
        stats.requestRetries += 1;
        emit('eve:response-recovery-request-retry', { attempt, delay, reason: previousReason, url: snapshot.url });
        appendLog({ type: 'request-retry', attempt, delay, reason: previousReason, url: snapshot.url });
        await wait(delay);
      }

      try {
        const args = await buildAttemptArgs(snapshot, attempt, previousReason);
        const response = await previousFetch(args.input, args.init);
        const classification = await classifyResponse(response, bodyObject);
        if (classification.ok) {
          if (attempt > 0) emit('eve:response-recovery-request-recovered', { attempt, url: snapshot.url });
          return response;
        }

        lastResponse = response;
        previousReason = classification.reason;
        lastFailure = Object.assign({ at: Date.now(), layer: 'request', url: snapshot.url }, classification);
        appendLog({ type: 'request-failure', attempt, classification: clone(classification), url: snapshot.url });

        if (classification.safety) {
          stats.safetyStops += 1;
          emit('eve:response-recovery-safety-stop', clone(lastFailure));
          return response;
        }
        if (!classification.retryable || attempt >= totalAttempts - 1) return response;
      } catch (error) {
        lastError = error;
        previousReason = 'network';
        lastFailure = { at: Date.now(), layer: 'request', retryable: true, reason: 'network', message: clean(error?.message || error, 1000), url: snapshot.url };
        appendLog({ type: 'network-failure', attempt, message: lastFailure.message, url: snapshot.url });
        if (attempt >= totalAttempts - 1) throw error;
      }
    }

    if (lastResponse) return lastResponse;
    throw lastError || new Error('AI request failed');
  }

  function installFetchHook() {
    if (typeof window.fetch !== 'function') return false;
    if (wrappedFetch && window.fetch === wrappedFetch) return true;
    previousFetch = window.fetch.bind(window);
    wrappedFetch = async function (input, init) {
      return fetchWithRetry(input, init);
    };
    Object.defineProperty(wrappedFetch, '__eveResponseRecoveryWrapped', { value: true });
    window.fetch = wrappedFetch;
    return true;
  }

  function restoreFetch() {
    if (wrappedFetch && window.fetch === wrappedFetch && previousFetch) window.fetch = previousFetch;
    wrappedFetch = null;
    previousFetch = null;
  }

  function snapshotInvocation() {
    const characterId = currentChatId();
    const list = messageList(characterId);
    const beforeObjects = new Set(list);
    const beforeIds = new Set(list.map(messageId).filter(Boolean));
    const anchor = lastUserMessage(characterId);
    return {
      id: `generation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      characterId,
      startedAt: Date.now(),
      beforeObjects,
      beforeIds,
      anchor,
      failure: null,
      removedIds: []
    };
  }

  function newAssistantMessages(invocation) {
    const list = messageList(invocation.characterId);
    return list.filter(message => {
      const id = messageId(message);
      return isAssistantMessage(message) && !invocation.beforeObjects.has(message) && (!id || !invocation.beforeIds.has(id));
    });
  }

  async function deleteDbMessage(characterId, id) {
    if (!id || !window.db?.chatMessages) return;
    try {
      const rows = await window.db.chatMessages.where('characterId').equals(characterId).filter(row =>
        String(row?.originalMessageId || '') === String(id) || String(row?.messageData?.id || '') === String(id)
      ).toArray();
      if (rows.length) await window.db.chatMessages.bulkDelete(rows.map(row => row.id));
    } catch (error) { log('删除失败消息数据库记录失败', error); }
  }

  function purgeExtensions(id, text) {
    if (!id) return;
    try { window.EVEMemory?.removeByMessage?.(id, text); } catch (_) {}
    try { window.EVETimeline?.removeByMessage?.(id, text); } catch (_) {}
    try { window.EVEMemoryInbox?.purgeByMessage?.(id); } catch (_) {}
  }

  function purgeMessages(messages, characterId, reason = 'failure') {
    if (!Array.isArray(messages) || !messages.length) return [];
    const map = legacyMessageMap();
    const list = map?.[characterId];
    const objects = new Set(messages);
    const ids = new Set(messages.map(messageId).filter(Boolean));
    const removed = [];

    if (Array.isArray(list)) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const message = list[index];
        const id = messageId(message);
        if (objects.has(message) || (id && ids.has(id))) {
          removed.push(message);
          list.splice(index, 1);
        }
      }
    }

    for (const message of removed) {
      const id = messageId(message);
      const text = messageText(message);
      if (id) {
        deleteDbMessage(characterId, id);
        purgeExtensions(id, text);
      }
      if (id) document.querySelectorAll(`[data-message-id="${cssEscape(id)}"]`).forEach(node => node.remove());
    }

    if (reason === 'partial') stats.removedPartialMessages += removed.length;
    return removed;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value || ''));
    return String(value || '').replace(/["\\]/g, '\\$&');
  }

  function purgeInvocation(invocation) {
    const messages = newAssistantMessages(invocation);
    const removed = purgeMessages(messages, invocation.characterId, 'partial');
    invocation.removedIds = removed.map(messageId).filter(Boolean);
    return removed;
  }

  function markFailure(message, characterId) {
    const failure = {
      at: Date.now(),
      layer: 'legacy-ui',
      reason: lastFailure?.reason || 'legacy-error-message',
      message: messageText(message),
      safety: Boolean(lastFailure?.safety),
      retryable: lastFailure?.safety ? false : true,
      characterId: characterId || currentChatId()
    };
    lastFailure = failure;
    lastFailedAnchor = lastUserMessage(failure.characterId);
    if (currentInvocation && currentInvocation.characterId === failure.characterId) currentInvocation.failure = failure;
    appendLog({ type: 'suppressed-message', failure: clone(failure), messageId: messageId(message) });
    emit('eve:response-recovery-failure-suppressed', clone(failure));
    return failure;
  }

  function installAddMessageHook() {
    const original = getGlobalFunction('addMessageWithAnimation');
    if (!original || original.__eveResponseRecoveryWrapped) return Boolean(original);
    originalFunctions.set('addMessageWithAnimation', original);
    const wrapped = function (message, characterId, ...rest) {
      if (settings.enabled && settings.suppressFailureMessages && isFailureMessage(message)) {
        stats.suppressedMessages += 1;
        markFailure(message, clean(characterId, 200));
        purgeMessages([message], clean(characterId, 200), 'failure');
        return undefined;
      }
      return original.call(this, message, characterId, ...rest);
    };
    Object.defineProperty(wrapped, '__eveResponseRecoveryWrapped', { value: true });
    setGlobalFunction('addMessageWithAnimation', wrapped);
    return true;
  }

  function installRenderHook(name) {
    const original = getGlobalFunction(name);
    if (!original || original.__eveResponseRecoveryWrapped) return Boolean(original);
    originalFunctions.set(name, original);
    const wrapped = function (...args) {
      if (settings.enabled && settings.suppressFailureMessages) purgeStoredFailuresSync(false);
      return original.apply(this, args);
    };
    Object.defineProperty(wrapped, '__eveResponseRecoveryWrapped', { value: true });
    setGlobalFunction(name, wrapped);
    return true;
  }

  function installProcessHook() {
    const original = getGlobalFunction('processAIReply');
    if (!original || original.__eveResponseRecoveryWrapped) return Boolean(original);
    originalFunctions.set('processAIReply', original);
    const wrapped = async function (...args) {
      if (!settings.enabled) return original.apply(this, args);
      const invocation = snapshotInvocation();
      currentInvocation = invocation;
      emit('eve:response-recovery-generation-start', { id: invocation.id, characterId: invocation.characterId, anchor: clone(invocation.anchor) });
      try {
        return await original.apply(this, args);
      } catch (error) {
        invocation.failure = {
          at: Date.now(), layer: 'process', reason: 'uncaught-process-error',
          message: clean(error?.message || error, 1000), retryable: true,
          characterId: invocation.characterId
        };
        lastFailure = invocation.failure;
        return undefined;
      } finally {
        if (invocation.failure) {
          purgeInvocation(invocation);
          queueCommandRetry(invocation);
        } else {
          const produced = newAssistantMessages(invocation).filter(message => !isFailureMessage(message));
          if (produced.length) markRecovered(invocation, produced);
        }
        if (currentInvocation === invocation) currentInvocation = null;
      }
    };
    Object.defineProperty(wrapped, '__eveResponseRecoveryWrapped', { value: true });
    setGlobalFunction('processAIReply', wrapped);
    return true;
  }

  function restoreLegacyHooks() {
    for (const [name, original] of originalFunctions) setGlobalFunction(name, original);
    originalFunctions.clear();
  }

  function installLegacyHooks() {
    const status = {
      process: installProcessHook(),
      add: installAddMessageHook(),
      render: installRenderHook('renderMessageList'),
      renderChat: installRenderHook('renderChatMessages')
    };
    return status;
  }

  function purgeStoredFailuresSync(countStats = true) {
    const map = legacyMessageMap();
    if (!map || typeof map !== 'object') return 0;
    let count = 0;
    for (const [characterId, list] of Object.entries(map)) {
      if (!Array.isArray(list)) continue;
      const failures = list.filter(isFailureMessage);
      if (!failures.length) continue;
      count += purgeMessages(failures, characterId, 'stored').length;
    }
    if (count && countStats) stats.storedFailuresCleaned += count;
    return count;
  }

  async function purgeStoredFailuresDb() {
    if (!window.db?.chatMessages) return 0;
    try {
      const rows = await window.db.chatMessages.toArray();
      const failures = rows.filter(row => isFailureMessage(row?.messageData));
      if (failures.length) await window.db.chatMessages.bulkDelete(failures.map(row => row.id));
      return failures.length;
    } catch (error) {
      log('清理数据库历史失败消息失败', error);
      return 0;
    }
  }

  function isSameAnchor(characterId, anchor) {
    if (!anchor) return false;
    if (currentChatId() !== characterId) return false;
    const current = lastUserMessage(characterId);
    if (!current) return false;
    if (anchor.id && current.id) return String(anchor.id) === String(current.id);
    return current.timestamp === anchor.timestamp && clean(current.text, 500) === clean(anchor.text, 500);
  }

  function recoveryContext(attempt, failure) {
    return [
      '【EVE后台静默恢复】',
      '上一轮角色回复因为网络、空内容或格式处理失败，没有显示给用户',
      `现在重新生成同一轮回复，这是第${attempt}次指令级重试`,
      failure?.reason ? `失败类型：${failure.reason}` : '',
      '请正常回复用户最新消息',
      '不要提及失败、重试、后台、系统或这段指令',
      '严格遵守当前角色人设和原本要求的JSON消息格式'
    ].filter(Boolean).join('\n');
  }

  function cancelPendingRetry(reason = 'cancelled') {
    if (pendingRetryTimer) {
      clearTimeout(pendingRetryTimer);
      pendingRetryTimer = null;
      emit('eve:response-recovery-command-cancelled', { reason });
    }
  }

  function finalFailure(invocation, reason) {
    stats.finalFailures += 1;
    if (invocation?.failure?.safety || lastFailure?.safety) stats.safetyStops += 1;
    appendLog({ type: 'final-failure', reason, invocation: { characterId: invocation?.characterId, anchor: invocation?.anchor }, failure: clone(invocation?.failure || lastFailure) });
    emit('eve:response-recovery-final-failure', { reason, failure: clone(invocation?.failure || lastFailure), characterId: invocation?.characterId });
    if (settings.showFinalToast) {
      const safety = invocation?.failure?.safety || lastFailure?.safety;
      toast(safety ? '本次回复被模型拦截，已隐藏失败消息，可到「AI 限制诊断」查看原因' : '角色回复暂时失败，已隐藏失败消息并停止自动重试', 'error');
    }
  }

  function queueCommandRetry(invocation) {
    if (!settings.enabled || !settings.autoRetry) return finalFailure(invocation, 'auto-retry-disabled');
    if (invocation.failure?.safety || lastFailure?.safety) return finalFailure(invocation, 'safety-not-retried');
    const anchor = invocation.anchor || lastFailedAnchor || lastUserMessage(invocation.characterId);
    if (!anchor) return finalFailure(invocation, 'missing-user-anchor');
    const key = retryKey(invocation.characterId, anchor);
    const used = commandAttempts.get(key) || 0;
    if (used >= settings.commandRetries) return finalFailure(invocation, 'command-retries-exhausted');

    cancelPendingRetry('replaced');
    const nextAttempt = used + 1;
    const delay = delayForAttempt(nextAttempt);
    pendingRetryTimer = setTimeout(async () => {
      pendingRetryTimer = null;
      if (!isSameAnchor(invocation.characterId, anchor)) {
        commandAttempts.delete(key);
        emit('eve:response-recovery-command-cancelled', { reason: 'newer-user-message', characterId: invocation.characterId });
        return;
      }
      commandAttempts.set(key, nextAttempt);
      stats.commandRetries += 1;
      appendLog({ type: 'command-retry', attempt: nextAttempt, characterId: invocation.characterId, anchor: clone(anchor), failure: clone(invocation.failure) });
      emit('eve:response-recovery-command-retry', { attempt: nextAttempt, characterId: invocation.characterId, anchor: clone(anchor), failure: clone(invocation.failure) });
      const result = await window.EVEAdapter?.requestSmartReply?.({
        reason: 'response-recovery',
        context: recoveryContext(nextAttempt, invocation.failure),
        allowClosedChat: false,
        ttl: 90000
      });
      if (!result?.sent) {
        const failedInvocation = Object.assign({}, invocation, { failure: { at: Date.now(), reason: result?.reason || 'retry-command-not-sent', message: result?.error?.message || '', retryable: true, characterId: invocation.characterId } });
        queueCommandRetry(failedInvocation);
      }
    }, delay);
    emit('eve:response-recovery-command-scheduled', { attempt: nextAttempt, delay, characterId: invocation.characterId, anchor: clone(anchor) });
  }

  function markRecovered(invocation, messages) {
    const key = retryKey(invocation.characterId, invocation.anchor);
    const hadRetries = (commandAttempts.get(key) || 0) > 0;
    commandAttempts.delete(key);
    lastFailure = null;
    if (hadRetries) {
      stats.recoveredReplies += 1;
      appendLog({ type: 'recovered', characterId: invocation.characterId, messageIds: messages.map(messageId).filter(Boolean) });
      emit('eve:response-recovery-success', { characterId: invocation.characterId, messageIds: messages.map(messageId).filter(Boolean) });
    }
  }

  function retryLastNow() {
    const characterId = currentChatId();
    const anchor = lastFailedAnchor || lastUserMessage(characterId);
    if (!characterId || !anchor) return Promise.resolve({ sent: false, reason: 'no-failed-message' });
    cancelPendingRetry('manual-retry');
    const invocation = { characterId, anchor, failure: lastFailure || { reason: 'manual', retryable: true } };
    const key = retryKey(characterId, anchor);
    commandAttempts.set(key, Math.max(0, (commandAttempts.get(key) || 0) - 1));
    queueCommandRetry(invocation);
    return Promise.resolve({ sent: true, scheduled: true });
  }

  function installObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(records => {
      if (!settings.enabled || !settings.suppressFailureMessages) return;
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const candidates = [node, ...node.querySelectorAll?.('[data-message-id],.message-container,.message-item') || []];
        for (const element of candidates) {
          const text = clean(element.textContent, 3000);
          const assistant = !element.matches?.('.sent,.my-message,.user-message,[data-sender="user"]');
          if (assistant && isFailureText(text)) {
            const id = clean(element.dataset?.messageId || element.getAttribute?.('data-message-id'), 200);
            element.remove();
            if (id) {
              const characterId = currentChatId();
              const list = messageList(characterId);
              const message = list.find(item => messageId(item) === id);
              if (message) purgeMessages([message], characterId, 'failure');
            }
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function bindEvents() {
    on(window, 'eve:user-message-committed', event => {
      latestUser = {
        characterId: clean(event.detail?.chat?.id || currentChatId(), 200),
        id: clean(event.detail?.messageId || event.detail?.id, 200),
        text: clean(event.detail?.text, 20000),
        timestamp: Number(event.detail?.timestamp) || Date.now()
      };
      cancelPendingRetry('new-user-message');
      commandAttempts.clear();
      lastFailure = null;
      lastFailedAnchor = null;
    });

    on(window, 'eve:ai-response-detail', event => {
      const detail = event.detail || {};
      const safety = Boolean(detail.blockReason) || SAFETY_REASONS.has(String(detail.finishReason || '').toUpperCase());
      if (safety) lastFailure = { at: Date.now(), layer: 'diagnostic', reason: 'safety', safety: true, retryable: false, message: detail.blockReason || detail.finishReason || 'SAFETY' };
      else if (!detail.ok || detail.emptyResponse || detail.parseError) {
        lastFailure = {
          at: Date.now(), layer: 'diagnostic',
          reason: detail.parseError ? 'malformed' : detail.emptyResponse ? 'empty' : `http-${detail.status || 0}`,
          safety: false, retryable: true,
          message: detail.parseError || detail.error?.message || detail.blockReasonMessage || ''
        };
      }
    });

    on(window, 'eve:ai-error', event => {
      lastFailure = { at: Date.now(), layer: 'adapter', reason: 'network', safety: false, retryable: true, message: clean(event.detail?.error?.message || event.detail?.error, 1000) };
    });

    on(window, 'eve:adapter-ready', () => {
      if (window.fetch !== wrappedFetch) installFetchHook();
    });
  }

  function installHooksRepeatedly() {
    const status = installLegacyHooks();
    if (status.process && status.add && status.render) {
      if (hookTimer) clearInterval(hookTimer);
      hookTimer = null;
      return true;
    }
    return false;
  }

  function getSettings() { return Object.assign({}, settings); }

  function getState() {
    return {
      pendingRetry: Boolean(pendingRetryTimer),
      currentInvocation: currentInvocation ? { id: currentInvocation.id, characterId: currentInvocation.characterId, startedAt: currentInvocation.startedAt, failure: clone(currentInvocation.failure) } : null,
      lastFailure: clone(lastFailure),
      lastFailedAnchor: clone(lastFailedAnchor),
      commandAttempts: Object.fromEntries(commandAttempts),
      stats: Object.assign({}, stats)
    };
  }

  function getDiagnostics() {
    const process = getGlobalFunction('processAIReply');
    const add = getGlobalFunction('addMessageWithAnimation');
    return {
      version: VERSION,
      initialized,
      settings: getSettings(),
      fetchHookInstalled: Boolean(wrappedFetch && window.fetch === wrappedFetch),
      processHookInstalled: Boolean(process?.__eveResponseRecoveryWrapped),
      addMessageHookInstalled: Boolean(add?.__eveResponseRecoveryWrapped),
      renderHookInstalled: Boolean(getGlobalFunction('renderMessageList')?.__eveResponseRecoveryWrapped),
      pendingRetry: Boolean(pendingRetryTimer),
      lastFailure: clone(lastFailure),
      stats: Object.assign({}, stats),
      recentLogs: getLogs().slice(0, 10)
    };
  }

  function openSettings() {
    document.getElementById('eve-response-recovery-panel')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'eve-response-recovery-panel';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:14px';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:min(560px,100%);max-height:92vh;overflow:auto;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;box-shadow:0 15px 50px #0005';
    const row = (label, input, description = '') => `<label style="display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid #ddd"><span style="flex:1"><b>${label}</b>${description ? `<small style="display:block;opacity:.65;margin-top:3px">${description}</small>` : ''}</span>${input}</label>`;
    const checkbox = (name, checked) => `<input type="checkbox" data-field="${name}" ${checked ? 'checked' : ''}>`;
    const number = (name, value, min, max, step = 1) => `<input type="number" data-field="${name}" value="${value}" min="${min}" max="${max}" step="${step}" style="width:82px">`;
    panel.innerHTML = `<div style="display:flex;align-items:center;padding:15px 17px;border-bottom:1px solid #ddd"><b style="flex:1">回复失败自动恢复</b><button data-close>✕</button></div><div style="padding:8px 17px 14px">${row('启用静默恢复', checkbox('enabled', settings.enabled), '失败内容不会作为角色消息显示')}${row('自动重试', checkbox('autoRetry', settings.autoRetry), '先重试API请求，仍失败时重新发出角色回复指令')}${row('清理历史失败消息', checkbox('cleanStoredFailureMessages', settings.cleanStoredFailureMessages))}${row('API请求额外重试次数', number('requestRetries', settings.requestRetries, 0, 5))}${row('重新发出回复指令次数', number('commandRetries', settings.commandRetries, 0, 5))}${row('首次重试延迟（毫秒）', number('baseDelayMs', settings.baseDelayMs, 200, 30000, 100))}${row('最终失败显示顶部提示', checkbox('showFinalToast', settings.showFinalToast))}<div style="padding:12px 0;font-size:12px;line-height:1.6;opacity:.7">网络错误、429、5xx、空回复和格式错误可以自动重试。明确的Safety拦截只会隐藏失败消息并写入诊断，不会尝试绕过。</div><div data-status style="padding:10px;border-radius:10px;background:rgba(127,127,127,.1);font-size:12px;white-space:pre-wrap"></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button data-retry>立即重试上一次</button><button data-clean>清理历史失败消息</button><button data-diagnostics>复制诊断</button></div></div><div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 17px;border-top:1px solid #ddd"><button data-cancel>取消</button><button data-save style="background:#4a84c1;color:#fff;border:0;border-radius:9px;padding:8px 18px">保存</button></div>`;
    overlay.append(panel); document.body.append(overlay);
    const close = () => overlay.remove();
    panel.querySelector('[data-close]').onclick = close;
    panel.querySelector('[data-cancel]').onclick = close;
    overlay.onclick = event => { if (event.target === overlay) close(); };
    const refreshStatus = () => { panel.querySelector('[data-status]').textContent = JSON.stringify(getState(), null, 2); };
    refreshStatus();
    panel.querySelector('[data-save]').onclick = () => {
      const values = {};
      panel.querySelectorAll('[data-field]').forEach(input => { values[input.dataset.field] = input.type === 'checkbox' ? input.checked : Number(input.value); });
      saveSettings(values); close(); toast('回复失败自动恢复设置已保存', 'success');
    };
    panel.querySelector('[data-retry]').onclick = async () => { await retryLastNow(); refreshStatus(); };
    panel.querySelector('[data-clean]').onclick = async () => { const a = purgeStoredFailuresSync(); const b = await purgeStoredFailuresDb(); stats.storedFailuresCleaned += a + b; refreshStatus(); toast(`已清理 ${a + b} 条失败消息`, 'success'); };
    panel.querySelector('[data-diagnostics]').onclick = async () => { const text = JSON.stringify(getDiagnostics(), null, 2); try { await navigator.clipboard.writeText(text); toast('诊断已复制', 'success'); } catch (_) { prompt('复制诊断', text); } };
  }

  async function init() {
    if (initialized) return getDiagnostics();
    initialized = true;
    installFetchHook();
    installHooksRepeatedly();
    if (!hookTimer) hookTimer = setInterval(installHooksRepeatedly, 700);
    installObserver();
    bindEvents();
    if (settings.cleanStoredFailureMessages) {
      stats.storedFailuresCleaned += purgeStoredFailuresSync();
      stats.storedFailuresCleaned += await purgeStoredFailuresDb();
    }
    window.EVE ||= {};
    window.EVE.responseRecovery = window.EVEResponseRecovery;
    emit('eve:response-recovery-ready', getDiagnostics());
    return getDiagnostics();
  }

  function destroy() {
    cancelPendingRetry('destroy');
    if (hookTimer) clearInterval(hookTimer);
    hookTimer = null;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    observer?.disconnect(); observer = null;
    disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} });
    restoreLegacyHooks();
    restoreFetch();
    initialized = false;
  }

  window.EVEResponseRecovery = Object.freeze({
    version: VERSION,
    init,
    destroy,
    configure: saveSettings,
    getSettings,
    getState,
    getDiagnostics,
    getLogs,
    retryLastNow,
    purgeStoredFailures: async () => {
      const memory = purgeStoredFailuresSync();
      const database = await purgeStoredFailuresDb();
      stats.storedFailuresCleaned += memory + database;
      return { memory, database, total: memory + database };
    },
    openSettings,
    isFailureText,
    isFailureMessage
  });

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init, { once: true })
    : init();
})(window, document);
