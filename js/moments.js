/**
 * EVE Chat Moments Enhancement v0.9.0
 * - Repairs character replies to user comments on Moments.
 * - Adds a guarded fallback for batch comments.
 * - Emits normalized Moments interaction events for notifications/timeline.
 * - Applies small WeChat-like presentation refinements without rebuilding the page.
 */
(function (window, document) {
  'use strict';
  if (window.EVEMoments?.version) return;

  const VERSION = '0.9.0';
  const STORAGE_KEY = 'eve_moments_settings_v09';
  const DEFAULTS = Object.freeze({
    enabled: true,
    repairReplies: true,
    repairBatchComments: true,
    retryCount: 2,
    maxBatchComments: 3,
    replyMaxChars: 90,
    useAdapterContext: true,
    wechatStyle: true,
    notifyInteractions: true,
    fallbackToOriginal: true
  });

  let settings = load();
  let initialized = false;
  let nativeReply = null;
  let nativeBatch = null;
  let nativeSaveComment = null;
  let nativeInteractionNotice = null;
  const recentEvents = new Map();

  function safeClone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }
  function load() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); }
    catch (_) { return Object.assign({}, DEFAULTS); }
  }
  function save(next = {}) {
    settings = Object.assign({}, settings, next || {});
    settings.enabled = Boolean(settings.enabled);
    settings.repairReplies = Boolean(settings.repairReplies);
    settings.repairBatchComments = Boolean(settings.repairBatchComments);
    settings.wechatStyle = Boolean(settings.wechatStyle);
    settings.notifyInteractions = Boolean(settings.notifyInteractions);
    settings.useAdapterContext = Boolean(settings.useAdapterContext);
    settings.fallbackToOriginal = Boolean(settings.fallbackToOriginal);
    settings.retryCount = Math.max(0, Math.min(5, Number(settings.retryCount) || 0));
    settings.maxBatchComments = Math.max(1, Math.min(8, Number(settings.maxBatchComments) || 3));
    settings.replyMaxChars = Math.max(20, Math.min(300, Number(settings.replyMaxChars) || 90));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
    applyStyle();
    window.dispatchEvent(new CustomEvent('eve:moments-settings-updated', { detail:{ settings:getSettings() } }));
    return getSettings();
  }
  function getSettings() { return Object.assign({}, settings); }
  function clean(value, max = 10000) {
    return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
  }
  function globalValue(name) {
    try { return window[name]; } catch (_) { return undefined; }
  }
  function getDb() {
    try { if (typeof db !== 'undefined') return db; } catch (_) {}
    return window.db || null;
  }
  function getCharacters() {
    try { if (typeof characters !== 'undefined' && Array.isArray(characters)) return characters; } catch (_) {}
    return Array.isArray(window.characters) ? window.characters : [];
  }
  function findCharacter(value) {
    const needle = clean(value, 200);
    return getCharacters().find(item =>
      String(item?.id) === needle || item?.name === needle || item?.nickname === needle
    ) || null;
  }
  function currentUserName() {
    return clean(document.getElementById('moments-username')?.textContent || '我', 80) || '我';
  }
  function adapterContext(meta = {}) {
    if (!settings.useAdapterContext) return '';
    try { return clean(window.EVEAdapter?.getPromptContext?.(Object.assign({ feature:'moments' }, meta)) || '', 12000); }
    catch (_) { return ''; }
  }
  function characterPrompt(character) {
    return clean(character?.persona || character?.prompt || character?.description || `你是${character?.name || '该角色'}。`, 12000);
  }
  function stripThink(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');
  }
  function extractText(value, depth = 0) {
    if (depth > 8 || value == null) return '';
    if (typeof value === 'string') {
      let text = stripThink(value).trim();
      text = text.replace(/^```(?:json|javascript|text)?\s*/i, '').replace(/\s*```$/i, '').trim();
      if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        try { const parsed = JSON.parse(text); const nested = extractText(parsed, depth + 1); if (nested) return nested; } catch (_) {}
      }
      return text;
    }
    if (Array.isArray(value)) {
      for (const item of value) { const found = extractText(item, depth + 1); if (found) return found; }
      return '';
    }
    if (typeof value === 'object') {
      const keys = ['reply','text','content','message','answer','output','response','result'];
      for (const key of keys) if (value[key] != null) {
        const found = extractText(value[key], depth + 1); if (found) return found;
      }
      const candidate = value.candidates?.[0]?.content?.parts?.[0]?.text;
      if (candidate) return extractText(candidate, depth + 1);
      const choice = value.choices?.[0]?.message?.content;
      if (choice) return extractText(choice, depth + 1);
    }
    return '';
  }
  function normalizeReply(value, max = settings.replyMaxChars) {
    let text = extractText(value);
    text = stripThink(text)
      .replace(/^\s*(?:回复|评论|回答|角色回复)\s*[:：]\s*/i, '')
      .replace(/^['“”"]+|['“”"]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return text.slice(0, max);
  }
  async function callApi(prompt, character) {
    let fn;
    try { if (typeof callChatAPI === 'function') fn = callChatAPI; } catch (_) {}
    fn ||= globalValue('callChatAPI');
    if (typeof fn !== 'function') throw new Error('未找到 EVE 原生 callChatAPI');
    return fn(prompt, character);
  }
  async function getMoment(momentId) {
    const database = getDb();
    if (!database?.moments) throw new Error('动态数据库未就绪');
    const numeric = Number(momentId);
    return database.moments.get(Number.isFinite(numeric) ? numeric : momentId);
  }
  async function listComments(momentId) {
    const database = getDb();
    if (!database?.momentComments) return [];
    const numeric = Number(momentId);
    const keys = Number.isFinite(numeric) ? [numeric, String(momentId)] : [momentId];
    for (const key of keys) {
      try {
        const rows = await database.momentComments.where('momentId').equals(key).toArray();
        if (rows.length) return rows;
      } catch (_) {}
    }
    try {
      const all = await database.momentComments.toArray();
      return all.filter(item => String(item.momentId) === String(momentId));
    } catch (_) { return []; }
  }
  function recentChat(character) {
    try {
      if (typeof getRecentChatRounds === 'function' && typeof formatChatRoundsToText === 'function') {
        return clean(formatChatRoundsToText(getRecentChatRounds(character.id, 20), character.name), 9000);
      }
    } catch (_) {}
    return '';
  }
  function postText(moment) {
    return clean(moment?.text || moment?.content || moment?.caption || '', 5000) || '[图片动态]';
  }
  async function buildReplyPrompt(moment, character, userComment) {
    const comments = await listComments(moment.id ?? moment.momentId);
    const commentText = comments.slice(-12).map(item => `${item.nickname || item.authorName || '访客'}：${item.text || item.content || ''}`).join('\n');
    return [
      `你正在扮演${character.name || '该角色'}。`,
      characterPrompt(character),
      adapterContext({ momentId:moment.id, characterId:character.id }),
      recentChat(character) ? `【最近聊天】\n${recentChat(character)}` : '',
      `【动态正文】\n${postText(moment)}`,
      commentText ? `【当前评论区】\n${commentText}` : '',
      `【用户刚刚回复】\n${clean(userComment, 1000)}`,
      '请以该角色身份自然回复这条评论。',
      '要求：像微信朋友圈评论，简短、口语化、符合人设与双方关系；不要解释规则；不要输出 JSON、Markdown 或引号；只输出回复正文。'
    ].filter(Boolean).join('\n\n');
  }
  async function buildCommentPrompt(moment, character) {
    return [
      `你正在扮演${character.name || '该角色'}。`,
      characterPrompt(character),
      adapterContext({ momentId:moment.id, characterId:character.id }),
      recentChat(character) ? `【最近聊天】\n${recentChat(character)}` : '',
      `【你看到的动态】\n${postText(moment)}`,
      '请留下1条符合你人设、与发布者关系和当前情境的微信朋友圈评论。',
      '10到35个字，简短自然，不要 JSON、Markdown、引号、角色名或说明，只输出评论正文。'
    ].filter(Boolean).join('\n\n');
  }
  async function generateText(prompt, character) {
    let lastError = null;
    const attempts = settings.retryCount + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const suffix = attempt ? '\n\n上一次输出无法解析。现在只输出一行纯文本，不要 JSON，不要代码块。' : '';
        const raw = await callApi(prompt + suffix, character);
        const text = normalizeReply(raw);
        if (text) return text;
        lastError = new Error('AI 返回空白或无法解析的内容');
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('动态回复生成失败');
  }
  function makeComment(character, text, replyTo = null, offset = 0) {
    const timestamp = Date.now() + offset;
    let formattedTime = new Date(timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    try { if (typeof formatTime === 'function') formattedTime = formatTime(new Date(timestamp)); } catch (_) {}
    return {
      id:`eve_moment_comment_${timestamp}_${Math.random().toString(36).slice(2,8)}`,
      nickname:character.name || character.nickname || '角色',
      avatar:character.avatar || character.avatarUrl || '',
      text,
      content:text,
      time:formattedTime,
      timestamp,
      replyTo:replyTo || null,
      characterId:character.id,
      authorId:character.id,
      source:'eve-moments-v09'
    };
  }
  async function saveComment(momentId, comment, interactionType = 'reply') {
    let saveFn, countFn, displayFn;
    try { if (typeof saveCommentToMoment === 'function') saveFn = saveCommentToMoment; } catch (_) {}
    try { if (typeof updateMomentCommentCount === 'function') countFn = updateMomentCommentCount; } catch (_) {}
    try { if (typeof displayCommentUnderMoment === 'function') displayFn = displayCommentUnderMoment; } catch (_) {}
    saveFn ||= globalValue('saveCommentToMoment'); countFn ||= globalValue('updateMomentCommentCount'); displayFn ||= globalValue('displayCommentUnderMoment');
    if (typeof saveFn !== 'function') throw new Error('未找到动态评论保存函数');
    await saveFn(momentId, comment);
    if (typeof countFn === 'function') await countFn(momentId);
    if (typeof displayFn === 'function') displayFn(momentId, comment);
    emitInteraction({ momentId, type:interactionType, actorId:comment.characterId, actorName:comment.nickname, text:comment.text, comment:safeClone(comment) });
    return comment;
  }
  function eventFingerprint(detail) {
    return `${detail.type}|${detail.momentId}|${detail.actorId || detail.actorName}|${detail.text}`;
  }
  function emitInteraction(detail) {
    if (!settings.notifyInteractions) return;
    const fingerprint = eventFingerprint(detail);
    const previous = recentEvents.get(fingerprint) || 0;
    if (Date.now() - previous < 1500) return;
    recentEvents.set(fingerprint, Date.now());
    for (const [key, time] of recentEvents) if (Date.now() - time > 15000) recentEvents.delete(key);
    window.dispatchEvent(new CustomEvent('eve:moment-interaction', { detail:Object.assign({ timestamp:Date.now() }, detail) }));
  }
  async function enhancedReply(momentId, characterName, userCommentText) {
    if (!settings.enabled || !settings.repairReplies) {
      if (typeof nativeReply === 'function') return nativeReply(momentId, characterName, userCommentText);
      return null;
    }
    let saved = false;
    try {
      const character = findCharacter(characterName);
      if (!character) throw new Error(`找不到角色：${characterName}`);
      const moment = await getMoment(momentId);
      if (!moment) throw new Error(`找不到动态：${momentId}`);
      const prompt = await buildReplyPrompt(moment, character, userCommentText);
      const text = await generateText(prompt, character);
      const comment = makeComment(character, text, currentUserName());
      await saveComment(momentId, comment, 'reply');
      saved = true;
      try { if (typeof showToast === 'function') showToast(`${character.name}回复了你的评论`, 'success'); } catch (_) {}
      return comment;
    } catch (error) {
      console.error('[EVEMoments] 角色回复修复失败：', error);
      window.dispatchEvent(new CustomEvent('eve:moment-reply-error', { detail:{ momentId, characterName, error:String(error?.message || error) } }));
      if (!saved && settings.fallbackToOriginal && typeof nativeReply === 'function') return nativeReply(momentId, characterName, userCommentText);
      throw error;
    }
  }
  async function fallbackBatch(momentId, characterList, momentArg) {
    const moment = momentArg || await getMoment(momentId);
    if (!moment) throw new Error(`找不到动态：${momentId}`);
    const candidates = (Array.isArray(characterList) ? characterList : []).filter(Boolean).slice(0, settings.maxBatchComments);
    const saved = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const character = findCharacter(candidates[index]?.id || candidates[index]?.name) || candidates[index];
      try {
        const text = await generateText(await buildCommentPrompt(moment, character), character);
        saved.push(await saveComment(momentId, makeComment(character, text, null, index * 1000), 'comment'));
      } catch (error) { console.warn('[EVEMoments] 单个角色评论失败：', character?.name, error); }
    }
    return saved;
  }
  async function enhancedBatch(momentId, characterList, momentArg) {
    if (!settings.enabled || !settings.repairBatchComments) {
      return typeof nativeBatch === 'function' ? nativeBatch(momentId, characterList, momentArg) : [];
    }
    const before = (await listComments(momentId)).length;
    let originalError = null;
    if (typeof nativeBatch === 'function') {
      try { await nativeBatch(momentId, characterList, momentArg); }
      catch (error) { originalError = error; console.warn('[EVEMoments] 原生批量评论失败，准备后备：', error); }
    }
    const after = (await listComments(momentId)).length;
    if (after > before) return { source:'native', added:after-before };
    try {
      const saved = await fallbackBatch(momentId, characterList, momentArg);
      if (!saved.length && originalError) throw originalError;
      return { source:'fallback', added:saved.length, comments:saved };
    } catch (error) {
      window.dispatchEvent(new CustomEvent('eve:moment-batch-error', { detail:{ momentId, error:String(error?.message || error) } }));
      throw error;
    }
  }
  function wrapSaveComment() {
    const current = globalValue('saveCommentToMoment');
    if (typeof current !== 'function' || current.__eveMomentsWrapped) return;
    nativeSaveComment = current;
    const wrapped = async function (momentId, comment) {
      const result = await nativeSaveComment.apply(this, arguments);
      if (comment && (comment.characterId || comment.authorId) && String(comment.authorId || comment.characterId) !== 'user') {
        emitInteraction({ momentId, type:comment.replyTo ? 'reply' : 'comment', actorId:comment.characterId || comment.authorId, actorName:comment.nickname || comment.authorName, text:comment.text || comment.content || '', comment:safeClone(comment) });
      }
      return result;
    };
    wrapped.__eveMomentsWrapped = true;
    window.saveCommentToMoment = wrapped;
  }
  function wrapInteractionNotice() {
    const current = globalValue('createMomentInteractionNotification');
    if (typeof current !== 'function' || current.__eveMomentsWrapped) return;
    nativeInteractionNotice = current;
    const wrapped = function (character, type, content) {
      const result = nativeInteractionNotice.apply(this, arguments);
      emitInteraction({ type:type || 'interaction', actorId:character?.id, actorName:character?.name, text:clean(content || '', 500) });
      return result;
    };
    wrapped.__eveMomentsWrapped = true;
    window.createMomentInteractionNotification = wrapped;
  }
  function installHooks() {
    const currentReply = globalValue('triggerAIReplyToUser');
    if (typeof currentReply === 'function' && !currentReply.__eveMomentsWrapped) {
      nativeReply = currentReply;
      enhancedReply.__eveMomentsWrapped = true;
      window.triggerAIReplyToUser = enhancedReply;
    }
    const currentBatch = globalValue('generateBatchMomentComments');
    if (typeof currentBatch === 'function' && !currentBatch.__eveMomentsWrapped) {
      nativeBatch = currentBatch;
      enhancedBatch.__eveMomentsWrapped = true;
      window.generateBatchMomentComments = enhancedBatch;
    }
    wrapSaveComment();
    wrapInteractionNotice();
  }
  function applyStyle() {
    let style = document.getElementById('eve-moments-wechat-style');
    if (!settings.wechatStyle) { style?.remove(); return; }
    if (style) return;
    style = document.createElement('style'); style.id = 'eve-moments-wechat-style';
    style.textContent = `
      #moments-page .moment-item{padding:14px 13px 12px;border-bottom:1px solid rgba(0,0,0,.07)}
      #moments-page .moment-content{line-height:1.55;word-break:break-word}
      #moments-page .moment-images{gap:4px;max-width:292px}
      #moments-page .moment-comments-section,#moments-page .likes-display{background:rgba(0,0,0,.045);border-radius:5px;padding:6px 9px;margin-top:5px;line-height:1.45}
      body[data-theme="dark"] #moments-page .moment-comments-section,body[data-theme="dark"] #moments-page .likes-display{background:rgba(255,255,255,.08)}
      #moments-page .comment-text-content{word-break:break-word}
      #moments-page .moment-more-dots{border-radius:5px}
    `;
    document.head.append(style);
  }
  function diagnostics() {
    return {
      version:VERSION,
      initialized,
      settings:getSettings(),
      hooks:{
        reply:globalValue('triggerAIReplyToUser') === enhancedReply,
        batch:globalValue('generateBatchMomentComments') === enhancedBatch,
        save:Boolean(globalValue('saveCommentToMoment')?.__eveMomentsWrapped),
        notification:Boolean(globalValue('createMomentInteractionNotification')?.__eveMomentsWrapped)
      },
      database:Boolean(getDb()?.moments && getDb()?.momentComments),
      callChatAPI:(() => { try { return typeof callChatAPI === 'function' || typeof window.callChatAPI === 'function'; } catch (_) { return false; } })()
    };
  }
  function init() {
    if (initialized) return Promise.resolve(diagnostics());
    initialized = true;
    applyStyle();
    installHooks();
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1; installHooks();
      if (attempts >= 20 || diagnostics().hooks.reply) clearInterval(timer);
    }, 500);
    window.EVE ||= {}; window.EVE.moments = window.EVEMoments;
    window.dispatchEvent(new CustomEvent('eve:moments-ready', { detail:diagnostics() }));
    return Promise.resolve(diagnostics());
  }
  function destroy() {
    if (nativeReply) window.triggerAIReplyToUser = nativeReply;
    if (nativeBatch) window.generateBatchMomentComments = nativeBatch;
    if (nativeSaveComment) window.saveCommentToMoment = nativeSaveComment;
    if (nativeInteractionNotice) window.createMomentInteractionNotification = nativeInteractionNotice;
    document.getElementById('eve-moments-wechat-style')?.remove();
    initialized = false;
  }

  window.EVEMoments = Object.freeze({
    version:VERSION, init, destroy, configure:save, getSettings, getDiagnostics:diagnostics,
    repairReply:enhancedReply, repairBatchComments:enhancedBatch,
    normalizeReply, emitInteraction
  });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
