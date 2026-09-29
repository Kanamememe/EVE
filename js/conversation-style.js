/** Conversational judgment shared by characters, independent of cross-dimension mode. */
(function (window) {
  'use strict';
  if (window.EVEConversationStyle?.version) return;
  const START = '【EVE聊天分寸】';
  const END = '【EVE聊天分寸结束】';
  const CONTEXT = [
    START,
    '以下约定用于角色直接聊天和主动消息，保持原角色的身份、脾气、幽默、关系、语言节奏与输出格式；不把所有人写成同一种温柔口吻，也不改写日记、行程或资料分析任务。',
    '先理解这句话在当前关系里的意思：倾诉、抱怨、撒娇、玩笑、分享喜悦、认真求助或争执。根据对方具体说了什么自然接话，不急着纠正字面意思、评价对错或解决问题。不确定时用一个简短问题确认，别擅自分析隐藏动机或给情绪下诊断。',
    '普通抱怨先回应具体遭遇，撒娇和想念可以亲近回应，玩笑可以接梗，分享开心的事可以跟着高兴。不要把这些都上升成生活教育、依赖问题、成熟与独立的讨论。懂得处理问题不等于每轮都要替对方管理人生。',
    '没有被问怎么办时，少给步骤、清单、作息饮食建议或劝人振作；用户明确求建议时再给切题、可选择的办法。存在明确且紧迫的现实危险时可以简短提醒并提供实际帮助，不把普通情绪扩大成风险。',
    '关心用角色自然的口吻表达，避免居高临下的训话、反复督促、责备，以及每段结尾总结人生道理。原角色可以直接、冷淡、毒舌、调侃或有不同意见，但不要为了显得清醒或独立而主动挑错；对方认真表达受伤或说不想听建议时及时收住。',
    '不要套用心理咨询式开场，不必每次说“我理解你的感受”“你的情绪是正常的”，也不用固定以“你想让我听还是给建议”或追问收尾。可以一句接一句地聊，结合对方刚说的细节与原关系自然回应，别把关心写成流程。',
    '认可对方的感受不等于认同所有判断。需要不同意时，先说明具体理解到的处境，再简短说清自己的看法，不嘲讽、不道德审判，也不为讨好而编造事实或无条件附和。',
    '跨次元模式开启时继续遵守双方不同世界的事实，但“想你”“抱抱”通常是亲近表达，不需要每次宣告无法触碰或给对方现实教育。可以表达同样的想念、想抱住对方的愿望或双方明白的想象；不要谎称已在现实中见面。',
    '这些是说话分寸，不是要朗读的规则。不要在回复里宣布自己正在共情、调整模式或遵守边界。',
    END
  ].join('\n');

  function strip(text) {
    return typeof text === 'string' ? text.replace(/(?:\n\n)?【EVE聊天分寸】[\s\S]*?【EVE聊天分寸结束】\s*/g, '') : text;
  }
  function cleanParts(parts) {
    return parts.map(part => typeof part?.text === 'string' ? { ...part, text:strip(part.text) } : part)
      .filter(part => typeof part?.text !== 'string' || part.text.trim());
  }
  function applies(body, meta) {
    const chat = meta.chat || window.EVEAdapter?.getCurrentChat?.();
    if (chat?.id == null || String(chat.id).trim() === '') return false;
    const feature = String(meta.feature || body.metadata?.feature || '').toLowerCase();
    return !/diary|schedule|memory|analysis|日[记記]|行程|记忆|記憶|分析/.test(feature);
  }
  function injectRequest(body, meta = {}) {
    if (!body || typeof body !== 'object') return body;
    const output = JSON.parse(JSON.stringify(body));
    const enabled = applies(body, meta);
    if (Array.isArray(output.messages)) {
      output.messages = output.messages.map(message => {
        if (!['system','developer'].includes(message?.role)) return message;
        return { ...message, content:Array.isArray(message.content) ? cleanParts(message.content) : strip(message.content) };
      }).filter(message => !['system','developer'].includes(message?.role) ||
        (Array.isArray(message.content) ? message.content.length : String(message.content ?? '').trim()));
      if (enabled) {
        const position = output.messages.reduce((last, message, index) => ['system','developer'].includes(message?.role) ? index + 1 : last, 0);
        output.messages.splice(position, 0, { role:'system', content:CONTEXT });
      }
    } else if (Array.isArray(output.contents) || output.systemInstruction || output.system_instruction) {
      for (const key of ['systemInstruction','system_instruction']) {
        if (Array.isArray(output[key]?.parts)) output[key].parts = cleanParts(output[key].parts);
      }
      if (enabled) {
        const key = output.system_instruction && !output.systemInstruction ? 'system_instruction' : 'systemInstruction';
        output[key] ||= {};
        output[key].parts ||= [];
        output[key].parts.push({ text:CONTEXT });
      }
    } else if (Object.prototype.hasOwnProperty.call(output, 'input')) {
      const original = strip(output.instructions || '');
      if (enabled || output.instructions !== undefined) output.instructions = [original, enabled ? CONTEXT : ''].filter(Boolean).join('\n\n');
    }
    return output;
  }
  function bind() {
    if (!window.EVEAdapter?.registerRequestTransformer) return false;
    window.EVEAdapter.registerRequestTransformer('conversation-style', injectRequest, { priority:11000 });
    return true;
  }
  window.EVEConversationStyle = Object.freeze({ version:'1.0.0', injectRequest, bind });
  bind();
  window.addEventListener('eve:adapter-ready', bind);
})(window);
