/**
 * EVE Daily Schedule v1.2.0
 * 通用角色行程插件：整日规划、到点生成、混合模式、时间线／通知／主动消息联动。
 */
(function (window, document) {
  'use strict';
  if (window.EVEDailySchedule?.version) return;

  const VERSION = '1.2.0';
  const SETTINGS_KEY = 'eve_daily_schedule_settings_v1';
  const STORE_KEY = 'eve_daily_schedule_store_v1';
  const MAX_TIMEOUT = 2147483647;

  const DEFAULTS = Object.freeze({
    enabled: true,
    mode: 'hybrid', // full-day | on-demand | hybrid
    autoGenerate: true,
    useAiGeneration: true,
    generateTime: '06:00',
    density: 'normal', // light | normal | busy
    detailAtStart: true,
    useWeather: true,
    useMemory: true,
    useTimeline: true,
    useAppointments: true,
    useR1: true,
    proactiveOnStart: false,
    notifyOnStart: false,
    timelineOnStart: true,
    catchUpAfterResume: true,
    refreshSeconds: 60,
    onDemandBlockMinutes: 90,
    debug: false
  });

  const STATUS = new Set(['planned', 'active', 'completed', 'adjusted', 'cancelled', 'missed']);
  const providers = new Map();
  const disposers = [];

  let settings = loadSettings();
  let store = readJson(STORE_KEY, { days: {} });
  let initialized = false;
  let adapterBound = false;
  let timer = null;
  let manager = null;
  let generating = false;

  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      return parsed && typeof parsed === 'object'
        ? Object.assign({}, fallback, parsed)
        : Object.assign({}, fallback);
    } catch (_) {
      return Object.assign({}, fallback);
    }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }
  function clone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }
  function clean(value, max = 1000) {
    return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  }
  function emit(name, detail = {}) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
  }
  function on(target, name, handler, options) {
    target.addEventListener(name, handler, options);
    disposers.push(() => target.removeEventListener(name, handler, options));
  }
  function log(...args) { if (settings.debug) console.log('[EVEDailySchedule]', ...args); }
  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    if (window.showToast) return window.showToast(message, type);
    console.log('[EVEDailySchedule]', message);
  }
  function currentChat() {
    return window.EVEAdapter?.getCurrentChat?.() || { scope: 'global', id: '', name: '', open: false };
  }
  function roleId() { return window.EVERoleFidelity?.resolveActive?.()?.id || ''; }
  function scopeKey(scope) { return clean(scope || currentChat().scope || 'global', 200) || 'global'; }
  function characterReady() {
    const chat = currentChat();
    return Boolean(chat.id || (chat.name && chat.name !== '角色聊天'));
  }

  function normalizeSettings(input) {
    const next = Object.assign({}, DEFAULTS, input || {});
    [
      'enabled', 'autoGenerate', 'useAiGeneration', 'detailAtStart', 'useWeather',
      'useMemory', 'useTimeline', 'useAppointments', 'useR1', 'proactiveOnStart',
      'notifyOnStart', 'timelineOnStart', 'catchUpAfterResume', 'debug'
    ].forEach(key => { next[key] = Boolean(next[key]); });
    next.mode = ['full-day', 'on-demand', 'hybrid'].includes(next.mode) ? next.mode : 'hybrid';
    next.density = ['light', 'normal', 'busy'].includes(next.density) ? next.density : 'normal';
    next.generateTime = /^\d{2}:\d{2}$/.test(next.generateTime) ? next.generateTime : '06:00';
    next.refreshSeconds = Math.max(15, Math.min(600, Number(next.refreshSeconds) || 60));
    next.onDemandBlockMinutes = Math.max(30, Math.min(240, Number(next.onDemandBlockMinutes) || 90));
    return next;
  }
  function loadSettings() { return normalizeSettings(readJson(SETTINGS_KEY, DEFAULTS)); }
  function configure(patch = {}) {
    settings = normalizeSettings(Object.assign({}, settings, patch || {}));
    writeJson(SETTINGS_KEY, settings);
    restartTimer();
    emit('eve:schedule-settings-updated', { settings: getSettings() });
    return getSettings();
  }
  function getSettings() { return Object.assign({}, settings); }
  function persist() { store.days ||= {}; writeJson(STORE_KEY, store); }

  function localClock() {
    const env = window.EVEWeather?.getEnvironment?.();
    const character = env?.character || null;
    const date = character?.localDate || env?.localDate;
    const time = character?.localTime || env?.localTime;
    const timezone = character?.timezone || env?.timezone || '';
    if (date && time) return { date, time, timezone };
    const now = new Date();
    return {
      date: [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-'),
      time: [String(now.getHours()).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0')].join(':'),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    };
  }
  function timeMinutes(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
    return match ? Math.min(1439, Number(match[1]) * 60 + Number(match[2])) : 0;
  }
  function timeString(minutes) {
    const value = Math.max(0, Math.min(1439, Number(minutes) || 0));
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  }
  function normalizeTime(value, fallback = '09:00') {
    const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
    if (!match) return fallback;
    return timeString(Math.min(23, Number(match[1])) * 60 + Math.min(59, Number(match[2])));
  }
  function normalizeItem(raw, index = 0) {
    const start = normalizeTime(raw?.start || raw?.time || '09:00');
    let end = normalizeTime(raw?.end || '', '');
    if (!end || timeMinutes(end) <= timeMinutes(start)) {
      end = timeString(timeMinutes(start) + Math.max(20, Number(raw?.durationMinutes) || 60));
    }
    return {
      id: clean(raw?.id || `schedule_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`, 180),
      start,
      end,
      title: clean(raw?.title || raw?.activity || '日常安排', 100),
      description: clean(raw?.description, 500),
      type: clean(raw?.type || 'daily', 50),
      status: STATUS.has(raw?.status) ? raw.status : 'planned',
      locked: Boolean(raw?.locked),
      private: Boolean(raw?.private),
      source: clean(raw?.source || 'generated', 50),
      startedAt: Number(raw?.startedAt) || 0,
      completedAt: Number(raw?.completedAt) || 0,
      notified: Boolean(raw?.notified),
      proactiveSent: Boolean(raw?.proactiveSent),
      timelineRecorded: Boolean(raw?.timelineRecorded)
    };
  }
  function dayKey(scope, date) { return `${scopeKey(scope)}|${date}`; }
  function getDay(options = {}) {
    const clock = localClock();
    const scope = scopeKey(options.scope);
    const date = options.date || clock.date;
    const raw = store.days?.[dayKey(scope, date)];
    if (!raw) return null;
    return clone(Object.assign({}, raw, {
      items: (raw.items || []).map(normalizeItem).sort((a, b) => timeMinutes(a.start) - timeMinutes(b.start))
    }));
  }
  function saveDay(day) {
    store.days ||= {};
    const normalized = Object.assign({}, day, {
      scope: scopeKey(day.scope),
      date: day.date || localClock().date,
      items: (day.items || []).map(normalizeItem).sort((a, b) => timeMinutes(a.start) - timeMinutes(b.start)),
      updatedAt: Date.now()
    });
    store.days[dayKey(normalized.scope, normalized.date)] = normalized;
    persist();
    emit('eve:schedule-updated', { day: clone(normalized) });
    return clone(normalized);
  }
  function currentItem(day = getDay() || { items: [] }) {
    const current = timeMinutes(localClock().time);
    return (day.items || []).find(item => item.status !== 'cancelled' && current >= timeMinutes(item.start) && current < timeMinutes(item.end)) || null;
  }
  function nextItem(day = getDay() || { items: [] }) {
    const current = timeMinutes(localClock().time);
    return (day.items || [])
      .filter(item => ['planned', 'adjusted'].includes(item.status) && timeMinutes(item.start) > current)
      .sort((a, b) => timeMinutes(a.start) - timeMinutes(b.start))[0] || null;
  }

  function registerProvider(id, provider) {
    if (!id || !provider) throw new TypeError('行程提供器需要 id');
    providers.set(String(id), provider);
    emit('eve:schedule-provider-registered', { id: String(id) });
    return () => providers.delete(String(id));
  }
  function resolveProvider(meta = {}) {
    const active = meta.roleId || roleId();
    if (active && providers.has(active)) return providers.get(active);
    for (const provider of providers.values()) {
      try {
        if (provider.match?.(Object.assign({ chat: currentChat(), roleId: active }, meta))) return provider;
      } catch (_) {}
    }
    return null;
  }

  function genericFallback() {
    const base = [
      ['07:30', '08:10', '起床与整理', '整理自己，准备开始一天', 'daily'],
      ['08:10', '08:50', '早餐', '吃早餐并确认今天的安排', 'meal'],
      ['09:30', '11:50', '上午安排', '处理工作、学习或个人事务', 'work'],
      ['12:10', '13:10', '午餐与休息', '吃午饭，短暂休息', 'meal'],
      ['14:00', '17:20', '下午安排', '继续当天的主要活动', 'work'],
      ['18:20', '19:20', '晚餐', '吃晚饭', 'meal'],
      ['20:00', '22:30', '个人时间', '处理生活琐事、兴趣或与重要的人联系', 'daily'],
      ['23:20', '23:55', '准备休息', '整理明天的事情，准备睡觉', 'rest']
    ];
    if (settings.density === 'light') base.splice(2, 1);
    if (settings.density === 'busy') base.splice(5, 0, ['17:30', '18:10', '临时事务', '处理当天尚未完成的事情', 'task']);
    return base.map((entry, index) => normalizeItem({
      start: entry[0], end: entry[1], title: entry[2], description: entry[3], type: entry[4], source: 'fallback'
    }, index));
  }
  async function appointmentsFor(date, characterId) {
    if (!settings.useAppointments || !window.db?.appointments?.toArray) return [];
    try {
      const all = await window.db.appointments.toArray();
      return all
        .filter(item => String(item.date || '').slice(0, 10) === date && (!characterId || !item.characterId || String(item.characterId) === String(characterId)))
        .map(item => normalizeItem({
          id: `appointment_${item.id}`,
          start: item.time || '19:00',
          durationMinutes: 60,
          title: item.name || item.title || '约定',
          description: item.description || '',
          type: 'appointment', locked: true, source: 'appointment'
        }));
    } catch (error) { log('读取约定失败', error); return []; }
  }
  function mergeLocked(generated, locked) {
    const result = [...generated];
    for (const item of locked) {
      const conflict = result.findIndex(candidate =>
        timeMinutes(candidate.start) < timeMinutes(item.end) && timeMinutes(candidate.end) > timeMinutes(item.start)
      );
      if (conflict >= 0 && !result[conflict].locked) result.splice(conflict, 1);
      if (!result.some(candidate => String(candidate.id) === String(item.id))) result.push(item);
    }
    return result.sort((a, b) => timeMinutes(a.start) - timeMinutes(b.start));
  }

  function getApiSettings() {
    try { if (typeof apiSettings !== 'undefined' && apiSettings) return apiSettings; } catch (_) {}
    return window.apiSettings || null;
  }
  function geminiEndpoint(api) {
    const base = clean(api?.base || '', 500).replace(/\/+$/, '');
    const model = clean(api?.model || '', 150).replace(/^models\//, '');
    if (!/generativelanguage\.googleapis\.com/i.test(base) || !api?.key || !model) {
      throw new Error('当前 API 不适合行程 AI 生成');
    }
    return `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(api.key)}`;
  }
  function parseJson(text) {
    const source = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(source); } catch (_) {}
    const object = source.match(/\{[\s\S]*\}/);
    if (object) return JSON.parse(object[0]);
    throw new Error('AI 未返回有效行程 JSON');
  }
  function contextForGeneration(date, provider, appointments, singleItem = false) {
    const chat = currentChat();
    const role = window.EVERoleFidelity?.getPromptContext?.({ feature: 'daily-schedule', scene: 'schedule', userText: '', chat }) || '';
    const weather = settings.useWeather ? window.EVEWeather?.getPromptContext?.() || '' : '';
    const memory = settings.useMemory ? window.EVEMemory?.getPromptContext?.({ query: '今天 行程 工作 约定', chat }) || '' : '';
    const timeline = settings.useTimeline ? window.EVETimeline?.getPromptContext?.({ query: '最近发生的事情', chat }) || '' : '';
    const r1 = settings.useR1 ? window.EVEXiaoYiR1?.getPromptContext?.({ scene: 'schedule', feature: 'daily-schedule' }) || '' : '';
    const constraints = provider?.getConstraints?.({
      date, settings: getSettings(), chat, r1State: window.EVEXiaoYiR1?.getState?.()
    }) || '';
    return { chat, role, weather, memory, timeline, r1, constraints, singleItem };
  }
  async function callGemini(prompt, maxTokens = 2200) {
    const api = getApiSettings();
    const response = await fetch(geminiEndpoint(api), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-EVE-Bypass-Adapter': '1' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt.slice(0, 24000) }] }],
        generationConfig: { temperature: 0.65, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
        ]
      })
    });
    const raw = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(raw?.error?.message || `行程生成失败：${response.status}`);
    const responseText = (raw?.candidates || [])
      .flatMap(candidate => candidate?.content?.parts || [])
      .map(part => part?.text)
      .filter(Boolean)
      .join('\n');
    return parseJson(responseText);
  }
  async function aiGenerateFullDay(date, provider, appointments) {
    const ctx = contextForGeneration(date, provider, appointments, false);
    const prompt = [
      '请为当前角色规划一天真实、连贯、不过度围绕用户的行程。只输出 JSON 对象，不要解释。',
      `日期：${date}；角色当地时区：${localClock().timezone || '未知'}；行程密度：${settings.density}`,
      '输出格式：{"items":[{"start":"HH:MM","end":"HH:MM","title":"简短标题","description":"具体但简洁的内容","type":"work|training|meal|rest|travel|social|task|appointment|racing|daily","private":false}]}',
      '规则：时间不能重叠；必须保留吃饭、休息和通勤空间；不要把角色排成全天围着用户转；未确定的危险任务、比赛名次或事故不能凭空写死；内容须符合角色身份、天气、既有约定和当前赛事。',
      appointments.length ? `已锁定约定：${appointments.map(item => `${item.start}-${item.end} ${item.title}`).join('；')}` : '',
      ctx.constraints, ctx.role, ctx.weather, ctx.memory, ctx.timeline, ctx.r1
    ].filter(Boolean).join('\n\n');
    const parsed = await callGemini(prompt, 2200);
    if (!Array.isArray(parsed.items)) throw new Error('AI 行程缺少 items');
    return parsed.items.map((item, index) => normalizeItem(Object.assign({}, item, { source: 'ai' }), index));
  }
  async function aiGenerateNextItem(date, provider, day) {
    const clock = localClock();
    const nowMinutes = timeMinutes(clock.time);
    const start = timeString(Math.min(1439, nowMinutes));
    const end = timeString(Math.min(1439, nowMinutes + settings.onDemandBlockMinutes));
    const ctx = contextForGeneration(date, provider, [], true);
    const previous = (day?.items || []).slice(-3).map(item => `${item.start}-${item.end} ${item.title}（${item.status}）`).join('；');
    const prompt = [
      '请只生成当前时间开始的下一项角色行程，只输出 JSON 对象，不要解释。',
      `日期：${date}；当地当前时间：${clock.time}；建议时间范围：${start}-${end}`,
      '输出格式：{"item":{"start":"HH:MM","end":"HH:MM","title":"简短标题","description":"具体但简洁的内容","type":"work|training|meal|rest|travel|social|task|appointment|racing|daily","private":false}}',
      '规则：这项活动必须符合当前时间、角色身份、天气、最近发生的事和赛事；不要凭空制造事故、伤亡、比赛名次或重大剧情；不要让角色无缘无故一直围着用户。',
      previous ? `今天先前行程：${previous}` : '',
      ctx.constraints, ctx.role, ctx.weather, ctx.memory, ctx.timeline, ctx.r1
    ].filter(Boolean).join('\n\n');
    const parsed = await callGemini(prompt, 900);
    if (!parsed.item) throw new Error('AI 未返回下一项行程');
    return normalizeItem(Object.assign({}, parsed.item, { source: 'ai-on-demand' }));
  }

  async function generateDay(options = {}) {
    if (generating) throw new Error('正在生成行程');
    if (!characterReady()) throw new Error('请先打开一个角色聊天');
    const clock = localClock();
    const scope = scopeKey(options.scope);
    const date = options.date || clock.date;
    const chat = currentChat();
    const provider = resolveProvider({ date, scope, roleId: roleId(), chat });
    const existing = getDay({ scope, date });
    const locked = [
      ...(existing?.items || []).filter(item => item.locked),
      ...await appointmentsFor(date, chat.id)
    ];

    generating = true;
    emit('eve:schedule-generation-start', { scope, date, mode: settings.mode });
    try {
      if (settings.mode === 'on-demand' && !options.fullDay) {
        const baseDay = existing
          ? Object.assign({}, existing, { items: options.force ? existing.items.filter(item => item.locked) : existing.items.slice() })
          : {
              scope, date, timezone: clock.timezone, mode: settings.mode,
              generatedAt: Date.now(), items: [], source: 'on-demand'
            };
        let item = null;
        if (settings.useAiGeneration && !options.localOnly) {
          try { item = await aiGenerateNextItem(date, provider, baseDay); }
          catch (error) { log('到点 AI 生成失败，使用本地规则', error); }
        }
        if (!item) {
          const candidates = provider?.generateFallback?.({
            date, settings: getSettings(), chat,
            r1State: window.EVEXiaoYiR1?.getState?.(), weather: window.EVEWeather?.getEnvironment?.()
          }) || genericFallback();
          const nowValue = timeMinutes(clock.time);
          item = candidates.map(normalizeItem).find(candidate => timeMinutes(candidate.end) > nowValue) || normalizeItem({
            start: clock.time,
            durationMinutes: settings.onDemandBlockMinutes,
            title: '处理当前事务',
            description: '根据当天情况处理接下来的安排',
            type: 'daily', source: 'fallback-on-demand'
          });
          if (timeMinutes(item.start) < nowValue) {
            const duration = Math.max(30, timeMinutes(item.end) - timeMinutes(item.start));
            item.start = clock.time;
            item.end = timeString(nowValue + duration);
          }
        }
        const overlap = baseDay.items.some(existingItem =>
          existingItem.status !== 'cancelled' &&
          timeMinutes(existingItem.start) < timeMinutes(item.end) &&
          timeMinutes(existingItem.end) > timeMinutes(item.start)
        );
        if (!overlap) baseDay.items.push(item);
        baseDay.items = mergeLocked(baseDay.items.map(normalizeItem), locked);
        baseDay.source = item.source.startsWith('ai') ? 'ai-on-demand' : 'fallback-on-demand';
        const saved = saveDay(baseDay);
        emit('eve:schedule-generation-complete', { day: saved, mode: 'on-demand' });
        return saved;
      }

      let items = [];
      if (settings.useAiGeneration && !options.localOnly) {
        try { items = await aiGenerateFullDay(date, provider, locked); }
        catch (error) { log('AI 行程生成失败，使用本地规则', error); }
      }
      if (!items.length) {
        items = provider?.generateFallback?.({
          date, settings: getSettings(), chat,
          r1State: window.EVEXiaoYiR1?.getState?.(), weather: window.EVEWeather?.getEnvironment?.()
        }) || genericFallback();
      }
      items = mergeLocked(items.map(normalizeItem), locked);
      const day = saveDay({
        scope, date, timezone: clock.timezone, mode: settings.mode,
        generatedAt: Date.now(), items,
        source: items.some(item => item.source === 'ai') ? 'ai' : 'fallback'
      });
      emit('eve:schedule-generation-complete', { day, mode: settings.mode });
      return day;
    } finally { generating = false; }
  }

  async function expandItem(day, item) {
    if (!settings.detailAtStart || item.description || !settings.useAiGeneration) return item;
    const provider = resolveProvider({ roleId: roleId(), chat: currentChat() });
    try {
      const generated = await aiGenerateNextItem(day.date, provider, day);
      if (generated) {
        item.title = generated.title || item.title;
        item.description = generated.description || item.description;
        item.type = generated.type || item.type;
        item.source = 'ai-at-start';
      }
    } catch (error) { log('到点细化失败', error); }
    return item;
  }
  async function fireStart(day, item) {
    if (item.notified && item.timelineRecorded && (!settings.proactiveOnStart || item.proactiveSent)) return;
    await expandItem(day, item);
    emit('eve:schedule-item-started', { day: clone(day), item: clone(item) });

    if (settings.timelineOnStart && !item.timelineRecorded && window.EVETimeline?.addEvent) {
      try {
        window.EVETimeline.addEvent({
          scope: day.scope,
          type: 'schedule-start',
          title: item.title,
          description: item.description,
          importance: item.type === 'racing' || item.type === 'appointment' ? 3 : 2,
          tags: ['schedule', item.type],
          source: 'daily-schedule'
        });
        item.timelineRecorded = true;
      } catch (_) {}
    }
    if (settings.notifyOnStart && !item.notified && window.EVENotifications?.show) {
      try {
        await window.EVENotifications.show({
          title: currentChat().name || 'EVE Chat',
          body: `现在：${item.title}`,
          type: 'schedule',
          tag: `schedule-${day.scope}-${day.date}-${item.id}`
        });
        item.notified = true;
      } catch (_) {}
    }
    if (settings.proactiveOnStart && !item.proactiveSent && window.EVEAdapter?.requestProactiveMessage) {
      try {
        await window.EVEAdapter.requestProactiveMessage({
          reason: 'schedule-start',
          activity: { label: item.title },
          promptContext: [
            '【行程刚开始】',
            `角色现在开始：${item.title}`,
            item.description || '',
            '只有在自然且值得主动联系使用者时才发送消息；可以简短分享正在做的事，不要像行程播报员'
          ].filter(Boolean).join('\n')
        });
        item.proactiveSent = true;
      } catch (_) {}
    }
  }

  async function tick(options = {}) {
    if (!settings.enabled || !characterReady()) return null;
    const clock = localClock();
    const scope = scopeKey();
    const date = clock.date;
    const nowValue = timeMinutes(clock.time);
    const generateAt = timeMinutes(settings.generateTime);
    let day = getDay({ scope, date });

    if (!day && settings.autoGenerate && (nowValue >= generateAt || options.forceGenerate)) {
      day = await generateDay({ scope, date, fullDay: settings.mode !== 'on-demand' });
    }
    if (!day) return null;

    if (settings.mode === 'on-demand') {
      const active = currentItem(day);
      const upcoming = nextItem(day);
      if (!active && (!upcoming || timeMinutes(upcoming.start) - nowValue > 10)) {
        day = await generateDay({ scope, date, fullDay: false });
      }
    }

    let changed = false;
    for (const item of day.items) {
      if (item.status === 'cancelled') continue;
      const start = timeMinutes(item.start);
      const end = timeMinutes(item.end);
      const previous = item.status;
      if (nowValue >= end) {
        if (['active', 'planned', 'adjusted'].includes(item.status)) {
          item.status = 'completed';
          item.completedAt = Date.now();
        }
      } else if (nowValue >= start && nowValue < end) {
        if (['planned', 'adjusted'].includes(item.status)) {
          item.status = 'active';
          item.startedAt = Date.now();
          await fireStart(day, item);
        }
      } else if (item.status === 'active') {
        item.status = 'planned';
      }
      if (previous !== item.status) changed = true;
    }
    if (changed || day.items.some(item => item.status === 'active' && (!item.timelineRecorded || (settings.notifyOnStart && !item.notified)))) {
      saveDay(day);
    }
    return clone(day);
  }
  function restartTimer() {
    if (timer) clearInterval(timer);
    timer = null;
    if (!settings.enabled) return;
    timer = setInterval(() => tick().catch(error => log('行程检查失败', error)), settings.refreshSeconds * 1000);
  }

  function getPromptContext(meta = {}) {
    if (!settings.enabled) return '';
    const day = getDay({ scope: meta.chat?.scope });
    if (!day) return '';
    const active = currentItem(day);
    const upcoming = nextItem(day);
    const scene = window.EVESceneState?.getState?.(meta.chat?.scope);
    return [
      '【角色今日行程】',
      `日期：${day.date}`,
      active ? `当前行程：${active.start}-${active.end} ${active.title}${active.description ? `｜${active.description}` : ''}` : '当前没有进行中的行程',
      upcoming ? `下一项：${upcoming.start} ${upcoming.title}` : '今天后面没有已规划行程',
      scene?.currentEvent || scene?.currentActivity ? '当前场景状态优先于预设行程；若冲突，应自然调整行程，不要让角色同时出现在两个地方' : '',
      '行程是角色的生活背景，不是机械拒绝聊天的理由。忙碌时可以回复较短或说明稍后再聊；面对面剧情与最新明确情境优先',
      '不要逐条向使用者汇报整张行程，除非使用者主动询问'
    ].filter(Boolean).join('\n');
  }
  function bindAdapter() {
    if (adapterBound || !window.EVEAdapter?.registerContextProvider) return false;
    window.EVEAdapter.registerContextProvider('daily-schedule', getPromptContext, { priority: 12 });
    adapterBound = true;
    return true;
  }

  function addItem(raw, options = {}) {
    const clock = localClock();
    const scope = scopeKey(options.scope);
    const date = options.date || clock.date;
    let day = getDay({ scope, date }) || {
      scope, date, timezone: clock.timezone, mode: settings.mode,
      generatedAt: Date.now(), items: [], source: 'manual'
    };
    const item = normalizeItem(Object.assign({}, raw, { source: raw.source || 'manual' }), day.items.length);
    day.items.push(item);
    saveDay(day);
    return clone(item);
  }
  function updateItem(id, patch, options = {}) {
    const day = getDay(options);
    if (!day) return false;
    const item = day.items.find(entry => String(entry.id) === String(id));
    if (!item) return false;
    Object.assign(item, patch || {});
    saveDay(day);
    return clone(item);
  }
  function removeItem(id, options = {}) {
    const day = getDay(options);
    if (!day) return false;
    const before = day.items.length;
    day.items = day.items.filter(entry => String(entry.id) !== String(id));
    if (day.items.length === before) return false;
    saveDay(day);
    return true;
  }
  function clearDay(options = {}) {
    const clock = localClock();
    const scope = scopeKey(options.scope);
    const date = options.date || clock.date;
    delete store.days[dayKey(scope, date)];
    persist();
    emit('eve:schedule-day-cleared', { scope, date });
    return true;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }
  function openManager() {
    manager?.remove();
    const overlay = document.createElement('div');
    manager = overlay;
    overlay.id = 'eve-daily-schedule-manager';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#0008;display:flex;align-items:center;justify-content:center;padding:12px';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:min(720px,100%);max-height:94vh;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 18px 60px #0006';
    panel.innerHTML = `<div style="display:flex;align-items:center;gap:7px;padding:14px 16px;border-bottom:1px solid #ddd"><b style="flex:1">角色今日行程</b><button data-generate>重新生成</button><button data-add>＋</button><button data-close>✕</button></div><div data-head style="padding:9px 14px;font-size:12px;opacity:.7;border-bottom:1px solid #ddd"></div><div data-list style="overflow:auto;min-height:300px"></div><div style="display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid #ddd"><button data-settings>行程设置</button><button data-clear style="color:#c33">清空今天</button></div>`;
    overlay.append(panel);
    document.body.append(overlay);

    const labels = { planned: '计划中', active: '进行中', completed: '已完成', adjusted: '已调整', cancelled: '已取消', missed: '错过' };
    const render = () => {
      const clock = localClock();
      const day = getDay();
      const list = panel.querySelector('[data-list]');
      panel.querySelector('[data-head]').textContent = `${clock.date}｜${currentChat().name || '当前角色'}｜${day?.source || '尚未生成'}｜当前 ${clock.time}`;
      list.innerHTML = '';
      if (!day?.items?.length) {
        list.innerHTML = '<div style="padding:60px;text-align:center;opacity:.6">今天还没有行程，点击“重新生成”</div>';
        return;
      }
      for (const item of day.items) {
        const row = document.createElement('div');
        const color = item.status === 'active' ? '#28a745' : item.status === 'completed' ? '#888' : item.status === 'cancelled' ? '#c33' : '#4a84c1';
        row.style.cssText = 'display:grid;grid-template-columns:86px 1fr auto;gap:9px;padding:11px 14px;border-bottom:1px solid #ddd;align-items:center';
        row.innerHTML = `<b style="color:${color}">${escapeHtml(item.start)}-${escapeHtml(item.end)}</b><div><div><b>${escapeHtml(item.title)}</b> ${item.locked ? '🔒' : ''}${item.private ? ' 🔐' : ''}</div><small style="opacity:.68">${escapeHtml(item.description || item.type)}｜${escapeHtml(labels[item.status] || item.status)}</small></div><div style="display:flex;gap:4px"><button data-edit>编辑</button><button data-delete>删</button></div>`;
        row.querySelector('[data-edit]').onclick = () => {
          const title = prompt('行程标题', item.title); if (title === null) return;
          const start = prompt('开始时间 HH:MM', item.start); if (start === null) return;
          const end = prompt('结束时间 HH:MM', item.end); if (end === null) return;
          const description = prompt('说明', item.description); if (description === null) return;
          updateItem(item.id, {
            title: clean(title, 100), start: normalizeTime(start, item.start), end: normalizeTime(end, item.end),
            description: clean(description, 500), locked: confirm('是否锁定这项行程，禁止 AI 重生成时覆盖？')
          });
          render();
        };
        row.querySelector('[data-delete]').onclick = () => { if (confirm('删除这项行程？')) { removeItem(item.id); render(); } };
        list.append(row);
      }
    };
    const close = () => overlay.remove();
    panel.querySelector('[data-close]').onclick = close;
    overlay.onclick = event => { if (event.target === overlay) close(); };
    panel.querySelector('[data-generate]').onclick = async () => {
      const button = panel.querySelector('[data-generate]');
      try {
        button.disabled = true;
        await generateDay({ force: true, fullDay: settings.mode !== 'on-demand' });
        render(); toast('今日行程已生成');
      } catch (error) { toast(error.message || String(error), 'error'); }
      finally { button.disabled = false; }
    };
    panel.querySelector('[data-add]').onclick = () => {
      const title = prompt('行程标题'); if (!title) return;
      const start = prompt('开始时间 HH:MM', '19:00'); if (start === null) return;
      const end = prompt('结束时间 HH:MM', '20:00'); if (end === null) return;
      addItem({ title, start, end, locked: true }); render();
    };
    panel.querySelector('[data-clear]').onclick = () => { if (confirm('清空今天的行程？')) { clearDay(); render(); } };
    panel.querySelector('[data-settings]').onclick = () => openSettings();
    render();
  }
  function openSettings() {
    document.getElementById('eve-schedule-settings-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'eve-schedule-settings-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000000;background:#0008;display:flex;align-items:center;justify-content:center;padding:12px';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:min(560px,100%);max-height:92vh;overflow:auto;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;padding:16px';
    panel.innerHTML = `<h3>角色行程表设置</h3>
      <label>生成模式<select data-mode style="width:100%;padding:8px"><option value="full-day">整日规划</option><option value="on-demand">到点生成</option><option value="hybrid">混合模式</option></select></label><br><br>
      <label>每日生成时间<input data-time type="time" value="${settings.generateTime}" style="width:100%;padding:8px"></label><br><br>
      <label>行程密度<select data-density style="width:100%;padding:8px"><option value="light">轻松</option><option value="normal">正常</option><option value="busy">忙碌</option></select></label><br><br>
      <label>到点生成每段时长（分钟）<input data-block type="number" min="30" max="240" value="${settings.onDemandBlockMinutes}" style="width:100%;padding:8px"></label>
      <div style="line-height:2;margin-top:10px">
        <label><input data-ai type="checkbox" ${settings.useAiGeneration ? 'checked' : ''}> 使用 Gemini 生成行程，失败时自动使用本地规则</label><br>
        <label><input data-detail type="checkbox" ${settings.detailAtStart ? 'checked' : ''}> 到点时再细化当前行程</label><br>
        <label><input data-weather type="checkbox" ${settings.useWeather ? 'checked' : ''}> 参考当地天气</label><br>
        <label><input data-memory type="checkbox" ${settings.useMemory ? 'checked' : ''}> 参考记忆与最近对话</label><br>
        <label><input data-appointments type="checkbox" ${settings.useAppointments ? 'checked' : ''}> 参考原有约定</label><br>
        <label><input data-r1 type="checkbox" ${settings.useR1 ? 'checked' : ''}> 参考 R1 赛事</label><br>
        <label><input data-notify type="checkbox" ${settings.notifyOnStart ? 'checked' : ''}> 行程开始时通知</label><br>
        <label><input data-proactive type="checkbox" ${settings.proactiveOnStart ? 'checked' : ''}> 行程开始时允许角色主动消息</label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button data-cancel>取消</button><button data-save style="background:#4a84c1;color:white;border:0;border-radius:8px;padding:8px 16px">保存</button></div>`;
    panel.querySelector('[data-mode]').value = settings.mode;
    panel.querySelector('[data-density]').value = settings.density;
    overlay.append(panel); document.body.append(overlay);
    const close = () => overlay.remove();
    panel.querySelector('[data-cancel]').onclick = close;
    overlay.onclick = event => { if (event.target === overlay) close(); };
    panel.querySelector('[data-save]').onclick = () => {
      configure({
        mode: panel.querySelector('[data-mode]').value,
        generateTime: panel.querySelector('[data-time]').value,
        density: panel.querySelector('[data-density]').value,
        onDemandBlockMinutes: panel.querySelector('[data-block]').value,
        useAiGeneration: panel.querySelector('[data-ai]').checked,
        detailAtStart: panel.querySelector('[data-detail]').checked,
        useWeather: panel.querySelector('[data-weather]').checked,
        useMemory: panel.querySelector('[data-memory]').checked,
        useAppointments: panel.querySelector('[data-appointments]').checked,
        useR1: panel.querySelector('[data-r1]').checked,
        notifyOnStart: panel.querySelector('[data-notify]').checked,
        proactiveOnStart: panel.querySelector('[data-proactive]').checked
      });
      close(); toast('行程设置已保存');
    };
  }

  function bindEvents() {
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible' && settings.catchUpAfterResume) tick({ forceGenerate: true }).catch(log);
    });
    on(window, 'eve:environment-updated', () => tick().catch(log));
    on(window, 'eve:scene-state-updated', () => tick().catch(log));
    on(window, 'eve:xiaoyi-r1-updated', () => {
      if (!settings.useR1 || settings.mode === 'on-demand' || !characterReady()) return;
      const activeRole = roleId();
      if (activeRole !== 'xiaoyi' && !/萧逸|osborn/i.test(currentChat().name || '')) return;
      generateDay({ force: true, fullDay: true }).catch(error => log('R1更新后重排行程失败', error));
    });
  }
  function getDiagnostics() {
    const day = getDay();
    return {
      version: VERSION,
      initialized,
      adapterBound,
      generating,
      settings: getSettings(),
      providers: [...providers.keys()],
      today: day,
      current: clone(currentItem(day || { items: [] })),
      next: clone(nextItem(day || { items: [] }))
    };
  }
  function init() {
    if (initialized) return Promise.resolve(getDiagnostics());
    initialized = true;
    bindEvents();
    if (!bindAdapter()) {
      const retry = setInterval(() => { if (bindAdapter()) clearInterval(retry); }, 500);
      setTimeout(() => clearInterval(retry), 30000);
    }
    restartTimer();
    setTimeout(() => tick({ forceGenerate: settings.catchUpAfterResume }).catch(log), 1000);
    window.EVE ||= {};
    window.EVE.dailySchedule = window.EVEDailySchedule;
    emit('eve:schedule-ready', getDiagnostics());
    return Promise.resolve(getDiagnostics());
  }
  function destroy() {
    if (timer) clearInterval(timer);
    timer = null;
    disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} });
    manager?.remove(); manager = null;
    initialized = false;
  }

  window.EVEDailySchedule = Object.freeze({
    version: VERSION,
    init, destroy, configure, getSettings,
    registerProvider, resolveProvider,
    generateDay, tick, getDay, currentItem, nextItem,
    addItem, updateItem, removeItem, clearDay,
    getPromptContext, openManager, openSettings, getDiagnostics
  });

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init, { once: true })
    : init();
})(window, document);
