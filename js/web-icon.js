/**
 * EVE Chat Web Icon Manager v1.0.0
 * - Replaces browser favicon, shortcut icon and Apple touch icon.
 * - Stores the processed icon in EVE Chat's existing IndexedDB appIcons table.
 * - Falls back to localStorage when IndexedDB is unavailable.
 */
(function (window, document) {
  'use strict';
  if (window.EVEWebIcon?.version) return;

  const VERSION = '1.0.0';
  const RECORD_ID = 'eve-web-icon-v1';
  const FALLBACK_KEY = 'eve_web_icon_v1';
  const MAX_FILE_BYTES = 15 * 1024 * 1024;

  let initialized = false;
  let currentRecord = null;
  let manifestObjectUrl = null;
  const original = {
    icons: [],
    manifestHref: '',
    captured: false
  };

  function clone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }
  function clean(value, max = 500) {
    return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
  }
  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    try { if (typeof window.showToast === 'function') return window.showToast(message, type); } catch (_) {}
    if (type === 'error') console.error('[EVEWebIcon]', message); else console.log('[EVEWebIcon]', message);
  }
  function getDb() {
    try { if (typeof db !== 'undefined') return db; } catch (_) {}
    return window.db || null;
  }
  function captureOriginal() {
    if (original.captured) return;
    original.captured = true;
    original.icons = [...document.querySelectorAll('link[rel*="icon"]')].map(link => ({
      rel:link.getAttribute('rel') || 'icon',
      href:link.getAttribute('href') || '',
      sizes:link.getAttribute('sizes') || '',
      type:link.getAttribute('type') || ''
    }));
    original.manifestHref = document.querySelector('link[rel="manifest"]')?.getAttribute('href') || '';
  }
  async function table() {
    const database = getDb();
    if (!database?.appIcons) return null;
    try {
      if (typeof database.isOpen === 'function' && !database.isOpen() && typeof database.open === 'function') await database.open();
    } catch (_) {}
    return database.appIcons;
  }
  async function readRecord() {
    try {
      const store = await table();
      const record = await store?.get?.(RECORD_ID);
      if (record?.data512) return record;
    } catch (error) { console.warn('[EVEWebIcon] IndexedDB read failed:', error); }
    try {
      const record = JSON.parse(localStorage.getItem(FALLBACK_KEY) || 'null');
      if (record?.data512) return record;
    } catch (_) {}
    return null;
  }
  async function writeRecord(record) {
    const value = Object.assign({ id:RECORD_ID, appId:'eve-web-icon', updatedAt:Date.now() }, record);
    let stored = false;
    try {
      const store = await table();
      if (store?.put) { await store.put(value); stored = true; }
    } catch (error) { console.warn('[EVEWebIcon] IndexedDB write failed:', error); }
    if (!stored) {
      try { localStorage.setItem(FALLBACK_KEY, JSON.stringify(value)); stored = true; }
      catch (error) { throw new Error(`图标保存失败：${error.message || error}`); }
    } else {
      try { localStorage.removeItem(FALLBACK_KEY); } catch (_) {}
    }
    return value;
  }
  async function deleteRecord() {
    try { const store = await table(); await store?.delete?.(RECORD_ID); } catch (_) {}
    try { localStorage.removeItem(FALLBACK_KEY); } catch (_) {}
  }
  function ensureIconLink(key, rel, sizes, href) {
    let link = document.querySelector(`link[data-eve-web-icon="${key}"]`);
    if (!link) {
      link = document.createElement('link');
      link.dataset.eveWebIcon = key;
      document.head.append(link);
    }
    link.rel = rel;
    if (sizes) link.setAttribute('sizes', sizes); else link.removeAttribute('sizes');
    link.type = 'image/png';
    link.href = href;
    return link;
  }
  function parseManifest(href) {
    try {
      if (!href || !href.startsWith('data:')) return {};
      const comma = href.indexOf(',');
      if (comma < 0) return {};
      const meta = href.slice(0, comma);
      const body = href.slice(comma + 1);
      const decoded = /;base64/i.test(meta) ? atob(body) : decodeURIComponent(body);
      return JSON.parse(decoded);
    } catch (_) { return {}; }
  }
  function applyManifest(record) {
    let link = document.querySelector('link[rel="manifest"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.append(link);
    }
    const base = parseManifest(original.manifestHref || link.getAttribute('href') || '');
    const manifest = Object.assign({
      name:'EVE Chat', short_name:'EVE Chat', start_url:'./', display:'standalone',
      background_color:'#ffffff', theme_color:'#ffffff'
    }, base, {
      icons:[
        { src:record.data192 || record.data512, sizes:'192x192', type:'image/png', purpose:'any maskable' },
        { src:record.data512, sizes:'512x512', type:'image/png', purpose:'any maskable' }
      ]
    });
    if (manifestObjectUrl) URL.revokeObjectURL(manifestObjectUrl);
    manifestObjectUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type:'application/manifest+json' }));
    link.href = manifestObjectUrl;
    link.dataset.eveWebIconManifest = '1';
  }
  function applyRecord(record) {
    if (!record?.data512) return false;
    captureOriginal();
    document.querySelectorAll('link[data-eve-web-icon]').forEach(link => link.remove());
    document.querySelectorAll('link[rel="icon"],link[rel="shortcut icon"]').forEach(link => {
      link.href = record.data32 || record.data192 || record.data512;
      link.type = 'image/png';
    });
    ensureIconLink('favicon-32', 'icon', '32x32', record.data32 || record.data512);
    ensureIconLink('favicon-192', 'icon', '192x192', record.data192 || record.data512);
    ensureIconLink('shortcut', 'shortcut icon', '', record.data32 || record.data512);
    ensureIconLink('apple-touch', 'apple-touch-icon', '180x180', record.data180 || record.data192 || record.data512);
    let tile = document.querySelector('meta[name="msapplication-TileImage"]');
    if (!tile) { tile = document.createElement('meta'); tile.name = 'msapplication-TileImage'; document.head.append(tile); }
    tile.content = record.data192 || record.data512;
    tile.dataset.eveWebIcon = '1';
    applyManifest(record);
    document.documentElement.dataset.eveCustomWebIcon = '1';
    currentRecord = clone(record);
    window.dispatchEvent(new CustomEvent('eve:web-icon-updated', { detail:{ record:getRecord(), custom:true } }));
    return true;
  }
  function restoreOriginalLinks() {
    document.querySelectorAll('link[data-eve-web-icon]').forEach(link => link.remove());
    document.querySelectorAll('meta[data-eve-web-icon]').forEach(meta => meta.remove());
    const existing = [...document.querySelectorAll('link[rel*="icon"]')];
    existing.forEach(link => link.remove());
    for (const item of original.icons) {
      const link = document.createElement('link');
      link.setAttribute('rel', item.rel);
      if (item.href) link.setAttribute('href', item.href);
      if (item.sizes) link.setAttribute('sizes', item.sizes);
      if (item.type) link.setAttribute('type', item.type);
      document.head.append(link);
    }
    const manifest = document.querySelector('link[rel="manifest"]');
    if (manifest && original.manifestHref) manifest.setAttribute('href', original.manifestHref);
    if (manifest) delete manifest.dataset.eveWebIconManifest;
    if (manifestObjectUrl) { URL.revokeObjectURL(manifestObjectUrl); manifestObjectUrl = null; }
    delete document.documentElement.dataset.eveCustomWebIcon;
  }
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('无法读取图片'));
      image.src = dataUrl;
    });
  }
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }
  function renderSize(image, size) {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d', { alpha:true });
    context.clearRect(0, 0, size, size);
    const sourceSize = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
    const sourceX = ((image.naturalWidth || image.width) - sourceSize) / 2;
    const sourceY = ((image.naturalHeight || image.height) - sourceSize) / 2;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
    return canvas.toDataURL('image/png');
  }
  async function processFile(file) {
    if (!file || !String(file.type || '').startsWith('image/')) throw new Error('请选择图片文件');
    if (file.size > MAX_FILE_BYTES) throw new Error('图片不能超过 15MB');
    const source = await fileToDataUrl(file);
    const image = await loadImage(source);
    if (!(image.naturalWidth || image.width) || !(image.naturalHeight || image.height)) throw new Error('图片尺寸无效');
    return {
      fileName:clean(file.name, 200),
      data32:renderSize(image, 32),
      data180:renderSize(image, 180),
      data192:renderSize(image, 192),
      data512:renderSize(image, 512),
      width:image.naturalWidth || image.width,
      height:image.naturalHeight || image.height,
      updatedAt:Date.now()
    };
  }
  async function setFromFile(file) {
    const record = await processFile(file);
    currentRecord = await writeRecord(record);
    applyRecord(currentRecord);
    return getRecord();
  }
  async function reset() {
    await deleteRecord();
    currentRecord = null;
    restoreOriginalLinks();
    window.dispatchEvent(new CustomEvent('eve:web-icon-updated', { detail:{ record:null, custom:false } }));
    return true;
  }
  function getRecord() { return currentRecord ? clone(currentRecord) : null; }
  function getDiagnostics() {
    return {
      version:VERSION,
      initialized,
      custom:Boolean(currentRecord?.data512),
      faviconLinks:document.querySelectorAll('link[rel*="icon"]').length,
      appleTouch:Boolean(document.querySelector('link[rel="apple-touch-icon"]')),
      manifestCustomized:Boolean(document.querySelector('link[rel="manifest"]')?.dataset.eveWebIconManifest),
      indexedDb:Boolean(getDb()?.appIcons)
    };
  }
  async function openManager() {
    document.getElementById('eve-web-icon-manager')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'eve-web-icon-manager';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.52);display:flex;align-items:center;justify-content:center;padding:14px';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:min(500px,100%);max-height:92vh;overflow:auto;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;box-shadow:0 15px 50px #0006';
    panel.innerHTML = `
      <div style="display:flex;align-items:center;padding:15px 17px;border-bottom:1px solid #ddd"><b style="flex:1">网页图标</b><button data-close type="button">✕</button></div>
      <div style="padding:18px">
        <div style="display:flex;gap:18px;align-items:center;margin-bottom:16px">
          <div style="width:92px;height:92px;border-radius:20px;background:#eee;display:grid;place-items:center;overflow:hidden;box-shadow:0 4px 16px #0002"><img data-preview alt="图标预览" style="width:100%;height:100%;object-fit:cover;display:none"><span data-empty style="font-size:34px">💬</span></div>
          <div style="flex:1"><b data-title>${currentRecord ? '当前使用自定义图标' : '当前使用默认图标'}</b><div data-file style="font-size:12px;opacity:.65;margin-top:5px">建议使用正方形 PNG、JPG 或 WebP</div></div>
        </div>
        <input data-input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
        <button data-choose type="button" style="padding:9px 14px;margin-right:7px">选择图片</button>
        <button data-reset type="button" style="padding:9px 14px">恢复默认</button>
        <div data-status style="font-size:13px;margin-top:12px;min-height:20px"></div>
        <div style="font-size:12px;line-height:1.55;opacity:.68;margin-top:16px">浏览器标签图标会立即更新。iPhone 已经加入主屏幕的旧图标由系统缓存，需要删除旧捷径后重新“添加到主屏幕”才能看到新图标。</div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 17px;border-top:1px solid #ddd"><button data-cancel type="button">取消</button><button data-save type="button" disabled style="background:#4a84c1;color:#fff;border:0;border-radius:9px;padding:8px 18px;opacity:.55">保存并应用</button></div>`;
    overlay.append(panel); document.body.append(overlay);
    const preview = panel.querySelector('[data-preview]');
    const empty = panel.querySelector('[data-empty]');
    const input = panel.querySelector('[data-input]');
    const status = panel.querySelector('[data-status]');
    const saveButton = panel.querySelector('[data-save]');
    let pending = null;
    const showPreview = source => {
      if (source) { preview.src = source; preview.style.display = 'block'; empty.style.display = 'none'; }
      else { preview.removeAttribute('src'); preview.style.display = 'none'; empty.style.display = 'block'; }
    };
    showPreview(currentRecord?.data180 || currentRecord?.data512 || '');
    const close = () => overlay.remove();
    panel.querySelector('[data-close]').onclick = close;
    panel.querySelector('[data-cancel]').onclick = close;
    overlay.onclick = event => { if (event.target === overlay) close(); };
    panel.querySelector('[data-choose]').onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return;
      status.textContent = '正在处理图片…';
      saveButton.disabled = true; saveButton.style.opacity = '.55';
      try {
        pending = await processFile(file);
        showPreview(pending.data180);
        panel.querySelector('[data-title]').textContent = '新图标预览';
        panel.querySelector('[data-file]').textContent = `${file.name} · ${pending.width}×${pending.height}`;
        status.textContent = '图片已处理，点击“保存并应用”完成更换';
        saveButton.disabled = false; saveButton.style.opacity = '1';
      } catch (error) {
        pending = null; status.textContent = error.message || String(error); toast(status.textContent, 'error');
      }
    };
    panel.querySelector('[data-reset]').onclick = async () => {
      if (!window.confirm('恢复 EVE Chat 默认网页图标？')) return;
      await reset(); showPreview(''); panel.querySelector('[data-title]').textContent = '当前使用默认图标'; status.textContent = '已恢复默认图标'; pending = null; saveButton.disabled = true; saveButton.style.opacity = '.55'; toast('已恢复默认网页图标');
    };
    saveButton.onclick = async () => {
      if (!pending) return;
      saveButton.disabled = true; status.textContent = '正在保存…';
      try {
        currentRecord = await writeRecord(pending); applyRecord(currentRecord); status.textContent = '图标已更换'; toast('网页图标已更换'); window.setTimeout(close, 350);
      } catch (error) { status.textContent = error.message || String(error); toast(status.textContent, 'error'); saveButton.disabled = false; }
    };
    return overlay;
  }
  async function init() {
    if (initialized) return getDiagnostics();
    initialized = true;
    captureOriginal();
    currentRecord = await readRecord();
    if (currentRecord) applyRecord(currentRecord);
    window.EVE ||= {}; window.EVE.webIcon = window.EVEWebIcon;
    window.dispatchEvent(new CustomEvent('eve:web-icon-ready', { detail:getDiagnostics() }));
    return getDiagnostics();
  }
  function destroy() {
    if (manifestObjectUrl) { URL.revokeObjectURL(manifestObjectUrl); manifestObjectUrl = null; }
    initialized = false;
  }

  window.EVEWebIcon = Object.freeze({
    version:VERSION, init, destroy, openManager, setFromFile, reset,
    apply:applyRecord, getRecord, getDiagnostics, processFile
  });
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', () => init().catch(error => console.error('[EVEWebIcon]', error)), { once:true })
    : init().catch(error => console.error('[EVEWebIcon]', error));
})(window, document);
