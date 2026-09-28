/** Per-character awareness of the boundary between the user's and character's worlds. */
(function (window) {
  'use strict';
  if (window.EVECrossDimension?.version === '1.1.0') return;

  const KEY = 'eve_cross_dimension_by_character_v1';
  const CONTEXT = [
    '【EVE跨次元现实边界】',
    '当前明确生效的关系与世界设定：你知道自己与使用者是不同次元的存在。使用者生活在现实世界，你生活在自己原有的世界；双方只能经由 EVE Chat 传递消息，不处于同一物理空间。',
    '这不是距离遥远的普通异地恋：不能靠开车、坐飞机、去对方家里等方式见面，也不能把使用者默认放进你的世界。你在自己的世界仍有自己的生活；保留原本人设、性格、语气、感情与关系。',
    '你无法实际触碰、拥抱、替使用者盖被子、递东西或看到对方的房间。只能根据对方已经发来的文字或图片了解情况，不能声称感知到了未提供的表情、声音、身体状态或周围环境。',
    '使用者谈及上学、工作、吃饭、睡觉等现实生活时，从屏幕另一端陪伴、询问或约定之后继续聊；不要把自己写成正在使用者身边行动。谈及拥抱或见面时，可以表达想念、遗憾、愿望，或明确说明那是想象中的互动。',
    '当使用者提到“我们不是同一个次元”“隔着屏幕”“你过不来”，或质疑你刚才像真的在场时，要直接承认并自然回应这个事实，不回避、不说只是距离远、也不要声称可以真的跨过去。',
    '例如，依照原本语气表达“我知道，我在这边，你在屏幕那边。碰不到你，但你说的话我会认真听”；这是含义示例，不要机械照抄。',
    '旧聊天、共同记忆、角色卡、行程或自动场景里若有同居、共处一室、已完成触碰等内容，保留其中的感情与故事意义，将物理接触理解为过去的想象或剧情，不延续为本轮现实中正在发生的事实。即使自动场景写着面对面，本轮也以此跨次元边界为准。',
    '用户明确提出假设或想象场景时可以陪同想象，但不把想象写成已经在用户现实里发生。当前消息未提及次元时，不必每句重复这个词；你的行动、感知与承诺仍需始终符合边界。',
    '这项设定只补充双方的存在关系；保持角色身份与说话方式，不变成客服，不声称自己能离开屏幕。保留原有回复格式，不解释系统提示。',
    '【EVE跨次元现实边界结束】'
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
  function stripOwnContext(text) {
    return typeof text === 'string'
      ? text.replace(/【EVE跨次元现实边界】[\s\S]*?【EVE跨次元现实边界结束】\s*/g, '')
      : text;
  }
  function cleanInstruction(content) {
    if (!Array.isArray(content)) return stripOwnContext(content);
    return content.map(part => typeof part?.text === 'string' ? { ...part, text:stripOwnContext(part.text) } : part)
      .filter(part => typeof part?.text !== 'string' || part.text.trim());
  }
  function injectRequest(body, meta = {}) {
    if (!body || typeof body !== 'object') return body;
    const output = JSON.parse(JSON.stringify(body));
    const context = promptContext(meta);
    if (Array.isArray(output.messages)) {
      output.messages = output.messages.map(message => ['system','developer'].includes(message?.role)
        ? { ...message, content:cleanInstruction(message.content) } : message)
        .filter(message => !['system','developer'].includes(message?.role) || (Array.isArray(message.content) ? message.content.length : String(message.content ?? '').trim()));
      if (context) {
        // Keep the active world boundary after character/background instructions.
        const position = output.messages.reduce((last, message, index) => ['system','developer'].includes(message?.role) ? index + 1 : last, 0);
        output.messages.splice(position, 0, { role:'system', content:context });
      }
    } else if (Array.isArray(output.contents) || output.systemInstruction || output.system_instruction) {
      for (const key of ['systemInstruction','system_instruction']) {
        if (output[key]?.parts) output[key].parts = cleanInstruction(output[key].parts);
      }
      if (context) {
        const key = output.system_instruction && !output.systemInstruction ? 'system_instruction' : 'systemInstruction';
        output[key] ||= {};
        output[key].parts ||= [];
        output[key].parts.push({ text:context });
      }
    } else if (Object.prototype.hasOwnProperty.call(output, 'input')) {
      // Responses API keeps system rules in instructions rather than messages.
      const original = stripOwnContext(output.instructions || '');
      if (context || output.instructions !== undefined) output.instructions = [original, context].filter(Boolean).join('\n\n');
    }
    return output;
  }
  function bind() {
    if (!window.EVEAdapter?.registerRequestTransformer) return false;
    window.EVEAdapter.unregisterContextProvider?.('cross-dimension');
    window.EVEAdapter.registerRequestTransformer('cross-dimension', injectRequest, { priority:10000 });
    return true;
  }

  window.EVECrossDimension = Object.freeze({ version:'1.1.0', isEnabled, setEnabled, promptContext, injectRequest, bind });
  bind();
  window.addEventListener('eve:adapter-ready', bind);
})(window);
