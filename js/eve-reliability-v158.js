/**
 * EVE Runtime Reliability v1.5.8
 * Shared web/Capacitor fixes for sticker payloads, sticker recovery and compact recall notices.
 */
(function (window, document) {
  'use strict';
  if (window.EVEReliabilityV158?.version) return;

  const VERSION = '1.5.8';
  const MANIFEST_KEY = 'eve_sticker_reliability_manifest_v158';
  const ALIAS_GROUPS = Object.freeze({
    '震惊':['震惊','惊讶','驚訝','吓到','嚇到','愣住','不可置信','问号','問號','惊','驚','shock','surprise','wow'],
    '赞同':['赞同','贊同','同意','点头','點頭','收到','好的','可以','没问题','沒問題','行','ok','okay','yes','好'],
    '开心':['开心','開心','高兴','高興','快乐','快樂','笑','哈哈','爆笑','得意','happy','laugh','lol'],
    '害羞':['害羞','脸红','臉紅','躲','偷看','不好意思','羞','shy'],
    '难过':['难过','難過','伤心','傷心','哭','泪','淚','委屈','低落','emo','sad'],
    '生气':['生气','生氣','愤怒','憤怒','炸毛','火大','不爽','打人','揍','怒','angry'],
    '无语':['无语','無語','白眼','沉默','嫌弃','嫌棄','无奈','無奈','看傻了'],
    '撒娇':['撒娇','撒嬌','抱抱','贴贴','貼貼','亲亲','親親','蹭','求求','拜托','拜託','hug'],
    '喜欢':['喜欢','喜歡','爱心','愛心','心动','心動','爱','愛','亲密','親密','love'],
    '疲惫':['累','困','睡','躺','疲惫','疲憊','没电','沒電','sleep','tired'],
    '紧张':['紧张','緊張','慌','害怕','担心','擔心','瑟瑟发抖','怕'],
    '调侃':['调侃','調侃','看戏','看戲','坏笑','壞笑','逗','挑衅','挑釁','嘲笑'],
    '庆祝':['庆祝','慶祝','恭喜','鼓掌','胜利','勝利','干杯','乾杯','欢呼','歡呼']
  });

  let initialized = false;
  let adapterBound = false;
  let bubbleObserver = null;
  let restorePromise = null;
  let hookTimer = null;
  let recoveryTimer = null;
  let lastRestoreAt = 0;
  let lastVaultCount = 0;
  let lastMemoryCount = 0;
  let repairedBubbleCount = 0;
  let compactRecallCount = 0;

  function clean(value, max = 1000) {
    return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  }
  function oneLine(value, max = 240) {
    return clean(value, max).replace(/\s+/g, ' ');
  }
  function clone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }
  function emit(name, detail = {}) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
  }
  function getArray() {
    try { return typeof customEmojis !== 'undefined' && Array.isArray(customEmojis) ? customEmojis : null; }
    catch (_) { return null; }
  }
  function itemImage(item) { return String(item?.url || item?.imageData || ''); }
  function usable(item) {
    return Boolean(item && oneLine(item.id, 220) && /^(?:data:image\/|blob:|capacitor:|file:|https?:)/i.test(itemImage(item)));
  }
  function normalizeTerm(value) {
    return oneLine(value, 300).toLowerCase().replace(/\.(?:png|jpe?g|gif|webp)$/i,'').replace(/[_-]+/g,' ');
  }
  function allFields(item) {
    const meta = item?.aiMetadata || {};
    const sourceName = item?.originalFileName || String(item?.sourceSignature || '').split('|')[0];
    return [
      item?.id,item?.name,item?.description,sourceName,item?.category,...(item?.tags || []),
      meta?.description,meta?.textInImage,...(meta?.emotions || []),...(meta?.intents || []),
      ...(meta?.scenes || []),...(meta?.tones || meta?.tone || []),...(meta?.subjects || []),meta?.motion
    ].map(normalizeTerm).filter(Boolean);
  }
  function conceptsFor(query) {
    const source = normalizeTerm(query);
    const concepts = new Set(source.match(/[\p{L}\p{N}]{1,}/gu) || []);
    for (const [label, aliases] of Object.entries(ALIAS_GROUPS)) {
      if (aliases.some(alias => source.includes(normalizeTerm(alias)))) {
        concepts.add(normalizeTerm(label));
        aliases.forEach(alias => concepts.add(normalizeTerm(alias)));
      }
    }
    return [...concepts].filter(Boolean).slice(0,80);
  }
  function directResolve(query) {
    try {
      const direct = window.EVEStickers?.resolveItem?.(query);
      if (direct && usable(direct)) return direct;
    } catch (_) {}
    const wanted = normalizeTerm(query);
    if (!wanted) return null;
    const items = getArray() || [];
    const exact = items.find(item => allFields(item).includes(wanted));
    if (exact && usable(exact)) return exact;
    return null;
  }
  function semanticResolve(query) {
    const direct = directResolve(query);
    if (direct) return direct;
    const expanded = conceptsFor(query).join(' ');
    try {
      const candidates = window.EVEStickerIntelligence?.findCandidates?.(expanded || query, { limit:5 }) || [];
      const chosen = candidates.find(candidate => Number(candidate?.score) > 0) || candidates[0];
      if (chosen?.id) {
        const item = (getArray() || []).find(entry => String(entry.id) === String(chosen.id));
        if (item && usable(item)) return item;
      }
    } catch (_) {}
    const concepts = conceptsFor(query);
    if (!concepts.length) return null;
    let best = null;
    let bestScore = 0;
    for (const item of getArray() || []) {
      if (!usable(item)) continue;
      const fields = allFields(item);
      let score = item.favorite ? 2 : 0;
      for (const concept of concepts) {
        if (fields.includes(concept)) score += 18;
        else if (fields.some(field => field.includes(concept) || concept.includes(field))) score += 5;
      }
      if (score > bestScore) { best = item; bestScore = score; }
    }
    return bestScore > 0 ? best : null;
  }
  function fallbackGlyph(query) {
    const source = normalizeTerm(query);
    const map = [
      [['震惊','惊讶','驚訝','shock','wow'],'😳'],[['赞同','贊同','ok','okay','收到','好'],'👌'],
      [['开心','開心','笑','哈哈'],'😂'],[['害羞','脸红','臉紅'],'🫣'],[['难过','難過','哭','委屈'],'🥺'],
      [['生气','生氣','怒','炸毛'],'😤'],[['无语','無語','白眼','无奈','無奈'],'😑'],[['抱抱','撒娇','撒嬌'],'🫂'],
      [['喜欢','喜歡','爱','愛','心动','心動'],'❤️'],[['困','睡','疲惫','疲憊'],'😴'],[['怕','紧张','緊張'],'😰']
    ];
    for (const [words,glyph] of map) if (words.some(word => source.includes(normalizeTerm(word)))) return glyph;
    return '🙂';
  }

  function stripFence(value) {
    return clean(value, 20000).replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  }
  function placeholderQuery(value) {
    const source = oneLine(value, 1000);
    if (!source) return '';
    const patterns = [
      /^[\[【]\s*(?:(?:[\p{L}\p{N}_-]{1,40})\s*)?(?:(?:发送了|發送了|发了|發了|发送|發送|使用了)\s*)?(?:一张|一張|一个|一個)?\s*表情包\s*[:：]\s*([^\]】]+?)\s*[\]】]$/iu,
      /^\s*(?:发送了|發送了|发了|發了|发送|發送)\s*表情包\s*[:：]\s*(.+?)\s*$/iu
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]) return oneLine(match[1],300);
    }
    return '';
  }
  function findEmojiRequest(value) {
    if (Array.isArray(value)) {
      for (const child of value) { const found = findEmojiRequest(child); if (found) return found; }
      return null;
    }
    if (typeof value === 'string') {
      const query = placeholderQuery(value);
      return query ? { query } : null;
    }
    if (!value || typeof value !== 'object') return null;
    if (String(value.type || '').toLowerCase() === 'emoji') {
      return { query:value.stickerId || value.id || value.description || value.name || '', object:value };
    }
    for (const key of ['message','content','text','reply','data']) {
      if (value[key] == null) continue;
      const found = findEmojiRequest(value[key]);
      if (found) return found;
    }
    return null;
  }
  function parseEmojiRequest(text) {
    const source = stripFence(text);
    if (!source) return null;
    const placeholder = placeholderQuery(source);
    if (placeholder) return { query:placeholder, raw:source };
    const candidates = [source];
    if (/^\{\\?"/.test(source)) candidates.push(source.replace(/\\"/g,'"'));
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        const request = findEmojiRequest(parsed);
        if (request) return Object.assign({ parsed, raw:source }, request);
      } catch (_) {}
    }
    return null;
  }
  function stickerPayload(item, original = {}) {
    return {
      type:'emoji',
      stickerId:item.id,
      id:item.id,
      description:item.description || item.name || item.id,
      name:item.name || item.description || item.id,
      ...(original?.mode ? { mode:original.mode } : {})
    };
  }
  function transformValue(value, state) {
    if (Array.isArray(value)) {
      return value.map(child => transformValue(child,state)).filter(child => child !== null && child !== '');
    }
    if (typeof value === 'string') {
      const query = placeholderQuery(value);
      if (!query) return value;
      state.hadEmoji = true;
      const item = semanticResolve(query);
      if (item) { state.resolved = true; return stickerPayload(item); }
      return fallbackGlyph(query);
    }
    if (!value || typeof value !== 'object') return value;
    if (String(value.type || '').toLowerCase() === 'emoji') {
      state.hadEmoji = true;
      const query = value.stickerId || value.id || value.description || value.name || '';
      const item = semanticResolve(query);
      if (item) { state.resolved = true; return stickerPayload(item,value); }
      return fallbackGlyph(query);
    }
    for (const key of ['message','content','text','reply']) {
      if (typeof value[key] !== 'string') continue;
      const query = placeholderQuery(value[key]);
      if (!query) continue;
      state.hadEmoji = true;
      const item = semanticResolve(query);
      if (item) { state.resolved = true; return stickerPayload(item,value); }
      return fallbackGlyph(query);
    }
    const output = { ...value };
    for (const [key,child] of Object.entries(value)) output[key] = transformValue(child,state);
    return output;
  }
  function responseTransformer(text) {
    const source = String(text ?? '');
    const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = (fenced ? fenced[1] : source).trim();
    const state = { hadEmoji:false, resolved:false };
    try {
      const parsed = JSON.parse(candidate);
      let transformed = transformValue(parsed,state);
      if (!state.hadEmoji) return source;
      if (!Array.isArray(transformed)) transformed = [transformed];
      const json = JSON.stringify(transformed);
      return fenced ? `\`\`\`json\n${json}\n\`\`\`` : json;
    } catch (_) {
      const query = placeholderQuery(candidate);
      if (!query) return source;
      const item = semanticResolve(query);
      return JSON.stringify([item ? stickerPayload(item) : fallbackGlyph(query)]);
    }
  }
  function contextProvider() {
    const count = (getArray() || []).length;
    if (!count) return '';
    return [
      '【通用表情包格式】',
      '发送表情包时只能使用本轮候选中真实存在的stickerId。',
      '输出必须是JSON数组中的对象：{"type":"emoji","stickerId":"精确ID"}。',
      '不要输出裸JSON对象，也不要输出“[发送了表情包：名称]”等占位文字。',
      '如果没有合适候选，改发普通文字。'
    ].join('\n');
  }
  function bindAdapter() {
    if (adapterBound || !window.EVEAdapter?.registerResponseTransformer) return false;
    window.EVEAdapter.registerContextProvider?.('sticker-reliability-v158', contextProvider, { priority:7 });
    window.EVEAdapter.registerResponseTransformer('sticker-reliability-v158', responseTransformer, { priority:95 });
    adapterBound = true;
    return true;
  }

  function renderGrid() {
    try { if (typeof renderEmojiGrid === 'function') return Promise.resolve(renderEmojiGrid()); } catch (_) {}
    try { return Promise.resolve(window.renderEmojiGrid?.()); } catch (_) { return Promise.resolve(); }
  }
  function mergeById(primary, secondary) {
    const map = new Map();
    const order = [];
    for (const source of [primary,secondary]) {
      for (const item of source || []) {
        if (!usable(item)) continue;
        const id = String(item.id);
        if (!map.has(id)) order.push(id);
        map.set(id, { ...(map.get(id) || {}), ...clone(item) });
      }
    }
    return order.map(id => map.get(id)).filter(Boolean);
  }
  function readManifest() {
    try { return JSON.parse(localStorage.getItem(MANIFEST_KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function writeManifest(items, reason) {
    const usableItems = (items || []).filter(usable);
    const manifest = {
      version:VERSION,
      count:usableItems.length,
      ids:usableItems.map(item => String(item.id)).slice(0,5000),
      at:new Date().toISOString(),
      reason:oneLine(reason,80)
    };
    try { localStorage.setItem(MANIFEST_KEY,JSON.stringify(manifest)); } catch (_) {}
    return manifest;
  }
  async function restoreStickers(reason = 'manual', options = {}) {
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      const storage = window.EVEStickerStorage;
      const array = getArray();
      if (!storage?.readVault || !array) return { ok:false, reason:'not-ready' };
      let vault = [];
      try { vault = await storage.readVault(); }
      catch (error) { return { ok:false, reason:'vault-error', error:oneLine(error?.message || error,500) }; }
      const validVault = (vault || []).filter(usable);
      const validMemory = (array || []).filter(usable);
      lastVaultCount = validVault.length;
      lastMemoryCount = validMemory.length;
      const manifest = readManifest();
      const missing = validVault.filter(item => !validMemory.some(current => String(current.id) === String(item.id)));
      const loadReason = /startup|load|visibility|pageshow|resume|foreground|manual|timer/.test(String(reason));
      const suspiciousDrop = validVault.length > 0 && (validMemory.length === 0 || validMemory.length < Math.max(1,Math.floor(validVault.length * .5)));
      if (missing.length && (loadReason || suspiciousDrop || options.force)) {
        const merged = mergeById(validVault,validMemory);
        array.splice(0,array.length,...merged);
        await renderGrid();
        lastMemoryCount = merged.length;
        writeManifest(merged,`restore:${reason}`);
        repairedBubbleCount += 0;
        emit('eve:sticker-reliability-restored',{ reason, restored:missing.length, total:merged.length });
        setTimeout(() => scanMessageUI(document),50);
        return { ok:true, restored:missing.length, total:merged.length, vault:validVault.length };
      }
      if (validMemory.length > validVault.length && storage.saveAll) {
        try { await storage.saveAll(validMemory); lastVaultCount = validMemory.length; }
        catch (_) {}
      }
      writeManifest(validMemory.length ? validMemory : validVault,`sync:${reason}`);
      return { ok:true, restored:0, total:validMemory.length, vault:validVault.length, previous:manifest.count || 0 };
    })().finally(() => { restorePromise = null; lastRestoreAt = Date.now(); });
    return restorePromise;
  }
  function installLoadHook() {
    const current = window.loadCustomEmojis;
    if (typeof current !== 'function' || current.__eveReliabilityV158) return false;
    const wrapped = async function () {
      const result = await current.apply(this,arguments);
      await restoreStickers('load-custom-emojis',{ force:true }).catch(() => {});
      return result;
    };
    wrapped.__eveReliabilityV158 = true;
    wrapped.__eveOriginal = current;
    window.loadCustomEmojis = wrapped;
    return true;
  }
  function installPersistenceWatchers() {
    installLoadHook();
    clearInterval(hookTimer);
    hookTimer = setInterval(installLoadHook,1000);
    setTimeout(() => clearInterval(hookTimer),60000);
    const delayed = [600,1800,4200,9000];
    delayed.forEach(delay => setTimeout(() => restoreStickers('startup',{ force:true }).catch(() => {}),delay));
    clearInterval(recoveryTimer);
    recoveryTimer = setInterval(() => {
      const array = getArray();
      const manifest = readManifest();
      if (array && manifest.count > 0 && array.filter(usable).length === 0) restoreStickers('timer',{ force:true }).catch(() => {});
    },12000);
    document.addEventListener('visibilitychange',() => {
      if (!document.hidden && Date.now()-lastRestoreAt>1500) restoreStickers('visibility',{ force:true }).catch(() => {});
    });
    window.addEventListener('pageshow',() => restoreStickers('pageshow',{ force:true }).catch(() => {}));
    window.addEventListener('eve:stickers-imported',() => setTimeout(() => restoreStickers('import').catch(() => {}),150));
    window.addEventListener('eve:sticker-storage-saved',event => {
      const array = getArray() || [];
      writeManifest(array,'storage-saved');
      lastVaultCount = Number(event.detail?.vaultCount) || array.length;
    });
  }

  function bubbleElement(node) {
    if (!node?.querySelector) return null;
    return node.matches?.('.message-bubble,.message-content,.message-text,.text-message')
      ? node : node.querySelector('.message-bubble,.message-content,.message-text,.text-message');
  }
  async function repairStickerBubble(node) {
    const bubble = bubbleElement(node);
    if (!bubble || bubble.dataset.eveStickerV158 === '1') return false;
    const cloneNode = bubble.cloneNode(true);
    cloneNode.querySelectorAll?.('.reply-reference,.timestamp,.message-time,.message-actions,button').forEach(child => child.remove());
    const request = parseEmojiRequest(cloneNode.textContent || '');
    if (!request) return false;
    let item = semanticResolve(request.query);
    if (!item) {
      await restoreStickers('bubble',{ force:true }).catch(() => {});
      item = semanticResolve(request.query);
    }
    bubble.dataset.eveStickerV158='1';
    bubble.textContent='';
    if (!item || !usable(item)) {
      bubble.textContent=fallbackGlyph(request.query);
      bubble.classList.add('eve-sticker-fallback-glyph');
      repairedBubbleCount++;
      return true;
    }
    const image=document.createElement('img');
    image.src=itemImage(item);
    image.alt=item.description||item.name||request.query;
    image.title=image.alt;
    image.className='message-emoji eve-repaired-sticker eve-sticker-v158';
    image.style.cssText='display:block;max-width:min(180px,48vw);max-height:220px;object-fit:contain;border-radius:12px';
    image.onerror=()=>{bubble.textContent=fallbackGlyph(request.query);bubble.classList.add('eve-sticker-fallback-glyph')};
    bubble.appendChild(image);
    const container=bubble.closest('.message-container,[data-message-id],.message-item');
    container?.classList?.add('emoji-only','eve-sticker-rendered');
    repairedBubbleCount++;
    return true;
  }
  function compactRecallText(text) {
    const source=oneLine(text,2000);
    if (!/(?:撤回了|已撤回|撤回了一|撤回一)/.test(source) || !/(?:消息|訊息)/.test(source)) return '';
    const mine=/^(?:你|我)\s*(?:已)?撤回/.test(source) || /你撤回了/.test(source);
    return mine ? '你撤回了一条消息' : '对方撤回了一条消息';
  }
  function compactRecallBubble(node) {
    const bubble=bubbleElement(node) || (node?.matches?.('.recalled-message,.system-message') ? node : null);
    if (!bubble || bubble.dataset.eveRecallCompact==='1') return false;
    const replacement=compactRecallText(bubble.textContent || '');
    if (!replacement) return false;
    bubble.textContent=replacement;
    bubble.dataset.eveRecallCompact='1';
    bubble.classList.add('eve-compact-recall');
    compactRecallCount++;
    return true;
  }
  function scanMessageUI(root=document) {
    if (root.nodeType===1) { repairStickerBubble(root); compactRecallBubble(root); }
    root.querySelectorAll?.('.message-bubble,.message-content,.message-text,.text-message,.recalled-message,.system-message').forEach(node => {
      repairStickerBubble(node); compactRecallBubble(node);
    });
  }
  function installMessageObserver() {
    bubbleObserver?.disconnect();
    bubbleObserver=new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes || []) if (node.nodeType===1) scanMessageUI(node);
      }
    });
    if (document.body) bubbleObserver.observe(document.body,{ childList:true,subtree:true });
    scanMessageUI(document);
    window.addEventListener('eve:message-recalled',() => {
      setTimeout(() => scanMessageUI(document),40);
      setTimeout(() => scanMessageUI(document),240);
    });
  }
  function installStyle() {
    if (document.getElementById('eve-reliability-v158-style')) return;
    const style=document.createElement('style');
    style.id='eve-reliability-v158-style';
    style.textContent='.eve-compact-recall{font-size:12px!important;opacity:.62!important;font-style:italic!important;text-align:center!important;background:transparent!important;box-shadow:none!important}.eve-sticker-fallback-glyph{font-size:36px!important;background:transparent!important;box-shadow:none!important;padding:4px!important}';
    document.head.appendChild(style);
  }

  function diagnostics() {
    const array=getArray() || [];
    return {
      version:VERSION,initialized,adapterBound,
      memoryCount:array.filter(usable).length,vaultCount:lastVaultCount,
      manifest:readManifest(),lastRestoreAt,repairedBubbleCount,compactRecallCount,
      storage:Boolean(window.EVEStickerStorage),stickers:Boolean(window.EVEStickers),intelligence:Boolean(window.EVEStickerIntelligence)
    };
  }
  function init() {
    if (initialized) return diagnostics();
    initialized=true;
    installStyle();
    installPersistenceWatchers();
    installMessageObserver();
    if (!bindAdapter()) {
      const timer=setInterval(()=>{if(bindAdapter())clearInterval(timer)},400);
      setTimeout(()=>clearInterval(timer),30000);
    }
    window.EVE ||= {};
    window.EVE.reliabilityV158=window.EVEReliabilityV158;
    emit('eve:reliability-v158-ready',diagnostics());
    return diagnostics();
  }
  function destroy() {
    clearInterval(hookTimer);clearInterval(recoveryTimer);bubbleObserver?.disconnect();
    initialized=false;adapterBound=false;
  }

  window.EVEReliabilityV158=Object.freeze({
    version:VERSION,init,destroy,diagnostics,responseTransformer,
    resolveSticker:semanticResolve,restoreStickers,scanMessageUI,compactRecallText
  });
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init,{once:true}):init();
})(window,document);
