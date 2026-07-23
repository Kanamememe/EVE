/**
 * EVE Character Diary Core v1.5.0
 * Per-character diary with AI/manual entries, mood, privacy and daily catch-up.
 */
(function (window, document) {
  'use strict';
  if (window.EVEDiary?.version) return;

  const VERSION = '1.5.4';
  const DB_NAME = 'EVEChat_Diary_v1';
  const STORE = 'entries';
  const SETTINGS_KEY = 'eve_diary_settings_v15';
  const FALLBACK_KEY = 'eve_diary_entries_fallback_v153';
  const DEFAULTS = Object.freeze({
    enabled: true,
    autoGenerate: true,
    generateTime: '23:50',
    catchUpDays: 7,
    defaultPrivacy: 'private',
    includeChat: true,
    includeTimeline: true,
    includeSchedule: true,
    includeWeather: true,
    promptEnabled: true,
    maxPromptEntries: 5,
    reminderEnabled: true,
    reminderMinutesBefore: 10
  });

  let settings = loadSettings();
  let dbPromise = null;
  let initialized = false;
  let timer = null;
  const listeners = [];

  function clean(value, max = 2000) { return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max); }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function readFallback() { try { const value=JSON.parse(localStorage.getItem(FALLBACK_KEY)||'[]'); return Array.isArray(value)?value:[]; } catch (_) { return []; } }
  function writeFallback(items) { try { localStorage.setItem(FALLBACK_KEY, JSON.stringify(items||[])); return true; } catch (_) { return false; } }
  function fallbackUpsert(item) { const items=readFallback(); const index=items.findIndex(x=>x.id===item.id); if(index>=0)items[index]=item;else items.push(item); writeFallback(items); }
  function loadSettings() { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (_) { return Object.assign({}, DEFAULTS); } }
  function saveSettings(next = {}) {
    settings = Object.assign({}, settings, next || {});
    settings.enabled = Boolean(settings.enabled);
    settings.autoGenerate = Boolean(settings.autoGenerate);
    settings.catchUpDays = Math.max(0, Math.min(31, Number(settings.catchUpDays) || 7));
    settings.maxPromptEntries = Math.max(0, Math.min(20, Number(settings.maxPromptEntries) || 5));
    settings.defaultPrivacy = ['private','shared'].includes(settings.defaultPrivacy) ? settings.defaultPrivacy : 'private';
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    emit('eve:diary-settings-updated', { settings:getSettings() });
    return getSettings();
  }
  function getSettings() { return Object.assign({}, settings); }
  function emit(name, detail = {}) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} }
  function bind(target, event, handler) { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath:'id' });
          store.createIndex('scope', 'scope', { unique:false });
          store.createIndex('date', 'date', { unique:false });
          store.createIndex('scopeDate', ['scope','date'], { unique:false });
          store.createIndex('createdAt', 'createdAt', { unique:false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('日记数据库打开失败'));
    });
    return dbPromise;
  }
  async function requestResult(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  async function transaction(mode, callback) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode); const store = tx.objectStore(STORE);
      let result;
      try { result = callback(store, tx); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('日记数据库操作失败'));
      tx.onabort = () => reject(tx.error || new Error('日记数据库操作已取消'));
    });
  }

  function currentChat() { return window.EVEAdapter?.getCurrentChat?.() || { id:'', name:'角色', scope:'global', open:false }; }
  function scopeKey(scope) {
    const chat = currentChat();
    return clean(scope || chat.scope || (chat.id ? `character:${chat.id}` : 'global'), 220) || 'global';
  }
  function roleName() { return clean(currentChat().name || '角色', 80) || '角色'; }
  function localDate(offset = 0) {
    const env = window.EVEWeather?.getEnvironment?.();
    const value = env?.character?.localDate || env?.localDate;
    const base = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Date(`${value}T12:00:00`) : new Date();
    base.setDate(base.getDate() + offset);
    return `${base.getFullYear()}-${String(base.getMonth()+1).padStart(2,'0')}-${String(base.getDate()).padStart(2,'0')}`;
  }
  function startOfDate(date) { return new Date(`${date}T00:00:00`).getTime(); }
  function endOfDate(date) { return new Date(`${date}T23:59:59.999`).getTime(); }
  function makeId(scope, date, source = 'ai') { return `diary_${source}_${Math.abs(hash(scope))}_${date}_${Date.now().toString(36)}`; }
  function hash(value) { let h=0; for (const ch of String(value)) h=((h<<5)-h+ch.charCodeAt(0))|0; return h; }
  function normalize(entry = {}) {
    const now = Date.now();
    return {
      id: clean(entry.id || makeId(scopeKey(entry.scope), entry.date || localDate(), entry.source || 'manual'), 240),
      scope: scopeKey(entry.scope),
      characterId: clean(entry.characterId || currentChat().id || '', 160),
      characterName: clean(entry.characterName || roleName(), 80),
      date: /^\d{4}-\d{2}-\d{2}$/.test(entry.date || '') ? entry.date : localDate(),
      title: clean(entry.title || '今天', 120),
      content: clean(entry.content || '', 12000),
      mood: clean(entry.mood || '平静', 40),
      moodReason: clean(entry.moodReason || '', 500),
      privacy: ['private','shared'].includes(entry.privacy) ? entry.privacy : settings.defaultPrivacy,
      source: clean(entry.source || 'manual', 40),
      images: Array.isArray(entry.images) ? entry.images.slice(0,9).map(v => clean(v, 8_000_000)).filter(Boolean) : [],
      sourceSummary: clean(entry.sourceSummary || '', 3000),
      createdAt: Number(entry.createdAt) || now,
      updatedAt: now,
      generatedAt: Number(entry.generatedAt) || 0,
      locked: Boolean(entry.locked)
    };
  }
  async function save(entry) {
    const item = normalize(entry);
    try { await transaction('readwrite', store => store.put(item)); }
    catch (error) { fallbackUpsert(item); emit('eve:diary-storage-fallback', { operation:'save', error:String(error?.message||error) }); }
    emit('eve:diary-updated', { entry:clone(item), scope:item.scope, date:item.date });
    return clone(item);
  }
  async function get(id) {
    try { const db = await openDB(); const tx = db.transaction(STORE, 'readonly'); return clone(await requestResult(tx.objectStore(STORE).get(id)) || null); }
    catch (_) { return clone(readFallback().find(item=>item.id===String(id)) || null); }
  }
  async function list(options = {}) {
    const scope = scopeKey(options.scope);
    let items=[];
    try { const db = await openDB(); const tx = db.transaction(STORE, 'readonly'); items = await requestResult(tx.objectStore(STORE).getAll()) || []; }
    catch (error) { items=readFallback(); emit('eve:diary-storage-fallback', { operation:'list', error:String(error?.message||error) }); }
    items = (items || []).filter(item => item.scope === scope);
    if (options.date) items = items.filter(item => item.date === options.date);
    if (options.query) {
      const q = clean(options.query, 100).toLowerCase();
      items = items.filter(item => `${item.title}
${item.content}
${item.mood}
${item.moodReason}`.toLowerCase().includes(q));
    }
    return items.sort((a,b) => (b.date.localeCompare(a.date)) || (b.createdAt-a.createdAt)).slice(0, Number(options.limit) || 500).map(clone);
  }
  async function remove(id) {
    const value=String(id);
    try { await transaction('readwrite', store => store.delete(value)); }
    catch (_) { writeFallback(readFallback().filter(item=>item.id!==value)); }
    emit('eve:diary-removed', { id:value });
  }
  async function clear(scope) {
    const items = await list({ scope, limit:5000 });
    try { await transaction('readwrite', store => items.forEach(item => store.delete(item.id))); }
    catch (_) { const ids=new Set(items.map(item=>item.id)); writeFallback(readFallback().filter(item=>!ids.has(item.id))); }
    emit('eve:diary-cleared', { scope:scopeKey(scope), count:items.length });
    return items.length;
  }
  async function exportData(scope) { return { version:VERSION, settings:getSettings(), entries:await list({ scope, limit:5000 }) }; }
  async function importData(payload = {}, options = {}) {
    const entries = Array.isArray(payload) ? payload : Array.isArray(payload.entries) ? payload.entries : [];
    if (options.replace) await clear(options.scope);
    for (const entry of entries) await save(entry);
    if (payload.settings && options.importSettings !== false) saveSettings(payload.settings);
    emit('eve:diary-imported', { count:entries.length });
    return entries.length;
  }

  function chatMessagesForDate(date) {
    if (!settings.includeChat) return [];
    try {
      const chat = currentChat();
      let all = window.chatMessages || {};
      try { if (typeof chatMessages !== 'undefined') all = chatMessages; } catch (_) {}
      const source = all?.[chat.id] || [];
      const from = startOfDate(date), to = endOfDate(date);
      return source.filter(item => {
        const ts = Number(item.timestamp || item.createdAt || item.time || 0);
        return ts >= from && ts <= to;
      }).slice(-40).map(item => ({ sender:item.sender || item.role || '', text:clean(item.text || item.content || item.message || '', 500) })).filter(item => item.text);
    } catch (_) { return []; }
  }
  function timelineForDate(date) {
    if (!settings.includeTimeline) return [];
    try { return window.EVETimeline?.list?.({ scope:scopeKey(), includeGlobal:true, from:startOfDate(date), to:endOfDate(date), limit:30 }) || []; }
    catch (_) { return []; }
  }
  function scheduleForDate(date) {
    if (!settings.includeSchedule) return [];
    try { return window.EVEDailySchedule?.getDay?.({ scope:scopeKey(), date })?.items || []; }
    catch (_) { return []; }
  }
  function sourceContext(date) {
    const chat = chatMessagesForDate(date);
    const timeline = timelineForDate(date);
    const schedule = scheduleForDate(date);
    const weather = settings.includeWeather ? (window.EVEWeather?.getPromptContext?.() || '') : '';
    const role = window.EVERoleFidelity?.getPromptContext?.({ feature:'diary', scene:'diary', chat:currentChat(), userText:'' }) || '';
    const lines = [];
    if (schedule.length) lines.push(`【当天行程】\n${schedule.map(i => `- ${i.start || ''}-${i.end || ''} ${i.title}${i.status ? `（${i.status}）` : ''}${i.description ? `：${i.description}` : ''}`).join('\n')}`);
    if (timeline.length) lines.push(`【当天时间线】\n${timeline.map(i => `- ${i.title}${i.description ? `：${i.description}` : ''}`).join('\n')}`);
    if (chat.length) lines.push(`【当天聊天摘录】\n${chat.map(i => `- ${i.sender}: ${i.text}`).join('\n')}`);
    if (weather) lines.push(weather);
    return { chat, timeline, schedule, weather, role, text:lines.join('\n\n') };
  }

  function getApiSettings() {
    try { if (typeof apiSettings !== 'undefined' && apiSettings) return apiSettings; } catch (_) {}
    return window.apiSettings || null;
  }
  async function callGemini(prompt) {
    const api = getApiSettings();
    const base = clean(api?.base || '', 500).replace(/\/+$/,'');
    const model = clean(api?.model || '', 150).replace(/^models\//,'');
    if (!/generativelanguage\.googleapis\.com/i.test(base) || !api?.key || !model) throw new Error('当前 API 无法用于日记生成');
    const endpoint = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(api.key)}`;
    const transport = window.EVEAdapter?.rawFetch || window.fetch.bind(window);
    const response = await transport(endpoint, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        contents:[{role:'user',parts:[{text:prompt.slice(0,28000)}]}],
        generationConfig:{temperature:0.72,maxOutputTokens:1800,responseMimeType:'application/json'}
      })
    });
    const raw = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(raw?.error?.message || `日记生成失败：${response.status}`);
    const text = (raw?.candidates || []).flatMap(c => c?.content?.parts || []).map(p => p?.text).filter(Boolean).join('\n');
    const source = String(text || '').replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
    try { return JSON.parse(source); } catch (_) {
      const match = source.match(/\{[\s\S]*\}/); if (match) return JSON.parse(match[0]);
      throw new Error('AI 未返回有效日记 JSON');
    }
  }
  function fallbackDiary(date, ctx) {
    const completed = ctx.schedule.filter(i => ['completed','active','adjusted'].includes(i.status));
    const lines = [];
    if (completed.length) lines.push(`今天完成了${completed.slice(0,4).map(i => i.title).join('、')}`);
    if (ctx.timeline.length) lines.push(ctx.timeline.slice(0,3).map(i => i.title).join('。'));
    if (!lines.length && ctx.chat.length) lines.push('今天和你聊了一会儿');
    if (!lines.length) lines.push('今天很安静，没发生什么特别的事');
    return { title:'今天', content:lines.join('\n\n'), mood:'平静', moodReason:'根据今天留下的记录整理', privacy:settings.defaultPrivacy };
  }
  async function generate(options = {}) {
    if (!settings.enabled) throw new Error('日记功能已关闭');
    const date = options.date || localDate();
    const scope = scopeKey(options.scope);
    const existing = await list({ scope, date, limit:20 });
    const autoExisting = existing.find(item => item.source === 'ai');
    if (autoExisting && !options.force) return autoExisting;
    const ctx = sourceContext(date);
    let parsed;
    try {
      const prompt = [
        `你是${roleName()}本人，请根据当天真实记录写一篇私人日记。`,
        '不要虚构当天没有发生的重大事件、比赛结果、伤病、冲突或用户行为。没有资料时宁可写得简短。',
        '这不是聊天回复，不要向用户提问，不要提及AI、系统、资料来源或生成过程。',
        '保留角色性格和第一人称视角。日记可以比聊天稍完整，但避免华丽散文和心理分析报告。',
        '只输出JSON：{"title":"简短标题","content":"正文","mood":"开心|平静|放松|疲惫|烦躁|难过|紧张|期待|复杂","moodReason":"一句原因","privacy":"private|shared"}',
        `日期：${date}`,
        ctx.role,
        ctx.text || '当天没有可用记录'
      ].filter(Boolean).join('\n\n');
      parsed = await callGemini(prompt);
    } catch (error) {
      console.warn('[EVEDiary] AI生成失败，使用本地整理：', error);
      parsed = fallbackDiary(date, ctx);
    }
    if (autoExisting) await remove(autoExisting.id);
    return save({
      scope, date, title:parsed.title || '今天', content:parsed.content || '', mood:parsed.mood || '平静',
      moodReason:parsed.moodReason || '', privacy:parsed.privacy || settings.defaultPrivacy,
      source:'ai', generatedAt:Date.now(), sourceSummary:ctx.text.slice(0,3000)
    });
  }

  async function getPromptContext(meta = {}) {
    if (!settings.enabled || !settings.promptEnabled || !settings.maxPromptEntries) return '';
    const query = clean(meta.userText || meta.query || '', 300).toLowerCase();
    let items = await list({ scope:meta.scope || meta.chat?.scope, limit:80 });
    if (query) {
      const words = query.split(/\s+/).filter(Boolean);
      items = items.map(item => ({ item, score:words.reduce((s,w) => s + (`${item.title} ${item.content} ${item.mood}`.toLowerCase().includes(w) ? 1 : 0), 0) }))
        .sort((a,b) => b.score-a.score || b.item.date.localeCompare(a.item.date)).map(x => x.item);
    }
    items = items.slice(0, settings.maxPromptEntries);
    if (!items.length) return '';
    const lines = ['【角色日记回忆】'];
    items.forEach(item => lines.push(`- ${item.date}｜${item.title}｜心情：${item.mood}｜${item.content.slice(0,260)}`));
    lines.push('这些是角色自己写下的日记。仅在当前话题自然相关时引用，不要逐条复述，也不要把日记内容误当成用户刚说的话。');
    return lines.join('\n');
  }

  async function checkAutoGenerate() {
    if (!settings.enabled || !settings.autoGenerate || !currentChat().id) return;
    const now = new Date(); const [h,m] = String(settings.generateTime || '23:50').split(':').map(Number);
    const today = localDate();
    if (now.getHours()*60 + now.getMinutes() >= h*60 + m) {
      const existing = await list({ date:today, limit:20 });
      if (!existing.some(item => item.source === 'ai')) await generate({ date:today }).catch(() => {});
    }
    for (let offset=1; offset<=settings.catchUpDays; offset++) {
      const date = localDate(-offset); const existing = await list({ date, limit:20 });
      if (!existing.length) {
        const ctx = sourceContext(date);
        if (ctx.chat.length || ctx.timeline.length || ctx.schedule.length) await generate({ date }).catch(() => {});
      }
    }
  }

  function diagnostics() { return { version:VERSION, initialized, settings:getSettings(), db:DB_NAME, scope:scopeKey(), character:currentChat().name || '' }; }
  async function init() {
    if (initialized) return diagnostics(); initialized = true;
    try { await openDB(); } catch (error) { emit('eve:diary-storage-fallback', { operation:'init', error:String(error?.message||error) }); }
    if (window.EVEAdapter?.registerContextProvider) window.EVEAdapter.registerContextProvider('character-diary', getPromptContext, { priority:14 });
    timer = setInterval(checkAutoGenerate, 60000);
    bind(document, 'visibilitychange', () => { if (!document.hidden) checkAutoGenerate(); });
    bind(window, 'eve:adapter-ready', () => checkAutoGenerate());
    bind(window, 'eve:schedule-ready', () => checkAutoGenerate());
    window.EVE ||= {}; window.EVE.diary = window.EVEDiary;
    emit('eve:diary-ready', diagnostics());
    setTimeout(checkAutoGenerate, 2500);
    return diagnostics();
  }
  function destroy() { clearInterval(timer); timer=null; listeners.splice(0).forEach(fn => { try { fn(); } catch (_) {} }); initialized=false; }

  window.EVEDiary = Object.freeze({
    version:VERSION, init, destroy, configure:saveSettings, getSettings, diagnostics,
    list, get, save, remove, clear, exportData, importData, generate, getPromptContext, getCurrentScope:scopeKey, getLocalDate:localDate
  });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
