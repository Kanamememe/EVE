/**
 * EVE Home App Registry v1.5.4
 * Owns the Schedule / Diary / Memory Inbox launchers and lazy-loads missing modules.
 */
(function (window, document) {
  'use strict';
  if (window.EVEHomeApps?.version === '1.5.4') return;

  const VERSION = '1.5.4';
  const GRID_ID = 'eve-home-feature-grid';
  const STYLE_ID = 'eve-home-app-registry-style';
  const loading = new Map();
  let initialized = false;
  let observer = null;
  let repairTimer = null;

  const apps = [
    {
      key: 'schedule', id: 'eve-schedule-home-app', label: '行程', global: 'EVEDailyScheduleApp',
      dependencies: [
        { global: 'EVEDailySchedule', src: 'plugins/daily-schedule/core.js?v=1.5.4' },
        { global: 'EVEDailyScheduleApp', src: 'plugins/daily-schedule/app.js?v=1.5.4' }
      ],
      icon: '<svg class="eve-home-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 18h3"></path></svg><span class="eve-home-app-badge" data-badge></span>'
    },
    {
      key: 'diary', id: 'eve-diary-home-app', label: '日记', global: 'EVEDiaryApp',
      dependencies: [
        { global: 'EVEDiary', src: 'plugins/diary/core.js?v=1.5.4' },
        { global: 'EVEDiaryApp', src: 'plugins/diary/app.js?v=1.5.4' }
      ],
      icon: '<svg class="eve-home-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h12a2 2 0 0 1 2 2v16H7a2 2 0 0 1-2-2V3z"></path><path d="M8 3v18M11 8h5M11 12h5M11 16h4"></path></svg>'
    },
    {
      key: 'memory-inbox', id: 'eve-memory-inbox-home-app', label: '待确认', global: 'EVEMemoryInbox',
      dependencies: [
        { global: 'EVEMemoryInbox', src: 'plugins/memory-inbox/core.js?v=1.5.4' }
      ],
      icon: '<svg class="eve-home-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4z"></path><path d="M4 14h4l2 3h4l2-3h4"></path></svg><span class="eve-memory-inbox-badge" data-badge></span>'
    }
  ];

  function toast(message, type = 'error') {
    try { if (typeof window.showToast === 'function') return window.showToast(message, type); } catch (_) {}
    console.warn('[EVEHomeApps]', message);
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .home-section.top-right .eve-home-feature-grid{
        display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;
        grid-template-rows:repeat(2,minmax(0,1fr))!important;gap:4px 7px!important;
        width:100%!important;height:100%!important;padding:1px!important;
        align-items:center!important;justify-items:center!important;overflow:visible!important;
      }
      .home-section.top-right .eve-home-feature-grid .mini-app{
        display:flex!important;min-width:0!important;min-height:0!important;width:100%!important;
        height:100%!important;visibility:visible!important;opacity:1!important;font-size:9px!important;
        line-height:1.05!important;touch-action:manipulation!important;-webkit-tap-highlight-color:transparent;
      }
      .home-section.top-right .eve-home-feature-grid .mini-app-icon{
        width:36px!important;height:36px!important;border-radius:11px!important;margin-bottom:1px!important;position:relative!important;
      }
      .eve-home-svg{width:23px!important;height:23px!important;display:block!important;fill:none!important;
        stroke:var(--color-gray-dark,#333)!important;stroke-width:1.8!important;stroke-linecap:round!important;
        stroke-linejoin:round!important;pointer-events:none!important;}
    `;
    document.head.appendChild(style);
  }

  function getGrid() {
    const topRight = document.querySelector('#home-grid .home-section.top-right');
    if (!topRight) return null;
    let grid = topRight.querySelector(`#${GRID_ID}, .eve-home-feature-grid, .apps-grid-2, .apps-grid, .eve-apps-grid-4, .eve-apps-grid-6`);
    if (!grid) { grid = document.createElement('div'); topRight.appendChild(grid); }
    grid.id = GRID_ID;
    grid.classList.remove('apps-grid-2', 'apps-grid', 'eve-apps-grid-4', 'eve-apps-grid-6');
    grid.classList.add('eve-home-feature-grid');
    return grid;
  }

  function createLauncher(app) {
    const link = document.createElement('a');
    link.href = '#'; link.className = 'mini-app'; link.id = app.id;
    link.dataset.eveHomeApp = app.key;
    link.innerHTML = `<div class="mini-app-icon">${app.icon}</div><span>${app.label}</span>`;
    return link;
  }

  function ensureLauncher(grid, app) {
    let element = document.getElementById(app.id);
    if (!element) { element = createLauncher(app); grid.appendChild(element); }
    else if (element.parentElement !== grid) grid.appendChild(element);
    element.classList.add('mini-app');
    element.dataset.eveHomeApp = app.key;
    element.removeAttribute('onclick');
    element.style.removeProperty('display');
    element.style.removeProperty('visibility');
    element.style.removeProperty('opacity');
    if (!element.querySelector('.mini-app-icon') || !element.querySelector('.eve-home-svg')) {
      element.innerHTML = `<div class="mini-app-icon">${app.icon}</div><span>${app.label}</span>`;
    }
    return element;
  }

  function waitForGlobal(name, timeout = 2500) {
    return new Promise(resolve => {
      if (window[name]) return resolve(window[name]);
      const started = Date.now();
      const timer = setInterval(() => {
        if (window[name] || Date.now() - started >= timeout) {
          clearInterval(timer); resolve(window[name] || null);
        }
      }, 40);
    });
  }

  function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    const key = `${globalName}:${src}`;
    if (loading.has(key)) return loading.get(key);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src.includes('?') ? `${src}&repair=${Date.now()}` : `${src}?repair=${Date.now()}`;
      script.async = false;
      script.onload = async () => resolve(await waitForGlobal(globalName));
      script.onerror = () => reject(new Error(`无法载入 ${src}`));
      document.body.appendChild(script);
    }).finally(() => loading.delete(key));
    loading.set(key, promise);
    return promise;
  }

  async function ensureCriticalBundle() {
    if (!window.EVECriticalModules) await loadScript('js/eve-critical-modules.js?v=1.5.4', 'EVECriticalModules');
    try { window.EVECriticalModules?.repair?.(); } catch (_) {}
    return window.EVECriticalModules || null;
  }

  async function ensureModule(app) {
    await ensureCriticalBundle();
    if (window[app.global]) return window[app.global];
    for (const dep of app.dependencies) {
      if (!window[dep.global]) await loadScript(dep.src, dep.global);
    }
    try { window.EVECriticalModules?.repair?.(); } catch (_) {}
    return window[app.global] || null;
  }

  async function openApp(key) {
    const app = apps.find(item => item.key === key);
    if (!app) return false;
    try {
      const moduleApi = await ensureModule(app);
      if (!moduleApi?.open) throw new Error(`${app.label}模块没有可用入口`);
      const result = await moduleApi.open();
      if (result === false) throw new Error(`${app.label}模块尚未准备好`);
      return true;
    } catch (error) {
      console.error(`[EVEHomeApps] ${app.label}打开失败`, error);
      toast(`${app.label}模块载入失败：${error?.message||error}`, 'error');
      return false;
    }
  }

  function bindGrid(grid) {
    if (grid.dataset.eveRegistryBound === VERSION) return;
    grid.dataset.eveRegistryBound = VERSION;
    grid.addEventListener('click', event => {
      const launcher = event.target.closest('[data-eve-home-app]');
      if (!launcher || !grid.contains(launcher)) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      openApp(launcher.dataset.eveHomeApp);
    }, true);
  }

  function repair() {
    ensureStyle();
    const grid = getGrid();
    if (!grid) return false;
    bindGrid(grid);
    apps.forEach(app => ensureLauncher(grid, app));
    apps.forEach(app => { const element = document.getElementById(app.id); if (element) grid.appendChild(element); });
    try { window.EVEDailyScheduleApp?.updateBadge?.(); } catch (_) {}
    try { window.EVEMemoryInbox?.updateBadge?.(); } catch (_) {}
    return true;
  }

  function scheduleRepair() { clearTimeout(repairTimer); repairTimer = setTimeout(repair, 40); }

  function diagnostics() {
    const grid = getGrid();
    return {
      version: VERSION, initialized, grid: Boolean(grid),
      launchers: apps.map(app => ({ key:app.key, present:Boolean(document.getElementById(app.id)), module:Boolean(window[app.global]) })),
      featureSettings: Boolean(window.EVEFeatureSettings), extensionSection: Boolean(document.getElementById('eve-extension-settings-section'))
    };
  }

  function init() {
    if (initialized) return diagnostics();
    initialized = true; repair();
    const home = document.getElementById('home-grid');
    if (home && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(scheduleRepair);
      observer.observe(home, { childList:true, subtree:true });
    }
    ['pageshow','eve:schedule-app-ready','eve:diary-ready','eve:memory-inbox-ready','eve:adapter-ready'].forEach(name => window.addEventListener(name, scheduleRepair));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRepair(); });
    setTimeout(repair, 250); setTimeout(repair, 1000);
    window.EVE ||= {}; window.EVE.homeApps = window.EVEHomeApps;
    return diagnostics();
  }

  function destroy() { observer?.disconnect(); observer=null; clearTimeout(repairTimer); initialized=false; }

  window.EVEHomeApps = Object.freeze({ version:VERSION, handlesClicks:true, init, repair, openApp, diagnostics, destroy });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
