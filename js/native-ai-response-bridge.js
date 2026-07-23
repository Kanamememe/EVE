/**
 * EVE Native AI Response Bridge v1.5.5
 * CapacitorHttp's patched fetch response is native-backed. EVE reads/clones one
 * AI response several times (diagnostics, recovery, output transforms and the
 * legacy chat parser). On iOS this can leave the final consumer with an empty
 * or already-consumed body. Buffer once, then rebuild a normal Web Response.
 */
(function (window) {
  'use strict';
  if (window.EVENativeAIResponseBridge?.version) return;

  const VERSION = '1.5.5';
  const MARK = Symbol('eveReusableAIResponse');

  function isNative() {
    try { return Boolean(window.Capacitor?.isNativePlatform?.()); }
    catch (_) { return false; }
  }

  function isMarked(response) {
    try { return Boolean(response?.[MARK] || response?.__eveReusableAIResponse); }
    catch (_) { return false; }
  }

  function copyHeaders(source) {
    const headers = new Headers();
    try {
      if (source?.forEach) source.forEach((value, key) => headers.set(key, value));
      else if (source && typeof source === 'object') {
        for (const [key, value] of Object.entries(source)) headers.set(key, String(value));
      }
    } catch (_) {}
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.delete('transfer-encoding');
    return headers;
  }

  function inferContentType(headers, text) {
    if (headers.get('content-type')) return;
    const trimmed = String(text || '').trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      headers.set('content-type', 'application/json; charset=utf-8');
    } else {
      headers.set('content-type', 'text/plain; charset=utf-8');
    }
  }

  async function readBody(response) {
    if (typeof response?.text === 'function') {
      try { return await response.text(); } catch (_) {}
    }
    if (typeof response?.json === 'function') {
      try { return JSON.stringify(await response.json()); } catch (_) {}
    }
    if (response && 'data' in response) {
      return typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? null);
    }
    throw new Error('无法读取原生AI响应内容');
  }

  async function stabilize(response, meta = {}) {
    if (!response || isMarked(response) || !isNative()) return response;
    if (typeof window.Response !== 'function') return response;

    let text;
    try { text = await readBody(response); }
    catch (error) {
      try {
        window.dispatchEvent(new CustomEvent('eve:native-ai-response-buffer-error', {
          detail: { url: String(meta.url || ''), message: String(error?.message || error) }
        }));
      } catch (_) {}
      return response;
    }

    const statusValue = Number(response.status);
    const status = Number.isFinite(statusValue) && statusValue >= 200 && statusValue <= 599 ? statusValue : 200;
    const headers = copyHeaders(response.headers);
    inferContentType(headers, text);
    const noBody = [204, 205, 304].includes(status);
    const rebuilt = new Response(noBody ? null : text, {
      status,
      statusText: String(response.statusText || ''),
      headers
    });
    try { Object.defineProperty(rebuilt, MARK, { value: true }); } catch (_) {}
    try { Object.defineProperty(rebuilt, '__eveReusableAIResponse', { value: true }); } catch (_) {}
    try { Object.defineProperty(rebuilt, '__eveNativeBuffered', { value: true }); } catch (_) {}

    try {
      window.dispatchEvent(new CustomEvent('eve:native-ai-response-buffered', {
        detail: { url: String(meta.url || ''), status, length: text.length }
      }));
    } catch (_) {}
    return rebuilt;
  }

  window.EVENativeAIResponseBridge = Object.freeze({
    version: VERSION,
    isNative,
    stabilize,
    isMarked
  });
})(window);
