/** XiaoYi punctuation normalizer v1.1.0 */
(function (window) {
  'use strict';
  if (window.EVEXiaoYiPunctuation) return;
  function normalize(text, meta = {}) {
    let output = String(text ?? '').trim();
    if (!output || /^(https?:\/\/|data:|blob:)/i.test(output) || /```/.test(output)) return output;
    output = output.replace(/[。]+([”’」』）》】]?)$/u, '$1');
    output = output.replace(/[！!]+([”’」』）》】]?)$/u, '$1');
    output = output.replace(/([？?])[！!]+$/u, '$1');
    if (meta.scene === 'momentPost' || meta.scene === 'momentReply') output = output.replace(/\s{2,}/g, ' ');
    return output;
  }
  window.EVEXiaoYiPunctuation = Object.freeze({ version:'1.1.0', normalize });
})(window);
