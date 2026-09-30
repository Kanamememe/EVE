/** Request-time clock and elapsed conversation time from persisted message timestamps. */
(function (window) {
  'use strict';
  if (window.EVETemporalContext?.version) return;
  function timestamp(value, now) {
    if (value == null || value === '') return null;
    let time = typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : Date.parse(value);
    if (time > 0 && time < 1e11) time *= 1000;
    return Number.isFinite(time) && time >= 946684800000 && time <= now ? time : null;
  }
  function zone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
  }
  function dateKey(time, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone:timezone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(time);
    return ['year','month','day'].map(type => parts.find(part => part.type === type).value).join('-');
  }
  function display(time, timezone) {
    return new Intl.DateTimeFormat('zh-CN', { timeZone:timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(time);
  }
  function elapsed(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return '不到1分钟';
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return hours < 24 ? `${hours}小时${rest}分钟` : `${Math.floor(hours / 24)}天${hours % 24}小时${rest}分钟`;
  }
  function getTiming(meta = {}) {
    const now = Date.now(), timezone = zone();
    const chat = meta.chat || window.EVEAdapter?.getCurrentChat?.() || {};
    const messages = (window.EVEAdapter?.getConversationTimeline?.(chat.id) || [])
      .map(message => ({ ...message, time:timestamp(message.timestamp, now) }))
      .filter(message => message.time !== null).sort((a,b) => a.time-b.time);
    const users = messages.filter(message => message.isUser === true || ['sent','user'].includes(String(message.sender).toLowerCase()));
    const assistants = messages.filter(message => message.isUser !== true && ['received','assistant','ai','bot'].includes(String(message.sender).toLowerCase()));
    const lastUserAt = users.at(-1)?.time ?? null;
    const lastAssistantAt = assistants.at(-1)?.time ?? null;
    // The newest user message may have just arrived. Do not let it erase the preceding gap.
    const referenceAt = lastAssistantAt ?? (lastUserAt !== null ? messages.filter(message => message.time < lastUserAt).at(-1)?.time ?? lastUserAt : messages.at(-1)?.time ?? null);
    const gapMs = referenceAt === null ? null : now-referenceAt;
    const dayChanged = referenceAt !== null && dateKey(referenceAt,timezone) !== dateKey(now,timezone);
    return { now, timezone, lastUserAt, lastAssistantAt, referenceAt, gapMs, dayChanged,
      resumed:gapMs !== null && (gapMs >= 2*3600000 || (dayChanged && gapMs >= 30*60000)) };
  }
  function getPromptContext(meta = {}) {
    const t = getTiming(meta);
    return [
      '【EVE本轮时间】',
      `用户设备当前当地时间：${display(t.now,t.timezone)}（${t.timezone}）；UTC：${new Date(t.now).toISOString()}`,
      '这是本次请求现场计算的时间；旧系统提示、天气采集时间和历史消息里的“现在”不能覆盖它。角色所在地若有时差应另行区分，不能套用为用户当地时间。',
      t.lastUserAt === null ? '最近用户消息时间：未知，不猜测。' : `最近用户消息：${display(t.lastUserAt,t.timezone)}，距现在${elapsed(t.now-t.lastUserAt)}。`,
      t.lastAssistantAt === null ? '上次角色回覆时间：未知。' : `上次角色回覆：${display(t.lastAssistantAt,t.timezone)}，距现在${elapsed(t.now-t.lastAssistantAt)}。`,
      t.referenceAt === null ? '没有可靠的历史时间，不编造离开时长。' : `本轮与前次交流参考点相隔${elapsed(t.gapMs)}；用户当地日历日期${t.dayChanged ? '已改变' : '未改变'}。`,
      t.resumed ? '这是隔了一段时间后重新交流。旧消息的动作、地点、心情、吃饭睡觉与未完成场景属于过去，不能默认仍在进行。优先回应这次新消息，必要时自然问后来怎么样；用户明确要继续昨天的话题时可以接续，并承认时间已过去。'
        : '短间隔内可以自然接话。仅过午夜不代表用户已经睡过一觉或离开很久，不强行重启话题。',
      '历史中的“今天／今晚／明天／待会”应按那条消息发生时的日期理解，不自动挪到今天。约定可以记得，但是否履行、是否醒来、是否还难过要依据新消息，不自行补写。',
      '自然体现时间感即可，不每轮播报日期或时长，不责问为什么没回、也不因间隔而说教。',
      '【EVE本轮时间结束】'
    ].join('\n');
  }
  function strip(text) { return typeof text === 'string' ? text.replace(/(?:\n\n)?【EVE本轮时间】[\s\S]*?【EVE本轮时间结束】\s*/g,'') : text; }
  function parts(values) { return values.map(part => typeof part?.text === 'string' ? { ...part,text:strip(part.text) } : part).filter(part => typeof part?.text !== 'string' || part.text.trim()); }
  function injectRequest(body, meta = {}) {
    const chat = meta.chat || window.EVEAdapter?.getCurrentChat?.();
    if (!body || typeof body !== 'object' || !chat?.id) return body;
    const out = JSON.parse(JSON.stringify(body)), context = getPromptContext(meta);
    if (Array.isArray(out.messages)) {
      out.messages = out.messages.map(message => ['system','developer'].includes(message?.role) ? { ...message,content:Array.isArray(message.content) ? parts(message.content) : strip(message.content) } : message)
        .filter(message => !['system','developer'].includes(message?.role) || (Array.isArray(message.content) ? message.content.length : String(message.content ?? '').trim()));
      const position = out.messages.reduce((last,message,index) => ['system','developer'].includes(message?.role) ? index+1 : last,0);
      out.messages.splice(position,0,{role:'system',content:context});
    } else if (Array.isArray(out.contents) || out.systemInstruction || out.system_instruction) {
      for (const key of ['systemInstruction','system_instruction']) if (Array.isArray(out[key]?.parts)) out[key].parts = parts(out[key].parts);
      const key = out.system_instruction && !out.systemInstruction ? 'system_instruction' : 'systemInstruction';
      out[key] ||= {}; out[key].parts ||= []; out[key].parts.push({text:context});
    } else if (Object.prototype.hasOwnProperty.call(out,'input')) out.instructions = [strip(out.instructions || ''),context].filter(Boolean).join('\n\n');
    return out;
  }
  function bind() { window.EVEAdapter?.registerRequestTransformer?.('temporal-context',injectRequest,{priority:12000}); }
  window.EVETemporalContext = Object.freeze({version:'1.0.0',getTiming,getPromptContext,injectRequest});
  bind(); window.addEventListener('eve:adapter-ready',bind);
})(window);
