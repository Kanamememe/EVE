/**
 * EVE Character Diary Core loader v1.5.7
 * The stable diary core is bundled in js/eve-critical-modules.js.
 * This file loads the post-core human diary writer for both web and Capacitor.
 */
(function (window, document) {
  'use strict';
  const VERSION = '1.5.7';

  function load(id, path, ready) {
    if (ready()) return true;
    if (document.getElementById(id)) return true;
    const script = document.createElement('script');
    script.id = id;
    script.src = new URL(`${path}?v=${VERSION}`, document.baseURI).href;
    script.async = false;
    script.dataset.eveModule = id;
    script.onerror = () => {
      console.error(`[EVEDiary] 模块载入失败：${path}`, script.src);
      try {
        window.dispatchEvent(new CustomEvent('eve:diary-humanizer-error', {
          detail:{ version:VERSION, src:script.src, module:path }
        }));
      } catch (_) {}
    };
    (document.head || document.documentElement).appendChild(script);
    return true;
  }

  function loadUpgrades() {
    load('eve-diary-humanizer-script', 'js/diary-humanizer.js', () => window.EVEDiaryHumanizer?.version === VERSION);
    load('eve-diary-humanizer-ui-script', 'js/diary-humanizer-ui.js', () => window.EVEDiaryHumanizerUI?.version === VERSION);
    window.EVEDiaryHumanizer?.install?.();
    window.EVEDiaryHumanizerUI?.install?.();
  }

  loadUpgrades();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadUpgrades, { once:true });
  }
})(window, document);
