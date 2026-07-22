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
