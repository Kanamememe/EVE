/**
 * EVE Chat Moment Image Upload Fix v1.3.4
 *
 * Replaces the detached, one-off file input used by the original page with a
 * persistent DOM input. This is more reliable on iOS Safari and WKWebView.
 * Images are processed sequentially, decoded with timeout/error handling, and
 * added only after a usable data URL has been produced.
 */
(function (window, document) {
  'use strict';

  if (window.EVEMomentImageUpload?.version) return;

  const VERSION = '1.3.4';
  const INPUT_ID = 'eve-moment-image-file-input';
  const MAX_IMAGES = 9;
  const MAX_FILE_MB = 25;
  const MAX_GIF_MB = 8;
  const MAX_DIMENSION = 1600;
  const QUALITY = 0.84;
  const ACCEPT = 'image/*,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif';

  let initialized = false;
  let processing = false;
  let originalAddMomentImage = null;
  let lastResult = { imported: 0, failed: 0, skipped: 0, errors: [] };

  function clean(value, max = 300) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    try { return window.showToast?.(message, type); } catch (_) {}
    console.log('[EVEMomentImageUpload]', message);
  }

  function getMomentImages() {
    try {
      return typeof momentImages !== 'undefined' && Array.isArray(momentImages)
        ? momentImages
        : null;
    } catch (_) {
      return null;
    }
  }

  function renderGrid() {
    try { if (typeof updateMomentImagesGrid === 'function') return updateMomentImagesGrid(); } catch (_) {}
    try { return window.updateMomentImagesGrid?.(); } catch (_) {}
  }

  function extension(file) {
    return String(file?.name || '').split('.').pop().toLowerCase();
  }

  function isGif(file) {
    return String(file?.type || '').toLowerCase() === 'image/gif' || extension(file) === 'gif';
  }

  function isImage(file) {
    const type = String(file?.type || '').toLowerCase();
    return type.startsWith('image/') || ['jpg','jpeg','png','gif','webp','heic','heif'].includes(extension(file));
  }

  function readAsDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
      reader.onabort = () => reject(new Error('图片读取已取消'));
      reader.readAsDataURL(blob);
    });
  }

  function loadHtmlImage(dataUrl, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        image.src = '';
        reject(new Error('图片解码超时'));
      }, timeoutMs);
      image.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(image);
      };
      image.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error('图片格式无法解码'));
      };
      image.src = dataUrl;
    });
  }

  function canvasToDataURL(canvas, type = 'image/webp', quality = QUALITY) {
    return new Promise((resolve, reject) => {
      if (!canvas.toBlob) {
        try { resolve(canvas.toDataURL(type, quality)); }
        catch (error) { reject(error); }
        return;
      }
      canvas.toBlob(async blob => {
        if (!blob) {
          try { resolve(canvas.toDataURL(type, quality)); }
          catch (error) { reject(error); }
          return;
        }
        try { resolve(await readAsDataURL(blob)); }
        catch (error) { reject(error); }
      }, type, quality);
    });
  }

  async function decodeStaticImage(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return {
          width: bitmap.width,
          height: bitmap.height,
          draw(context, width, height) { context.drawImage(bitmap, 0, 0, width, height); },
          close() { try { bitmap.close(); } catch (_) {} }
        };
      } catch (_) {}
    }

    const dataUrl = await readAsDataURL(file);
    const image = await loadHtmlImage(dataUrl);
    return {
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      draw(context, width, height) { context.drawImage(image, 0, 0, width, height); },
      close() {}
    };
  }

  async function processFile(file) {
    if (!isImage(file)) throw new Error('不是支持的图片格式');
    const sizeMB = Number(file.size || 0) / 1024 / 1024;
    if (sizeMB > MAX_FILE_MB) throw new Error(`图片超过 ${MAX_FILE_MB}MB`);

    if (isGif(file)) {
      if (sizeMB > MAX_GIF_MB) throw new Error(`GIF 超过 ${MAX_GIF_MB}MB`);
      const dataUrl = await readAsDataURL(file);
      if (!/^data:image\/gif/i.test(dataUrl)) throw new Error('GIF 读取失败');
      return dataUrl;
    }

    let decoded;
    try {
      decoded = await decodeStaticImage(file);
    } catch (error) {
      const ext = extension(file);
      if (ext === 'heic' || ext === 'heif' || /hei[cf]/i.test(file.type || '')) {
        throw new Error('这张 HEIC/HEIF 图片无法在当前浏览器解码，请在相册中导出为 JPEG 后重试');
      }
      throw error;
    }

    try {
      if (!decoded.width || !decoded.height) throw new Error('图片尺寸无效');
      const ratio = Math.min(1, MAX_DIMENSION / Math.max(decoded.width, decoded.height));
      const width = Math.max(1, Math.round(decoded.width * ratio));
      const height = Math.max(1, Math.round(decoded.height * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new Error('无法建立图片处理画布');
      decoded.draw(context, width, height);
      const dataUrl = await canvasToDataURL(canvas, 'image/webp', QUALITY);
      if (!/^data:image\//i.test(dataUrl)) throw new Error('图片压缩结果无效');
      return dataUrl;
    } finally {
      decoded?.close?.();
    }
  }

  function getInput() {
    let input = document.getElementById(INPUT_ID);
    if (input) return input;

    input = document.createElement('input');
    input.id = INPUT_ID;
    input.type = 'file';
    input.accept = ACCEPT;
    input.multiple = true;
    input.setAttribute('aria-hidden', 'true');
    input.style.cssText = [
      'position:fixed',
      'left:-10000px',
      'top:0',
      'width:1px',
      'height:1px',
      'opacity:0',
      'pointer-events:none'
    ].join(';');
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      input.value = '';
      if (files.length) await addFiles(files);
    });
    return input;
  }

  async function addFiles(fileList) {
    if (processing) {
      toast('正在处理上一批图片，请稍等', 'warning');
      return { ...lastResult };
    }

    const images = getMomentImages();
    if (!images) throw new Error('动态图片列表尚未载入');
    const remaining = Math.max(0, MAX_IMAGES - images.length);
    if (!remaining) {
      toast(`一条动态最多上传 ${MAX_IMAGES} 张图片`, 'warning');
      return { imported: 0, skipped: Array.from(fileList || []).length, failed: 0, errors: [] };
    }

    processing = true;
    const files = Array.from(fileList || []);
    const selected = files.slice(0, remaining);
    let imported = 0;
    let failed = 0;
    let skipped = Math.max(0, files.length - selected.length);
    const errors = [];

    toast(`正在处理 ${selected.length} 张图片…`, 'info');
    try {
      for (const file of selected) {
        try {
          const dataUrl = await processFile(file);
          images.push(dataUrl);
          imported += 1;
          renderGrid();
        } catch (error) {
          failed += 1;
          errors.push(`${clean(file?.name || '图片', 80)}：${clean(error?.message || error, 160)}`);
          console.warn('[EVEMomentImageUpload] 图片处理失败', file?.name, error);
        }
      }
    } finally {
      processing = false;
    }

    lastResult = { imported, failed, skipped, errors };
    if (imported) {
      const parts = [`已添加 ${imported} 张图片`];
      if (skipped) parts.push(`跳过 ${skipped} 张`);
      if (failed) parts.push(`失败 ${failed} 张`);
      toast(parts.join('，'), failed ? 'warning' : 'success');
    } else if (failed) {
      toast(errors[0] || '图片上传失败', 'error');
    }

    window.dispatchEvent(new CustomEvent('eve:moment-images-selected', {
      detail: { imported, failed, skipped, errors: errors.slice(), total: images.length }
    }));
    return { ...lastResult };
  }

  function openPicker() {
    const images = getMomentImages();
    if (images && images.length >= MAX_IMAGES) {
      toast(`一条动态最多上传 ${MAX_IMAGES} 张图片`, 'warning');
      return false;
    }
    const input = getInput();
    try {
      if (typeof input.showPicker === 'function') input.showPicker();
      else input.click();
    } catch (_) {
      input.click();
    }
    return true;
  }

  function installOverride() {
    if (!originalAddMomentImage && typeof window.addMomentImage === 'function') {
      originalAddMomentImage = window.addMomentImage;
    }
    window.addMomentImage = openPicker;
    return true;
  }

  function getDiagnostics() {
    return {
      version: VERSION,
      initialized,
      processing,
      inputAttached: Boolean(document.getElementById(INPUT_ID)),
      overrideInstalled: window.addMomentImage === openPicker,
      momentImageCount: getMomentImages()?.length ?? null,
      lastResult: { ...lastResult }
    };
  }

  function init() {
    if (initialized) return getDiagnostics();
    initialized = true;
    const run = () => {
      getInput();
      installOverride();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();

    // The original script is already parsed before extensions, but retry in case
    // another feature replaces the global function after startup.
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      installOverride();
      if (attempts >= 20) clearInterval(timer);
    }, 500);

    window.EVE ||= {};
    window.EVE.momentImageUpload = window.EVEMomentImageUpload;
    window.dispatchEvent(new CustomEvent('eve:moment-image-upload-ready', { detail: getDiagnostics() }));
    return getDiagnostics();
  }

  window.EVEMomentImageUpload = Object.freeze({
    version: VERSION,
    init,
    openPicker,
    addFiles,
    getDiagnostics
  });

  init();
})(window, document);
