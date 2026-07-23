/**
 * EVE Character Diary Core loader v1.5.7
 * The stable diary core is bundled in js/eve-critical-modules.js.
 * This file loads the post-core human diary writer for both web and Capacitor.
 */
(function (window, document) {
  'use strict';
  const VERSION = '1.5.7';
  const ID = 'eve-diary-humanizer-script';

  function loadHumanizer() {
    if (window.EVEDiaryHumanizer?.version === VERSION) {
      window.EVEDiaryHumanizer.install?.();
      return true;
    }
    if (document.getElementById(ID)) return true;
    const script = document.createElement('script');
    script.id = ID;
    script.src = new URL(`js/diary-humanizer.js?v=${VERSION}`, document.baseURI).href;
    script.async = false;
    script.dataset.eveModule = 'diary-humanizer';
    script.onerror = () => {
      console.error('[EVEDiary] 日记自然写作模块载入失败：', script.src);
      try {
        window.dispatchEvent(new CustomEvent('eve:diary-humanizer-error', {
          detail:{ version:VERSION, src:script.src }
        }));
      } catch (_) {}
    };
    (document.head || document.documentElement).appendChild(script);
    return true;
  }

  loadHumanizer();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadHumanizer, { once:true });
  }
})(window, document);
