/**
 * EVE Sticker Intelligence v1.2.1
 *
 * 表情包识别与选图增强：
 * - 为每张表情包保存结构化语义（画面、文字、情绪、意图、场景、语气、强度）
 * - 理解用户刚发送的表情包，并把语义提供给 AI
 * - 根据当前消息、场景与角色偏好筛选可用表情包候选
 * - 强制 AI 使用稳定的 stickerId，而不是依赖容易变化的文件名
 * - 可选使用当前 Gemini API 对图片进行一次性视觉分析
 * - 支持手动纠错与锁定元数据
 */
(function (window, document) {
  'use strict';
  if (window.EVEStickerIntelligence?.version) return;

  const VERSION = '1.2.1';
  const SETTINGS_KEY = 'eve_sticker_intelligence_settings_v1';
  const RECENT_KEY = 'eve_sticker_intelligence_recent_v1';
  const DEFAULTS = Object.freeze({
    enabled: true,
    understandIncoming: true,
    smartSelection: true,
    promptCandidates: true,
    candidateLimit: 8,
    incomingTtlSeconds: 150,
    recentAvoidCount: 5,
    autoAnalyzeAfterImport: false,
    analysisFrameLimit: 4,
    analysisMaxDimension: 768,
    analysisTemperature: 0.2,
    debug: false
  });

  const EMOTION_MAP = Object.freeze({
    '开心': ['开心','高兴','快乐','笑','哈哈','爆笑','乐','喜悦','得意'],
    '害羞': ['害羞','脸红','躲','偷看','不好意思','羞','扭捏'],
    '难过': ['难过','伤心','哭','泪','委屈','低落','失落','emo'],
    '生气': ['生气','愤怒','炸毛','火大','不爽','打人','揍','怒'],
    '无语': ['无语','白眼','沉默','嫌弃','无奈','看傻了'],
    '震惊': ['震惊','惊讶','吓到','愣住','不可置信','问号'],
    '撒娇': ['撒娇','抱抱','贴贴','亲亲','蹭','求求','拜托'],
    '调侃': ['调侃','看戏','坏笑','嘲笑','逗','阴阳','挑衅'],
    '喜欢': ['喜欢','爱心','心动','爱','亲密','宠'],
    '疲惫': ['累','困','睡','躺','疲惫','没电'],
    '紧张': ['紧张','慌','害怕','担心','瑟瑟发抖'],
    '庆祝': ['庆祝','恭喜','鼓掌','胜利','干杯','欢呼']
  });

  const INTENT_MAP = Object.freeze({
    '回应调侃': ['调侃','坏笑','看戏','得意','逗','挑衅'],
    '撒娇求关注': ['撒娇','抱抱','贴贴','求求','拜托','委屈'],
    '表达赞同': ['点头','赞同','可以','好的','收到','鼓掌'],
    '表达拒绝': ['不要','拒绝','不行','摇头','退后'],
    '等待回应': ['偷看','等待','盯','期待','敲门'],
    '安慰陪伴': ['抱抱','摸头','安慰','陪伴','递纸巾'],
    '庆祝夸奖': ['庆祝','恭喜','鼓掌','厉害','冠军'],
    '表达无奈': ['无语','白眼','无奈','叹气'],
    '转移尴尬': ['害羞','躲开','装傻','逃跑'],
    '轻微抗议': ['生气','炸毛','打人','抗议','不满']
  });

  const XIAOYI_PREFER = ['调侃','得意','看戏','无奈','猫','坏笑','回应调侃','等待回应'];
  const XIAOYI_AVOID = ['卑微','跪求','崩溃大哭','疯狂卖萌','满屏爱心'];

  let settings = readSettings();
  let initialized = false;
  let adapterBound = false;
  let incoming = null;
  let incomingTimer = null;
  let manager = null;
  let analyzing = false;
  const disposers = [];

  function readSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
    catch (_) { return Object.assign({}, DEFAULTS); }
  }
  function configure(next = {}) {
    settings = Object.assign({}, DEFAULTS, settings, next || {});
    ['enabled','understandIncoming','smartSelection','promptCandidates','autoAnalyzeAfterImport','debug'].forEach(key => settings[key] = Boolean(settings[key]));
    settings.candidateLimit = clampNumber(settings.candidateLimit, 1, 20, 8);
    settings.incomingTtlSeconds = clampNumber(settings.incomingTtlSeconds, 15, 600, 150);
    settings.recentAvoidCount = clampNumber(settings.recentAvoidCount, 0, 20, 5);
    settings.analysisFrameLimit = clampNumber(settings.analysisFrameLimit, 1, 6, 4);
    settings.analysisMaxDimension = clampNumber(settings.analysisMaxDimension, 256, 1536, 768);
    settings.analysisTemperature = Math.max(0, Math.min(1, Number(settings.analysisTemperature) || 0.2));
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    emit('eve:sticker-intelligence-settings-updated', { settings:getSettings() });
    return getSettings();
  }
  function getSettings() { return Object.assign({}, settings); }
  function clampNumber(value, min, max, fallback) { const num = Number(value); return Math.max(min, Math.min(max, Number.isFinite(num) ? num : fallback)); }
  function clean(value, max = 2000) { return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max); }
  function unique(values, max = 30) { return Array.from(new Set((values || []).map(value => clean(value, 80)).filter(Boolean))).slice(0, max); }
  function emit(name, detail = {}) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} }
  function log(...args) { if (settings.debug) console.log('[EVEStickerIntelligence]', ...args); }
  function on(target, name, handler, options) { target.addEventListener(name, handler, options); disposers.push(() => target.removeEventListener(name, handler, options)); }
  function clone(value) { try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); } catch (_) { return value; } }
  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    if (window.showToast) return window.showToast(message, type);
    console.log('[EVEStickerIntelligence]', message);
  }

  function getItems() {
    try { if (typeof customEmojis !== 'undefined' && Array.isArray(customEmojis)) return customEmojis; } catch (_) {}
    return [];
  }
  function saveItems() {
    try { if (typeof saveCustomEmojis === 'function') return Promise.resolve(saveCustomEmojis()); } catch (_) {}
    try { if (typeof window.saveCustomEmojis === 'function') return Promise.resolve(window.saveCustomEmojis()); } catch (_) {}
    return Promise.resolve(false);
  }
  function getCurrentScope() { return window.EVEAdapter?.getCurrentChat?.().scope || 'global'; }
  function getRoleId() { return window.EVERoleFidelity?.resolveActive?.()?.id || ''; }

  function normalizeMetadata(raw = {}) {
    return {
      version: 2,
      description: clean(raw.description, 500),
      textInImage: clean(raw.textInImage, 300),
      emotions: unique(raw.emotions, 12),
      intents: unique(raw.intents, 12),
      scenes: unique(raw.scenes, 12),
      tones: unique(raw.tones || raw.tone, 10),
      subjects: unique(raw.subjects, 10),
      motion: clean(raw.motion, 300),
      intensity: Math.max(1, Math.min(5, Number(raw.intensity) || 2)),
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0.25)),
      source: clean(raw.source || 'local', 30),
      analyzedAt: raw.analyzedAt || new Date().toISOString(),
      locked: Boolean(raw.locked),
      lockedFields: unique(raw.lockedFields, 20)
    };
  }

  function heuristicMetadata(item) {
    const sourceName = String(item?.sourceSignature || '').split('|')[0];
    const haystack = [item?.name, item?.description, sourceName, ...(item?.tags || [])].filter(Boolean).join(' ').toLowerCase();
    const emotions = [], intents = [];
    for (const [label, keywords] of Object.entries(EMOTION_MAP)) if (keywords.some(keyword => haystack.includes(keyword.toLowerCase()))) emotions.push(label);
    for (const [label, keywords] of Object.entries(INTENT_MAP)) if (keywords.some(keyword => haystack.includes(keyword.toLowerCase()))) intents.push(label);
    const subjects = [];
    for (const subject of ['猫','狗','兔','熊','人','小孩','动漫角色','文字梗图']) if (haystack.includes(subject)) subjects.push(subject);
    return normalizeMetadata({
      description: clean(item?.description || item?.name || sourceName || '未分析表情包', 500),
      emotions: emotions.length ? emotions : ['轻松'],
      intents: intents.length ? intents : ['情绪回应'],
      scenes: ['日常聊天'],
      tones: emotions.includes('生气') ? ['激烈'] : ['轻松'],
      subjects,
      intensity: /爆笑|大哭|暴怒|疯狂|尖叫/.test(haystack) ? 4 : 2,
      confidence: 0.28,
      source: 'local'
    });
  }

  function ensureMetadata(item) {
    if (!item) return null;
    if (!item.aiMetadata || Number(item.aiMetadata.version) < 2) item.aiMetadata = heuristicMetadata(item);
    else item.aiMetadata = normalizeMetadata(item.aiMetadata);
    return item.aiMetadata;
  }

  function itemImage(item) { return item?.url || item?.imageData || ''; }
  function findItemById(id) { return getItems().find(item => String(item.id) === String(id)) || null; }
  function normalizeUrl(value) { return String(value || '').replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, ''); }
  function findItemByImage(src, alt = '') {
    const normalizedSrc = normalizeUrl(src);
    const byUrl = getItems().find(item => {
      const image = itemImage(item);
      return image && (image === src || normalizeUrl(image) === normalizedSrc);
    });
    if (byUrl) return byUrl;
    return window.EVEStickers?.resolveItem?.(alt) || null;
  }

  function dataUrlToBlob(dataUrl) {
    const match = String(dataUrl || '').match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.+)$/i);
    if (!match) throw new Error('不是有效的图片数据');
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type:match[1] });
  }
  function fileToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
      reader.readAsDataURL(blob);
    });
  }
  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片解码失败'));
      image.src = source;
    });
  }
  function resizeDrawable(drawable, width, height, maxDimension = settings.analysisMaxDimension) {
    const ratio = Math.min(1, maxDimension / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext('2d', { alpha:true });
    context.drawImage(drawable, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.86);
  }
  async function extractAnalysisFrames(item) {
    const source = itemImage(item);
    if (!source) throw new Error('表情包没有可读取的图片');
    const blob = source.startsWith('data:') ? dataUrlToBlob(source) : await fetch(source).then(response => response.blob());
    const type = blob.type || 'image/png';
    if (type === 'image/gif' && typeof window.ImageDecoder === 'function') {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const decoder = new ImageDecoder({ data:bytes, type });
        await decoder.tracks.ready;
        const count = Math.max(1, decoder.tracks.selectedTrack?.frameCount || 1);
        const frameLimit = Math.min(settings.analysisFrameLimit, count);
        const indexes = unique(Array.from({ length:frameLimit }, (_, index) => Math.round(index * (count - 1) / Math.max(1, frameLimit - 1))), frameLimit).map(Number);
        const frames = [];
        for (const frameIndex of indexes) {
          const result = await decoder.decode({ frameIndex });
          const frame = result.image;
          frames.push(resizeDrawable(frame, frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight));
          frame.close?.();
        }
        decoder.close?.();
        if (frames.length) return { frames, animated:true, frameMode:'multi-frame' };
      } catch (error) { log('GIF多帧抽取失败，改用首帧', error); }
    }
    const dataUrl = source.startsWith('data:') ? source : await fileToDataUrl(blob);
    const image = await loadImage(dataUrl);
    return { frames:[resizeDrawable(image, image.naturalWidth, image.naturalHeight)], animated:type === 'image/gif', frameMode:'first-frame' };
  }

  function getApiSettings() {
    try { if (typeof apiSettings !== 'undefined' && apiSettings) return apiSettings; } catch (_) {}
    return window.apiSettings || null;
  }
  function geminiEndpoint(api) {
    const base = clean(api?.base || 'https://generativelanguage.googleapis.com/v1', 500).replace(/\/+$/, '');
    const model = clean(api?.model || 'gemini-2.5-flash', 150).replace(/^models\//, '');
    if (!/generativelanguage\.googleapis\.com/i.test(base)) throw new Error('AI视觉分析目前仅支持 Gemini 直连 API');
    if (!clean(api?.key, 500)) throw new Error('请先在 API 设置中填写 Gemini API Key');
    return `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(api.key)}`;
  }
  function parseModelJson(text) {
    const source = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(source); } catch (_) {}
    const match = source.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI没有返回有效JSON');
  }
  async function analyzeItem(id, options = {}) {
    if (analyzing && !options.allowParallel) throw new Error('已有表情包正在分析');
    const item = findItemById(id);
    if (!item) throw new Error('找不到表情包');
    if (item.aiMetadata?.locked && !options.force) return clone(item.aiMetadata);
    const api = getApiSettings();
    const endpoint = geminiEndpoint(api);
    const extracted = await extractAnalysisFrames(item);
    const prompt = [
      '你正在为聊天应用分析一张表情包。请只输出一个JSON对象，不要解释。',
      '请根据所有提供的画面判断整张表情包的动态含义，而不只描述第一帧。',
      '字段必须为：',
      '{',
      '  "description":"用简体中文描述画面和动作，40到120字",',
      '  "textInImage":"图片中的文字，没有则为空字符串",',
      '  "emotions":["主要情绪，1到5项"],',
      '  "intents":["在聊天中可能表达的意图，1到5项"],',
      '  "scenes":["适合使用的聊天场景，1到5项"],',
      '  "tones":["可爱、轻松、调侃、激烈、冷淡等，1到4项"],',
      '  "subjects":["主要主体，0到4项"],',
      '  "motion":"GIF或动作变化，没有则为空字符串",',
      '  "intensity":1到5的整数,',
      '  "confidence":0到1的小数',
      '}',
      `原始名称：${item.name || item.description || item.id}`,
      `现有标签：${(item.tags || []).join('、') || '无'}`,
      `是否动图：${extracted.animated ? '是' : '否'}，取帧方式：${extracted.frameMode}`,
      '不要凭空推断具体人物身份、关系或剧情。若含义不确定，请降低confidence。'
    ].join('\n');
    const parts = [{ text:prompt }];
    for (const frame of extracted.frames) {
      const match = frame.match(/^data:([^;]+);base64,(.+)$/);
      if (match) parts.push({ inlineData:{ mimeType:match[1], data:match[2] } });
    }
    const body = {
      contents:[{ role:'user', parts }],
      generationConfig:{ temperature:settings.analysisTemperature, maxOutputTokens:1200, responseMimeType:'application/json' },
      safetySettings:[
        { category:'HARM_CATEGORY_HARASSMENT', threshold:'OFF' },
        { category:'HARM_CATEGORY_HATE_SPEECH', threshold:'OFF' },
        { category:'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold:'OFF' },
        { category:'HARM_CATEGORY_DANGEROUS_CONTENT', threshold:'OFF' }
      ]
    };
    analyzing = true;
    emit('eve:sticker-analysis-start', { stickerId:id });
    try {
      const transport = window.EVEAdapter?.rawFetch || window.fetch.bind(window);
      const response = await transport(endpoint, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
      const raw = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(raw?.error?.message || `Gemini请求失败：${response.status}`);
      const text = (raw?.candidates || []).flatMap(candidate => candidate?.content?.parts || []).map(part => part?.text).filter(Boolean).join('\n');
      const metadata = normalizeMetadata(Object.assign({}, parseModelJson(text), { source:'gemini', analyzedAt:new Date().toISOString() }));
      item.aiMetadata = metadata;
      item.tags = unique([...(item.tags || []), ...metadata.emotions, ...metadata.intents, ...metadata.tones], 30);
      await saveItems();
      emit('eve:sticker-analysis-complete', { stickerId:id, metadata:clone(metadata) });
      return clone(metadata);
    } catch (error) {
      emit('eve:sticker-analysis-error', { stickerId:id, error });
      throw error;
    } finally { analyzing = false; }
  }

  async function analyzeMissing(options = {}) {
    const items = getItems().filter(item => !item.aiMetadata || item.aiMetadata.source !== 'gemini');
    const limit = Math.max(1, Math.min(items.length, Number(options.limit) || items.length));
    let success = 0, failed = 0;
    for (const item of items.slice(0, limit)) {
      try { await analyzeItem(item.id); success += 1; }
      catch (error) { console.warn('[EVEStickerIntelligence] 分析失败', item.id, error); failed += 1; }
    }
    toast(`分析完成：成功 ${success}，失败 ${failed}`, failed ? 'error' : 'success');
    return { success, failed };
  }

  function incomingContext() {
    if (!settings.enabled || !settings.understandIncoming || !incoming) return '';
    if (Date.now() > incoming.expiresAt || incoming.scope !== getCurrentScope()) { clearIncoming(); return ''; }
    const meta = incoming.metadata || {};
    return [
      '【用户刚发送的表情包｜本轮优先理解】',
      `表情包ID：${incoming.itemId}`,
      `画面与动作：${meta.description || incoming.name}`,
      meta.textInImage ? `图中文字：${meta.textInImage}` : '',
      meta.emotions?.length ? `主要情绪：${meta.emotions.join('、')}` : '',
      meta.intents?.length ? `可能意图：${meta.intents.join('、')}` : '',
      meta.motion ? `动作变化：${meta.motion}` : '',
      `识别置信度：${Math.round((meta.confidence || 0.25) * 100)}%`,
      (meta.confidence || 0) < 0.55 ? '置信度较低：把它视为情绪性的回应，不要断言用户一定在表达某个具体事实' : '',
      '请结合上一轮对话理解这个表情包，不要机械复述画面，也不要把它当成普通图片询问用户'
    ].filter(Boolean).join('\n');
  }

  function queryConcepts(text) {
    const source = clean(text, 5000).toLowerCase();
    const concepts = new Set();
    for (const [label, keywords] of Object.entries(EMOTION_MAP)) if (keywords.some(keyword => source.includes(keyword.toLowerCase()))) concepts.add(label);
    for (const [label, keywords] of Object.entries(INTENT_MAP)) if (keywords.some(keyword => source.includes(keyword.toLowerCase()))) concepts.add(label);
    for (const word of source.match(/[\p{L}\p{N}]{2,}/gu) || []) concepts.add(word);
    return [...concepts].slice(0, 40);
  }
  function readRecent(scope = getCurrentScope()) {
    try { const map = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}'); return Array.isArray(map[scope]) ? map[scope] : []; }
    catch (_) { return []; }
  }
  function markRecent(id, scope = getCurrentScope()) {
    try {
      const map = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}');
      const list = [String(id), ...(Array.isArray(map[scope]) ? map[scope] : []).filter(value => String(value) !== String(id))].slice(0, 20);
      map[scope] = list; localStorage.setItem(RECENT_KEY, JSON.stringify(map));
    } catch (_) {}
  }
  function scoreItem(item, concepts, roleId, recent) {
    const meta = ensureMetadata(item);
    const fields = [item.name, item.description, ...(item.tags || []), meta.description, meta.textInImage, ...meta.emotions, ...meta.intents, ...meta.scenes, ...meta.tones, ...meta.subjects, meta.motion].map(value => clean(value, 500).toLowerCase()).filter(Boolean);
    let score = item.favorite ? 4 : 0;
    for (const concept of concepts) {
      const term = concept.toLowerCase();
      if ((item.tags || []).some(tag => clean(tag, 80).toLowerCase() === term)) score += 14;
      if (meta.emotions.some(value => value.toLowerCase() === term)) score += 13;
      if (meta.intents.some(value => value.toLowerCase() === term)) score += 12;
      if (fields.some(value => value === term)) score += 8;
      else if (fields.some(value => value.includes(term) || term.includes(value))) score += 3;
    }
    if (roleId === 'xiaoyi') {
      if (XIAOYI_PREFER.some(term => fields.some(value => value.includes(term)))) score += 4;
      if (XIAOYI_AVOID.some(term => fields.some(value => value.includes(term)))) score -= 12;
    }
    const index = recent.indexOf(String(item.id));
    if (index >= 0 && index < settings.recentAvoidCount) score -= 18 - index * 2;
    score += Math.round((meta.confidence || 0) * 3);
    return score;
  }
  function findCandidates(query = '', options = {}) {
    const concepts = unique([...(options.concepts || []), ...queryConcepts(query)], 50);
    const roleId = options.roleId || getRoleId();
    const recent = readRecent(options.scope || getCurrentScope());
    const limit = Math.max(1, Math.min(20, Number(options.limit) || settings.candidateLimit));
    return getItems().map(item => ({ item, metadata:ensureMetadata(item), score:scoreItem(item, concepts, roleId, recent) }))
      .filter(entry => entry.score > (concepts.length ? 0 : 3))
      .sort((a,b) => b.score - a.score)
      .slice(0, limit)
      .map(entry => ({ id:entry.item.id, name:entry.item.name || entry.item.description || entry.item.id, description:entry.metadata.description, emotions:entry.metadata.emotions, intents:entry.metadata.intents, score:entry.score, favorite:Boolean(entry.item.favorite) }));
  }

  function candidateContext(meta = {}) {
    if (!settings.enabled) return '';
    const chunks = [];
    const incomingText = incomingContext();
    if (incomingText) chunks.push(incomingText);
    if (settings.smartSelection && settings.promptCandidates) {
      const query = [meta.userText || '', incoming?.metadata?.emotions?.join(' ') || '', incoming?.metadata?.intents?.join(' ') || ''].join(' ');
      let candidates = findCandidates(query, { limit:settings.candidateLimit, scope:meta.chat?.scope });
      if (!candidates.length) candidates = getItems().filter(item => item.favorite).slice(0, settings.candidateLimit).map(item => ({ id:item.id, name:item.name || item.description || item.id, description:ensureMetadata(item).description, emotions:ensureMetadata(item).emotions, intents:ensureMetadata(item).intents }));
      if (candidates.length) {
        chunks.push([
          '【本轮可用表情包候选】',
          ...candidates.map(candidate => `- stickerId=${candidate.id}｜${candidate.name}｜情绪:${candidate.emotions.join('、') || '未标注'}｜意图:${candidate.intents.join('、') || '未标注'}｜${candidate.description}`),
          '只有在表情包确实比文字更自然时才使用，不要每轮都发送',
          '发送时必须在JSON数组中输出：{"type":"emoji","stickerId":"候选中的精确ID"}',
          '可以单独发表情包，也可以先发送一条短文字，再发送emoji对象',
          '禁止输出“[发送了表情包：名称]”等纯文字占位符，禁止虚构不存在的stickerId'
        ].join('\n'));
      }
    }
    return chunks.join('\n\n');
  }

  function convertEmojiObject(value) {
    if (!value || typeof value !== 'object') return value;
    if (String(value.type || '').toLowerCase() !== 'emoji') return value;
    const item = findItemById(value.stickerId || value.id) || window.EVEStickers?.resolveItem?.(value.description || value.name || '');
    if (!item) return value;
    markRecent(item.id);
    return Object.assign({}, value, { stickerId:item.id, description:item.description || item.name || item.id });
  }
  function transformJson(value) {
    if (Array.isArray(value)) return value.map(transformJson);
    if (!value || typeof value !== 'object') return value;
    const converted = convertEmojiObject(value);
    if (converted !== value || String(value.type || '').toLowerCase() === 'emoji') return converted;
    const output = Object.assign({}, value);
    for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') output[key] = transformJson(child);
    return output;
  }
  function responseTransformer(text) {
    const source = String(text ?? '');
    const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = (fenced ? fenced[1] : source).trim();
    try {
      const transformed = transformJson(JSON.parse(candidate));
      const json = JSON.stringify(transformed);
      return fenced ? `\`\`\`json\n${json}\n\`\`\`` : json;
    } catch (_) { return source; }
  }

  function detectStickerFromElement(detail = {}) {
    const element = detail.element;
    if (!element?.querySelector) return null;
    const image = element.querySelector('img.message-emoji,img.eve-repaired-sticker,img[alt][src]');
    if (image) return findItemByImage(image.currentSrc || image.src, image.alt || image.title || '');
    const text = clean(detail.text || element.textContent, 500);
    const match = text.match(/[\[【](?:发送了|發送了|发了|發了|使用了)?\s*表情包\s*[:：]\s*([^\]】]+)[\]】]/i);
    return window.EVEStickers?.resolveItem?.(match?.[1] || text) || null;
  }
  function setIncoming(item, detail = {}) {
    if (!item) return;
    const metadata = ensureMetadata(item);
    incoming = { itemId:item.id, name:item.name || item.description || item.id, metadata:clone(metadata), messageId:detail.messageId || detail.id || '', scope:detail.scope || detail.chat?.scope || getCurrentScope(), createdAt:Date.now(), expiresAt:Date.now() + settings.incomingTtlSeconds * 1000 };
    clearTimeout(incomingTimer);
    incomingTimer = setTimeout(clearIncoming, settings.incomingTtlSeconds * 1000 + 1000);
    emit('eve:incoming-sticker-understood', clone(incoming));
  }
  function clearIncoming() { clearTimeout(incomingTimer); incomingTimer = null; incoming = null; }

  function bindEvents() {
    on(window, 'eve:user-message-committed', event => {
      if (!settings.enabled || !settings.understandIncoming) return;
      const item = detectStickerFromElement(event.detail || {});
      if (item) setIncoming(item, event.detail || {});
    });
    on(window, 'eve:ai-response', () => { if (incoming) setTimeout(clearIncoming, 1500); });
    on(window, 'eve:ai-message-committed', event => {
      const element = event.detail?.element;
      const image = element?.querySelector?.('img.message-emoji,img.eve-repaired-sticker,img[alt][src]');
      if (!image) return;
      const item = findItemByImage(image.currentSrc || image.src, image.alt || image.title || '');
      if (item) markRecent(item.id, event.detail?.scope || getCurrentScope());
    });
    on(window, 'eve:stickers-imported', async event => {
      for (const item of getItems()) ensureMetadata(item);
      await saveItems();
      if (settings.autoAnalyzeAfterImport) {
        const ids = event.detail?.ids || [];
        for (const id of ids) analyzeItem(id).catch(error => console.warn('[EVEStickerIntelligence] 自动分析失败', error));
      }
    });
  }
  function bindAdapter() {
    if (adapterBound || !window.EVEAdapter?.registerContextProvider) return false;
    window.EVEAdapter.registerContextProvider('sticker-intelligence', candidateContext, { priority:8 });
    window.EVEAdapter.registerResponseTransformer?.('sticker-intelligence-output', responseTransformer, { priority:35 });
    adapterBound = true;
    return true;
  }

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[char]); }
  function promptList(label, values) { const answer = prompt(label, (values || []).join('，')); return answer === null ? null : unique(answer.split(/[,，\n]/), 20); }
  async function editMetadata(item) {
    const current = ensureMetadata(item);
    const description = prompt('画面与动作描述', current.description); if (description === null) return false;
    const textInImage = prompt('图片中文字（没有可留空）', current.textInImage); if (textInImage === null) return false;
    const emotions = promptList('主要情绪，用逗号分隔', current.emotions); if (emotions === null) return false;
    const intents = promptList('聊天意图，用逗号分隔', current.intents); if (intents === null) return false;
    const scenes = promptList('适用场景，用逗号分隔', current.scenes); if (scenes === null) return false;
    const tones = promptList('语气，用逗号分隔', current.tones); if (tones === null) return false;
    item.aiMetadata = normalizeMetadata(Object.assign({}, current, { description, textInImage, emotions, intents, scenes, tones, source:'manual', confidence:1, locked:true, lockedFields:['description','textInImage','emotions','intents','scenes','tones'] }));
    item.tags = unique([...(item.tags || []), ...emotions, ...intents, ...tones], 30);
    await saveItems();
    emit('eve:sticker-metadata-corrected', { stickerId:item.id, metadata:clone(item.aiMetadata) });
    return true;
  }

  function openManager() {
    manager?.remove();
    const overlay = document.createElement('div'); manager = overlay; overlay.id = 'eve-sticker-intelligence-manager';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:12px';
    const panel = document.createElement('div'); panel.style.cssText = 'width:min(920px,100%);max-height:94vh;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 18px 60px #0006';
    panel.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;padding:14px 16px;border-bottom:1px solid #ddd">
        <b style="flex:1">表情包智能识别</b>
        <button data-analyze-missing type="button">AI分析未识别</button>
        <button data-close type="button">✕</button>
      </div>
      <div style="padding:10px 14px;border-bottom:1px solid #ddd;display:flex;gap:8px;flex-wrap:wrap">
        <input data-search placeholder="搜索名称、情绪或意图" style="flex:1;min-width:180px;padding:8px;border:1px solid #ccc;border-radius:8px">
        <label style="display:flex;align-items:center;gap:6px"><input data-unanalysed type="checkbox">只看未AI分析</label>
      </div>
      <div data-status style="padding:8px 14px;font-size:12px;opacity:.7;border-bottom:1px solid #ddd"></div>
      <div data-grid style="overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;min-height:260px"></div>`;
    overlay.append(panel); document.body.append(overlay);
    const status = panel.querySelector('[data-status]');
    const render = () => {
      const query = clean(panel.querySelector('[data-search]').value, 100).toLowerCase();
      const onlyMissing = panel.querySelector('[data-unanalysed]').checked;
      const items = getItems().filter(item => {
        const meta = ensureMetadata(item);
        const haystack = [item.name,item.description,...(item.tags || []),meta.description,meta.textInImage,...meta.emotions,...meta.intents,...meta.scenes].join(' ').toLowerCase();
        return (!query || haystack.includes(query)) && (!onlyMissing || meta.source !== 'gemini');
      });
      status.textContent = `共 ${getItems().length} 张｜Gemini已分析 ${getItems().filter(item => ensureMetadata(item).source === 'gemini').length} 张｜手动锁定 ${getItems().filter(item => ensureMetadata(item).locked).length} 张`;
      const grid = panel.querySelector('[data-grid]'); grid.innerHTML = '';
      for (const item of items) {
        const meta = ensureMetadata(item);
        const card = document.createElement('div'); card.style.cssText = 'border:1px solid #ddd;border-radius:12px;padding:9px;display:flex;flex-direction:column;gap:6px;min-width:0';
        card.innerHTML = `
          <img src="${itemImage(item)}" alt="" style="width:100%;height:130px;object-fit:contain;background:#f5f5f5;border-radius:8px">
          <b style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.name || item.description || item.id)}</b>
          <div style="font-size:12px;line-height:1.45;max-height:52px;overflow:auto">${escapeHtml(meta.description)}</div>
          <small style="opacity:.72">情绪：${escapeHtml(meta.emotions.join('、') || '未标注')}</small>
          <small style="opacity:.72">意图：${escapeHtml(meta.intents.join('、') || '未标注')}</small>
          <small style="opacity:.62">来源：${escapeHtml(meta.source)}｜置信度 ${Math.round(meta.confidence * 100)}%${meta.locked ? '｜已锁定' : ''}</small>
          <div style="display:flex;gap:5px"><button data-analyze style="flex:1">AI分析</button><button data-edit style="flex:1">纠正</button><button data-local style="flex:1">本地重建</button></div>`;
        card.querySelector('[data-analyze]').onclick = async () => {
          try { card.querySelector('[data-analyze]').disabled = true; status.textContent = `正在分析：${item.name || item.id}`; await analyzeItem(item.id, { force:true }); toast('表情包分析完成'); render(); }
          catch (error) { console.error(error); toast(error.message || String(error), 'error'); }
        };
        card.querySelector('[data-edit]').onclick = async () => { if (await editMetadata(item)) { toast('已保存人工纠正'); render(); } };
        card.querySelector('[data-local]').onclick = async () => { item.aiMetadata = heuristicMetadata(item); await saveItems(); render(); };
        grid.append(card);
      }
      if (!items.length) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;opacity:.6">没有符合条件的表情包</div>';
    };
    panel.querySelector('[data-close]').onclick = () => overlay.remove();
    overlay.onclick = event => { if (event.target === overlay) overlay.remove(); };
    panel.querySelector('[data-search]').oninput = render;
    panel.querySelector('[data-unanalysed]').onchange = render;
    panel.querySelector('[data-analyze-missing]').onclick = async () => {
      if (analyzing) return toast('正在分析，请稍候', 'error');
      if (!confirm('会使用当前 Gemini API 逐张分析未识别的表情包，并消耗 API 额度，继续吗？')) return;
      try { await analyzeMissing(); render(); } catch (error) { toast(error.message || String(error), 'error'); }
    };
    render();
  }

  function getDiagnostics() {
    const items = getItems();
    return {
      version:VERSION, initialized, adapterBound, settings:getSettings(), total:items.length,
      geminiAnalysed:items.filter(item => ensureMetadata(item).source === 'gemini').length,
      manualLocked:items.filter(item => ensureMetadata(item).locked).length,
      incoming:clone(incoming), roleId:getRoleId(), recent:readRecent()
    };
  }
  function init() {
    if (initialized) return Promise.resolve(getDiagnostics());
    initialized = true;
    for (const item of getItems()) ensureMetadata(item);
    saveItems().catch(() => {});
    bindEvents();
    if (!bindAdapter()) {
      const timer = setInterval(() => { if (bindAdapter()) clearInterval(timer); }, 500);
      setTimeout(() => clearInterval(timer), 30000);
    }
    window.EVE ||= {}; window.EVE.stickerIntelligence = window.EVEStickerIntelligence;
    emit('eve:sticker-intelligence-ready', getDiagnostics());
    return Promise.resolve(getDiagnostics());
  }
  function destroy() {
    disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} });
    clearIncoming(); manager?.remove(); manager = null; initialized = false;
  }

  window.EVEStickerIntelligence = Object.freeze({
    version:VERSION, init, destroy, configure, getSettings, getDiagnostics,
    ensureMetadata, analyzeItem, analyzeMissing, findCandidates, getIncoming:() => clone(incoming), clearIncoming,
    openManager, responseTransformer
  });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
