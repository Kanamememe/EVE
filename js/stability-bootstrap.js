/** EVE App Stability Bootstrap v1.5.4 */
(function (window, document) {
  'use strict';
  if (window.EVEStability?.version === '1.5.4') return;
  const VERSION = '1.5.4';
  const required = [
    ['EVECriticalModules', 'js/eve-critical-modules.js?v=1.5.4'],
    ['EVEDailySchedule', 'plugins/daily-schedule/core.js?v=1.5.4'],
    ['EVEDailyScheduleApp', 'plugins/daily-schedule/app.js?v=1.5.4'],
    ['EVEDiary', 'plugins/diary/core.js?v=1.5.4'],
    ['EVEDiaryApp', 'plugins/diary/app.js?v=1.5.4'],
    ['EVERoleFidelity', 'plugins/role-fidelity/core.js?v=1.5.4'],
    ['EVERoleFidelityUI', 'plugins/role-fidelity/ui.js?v=1.5.4'],
    ['EVEMemoryInbox', 'plugins/memory-inbox/core.js?v=1.5.4'],
    ['EVEHomeApps', 'js/home-app-registry.js?v=1.5.4'],
    ['EVEFeatureSettings', 'js/feature-settings.js?v=1.5.4']
  ];  const pending = new Map();

  function load(globalName, src) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (pending.has(globalName)) return pending.get(globalName);
    const promise = new Promise(resolve => {
      const script = document.createElement('script');
      script.src = src.includes('?') ? `${src}&bootstrap=${Date.now()}` : `${src}?bootstrap=${Date.now()}`;
      script.async = false;
      script.onload = () => setTimeout(() => resolve(window[globalName] || null), 0);
      script.onerror = () => resolve(null);
      document.body.appendChild(script);
    }).finally(() => pending.delete(globalName));
    pending.set(globalName, promise);
    return promise;
  }

  async function repair() {
    const before = diagnostics();
    for (const [name, src] of required) {
      if (!window[name]) await load(name, src);
    }
    try { window.EVECriticalModules?.repair?.(); } catch (_) {}
    try { window.EVEHomeApps?.init?.(); window.EVEHomeApps?.repair?.(); } catch (_) {}
    try { window.EVEFeatureSettings?.init?.(); window.EVEFeatureSettings?.inject?.(); } catch (_) {}
    return { before, after:diagnostics() };
  }

  function diagnostics() {
    return {
      version:VERSION,
      modules:Object.fromEntries(required.map(([name]) => [name, Boolean(window[name])])),
      scheduleIcon:Boolean(document.getElementById('eve-schedule-home-app')),
      diaryIcon:Boolean(document.getElementById('eve-diary-home-app')),
      scheduleScreen:Boolean(document.getElementById('eve-schedule-screen')),
      diaryScreen:Boolean(document.getElementById('eve-diary-screen')),
      extensionSettings:Boolean(document.getElementById('eve-extension-settings-section')),
      roleSetting:Boolean(document.getElementById('eve-role-fidelity-setting-item'))
    };
  }

  function init() {
    setTimeout(repair, 50);
    setTimeout(repair, 800);
    window.addEventListener('pageshow', () => repair());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) repair(); });
    return diagnostics();
  }

  window.EVEStability = Object.freeze({ version:VERSION, init, repair, diagnostics });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
