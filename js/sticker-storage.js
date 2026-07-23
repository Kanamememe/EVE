/**
 * EVE Chat Sticker Persistence v1.3.4
 *
 * Fixes two destructive behaviours in the original sticker save path:
 * 1. the original function swallowed IndexedDB errors and callers reported success;
 * 2. personal stickers were deleted before the replacement write completed.
 *
 * This module keeps an independent transactional vault and mirrors it to the
 * original EVE database. The in-memory customEmojis array is always updated in
 * place so existing UI code keeps the same reference.
 */
(function (window, document) {
  'use strict';

  if (window.EVEStickerStorage?.version) return;

  const VERSION = '1.3.4';
  const VAULT_DB_NAME = 'EVEChat_StickerVault_v2';
  const VAULT_DB_VERSION = 1;
  const STICKER_STORE = 'stickers';
  const META_STORE = 'meta';
  const PERSIST_REQUEST_KEY = 'eve_sticker_persist_requested_v1';

  let vaultPromise = null;
  let initialized = false;
  let syncing = null;
  let originalSave = null;
  let originalLoad = null;
  let lastStatus = {
    at: null,
    ok: true,
    vaultCount: 0,
    nativeCount: 0,
    restored: 0,
    message: '尚未同步'
  };

  function clean(value, max = 500) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function clone(value) {
    try {
      return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止'));
    });
  }

  function openVault() {
    if (vaultPromise) return vaultPromise;

    vaultPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STICKER_STORE)) {
          const store = database.createObjectStore(STICKER_STORE, { keyPath: 'id' });
          store.createIndex('addedAt', 'addedAt', { unique: false });
          store.createIndex('contentHash', 'contentHash', { unique: false });
          store.createIndex('sourceSignature', 'sourceSignature', { unique: false });
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        vaultPromise = null;
        reject(request.error || new Error('无法打开表情包保险库'));
      };
      request.onblocked = () => console.warn('[EVEStickerStorage] 保险库升级被其他页面阻塞');
    });

    return vaultPromise;
  }

  function getStickerArray() {
    try {
      return typeof customEmojis !== 'undefined' && Array.isArray(customEmojis)
        ? customEmojis
        : null;
    } catch (_) {
      return null;
    }
  }

  function getNativeDb() {
    try {
      if (window.db?.customEmojis) return window.db;
      if (typeof db !== 'undefined' && db?.customEmojis) return db;
    } catch (_) {}
    return null;
  }

  function imageValue(item) {
    return String(item?.url || item?.imageData || '');
  }

  function isUsableSticker(item) {
    if (!item || !clean(item.id, 220)) return false;
    const image = imageValue(item);
    return /^(data:image\/|blob:|capacitor:|file:|https?:)/i.test(image);
  }

  function normalizeSticker(item) {
    const value = clone(item || {});
    value.id = clean(value.id, 220) || `emoji_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    value.url = imageValue(value);
    value.imageData = value.imageData || value.url;
    value.name = clean(value.name || value.description || value.originalFileName || '表情包', 160) || '表情包';
    value.description = clean(value.description || value.name, 220) || value.name;
    value.category = clean(value.category || '未分类', 80) || '未分类';
    value.tags = Array.from(new Set((Array.isArray(value.tags) ? value.tags : [])
      .map(tag => clean(tag, 50))
      .filter(Boolean))).slice(0, 40);
    value.favorite = Boolean(value.favorite);
    value.isPersonal = true;
    value.addedAt = value.addedAt || new Date().toISOString();
    value.updatedAt = new Date().toISOString();
    return value;
  }

  function normalizeList(items) {
    const result = [];
    const ids = new Set();
    const hashes = new Set();
    const signatures = new Set();

    for (const source of Array.from(items || [])) {
      const item = normalizeSticker(source);
      if (!isUsableSticker(item)) continue;
      if (ids.has(item.id)) continue;
      if (item.contentHash && hashes.has(item.contentHash)) continue;
      if (item.sourceSignature && signatures.has(item.sourceSignature)) continue;
      ids.add(item.id);
      if (item.contentHash) hashes.add(item.contentHash);
      if (item.sourceSignature) signatures.add(item.sourceSignature);
      result.push(item);
    }
    return result;
  }

  async function requestPersistentStorage() {
    if (!navigator.storage?.persist) return false;
    try {
      if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
      const granted = await navigator.storage.persist();
      try { localStorage.setItem(PERSIST_REQUEST_KEY, granted ? 'granted' : 'denied'); } catch (_) {}
      return granted;
    } catch (error) {
      console.warn('[EVEStickerStorage] 无法申请持久储存', error);
      return false;
    }
  }

  async function readVault() {
    const database = await openVault();
    const transaction = database.transaction(STICKER_STORE, 'readonly');
    const values = await requestToPromise(transaction.objectStore(STICKER_STORE).getAll());
    await transactionDone(transaction);
    return normalizeList(values);
  }

  async function replaceVault(items) {
    const records = normalizeList(items);
    const database = await openVault();
    const transaction = database.transaction([STICKER_STORE, META_STORE], 'readwrite');
    const store = transaction.objectStore(STICKER_STORE);
    const meta = transaction.objectStore(META_STORE);
    const existingKeys = await requestToPromise(store.getAllKeys());
    const keep = new Set(records.map(item => item.id));

    for (const record of records) store.put(record);
    for (const key of existingKeys) if (!keep.has(String(key))) store.delete(key);
    meta.put({ key: 'lastSync', value: new Date().toISOString(), count: records.length });
    await transactionDone(transaction);

    const verified = await readVault();
    if (verified.length !== records.length) {
      throw new Error(`保险库验证失败：预期 ${records.length}，实际 ${verified.length}`);
    }
    return verified;
  }

  async function readNative() {
    const nativeDb = getNativeDb();
    if (!nativeDb?.customEmojis) return [];
    const values = await nativeDb.customEmojis.toArray();
    return normalizeList(values.filter(item => item?.isPersonal !== false));
  }

  async function replaceNative(items) {
    const records = normalizeList(items).map(item => ({ ...item, isPersonal: true }));
    const nativeDb = getNativeDb();
    if (!nativeDb?.customEmojis) throw new Error('EVE 原生表情包数据库尚未就绪');

    await nativeDb.transaction('rw', nativeDb.customEmojis, async () => {
      // Dexie transactions are atomic. Write first, verify, then remove stale rows.
      if (records.length) await nativeDb.customEmojis.bulkPut(records);

      const written = records.length
        ? await nativeDb.customEmojis.bulkGet(records.map(item => item.id))
        : [];
      if (written.some((item, index) => !item || String(item.id) !== String(records[index].id))) {
        throw new Error('EVE 原生表情包写入验证失败');
      }

      const existing = await nativeDb.customEmojis
        .filter(item => item?.isPersonal !== false)
        .toArray();
      const keep = new Set(records.map(item => String(item.id)));
      const staleIds = existing
        .map(item => item?.id)
        .filter(id => id != null && !keep.has(String(id)));
      if (staleIds.length) await nativeDb.customEmojis.bulkDelete(staleIds);
    });

    const verified = await readNative();
    if (verified.length !== records.length) {
      throw new Error(`原生数据库验证失败：预期 ${records.length}，实际 ${verified.length}`);
    }
    return verified;
  }

  function mergeLists(vaultItems, nativeItems, memoryItems) {
    const byId = new Map();
    const order = [];

    function add(source, priority) {
      for (const raw of normalizeList(source)) {
        const id = String(raw.id);
        const previous = byId.get(id);
        if (!previous) {
          byId.set(id, { item: raw, priority });
          order.push(id);
          continue;
        }
        const previousHasImage = isUsableSticker(previous.item);
        const currentHasImage = isUsableSticker(raw);
        if (priority > previous.priority || (!previousHasImage && currentHasImage)) {
          byId.set(id, { item: { ...previous.item, ...raw }, priority });
        } else {
          previous.item = { ...raw, ...previous.item };
        }
      }
    }

    // Vault is the recovery source of truth, memory has the freshest edits.
    add(nativeItems, 1);
    add(vaultItems, 2);
    add(memoryItems, 3);
    return normalizeList(order.map(id => byId.get(id)?.item).filter(Boolean));
  }

  function replaceMemory(items) {
    const array = getStickerArray();
    if (!array) return false;
    array.splice(0, array.length, ...normalizeList(items));
    return true;
  }

  async function renderOriginal() {
    try {
      if (typeof renderEmojiGrid === 'function') return await renderEmojiGrid();
    } catch (_) {}
    try { return await window.renderEmojiGrid?.(); } catch (_) {}
  }

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  async function saveAll(items = getStickerArray(), options = {}) {
    const records = normalizeList(items || []);
    const started = Date.now();
    let vault = [];
    let native = [];
    let nativeError = null;

    try {
      await requestPersistentStorage();
      vault = await replaceVault(records);
      try {
        native = await replaceNative(records);
      } catch (error) {
        nativeError = error;
        console.warn('[EVEStickerStorage] 原生表情包镜像失败，保险库已保存', error);
      }

      lastStatus = {
        at: new Date().toISOString(),
        ok: true,
        vaultCount: vault.length,
        nativeCount: native.length,
        restored: 0,
        durationMs: Date.now() - started,
        nativeWarning: nativeError ? clean(nativeError.message || nativeError, 500) : '',
        message: nativeError ? '保险库保存成功，原生镜像稍后重试' : '表情包已双重保存并验证'
      };
      emit('eve:sticker-storage-saved', clone(lastStatus));
      return { ...clone(lastStatus), records: clone(records) };
    } catch (error) {
      lastStatus = {
        at: new Date().toISOString(),
        ok: false,
        vaultCount: vault.length,
        nativeCount: native.length,
        restored: 0,
        durationMs: Date.now() - started,
        message: clean(error?.message || error, 500) || '表情包保存失败'
      };
      emit('eve:sticker-storage-error', { status: clone(lastStatus), error });
      throw error;
    }
  }

  async function sync(options = {}) {
    if (syncing) return syncing;
    syncing = (async () => {
      const memory = getStickerArray() || [];
      let vault = [];
      let native = [];
      let vaultError = null;
      let nativeError = null;

      try { vault = await readVault(); } catch (error) { vaultError = error; }
      try { native = await readNative(); } catch (error) { nativeError = error; }

      if (vaultError && nativeError) throw vaultError;
      const merged = mergeLists(vault, native, memory);
      const previousCount = memory.length;
      replaceMemory(merged);

      // Repopulate both stores without allowing one mirror failure to erase data.
      let savedVault = vault;
      let savedNative = native;
      try { savedVault = await replaceVault(merged); } catch (error) { vaultError = error; }
      try { savedNative = await replaceNative(merged); } catch (error) { nativeError = error; }

      await renderOriginal();
      const restored = Math.max(0, merged.length - previousCount);
      lastStatus = {
        at: new Date().toISOString(),
        ok: !vaultError,
        vaultCount: savedVault.length,
        nativeCount: savedNative.length,
        restored,
        vaultWarning: vaultError ? clean(vaultError.message || vaultError, 500) : '',
        nativeWarning: nativeError ? clean(nativeError.message || nativeError, 500) : '',
        message: restored ? `已恢复 ${restored} 张表情包` : '表情包储存已同步'
      };
      emit('eve:sticker-storage-synced', clone(lastStatus));
      return clone(lastStatus);
    })().finally(() => { syncing = null; });
    return syncing;
  }

  function installHooks() {
    if (!originalSave && typeof window.saveCustomEmojis === 'function') {
      originalSave = window.saveCustomEmojis;
      const wrappedSave = async function () {
        return saveAll(getStickerArray());
      };
      wrappedSave.__eveStickerStorageWrapped = true;
      window.saveCustomEmojis = wrappedSave;
    }

    if (!originalLoad && typeof window.loadCustomEmojis === 'function') {
      originalLoad = window.loadCustomEmojis;
      const wrappedLoad = async function () {
        let result;
        try { result = await originalLoad.apply(this, arguments); }
        finally { await sync({ reason: 'native-load' }).catch(error => console.warn('[EVEStickerStorage] 加载后同步失败', error)); }
        return result;
      };
      wrappedLoad.__eveStickerStorageWrapped = true;
      window.loadCustomEmojis = wrappedLoad;
    }
  }

  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    try { return window.showToast?.(message, type); } catch (_) {}
  }

  async function repair() {
    try {
      const result = await sync({ reason: 'manual-repair' });
      toast(`${result.message}（本地 ${result.nativeCount}／保险库 ${result.vaultCount}）`, result.ok ? 'success' : 'warning');
      return result;
    } catch (error) {
      toast(`表情包修复失败：${clean(error?.message || error, 180)}`, 'error');
      throw error;
    }
  }

  function getStatus() { return clone(lastStatus); }

  async function init() {
    if (initialized) return getStatus();
    initialized = true;
    installHooks();
    await requestPersistentStorage();

    // Main EVE data loading happens on DOMContentLoaded; sync after it settles.
    const run = () => setTimeout(() => sync({ reason: 'startup' }).catch(error => console.warn('[EVEStickerStorage] 启动同步失败', error)), 800);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();

    let lastVisibilitySync = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastVisibilitySync < 5000) return;
      lastVisibilitySync = Date.now();
      sync({ reason: 'visibility' }).catch(error => console.warn('[EVEStickerStorage] 恢复前景同步失败', error));
    });

    window.addEventListener('pageshow', event => {
      if (event.persisted) sync({ reason: 'pageshow' }).catch(() => {});
    });
    window.addEventListener('eve:stickers-imported', () => saveAll(getStickerArray()).catch(error => console.warn('[EVEStickerStorage] 导入后保存失败', error)));
    window.addEventListener('eve:stickers-reordered', () => saveAll(getStickerArray()).catch(() => {}));

    window.EVE ||= {};
    window.EVE.stickerStorage = window.EVEStickerStorage;
    emit('eve:sticker-storage-ready', { version: VERSION });
    return getStatus();
  }

  window.EVEStickerStorage = Object.freeze({
    version: VERSION,
    init,
    sync,
    repair,
    saveAll,
    readVault,
    readNative,
    getStatus,
    requestPersistentStorage
  });

  init().catch(error => console.error('[EVEStickerStorage] 初始化失败', error));
})(window, document);
