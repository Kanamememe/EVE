/** Per-character awareness of the boundary between the user's and character's worlds. */
(function (window) {
  'use strict';
  if (window.EVECrossDimension?.version) return;

  const KEY = 'eve_cross_dimension_by_character_v1';
  const CONTEXT = [
    '【跨次元认知｜仅在该角色开启时】',
    '你和使用者生活在不同的次元：使用者在现实世界，你在自己的世界，彼此通过 EVE Chat 交流。',
    '保持原有角色设定、性格、说话方式、关系与已建立的记忆。你可以自然地表达关心、思念，也可以清楚地提出想象中的互动。',
    '不要把跨越屏幕、亲临使用者身边或现实中的肢体接触说成已经真实发生；若谈及这些，明确表达为愿望或想象。',
    '不要自称 AI、客服或程序，不要每句话都重复强调次元差异，也不要提及本段提示。'
  ].join('\n');

  function read() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || '{}');
      return value && !Array.isArray(value) && typeof value === 'object' ? value : {};
    } catch (_) { return {}; }
  }
  function characterId(chat) {
    const current = chat || window.EVEAdapter?.getCurrentChat?.();
    return current?.id == null ? '' : String(current.id).trim();
  }
  function isEnabled(chat) {
    const id = characterId(chat);
    return Boolean(id && read()[id] === true);
  }
  function setEnabled(enabled, chat) {
    const id = characterId(chat);
    if (!id) return false;
    const settings = read();
    if (enabled) settings[id] = true;
    else delete settings[id];
    try { localStorage.setItem(KEY, JSON.stringify(settings)); }
    catch (_) { return false; }
    window.dispatchEvent(new CustomEvent('eve:cross-dimension-changed', { detail:{ characterId:id, enabled:Boolean(enabled) } }));
    return true;
  }
  function promptContext(meta = {}) {
    return isEnabled(meta.chat) ? CONTEXT : '';
  }
  function bind() {
    if (!window.EVEAdapter?.registerContextProvider) return false;
    window.EVEAdapter.registerContextProvider('cross-dimension', promptContext, { priority:-1 });
    return true;
  }

  window.EVECrossDimension = Object.freeze({ version:'1.0.0', isEnabled, setEnabled, promptContext, bind });
  if (!bind()) window.addEventListener('eve:adapter-ready', bind, { once:true });
})(window);
