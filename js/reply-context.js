/**
 * EVE Chat Reply Context Fix v1.1.1
 *
 * Fixes a legacy gap where the quoted message is rendered in the bubble,
 * but is not reliably included in the next AI request.
 */
(function (window, document) {
  'use strict';
  if (window.EVEReplyContext?.version) return;

  const VERSION = '1.1.1';
  const TTL_MS = 3 * 60 * 1000;
  let pending = null;
  let initialized = false;
  let adapterBound = false;
  let observer = null;
  const disposers = [];

  function clean(value, max = 5000) {
    return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, max);
  }
  function clone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }
  function visible(node) {
    if (!node) return false;
    const style = window.getComputedStyle?.(node);
    return style ? style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 : true;
  }
  function currentScope() {
    return window.EVEAdapter?.getCurrentChat?.().scope || 'global';
  }
  function findText(root, selectors) {
    for (const selector of selectors) {
      const node = root?.querySelector?.(selector);
      const value = clean(node?.textContent, 3000);
      if (value) return value;
    }
    return '';
  }
  function findMessageId(root) {
    if (!root) return '';
    const candidates = [
      root.dataset?.replyToMessageId,
      root.dataset?.replyToId,
      root.dataset?.targetMessageId,
      root.dataset?.messageId,
      root.getAttribute?.('data-reply-to-message-id'),
      root.getAttribute?.('data-reply-to-id'),
      root.getAttribute?.('data-target-message-id')
    ];
    for (const value of candidates) if (clean(value, 200)) return clean(value, 200);
    const button = root.querySelector?.('[onclick*="jump"],[onclick*="Message"],[data-message-id]');
    const datasetId = clean(button?.dataset?.messageId || button?.getAttribute?.('data-message-id'), 200);
    if (datasetId) return datasetId;
    const onclick = String(button?.getAttribute?.('onclick') || '');
    const match = onclick.match(/["']([^"']{5,})["']/);
    return clean(match?.[1], 200);
  }

  function quoteFromPreview() {
    const previews = [...document.querySelectorAll('.reply-preview')].filter(visible);
    const preview = previews.at(-1);
    if (!preview) return null;
    const text = findText(preview, ['.reply-preview-message', '.reply-preview-text', '[data-reply-message]']);
    if (!text) return null;
    return {
      targetText: text,
      targetSender: findText(preview, ['.reply-preview-sender', '[data-reply-sender]']) || '角色',
      targetMessageId: findMessageId(preview),
      source: 'input-preview'
    };
  }

  function quoteFromMessageElement(element) {
    if (!element?.querySelector) return null;
    const reference = element.querySelector('.reply-reference');
    if (!reference) return null;
    const text = findText(reference, ['.reply-reference-message', '.reply-reference-content', '[data-reply-message]']);
    if (!text) return null;
    return {
      targetText: text,
      targetSender: findText(reference, ['.reply-reference-sender', '[data-reply-sender]']) || '角色',
      targetMessageId: findMessageId(reference),
      source: 'committed-message'
    };
  }

  function setPending(detail = {}) {
    const targetText = clean(detail.targetText, 3000);
    if (!targetText) return null;
    pending = {
      targetText,
      targetSender: clean(detail.targetSender, 100) || '角色',
      targetMessageId: clean(detail.targetMessageId, 200),
      userText: clean(detail.userText, 5000),
      scope: clean(detail.scope, 300) || currentScope(),
      source: clean(detail.source, 100) || 'manual',
      capturedAt: Date.now(),
      lastAppliedAt: 0,
      appliedRequestId: null
    };
    window.dispatchEvent(new CustomEvent('eve:reply-context-captured', { detail: clone(pending) }));
    return clone(pending);
  }
  function clear(reason = 'cleared') {
    if (!pending) return;
    const previous = clone(pending);
    pending = null;
    window.dispatchEvent(new CustomEvent('eve:reply-context-cleared', { detail: { reason, previous } }));
  }
  function isExpired() {
    return !pending || Date.now() - pending.capturedAt > TTL_MS;
  }
  function getPending() {
    if (isExpired()) { clear('expired'); return null; }
    return clone(pending);
  }

  function promptContext(meta = {}) {
    const item = getPending();
    if (!item) return '';
    const chatScope = clean(meta.chat?.scope, 300) || currentScope();
    if (item.scope && chatScope && item.scope !== chatScope) return '';
    const latest = clean(meta.userText, 5000);
    if (item.userText && latest && latest !== item.userText && !latest.includes(item.userText) && !item.userText.includes(latest)) return '';
    pending.lastAppliedAt = Date.now();
    return [
      '【当前用户消息的明确引用｜本轮优先理解】',
      `用户的最新消息是在直接回复${item.targetSender || '角色'}此前的这句话：`,
      `「${item.targetText}」`,
      item.userText || latest ? `用户的新消息是：「${item.userText || latest}」` : '',
      item.targetMessageId ? `被引用消息ID：${item.targetMessageId}` : '',
      '请先结合被引用原文理解“这、那、做不到、为什么、吓人”等指代，再回应用户',
      '不要忽略引用，不要把被引用原文误认为用户刚刚说的话，也不要只对用户的新消息做脱离上下文的字面回应'
    ].filter(Boolean).join('\n');
  }

  function captureBeforeSend() {
    const quote = quoteFromPreview();
    if (!quote) return;
    const input = document.getElementById('api-chat-input');
    setPending({
      ...quote,
      userText: clean(input?.value, 5000),
      scope: currentScope()
    });
  }

  function userTextFromElement(element, fallback = '') {
    if (!element?.querySelector) return clean(fallback, 5000);
    const target = element.querySelector('.message-bubble,.message-content,.message-text') || element;
    const copy = target.cloneNode(true);
    copy.querySelectorAll?.('.reply-reference,.message-actions,.message-action-bar,.timestamp,.message-time,button').forEach(node => node.remove());
    return clean(copy.textContent || fallback, 5000);
  }

  function handleCommitted(event) {
    const detail = event.detail || {};
    if (detail.sender !== 'user') return;
    const quote = quoteFromMessageElement(detail.element);
    if (!quote) return;
    setPending({
      ...quote,
      userText: userTextFromElement(detail.element, detail.text),
      scope: detail.scope || detail.chat?.scope || currentScope()
    });
  }

  function bindAdapter() {
    if (adapterBound || !window.EVEAdapter?.registerContextProvider) return false;
    window.EVEAdapter.registerContextProvider('reply-context', promptContext, { priority: 2 });
    adapterBound = true;
    return true;
  }

  function installEvents() {
    const click = event => {
      const button = event.target?.closest?.('button');
      if (!button) return;
      const onclick = String(button.getAttribute('onclick') || '');
      if (/handleSendButtonClick|sendApiMessage|sendMessage/i.test(onclick) || button.matches('.send-button,.send-btn,.chat-send-btn,[title*="发送"],[aria-label*="发送"]')) captureBeforeSend();
    };
    const keydown = event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target?.id === 'api-chat-input') captureBeforeSend();
    };
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('eve:user-message-committed', handleCommitted);
    const onRequest = event => {
      if (pending?.lastAppliedAt) pending.appliedRequestId = event.detail?.requestId ?? null;
    };
    const onFinish = event => {
      if (!pending?.lastAppliedAt) return;
      const requestId = event.detail?.requestId ?? null;
      if (pending.appliedRequestId == null || requestId == null || String(pending.appliedRequestId) === String(requestId)) clear('request-finished');
    };
    window.addEventListener('eve:ai-request', onRequest);
    window.addEventListener('eve:ai-response', onFinish);
    window.addEventListener('eve:ai-error', onFinish);
    disposers.push(
      () => document.removeEventListener('click', click, true),
      () => document.removeEventListener('keydown', keydown, true),
      () => window.removeEventListener('eve:user-message-committed', handleCommitted),
      () => window.removeEventListener('eve:ai-request', onRequest),
      () => window.removeEventListener('eve:ai-response', onFinish),
      () => window.removeEventListener('eve:ai-error', onFinish)
    );
  }

  function installObserver() {
    observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const candidates = node.matches?.('[data-message-id]') ? [node] : [...(node.querySelectorAll?.('[data-message-id]') || [])];
        for (const element of candidates) {
          const isUser = element.matches?.('.sent,.my-message,.user-message,[data-sender="user"],[data-role="user"]');
          if (!isUser) continue;
          const quote = quoteFromMessageElement(element);
          if (!quote) continue;
          const textNode = element.querySelector('.message-bubble,.message-content,.message-text') || element;
          const copy = textNode.cloneNode(true);
          copy.querySelectorAll?.('.reply-reference,.message-actions,.timestamp,button').forEach(node => node.remove());
          setPending({ ...quote, userText:clean(copy.textContent, 5000), scope:currentScope() });
        }
      }
    });
    observer.observe(document.body, { childList:true, subtree:true });
  }

  function diagnostics() {
    return { version:VERSION, initialized, adapterBound, pending:getPending() };
  }
  function init() {
    if (initialized) return Promise.resolve(diagnostics());
    initialized = true;
    installEvents();
    installObserver();
    if (!bindAdapter()) {
      const timer = setInterval(() => { if (bindAdapter()) clearInterval(timer); }, 500);
      disposers.push(() => clearInterval(timer));
    }
    window.EVE ||= {};
    window.EVE.replyContext = window.EVEReplyContext;
    window.dispatchEvent(new CustomEvent('eve:reply-context-ready', { detail:diagnostics() }));
    return Promise.resolve(diagnostics());
  }
  function destroy() {
    disposers.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
    observer?.disconnect(); observer = null;
    clear('destroy');
    initialized = false;
  }

  window.EVEReplyContext = Object.freeze({
    version:VERSION, init, destroy, setPending, clear, getPending,
    getPromptContext:promptContext, getDiagnostics:diagnostics,
    captureFromPreview:captureBeforeSend
  });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
