/**
 * EVE Chat Adapter v1.2.0
 * Connects the legacy EVE Chat page with Weather, Proactive, Memory and Timeline.
 */
(function (window, document) {
  'use strict';
  if (window.EVEAdapter?.version) return;

  const VERSION = '1.2.0';
  const KEY = 'eve_adapter_settings_v4';
  const DEFAULTS = Object.freeze({
    enabled: true,
    injectWeather: true,
    injectActivity: true,
    trackUserMessages: true,
    observeCommittedMessages: true,
    autoReplyEnabled: false,
    autoReplyDelaySeconds: 3,
    debug: false,
    maxContextCharacters: 14000,
    oneShotTtlMs: 45000
  });

  const providers = new Map();
  const requestTransformers = new Map();
  const responseTransformers = new Map();
  const disposers = [];
  const fingerprints = new Map();
  const seenMessageIds = new Set();
  let config = read();
  let nativeFetch = null;
  let initialized = false;
  let oneShot = '';
  let oneShotUntil = 0;
  let lastRequestAt = 0;
  let lastResponseAt = 0;
  let latestUserText = '';
  let latestUserAt = 0;
  let requestSeq = 0;
  let observer = null;
  let autoReplyTimer = null;
  let autoReplyUserAt = 0;

  function read() { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (_) { return Object.assign({}, DEFAULTS); } }
  function save(next = {}) {
    config = Object.assign({}, DEFAULTS, config, next || {});
    ['enabled','injectWeather','injectActivity','trackUserMessages','observeCommittedMessages','autoReplyEnabled','debug'].forEach(k => config[k] = Boolean(config[k]));
    config.autoReplyDelaySeconds = Math.max(0, Math.min(120, Number(config.autoReplyDelaySeconds) || 3));
    config.maxContextCharacters = Math.max(1000, Math.min(50000, Number(config.maxContextCharacters) || 14000));
    config.oneShotTtlMs = Math.max(1000, Math.min(300000, Number(config.oneShotTtlMs) || 45000));
    try { localStorage.setItem(KEY, JSON.stringify(config)); } catch (_) {}
    return Object.assign({}, config);
  }
  function log(...args) { if (config.debug) console.log('[EVEAdapter]', ...args); }
  function emit(name, detail = {}) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} }
  function on(target, name, handler, options) { target.addEventListener(name, handler, options); disposers.push(() => target.removeEventListener(name, handler, options)); }
  function clone(value) { try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); } catch (_) { return value; } }
  function clean(value, max = 100000) { return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max); }
  function slug(value) { return clean(value, 120).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'global'; }
  function currentCharacter() {
    try { if (typeof currentChatCharacter !== 'undefined' && currentChatCharacter) return currentChatCharacter; } catch (_) {}
    return window.currentChatCharacter || null;
  }
  function getCurrentChat() {
    const character = currentCharacter();
    const title = clean(document.getElementById('api-chat-title')?.textContent, 100);
    const input = document.getElementById('api-chat-input');
    const screen = document.getElementById('api-chat-screen');
    const open = Boolean(input && (!screen || screen.offsetParent !== null || screen.classList.contains('active')));
    const id = clean(character?.id, 100);
    return {
      open, id, name: clean(character?.name || title, 100), title,
      scope: id ? `character:${slug(id)}` : (title && title !== '角色聊天' ? `character:${slug(title)}` : 'global')
    };
  }

  function registerContextProvider(id, provider, options = {}) {
    if (!id || typeof provider !== 'function') throw new TypeError('Context provider requires an id and a function.');
    providers.set(String(id), { id:String(id), provider, priority:Number(options.priority) || 100, enabled:options.enabled !== false });
    return () => providers.delete(String(id));
  }
  function unregisterContextProvider(id) { return providers.delete(String(id)); }
  function setContextProviderEnabled(id, enabled) { const item = providers.get(String(id)); if (!item) return false; item.enabled = Boolean(enabled); return true; }
  function registerRequestTransformer(id, transformer, options = {}) {
    if (!id || typeof transformer !== 'function') throw new TypeError('Request transformer requires an id and a function.');
    requestTransformers.set(String(id), { id:String(id), transformer, priority:Number(options.priority) || 100, enabled:options.enabled !== false });
    return () => requestTransformers.delete(String(id));
  }
  function unregisterRequestTransformer(id) { return requestTransformers.delete(String(id)); }
  function registerResponseTransformer(id, transformer, options = {}) {
    if (!id || typeof transformer !== 'function') throw new TypeError('Response transformer requires an id and a function.');
    responseTransformers.set(String(id), { id:String(id), transformer, priority:Number(options.priority) || 100, enabled:options.enabled !== false });
    return () => responseTransformers.delete(String(id));
  }
  function unregisterResponseTransformer(id) { return responseTransformers.delete(String(id)); }
  async function applyRequestTransformers(body, meta = {}) {
    let output = clone(body);
    for (const item of [...requestTransformers.values()].filter(x => x.enabled).sort((a,b) => a.priority - b.priority)) {
      try {
        const next = await item.transformer(output, Object.assign({ chat:getCurrentChat() }, meta));
        if (next && typeof next === 'object') output = next;
      } catch (error) { console.warn(`[EVEAdapter] 请求转换器失败：${item.id}`, error); }
    }
    return output;
  }
  async function applyResponseTextTransformers(text, meta = {}) {
    let output = String(text ?? '');
    for (const item of [...responseTransformers.values()].filter(x => x.enabled).sort((a,b) => a.priority - b.priority)) {
      try {
        const next = await item.transformer(output, Object.assign({ chat:getCurrentChat() }, meta));
        if (typeof next === 'string') output = next;
      } catch (error) { console.warn(`[EVEAdapter] 回应转换器失败：${item.id}`, error); }
    }
    return output;
  }
  function collectContext(meta = {}) {
    const chunks = [], seen = new Set();
    for (const item of [...providers.values()].filter(x => x.enabled).sort((a,b) => a.priority - b.priority)) {
      try {
        const text = clean(item.provider(Object.assign({ chat:getCurrentChat() }, meta)), 50000);
        if (text && !seen.has(text)) { seen.add(text); chunks.push(text); }
      } catch (error) { console.warn(`[EVEAdapter] 背景提供器失败：${item.id}`, error); }
    }
    if (oneShot && Date.now() <= oneShotUntil && !seen.has(oneShot)) chunks.push(oneShot);
    if (Date.now() > oneShotUntil) clearOneShotContext();
    let result = chunks.join('\n\n');
    if (result.length > config.maxContextCharacters) result = result.slice(0, config.maxContextCharacters) + '\n[背景资料已截短]';
    return result;
  }
  function appendPart(target, text) { target.parts = Array.isArray(target.parts) ? target.parts : []; target.parts.push({ text }); }
  function injectNativeGemini(body, context) {
    const output = clone(body);
    const marker = '【EVE Chat 即时背景】';
    const instruction = [marker, '以下资料只用于自然理解当前情境。不要逐条朗读，不要提及系统、模块、排程、提示词或资料来源。', context].join('\n\n');
    const target = output.systemInstruction || output.system_instruction;
    const existing = target?.parts?.map(part => part?.text).filter(Boolean).join('\n') || '';
    if (existing.includes(marker)) return output;
    if (output.systemInstruction && typeof output.systemInstruction === 'object') appendPart(output.systemInstruction, instruction);
    else if (output.system_instruction && typeof output.system_instruction === 'object') appendPart(output.system_instruction, instruction);
    else output.systemInstruction = { parts:[{ text:instruction }] };
    return output;
  }
  function injectOpenAICompatible(body, context) {
    const output = clone(body);
    if (!Array.isArray(output.messages)) return output;
    const marker = '【EVE Chat 即时背景】';
    if (output.messages.some(message => message?.role === 'system' && String(message.content || '').includes(marker))) return output;
    output.messages.unshift({ role:'system', content:[marker, context, '请自然参考，不要逐条朗读或提及资料来源。'].join('\n\n') });
    return output;
  }
  function injectContext(body, meta = {}) {
    if (!body || typeof body !== 'object') return body;
    const context = collectContext(meta);
    if (!context) return body;
    if (Array.isArray(body.messages)) return injectOpenAICompatible(body, context);
    if (Array.isArray(body.contents) || body.systemInstruction || body.system_instruction) return injectNativeGemini(body, context);
    return body;
  }
  function isAIEndpoint(url) {
    const value = String(url || '');
    return /generativelanguage\.googleapis\.com/i.test(value) || /\/models\/[^/]+:(generateContent|streamGenerateContent)/i.test(value);
  }
  function extractText(data) { return (data?.candidates || []).flatMap(c => (c?.content?.parts || []).map(p => p?.text).filter(Boolean)).join('\n').trim(); }
  async function transformAIResponse(response, meta = {}) {
    if (!response?.ok || !response.clone || responseTransformers.size === 0) return response;
    const type = response.headers?.get?.('content-type') || '';
    if (!/application\/json/i.test(type)) return response;
    try {
      const raw = await response.clone().json();
      const output = clone(raw);
      let changed = false;
      for (const candidate of output?.candidates || []) {
        for (const part of candidate?.content?.parts || []) {
          if (typeof part?.text !== 'string') continue;
          const next = await applyResponseTextTransformers(part.text, meta);
          if (next !== part.text) { part.text = next; changed = true; }
        }
      }
      for (const choice of output?.choices || []) {
        if (typeof choice?.message?.content === 'string') {
          const next = await applyResponseTextTransformers(choice.message.content, meta);
          if (next !== choice.message.content) { choice.message.content = next; changed = true; }
        }
        if (typeof choice?.text === 'string') {
          const next = await applyResponseTextTransformers(choice.text, meta);
          if (next !== choice.text) { choice.text = next; changed = true; }
        }
      }
      if (!changed) return response;
      const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding'); headers.delete('transfer-encoding');
      return new Response(JSON.stringify(output), { status:response.status, statusText:response.statusText, headers });
    } catch (error) {
      console.warn('[EVEAdapter] 回应后处理失败，已使用原回应', error);
      return response;
    }
  }
  function extractDiagnosticFromJson(raw, prepared, response) {
    const candidates = Array.isArray(raw?.candidates) ? raw.candidates : [];
    const first = candidates[0] || {};
    const text = extractText(raw);
    const requestBody = prepared?.requestBody || {};
    const modelFromUrl = String(prepared?.url || '').match(/\/models\/([^/:?]+)(?::|\/)/)?.[1] || '';
    return {
      id:`diag_${prepared?.requestId || Date.now()}`,
      timestamp:Date.now(),
      url:prepared?.url || '',
      model:requestBody.model || modelFromUrl,
      status:response?.status || 0,
      ok:Boolean(response?.ok),
      blockReason:raw?.promptFeedback?.blockReason || '',
      blockReasonMessage:raw?.promptFeedback?.blockReasonMessage || '',
      promptSafetyRatings:clone(raw?.promptFeedback?.safetyRatings || []),
      finishReason:first?.finishReason || raw?.choices?.[0]?.finish_reason || '',
      safetyRatings:clone(first?.safetyRatings || []),
      citationMetadata:clone(first?.citationMetadata || null),
      error:clone(raw?.error || null),
      textLength:text.length,
      emptyResponse:!text,
      safetySettings:clone(requestBody.safetySettings || requestBody.safety_settings || []),
      generationConfig:clone(requestBody.generationConfig || { temperature:requestBody.temperature, topP:requestBody.top_p, maxTokens:requestBody.max_tokens }),
      rawSummary:clone({ promptFeedback:raw?.promptFeedback || null, finishReason:first?.finishReason || null, safetyRatings:first?.safetyRatings || null, error:raw?.error || null })
    };
  }
  async function inspectAIResponse(response, prepared) {
    if (!response?.clone) return null;
    try {
      const type = response.headers?.get?.('content-type') || '';
      const copy = response.clone();
      let raw = null;
      if (/application\/json/i.test(type)) raw = await copy.json();
      else {
        const body = await copy.text();
        const payloads = [];
        for (const line of body.split('\n').map(value => value.trim()).filter(Boolean)) {
          const source = line.replace(/^data:\s*/, '');
          if (!source || source === '[DONE]') continue;
          try { payloads.push(JSON.parse(source)); } catch (_) {}
        }
        raw = payloads.length ? payloads[payloads.length - 1] : { rawText:body.slice(0,4000) };
      }
      const diagnostic = extractDiagnosticFromJson(raw || {}, prepared, response);
      emit('eve:ai-response-detail', diagnostic);
      return diagnostic;
    } catch (error) {
      const diagnostic = {
        id:`diag_${prepared?.requestId || Date.now()}`,
        timestamp:Date.now(), url:prepared?.url || '', status:response?.status || 0,
        ok:Boolean(response?.ok), parseError:clean(error?.message || error, 1000), emptyResponse:true
      };
      emit('eve:ai-response-detail', diagnostic);
      return diagnostic;
    }
  }

  async function parseResponse(response, url, requestId) {
    if (!response?.ok || !response.clone) return;
    try {
      const type = response.headers?.get?.('content-type') || '';
      const copy = response.clone(); let text = '', raw = null;
      if (/application\/json/i.test(type)) { raw = await copy.json(); text = extractText(raw); }
      else {
        const body = await copy.text(), chunks = [];
        for (const line of body.split('\n').map(x => x.trim()).filter(Boolean)) {
          const source = line.replace(/^data:\s*/, ''); if (!source || source === '[DONE]') continue;
          try { const extracted = extractText(JSON.parse(source)); if (extracted) chunks.push(extracted); } catch (_) {}
        }
        text = chunks.join(''); raw = body.slice(0, 20000);
      }
      if (text) emit('eve:ai-message-received', { text, url, requestId, timestamp:Date.now(), raw:clone(raw) });
    } catch (error) { log('读取 AI 回应失败，已忽略', error); }
  }
  async function prepare(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    let bypass = false;
    try {
      const headers = new Headers(init?.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
      bypass = headers.get('X-EVE-Bypass-Adapter') === '1';
    } catch (_) {}
    if (bypass || !config.enabled || !isAIEndpoint(url)) return { input, init, url, ai:false };
    let body = typeof init?.body === 'string' ? init.body : '';
    if (!body && typeof Request !== 'undefined' && input instanceof Request) { try { body = await input.clone().text(); } catch (_) {} }
    if (!body) return { input, init, url, ai:true };
    try {
      const parsed = JSON.parse(body), requestId = ++requestSeq;
      const meta = { url, requestId, userText:Date.now() - latestUserAt < 120000 ? latestUserText : '', chat:getCurrentChat() };
      const transformed = await applyRequestTransformers(parsed, meta);
      const injected = injectContext(transformed, meta);
      let nextInput = input, nextInit = Object.assign({}, init || {}, { body:JSON.stringify(injected) });
      if (typeof Request !== 'undefined' && input instanceof Request) { nextInput = new Request(input, nextInit); nextInit = undefined; }
      lastRequestAt = Date.now(); cancelAutoReply('ai-request-started');
      emit('eve:ai-request', { url, requestId, body:clone(injected), timestamp:lastRequestAt });
      return { input:nextInput, init:nextInit, url, ai:true, requestId, requestBody:clone(injected) };
    } catch (error) {
      console.warn('[EVEAdapter] 背景注入失败，已使用原请求', error);
      return { input, init, url, ai:true };
    }
  }
  function installFetch() {
    if (nativeFetch || typeof window.fetch !== 'function') return;
    nativeFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
      const prepared = await prepare(input, init);
      try {
        let response = await nativeFetch(prepared.input, prepared.init);
        if (prepared.ai) {
          response = await transformAIResponse(response, { url:prepared.url, requestId:prepared.requestId, requestBody:prepared.requestBody, userText:latestUserText });
          lastResponseAt = Date.now();
          emit('eve:ai-response', { url:prepared.url, requestId:prepared.requestId, ok:response.ok, status:response.status, timestamp:lastResponseAt });
          await inspectAIResponse(response, prepared);
          parseResponse(response, prepared.url, prepared.requestId);
        }
        return response;
      } catch (error) {
        if (prepared.ai) emit('eve:ai-error', { url:prepared.url, requestId:prepared.requestId, error, timestamp:Date.now() });
        throw error;
      } finally { if (prepared.ai && oneShot) clearOneShotContext(); }
    };
  }
  function restoreFetch() { if (nativeFetch) { window.fetch = nativeFetch; nativeFetch = null; } }
  function setOneShotContext(text, ttl = config.oneShotTtlMs) { oneShot = clean(text, config.maxContextCharacters); oneShotUntil = Date.now() + Math.max(1000, Number(ttl) || config.oneShotTtlMs); }
  function clearOneShotContext() { oneShot = ''; oneShotUntil = 0; }

  function findSmartButton() {
    return [...document.querySelectorAll('button[onclick]')].find(button => String(button.getAttribute('onclick') || '').includes('triggerSmartReply')) || null;
  }
  async function requestSmartReply(options = {}) {
    if (!config.enabled) return { sent:false, reason:'adapter-disabled' };
    if (!getCurrentChat().open && !options.allowClosedChat) return { sent:false, reason:'no-open-chat' };
    let fn = null;
    try { if (typeof triggerSmartReply === 'function') fn = triggerSmartReply; } catch (_) {}
    fn ||= typeof window.triggerSmartReply === 'function' ? window.triggerSmartReply : null;
    const button = findSmartButton();
    if (!fn && !button) return { sent:false, reason:'smart-reply-not-found' };
    if (options.context) setOneShotContext(options.context, options.ttl);
    emit('eve:smart-reply-start', { reason:options.reason || 'manual' });
    try {
      const result = fn ? await fn() : button.click();
      emit('eve:smart-reply-complete', { reason:options.reason || 'manual', result:clone(result) });
      return { sent:true, result };
    } catch (error) {
      clearOneShotContext(); emit('eve:smart-reply-error', { reason:options.reason || 'manual', error });
      return { sent:false, reason:'trigger-failed', error };
    }
  }
  async function requestProactiveMessage(payload = {}) {
    const context = ['【主动消息模式】','角色正在主动联系使用者，而不是回答一条刚收到的新消息。','请生成一则自然、简短、符合角色人设的消息；不要提到排程、触发器、系统或提示词。',payload.activity?.label ? `角色当前状态：${payload.activity.label}` : '',payload.promptContext || ''].filter(Boolean).join('\n');
    emit('eve:proactive-dispatch-start', { payload:clone(payload) });
    const result = await requestSmartReply({ reason:'proactive', context });
    if (result.sent) emit('eve:proactive-dispatch-complete', { payload:clone(payload), result:clone(result) });
    else emit('eve:proactive-dispatch-error', { payload:clone(payload), result:clone(result) });
    return result;
  }

  function fingerprint(text) { return `${clean(text, 500)}|${getCurrentChat().scope}`; }
  function markUserMessage(detail = {}) {
    if (!config.trackUserMessages) return false;
    const text = clean(detail.text, 100000); if (!text) return false;
    const fp = fingerprint(text), previous = fingerprints.get(fp) || 0;
    if (Date.now() - previous < 1200) return false;
    fingerprints.set(fp, Date.now()); for (const [key, time] of fingerprints) if (Date.now() - time > 10000) fingerprints.delete(key);
    latestUserText = text; latestUserAt = Date.now(); window.EVEProactive?.markUserInteraction?.();
    emit('eve:user-message-sent', Object.assign({ timestamp:Date.now(), text, chat:getCurrentChat() }, detail));
    return true;
  }
  function installInputTracking() {
    on(document, 'click', event => {
      const button = event.target?.closest?.('button'); if (!button) return;
      const onclick = String(button.getAttribute('onclick') || '');
      if (!/send.*message|sendMessage|sendApiMessage/i.test(onclick) && !button.matches('[aria-label*="发送"], [title*="发送"], .send-btn, .chat-send-btn')) return;
      const input = document.getElementById('api-chat-input'); if (input?.value.trim()) markUserMessage({ text:input.value.trim(), source:'button' });
    }, true);
    on(document, 'keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target?.id === 'api-chat-input' && event.target.value.trim()) markUserMessage({ text:event.target.value.trim(), source:'enter' });
    }, true);
  }
  function messageText(element) {
    const target = element.querySelector('.message-bubble,.message-content,.text-message,.message-text') || element;
    const copy = target.cloneNode(true); copy.querySelectorAll?.('.reply-reference,.message-action-bar,.message-actions,.timestamp,.message-time,button').forEach(node => node.remove());
    return clean(copy.textContent, 5000);
  }
  function messageSender(element) {
    if (element.matches('.sent,.my-message,.user-message,[data-sender="user"],[data-role="user"]') || element.classList.contains('sent')) return 'user';
    return 'assistant';
  }
  function commitElement(element, silent = false) {
    if (!element?.matches?.('[data-message-id],.message-container[data-message-id]')) return;
    const id = clean(element.dataset.messageId || element.getAttribute('data-message-id'), 200);
    if (!id || seenMessageIds.has(id)) return;
    seenMessageIds.add(id);
    if (silent || element.querySelector('.recalled-message') || element.classList.contains('recalled-message')) return;
    const text = messageText(element), sender = messageSender(element);
    if (!text && !element.querySelector('img')) return;
    const detail = { messageId:id, id, text, sender, scope:getCurrentChat().scope, chat:getCurrentChat(), timestamp:Date.now(), element };
    emit('eve:message-committed', detail);
    emit(sender === 'user' ? 'eve:user-message-committed' : 'eve:ai-message-committed', detail);
    if (sender === 'user') scheduleAutoReply(detail); else cancelAutoReply('assistant-committed');
  }
  function scanMessages(root = document, silent = false) { root.querySelectorAll?.('[data-message-id]').forEach(element => commitElement(element, silent)); }
  function installMessageObserver() {
    if (!config.observeCommittedMessages || observer) return;
    scanMessages(document, true);
    observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('[data-message-id]')) commitElement(node, false);
        scanMessages(node, false);
      }
    });
    observer.observe(document.body, { childList:true, subtree:true });
  }
  function cancelAutoReply(reason) {
    if (!autoReplyTimer) return;
    clearTimeout(autoReplyTimer); autoReplyTimer = null; emit('eve:auto-reply-cancelled', { reason });
  }
  function scheduleAutoReply(detail) {
    cancelAutoReply('replaced');
    if (!config.autoReplyEnabled) return;
    autoReplyUserAt = detail.timestamp || Date.now();
    autoReplyTimer = setTimeout(async () => {
      autoReplyTimer = null;
      if (!config.autoReplyEnabled || lastRequestAt >= autoReplyUserAt) return;
      await requestSmartReply({ reason:'auto-reply', context:'【自动回复模式】\n使用者刚发送了一条消息，请按角色人设自然回复。不要提到自动回复功能。' });
    }, config.autoReplyDelaySeconds * 1000);
    emit('eve:auto-reply-scheduled', { dueAt:Date.now() + config.autoReplyDelaySeconds * 1000, messageId:detail.messageId });
  }
  function getLegacyMessage(id) {
    try { const character = currentCharacter(); if (typeof chatMessages !== 'undefined' && character?.id) return (chatMessages[character.id] || []).find(item => String(item.id) === String(id)) || null; }
    catch (_) {}
    return null;
  }
  function registerBuiltIns() {
    if (!providers.has('weather')) registerContextProvider('weather', () => config.injectWeather ? window.EVEWeather?.getPromptContext?.() || '' : '', { priority:20 });
    if (!providers.has('activity')) registerContextProvider('activity', () => config.injectActivity ? window.EVEProactive?.getPromptContext?.() || '' : '', { priority:30 });
  }
  function configure(next = {}) { const result = save(next); emit('eve:adapter-settings-updated', { settings:result }); return result; }
  function diagnostics() {
    return {
      version:VERSION, initialized, settings:Object.assign({}, config), fetchHookInstalled:Boolean(nativeFetch), chat:getCurrentChat(),
      weatherModule:Boolean(window.EVEWeather), proactiveModule:Boolean(window.EVEProactive), memoryModule:Boolean(window.EVEMemory),
      timelineModule:Boolean(window.EVETimeline), recallModule:Boolean(window.EVERecall), stickersModule:Boolean(window.EVEStickers),
      momentsModule:Boolean(window.EVEMoments), notificationsModule:Boolean(window.EVENotifications), replyContextModule:Boolean(window.EVEReplyContext), replyOutputModule:Boolean(window.EVEReplyOutput),
      stickerIntelligenceModule:Boolean(window.EVEStickerIntelligence), sceneStateModule:Boolean(window.EVESceneState), dailyScheduleModule:Boolean(window.EVEDailySchedule), xiaoyiScheduleModule:Boolean(window.EVEXiaoYiSchedule), aiDiagnosticsModule:Boolean(window.EVEAIDiagnostics),
      healthModule:Boolean(window.EVEHealth), roleFidelityModule:Boolean(window.EVERoleFidelity), contextProviders:[...providers.keys()], requestTransformers:[...requestTransformers.keys()], responseTransformers:[...responseTransformers.keys()], contextLength:collectContext({ diagnostics:true }).length,
      lastGeminiRequestAt:lastRequestAt, lastGeminiResponseAt:lastResponseAt, observedMessages:seenMessageIds.size,
      smartReplyFunction:(() => { try { return typeof triggerSmartReply === 'function' || typeof window.triggerSmartReply === 'function'; } catch (_) { return false; } })(),
      smartReplyButton:Boolean(findSmartButton())
    };
  }
  function init() {
    if (initialized) return Promise.resolve(diagnostics());
    initialized = true; registerBuiltIns(); installFetch(); installInputTracking(); installMessageObserver();
    window.EVEProactiveAdapter = { sendMessage:requestProactiveMessage };
    on(window, 'eve:proactive-message-request', event => requestProactiveMessage(event.detail || {}));
    on(window, 'eve:proactive-trigger', event => requestProactiveMessage(event.detail || {}));
    window.EVE ||= {}; window.EVE.adapter = window.EVEAdapter;
    emit('eve:adapter-ready', diagnostics());
    return Promise.resolve(diagnostics());
  }
  function destroy() {
    disposers.splice(0).forEach(fn => { try { fn(); } catch (_) {} }); observer?.disconnect(); observer = null;
    cancelAutoReply('destroy'); restoreFetch(); providers.clear(); requestTransformers.clear(); responseTransformers.clear(); seenMessageIds.clear(); clearOneShotContext(); initialized = false;
  }

  window.EVEAdapter = Object.freeze({
    version:VERSION, init, destroy, configure, getSettings:() => Object.assign({}, config), getDiagnostics:diagnostics,
    getCurrentChat, registerContextProvider, unregisterContextProvider, setContextProviderEnabled,
    registerRequestTransformer, unregisterRequestTransformer, registerResponseTransformer, unregisterResponseTransformer,
    getPromptContext:collectContext, injectGeminiContext:injectContext, setOneShotContext, clearOneShotContext,
    markUserMessage, requestSmartReply, requestProactiveMessage, getLegacyMessage,
    triggerProactiveNow:() => window.EVEProactive?.triggerNow?.({ force:true }) || requestProactiveMessage({ reason:'manual' })
  });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
