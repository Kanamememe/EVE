/**
 * EVE Critical Modules Bundle v1.5.4
 * Local single-file fallback for Capacitor/WKWebView.
 */
(function(window){
  'use strict';
  if (!window.EVECriticalModules) window.EVECriticalModules = { version:'1.5.4', bundled:true };
})(window);

/* ===== BEGIN role-fidelity/core ===== */
/**
 * EVE Role Fidelity Core v1.1.0
 * 通用角色贴合引擎：角色档案、场景识别、示例检索、请求参数调节、输出规范化与OOC检测
 */
(function (window, document) {
  'use strict';
  if (window.EVERoleFidelity?.version) return;

  const VERSION = '1.1.0';
  const SETTINGS_KEY = 'eve_role_fidelity_settings_v1';
  const CUSTOM_PROFILES_KEY = 'eve_role_fidelity_custom_profiles_v1';
  const BINDINGS_KEY = 'eve_role_fidelity_bindings_v1';
  const DEFAULTS = Object.freeze({
    enabled: true,
    autoMatch: true,
    strictness: 'strict',
    normalizeOutput: true,
    detectOoc: true,
    tuneGeneration: true,
    exampleLimit: 4,
    maxContextCharacters: 11000,
    debug: false
  });

  const packs = new Map();
  const customProfiles = new Map();
  const validators = new Map();
  const normalizers = new Map();
  const disposers = [];
  let settings = readJson(SETTINGS_KEY, DEFAULTS);
  let bindings = readJson(BINDINGS_KEY, {});
  let adapterBound = false;
  let initialized = false;
  let lastValidation = null;
  let retryTimer = null;

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      if (Array.isArray(fallback)) return Array.isArray(value) ? value : fallback.slice();
      return value && typeof value === 'object' ? Object.assign({}, fallback, value) : Object.assign({}, fallback);
    } catch (_) { return Array.isArray(fallback) ? fallback.slice() : Object.assign({}, fallback); }
  }
  function writeJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; } }
  function clone(value) { try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); } catch (_) { return value; } }
  function clean(value, max = 100000) { return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max); }
  function list(value) { return Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []); }
  function slug(value) { return clean(value, 120).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || `role-${Date.now()}`; }
  function emit(name, detail = {}) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} }
  function log(...args) { if (settings.debug) console.log('[EVERoleFidelity]', ...args); }

  function normalizeSettings(next = {}) {
    const out = Object.assign({}, DEFAULTS, settings, next || {});
    ['enabled','autoMatch','normalizeOutput','detectOoc','tuneGeneration','debug'].forEach(key => out[key] = Boolean(out[key]));
    out.strictness = ['normal','strict','extreme'].includes(out.strictness) ? out.strictness : 'strict';
    out.exampleLimit = Math.max(0, Math.min(10, Number(out.exampleLimit) || 4));
    out.maxContextCharacters = Math.max(2000, Math.min(24000, Number(out.maxContextCharacters) || 11000));
    return out;
  }
  function configure(next = {}) {
    settings = normalizeSettings(next);
    writeJson(SETTINGS_KEY, settings);
    emit('eve:role-fidelity-settings-updated', { settings:getSettings() });
    return getSettings();
  }
  function getSettings() { return Object.assign({}, settings); }

  function loadCustomProfiles() {
    const stored = readJson(CUSTOM_PROFILES_KEY, { profiles:[] });
    for (const profile of list(stored.profiles)) {
      if (profile?.id) customProfiles.set(String(profile.id), profile);
    }
  }
  function saveCustomProfiles() { writeJson(CUSTOM_PROFILES_KEY, { profiles:[...customProfiles.values()] }); }

  function registerPack(pack) {
    if (!pack?.id || !pack?.profile) throw new TypeError('角色包必须包含 id 与 profile');
    const id = String(pack.id);
    const normalized = Object.assign({}, pack, { id, profile:Object.assign({}, pack.profile, { id:pack.profile.id || id }) });
    packs.set(id, normalized);
    if (typeof pack.validate === 'function') validators.set(id, pack.validate);
    if (typeof pack.normalize === 'function') normalizers.set(id, pack.normalize);
    emit('eve:role-pack-registered', { id, name:pack.profile.name || id });
    return () => unregisterPack(id);
  }
  function unregisterPack(id) { validators.delete(String(id)); normalizers.delete(String(id)); return packs.delete(String(id)); }
  function listProfiles() {
    const builtin = [...packs.values()].map(pack => ({ id:pack.id, name:pack.profile.name || pack.id, builtin:true, autoMatch:list(pack.profile.autoMatch || pack.profile.aliases) }));
    const custom = [...customProfiles.values()].map(profile => ({ id:profile.id, name:profile.name || profile.id, builtin:false, autoMatch:list(profile.autoMatch || profile.aliases) }));
    return builtin.concat(custom);
  }
  function getProfile(id) {
    const key = String(id || '');
    if (packs.has(key)) return clone(packs.get(key).profile);
    if (customProfiles.has(key)) return clone(customProfiles.get(key));
    return null;
  }
  function getPack(id) { return packs.get(String(id || '')) || null; }

  function saveCustomProfile(profile) {
    if (!profile || typeof profile !== 'object') throw new TypeError('无效角色档案');
    const id = String(profile.id || slug(profile.name || 'custom-role'));
    const normalized = Object.assign({
      id,
      name:profile.name || id,
      aliases:[],
      coreTraits:[],
      behaviorRules:[],
      forbiddenDeviations:[],
      speechStyle:{},
      relationship:{},
      sceneRules:{},
      examples:[]
    }, clone(profile), { id });
    customProfiles.set(id, normalized);
    saveCustomProfiles();
    emit('eve:role-profile-saved', { id, profile:clone(normalized) });
    return clone(normalized);
  }
  function deleteCustomProfile(id) {
    const key = String(id || '');
    if (!customProfiles.delete(key)) return false;
    saveCustomProfiles();
    Object.keys(bindings).forEach(characterId => { if (bindings[characterId] === key) delete bindings[characterId]; });
    writeJson(BINDINGS_KEY, bindings);
    return true;
  }

  function currentChat() { return window.EVEAdapter?.getCurrentChat?.() || { id:'', name:'', title:'', scope:'global', open:false }; }
  function bindProfile(characterId, profileId) {
    const cid = clean(characterId, 200);
    if (!cid) throw new Error('当前角色没有可用ID');
    if (profileId && !getProfile(profileId)) throw new Error(`找不到角色档案：${profileId}`);
    if (profileId) bindings[cid] = String(profileId); else delete bindings[cid];
    writeJson(BINDINGS_KEY, bindings);
    emit('eve:role-binding-updated', { characterId:cid, profileId:profileId || null });
    return getBinding(cid);
  }
  function getBinding(characterId) { return bindings[clean(characterId, 200)] || null; }

  function matchScore(profile, name) {
    const target = clean(name, 120).toLowerCase();
    if (!target) return 0;
    const terms = [profile.name, ...(profile.aliases || []), ...(profile.autoMatch || [])].map(value => clean(value, 120).toLowerCase()).filter(Boolean);
    let score = 0;
    for (const term of terms) {
      if (target === term) score = Math.max(score, 100);
      else if (target.includes(term) || term.includes(target)) score = Math.max(score, 65);
    }
    return score;
  }
  function resolveActive(meta = {}) {
    if (!settings.enabled) return null;
    const chat = meta.chat || currentChat();
    const bound = chat.id && bindings[chat.id];
    if (bound) {
      const profile = getProfile(bound); if (profile) return { id:bound, profile, pack:getPack(bound), reason:'binding', chat };
    }
    if (!settings.autoMatch) return null;
    const candidates = [];
    for (const pack of packs.values()) candidates.push({ id:pack.id, profile:pack.profile, pack });
    for (const profile of customProfiles.values()) candidates.push({ id:profile.id, profile, pack:null });
    const name = chat.name || chat.title || '';
    const best = candidates.map(item => Object.assign(item, { score:matchScore(item.profile, name) })).sort((a,b) => b.score - a.score)[0];
    return best?.score >= 65 ? Object.assign(best, { reason:'auto-match', chat }) : null;
  }

  function detectScene(meta = {}) {
    const feature = clean(meta.feature || meta.requestBody?.metadata?.feature, 80).toLowerCase();
    const userText = clean(meta.userText, 5000);
    const requestText = JSON.stringify(meta.requestBody || {}).slice(0, 20000);
    const combined = `${feature}\n${userText}\n${requestText}`;
    if (/moment|动态|朋友圈/.test(combined)) return /回复|评论|comment|reply/.test(combined) ? 'momentReply' : 'momentPost';
    if (/主动消息|proactive|主动联系/.test(combined)) return 'proactive';
    if (/剧情|旁白|第三人称|场景描写|story/.test(combined)) return 'story';
    return 'chat';
  }

  function flattenExamples(profile, pack) {
    const groups = [];
    if (Array.isArray(profile.examples)) groups.push(...profile.examples);
    if (pack?.examples) {
      for (const value of Object.values(pack.examples)) if (Array.isArray(value)) groups.push(...value);
    }
    return groups;
  }
  function exampleScore(example, scene, query) {
    let score = 0;
    const exScene = example.scene || 'chat';
    if (exScene === scene) score += 10;
    if (scene === 'momentReply' && ['moments','momentReply'].includes(exScene)) score += 8;
    const haystack = [example.user, ...(example.assistant || []), ...(example.tags || []), example.note].join(' ').toLowerCase();
    const terms = clean(query, 1000).toLowerCase().split(/[\s，。！？、,.!?]+/).filter(term => term.length >= 2);
    for (const term of terms) if (haystack.includes(term)) score += Math.min(5, term.length);
    return score;
  }
  function selectExamples(profile, pack, scene, query) {
    return flattenExamples(profile, pack)
      .map(example => ({ example, score:exampleScore(example, scene, query) }))
      .filter(item => item.score > 0)
      .sort((a,b) => b.score - a.score)
      .slice(0, settings.exampleLimit)
      .map(item => item.example);
  }

  function formatExamples(examples, profile) {
    if (!examples.length) return '';
    const userLabel = clean(profile?.relationship?.userName || '使用者', 80);
    const roleLabel = clean(profile?.displayCharacterName || profile?.name || '角色', 80);
    const blocks = examples.map((example, index) => {
      const user = clean(example.user || '', 1000);
      const assistant = list(example.assistant || example.reply).map(item => clean(item, 1000)).filter(Boolean);
      return [`示例${index + 1}`, user ? `${userLabel}：${user}` : '', ...assistant.map(item => `${roleLabel}：${item}`), example.note ? `要点：${clean(example.note, 600)}` : ''].filter(Boolean).join('\n');
    });
    return `【语言与行为示例】\n${blocks.join('\n\n')}`;
  }

  function buildGenericContext(active, meta = {}) {
    const profile = active.profile;
    const pack = active.pack;
    const scene = detectScene(meta);
    const strictness = settings.strictness;
    const userText = clean(meta.userText, 5000);
    const examples = selectExamples(profile, pack, scene, userText);
    const sections = [
      '【最高优先级：角色贴合】',
      `当前应扮演：${profile.name || active.id}`,
      '角色一致性高于天气、记忆、时间线和其他背景资料。背景资料只能提供情境，不能改变角色的核心人格。',
      profile.summary ? `【角色摘要】\n${clean(profile.summary, 2500)}` : '',
      list(profile.hardFacts).length ? `【不可改写的事实】\n${list(profile.hardFacts).map(item => `- ${clean(item, 500)}`).join('\n')}` : '',
      list(profile.coreTraits).length ? `【核心性格】\n${list(profile.coreTraits).map(item => `- ${clean(item, 500)}`).join('\n')}` : '',
      list(profile.behaviorRules).length ? `【思考与行为逻辑】\n${list(profile.behaviorRules).map(item => `- ${clean(item, 700)}`).join('\n')}` : '',
      profile.relationship?.summary ? `【与使用者的关系】\n${clean(profile.relationship.summary, 1800)}` : '',
      profile.sceneRules?.[scene] ? `【当前场景：${scene}】\n${list(profile.sceneRules[scene]).map(item => `- ${clean(item, 700)}`).join('\n')}` : '',
      profile.speechStyle?.prompt ? `【语言风格】\n${clean(profile.speechStyle.prompt, 2500)}` : '',
      list(profile.forbiddenDeviations).length ? `【禁止偏差】\n${list(profile.forbiddenDeviations).map(item => `- ${clean(item, 500)}`).join('\n')}` : '',
      formatExamples(examples, profile),
      strictness === 'extreme' ? '【极严格要求】\n生成前逐项检查是否符合角色逻辑；不要为了讨好使用者而牺牲角色一致性。' : strictness === 'strict' ? '【严格要求】\n优先保持角色的判断、边界、语言节奏与独立生活感。' : ''
    ].filter(Boolean);
    if (typeof pack?.getExtraContext === 'function') {
      try { const extra = pack.getExtraContext(Object.assign({}, meta, { scene, active, userText })); if (extra) sections.push(clean(extra, 5000)); } catch (error) { console.warn('[EVERoleFidelity] 专属角色附加背景失败', error); }
    }
    let result = sections.join('\n\n');
    if (result.length > settings.maxContextCharacters) result = result.slice(0, settings.maxContextCharacters) + '\n[角色贴合资料已截短]';
    return result;
  }

  function getPromptContext(meta = {}) {
    const active = resolveActive(meta);
    return active ? buildGenericContext(active, meta) : '';
  }

  function normalizeOneText(text, profile, pack, meta = {}) {
    let output = clean(text, 100000);
    if (!output) return output;
    if (/^(https?:\/\/|data:|blob:)/i.test(output) || /```/.test(output)) return output;
    const style = profile.speechStyle || {};
    if (settings.normalizeOutput) {
      if (style.avoidFinalPeriod) output = output.replace(/[。]+([”’」』）》】]?)$/u, '$1');
      if (style.avoidFinalExclamation) output = output.replace(/[！!]+([”’」』）》】]?)$/u, '$1');
    }
    const normalizer = normalizers.get(String(pack?.id || profile.id));
    if (normalizer) {
      try { const next = normalizer(output, Object.assign({}, meta, { profile, pack })); if (typeof next === 'string') output = next; } catch (error) { console.warn('[EVERoleFidelity] 专属文本规范化失败', error); }
    }
    return output;
  }

  function transformJsonValue(value, profile, pack, meta, key = '') {
    if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? normalizeOneText(item, profile, pack, meta) : transformJsonValue(item, profile, pack, meta, key));
    if (!value || typeof value !== 'object') return value;
    const out = Array.isArray(value) ? [] : Object.assign({}, value);
    for (const [childKey, childValue] of Object.entries(value)) {
      if (typeof childValue === 'string' && ['text','content','message','reply','caption','description'].includes(childKey)) out[childKey] = normalizeOneText(childValue, profile, pack, meta);
      else if (childValue && typeof childValue === 'object') out[childKey] = transformJsonValue(childValue, profile, pack, meta, childKey);
      else out[childKey] = childValue;
    }
    return out;
  }

  function normalizeResponse(responseText, meta = {}) {
    const active = resolveActive(meta);
    if (!active || !settings.normalizeOutput) return String(responseText ?? '');
    const source = String(responseText ?? '');
    const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = fenced ? fenced[1] : source;
    try {
      const parsed = JSON.parse(candidate);
      const transformed = transformJsonValue(parsed, active.profile, active.pack, Object.assign({}, meta, { scene:detectScene(meta) }));
      const json = JSON.stringify(transformed);
      return fenced ? `\`\`\`json\n${json}\n\`\`\`` : json;
    } catch (_) {
      return source.split('\n').map(line => line.trim() ? normalizeOneText(line, active.profile, active.pack, meta) : line).join('\n');
    }
  }

  function genericValidate(text, active, meta = {}) {
    const issues = [];
    const profile = active.profile;
    const style = profile.speechStyle || {};
    const source = clean(text, 20000);
    if (!source) return issues;
    if (/作为(?:一个)?AI|语言模型|系统提示|提示词|政策/.test(source)) issues.push({ code:'meta-break', severity:100, message:'提及AI或幕后信息' });
    if (style.preferShortMessages && source.length > Number(style.maxReplyCharacters || 700)) issues.push({ code:'too-long', severity:45, message:'回复过长' });
    if (style.avoidFinalPeriod && /。[”’」』）》】]?$/u.test(source)) issues.push({ code:'final-period', severity:15, message:'句号收尾' });
    if (style.avoidFinalExclamation && /[！!][”’」』）》】]?$/u.test(source)) issues.push({ code:'final-exclamation', severity:15, message:'感叹号收尾' });
    const questions = (source.match(/[？?]/g) || []).length;
    if (questions >= 4) issues.push({ code:'question-overload', severity:35, message:'连续提问过多' });
    if (/(我理解你的感受|你愿意详细说说吗|还有什么想聊的|需要我陪你吗)/.test(source)) issues.push({ code:'counsellor-template', severity:60, message:'心理咨询式模板' });
    return issues;
  }
  function validateResponse(text, meta = {}) {
    const active = resolveActive(meta);
    if (!active || !settings.detectOoc) return { ok:true, score:100, issues:[], activeProfile:null };
    const issues = genericValidate(text, active, meta);
    const validator = validators.get(String(active.pack?.id || active.profile.id));
    if (validator) {
      try { issues.push(...list(validator(String(text ?? ''), Object.assign({}, meta, { profile:active.profile, pack:active.pack })))); } catch (error) { console.warn('[EVERoleFidelity] 专属OOC检查失败', error); }
    }
    const penalty = issues.reduce((sum, issue) => sum + Number(issue.severity || 0), 0);
    const result = { ok:penalty < 70, score:Math.max(0, 100 - penalty), issues, activeProfile:active.id, scene:detectScene(meta), timestamp:Date.now() };
    lastValidation = result;
    if (issues.length) emit('eve:role-ooc-detected', clone(result));
    return clone(result);
  }

  function requestTransformer(body, meta = {}) {
    const active = resolveActive(meta);
    if (!active || !settings.tuneGeneration) return body;
    const sampling = active.profile.generation || {};
    if (!sampling.temperature && !sampling.topP && !sampling.topK) return body;
    const output = clone(body);
    if (Array.isArray(output.messages)) {
      if (sampling.temperature != null) output.temperature = Number(sampling.temperature);
      if (sampling.topP != null) output.top_p = Number(sampling.topP);
    } else {
      output.generationConfig = Object.assign({}, output.generationConfig || {});
      if (sampling.temperature != null) output.generationConfig.temperature = Number(sampling.temperature);
      if (sampling.topP != null) output.generationConfig.topP = Number(sampling.topP);
      if (sampling.topK != null) output.generationConfig.topK = Number(sampling.topK);
    }
    return output;
  }
  function responseTransformer(text, meta = {}) {
    const normalized = normalizeResponse(text, meta);
    validateResponse(normalized, meta);
    return normalized;
  }

  function bindAdapter() {
    if (adapterBound || !window.EVEAdapter?.registerContextProvider) return false;
    window.EVEAdapter.registerContextProvider('role-fidelity', getPromptContext, { priority:1 });
    window.EVEAdapter.registerRequestTransformer?.('role-fidelity-sampling', requestTransformer, { priority:1 });
    window.EVEAdapter.registerResponseTransformer?.('role-fidelity-output', responseTransformer, { priority:1 });
    adapterBound = true;
    emit('eve:role-fidelity-adapter-bound', { adapterVersion:window.EVEAdapter.version });
    return true;
  }

  function exportProfile(id) { const profile = getProfile(id); if (!profile) throw new Error('找不到角色档案'); return JSON.stringify(profile, null, 2); }
  function importProfile(source) { const parsed = typeof source === 'string' ? JSON.parse(source) : source; return saveCustomProfile(parsed); }
  function diagnostics() {
    const active = resolveActive();
    return {
      version:VERSION,
      initialized,
      adapterBound,
      settings:getSettings(),
      activeProfile:active ? { id:active.id, name:active.profile.name, reason:active.reason, chat:active.chat } : null,
      profiles:listProfiles(),
      bindings:clone(bindings),
      lastValidation:clone(lastValidation)
    };
  }

  function init() {
    if (initialized) return Promise.resolve(diagnostics());
    settings = normalizeSettings(settings);
    loadCustomProfiles();
    initialized = true;
    if (!bindAdapter()) retryTimer = setInterval(() => { if (bindAdapter()) { clearInterval(retryTimer); retryTimer = null; } }, 500);
    window.EVE ||= {}; window.EVE.roleFidelity = window.EVERoleFidelity;
    emit('eve:role-fidelity-ready', diagnostics());
    return Promise.resolve(diagnostics());
  }
  function destroy() {
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = null;
    disposers.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
    initialized = false;
  }

  window.EVERoleFidelity = Object.freeze({
    version:VERSION, init, destroy, configure, getSettings, diagnostics,
    registerPack, unregisterPack, listProfiles, getProfile, saveCustomProfile, deleteCustomProfile,
    bindProfile, getBinding, resolveActive, getPromptContext, detectScene,
    normalizeResponse, validateResponse, exportProfile, importProfile,
    get lastValidation() { return clone(lastValidation); }
  });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);

/* ===== END role-fidelity/core ===== */

/* ===== BEGIN daily-schedule/core ===== */
/**
 * EVE Daily Schedule v1.3.2
 * 通用角色行程插件：整日规划、到点生成、混合模式、时间线／通知／主动消息联动。
 */
(function (window, document) {
  'use strict';
  if (window.EVEDailySchedule?.version) return;

  const VERSION = '1.3.2';
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
    const transport = window.EVEAdapter?.rawFetch || window.fetch.bind(window);
    const response = await transport(geminiEndpoint(api), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    generateDay, tick, getDay, currentItem, nextItem, getClock: localClock,
    addItem, updateItem, removeItem, clearDay,
    getPromptContext, openManager, openSettings, getDiagnostics
  });

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init, { once: true })
    : init();
})(window, document);

/* ===== END daily-schedule/core ===== */

/* ===== BEGIN daily-schedule/app ===== */
/**
 * EVE Daily Schedule Home App v1.3.0
 * Adds an independent home-screen icon and full schedule screen.
 */
(function (window, document) {
  'use strict';
  if (window.EVEDailyScheduleApp?.version) return;

  const VERSION = '1.5.2';
  const SCREEN_ID = 'eve-schedule-screen';
  const ICON_ID = 'eve-schedule-home-app';
  const STYLE_ID = 'eve-schedule-app-style';
  const disposers = [];
  let initialized = false;
  let selectedDate = '';

  function api() { return window.EVEDailySchedule || null; }
  function chat() { return window.EVEAdapter?.getCurrentChat?.() || { id:'', name:'角色行程', scope:'global', open:false }; }
  function clean(value, max = 500) { return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max); }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]); }
  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    if (window.showToast) return window.showToast(message, type);
    console.log('[EVEDailyScheduleApp]', message);
  }
  function emit(name, detail = {}) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} }
  function on(target, name, handler, options) { target.addEventListener(name, handler, options); disposers.push(() => target.removeEventListener(name, handler, options)); }
  function clock() {
    const native = api()?.getClock?.();
    if (native?.date) return native;
    const env = window.EVEWeather?.getEnvironment?.();
    const character = env?.character || env;
    if (character?.localDate) return { date:character.localDate, time:character.localTime || '', timezone:character.timezone || '' };
    const now = new Date();
    return {
      date:`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,
      time:`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`,
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    };
  }
  function shiftDate(value, amount) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Date(`${value}T12:00:00`) : new Date();
    date.setDate(date.getDate() + amount);
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }
  function displayDate(value) {
    try { return new Intl.DateTimeFormat('zh-CN', { month:'long', day:'numeric', weekday:'short' }).format(new Date(`${value}T12:00:00`)); }
    catch (_) { return value; }
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .home-section.top-right .eve-apps-grid-4{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:3px 9px;width:100%;height:100%;padding:1px;align-items:center}
      .home-section.top-right .eve-apps-grid-4 .mini-app{min-width:0;min-height:0;font-size:10px!important;line-height:1.1}
      .home-section.top-right .eve-apps-grid-4 .mini-app-icon{width:42px!important;height:42px!important;border-radius:13px!important;margin-bottom:2px}
      .home-section.top-right .eve-apps-grid-4 .mini-app-icon i{font-size:21px!important}
      .eve-home-app-badge{position:absolute;top:-4px;right:-6px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#ff3b30;color:#fff;font-size:10px;line-height:17px;text-align:center;font-weight:700;box-shadow:0 1px 4px #0005;display:none}
      #${ICON_ID} .mini-app-icon{position:relative}
      #${SCREEN_ID}{background:var(--body-bg,#fff)}
      #${SCREEN_ID} .eve-schedule-app-content{padding:0;overflow-y:auto;background:var(--color-gray-bg-light,#f7f7f8)}
      .eve-schedule-toolbar{display:flex;align-items:center;gap:8px;padding:12px 14px;background:var(--secondary-bg,#fff);border-bottom:1px solid var(--color-border,#eee);position:sticky;top:0;z-index:3}
      .eve-schedule-toolbar button{border:0;background:rgba(74,132,193,.12);color:#356b9f;border-radius:10px;padding:7px 10px;font-size:13px}
      .eve-schedule-toolbar .eve-schedule-date{flex:1;text-align:center;font-weight:700;font-size:15px}
      .eve-schedule-summary{margin:12px 12px 8px;padding:14px;border-radius:16px;background:linear-gradient(135deg,rgba(74,132,193,.16),rgba(255,255,255,.8));border:1px solid rgba(74,132,193,.15);box-shadow:0 4px 14px rgba(0,0,0,.05)}
      .eve-schedule-summary-title{display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:8px}
      .eve-schedule-summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .eve-schedule-summary-box{background:rgba(255,255,255,.72);border-radius:12px;padding:9px;min-width:0}
      .eve-schedule-summary-box small{display:block;opacity:.58;margin-bottom:3px}
      .eve-schedule-summary-box b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
      .eve-schedule-list{padding:4px 12px 94px}
      .eve-schedule-card{display:grid;grid-template-columns:62px 1fr auto;gap:10px;align-items:start;background:var(--secondary-bg,#fff);border-radius:14px;padding:12px;margin-bottom:9px;border:1px solid rgba(0,0,0,.06);box-shadow:0 3px 10px rgba(0,0,0,.04)}
      .eve-schedule-card.active{border-color:rgba(52,199,89,.45);box-shadow:0 3px 13px rgba(52,199,89,.12)}
      .eve-schedule-card.completed{opacity:.63}
      .eve-schedule-time{font-weight:800;color:#4a84c1;font-size:13px;line-height:1.45}
      .eve-schedule-card.active .eve-schedule-time{color:#28a745}
      .eve-schedule-title{font-weight:700;font-size:14px;margin-bottom:4px;word-break:break-word}
      .eve-schedule-desc{font-size:12px;line-height:1.45;opacity:.62;word-break:break-word}
      .eve-schedule-status{display:inline-block;margin-top:5px;border-radius:8px;padding:2px 7px;background:rgba(74,132,193,.1);font-size:10px;color:#4a84c1}
      .eve-schedule-card-actions{display:flex;flex-direction:column;gap:5px}
      .eve-schedule-card-actions button{border:0;border-radius:8px;padding:5px 7px;background:rgba(0,0,0,.055);font-size:11px;white-space:nowrap}
      .eve-schedule-empty{text-align:center;padding:70px 24px;color:#888}
      .eve-schedule-empty i{display:block;font-size:42px;margin-bottom:12px;color:#9bb8d3}
      .eve-schedule-bottom{position:absolute;left:0;right:0;bottom:0;height:62px;padding:8px 12px calc(8px + env(safe-area-inset-bottom));box-sizing:content-box;background:rgba(255,255,255,.93);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-top:1px solid rgba(0,0,0,.08);display:grid;grid-template-columns:repeat(3,1fr);gap:8px;z-index:12}
      .eve-schedule-bottom button{border:0;border-radius:12px;background:rgba(74,132,193,.1);color:#3f75aa;font-weight:600;font-size:12px}
      .eve-schedule-header-actions{position:absolute;right:19px;top:52px;transform:translateY(-50%);display:flex;gap:8px}
      .eve-schedule-header-actions button{border:0;background:transparent;font-size:17px;color:#333;padding:5px}
      body[data-theme="dark"] #${SCREEN_ID} .eve-schedule-app-content{background:#1a1a1a}
      body[data-theme="dark"] .eve-schedule-card,body[data-theme="dark"] .eve-schedule-summary,body[data-theme="dark"] .eve-schedule-toolbar{background:#292929;color:#eee;border-color:#444}
      body[data-theme="dark"] .eve-schedule-summary-box{background:#333}
      body[data-theme="dark"] .eve-schedule-bottom{background:rgba(30,30,30,.94);border-color:#444}
      body[data-theme="dark"] .eve-schedule-header-actions button{color:#fff}
    `;
    document.head.appendChild(style);
  }

  function bindHomeIcon(element) {
    if (!element || element.dataset.eveScheduleBound === VERSION) return;
    element.dataset.eveScheduleBound = VERSION;
    element.dataset.eveHomeApp = 'schedule';
    element.addEventListener('click', event => {
      if (window.EVEHomeApps?.handlesClicks) return;
      event.preventDefault();
      open();
    });
  }
  function ensureHomeIcon() {
    const existing = document.getElementById(ICON_ID);
    if (existing) { bindHomeIcon(existing); updateBadge(); return true; }
    const grid = document.querySelector('#eve-home-feature-grid, .home-section.top-right .eve-home-feature-grid, .home-section.top-right .apps-grid-2, .home-section.top-right .apps-grid');
    if (!grid) return false;
    grid.id = 'eve-home-feature-grid';
    grid.classList.remove('apps-grid-2', 'apps-grid', 'eve-apps-grid-4', 'eve-apps-grid-6');
    grid.classList.add('eve-home-feature-grid');
    const link = document.createElement('a');
    link.href = '#'; link.className = 'mini-app'; link.id = ICON_ID;
    link.dataset.eveHomeApp = 'schedule';
    link.innerHTML = '<div class="mini-app-icon"><svg class="eve-home-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 18h3"></path></svg><span class="eve-home-app-badge" data-badge></span></div><span>行程</span>';
    bindHomeIcon(link); grid.appendChild(link); updateBadge(); return true;
  }
  function statusBarMarkup() {
    return `<div class="app-status-bar"><div class="app-status-time"></div><div class="app-status-right"><div class="app-signal-icon signal-icon"><div class="signal-row"><div class="signal-bar"></div><div class="signal-bar"></div><div class="signal-bar"></div><div class="signal-bar"></div></div></div><div class="app-battery-container"><div class="app-battery-icon"><div class="app-battery-level"></div></div></div></div></div>`;
  }
  function ensureScreen() {
    if (document.getElementById(SCREEN_ID)) return true;
    const wallpaper = document.querySelector('#phone-screen .wallpaper') || document.getElementById('phone-screen');
    if (!wallpaper) return false;
    const screen = document.createElement('div'); screen.id = SCREEN_ID; screen.className = 'app-screen';
    screen.innerHTML = `<div class="app-top-container">${statusBarMarkup()}<div class="app-header"><button class="back-button" data-back>‹</button><div class="app-title">角色行程</div><div class="eve-schedule-header-actions"><button data-refresh title="重新生成"><i class="fas fa-sync-alt"></i></button><button data-add title="添加行程"><i class="fas fa-plus"></i></button></div></div></div><div class="app-content eve-schedule-app-content"><div class="eve-schedule-toolbar"><button data-prev>‹</button><button data-today>今天</button><div class="eve-schedule-date" data-date></div><button data-next>›</button></div><div class="eve-schedule-summary" data-summary></div><div class="eve-schedule-list" data-list></div></div><div class="eve-schedule-bottom"><button data-generate><i class="fas fa-magic"></i><br>生成行程</button><button data-manage><i class="fas fa-list"></i><br>详细管理</button><button data-settings><i class="fas fa-sliders-h"></i><br>行程设置</button></div>`;
    wallpaper.appendChild(screen);
    screen.querySelector('[data-back]').onclick = close;
    screen.querySelector('[data-prev]').onclick = () => { selectedDate = shiftDate(selectedDate, -1); render(); };
    screen.querySelector('[data-next]').onclick = () => { selectedDate = shiftDate(selectedDate, 1); render(); };
    screen.querySelector('[data-today]').onclick = () => { selectedDate = clock().date; render(); };
    screen.querySelector('[data-refresh]').onclick = () => generate(true);
    screen.querySelector('[data-generate]').onclick = () => generate(true);
    screen.querySelector('[data-add]').onclick = addManual;
    screen.querySelector('[data-manage]').onclick = () => api()?.openManager?.();
    screen.querySelector('[data-settings]').onclick = () => api()?.openSettings?.();
    return true;
  }
  function close() {
    try { if (typeof hideApp === 'function') return hideApp(SCREEN_ID); } catch (_) {}
    const screen = document.getElementById(SCREEN_ID); if (screen) screen.style.display = 'none';
  }
  function open() {
    if (!api()) { toast('行程核心模块尚未载入，请执行完整修复同步', 'error'); return false; }
    if (!ensureScreen()) { toast('行程界面尚未准备好', 'error'); return false; }
    selectedDate = selectedDate || clock().date;
    try { if (typeof showApp === 'function') showApp(SCREEN_ID); else document.getElementById(SCREEN_ID).style.display = 'flex'; }
    catch (_) { document.getElementById(SCREEN_ID).style.display = 'flex'; }
    render(); emit('eve:schedule-app-opened', { date:selectedDate, chat:chat() });
    return true;
  }
  function editItem(item) {
    const schedule = api(); if (!schedule) return;
    const title = prompt('行程标题', item.title); if (title === null) return;
    const start = prompt('开始时间 HH:MM', item.start); if (start === null) return;
    const end = prompt('结束时间 HH:MM', item.end); if (end === null) return;
    const description = prompt('说明', item.description || ''); if (description === null) return;
    schedule.updateItem(item.id, { title:clean(title,100), start:clean(start,5), end:clean(end,5), description:clean(description,500) }, { date:selectedDate });
    render();
  }
  function addManual() {
    const schedule = api(); if (!schedule) return toast('行程模块未载入', 'error');
    const title = prompt('行程标题'); if (!title) return;
    const start = prompt('开始时间 HH:MM', '19:00'); if (start === null) return;
    const end = prompt('结束时间 HH:MM', '20:00'); if (end === null) return;
    const description = prompt('说明（可留空）', '') ?? '';
    schedule.addItem({ title:clean(title,100), start:clean(start,5), end:clean(end,5), description:clean(description,500), locked:true }, { date:selectedDate });
    render(); toast('已添加行程');
  }
  async function generate(force) {
    const schedule = api(); if (!schedule) return toast('行程模块未载入', 'error');
    const button = document.querySelector(`#${SCREEN_ID} [data-generate]`);
    try {
      if (button) button.disabled = true;
      await schedule.generateDay({ date:selectedDate || clock().date, force:Boolean(force), fullDay:schedule.getSettings?.().mode !== 'on-demand' });
      render(); toast('行程已生成');
    } catch (error) { toast(error?.message || String(error), 'error'); }
    finally { if (button) button.disabled = false; }
  }
  function renderSummary(day) {
    const box = document.querySelector(`#${SCREEN_ID} [data-summary]`); if (!box) return;
    const currentClock = clock(); const currentChat = chat(); const isToday = selectedDate === currentClock.date;
    const current = isToday && day ? api()?.currentItem?.(day) : null;
    const next = isToday && day ? api()?.nextItem?.(day) : day?.items?.find(item => ['planned','adjusted'].includes(item.status));
    box.innerHTML = `<div class="eve-schedule-summary-title"><i class="fas fa-user-clock"></i><span>${escapeHtml(currentChat.name || '当前角色')}</span><small style="margin-left:auto;opacity:.58;font-weight:400">${escapeHtml(day?.timezone || currentClock.timezone || '')}</small></div><div class="eve-schedule-summary-grid"><div class="eve-schedule-summary-box"><small>${isToday ? '当前安排' : '首项安排'}</small><b>${escapeHtml(current?.title || day?.items?.[0]?.title || '暂无')}</b></div><div class="eve-schedule-summary-box"><small>${isToday ? '下一项' : '共计'}</small><b>${escapeHtml(isToday ? (next ? `${next.start} ${next.title}` : '今天已无安排') : `${day?.items?.length || 0} 项行程`)}</b></div></div>`;
  }
  function render() {
    ensureHomeIcon(); ensureScreen();
    const schedule = api(); const currentClock = clock(); selectedDate = selectedDate || currentClock.date;
    const screen = document.getElementById(SCREEN_ID); if (!screen) return;
    screen.querySelector('[data-date]').textContent = displayDate(selectedDate);
    const day = schedule?.getDay?.({ date:selectedDate }) || null; renderSummary(day);
    const list = screen.querySelector('[data-list]'); list.innerHTML = '';
    if (!schedule) { list.innerHTML = '<div class="eve-schedule-empty"><i class="fas fa-exclamation-circle"></i>行程模块未载入</div>'; return; }
    if (!chat().id && !chat().name) { list.innerHTML = '<div class="eve-schedule-empty"><i class="fas fa-comment-dots"></i>请先打开一个角色聊天室<br><small>行程会按角色分别保存</small></div>'; return; }
    if (!day?.items?.length) { list.innerHTML = '<div class="eve-schedule-empty"><i class="far fa-calendar-plus"></i>这一天还没有行程<br><small>点击下方“生成行程”或右上角＋手动添加</small></div>'; updateBadge(); return; }
    const labels = { planned:'计划中', active:'进行中', completed:'已完成', adjusted:'已调整', cancelled:'已取消', missed:'错过' };
    day.items.forEach(item => {
      const card = document.createElement('div'); card.className = `eve-schedule-card ${item.status || ''}`;
      card.innerHTML = `<div class="eve-schedule-time">${escapeHtml(item.start)}<br><span style="opacity:.5;font-weight:500">${escapeHtml(item.end)}</span></div><div><div class="eve-schedule-title">${escapeHtml(item.title)}${item.locked ? ' 🔒' : ''}${item.private ? ' 🔐' : ''}</div><div class="eve-schedule-desc">${escapeHtml(item.description || item.type || '')}</div><span class="eve-schedule-status">${escapeHtml(labels[item.status] || item.status)}</span></div><div class="eve-schedule-card-actions"><button data-edit>编辑</button><button data-done>${item.status === 'completed' ? '恢复' : '完成'}</button><button data-lock>${item.locked ? '解锁' : '锁定'}</button><button data-delete style="color:#c33">删除</button></div>`;
      card.querySelector('[data-edit]').onclick = () => editItem(item);
      card.querySelector('[data-done]').onclick = () => { schedule.updateItem(item.id, { status:item.status === 'completed' ? 'planned' : 'completed', completedAt:item.status === 'completed' ? 0 : Date.now() }, { date:selectedDate }); render(); };
      card.querySelector('[data-lock]').onclick = () => { schedule.updateItem(item.id, { locked:!item.locked }, { date:selectedDate }); render(); };
      card.querySelector('[data-delete]').onclick = () => { if (confirm(`删除“${item.title}”？`)) { schedule.removeItem(item.id, { date:selectedDate }); render(); } };
      list.appendChild(card);
    });
    updateBadge();
  }
  function updateBadge() {
    const badge = document.querySelector(`#${ICON_ID} [data-badge]`); if (!badge) return;
    const day = api()?.getDay?.({ date:clock().date });
    const count = (day?.items || []).filter(item => ['planned','active','adjusted'].includes(item.status)).length;
    badge.textContent = count > 99 ? '99+' : String(count); badge.style.display = count ? 'block' : 'none';
  }
  function getDiagnostics() { return { version:VERSION, initialized, icon:Boolean(document.getElementById(ICON_ID)), screen:Boolean(document.getElementById(SCREEN_ID)), selectedDate, scheduleLoaded:Boolean(api()) }; }
  function init() {
    if (initialized) return Promise.resolve(getDiagnostics());
    initialized = true; ensureStyle();
    const retry = setInterval(() => { const icon=ensureHomeIcon(), screen=ensureScreen(); if (icon && screen) clearInterval(retry); }, 500);
    setTimeout(() => clearInterval(retry), 30000); ensureHomeIcon(); ensureScreen();
    on(window, 'eve:schedule-updated', () => { updateBadge(); if (document.getElementById(SCREEN_ID)?.style.display === 'flex') render(); });
    on(window, 'eve:schedule-day-cleared', () => { updateBadge(); render(); });
    on(window, 'eve:schedule-item-started', () => { updateBadge(); render(); });
    on(window, 'eve:schedule-ready', () => { updateBadge(); render(); });
    on(window, 'eve:adapter-ready', updateBadge);
    window.EVE ||= {}; window.EVE.dailyScheduleApp = window.EVEDailyScheduleApp;
    emit('eve:schedule-app-ready', getDiagnostics()); return Promise.resolve(getDiagnostics());
  }
  function destroy() {
    disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} });
    document.getElementById(ICON_ID)?.remove(); document.getElementById(SCREEN_ID)?.remove(); document.getElementById(STYLE_ID)?.remove(); initialized = false;
  }

  window.EVEDailyScheduleApp = Object.freeze({ version:VERSION, init, destroy, open, close, render, updateBadge, getDiagnostics });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);

/* ===== END daily-schedule/app ===== */

/* ===== BEGIN diary/core ===== */
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

/* ===== END diary/core ===== */

/* ===== BEGIN diary/app ===== */
/** EVE Diary Home App v1.5.4 */
(function (window, document) {
  'use strict';
  if (window.EVEDiaryApp?.version) return;
  const VERSION='1.5.4', SCREEN_ID='eve-diary-screen', ICON_ID='eve-diary-home-app', STYLE_ID='eve-diary-app-style';
  let initialized=false, selectedDate='', query=''; const disposers=[];
  function api(){return window.EVEDiary||null}
  function chat(){return window.EVEAdapter?.getCurrentChat?.()||{id:'',name:'角色日记',scope:'global'}}
  function clean(v,m=1000){return String(v??'').replace(/\r\n?/g,'\n').trim().slice(0,m)}
  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function toast(m,t='success'){try{if(typeof showToast==='function')return showToast(m,t)}catch(_){} if(window.showToast)return window.showToast(m,t); alert(m)}
  function on(target,event,handler,opts){target.addEventListener(event,handler,opts);disposers.push(()=>target.removeEventListener(event,handler,opts))}
  function shiftDate(value,amount){const d=/^\d{4}-\d{2}-\d{2}$/.test(value||'')?new Date(`${value}T12:00:00`):new Date();d.setDate(d.getDate()+amount);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
  function displayDate(value){try{return new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'long',day:'numeric',weekday:'short'}).format(new Date(`${value}T12:00:00`))}catch(_){return value}}
  function moodEmoji(m){return ({开心:'😊',平静:'😌',放松:'🤍',疲惫:'😮‍💨',烦躁:'😤',难过:'😔',紧张:'😣',期待:'✨',复杂:'🌫️'})[m]||'📖'}
  function ensureStyle(){if(document.getElementById(STYLE_ID))return;const s=document.createElement('style');s.id=STYLE_ID;s.textContent=`
.home-section.top-right .eve-apps-grid-6{display:grid!important;grid-template-columns:repeat(3,1fr)!important;grid-template-rows:repeat(2,1fr)!important;gap:4px 7px!important;width:100%;height:100%;padding:1px;align-items:center}.home-section.top-right .eve-apps-grid-6 .mini-app{min-width:0;min-height:0;font-size:9px!important;line-height:1.05}.home-section.top-right .eve-apps-grid-6 .mini-app-icon{width:36px!important;height:36px!important;border-radius:11px!important;margin-bottom:1px}.home-section.top-right .eve-apps-grid-6 .mini-app-icon i{font-size:18px!important}
#${SCREEN_ID}{background:var(--body-bg,#fff)}#${SCREEN_ID} .eve-diary-content{padding:0;overflow-y:auto;background:linear-gradient(180deg,#f4f1eb,#f9f8f5)}.eve-diary-toolbar{display:flex;align-items:center;gap:8px;padding:11px 13px;background:rgba(255,255,255,.93);border-bottom:1px solid rgba(0,0,0,.08);position:sticky;top:0;z-index:3;backdrop-filter:blur(14px)}.eve-diary-toolbar button{border:0;background:#eee7dc;color:#6d5943;border-radius:10px;padding:7px 10px}.eve-diary-date{flex:1;text-align:center;font-weight:700;font-size:14px}.eve-diary-search{margin:10px 12px 0;display:flex;gap:8px}.eve-diary-search input{flex:1;border:1px solid #ddd4c8;border-radius:12px;padding:10px 12px;background:#fff}.eve-diary-list{padding:10px 12px 94px}.eve-diary-card{background:#fffefb;border:1px solid #e8e0d4;border-radius:16px;margin-bottom:12px;box-shadow:0 5px 15px rgba(74,55,30,.06);overflow:hidden}.eve-diary-card-head{display:flex;align-items:center;gap:10px;padding:13px 14px 9px;border-bottom:1px dashed #e4dbce}.eve-diary-mood{font-size:25px}.eve-diary-headtext{flex:1;min-width:0}.eve-diary-title{font-weight:800;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.eve-diary-meta{font-size:11px;opacity:.55;margin-top:3px}.eve-diary-body{padding:13px 15px 15px;white-space:pre-wrap;line-height:1.72;font-size:14px;color:#3f372e}.eve-diary-reason{margin-top:10px;padding:8px 10px;background:#f7f2e9;border-radius:10px;font-size:12px;color:#776754}.eve-diary-images{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:11px}.eve-diary-images img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:9px}.eve-diary-actions{display:flex;gap:7px;padding:0 14px 13px}.eve-diary-actions button{border:0;border-radius:9px;background:#f1ece5;padding:6px 9px;font-size:11px;color:#66584a}.eve-diary-empty{text-align:center;padding:78px 24px;color:#9b8c7b}.eve-diary-empty i{display:block;font-size:44px;margin-bottom:12px}.eve-diary-bottom{position:absolute;left:0;right:0;bottom:0;height:62px;padding:8px 12px calc(8px + env(safe-area-inset-bottom));box-sizing:content-box;background:rgba(255,255,255,.94);border-top:1px solid rgba(0,0,0,.08);display:grid;grid-template-columns:repeat(3,1fr);gap:8px;z-index:12}.eve-diary-bottom button{border:0;border-radius:12px;background:#eee7dc;color:#6d5943;font-weight:700;font-size:12px}.eve-diary-header-actions{position:absolute;right:19px;top:52px;transform:translateY(-50%);display:flex;gap:8px}.eve-diary-header-actions button{border:0;background:transparent;font-size:17px;color:#333;padding:5px}body[data-theme="dark"] #${SCREEN_ID} .eve-diary-content{background:#181614}body[data-theme="dark"] .eve-diary-card,body[data-theme="dark"] .eve-diary-toolbar{background:#292622;color:#eee;border-color:#4a433a}body[data-theme="dark"] .eve-diary-body{color:#eee}body[data-theme="dark"] .eve-diary-reason,body[data-theme="dark"] .eve-diary-search input{background:#34302b;color:#eee;border-color:#4b443c}body[data-theme="dark"] .eve-diary-bottom{background:rgba(30,28,25,.95)}body[data-theme="dark"] .eve-diary-header-actions button{color:#fff}`;document.head.appendChild(s)}
  function bindHomeIcon(element){
    if(!element||element.dataset.eveDiaryBound===VERSION)return;
    element.dataset.eveDiaryBound=VERSION;
    element.dataset.eveHomeApp='diary';
    element.addEventListener('click',e=>{
      if(window.EVEHomeApps?.handlesClicks)return;
      e.preventDefault();open();
    });
  }
  function ensureHomeIcon(){
    const existing=document.getElementById(ICON_ID);
    if(existing){bindHomeIcon(existing);return true}
    const grid=document.querySelector('#eve-home-feature-grid,.home-section.top-right .eve-home-feature-grid,.home-section.top-right .apps-grid-2,.home-section.top-right .apps-grid');
    if(!grid)return false;
    grid.id='eve-home-feature-grid';grid.classList.remove('apps-grid-2','apps-grid','eve-apps-grid-4','eve-apps-grid-6');grid.classList.add('eve-home-feature-grid');
    const a=document.createElement('a');a.href='#';a.className='mini-app';a.id=ICON_ID;a.dataset.eveHomeApp='diary';
    a.innerHTML='<div class="mini-app-icon"><svg class="eve-home-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h12a2 2 0 0 1 2 2v16H7a2 2 0 0 1-2-2V3z"></path><path d="M8 3v18M11 8h5M11 12h5M11 16h4"></path></svg></div><span>日记</span>';
    bindHomeIcon(a);grid.appendChild(a);return true;
  }
  function statusBar(){return `<div class="app-status-bar"><div class="app-status-time"></div><div class="app-status-right"><div class="app-signal-icon signal-icon"><div class="signal-row"><div class="signal-bar"></div><div class="signal-bar"></div><div class="signal-bar"></div><div class="signal-bar"></div></div></div><div class="app-battery-container"><div class="app-battery-icon"><div class="app-battery-level"></div></div></div></div></div>`}
  function ensureScreen(){if(document.getElementById(SCREEN_ID))return true;const wallpaper=document.querySelector('#phone-screen .wallpaper')||document.getElementById('phone-screen');if(!wallpaper)return false;const screen=document.createElement('div');screen.id=SCREEN_ID;screen.className='app-screen';screen.innerHTML=`<div class="app-top-container">${statusBar()}<div class="app-header"><button class="back-button" data-back>‹</button><div class="app-title">角色日记</div><div class="eve-diary-header-actions"><button data-search title="搜索"><i class="fas fa-search"></i></button><button data-add title="手写"><i class="fas fa-plus"></i></button></div></div></div><div class="app-content eve-diary-content"><div class="eve-diary-toolbar"><button data-prev>‹</button><button data-today>今天</button><div class="eve-diary-date" data-date></div><button data-next>›</button></div><div class="eve-diary-search" data-search-box style="display:none"><input data-query placeholder="搜索日记内容"><button data-search-go>搜索</button></div><div class="eve-diary-list" data-list></div></div><div class="eve-diary-bottom"><button data-generate><i class="fas fa-feather-alt"></i><br>生成日记</button><button data-all><i class="fas fa-book"></i><br>全部日记</button><button data-settings><i class="fas fa-sliders-h"></i><br>日记设置</button></div>`;wallpaper.appendChild(screen);screen.querySelector('[data-back]').onclick=close;screen.querySelector('[data-prev]').onclick=()=>{selectedDate=shiftDate(selectedDate,-1);query='';render()};screen.querySelector('[data-next]').onclick=()=>{selectedDate=shiftDate(selectedDate,1);query='';render()};screen.querySelector('[data-today]').onclick=()=>{selectedDate=api()?.getLocalDate?.()||shiftDate('',0);query='';render()};screen.querySelector('[data-add]').onclick=addManual;screen.querySelector('[data-generate]').onclick=()=>generate(true);screen.querySelector('[data-all]').onclick=()=>{selectedDate='';query='';render()};screen.querySelector('[data-settings]').onclick=openSettings;screen.querySelector('[data-search]').onclick=()=>{const box=screen.querySelector('[data-search-box]');box.style.display=box.style.display==='none'?'flex':'none'};screen.querySelector('[data-search-go]').onclick=()=>{query=clean(screen.querySelector('[data-query]').value,100);selectedDate='';render()};return true}
  function close(){try{if(typeof hideApp==='function')return hideApp(SCREEN_ID)}catch(_){}const s=document.getElementById(SCREEN_ID);if(s)s.style.display='none'}
  async function open(){
    try { window.EVECriticalModules?.repair?.(); } catch (_) {}
    if(!api()){toast('日记核心模块尚未载入，请重新同步完整 App','error');return false}
    if(!ensureScreen()){toast('日记界面尚未准备好','error');return false}
    selectedDate=selectedDate||api()?.getLocalDate?.()||shiftDate('',0);
    try{if(typeof showApp==='function')showApp(SCREEN_ID);else document.getElementById(SCREEN_ID).style.display='flex'}catch(_){document.getElementById(SCREEN_ID).style.display='flex'}
    try { await render(); return true; }
    catch(error){ console.error('[EVEDiaryApp] 打开失败',error); toast(`日记打开失败：${error?.message||error}`,'error'); return false; }
  }
  async function fileToDataURL(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result||''));r.onerror=()=>rej(r.error||new Error('图片读取失败'));r.readAsDataURL(file)})}
  async function chooseImages(){return new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.accept='image/*';input.multiple=true;input.style.display='none';document.body.appendChild(input);input.onchange=async()=>{const out=[];for(const f of [...input.files].slice(0,9)){try{out.push(await fileToDataURL(f))}catch(_){}}input.remove();resolve(out)};input.oncancel=()=>{input.remove();resolve([])};input.click()})}
  async function addManual(){const d=selectedDate||api()?.getLocalDate?.();const title=prompt('日记标题','今天');if(title===null)return;const content=prompt('写下今天的日记','');if(content===null||!content.trim())return;const mood=prompt('心情（开心／平静／放松／疲惫／烦躁／难过／紧张／期待／复杂）','平静')||'平静';const add=confirm('要添加图片吗？');const images=add?await chooseImages():[];await api().save({date:d,title,content,mood,source:'manual',privacy:'private',images});toast('日记已保存');render()}
  async function edit(entry){const title=prompt('日记标题',entry.title);if(title===null)return;const content=prompt('日记正文',entry.content);if(content===null)return;const mood=prompt('心情',entry.mood||'平静');if(mood===null)return;const privacy=confirm('设为可分享日记？\n确定＝可分享，取消＝私人')?'shared':'private';await api().save(Object.assign({},entry,{title,content,mood,privacy}));render()}
  async function generate(force){const button=document.querySelector(`#${SCREEN_ID} [data-generate]`);try{if(button)button.disabled=true;await api().generate({date:selectedDate||api().getLocalDate(),force});toast('日记已生成');render()}catch(e){toast(e?.message||String(e),'error')}finally{if(button)button.disabled=false}}
  function openSettings(){const s=api()?.getSettings?.();if(!s)return;const time=prompt('每天自动生成时间（HH:MM）',s.generateTime||'23:50');if(time===null)return;const auto=confirm('是否开启每天自动生成日记？');const privacy=confirm('自动生成日记默认设为可分享？\n确定＝可分享，取消＝私人')?'shared':'private';api().configure({generateTime:time,autoGenerate:auto,defaultPrivacy:privacy});toast('日记设置已保存')}
  async function render(){ensureHomeIcon();ensureScreen();const diary=api();if(!diary)throw new Error('日记核心模块未载入');const screen=document.getElementById(SCREEN_ID);if(!screen)return;screen.querySelector('[data-date]').textContent=selectedDate?displayDate(selectedDate):(query?`搜索：${query}`:'全部日记');const list=screen.querySelector('[data-list]');list.innerHTML='';if(!chat().id){list.innerHTML='<div class="eve-diary-empty"><i class="fas fa-comment-dots"></i>请先打开一个角色聊天室<br><small>每个角色拥有独立日记本</small></div>';return}let entries=await diary.list({date:selectedDate||undefined,query,limit:500});if(!entries.length){list.innerHTML='<div class="eve-diary-empty"><i class="fas fa-book-open"></i>还没有日记<br><small>可以生成当天日记或手写一篇</small></div>';return}for(const entry of entries){const card=document.createElement('article');card.className='eve-diary-card';const imgs=(entry.images||[]).map(src=>`<img src="${src}" alt="日记图片">`).join('');card.innerHTML=`<div class="eve-diary-card-head"><div class="eve-diary-mood">${moodEmoji(entry.mood)}</div><div class="eve-diary-headtext"><div class="eve-diary-title">${esc(entry.title)}</div><div class="eve-diary-meta">${esc(entry.date)} · ${esc(entry.characterName||chat().name)} · ${entry.source==='ai'?'AI整理':'手写'} · ${entry.privacy==='private'?'🔒 私人':'🤍 可分享'}</div></div></div><div class="eve-diary-body">${esc(entry.content)}${entry.moodReason?`<div class="eve-diary-reason">心情：${esc(entry.mood)} · ${esc(entry.moodReason)}</div>`:''}${imgs?`<div class="eve-diary-images">${imgs}</div>`:''}</div><div class="eve-diary-actions"><button data-edit>编辑</button><button data-privacy>${entry.privacy==='private'?'设为分享':'设为私人'}</button><button data-delete style="color:#b33">删除</button></div>`;card.querySelector('[data-edit]').onclick=()=>edit(entry);card.querySelector('[data-privacy]').onclick=async()=>{await api().save(Object.assign({},entry,{privacy:entry.privacy==='private'?'shared':'private'}));render()};card.querySelector('[data-delete]').onclick=async()=>{if(confirm(`删除“${entry.title}”？`)){await api().remove(entry.id);render()}};list.appendChild(card)}}
  function init(){
    if(initialized)return {version:VERSION,initialized:true,coreLoaded:Boolean(api())};
    initialized=true;ensureStyle();
    const retry=setInterval(()=>{if(ensureHomeIcon()&&ensureScreen())clearInterval(retry)},500);
    setTimeout(()=>clearInterval(retry),30000);ensureHomeIcon();ensureScreen();
    on(window,'eve:diary-updated',()=>{if(document.getElementById(SCREEN_ID)?.style.display==='flex')render()});
    on(window,'eve:diary-removed',()=>render());
    window.EVE ||= {};window.EVE.diaryApp=window.EVEDiaryApp;
    try{window.dispatchEvent(new CustomEvent('eve:diary-app-ready',{detail:{version:VERSION,coreLoaded:Boolean(api())}}))}catch(_){}
    return {version:VERSION,initialized:true,coreLoaded:Boolean(api())};
  }
  function destroy(){disposers.splice(0).forEach(fn=>{try{fn()}catch(_){}});document.getElementById(ICON_ID)?.remove();document.getElementById(SCREEN_ID)?.remove();document.getElementById(STYLE_ID)?.remove();initialized=false}
  window.EVEDiaryApp=Object.freeze({version:VERSION,init,destroy,open,close,render});document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init,{once:true}):init()
})(window,document);

/* ===== END diary/app ===== */

/* ===== BEGIN role-fidelity/ui ===== */
/** EVE Role Fidelity UI v1.1.0 */
(function (window, document) {
  'use strict';
  if (window.EVERoleFidelityUI?.version) return;
  const VERSION = '1.1.0';
  let initialized = false;
  let retryTimer = null;

  function rf() { return window.EVERoleFidelity; }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]); }
  function toast(text, type='success') { if (typeof window.showToast === 'function') window.showToast(text, type); else alert(text); }
  function currentChat() { return window.EVEAdapter?.getCurrentChat?.() || { id:'', name:'', title:'', open:false }; }

  function addStyles() {
    if (document.getElementById('eve-role-fidelity-style')) return;
    const style = document.createElement('style'); style.id='eve-role-fidelity-style';
    style.textContent = `
      #eve-role-fidelity-modal{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:10px}
      #eve-role-fidelity-modal .rf-panel{width:min(760px,100%);max-height:94vh;overflow:auto;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:20px;box-shadow:0 18px 60px #0005}
      #eve-role-fidelity-modal .rf-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;padding:15px 17px;border-bottom:1px solid rgba(0,0,0,.09);background:var(--secondary-bg,#fff)}
      #eve-role-fidelity-modal .rf-title{flex:1;font-size:17px;font-weight:700}
      #eve-role-fidelity-modal .rf-close{border:0;background:transparent;font-size:20px;cursor:pointer}
      #eve-role-fidelity-modal .rf-body{padding:13px}
      #eve-role-fidelity-modal .rf-card{border:1px solid rgba(0,0,0,.1);border-radius:14px;margin-bottom:12px;overflow:hidden;background:rgba(127,127,127,.035)}
      #eve-role-fidelity-modal .rf-card h3{font-size:15px;margin:0;padding:12px 14px;border-bottom:1px solid rgba(0,0,0,.08)}
      #eve-role-fidelity-modal .rf-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(150px,44%);gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid rgba(0,0,0,.055)}
      #eve-role-fidelity-modal .rf-row:last-child{border-bottom:0}
      #eve-role-fidelity-modal .rf-label b{display:block;font-size:14px}.rf-label small{opacity:.65;line-height:1.4}
      #eve-role-fidelity-modal input[type=text],#eve-role-fidelity-modal input[type=number],#eve-role-fidelity-modal select,#eve-role-fidelity-modal textarea{width:100%;box-sizing:border-box;border:1px solid rgba(0,0,0,.16);border-radius:9px;background:var(--secondary-bg,#fff);color:inherit;padding:8px;font:inherit}
      #eve-role-fidelity-modal textarea{min-height:90px;resize:vertical;line-height:1.5}
      #eve-role-fidelity-modal .rf-actions{display:flex;flex-wrap:wrap;gap:8px;padding:11px 14px}
      #eve-role-fidelity-modal button.rf-btn{border:0;border-radius:10px;padding:9px 13px;background:#4a84c1;color:#fff;cursor:pointer;font-weight:600}
      #eve-role-fidelity-modal button.rf-btn.secondary{background:rgba(127,127,127,.15);color:inherit}
      #eve-role-fidelity-modal button.rf-btn.danger{background:#d9534f}
      #eve-role-fidelity-modal .rf-status{font-size:12px;line-height:1.55;padding:9px 14px;background:rgba(74,132,193,.08);white-space:pre-wrap}
      #eve-role-fidelity-modal .rf-two{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px 14px}
      #eve-role-fidelity-modal .rf-field label{display:block;font-size:12px;font-weight:650;margin-bottom:5px}
      #eve-role-fidelity-modal .rf-full{grid-column:1/-1}
      @media(max-width:560px){#eve-role-fidelity-modal .rf-row{grid-template-columns:1fr}#eve-role-fidelity-modal .rf-two{grid-template-columns:1fr}}
      body[data-theme=dark] #eve-role-fidelity-modal .rf-head{background:#222}
    `;
    document.head.appendChild(style);
  }

  function settingsItem() {
    const item = document.createElement('div');
    item.id='eve-role-fidelity-setting-item'; item.className='setting-item';
    item.innerHTML=`<div class="setting-left"><div class="setting-label">角色贴合增强</div><div class="setting-desc">通用角色档案与萧逸专属深度模块</div></div><div class="setting-right"><button type="button" class="rf-open-setting" style="border:0;background:rgba(74,132,193,.12);color:#4a84c1;border-radius:10px;padding:7px 11px">设置</button></div>`;
    item.querySelector('button').onclick=openManager;
    return item;
  }
  function injectSetting() {
    if (document.getElementById('eve-role-fidelity-setting-item')) return true;
    const section = document.getElementById('eve-extension-settings-section');
    if (section) {
      const holder = section.querySelector('[data-eve-list],.setting-card,.settings-list,.settings-section-content,.settings-group') || section;
      holder.appendChild(settingsItem()); return true;
    }
    // 等待统一的 EVE 扩展功能区建立，避免生成重复或脱离卡片的入口。
    return false;
  }

  function profileOptions(selected) {
    const options = ['<option value="">不绑定专属档案</option>'];
    for (const profile of rf()?.listProfiles?.() || []) options.push(`<option value="${escapeHtml(profile.id)}" ${selected===profile.id?'selected':''}>${escapeHtml(profile.name)}${profile.builtin?'（内置）':''}</option>`);
    return options.join('');
  }

  function modalHtml() {
    const api=rf(); const settings=api?.getSettings?.() || {}; const chat=currentChat(); const binding=chat.id ? api?.getBinding?.(chat.id) : '';
    const diagnostics=api?.diagnostics?.() || {};
    return `<div class="rf-panel" role="dialog" aria-modal="true">
      <div class="rf-head"><div class="rf-title">角色贴合增强</div><button class="rf-close" data-close>✕</button></div>
      <div class="rf-body">
        <div class="rf-card"><h3>当前角色</h3>
          <div class="rf-status">聊天角色：${escapeHtml(chat.name || chat.title || '尚未打开角色聊天')}\n角色ID：${escapeHtml(chat.id || '无')}\n当前识别：${escapeHtml(diagnostics.activeProfile?.name || '未启用角色档案')} ${diagnostics.activeProfile?.reason?`（${escapeHtml(diagnostics.activeProfile.reason)}）`:''}</div>
          <div class="rf-row"><div class="rf-label"><b>绑定角色档案</b><small>按角色ID绑定，不会污染其他角色</small></div><select id="rf-bind-profile">${profileOptions(binding)}</select></div>
          <div class="rf-actions"><button class="rf-btn" data-bind ${chat.id?'':'disabled'}>保存绑定</button><button class="rf-btn secondary" data-export-active>导出当前档案</button></div>
        </div>

        <div class="rf-card"><h3>通用引擎</h3>
          <div class="rf-row"><div class="rf-label"><b>启用角色贴合</b></div><input id="rf-enabled" type="checkbox" ${settings.enabled?'checked':''}></div>
          <div class="rf-row"><div class="rf-label"><b>自动匹配角色名称</b><small>绑定优先，自动匹配只作后备</small></div><input id="rf-auto-match" type="checkbox" ${settings.autoMatch?'checked':''}></div>
          <div class="rf-row"><div class="rf-label"><b>贴合强度</b></div><select id="rf-strictness"><option value="normal" ${settings.strictness==='normal'?'selected':''}>普通</option><option value="strict" ${settings.strictness==='strict'?'selected':''}>严格</option><option value="extreme" ${settings.strictness==='extreme'?'selected':''}>极严格</option></select></div>
          <div class="rf-row"><div class="rf-label"><b>程序修正语言格式</b><small>例如按角色习惯处理句尾标点</small></div><input id="rf-normalize" type="checkbox" ${settings.normalizeOutput?'checked':''}></div>
          <div class="rf-row"><div class="rf-label"><b>本地OOC检测</b><small>不额外调用API，只记录明显偏差</small></div><input id="rf-ooc" type="checkbox" ${settings.detectOoc?'checked':''}></div>
          <div class="rf-row"><div class="rf-label"><b>使用角色推荐生成参数</b><small>萧逸专属档案会降低过高温度</small></div><input id="rf-tune" type="checkbox" ${settings.tuneGeneration?'checked':''}></div>
          <div class="rf-row"><div class="rf-label"><b>每轮参考示例数</b></div><input id="rf-example-limit" type="number" min="0" max="10" value="${Number(settings.exampleLimit)||4}"></div>
          <div class="rf-actions"><button class="rf-btn" data-save-settings>保存通用设置</button><button class="rf-btn secondary" data-diagnostics>查看诊断</button></div>
        </div>

        <div class="rf-card" id="rf-xiaoyi-card" style="display:${(rf()?.listProfiles?.()||[]).some(x=>x.id==='xiaoyi')?'block':'none'}"><h3>萧逸专属模块</h3>
          <div class="rf-status">内置：萧逸・夕月专属版\n包含深层性格逻辑、聊天／动态分场景语言、R1五冠王职业层与句尾标点规则</div>
          <div class="rf-actions"><button class="rf-btn secondary" data-r1-settings>R1实时赛事设置</button><button class="rf-btn secondary" data-xiaoyi-summary>查看萧逸档案摘要</button></div>
        </div>

        <div class="rf-card"><h3>创建通用角色档案</h3>
          <div class="rf-two">
            <div class="rf-field"><label>角色名称</label><input id="rf-custom-name" type="text" placeholder="例如：某个角色"></div>
            <div class="rf-field"><label>别名（逗号分隔）</label><input id="rf-custom-aliases" type="text" placeholder="英文名、昵称"></div>
            <div class="rf-field rf-full"><label>角色核心与背景</label><textarea id="rf-custom-core" placeholder="粘贴角色人设、性格和重要经历"></textarea></div>
            <div class="rf-field rf-full"><label>语言习惯</label><textarea id="rf-custom-speech" placeholder="例如：短消息、少用句号、会反问"></textarea></div>
            <div class="rf-field rf-full"><label>与使用者的关系</label><textarea id="rf-custom-relationship" placeholder="固定关系设定"></textarea></div>
            <div class="rf-field rf-full"><label>禁止偏差（每行一条）</label><textarea id="rf-custom-forbidden" placeholder="心理咨询师式回复\n无条件顺从"></textarea></div>
          </div>
          <div class="rf-actions"><button class="rf-btn" data-create-profile>保存通用档案</button><button class="rf-btn secondary" data-import-profile>导入JSON</button></div>
        </div>
      </div>
    </div>`;
  }

  function openManager() {
    if (!rf()) return toast('角色贴合引擎尚未载入','error');
    addStyles(); document.getElementById('eve-role-fidelity-modal')?.remove();
    const overlay=document.createElement('div');overlay.id='eve-role-fidelity-modal';overlay.innerHTML=modalHtml();document.body.appendChild(overlay);
    const close=()=>overlay.remove(); overlay.querySelector('[data-close]').onclick=close; overlay.onclick=e=>{if(e.target===overlay)close()};
    overlay.querySelector('[data-bind]').onclick=()=>{const chat=currentChat();if(!chat.id)return toast('请先打开一个角色聊天','error');const value=overlay.querySelector('#rf-bind-profile').value;rf().bindProfile(chat.id,value||null);toast(value?'角色档案已绑定':'已取消绑定');close();openManager()};
    overlay.querySelector('[data-save-settings]').onclick=()=>{rf().configure({enabled:overlay.querySelector('#rf-enabled').checked,autoMatch:overlay.querySelector('#rf-auto-match').checked,strictness:overlay.querySelector('#rf-strictness').value,normalizeOutput:overlay.querySelector('#rf-normalize').checked,detectOoc:overlay.querySelector('#rf-ooc').checked,tuneGeneration:overlay.querySelector('#rf-tune').checked,exampleLimit:Number(overlay.querySelector('#rf-example-limit').value)||4});toast('角色贴合设置已保存');};
    overlay.querySelector('[data-diagnostics]').onclick=()=>{const text=JSON.stringify(rf().diagnostics(),null,2);navigator.clipboard?.writeText(text).then(()=>toast('诊断已复制')).catch(()=>prompt('诊断内容',text));};
    overlay.querySelector('[data-export-active]').onclick=()=>{const active=rf().resolveActive();if(!active)return toast('当前没有启用角色档案','error');downloadText(`${active.id}-role-profile.json`,rf().exportProfile(active.id));};
    overlay.querySelector('[data-create-profile]').onclick=()=>{const name=overlay.querySelector('#rf-custom-name').value.trim();if(!name)return toast('请填写角色名称','error');const profile=rf().saveCustomProfile({name,aliases:overlay.querySelector('#rf-custom-aliases').value.split(/[，,]/).map(x=>x.trim()).filter(Boolean),summary:overlay.querySelector('#rf-custom-core').value.trim(),speechStyle:{prompt:overlay.querySelector('#rf-custom-speech').value.trim()},relationship:{summary:overlay.querySelector('#rf-custom-relationship').value.trim()},forbiddenDeviations:overlay.querySelector('#rf-custom-forbidden').value.split('\n').map(x=>x.trim()).filter(Boolean),sceneRules:{chat:['像真实聊天一样自然回应，不要把人设资料逐条朗读']}});toast(`已创建：${profile.name}`);close();openManager()};
    overlay.querySelector('[data-import-profile]').onclick=()=>{const input=document.createElement('input');input.type='file';input.accept='application/json,.json';input.onchange=async()=>{try{const profile=rf().importProfile(await input.files[0].text());toast(`已导入：${profile.name}`);close();openManager()}catch(error){toast(`导入失败：${error.message}`,'error')}};input.click()};
    overlay.querySelector('[data-r1-settings]').onclick=()=>window.EVEXiaoYiR1?.openSettings?.() || toast('R1模块尚未载入','error');
    overlay.querySelector('[data-xiaoyi-summary]').onclick=()=>{const p=rf().getProfile('xiaoyi');alert([p?.summary,'','R1身份：'+(p?.racingIdentity?.title||'R1五冠王'),'关系：'+(p?.relationship?.summary||'')].filter(Boolean).join('\n'))};
  }

  function downloadText(name,text){const blob=new Blob([text],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  function init(){if(initialized)return;initialized=true;addStyles();if(!injectSetting())retryTimer=setInterval(()=>{if(injectSetting()){clearInterval(retryTimer);retryTimer=null}},700);}
  function destroy(){if(retryTimer)clearInterval(retryTimer);document.getElementById('eve-role-fidelity-setting-item')?.remove();document.getElementById('eve-role-fidelity-standalone-section')?.remove();document.getElementById('eve-role-fidelity-modal')?.remove();initialized=false;}
  window.EVERoleFidelityUI=Object.freeze({version:VERSION,init,destroy,openManager,inject:injectSetting});
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init,{once:true}):init();
})(window,document);

/* ===== END role-fidelity/ui ===== */

(function(window, document){
  'use strict';
  const state = window.EVECriticalModules || {};
  state.version='1.5.4'; state.bundled=true;
  state.diagnostics=function(){ return {
    version:state.version,
    diary:Boolean(window.EVEDiary), diaryApp:Boolean(window.EVEDiaryApp),
    schedule:Boolean(window.EVEDailySchedule), scheduleApp:Boolean(window.EVEDailyScheduleApp),
    roleFidelity:Boolean(window.EVERoleFidelity), roleFidelityUI:Boolean(window.EVERoleFidelityUI),
    extensionSettings:Boolean(document.getElementById('eve-extension-settings-section')),
    roleSetting:Boolean(document.getElementById('eve-role-fidelity-setting-item'))
  }; };
  state.repair=function(){
    try { window.EVEDailySchedule?.init?.(); } catch (_) {}
    try { window.EVEDailyScheduleApp?.init?.(); } catch (_) {}
    try { window.EVEDiary?.init?.(); } catch (_) {}
    try { window.EVEDiaryApp?.init?.(); } catch (_) {}
    try { window.EVERoleFidelity?.init?.(); } catch (_) {}
    try { window.EVERoleFidelityUI?.init?.(); window.EVERoleFidelityUI?.inject?.(); } catch (_) {}
    return state.diagnostics();
  };
  window.EVECriticalModules=state;
  const init=()=>{ try { state.repair(); } catch (_) {} };
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init,{once:true}):init();
})(window, document);
