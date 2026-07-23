/**
 * EVE Provider Request Compatibility v1.5.6
 * Keeps OpenAI-compatible requests accepted by SiliconFlow and preserves the
 * newest conversation when a provider imposes a small messages limit.
 */
(function (window) {
  'use strict';
  if (window.EVEProviderRequestCompat?.version) return;

  const VERSION = '1.5.6';
  const MAX_SILICONFLOW_MESSAGES = 10;
  const disposers = [];
  let previousFetch = null;
  let installed = false;
  let lastReport = null;

  function clone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }
  function clean(value, max = 2000) { return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max); }
  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }
  function emit(name, detail = {}) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
  }
  function isSiliconFlow(url) {
    try {
      const parsed = new URL(String(url || ''), document.baseURI);
      return /(^|\.)api\.siliconflow\.cn$/i.test(parsed.hostname) && /\/v1\/chat\/completions\/?$/i.test(parsed.pathname);
    } catch (_) { return /api\.siliconflow\.cn\/v1\/chat\/completions/i.test(String(url || '')); }
  }
  function contentToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return clean(content, 100000);
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      if (part?.type === 'input_text') return part.text || '';
      return '';
    }).filter(Boolean).join('\n');
  }
  function normalizeUserContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return clean(content, 100000);
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') { if (part.trim()) parts.push({ type:'text', text:part }); continue; }
      if (part?.type === 'text' && typeof part.text === 'string') parts.push({ type:'text', text:part.text });
      else if (part?.type === 'input_text' && typeof part.text === 'string') parts.push({ type:'text', text:part.text });
      else if (part?.type === 'image_url' && part.image_url?.url) {
        parts.push({ type:'image_url', image_url:{ url:String(part.image_url.url), ...(part.image_url.detail ? { detail:part.image_url.detail } : {}) } });
      } else if (part?.type === 'input_image' && (part.image_url || part.image_url?.url)) {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (url) parts.push({ type:'image_url', image_url:{ url:String(url) } });
      }
    }
    return parts.length ? parts : contentToText(content);
  }
  function normalizeMessage(message) {
    if (!message || typeof message !== 'object') return null;
    let role = String(message.role || 'user').toLowerCase();
    if (role === 'developer') role = 'system';
    if (!['system','user','assistant'].includes(role)) role = 'user';
    let content = role === 'user' ? normalizeUserContent(message.content) : contentToText(message.content);
    if (Array.isArray(content) && content.length === 0) content = '';
    if (typeof content === 'string' && !content.trim()) return null;
    return { role, content };
  }
  function mergeAndWindowMessages(messages, maxMessages = MAX_SILICONFLOW_MESSAGES) {
    const normalized = (Array.isArray(messages) ? messages : []).map(normalizeMessage).filter(Boolean);
    const systemTexts = normalized.filter(item => item.role === 'system').map(item => contentToText(item.content)).filter(Boolean);
    const conversation = normalized.filter(item => item.role !== 'system');
    const output = [];
    if (systemTexts.length) output.push({ role:'system', content:systemTexts.join('\n\n') });
    const slots = Math.max(1, maxMessages - output.length);
    let recent = conversation.slice(-slots);
    // Avoid starting a reduced history with an orphan assistant turn when possible.
    while (recent.length > 1 && recent[0]?.role === 'assistant') recent.shift();
    output.push(...recent);
    return { messages:output.slice(-maxMessages), originalCount:normalized.length, finalCount:Math.min(output.length, maxMessages) };
  }
  function sanitizeSiliconFlowBody(raw, options = {}) {
    const strict = Boolean(options.strict);
    const body = raw && typeof raw === 'object' ? clone(raw) : {};
    const windowed = mergeAndWindowMessages(body.messages, strict ? 8 : MAX_SILICONFLOW_MESSAGES);
    const maxFromEither = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
    const output = {
      model: clean(body.model, 300),
      messages: windowed.messages,
      stream: strict ? false : Boolean(body.stream),
      max_tokens: Math.round(clamp(maxFromEither, 1, strict ? 2048 : 4096, strict ? 1024 : 2048))
    };
    if (!strict) {
      if (body.temperature != null) output.temperature = clamp(body.temperature, 0, 2, 0.7);
      if (body.top_p != null) output.top_p = clamp(body.top_p, 0.1, 1, 0.7);
      if (body.top_k != null) output.top_k = clamp(body.top_k, 0, 50, 50);
      if (body.frequency_penalty != null) output.frequency_penalty = clamp(body.frequency_penalty, -2, 2, 0);
      if (body.min_p != null) output.min_p = clamp(body.min_p, 0, 1, 0.05);
      if (body.stop == null || typeof body.stop === 'string' || (Array.isArray(body.stop) && body.stop.length <= 4)) output.stop = body.stop ?? null;
      if (body.n != null) output.n = Math.max(1, Math.min(4, Math.round(Number(body.n) || 1)));
      if (typeof body.enable_thinking === 'boolean') output.enable_thinking = body.enable_thinking;
      if (output.enable_thinking && body.thinking_budget != null) output.thinking_budget = Math.max(1, Math.min(32768, Math.round(Number(body.thinking_budget) || 4096)));
      if (/deepseek-ai\/DeepSeek-V4-Flash/i.test(output.model) && ['high','max'].includes(body.reasoning_effort)) output.reasoning_effort = body.reasoning_effort;
      if (body.response_format && typeof body.response_format === 'object' && ['text','json_object'].includes(body.response_format.type)) output.response_format = { type:body.response_format.type };
      if (Array.isArray(body.tools) && body.tools.length) output.tools = body.tools.slice(0, 128);
      if (body.tool_choice != null && output.tools) output.tool_choice = body.tool_choice;
    } else {
      output.temperature = clamp(body.temperature, 0, 1, 0.7);
      output.top_p = clamp(body.top_p, 0.1, 1, 0.7);
    }
    if (!output.model) delete output.model;
    return {
      body:output,
      report:{
        provider:'siliconflow', strict, model:output.model || '', originalMessageCount:windowed.originalCount,
        finalMessageCount:windowed.finalCount, removedMessageCount:Math.max(0, windowed.originalCount - windowed.finalCount),
        requestKeys:Object.keys(output)
      }
    };
  }
  async function snapshot(input, init) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
    let method = String(init?.method || input?.method || 'GET').toUpperCase();
    let headers = new Headers(init?.headers || input?.headers || undefined);
    let bodyText = typeof init?.body === 'string' ? init.body : '';
    if (!bodyText && typeof Request !== 'undefined' && input instanceof Request && !['GET','HEAD'].includes(method)) {
      try { bodyText = await input.clone().text(); } catch (_) {}
    }
    return { url, method, headers, bodyText, isRequest:typeof Request !== 'undefined' && input instanceof Request, input, init };
  }
  function buildArgs(snap, body) {
    const text = JSON.stringify(body);
    const headers = new Headers(snap.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    if (snap.isRequest) return { input:new Request(snap.input, { headers, body:text, method:snap.method }), init:undefined };
    return { input:snap.input, init:Object.assign({}, snap.init || {}, { method:snap.method, headers, body:text }) };
  }
  async function readError(response) {
    if (!response?.clone) return { message:'', raw:null };
    try {
      const type = response.headers?.get?.('content-type') || '';
      if (/json/i.test(type)) {
        const raw = await response.clone().json();
        return { message:clean(raw?.message || raw?.error?.message || raw?.detail || '', 2000), raw };
      }
      const text = await response.clone().text();
      try { const raw = JSON.parse(text); return { message:clean(raw?.message || raw?.error?.message || text, 2000), raw }; }
      catch (_) { return { message:clean(text, 2000), raw:text }; }
    } catch (error) { return { message:clean(error?.message || error, 1000), raw:null }; }
  }
  function shouldStrictRetry(errorMessage) {
    const text = clean(errorMessage, 2000).toLowerCase();
    if (/api.?key|unauthor|permission|insufficient|balance|model.*(not exist|does not exist|invalid|access)/i.test(text)) return false;
    return true;
  }
  async function compatibleFetch(input, init) {
    const snap = await snapshot(input, init);
    if (!isSiliconFlow(snap.url) || !snap.bodyText) return previousFetch(input, init);
    let parsed;
    try { parsed = JSON.parse(snap.bodyText); } catch (_) { return previousFetch(input, init); }

    const first = sanitizeSiliconFlowBody(parsed, { strict:false });
    lastReport = Object.assign({ timestamp:Date.now(), url:snap.url }, first.report);
    if (first.report.removedMessageCount || JSON.stringify(first.body) !== JSON.stringify(parsed)) {
      emit('eve:provider-request-normalized', clone(lastReport));
    }
    let args = buildArgs(snap, first.body);
    let response = await previousFetch(args.input, args.init);
    if (Number(response?.status) !== 400) return response;

    const error = await readError(response);
    emit('eve:provider-http-error', {
      timestamp:Date.now(), provider:'siliconflow', url:snap.url, status:400, ok:false,
      model:first.body.model || '', message:error.message, error:error.raw,
      requestSummary:clone(first.report)
    });
    if (!shouldStrictRetry(error.message)) return response;

    const fallback = sanitizeSiliconFlowBody(parsed, { strict:true });
    args = buildArgs(snap, fallback.body);
    const retry = await previousFetch(args.input, args.init);
    const retryError = Number(retry?.status) >= 400 ? await readError(retry) : { message:'', raw:null };
    emit('eve:provider-compat-retry', {
      timestamp:Date.now(), provider:'siliconflow', url:snap.url, initialStatus:400,
      retryStatus:Number(retry?.status || 0), recovered:Boolean(retry?.ok), initialMessage:error.message,
      retryMessage:retryError.message, requestSummary:clone(fallback.report)
    });
    return retry;
  }
  function install() {
    if (installed || typeof window.fetch !== 'function') return false;
    previousFetch = window.fetch.bind(window);
    window.fetch = compatibleFetch;
    installed = true;
    emit('eve:provider-request-compat-ready', { version:VERSION });
    return true;
  }
  function restore() {
    if (installed && previousFetch) window.fetch = previousFetch;
    previousFetch = null; installed = false;
  }
  function diagnostics() { return { version:VERSION, installed, lastReport:clone(lastReport) }; }

  window.EVEProviderRequestCompat = Object.freeze({ version:VERSION, install, restore, diagnostics, sanitizeSiliconFlowBody, mergeAndWindowMessages });
  install();
})(window);
