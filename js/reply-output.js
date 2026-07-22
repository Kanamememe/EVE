/**
 * EVE Chat AI Quote Output Repair v1.1.2
 *
 * Repairs AI replies that describe a quote as plain text instead of using
 * EVE Chat's native reply_to JSON object. It also repairs already-rendered
 * placeholder bubbles when a matching target message can be found.
 */
(function (window, document) {
  'use strict';
  if (window.EVEReplyOutput?.version) return;

  const VERSION = '1.1.2';
  const SETTINGS_KEY = 'eve_reply_output_settings_v1';
  const DEFAULTS = Object.freeze({
    enabled: true,
    repairExistingMessages: true,
    fallbackToLatestUserMessage: true,
    maxSearchMessages: 100,
    minimumSimilarity: 0.46,
    debug: false
  });

  let settings = readSettings();
  let initialized = false;
  let adapterBound = false;
  let observer = null;
  const disposers = [];

  function readSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
    catch (_) { return Object.assign({}, DEFAULTS); }
  }
  function configure(next = {}) {
    settings = Object.assign({}, DEFAULTS, settings, next || {});
    settings.enabled = Boolean(settings.enabled);
    settings.repairExistingMessages = Boolean(settings.repairExistingMessages);
    settings.fallbackToLatestUserMessage = Boolean(settings.fallbackToLatestUserMessage);
    settings.maxSearchMessages = Math.max(10, Math.min(500, Number(settings.maxSearchMessages) || 100));
    settings.minimumSimilarity = Math.max(0.2, Math.min(0.95, Number(settings.minimumSimilarity) || 0.46));
    settings.debug = Boolean(settings.debug);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    return getSettings();
  }
  function getSettings() { return Object.assign({}, settings); }
  function log(...args) { if (settings.debug) console.log('[EVEReplyOutput]', ...args); }
  function clean(value, max = 5000) {
    return String(value ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, max);
  }
  function clone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }
  function normalize(value) {
    return clean(value, 4000)
      .toLowerCase()
      .replace(/[“”「」『』《》〈〉【】\[\]()（）]/g, '')
      .replace(/[，。！？!?,、；;：:\-—…·'"`~]/g, '')
      .replace(/\s+/g, '');
  }
  function stripWrappingQuotes(value) {
    let output = clean(value, 4000);
    const pairs = [['“','”'], ['「','」'], ['『','』'], ['"','"'], ["'","'"]];
    for (const [left, right] of pairs) {
      if (output.startsWith(left) && output.endsWith(right) && output.length >= 2) {
        output = output.slice(left.length, -right.length).trim();
        break;
      }
    }
    return output;
  }
  function senderKind(value) {
    const source = clean(value, 100).toLowerCase();
    if (!source) return 'unknown';
    if (/(?:用户|使用者|你|夕月|萧小五|蕭小五|我方)/i.test(source)) return 'user';
    try {
      const currentName = clean((typeof currentChatCharacter !== 'undefined' ? currentChatCharacter?.name : window.currentChatCharacter?.name), 100).toLowerCase();
      if (currentName && source.includes(currentName)) return 'assistant';
    } catch (_) {}
    if (/(?:角色|ai|助手|萧逸|蕭逸|他|她)/i.test(source)) return 'assistant';
    return 'unknown';
  }
  function bigrams(value) {
    const source = normalize(value);
    if (!source) return [];
    if (source.length === 1) return [source];
    const result = [];
    for (let i = 0; i < source.length - 1; i += 1) result.push(source.slice(i, i + 2));
    return result;
  }
  function similarity(a, b) {
    const left = normalize(a), right = normalize(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) {
      const shorter = Math.min(left.length, right.length);
      const longer = Math.max(left.length, right.length);
      return 0.72 + 0.28 * (shorter / longer);
    }
    const aa = bigrams(left), bb = bigrams(right);
    const counts = new Map();
    for (const item of aa) counts.set(item, (counts.get(item) || 0) + 1);
    let overlap = 0;
    for (const item of bb) {
      const count = counts.get(item) || 0;
      if (count > 0) { overlap += 1; counts.set(item, count - 1); }
    }
    return (2 * overlap) / Math.max(1, aa.length + bb.length);
  }

  function currentCharacter() {
    try { if (typeof currentChatCharacter !== 'undefined' && currentChatCharacter) return currentChatCharacter; } catch (_) {}
    return window.currentChatCharacter || null;
  }
  function currentScope() { return window.EVEAdapter?.getCurrentChat?.().scope || 'global'; }
  function messageSenderFromElement(element) {
    if (!element) return 'unknown';
    if (element.matches?.('.sent,.my-message,.user-message,[data-sender="user"],[data-role="user"]') || element.classList?.contains('sent')) return 'user';
    if (element.matches?.('.received,.ai-message,.assistant-message,[data-sender="assistant"],[data-role="assistant"]') || element.classList?.contains('received')) return 'assistant';
    return 'unknown';
  }
  function messageTextFromElement(element) {
    if (!element?.querySelector) return '';
    const target = element.matches?.('.message-bubble,.message-content,.message-text')
      ? element
      : element.querySelector('.message-bubble,.message-content,.message-text') || element;
    const copy = target.cloneNode(true);
    copy.querySelectorAll?.('.reply-reference,.message-actions,.message-action-bar,.timestamp,.message-time,button').forEach(node => node.remove());
    const image = copy.querySelector?.('img[alt]');
    const text = clean(copy.textContent, 5000);
    return text || clean(image?.alt, 5000);
  }
  function nameForSender(sender) {
    if (sender === 'user') return '你';
    const character = currentCharacter();
    return clean(character?.name, 100) || '角色';
  }
  function candidatesFromDom(excludeElement = null) {
    if (!document?.querySelectorAll) return [];
    const roots = [...document.querySelectorAll('#api-chat-screen [data-message-id], [data-message-id]')];
    const seen = new Set(), result = [];
    for (const element of roots) {
      if (excludeElement && (element === excludeElement || element.contains?.(excludeElement) || excludeElement.contains?.(element))) continue;
      const id = clean(element.dataset?.messageId || element.getAttribute?.('data-message-id'), 200);
      if (!id || seen.has(id)) continue;
      const text = messageTextFromElement(element);
      if (!text) continue;
      const sender = messageSenderFromElement(element);
      seen.add(id);
      result.push({ id, text, sender, name:nameForSender(sender), element, source:'dom', order:result.length });
    }
    return result.slice(-settings.maxSearchMessages);
  }
  function extractLegacyText(item) {
    if (!item || typeof item !== 'object') return '';
    for (const key of ['content','message','text','reply','description','caption']) {
      if (typeof item[key] === 'string' && clean(item[key])) return clean(item[key], 5000);
    }
    return '';
  }
  function legacySender(item) {
    if (!item || typeof item !== 'object') return 'unknown';
    const sender = clean(item.sender ?? item.role ?? item.from, 40).toLowerCase();
    if (item.isUser === true || item.is_user === true || ['user','sent','outgoing','me'].includes(sender)) return 'user';
    if (item.isUser === false || item.is_user === false || ['assistant','received','incoming','ai','character'].includes(sender)) return 'assistant';
    return 'unknown';
  }
  function candidatesFromLegacy() {
    const character = currentCharacter();
    let list = [];
    try {
      if (typeof chatMessages !== 'undefined' && character?.id && Array.isArray(chatMessages[character.id])) list = chatMessages[character.id];
    } catch (_) {}
    if (!list.length && Array.isArray(window.chatMessages?.[character?.id])) list = window.chatMessages[character.id];
    return list.slice(-settings.maxSearchMessages).map((item, index) => ({
      id:clean(item?.id ?? item?.messageId ?? item?.message_id, 200),
      text:extractLegacyText(item), sender:legacySender(item),
      name:clean(item?.senderName || item?.name, 100) || nameForSender(legacySender(item)),
      source:'legacy', order:index
    })).filter(item => item.id && item.text);
  }
  function walkStrings(value, output = []) {
    if (typeof value === 'string') { output.push(value); return output; }
    if (Array.isArray(value)) { for (const child of value) walkStrings(child, output); return output; }
    if (value && typeof value === 'object') for (const child of Object.values(value)) walkStrings(child, output);
    return output;
  }
  function candidatesFromRequestBody(body) {
    const result = [], seen = new Set();
    for (const source of walkStrings(body, [])) {
      if (!source.includes('[ID:') && !source.includes('[ID：')) continue;
      const regex = /\[ID\s*[:：]\s*([^\]]+)\]\s*([^\n]*)/g;
      let match;
      while ((match = regex.exec(source))) {
        const id = clean(match[1], 200);
        let line = clean(match[2], 5000);
        if (!id || !line || seen.has(id)) continue;
        const senderMatch = line.match(/^\s*(?:\[([^\]]+)\]|([^:：]{1,30})[:：])\s*/);
        const senderLabel = clean(senderMatch?.[1] || senderMatch?.[2], 100);
        if (senderMatch) line = clean(line.slice(senderMatch[0].length), 5000);
        if (!line) continue;
        const sender = senderKind(senderLabel);
        seen.add(id);
        result.push({ id, text:line, sender, name:senderLabel || nameForSender(sender), source:'request', order:result.length });
      }
    }
    return result.slice(-settings.maxSearchMessages);
  }
  function mergeCandidates(meta = {}, excludeElement = null) {
    const input = Array.isArray(meta.messageCandidates) ? meta.messageCandidates.map((item, index) => ({
      id:clean(item?.id ?? item?.message_id ?? item?.messageId, 200),
      text:clean(item?.text ?? item?.content ?? item?.message, 5000),
      sender:legacySender(item), name:clean(item?.name, 100),
      element:item?.element || null, source:'meta', order:index
    })).filter(item => item.id && item.text) : [];
    const combined = [...input, ...candidatesFromRequestBody(meta.requestBody), ...candidatesFromDom(excludeElement), ...candidatesFromLegacy()];
    const map = new Map();
    for (const item of combined) {
      if (!item.id || !item.text) continue;
      const previous = map.get(item.id);
      if (!previous || (previous.source !== 'dom' && item.source === 'dom')) map.set(item.id, item);
    }
    return [...map.values()].slice(-settings.maxSearchMessages);
  }

  function parsePlaceholder(value) {
    const source = clean(value, 12000);
    if (!source) return null;

    const bracket = source.match(/^[\[【]\s*([\s\S]*?)\s*[\]】]\s*([\s\S]*)$/);
    if (!bracket) return null;
    const inside = clean(bracket[1], 6000);
    const tail = clean(bracket[2].replace(/^\s*[:：\-—]+\s*/, ''), 6000);

    let match = inside.match(/^(?:回复|回覆|引用)\s+([^:：]{1,60})\s*[:：]\s*([\s\S]+)$/i);
    if (match) {
      return {
        targetSender:clean(match[1], 100), targetText:stripWrappingQuotes(match[2]),
        targetMessageId:'', content:tail, markerOnly:!tail, raw:source, format:'history'
      };
    }

    match = inside.match(/^(?:(?:AI|ai|角色|助手|萧逸|蕭逸)\s*)?(?:引用|回复|回覆)(?:了)?\s*(?:(你|用户|使用者|夕月|萧小五|蕭小五|角色|萧逸|蕭逸)(?:的)?\s*)?(?:(?:上一条|上條|这条|這條|该条|該條)?\s*(?:消息|訊息))?\s*(?:ID|id)?\s*[:：]\s*([\s\S]+)$/i);
    if (match) {
      const hint = clean(match[1], 100);
      const rawTarget = stripWrappingQuotes(match[2]);
      const idMatch = rawTarget.match(/^\s*(\d{5,})\s*(?:[|｜]\s*([\s\S]+))?$/);
      return {
        targetSender:hint, targetText:clean(idMatch?.[2] || (idMatch ? '' : rawTarget), 5000),
        targetMessageId:clean(idMatch?.[1], 200), content:tail,
        markerOnly:!tail, raw:source, format:'generic'
      };
    }

    match = inside.match(/^(?:回复|回覆|引用)(?:了)?\s*(?:消息|訊息)?\s*(?:ID|id)\s*[:：]?\s*(\d{5,})$/i);
    if (match) {
      return { targetSender:'', targetText:'', targetMessageId:clean(match[1],200), content:tail, markerOnly:!tail, raw:source, format:'id' };
    }

    match = inside.match(/^(?:回复|回覆|引用)(?:了)?\s*(你|用户|使用者|夕月|萧小五|蕭小五)(?:的)?\s*(?:消息|訊息)?$/i);
    if (match) {
      return { targetSender:clean(match[1],100), targetText:'', targetMessageId:'', content:tail, markerOnly:!tail, raw:source, format:'latest-user' };
    }
    return null;
  }

  function findTarget(parsed, meta = {}, excludeElement = null) {
    const candidates = mergeCandidates(meta, excludeElement);
    if (!candidates.length) return null;
    const explicitId = clean(parsed?.targetMessageId, 200);
    if (explicitId) {
      const direct = candidates.find(item => String(item.id) === explicitId);
      if (direct) return direct;
      return { id:explicitId, text:clean(parsed?.targetText,5000), sender:senderKind(parsed?.targetSender), name:clean(parsed?.targetSender,100), source:'explicit' };
    }

    const wanted = clean(parsed?.targetText, 5000);
    const kind = senderKind(parsed?.targetSender);
    let best = null, bestScore = -Infinity;
    for (let index = 0; index < candidates.length; index += 1) {
      const item = candidates[index];
      let score = 0;
      if (wanted) {
        const sim = similarity(wanted, item.text);
        score += sim * 100;
        const a = normalize(wanted), b = normalize(item.text);
        if (a && b && a === b) score += 80;
        else if (a && b && (a.includes(b) || b.includes(a))) score += 30;
      } else score += 15;
      if (kind !== 'unknown') score += item.sender === kind ? 20 : -12;
      score += (index / Math.max(1, candidates.length - 1)) * 8;
      if (score > bestScore) { bestScore = score; best = item; }
    }

    if (wanted && bestScore >= settings.minimumSimilarity * 100) return best;
    if (!wanted && best) return best;
    if (settings.fallbackToLatestUserMessage) {
      const user = [...candidates].reverse().find(item => item.sender === 'user');
      if (user) return user;
    }
    return null;
  }

  function nativeReplyObject(parsed, target, original = {}, contentOverride = '') {
    const content = clean(contentOverride || parsed?.content || original?.content || original?.message || original?.text || original?.reply, 10000);
    if (!target?.id || !content) return null;
    const output = {
      type:'reply_to',
      message_id:String(target.id),
      content
    };
    const name = clean(original?.name || original?.characterName, 100);
    if (name) output.name = name;
    return output;
  }

  function normalizeReplyObject(value, meta = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const type = clean(value.type || value.kind || value.messageType, 80).toLowerCase();
    const looksLikeReply = ['reply_to','reply','quote','quoted_reply','replyto','reply-to'].includes(type)
      || value.replyToMessageId != null || value.reply_to_message_id != null || value.quotedMessageId != null
      || value.quoteText != null || value.quotedText != null;
    if (!looksLikeReply) return null;
    const parsed = {
      targetMessageId:clean(value.message_id ?? value.messageId ?? value.replyToMessageId ?? value.reply_to_message_id ?? value.quotedMessageId, 200),
      targetText:clean(value.quoteText ?? value.quotedText ?? value.targetText ?? value.originalMessage, 5000),
      targetSender:clean(value.replyTo ?? value.targetSender ?? value.quotedSender, 100),
      content:clean(value.content ?? value.message ?? value.text ?? value.reply ?? value.answer, 10000)
    };
    const target = findTarget(parsed, meta);
    return nativeReplyObject(parsed, target, value);
  }

  function repairArray(array, meta = {}) {
    const output = [];
    for (let i = 0; i < array.length; i += 1) {
      const item = array[i];
      if (typeof item === 'string') {
        const parsed = parsePlaceholder(item);
        if (parsed) {
          let content = parsed.content;
          let consumeNext = false;
          let original = {};
          if (!content && i + 1 < array.length) {
            const next = array[i + 1];
            if (typeof next === 'string' && !parsePlaceholder(next)) { content = clean(next,10000); consumeNext = Boolean(content); }
            else if (next && typeof next === 'object' && !Array.isArray(next)) {
              content = clean(next.message ?? next.content ?? next.text ?? next.reply, 10000);
              consumeNext = Boolean(content);
              original = next;
            }
          }
          const target = findTarget(parsed, meta);
          const repaired = nativeReplyObject(parsed, target, original, content);
          if (repaired) {
            output.push(repaired);
            if (consumeNext) i += 1;
            continue;
          }
          if (content) { output.push(content); if (consumeNext) i += 1; continue; }
        }
        output.push(item);
        continue;
      }
      if (Array.isArray(item)) { output.push(repairArray(item, meta)); continue; }
      if (item && typeof item === 'object') {
        const normalized = normalizeReplyObject(item, meta);
        if (normalized) { output.push(normalized); continue; }
        output.push(repairJsonValue(item, meta));
        continue;
      }
      output.push(item);
    }
    return output;
  }

  function repairJsonValue(value, meta = {}) {
    if (Array.isArray(value)) return repairArray(value, meta);
    if (typeof value === 'string') {
      const parsed = parsePlaceholder(value);
      if (!parsed) return value;
      const target = findTarget(parsed, meta);
      return nativeReplyObject(parsed, target) || parsed.content || value;
    }
    if (!value || typeof value !== 'object') return value;
    const normalized = normalizeReplyObject(value, meta);
    if (normalized) return normalized;
    for (const key of ['message','content','text','reply']) {
      if (typeof value[key] !== 'string') continue;
      const parsed = parsePlaceholder(value[key]);
      if (!parsed) continue;
      const target = findTarget(parsed, meta);
      const repaired = nativeReplyObject(parsed, target, value);
      if (repaired) return repaired;
    }
    const output = Object.assign({}, value);
    for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') output[key] = repairJsonValue(child, meta);
    return output;
  }

  function repairAIResponseText(responseText, meta = {}) {
    if (!settings.enabled) return String(responseText ?? '');
    const source = String(responseText ?? '');
    const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = (fenced ? fenced[1] : source).trim();
    try {
      const parsed = JSON.parse(candidate);
      const repaired = repairJsonValue(parsed, meta);
      const json = JSON.stringify(repaired);
      return fenced ? `\`\`\`json\n${json}\n\`\`\`` : json;
    } catch (_) {
      const parsed = parsePlaceholder(candidate);
      if (!parsed) return source;
      const target = findTarget(parsed, meta);
      const repaired = nativeReplyObject(parsed, target);
      if (repaired) return JSON.stringify([repaired]);
      return parsed.content ? JSON.stringify([parsed.content]) : source;
    }
  }

  function promptContext() {
    if (!settings.enabled) return '';
    return [
      '【引用回复输出格式修正】',
      '如果你要引用某条消息，必须在JSON数组中使用对象：{"type":"reply_to","message_id":"历史记录中的真实消息ID","content":"你的回复正文"}',
      'message_id必须来自历史记录中的[ID:xxxxx]，不得虚构',
      '禁止把引用写成纯文字，例如“[引用了消息：原文] 回复内容”或“[回复 某人：原文] 回复内容”',
      '如果无法确认真实message_id，就发送普通文字回复，不要输出引用占位文字'
    ].join('\n');
  }

  function bindAdapter() {
    if (adapterBound || !window.EVEAdapter?.registerResponseTransformer) return false;
    window.EVEAdapter.registerContextProvider?.('reply-output-format', promptContext, { priority:35 });
    window.EVEAdapter.registerResponseTransformer('reply-output-fix', repairAIResponseText, { priority:35 });
    adapterBound = true;
    return true;
  }

  function makeReference(target) {
    const reference = document.createElement('div');
    reference.className = 'reply-reference eve-repaired-reply-reference';
    reference.dataset.replyToMessageId = String(target.id || '');
    reference.setAttribute('data-reply-to-message-id', String(target.id || ''));
    const content = document.createElement('div'); content.className = 'reply-reference-content';
    const sender = document.createElement('div'); sender.className = 'reply-reference-sender'; sender.textContent = target.name || nameForSender(target.sender);
    const message = document.createElement('div'); message.className = 'reply-reference-message'; message.textContent = clean(target.text, 1000);
    content.append(sender, message); reference.append(content);
    if (target.element) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'reply-jump-btn'; button.dataset.messageId = String(target.id || '');
      button.setAttribute('aria-label', '跳到被引用消息'); button.textContent = '↥';
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        target.element.scrollIntoView?.({ behavior:'smooth', block:'center' });
        target.element.classList?.add('eve-reply-target-highlight');
        window.setTimeout(() => target.element?.classList?.remove('eve-reply-target-highlight'), 1200);
      });
      reference.append(button);
    }
    return reference;
  }
  function sameAssistantMessage(element) {
    return messageSenderFromElement(element) === 'assistant';
  }
  function nextMessageContainer(container) {
    let node = container?.nextElementSibling;
    while (node) {
      if (node.matches?.('[data-message-id],.message-container')) return node;
      node = node.nextElementSibling;
    }
    return null;
  }
  function repairBubble(element) {
    if (!settings.enabled || !element?.querySelector) return false;
    const container = element.matches?.('[data-message-id],.message-container') ? element : element.closest?.('[data-message-id],.message-container');
    const bubble = element.matches?.('.message-bubble,.message-content,.message-text') ? element : element.querySelector('.message-bubble,.message-content,.message-text');
    if (!bubble || bubble.dataset.eveReplyOutputRepaired === '1' || bubble.querySelector('.reply-reference')) return false;
    const source = clean(bubble.textContent, 12000);
    const parsed = parsePlaceholder(source);
    if (!parsed) return false;
    let target = findTarget(parsed, {}, container || element);
    if (!target) return false;

    if (!parsed.content) {
      const next = nextMessageContainer(container);
      const nextBubble = next?.querySelector?.('.message-bubble,.message-content,.message-text');
      if (next && nextBubble && sameAssistantMessage(next) && !nextBubble.querySelector('.reply-reference')) {
        nextBubble.prepend(makeReference(target));
        nextBubble.dataset.eveReplyOutputRepaired = '1';
        container.style.display = 'none';
        container.dataset.eveReplyMarkerHidden = '1';
        return true;
      }
      return false;
    }

    bubble.textContent = '';
    bubble.append(makeReference(target));
    const text = document.createElement('span'); text.className = 'eve-repaired-reply-content'; text.textContent = parsed.content;
    bubble.append(text);
    bubble.dataset.eveReplyOutputRepaired = '1';
    container?.classList?.add('eve-reply-rendered');
    return true;
  }
  function scan(root = document) {
    if (!settings.repairExistingMessages) return;
    if (root.matches?.('[data-message-id],.message-container')) repairBubble(root);
    root.querySelectorAll?.('[data-message-id],.message-container').forEach(repairBubble);
  }
  function installDisplayRepair() {
    if (!settings.repairExistingMessages || observer) return;
    const style = document.createElement('style');
    style.id = 'eve-reply-output-style';
    style.textContent = '.eve-reply-target-highlight{animation:eveReplyHighlight 1.2s ease}@keyframes eveReplyHighlight{0%,100%{filter:none}35%{filter:brightness(1.25);box-shadow:0 0 0 3px rgba(0,122,255,.28)}}';
    document.head?.append(style);
    scan(document);
    observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) scan(node);
    });
    observer.observe(document.body, { childList:true, subtree:true });
  }

  function diagnostics() {
    return {
      version:VERSION, initialized, adapterBound, settings:getSettings(),
      transformerRegistered:Boolean(window.EVEAdapter?.getDiagnostics?.().responseTransformers?.includes('reply-output-fix')),
      contextProviderRegistered:Boolean(window.EVEAdapter?.getDiagnostics?.().contextProviders?.includes('reply-output-format'))
    };
  }
  function init() {
    if (initialized) return Promise.resolve(diagnostics());
    initialized = true;
    installDisplayRepair();
    if (!bindAdapter()) {
      const timer = window.setInterval(() => { if (bindAdapter()) window.clearInterval(timer); }, 500);
      disposers.push(() => window.clearInterval(timer));
    }
    window.EVE ||= {};
    window.EVE.replyOutput = window.EVEReplyOutput;
    window.dispatchEvent(new CustomEvent('eve:reply-output-ready', { detail:diagnostics() }));
    return Promise.resolve(diagnostics());
  }
  function destroy() {
    disposers.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
    observer?.disconnect(); observer = null;
    document.getElementById('eve-reply-output-style')?.remove();
    initialized = false;
  }

  window.EVEReplyOutput = Object.freeze({
    version:VERSION, init, destroy, configure, getSettings, getDiagnostics:diagnostics,
    parsePlaceholder, findTarget, repairAIResponseText, repairJsonValue,
    scanExistingMessages:scan
  });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
