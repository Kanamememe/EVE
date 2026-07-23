/**
 * EVE Diary Humanizer v1.5.7
 * Replaces report-like diary summaries with provider-neutral, first-person diary writing.
 */
(function (window, document) {
  'use strict';

  const VERSION = '1.5.7';
  const SETTINGS_KEY = 'eve_diary_humanizer_settings_v157';
  const STYLE_ID = 'eve-diary-humanizer-style';
  const REPORT_PATTERNS = [
    /场景状态/,
    /角色所在(?:地|位置)/,
    /更新时间?为/,
    /根据(?:今天|当天|现有|留下的)?记录(?:整理|生成)?/,
    /当天(?:行程|时间线|聊天摘录)/,
    /进行了?一次对话/,
    /对话记录/,
    /系统(?:记录|整理|摘要)/,
    /AI(?:整理|生成|摘要)/,
    /事件摘要/,
    /今日完成事项/,
    /角色状态/,
    /数据(?:显示|表明)/
  ];
  const ALLOWED_MOODS = ['开心','平静','放松','疲惫','烦躁','难过','紧张','期待','复杂'];
  let installed = false;
  let baseDiary = null;
  let timer = null;
  let observer = null;
  let humanSettings = null;

  function clean(value, max = 12000) {
    return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  }
  function clone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }
  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value && typeof value === 'object' ? Object.assign({}, fallback, value) : Object.assign({}, fallback);
    } catch (_) { return Object.assign({}, fallback); }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }
  function emit(name, detail = {}) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
  }
  function currentChat() {
    return window.EVEAdapter?.getCurrentChat?.() || { id:'', name:'角色', scope:'global', open:false };
  }
  function roleName() {
    return clean(currentChat().name || '角色', 80) || '角色';
  }
  function isXiaoYi() {
    const chat = currentChat();
    const active = window.EVERoleFidelity?.getActiveProfile?.() || window.EVERoleFidelity?.diagnostics?.()?.activeProfile;
    return /萧逸|蕭逸/i.test(chat.name || '') || /xiaoyi|xiao-yi/i.test(String(active?.id || active || ''));
  }
  function toDateString(value) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? new Date(`${value}T12:00:00`) : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }
  function dayBounds(date) {
    return {
      from:new Date(`${date}T00:00:00`).getTime(),
      to:new Date(`${date}T23:59:59.999`).getTime()
    };
  }
  function parseTime(value) {
    if (value == null) return 0;
    if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
    if (/^\d+$/.test(String(value))) {
      const number = Number(value);
      return number < 1e12 ? number * 1000 : number;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function shortQuote(value, max = 72) {
    return clean(value, max).replace(/\s+/g, ' ').replace(/^[「“]|[」”]$/g, '');
  }
  function sourceText(item) {
    const value = clean(item?.text ?? item?.content ?? item?.message ?? item?.body ?? '', 800);
    if (!value) return '';
    if (/^\[(?:发送|傳送)了?(?:表情包|图片|圖片)/.test(value)) return '发了一张表情包';
    if (/^(?:data:image|blob:|https?:\/\/\S+\.(?:png|jpe?g|gif|webp))/i.test(value)) return '发了一张图片';
    if (/回复失败|AI响应生成失败|网络或请求错误|日记模块/i.test(value)) return '';
    return value;
  }
  function senderLabel(item) {
    const sender = String(item?.sender ?? item?.role ?? item?.type ?? '').toLowerCase();
    if (['sent','user','human','me','self'].includes(sender)) return '用户';
    if (['received','assistant','character','ai','bot'].includes(sender)) return roleName();
    return sender || '对话';
  }
  function chatMessagesForDate(date) {
    const chat = currentChat();
    if (!chat.id) return [];
    const bounds = dayBounds(date);
    let all = window.chatMessages || {};
    try { if (typeof chatMessages !== 'undefined') all = chatMessages; } catch (_) {}
    const source = Array.isArray(all?.[chat.id]) ? all[chat.id] : [];
    return source
      .map(item => ({
        timestamp:parseTime(item?.timestamp ?? item?.createdAt ?? item?.time),
        sender:senderLabel(item),
        text:sourceText(item)
      }))
      .filter(item => item.text && item.timestamp >= bounds.from && item.timestamp <= bounds.to)
      .slice(-28);
  }
  async function timelineForDate(date) {
    const bounds = dayBounds(date);
    try {
      const value = await Promise.resolve(window.EVETimeline?.list?.({
        scope:baseDiary?.getCurrentScope?.(), includeGlobal:true,
        from:bounds.from, to:bounds.to, limit:30
      }));
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }
  async function scheduleForDate(date) {
    try {
      const day = await Promise.resolve(window.EVEDailySchedule?.getDay?.({ scope:baseDiary?.getCurrentScope?.(), date }));
      return Array.isArray(day?.items) ? day.items : [];
    } catch (_) { return []; }
  }
  function weatherForDate(date) {
    if (date !== (baseDiary?.getLocalDate?.() || toDateString(new Date()))) return '';
    try {
      const env = window.EVEWeather?.getEnvironment?.() || {};
      const role = env.character || env.role || {};
      const parts = [role.city || role.location, role.weather || role.condition, role.temperature != null ? `${role.temperature}°C` : ''].filter(Boolean);
      return parts.join('，');
    } catch (_) { return ''; }
  }
  function roleContext() {
    try {
      return clean(window.EVERoleFidelity?.getPromptContext?.({
        feature:'diary', scene:'diary', chat:currentChat(), userText:''
      }) || '', 9000);
    } catch (_) { return ''; }
  }
  async function buildContext(date) {
    const [timeline, schedule] = await Promise.all([timelineForDate(date), scheduleForDate(date)]);
    const chat = chatMessagesForDate(date);
    const completed = schedule.filter(item => !['cancelled','missed'].includes(String(item?.status || '')));
    const meaningful = chat.length + timeline.length + completed.length;
    return {
      date,
      chat,
      timeline,
      schedule:completed,
      weather:weatherForDate(date),
      role:roleContext(),
      meaningful
    };
  }
  function formatContext(ctx) {
    const blocks = [];
    if (ctx.schedule.length) {
      blocks.push(`【当天实际行程】\n${ctx.schedule.slice(0,12).map(item => {
        const time = [item.start,item.end].filter(Boolean).join('-');
        return `- ${time ? `${time} ` : ''}${clean(item.title || item.type || '安排', 100)}${item.description ? `：${clean(item.description, 180)}` : ''}`;
      }).join('\n')}`);
    }
    if (ctx.timeline.length) {
      blocks.push(`【当天发生的事】\n${ctx.timeline.slice(0,12).map(item => `- ${clean(item.title || item.type || '事件', 100)}${item.description ? `：${clean(item.description, 180)}` : ''}`).join('\n')}`);
    }
    if (ctx.chat.length) {
      blocks.push(`【当天对话片段】\n${ctx.chat.map(item => `- ${item.sender}：${clean(item.text, 260)}`).join('\n')}`);
    }
    if (ctx.weather) blocks.push(`【环境】${ctx.weather}`);
    return blocks.join('\n\n');
  }
  function systemPrompt(ctx, mode = 'write') {
    const xiaoYi = isXiaoYi();
    const base = [
      `你现在是${roleName()}本人，正在写只给自己看的私人日记。`,
      '这不是聊天回复、事件摘要、系统报告或工作日志。正文必须像一个人结束一天后真正写下来的话。',
      '使用第一人称“我”。不要称自己为“角色”，不要向读者解释背景，也不要提及AI、系统、场景状态、时间线、记录、资料来源或生成过程。',
      '不要用项目符号，不要逐项罗列发生了什么，不要写“进行了对话”“所在地更新为”“根据记录整理”等程序语言。',
      '从当天真实发生的小事里挑一两件最值得记住的写。写当时注意到的细节、情绪怎么变化、以及一小段没有在聊天里说出口的想法。',
      '不虚构当天没有发生的比赛结果、伤病、冲突、见面、亲密行为或用户反应。资料少时宁可只写两三句，也不要编造或凑字数。',
      '正文通常分成2到5个自然段，约80到360个汉字；资料很少时可以更短。语言自然克制，不写华丽散文，不做心理学分析，不总结人生大道理。',
      '标题像日记本里随手写的小标题，不要只写“今天”，也不要写“今日记录”“事件摘要”。',
      'moodReason要像本人对心情的简短解释，不得出现“根据记录”“资料不足”等幕后措辞。',
      '只输出一个JSON对象：{"title":"短标题","content":"第一人称正文","mood":"开心|平静|放松|疲惫|烦躁|难过|紧张|期待|复杂","moodReason":"自然的一句话","privacy":"private|shared"}'
    ];
    if (xiaoYi) {
      base.push('萧逸专属写法：语气直接、成熟、松弛而克制，写具体小事胜过长篇抒情；可以有一点不动声色的调侃或在意，但不要油腻、病娇、心理咨询化，也不要突然把脆弱全部摊开。日记可以使用正常标点，不需要机械复制聊天里的断句习惯。');
    }
    if (ctx.role) base.push(`以下角色规则优先遵守，但不要在日记中复述这些规则：\n${ctx.role}`);
    if (mode === 'rewrite') base.push('你正在重写一篇过于像程序汇报的草稿。必须彻底改成自然私人日记，保留真实事实，但不要保留原草稿的报告句式。');
    return base.join('\n\n');
  }
  function getApiSettings() {
    try { if (typeof apiSettings !== 'undefined' && apiSettings) return apiSettings; } catch (_) {}
    return window.apiSettings || {};
  }
  function apiConfig() {
    const api = getApiSettings();
    return {
      base:clean(api.base || api.baseUrl || api.apiBase || api.url || '', 800).replace(/\/+$/,''),
      key:clean(api.key || api.apiKey || api.token || '', 1000),
      model:clean(api.model || api.modelName || '', 180).replace(/^models\//,''),
      temperature:Number(api.temperature)
    };
  }
  function isGemini(config) {
    return /generativelanguage\.googleapis\.com/i.test(config.base);
  }
  function openAIEndpoint(base) {
    if (/\/chat\/completions(?:[/?#]|$)/i.test(base)) return base;
    if (/\/v1\/?$/i.test(base)) return `${base.replace(/\/$/,'')}/chat/completions`;
    if (/siliconflow|deepseek|moonshot|openai/i.test(base)) return `${base.replace(/\/$/,'')}/v1/chat/completions`;
    return `${base.replace(/\/$/,'')}/chat/completions`;
  }
  function transport() {
    return window.EVEAdapter?.rawFetch || window.fetch.bind(window);
  }
  async function responseJson(response) {
    try { return await response.json(); }
    catch (_) {
      try { return { rawText:await response.text() }; }
      catch (_) { return {}; }
    }
  }
  function extractAIText(raw) {
    const gemini = (raw?.candidates || []).flatMap(candidate => candidate?.content?.parts || []).map(part => part?.text).filter(Boolean).join('\n').trim();
    if (gemini) return gemini;
    const content = raw?.choices?.[0]?.message?.content ?? raw?.choices?.[0]?.text ?? raw?.output_text ?? '';
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) return content.map(part => part?.text || part?.content || '').filter(Boolean).join('\n').trim();
    return '';
  }
  async function callGemini(config, system, user) {
    const endpoint = `${config.base}/models/${encodeURIComponent(config.model)}:generateContent`;
    const response = await transport()(endpoint, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-goog-api-key':config.key },
      body:JSON.stringify({
        systemInstruction:{ parts:[{ text:system }] },
        contents:[{ role:'user', parts:[{ text:user.slice(0,28000) }] }],
        generationConfig:{
          temperature:Number.isFinite(config.temperature) ? Math.max(0.4,Math.min(1.15,config.temperature)) : 0.88,
          maxOutputTokens:2200,
          responseMimeType:'application/json'
        }
      })
    });
    const raw = await responseJson(response);
    if (!response.ok) throw new Error(raw?.error?.message || `日记生成失败：HTTP ${response.status}`);
    return extractAIText(raw);
  }
  async function callOpenAICompatible(config, system, user) {
    const endpoint = openAIEndpoint(config.base);
    const common = {
      model:config.model,
      messages:[
        { role:'system', content:system },
        { role:'user', content:user.slice(0,28000) }
      ],
      temperature:Number.isFinite(config.temperature) ? Math.max(0.4,Math.min(1.2,config.temperature)) : 0.88,
      max_tokens:2200
    };
    const attempt = async body => {
      const response = await transport()(endpoint, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${config.key}` },
        body:JSON.stringify(body)
      });
      const raw = await responseJson(response);
      return { response, raw };
    };
    let result = await attempt(Object.assign({}, common, { response_format:{ type:'json_object' } }));
    if (!result.response.ok && [400,404,422].includes(result.response.status)) {
      result = await attempt(common);
    }
    if (!result.response.ok) throw new Error(result.raw?.error?.message || result.raw?.message || `日记生成失败：HTTP ${result.response.status}`);
    return extractAIText(result.raw);
  }
  async function callAI(system, user) {
    const config = apiConfig();
    if (!config.base || !config.key || !config.model) throw new Error('日记生成缺少可用的 API 配置');
    return isGemini(config) ? callGemini(config, system, user) : callOpenAICompatible(config, system, user);
  }
  function stripFence(value) {
    return clean(value, 20000).replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  }
  function parseDiary(value) {
    const source = stripFence(value);
    if (!source) throw new Error('AI 没有返回日记内容');
    try {
      const parsed = JSON.parse(source);
      return Array.isArray(parsed) ? parsed[0] : parsed;
    } catch (_) {
      const match = source.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch (_) {}
      }
      return { title:'记下一点', content:source, mood:'平静', moodReason:'', privacy:'private' };
    }
  }
  function isReportLike(value) {
    const text = clean(value, 16000);
    if (!text) return true;
    if (REPORT_PATTERNS.some(pattern => pattern.test(text))) return true;
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const bullets = lines.filter(line => /^[-•*]\s+|^\d+[.)、]\s*/.test(line)).length;
    if (lines.length >= 2 && bullets >= Math.ceil(lines.length / 2)) return true;
    if (/^(?:完成|更新|记录|状态|地点|事件)[：:]/m.test(text)) return true;
    return false;
  }
  function sanitizeContent(value) {
    let text = clean(value, 12000)
      .replace(/^(?:日记正文|正文|内容)[：:]\s*/,'')
      .replace(/\n{3,}/g,'\n\n');
    for (const pattern of REPORT_PATTERNS) text = text.replace(pattern, '');
    return text.replace(/[ \t]+\n/g,'\n').trim();
  }
  function titleFromContent(content) {
    const first = clean(content, 80).split(/[。！？!?\n]/)[0].replace(/[“”「」]/g,'').trim();
    if (!first || /^(今天|今日|一天)$/.test(first)) return '留下一点';
    return first.slice(0,14);
  }
  function normalizeDiary(parsed, ctx) {
    const content = sanitizeContent(parsed?.content || parsed?.text || parsed?.body || '');
    const rawTitle = clean(parsed?.title || '', 60);
    const title = !rawTitle || /^(今天|今日记录|事件摘要|日记)$/.test(rawTitle) ? titleFromContent(content) : rawTitle;
    const mood = ALLOWED_MOODS.includes(parsed?.mood) ? parsed.mood : '平静';
    let moodReason = clean(parsed?.moodReason || parsed?.mood_reason || '', 240);
    if (REPORT_PATTERNS.some(pattern => pattern.test(moodReason))) moodReason = '';
    const settings = getSettings();
    return {
      title:title || '留下一点',
      content,
      mood,
      moodReason,
      privacy:settings.defaultPrivacy || 'private',
      source:'ai-humanized',
      sourceSummary:formatContext(ctx).slice(0,3000)
    };
  }
  function humanFallback(ctx) {
    const lastUser = [...ctx.chat].reverse().find(item => item.sender === '用户' && item.text);
    const lastRole = [...ctx.chat].reverse().find(item => item.sender === roleName() && item.text);
    const firstTask = ctx.schedule[0]?.title || ctx.timeline[0]?.title || '';
    if (lastUser) {
      const quote = shortQuote(lastUser.text, 58);
      if (isXiaoYi()) {
        return {
          title:'还记得那句话',
          content:`今天和萧小五聊了会儿。\n\n她提到“${quote}”。当时只是顺着话往下接，等安静下来以后，那句话反倒还在脑子里。`,
          mood:'平静',
          moodReason:'有句话后来又想起了一次',
          privacy:'private'
        };
      }
      return {
        title:'留在心里的话',
        content:`今天和她聊了一会儿。\n\n她提到“${quote}”。当时没有觉得特别，安静下来以后才发现，自己居然还记得这句话。`,
        mood:'平静',
        moodReason:'那句话比想象中留得更久',
        privacy:'private'
      };
    }
    if (lastRole) {
      return {
        title:'说出口以后',
        content:`今天说了句“${shortQuote(lastRole.text,58)}”。\n\n说出口的时候没多想，后来再想起来，倒也不觉得需要改。`,
        mood:'平静',
        moodReason:'有些话说出来以后，心里反而安静了',
        privacy:'private'
      };
    }
    if (firstTask) {
      return {
        title:clean(firstTask,20),
        content:`今天大半时间都留给了${clean(firstTask,60)}。\n\n忙的时候没觉得，停下来以后才发现有点累。不过事情做完了，心里也算踏实。`,
        mood:'疲惫',
        moodReason:'忙完以后才感觉到累',
        privacy:'private'
      };
    }
    return {
      title:'安静的一天',
      content:isXiaoYi() ? '今天没什么特别值得记下来的。\n\n安静也好，至少不用急着给这一天一个结论。' : '今天没发生什么特别的事。\n\n有时候这样安安静静地过完一天，也不坏。',
      mood:'平静',
      moodReason:'今天没有太多波澜',
      privacy:'private'
    };
  }
  async function writeDiary(ctx) {
    const facts = formatContext(ctx) || '当天没有足够记录。只能写很短，不得补造事件。';
    const user = `日期：${ctx.date}\n\n以下内容只是事实素材，不是需要照抄的写作格式：\n<facts>\n${facts}\n</facts>`;
    let parsed = normalizeDiary(parseDiary(await callAI(systemPrompt(ctx,'write'), user)), ctx);
    if (isReportLike(parsed.content) || parsed.content.length < 12) {
      const bad = parsed.content;
      const rewriteUser = `${user}\n\n这是一份不合格草稿：\n<bad_draft>\n${bad}\n</bad_draft>\n\n请只保留真实事实，彻底重写成私人日记。`;
      parsed = normalizeDiary(parseDiary(await callAI(systemPrompt(ctx,'rewrite'), rewriteUser)), ctx);
    }
    if (isReportLike(parsed.content) || parsed.content.length < 12) return Object.assign(humanFallback(ctx), { source:'local-human-fallback', sourceSummary:facts.slice(0,3000) });
    return parsed;
  }
  function getSettings() {
    const base = baseDiary?.getSettings?.() || {};
    return Object.assign({}, base, humanSettings || {});
  }
  function configure(next = {}) {
    const current = getSettings();
    humanSettings = Object.assign({}, humanSettings || {}, {
      autoGenerate:next.autoGenerate == null ? current.autoGenerate : Boolean(next.autoGenerate),
      generateTime:clean(next.generateTime == null ? current.generateTime : next.generateTime, 5) || '23:50',
      catchUpDays:Math.max(0,Math.min(31,Number(next.catchUpDays == null ? current.catchUpDays : next.catchUpDays) || 0))
    });
    writeJson(SETTINGS_KEY, humanSettings);
    const passthrough = Object.assign({}, next, { autoGenerate:false });
    baseDiary?.configure?.(passthrough);
    emit('eve:diary-settings-updated',{ settings:getSettings() });
    return getSettings();
  }
  async function generate(options = {}) {
    const settings = getSettings();
    if (settings.enabled === false) throw new Error('日记功能已关闭');
    const date = options.date || baseDiary?.getLocalDate?.() || toDateString(new Date());
    const scope = options.scope || baseDiary?.getCurrentScope?.();
    const existing = await baseDiary.list({ scope, date, limit:30 });
    const autoExisting = existing.find(item => String(item.source || '').startsWith('ai') || item.source === 'local-human-fallback');
    if (autoExisting && !options.force) return autoExisting;
    const ctx = await buildContext(date);
    let parsed;
    try { parsed = await writeDiary(ctx); }
    catch (error) {
      console.warn('[EVEDiaryHumanizer] AI日记生成失败，使用自然本地短记：', error);
      parsed = Object.assign(humanFallback(ctx), { source:'local-human-fallback', sourceSummary:formatContext(ctx).slice(0,3000) });
      emit('eve:diary-generation-fallback',{ date, error:clean(error?.message || error,800) });
    }
    if (autoExisting) await baseDiary.remove(autoExisting.id);
    const saved = await baseDiary.save({
      scope,
      date,
      title:parsed.title,
      content:parsed.content,
      mood:parsed.mood,
      moodReason:parsed.moodReason,
      privacy:parsed.privacy || settings.defaultPrivacy || 'private',
      source:parsed.source || 'ai-humanized',
      generatedAt:Date.now(),
      sourceSummary:parsed.sourceSummary || formatContext(ctx).slice(0,3000)
    });
    emit('eve:diary-humanized',{ entry:clone(saved), provider:isGemini(apiConfig())?'gemini':'openai-compatible' });
    return saved;
  }
  async function checkAutoGenerate() {
    const settings = getSettings();
    if (settings.enabled === false || !settings.autoGenerate || !currentChat().id) return;
    const now = new Date();
    const [hour,minute] = String(settings.generateTime || '23:50').split(':').map(Number);
    const today = baseDiary?.getLocalDate?.() || toDateString(now);
    if (now.getHours()*60 + now.getMinutes() >= (Number(hour)||0)*60 + (Number(minute)||0)) {
      const entries = await baseDiary.list({ date:today, limit:30 });
      if (!entries.some(item => String(item.source || '').startsWith('ai') || item.source === 'local-human-fallback')) await generate({ date:today }).catch(() => {});
    }
    const days = Math.max(0,Math.min(31,Number(settings.catchUpDays)||0));
    for (let offset=1; offset<=days; offset++) {
      const date = toDateString(new Date(now.getFullYear(),now.getMonth(),now.getDate()-offset,12));
      const entries = await baseDiary.list({ date, limit:30 });
      if (entries.length) continue;
      const ctx = await buildContext(date);
      if (ctx.meaningful) await generate({ date }).catch(() => {});
    }
  }
  function patchCard(card) {
    if (!card || card.dataset.eveDiaryHumanized === VERSION) return;
    const meta = card.querySelector('.eve-diary-meta');
    const wasAI = /AI整理|ai-humanized|角色书写/.test(meta?.textContent || '');
    if (meta) {
      meta.textContent = meta.textContent
        .replace(/\s*·\s*AI整理/g,'')
        .replace(/\s*·\s*角色书写/g,'');
    }
    const reason = card.querySelector('.eve-diary-reason');
    if (reason && REPORT_PATTERNS.some(pattern => pattern.test(reason.textContent || ''))) {
      reason.textContent = (reason.textContent || '').split('·')[0].trim();
    }
    if (wasAI) {
      const actions = card.querySelector('.eve-diary-actions');
      if (actions && !actions.querySelector('[data-rewrite-human]')) {
        const button = document.createElement('button');
        button.type='button'; button.dataset.rewriteHuman='1'; button.textContent='重写';
        button.onclick = async () => {
          const date = (meta?.textContent || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || baseDiary?.getLocalDate?.();
          button.disabled=true;
          try { await generate({ date, force:true }); await window.EVEDiaryApp?.render?.(); }
          catch (error) { alert(error?.message || String(error)); }
          finally { button.disabled=false; }
        };
        actions.prepend(button);
      }
    }
    card.dataset.eveDiaryHumanized=VERSION;
  }
  function patchDiaryUI(root = document) {
    root.querySelectorAll?.('.eve-diary-card').forEach(patchCard);
  }
  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id=STYLE_ID;
    style.textContent='.eve-diary-card .eve-diary-body{letter-spacing:.01em}.eve-diary-card [data-rewrite-human]{background:#e9dfd0!important;color:#6a5034!important;font-weight:600}';
    document.head.appendChild(style);
  }
  function installObserver() {
    observer?.disconnect();
    observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes || []) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.('.eve-diary-card')) patchCard(node);
          patchDiaryUI(node);
        }
      }
    });
    observer.observe(document.documentElement,{ childList:true,subtree:true });
    patchDiaryUI();
  }
  function upgradeDiaryObject() {
    if (!baseDiary) return false;
    const upgraded = {};
    for (const key of Object.keys(baseDiary)) upgraded[key]=baseDiary[key];
    upgraded.version=VERSION;
    upgraded.generate=generate;
    upgraded.configure=configure;
    upgraded.getSettings=getSettings;
    upgraded.checkAutoGenerate=checkAutoGenerate;
    upgraded.audit=() => ({
      version:VERSION,
      provider:isGemini(apiConfig())?'gemini':'openai-compatible',
      role:roleName(),
      xiaoYi:isXiaoYi(),
      settings:getSettings(),
      reportPatterns:REPORT_PATTERNS.length
    });
    window.EVEDiary=Object.freeze(upgraded);
    window.EVE ||= {};
    window.EVE.diary=window.EVEDiary;
    return true;
  }
  function install() {
    if (installed && window.EVEDiaryHumanizer?.version === VERSION) return true;
    if (!window.EVEDiary?.version) return false;
    baseDiary=window.EVEDiary;
    const baseSettings=baseDiary.getSettings?.() || {};
    humanSettings=readJson(SETTINGS_KEY,{
      autoGenerate:Boolean(baseSettings.autoGenerate),
      generateTime:baseSettings.generateTime || '23:50',
      catchUpDays:Number(baseSettings.catchUpDays) || 7
    });
    baseDiary.configure?.({ autoGenerate:false });
    upgradeDiaryObject();
    installStyle();
    installObserver();
    clearInterval(timer);
    timer=setInterval(() => checkAutoGenerate().catch(() => {}),60000);
    document.addEventListener('visibilitychange',() => { if (!document.hidden) checkAutoGenerate().catch(() => {}); });
    setTimeout(() => checkAutoGenerate().catch(() => {}),3000);
    installed=true;
    emit('eve:diary-humanizer-ready',{ version:VERSION, role:roleName() });
    return true;
  }
  function waitForCore() {
    if (install()) return;
    let tries=0;
    const retry=setInterval(() => {
      tries++;
      if (install() || tries>80) clearInterval(retry);
    },250);
  }

  window.EVEDiaryHumanizer=Object.freeze({ version:VERSION, install, generate, isReportLike, patchDiaryUI });
  document.readyState==='loading' ? document.addEventListener('DOMContentLoaded',waitForCore,{once:true}) : waitForCore();
})(window,document);
