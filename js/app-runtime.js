/**
 * EVE Chat App Runtime v1.3.4
 * Shared runtime helpers for the web build and the Capacitor iOS build.
 */
(function (window, document) {
  'use strict';

  if (window.EVEAppRuntime?.version) return;

  const VERSION = '1.3.4';
  const capacitor = window.Capacitor;
  const native = Boolean(capacitor?.isNativePlatform?.());
  const platform = native ? (capacitor.getPlatform?.() || 'native') : 'web';
  const FULLSCREEN_STYLE_ID = 'eve-native-layout-style';

  function installNativeLayoutStyle() {
    if (!native || document.getElementById(FULLSCREEN_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = FULLSCREEN_STYLE_ID;
    style.textContent = `
      html[data-eve-runtime="native"],
      html[data-eve-runtime="native"] body {
        width: 100%;
        height: 100%;
        min-height: 100%;
        margin: 0;
        padding: 0;
        overflow: hidden;
        background: #000;
      }
      html[data-eve-runtime="native"] #phone-screen {
        width: 100vw !important;
        height: 100vh !important;
        height: 100dvh !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        border: 0 !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        transform: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function markRuntime() {
    document.documentElement.dataset.eveRuntime = native ? 'native' : 'web';
    document.documentElement.dataset.evePlatform = platform;
    document.body?.classList?.toggle('eve-native-app', native);

    if (native) {
      document.body?.classList?.add('fullscreen-mode');
      document.getElementById('phone-screen')?.classList?.add('fullscreen-mode');
      installNativeLayoutStyle();
    }
  }

  async function unregisterServiceWorkersInNative() {
    if (!native || !navigator.serviceWorker?.getRegistrations) return 0;
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
      return registrations.length;
    } catch (error) {
      console.warn('[EVEAppRuntime] 无法清理 Service Worker', error);
      return 0;
    }
  }

  async function requestPersistentStorage() {
    if (!navigator.storage?.persist) return false;
    try {
      if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    } catch (_) {
      return false;
    }
  }

  function diagnostics() {
    return {
      version: VERSION,
      native,
      platform,
      protocol: location.protocol,
      capacitorAvailable: Boolean(capacitor),
      capacitorHttpPatched: Boolean(capacitor?.isPluginAvailable?.('CapacitorHttp')),
      serviceWorkerAvailable: 'serviceWorker' in navigator,
      indexedDBAvailable: 'indexedDB' in window,
      fullscreenApplied: Boolean(document.getElementById('phone-screen')?.classList?.contains('fullscreen-mode'))
    };
  }

  async function init() {
    markRuntime();
    await requestPersistentStorage();
    await unregisterServiceWorkersInNative();
    window.dispatchEvent(new CustomEvent('eve:app-runtime-ready', { detail: diagnostics() }));
    return diagnostics();
  }

  window.EVEAppRuntime = Object.freeze({
    version: VERSION,
    native,
    platform,
    init,
    diagnostics,
    requestPersistentStorage,
    unregisterServiceWorkersInNative
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(window, document);
