/**
 * EVE Chat Moments Enhancement v1.0.0
 * - Repairs character replies to user comments on Moments.
 * - Lets the user continue replying to each new character answer in the comment thread.
 * - Adds a guarded fallback for batch comments.
 * - Emits normalized Moments interaction events for notifications/timeline.
 * - Applies small WeChat-like presentation refinements without rebuilding the page.
 */
(function (window, document) {
  'use strict';
  if (window.EVEMoments?.version) return;

  const VERSION = '1.0.0';
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
    fallbackToOriginal: true,
    threadedReplies: true,
    showReplyButton: true,
    threadContextLimit: 12
  });

  let settings = load();
  let initialized = false;
  let nativeReply = null;
  let nativeBatch = null;
  let nativeSaveComment = null;
  let nativeInteractionNotice = null;
  let nativeDisplayComment = null;
  let nativeShowBottomInput = null;
  let commentObserver = null;
  let hydrateTimer = null;
  let activeReplyContext = null;
  const pendingReplyContexts = new Map();
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
    settings.threadedReplies = Boolean(settings.threadedReplies);
    settings.showReplyButton = Boolean(settings.showReplyButton);
    settings.retryCount = Math.max(0, Math.min(5, Number(settings.retryCount) || 0));
    settings.maxBatchComments = Math.max(1, Math.min(8, Number(settings.maxBatchComments) || 3));
    settings.replyMaxChars = Math.max(20, Math.min(300, Number(settings.replyMaxChars) || 90));
    settings.threadContextLimit = Math.max(3, Math.min(30, Number(settings.threadContextLimit) || 12));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
    applyStyle();
    scheduleHydration();
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
  async function getComment(momentId, commentId) {
    if (commentId == null) return null;
    const comments = await listComments(momentId);
    return comments.find(item => String(item?.id) === String(commentId)) || null;
  }
  function commentText(comment) {
    return clean(comment?.text || comment?.content || '', 2000);
  }
  function commentAuthorId(comment) {
    return clean(comment?.authorId || comment?.characterId || '', 200);
  }
  function isUserComment(comment) {
    return commentAuthorId(comment) === 'user';
  }
  function isCharacterComment(comment) {
    return !isUserComment(comment) && Boolean(findCharacter(commentAuthorId(comment) || comment?.nickname));
  }
  function contextKey(momentId, characterName, text) {
    return [String(momentId), clean(characterName, 120).toLowerCase(), clean(text, 300).replace(/\s+/g, ' ').toLowerCase()].join('|');
  }
  function rememberPendingReply(context) {
    const key = contextKey(context.momentId, context.characterName, context.userText);
    const list = pendingReplyContexts.get(key) || [];
    list.push(Object.assign({ createdAt:Date.now() }, context));
    pendingReplyContexts.set(key, list.slice(-5));
    window.setTimeout(() => {
      const current = pendingReplyContexts.get(key) || [];
      const next = current.filter(item => Date.now() - item.createdAt < 120000);
      if (next.length) pendingReplyContexts.set(key, next); else pendingReplyContexts.delete(key);
    }, 125000);
  }
  function takePendingReply(momentId, characterName, text) {
    const key = contextKey(momentId, characterName, text);
    const exact = pendingReplyContexts.get(key) || [];
    if (exact.length) {
      const item = exact.shift();
      if (exact.length) pendingReplyContexts.set(key, exact); else pendingReplyContexts.delete(key);
      return item;
    }
    const prefix = `${String(momentId)}|${clean(characterName,120).toLowerCase()}|`;
    let bestKey = null, bestItem = null;
    for (const [candidateKey, items] of pendingReplyContexts) {
      if (!candidateKey.startsWith(prefix) || !items.length) continue;
      const item = items[0];
      if (!bestItem || item.createdAt > bestItem.createdAt) { bestKey = candidateKey; bestItem = item; }
    }
    if (bestKey && bestItem) {
      const items = pendingReplyContexts.get(bestKey) || [];
      items.shift();
      if (items.length) pendingReplyContexts.set(bestKey, items); else pendingReplyContexts.delete(bestKey);
    }
    return bestItem;
  }
  function buildThreadText(comments, context, userCommentText) {
    if (!context?.targetCommentId) return '';
    const byId = new Map(comments.map(item => [String(item.id), item]));
    const chain = [];
    let currentId = String(context.targetCommentId);
    const visited = new Set();
    while (currentId && !visited.has(currentId) && chain.length < settings.threadContextLimit) {
      visited.add(currentId);
      const item = byId.get(currentId);
      if (!item) break;
      chain.unshift(item);
      currentId = item.replyToCommentId != null ? String(item.replyToCommentId) : '';
    }
    const rows = chain.map(item => {
      const author = clean(item.nickname || item.authorName || '访客', 100);
      const target = clean(item.replyTo || '', 100);
      return `${author}${target ? ` 回复 ${target}` : ''}：${commentText(item)}`;
    });
    rows.push(`${currentUserName()} 回复 ${context.targetNickname || context.characterName}：${clean(userCommentText,1000)}`);
    return rows.join('\n');
  }
  function findCommentElement(momentId, commentId) {
    const moment = document.querySelector(`[data-moment-id="${String(momentId).replace(/"/g,'\\"')}"]`);
    if (!moment) return null;
    return [...moment.querySelectorAll('[data-comment-id]')]
      .find(element => String(element.getAttribute('data-comment-id')) === String(commentId)) || null;
  }
  async function persistThreadMetadata(comment) {
    const database = getDb();
    if (!database?.momentComments || comment?.id == null) return;
    const patch = {};
    for (const key of ['replyToCommentId','replyToAuthorId','rootCommentId','replyDepth','source']) {
      if (comment[key] != null) patch[key] = comment[key];
    }
    if (!Object.keys(patch).length) return;
    try { await database.momentComments.update(comment.id, patch); }
    catch (_) {
      try {
        const row = await database.momentComments.get(comment.id);
        if (row) await database.momentComments.put(Object.assign({}, row, patch));
      } catch (_) {}
    }
  }
  async function decorateComment(momentId, comment, element = null) {
    if (!settings.threadedReplies || !comment) return null;
    const node = element || findCommentElement(momentId, comment.id);
    if (!node) return null;
    node.dataset.eveThreaded = '1';
    node.dataset.eveMomentId = String(momentId);
    node.dataset.eveCommentId = String(comment.id);
    node.dataset.eveAuthorId = commentAuthorId(comment);
    node.dataset.eveNickname = clean(comment.nickname || comment.authorName || '', 100);
    if (comment.replyToCommentId != null) node.dataset.eveReplyToCommentId = String(comment.replyToCommentId);
    node.classList.add('eve-thread-comment');
    const existingButton = node.querySelector('.eve-thread-reply-btn');
    if (!settings.showReplyButton || !isCharacterComment(comment)) {
      existingButton?.remove();
      return node;
    }
    if (existingButton) return node;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'eve-thread-reply-btn';
    button.textContent = '回复';
    button.setAttribute('aria-label', `回复${comment.nickname || '角色'}`);
    button.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      openReplyToComment(momentId, comment.id).catch(error => {
        console.error('[EVEMoments] 打开评论回复失败：', error);
        try { if (typeof showToast === 'function') showToast(`无法回复：${error.message || error}`, 'error'); } catch (_) {}
      });
    };
    const time = node.querySelector('.comment-time');
    if (time?.parentNode) time.insertAdjacentElement('afterend', button); else node.append(button);
    return node;
  }
  async function hydrateVisibleComments() {
    if (!settings.threadedReplies) return;
    const database = getDb();
    if (!database?.momentComments) return;
    const momentNodes = [...document.querySelectorAll('[data-moment-id]')];
    for (const momentNode of momentNodes) {
      const momentId = momentNode.getAttribute('data-moment-id');
      const nodes = [...momentNode.querySelectorAll('.moment-comment[data-comment-id], .comment-item[data-comment-id]')];
      if (!nodes.length) continue;
      const comments = await listComments(momentId);
      const byId = new Map(comments.map(item => [String(item.id), item]));
      for (const node of nodes) {
        const item = byId.get(String(node.getAttribute('data-comment-id')));
        if (item) await decorateComment(momentId, item, node);
      }
    }
  }
  function scheduleHydration() {
    window.clearTimeout(hydrateTimer);
    hydrateTimer = window.setTimeout(() => hydrateVisibleComments().catch(error => console.warn('[EVEMoments] 评论装饰失败：', error)), 60);
  }
  function addReplyBanner(context) {
    if (!context?.targetCommentId) return;
    const container = document.getElementById('bottom-comment-input');
    const input = document.getElementById('bottom-comment-text');
    if (!container || !input) return;
    input.dataset.eveReplyCommentId = String(context.targetCommentId);
    input.dataset.eveReplyAuthorId = String(context.targetAuthorId || '');
    input.dataset.eveReplyNickname = context.targetNickname;
    container.querySelector('.eve-reply-target-banner')?.remove();
    const banner = document.createElement('div');
    banner.className = 'eve-reply-target-banner';
    banner.innerHTML = `<span>回复 <b></b>：<span class="eve-reply-preview"></span></span><button type="button" aria-label="取消回复">×</button>`;
    banner.querySelector('b').textContent = context.targetNickname;
    banner.querySelector('.eve-reply-preview').textContent = clean(context.targetText, 45);
    banner.querySelector('button').onclick = () => {
      activeReplyContext = null;
      try { if (typeof closeBottomCommentInput === 'function') closeBottomCommentInput(); else container.remove(); } catch (_) { container.remove(); }
    };
    container.prepend(banner);
  }
  async function openReplyToComment(momentId, commentId) {
    if (!settings.threadedReplies) throw new Error('连续回复功能未开启');
    const comment = await getComment(momentId, commentId);
    if (!comment) throw new Error('找不到这条评论');
    const character = findCharacter(commentAuthorId(comment) || comment.nickname);
    if (!character) throw new Error('这条评论不是可回复的角色评论');
    activeReplyContext = {
      momentId:String(momentId),
      targetCommentId:comment.id,
      targetAuthorId:character.id,
      targetNickname:character.name || comment.nickname,
      targetText:commentText(comment),
      rootCommentId:comment.rootCommentId || comment.id,
      replyDepth:Math.max(0, Number(comment.replyDepth) || 0),
      characterName:character.name || comment.nickname
    };
    let showFn;
    try { if (typeof showBottomCommentInput === 'function') showFn = showBottomCommentInput; } catch (_) {}
    showFn ||= globalValue('showBottomCommentInput') || nativeShowBottomInput;
    if (typeof showFn === 'function') {
      const replyContext = safeClone(activeReplyContext);
      showFn(momentId, replyContext.targetNickname);
      window.setTimeout(() => addReplyBanner(replyContext), 0);
      return replyContext;
    }
    const value = window.prompt(`回复 ${activeReplyContext.targetNickname}`, '');
    if (!clean(value, 1000)) { activeReplyContext = null; return null; }
    const userComment = {
      id:Date.now(), momentId:Number(momentId), authorId:'user', nickname:currentUserName(),
      avatar:'', text:clean(value,1000), content:clean(value,1000), timestamp:Date.now(),
      replyTo:activeReplyContext.targetNickname, replyToCommentId:comment.id,
      replyToAuthorId:character.id, rootCommentId:activeReplyContext.rootCommentId,
      replyDepth:activeReplyContext.replyDepth + 1, source:'eve-threaded-user-v10'
    };
    let saveFn = globalValue('saveCommentToMoment'), displayFn = globalValue('displayCommentUnderMoment'), countFn = globalValue('updateMomentCommentCount');
    if (typeof saveFn !== 'function') throw new Error('评论保存功能未就绪');
    await saveFn(momentId, userComment);
    await persistThreadMetadata(userComment);
    if (typeof countFn === 'function') await countFn(momentId);
    if (typeof displayFn === 'function') displayFn(momentId, userComment);
    rememberPendingReply({
      momentId, characterName:character.name, userText:userComment.text,
      userCommentId:userComment.id, targetCommentId:comment.id,
      rootCommentId:userComment.rootCommentId, depth:userComment.replyDepth,
      targetNickname:activeReplyContext.targetNickname
    });
    activeReplyContext = null;
    return enhancedReply(momentId, character.name, userComment.text);
  }
  function installCommentObserver() {
    if (commentObserver || !document.body) return;
    commentObserver = new MutationObserver(mutations => {
      if (mutations.some(item => item.addedNodes?.length || item.removedNodes?.length)) scheduleHydration();
      if (activeReplyContext && !document.getElementById('bottom-comment-input')) {
        window.setTimeout(() => {
          if (!document.getElementById('bottom-comment-input')) activeReplyContext = null;
        }, 250);
      }
    });
    commentObserver.observe(document.body, { childList:true, subtree:true });
    scheduleHydration();
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
  async function buildReplyPrompt(moment, character, userComment, threadContext = null) {
    const comments = await listComments(moment.id ?? moment.momentId);
    const commentText = comments.slice(-12).map(item => `${item.nickname || item.authorName || '访客'}：${item.text || item.content || ''}`).join('\n');
    const threadText = settings.threadedReplies ? buildThreadText(comments, threadContext, userComment) : '';
    return [
      `你正在扮演${character.name || '该角色'}。`,
      characterPrompt(character),
      adapterContext({ momentId:moment.id, characterId:character.id }),
      recentChat(character) ? `【最近聊天】\n${recentChat(character)}` : '',
      `【动态正文】\n${postText(moment)}`,
      commentText ? `【当前评论区】\n${commentText}` : '',
      threadText ? `【正在继续的评论对话】\n${threadText}` : '',
      `【用户刚刚回复】\n${clean(userComment, 1000)}`,
      '请以该角色身份自然继续这段评论对话。',
      '要求：像微信朋友圈评论，简短、口语化、符合人设与双方关系；要回应用户最新一句，不要重复之前的回答；不要解释规则；不要输出 JSON、Markdown 或引号；只输出回复正文。'
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
  function makeComment(character, text, replyTo = null, offset = 0, metadata = {}) {
    const timestamp = Date.now() + offset;
    let formattedTime = new Date(timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    try { if (typeof formatTime === 'function') formattedTime = formatTime(new Date(timestamp)); } catch (_) {}
    return Object.assign({
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
      source:'eve-moments-v10'
    }, metadata || {});
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
      const replyContext = takePendingReply(momentId, character.name || characterName, userCommentText);
      const prompt = await buildReplyPrompt(moment, character, userCommentText, replyContext);
      const text = await generateText(prompt, character);
      const comment = makeComment(character, text, currentUserName(), 0, replyContext ? {
        replyToCommentId:replyContext.userCommentId,
        replyToAuthorId:'user',
        rootCommentId:replyContext.rootCommentId || replyContext.targetCommentId || replyContext.userCommentId,
        replyDepth:Math.max(1, Number(replyContext.depth) || 1) + 1
      } : {});
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
      let replyContext = null;
      const authorId = String(comment?.authorId || comment?.characterId || 'user');
      if (settings.threadedReplies && authorId === 'user' && activeReplyContext && String(activeReplyContext.momentId) === String(momentId)) {
        replyContext = safeClone(activeReplyContext);
        Object.assign(comment, {
          replyTo:replyContext.targetNickname,
          replyToCommentId:replyContext.targetCommentId,
          replyToAuthorId:replyContext.targetAuthorId,
          rootCommentId:replyContext.rootCommentId || replyContext.targetCommentId,
          replyDepth:replyContext.replyDepth + 1,
          source:'eve-threaded-user-v10'
        });
      }
      const result = await nativeSaveComment.apply(this, arguments);
      await persistThreadMetadata(comment);
      if (replyContext && comment?.id != null) {
        const character = findCharacter(replyContext.targetAuthorId || replyContext.characterName || replyContext.targetNickname);
        if (character) rememberPendingReply({
          momentId, characterName:character.name || replyContext.targetNickname,
          userText:comment.text || comment.content || '', userCommentId:comment.id,
          targetCommentId:replyContext.targetCommentId,
          rootCommentId:comment.rootCommentId, depth:comment.replyDepth,
          targetNickname:replyContext.targetNickname
        });
        activeReplyContext = null;
      }
      if (comment && (comment.characterId || comment.authorId) && String(comment.authorId || comment.characterId) !== 'user') {
        emitInteraction({ momentId, type:comment.replyTo ? 'reply' : 'comment', actorId:comment.characterId || comment.authorId, actorName:comment.nickname || comment.authorName, text:comment.text || comment.content || '', comment:safeClone(comment) });
      }
      scheduleHydration();
      return result;
    };
    wrapped.__eveMomentsWrapped = true;
    window.saveCommentToMoment = wrapped;
  }
  function wrapDisplayComment() {
    const current = globalValue('displayCommentUnderMoment');
    if (typeof current !== 'function' || current.__eveMomentsWrapped) return;
    nativeDisplayComment = current;
    const wrapped = function (momentId, comment) {
      const result = nativeDisplayComment.apply(this, arguments);
      window.setTimeout(() => decorateComment(momentId, comment).catch(() => {}), 0);
      return result;
    };
    wrapped.__eveMomentsWrapped = true;
    window.displayCommentUnderMoment = wrapped;
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
    wrapDisplayComment();
    wrapInteractionNotice();
  }
  function applyStyle() {
    let style = document.getElementById('eve-moments-wechat-style');
    if (!settings.wechatStyle && !settings.threadedReplies) { style?.remove(); return; }
    if (!style) {
      style = document.createElement('style');
      style.id = 'eve-moments-wechat-style';
      document.head.append(style);
    }
    const wechat = settings.wechatStyle ? `
      #moments-page .moment-item{padding:14px 13px 12px;border-bottom:1px solid rgba(0,0,0,.07)}
      #moments-page .moment-content{line-height:1.55;word-break:break-word}
      #moments-page .moment-images{gap:4px;max-width:292px}
      #moments-page .moment-comments-section,#moments-page .likes-display{background:rgba(0,0,0,.045);border-radius:5px;padding:6px 9px;margin-top:5px;line-height:1.45}
      body[data-theme="dark"] #moments-page .moment-comments-section,body[data-theme="dark"] #moments-page .likes-display{background:rgba(255,255,255,.08)}
      #moments-page .comment-text-content{word-break:break-word}
      #moments-page .moment-more-dots{border-radius:5px}
    ` : '';
    const threaded = settings.threadedReplies ? `
      #moments-page .eve-thread-comment{position:relative;padding-right:34px}
      #moments-page .eve-thread-reply-btn{border:0;background:transparent;color:#576b95;font-size:11px;padding:1px 4px;margin-left:6px;cursor:pointer;vertical-align:middle}
      #moments-page .eve-thread-reply-btn:active{opacity:.55}
      .eve-reply-target-banner{display:flex;align-items:center;gap:7px;padding:7px 10px;background:rgba(87,107,149,.11);color:#576b95;font-size:12px;border-radius:8px;margin-bottom:6px;max-width:100%;box-sizing:border-box}
      .eve-reply-target-banner>span{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .eve-reply-target-banner button{border:0;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer}
      body[data-theme="dark"] .eve-reply-target-banner{background:rgba(130,155,210,.16);color:#9fb5e3}
    ` : '';
    style.textContent = wechat + threaded;
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
        notification:Boolean(globalValue('createMomentInteractionNotification')?.__eveMomentsWrapped),
        display:Boolean(globalValue('displayCommentUnderMoment')?.__eveMomentsWrapped),
        threadedReplies:Boolean(settings.threadedReplies && commentObserver)
      },
      database:Boolean(getDb()?.moments && getDb()?.momentComments),
      callChatAPI:(() => { try { return typeof callChatAPI === 'function' || typeof window.callChatAPI === 'function'; } catch (_) { return false; } })()
    };
  }
  function init() {
    if (initialized) return Promise.resolve(diagnostics());
    initialized = true;
    applyStyle();
    try { nativeShowBottomInput = globalValue('showBottomCommentInput'); } catch (_) {}
    installHooks();
    installCommentObserver();
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1; installHooks(); scheduleHydration();
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
    if (nativeDisplayComment) window.displayCommentUnderMoment = nativeDisplayComment;
    if (nativeInteractionNotice) window.createMomentInteractionNotification = nativeInteractionNotice;
    document.getElementById('eve-moments-wechat-style')?.remove();
    commentObserver?.disconnect(); commentObserver = null;
    window.clearTimeout(hydrateTimer); hydrateTimer = null;
    activeReplyContext = null; pendingReplyContexts.clear();
    initialized = false;
  }

  window.EVEMoments = Object.freeze({
    version:VERSION, init, destroy, configure:save, getSettings, getDiagnostics:diagnostics,
    repairReply:enhancedReply, repairBatchComments:enhancedBatch,
    replyToComment:openReplyToComment, hydrateVisibleComments,
    normalizeReply, emitInteraction
  });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
