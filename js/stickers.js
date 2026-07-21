/**
 * EVE Chat Sticker Extension v0.8.0
 * True multi-image import plus category, tags, favorite, search and manager UI.
 * It reuses EVE Chat's original customEmojis array and IndexedDB save function.
 */
(function (window, document) {
  'use strict';
  if (window.EVEStickers?.version) return;

  const VERSION = '0.8.0';
  const SETTINGS_KEY = 'eve_sticker_settings_v2';
  const DEFAULTS = Object.freeze({
    enabled: true,
    maxInputMB: 15,
    maxGifMB: 5,
    compressAboveMB: 1.2,
    maxDimension: 1024,
    webpQuality: 0.86,
    defaultCategory: '未分类',
    defaultTags: '',
    debug: false
  });
  let settings = read();
  let initialized = false;
  let originalHandleEmojiUpload = null;
  let manager = null;
  let draggedStickerId = null;

  function read() { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (_) { return Object.assign({}, DEFAULTS); } }
  function configure(next = {}) {
    settings = Object.assign({}, DEFAULTS, settings, next || {});
    settings.enabled = Boolean(settings.enabled);
    settings.maxInputMB = Math.max(1, Math.min(50, Number(settings.maxInputMB) || 15));
    settings.maxGifMB = Math.max(1, Math.min(20, Number(settings.maxGifMB) || 5));
    settings.compressAboveMB = Math.max(.2, Math.min(10, Number(settings.compressAboveMB) || 1.2));
    settings.maxDimension = Math.max(256, Math.min(2048, Number(settings.maxDimension) || 1024));
    settings.webpQuality = Math.max(.4, Math.min(1, Number(settings.webpQuality) || .86));
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    return getSettings();
  }
  function getSettings() { return Object.assign({}, settings); }
  function log(...args) { if (settings.debug) console.log('[EVEStickers]', ...args); }
  function clean(value, max = 300) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
  function tags(value) { return Array.from(new Set((Array.isArray(value) ? value : String(value || '').split(/[,，]/)).map(x => clean(x, 40)).filter(Boolean))).slice(0, 30); }
  function getArray() { try { return typeof customEmojis !== 'undefined' && Array.isArray(customEmojis) ? customEmojis : null; } catch (_) { return null; } }
  function saveOriginal() {
    try {
      if (typeof saveCustomEmojis === 'function') return Promise.resolve(saveCustomEmojis());
      if (typeof window.saveCustomEmojis === 'function') return Promise.resolve(window.saveCustomEmojis());
    } catch (error) { return Promise.reject(error); }
    return Promise.resolve(false);
  }
  function renderOriginal() {
    try { if (typeof renderEmojiGrid === 'function') return renderEmojiGrid(); } catch (_) {}
    try { return window.renderEmojiGrid?.(); } catch (_) {}
  }
  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    if (window.showToast) return window.showToast(message, type);
    console.log('[EVEStickers]', message);
  }
  function fileExtension(file) { return String(file.name || '').split('.').pop().toLowerCase(); }
  function validImage(file) { return /^image\/(png|jpe?g|gif|webp)$/i.test(file.type || '') || ['png','jpg','jpeg','gif','webp'].includes(fileExtension(file)); }
  function basename(name) { return clean(String(name || '表情包').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), 120) || '表情包'; }
  function sourceSignature(file) { return [file.name, file.size, file.lastModified].join('|'); }
  async function hashFile(file) {
    try {
      if (!crypto?.subtle) return sourceSignature(file);
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
    } catch (_) { return sourceSignature(file); }
  }
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
      reader.readAsDataURL(file);
    });
  }
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('图片解码失败')); image.src = dataUrl;
    });
  }
  async function compressImage(file) {
    const original = await fileToDataURL(file);
    if (file.type === 'image/gif' || fileExtension(file) === 'gif') return original;
    const threshold = settings.compressAboveMB * 1024 * 1024;
    if (file.size <= threshold) return original;
    try {
      const image = await loadImage(original);
      const ratio = Math.min(1, settings.maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      canvas.getContext('2d', { alpha:true }).drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/webp', settings.webpQuality);
    } catch (error) { log('压缩失败，保留原图', error); return original; }
  }

  async function importFiles(fileList, options = {}) {
    if (!settings.enabled) return { imported:0, skipped:0, failed:0 };
    const array = getArray();
    if (!array) throw new Error('EVE Chat 原生表情包尚未载入');
    const files = Array.from(fileList || []);
    const category = clean(options.category || settings.defaultCategory, 60) || '未分类';
    const commonTags = tags(options.tags ?? settings.defaultTags);
    let imported = 0, skipped = 0, failed = 0;
    const existingHashes = new Set(array.map(item => item.contentHash).filter(Boolean));
    const existingSignatures = new Set(array.map(item => item.sourceSignature).filter(Boolean));

    for (const file of files) {
      try {
        if (!validImage(file)) { skipped += 1; continue; }
        const mb = file.size / 1024 / 1024;
        if (mb > settings.maxInputMB || ((file.type === 'image/gif' || fileExtension(file) === 'gif') && mb > settings.maxGifMB)) { skipped += 1; continue; }
        const signature = sourceSignature(file);
        const contentHash = await hashFile(file);
        if (existingSignatures.has(signature) || existingHashes.has(contentHash)) { skipped += 1; continue; }
        const url = await compressImage(file);
        const name = basename(file.name);
        const filenameTags = tags(name.split(/\s+/).filter(word => word.length >= 2));
        array.push({
          id:`emoji_${Date.now()}_${Math.random().toString(36).slice(2,9)}`,
          url, description:name, name, category,
          tags:Array.from(new Set([...commonTags, ...filenameTags])).slice(0,30),
          favorite:false, addedAt:new Date().toISOString(), isPersonal:true,
          sourceSignature:signature, contentHash
        });
        existingSignatures.add(signature); existingHashes.add(contentHash); imported += 1;
      } catch (error) { console.warn('[EVEStickers] 导入失败', file.name, error); failed += 1; }
    }
    if (imported) { await saveOriginal(); await Promise.resolve(renderOriginal()); }
    const message = [`已导入 ${imported} 张表情包`, skipped ? `跳过 ${skipped} 张` : '', failed ? `失败 ${failed} 张` : ''].filter(Boolean).join('，');
    toast(message, failed ? 'error' : 'success');
    window.dispatchEvent(new CustomEvent('eve:stickers-imported', { detail:{ imported, skipped, failed, category } }));
    return { imported, skipped, failed };
  }

  async function promptAndImport(files) {
    const category = prompt('这批表情包的分类（可留空）', settings.defaultCategory) ?? settings.defaultCategory;
    const commonTags = prompt('这批表情包的共同标签，用逗号分隔（可留空）', settings.defaultTags) ?? settings.defaultTags;
    configure({ defaultCategory:clean(category,60) || '未分类', defaultTags:clean(commonTags,300) });
    return importFiles(files, { category, tags:commonTags });
  }
  function installUploadHook() {
    if (originalHandleEmojiUpload || typeof window.handleEmojiUpload !== 'function') return false;
    originalHandleEmojiUpload = window.handleEmojiUpload;
    window.handleEmojiUpload = function(event) {
      const files = Array.from(event?.target?.files || []);
      if (files.length <= 1) return originalHandleEmojiUpload.apply(this, arguments);
      event.preventDefault?.();
      promptAndImport(files).finally(() => { if (event?.target) event.target.value = ''; });
      return false;
    };
    return true;
  }

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]); }
  function managerItems() { return getArray() || []; }
  async function removeById(id) {
    const array = getArray(); if (!array) return false;
    const index = array.findIndex(item => String(item.id) === String(id));
    if (index < 0) return false;
    array.splice(index, 1); await saveOriginal(); await Promise.resolve(renderOriginal()); return true;
  }
  async function moveById(sourceId, targetId) {
    const array = getArray(); if (!array || sourceId === targetId) return false;
    const from = array.findIndex(item => String(item.id) === String(sourceId));
    const to = array.findIndex(item => String(item.id) === String(targetId));
    if (from < 0 || to < 0) return false;
    const [item] = array.splice(from, 1);
    const destination = array.findIndex(entry => String(entry.id) === String(targetId));
    array.splice(destination < 0 ? array.length : destination, 0, item);
    await saveOriginal(); await Promise.resolve(renderOriginal());
    window.dispatchEvent(new CustomEvent('eve:stickers-reordered', { detail:{ sourceId, targetId } }));
    return true;
  }
  async function updateById(id, patch) {
    const item = managerItems().find(entry => String(entry.id) === String(id));
    if (!item) return false;
    Object.assign(item, patch); await saveOriginal(); await Promise.resolve(renderOriginal()); return true;
  }
  function openManager() {
    manager?.remove();
    const overlay = document.createElement('div'); manager = overlay;
    overlay.id = 'eve-sticker-manager';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999997;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:12px';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:min(820px,100%);max-height:92vh;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 15px 50px #0005';
    panel.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;padding:14px 16px;border-bottom:1px solid #ddd">
        <b style="flex:1">表情包管理</b><button data-upload type="button">＋ 批量导入</button><button data-close type="button">✕</button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid #ddd">
        <input data-search placeholder="搜索名称或标签" style="flex:1;min-width:150px;padding:8px;border:1px solid #ccc;border-radius:8px">
        <select data-category style="padding:8px;border:1px solid #ccc;border-radius:8px"></select>
        <label style="display:flex;align-items:center;gap:5px"><input data-favorite type="checkbox">只看收藏</label>
      </div>
      <div data-grid style="overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px;min-height:220px"></div>
      <input data-file type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>`;
    overlay.append(panel); document.body.append(overlay);

    const render = () => {
      const items = managerItems();
      const categories = ['全部', ...Array.from(new Set(items.map(item => clean(item.category,60) || '未分类'))).sort()];
      const select = panel.querySelector('[data-category]');
      const previous = select.value || '全部'; select.innerHTML = categories.map(value => `<option>${escapeHtml(value)}</option>`).join(''); select.value = categories.includes(previous) ? previous : '全部';
      const query = clean(panel.querySelector('[data-search]').value,100).toLowerCase();
      const onlyFavorite = panel.querySelector('[data-favorite]').checked;
      const selectedCategory = select.value;
      const filtered = items.filter(item => {
        const category = clean(item.category,60) || '未分类';
        const haystack = `${item.name || ''} ${item.description || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
        return (!query || haystack.includes(query)) && (!onlyFavorite || item.favorite) && (selectedCategory === '全部' || category === selectedCategory);
      });
      const grid = panel.querySelector('[data-grid]'); grid.innerHTML = '';
      for (const item of filtered) {
        const card = document.createElement('div');
        card.draggable = true;
        card.dataset.stickerId = item.id;
        card.title = '可拖曳调整顺序';
        card.style.cssText = 'border:1px solid #ddd;border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:0;cursor:grab';
        card.ondragstart = event => { draggedStickerId = item.id; card.style.opacity = '.55'; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); };
        card.ondragend = () => { draggedStickerId = null; card.style.opacity = '1'; };
        card.ondragover = event => { if (draggedStickerId && draggedStickerId !== item.id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; card.style.outline = '2px solid #4a84c1'; } };
        card.ondragleave = () => { card.style.outline = ''; };
        card.ondrop = async event => { event.preventDefault(); event.stopPropagation(); card.style.outline = ''; const sourceId = draggedStickerId || event.dataTransfer.getData('text/plain'); if (sourceId && sourceId !== item.id) { await moveById(sourceId, item.id); render(); } };
        card.innerHTML = `<img src="${item.url || item.imageData || ''}" alt="" style="width:100%;aspect-ratio:1;object-fit:contain;border-radius:8px;background:#f5f5f5"><div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.name || item.description || '表情包')}</div><small style="opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml((item.tags || []).join('、') || item.category || '未分类')}</small><div style="display:flex;gap:4px"><button data-star type="button" style="flex:1">${item.favorite ? '★' : '☆'}</button><button data-edit type="button" style="flex:1">编辑</button><button data-delete type="button" style="flex:1;color:#c33">删</button></div>`;
        card.querySelector('[data-star]').onclick = async () => { await updateById(item.id, { favorite:!item.favorite }); render(); };
        card.querySelector('[data-edit]').onclick = async () => {
          const name = prompt('名称', item.name || item.description || '') ; if (name === null) return;
          const category = prompt('分类', item.category || '未分类'); if (category === null) return;
          const tagText = prompt('标签（逗号分隔）', (item.tags || []).join(',')); if (tagText === null) return;
          await updateById(item.id, { name:clean(name,120), description:clean(name,120) || item.description, category:clean(category,60) || '未分类', tags:tags(tagText) }); render();
        };
        card.querySelector('[data-delete]').onclick = async () => { if (confirm('删除这张表情包？')) { await removeById(item.id); render(); } };
        grid.append(card);
      }
      if (!filtered.length) grid.innerHTML = '<div style="grid-column:1/-1;padding:45px;text-align:center;opacity:.6">暂无表情包</div>';
    };
    panel.querySelector('[data-close]').onclick = () => overlay.remove();
    overlay.onclick = event => { if (event.target === overlay) overlay.remove(); };
    panel.querySelector('[data-search]').oninput = render;
    panel.querySelector('[data-category]').onchange = render;
    panel.querySelector('[data-favorite]').onchange = render;
    const fileInput = panel.querySelector('[data-file]');
    panel.querySelector('[data-upload]').onclick = () => fileInput.click();
    fileInput.onchange = async () => { await promptAndImport(fileInput.files); fileInput.value = ''; render(); };
    panel.addEventListener('dragover', event => {
      if (event.dataTransfer?.files?.length) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; panel.style.outline = '3px dashed #4a84c1'; }
    });
    panel.addEventListener('dragleave', event => { if (!panel.contains(event.relatedTarget)) panel.style.outline = ''; });
    panel.addEventListener('drop', async event => {
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) return;
      event.preventDefault(); panel.style.outline = '';
      await promptAndImport(files); render();
    });
    render();
  }
  function findByTags(wanted, options = {}) {
    const desired = new Set(tags(wanted).map(x => x.toLowerCase()));
    return managerItems().filter(item => {
      const itemTags = new Set(tags(item.tags).map(x => x.toLowerCase()));
      return (!options.favoriteOnly || item.favorite) && [...desired].some(tag => itemTags.has(tag));
    });
  }
  function retryHook() { if (!installUploadHook()) setTimeout(retryHook, 1000); }
  function init() {
    if (initialized) return Promise.resolve(getStats());
    initialized = true; retryHook();
    window.EVE ||= {}; window.EVE.stickers = window.EVEStickers;
    window.dispatchEvent(new CustomEvent('eve:stickers-ready', { detail:getStats() }));
    return Promise.resolve(getStats());
  }
  function getStats() { const items = managerItems(); return { version:VERSION, initialized, total:items.length, favorites:items.filter(x => x.favorite).length, categories:new Set(items.map(x => x.category || '未分类')).size, uploadHook:Boolean(originalHandleEmojiUpload) }; }
  function destroy() { if (originalHandleEmojiUpload) window.handleEmojiUpload = originalHandleEmojiUpload; originalHandleEmojiUpload = null; manager?.remove(); initialized = false; }

  window.EVEStickers = Object.freeze({ version:VERSION, init, destroy, configure, getSettings, getStats, importFiles, openManager, findByTags, removeById, updateById, moveById });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
