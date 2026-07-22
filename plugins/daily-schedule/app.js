/**
 * EVE Daily Schedule App v1.3.0
 * 在主屏幕 Dock 提供独立“行程”App，并以原生 EVE app-screen 呈现角色行程。
 */
(function (window, document) {
  'use strict';
  if (window.EVEScheduleApp?.version) return;

  const VERSION = '1.3.0';
  const SCREEN_ID = 'schedule-screen';
  const HOME_ID = 'eve-schedule-home-app';
  const STYLE_ID = 'eve-schedule-app-style';
  const STATUS_LABELS = Object.freeze({
    planned: '计划中', active: '进行中', completed: '已完成',
    adjusted: '已调整', cancelled: '已取消', missed: '错过'
  });

  let initialized = false;
  let viewDate = '';
  let rendering = false;
  const disposers = [];

  function clean(value, max = 1000) {
    return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }
  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    if (window.showToast) return window.showToast(message, type);
    console.log('[EVEScheduleApp]', message);
  }
  function emit(name, detail = {}) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
  }
  function on(target, name, handler, options) {
    target.addEventListener(name, handler, options);
    disposers.push(() => target.removeEventListener(name, handler, options));
  }
  function api() { return window.EVEDailySchedule || null; }
  function chat() {
    return window.EVEAdapter?.getCurrentChat?.() || { id: '', name: '', scope: 'global', open: false };
  }
  function environment() { return window.EVEWeather?.getEnvironment?.() || null; }
  function currentDate() {
    const env = environment();
    return clean(env?.character?.localDate || env?.localDate, 20) || localDate(new Date());
  }
  function localDate(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }
  function shiftDate(dateText, delta) {
    const date = new Date(`${dateText || currentDate()}T12:00:00`);
    if (Number.isNaN(date.getTime())) return currentDate();
    date.setDate(date.getDate() + delta);
    return localDate(date);
  }
  function dateLabel(value) {
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    try {
      return new Intl.DateTimeFormat('zh-TW', {
        month: 'long', day: 'numeric', weekday: 'short'
      }).format(date);
    } catch (_) { return `${date.getMonth() + 1}月${date.getDate()}日`; }
  }
  function isToday(value) { return value === currentDate(); }
  function hasCharacter() {
    const current = chat();
    return Boolean(current.id || (current.name && current.name !== '角色聊天'));
  }
  function statusClass(status) {
    return ['planned', 'active', 'completed', 'adjusted', 'cancelled', 'missed'].includes(status) ? status : 'planned';
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${HOME_ID} .mini-app-icon{position:relative;background:linear-gradient(135deg,#7b61ff,#5b8cff)!important;color:#fff}
      #${HOME_ID} .mini-app-icon i{color:#fff!important}
      .eve-schedule-home-badge{position:absolute;right:-5px;top:-5px;min-width:18px;height:18px;padding:0 4px;border-radius:10px;background:#ff3b30;color:#fff;font-size:10px;line-height:18px;text-align:center;font-weight:700;box-shadow:0 1px 5px #0005;display:none;z-index:2}
      #${SCREEN_ID}{background:var(--body-bg,#f5f5f7)}
      #${SCREEN_ID} .eve-schedule-app-content{padding:0!important;overflow-y:auto;background:var(--body-bg,#f5f5f7)}
      #${SCREEN_ID} .eve-schedule-header-actions{position:absolute;right:17px;top:50%;transform:translateY(-50%);display:flex;gap:8px}
      #${SCREEN_ID} .eve-schedule-icon-btn{border:0;background:transparent;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:inherit;font-size:15px;cursor:pointer}
      #${SCREEN_ID} .eve-schedule-icon-btn:active{background:rgba(0,0,0,.08)}
      .eve-schedule-date-nav{display:grid;grid-template-columns:38px 1fr 38px;gap:8px;align-items:center;padding:12px 14px 8px}
      .eve-schedule-date-nav button{border:0;background:rgba(74,132,193,.12);color:#4a84c1;border-radius:11px;height:36px;font-size:17px}
      .eve-schedule-date-main{text-align:center}
      .eve-schedule-date-main b{display:block;font-size:17px}
      .eve-schedule-date-main small{display:block;margin-top:2px;opacity:.62}
      .eve-schedule-today-button{display:block;margin:0 auto 10px;border:0;background:transparent;color:#4a84c1;font-size:12px}
      .eve-schedule-summary{margin:0 13px 10px;padding:13px 14px;border-radius:16px;background:rgba(255,255,255,.86);box-shadow:0 2px 10px rgba(0,0,0,.06)}
      .eve-schedule-summary-top{display:flex;align-items:center;gap:8px}
      .eve-schedule-summary-character{font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .eve-schedule-summary-source{font-size:11px;padding:3px 7px;border-radius:8px;background:rgba(74,132,193,.1);color:#4a84c1}
      .eve-schedule-summary-current{margin-top:9px;font-size:13px;line-height:1.45}
      .eve-schedule-list{padding:0 13px 90px}
      .eve-schedule-empty{padding:48px 24px;text-align:center;opacity:.66;line-height:1.7}
      .eve-schedule-empty i{font-size:38px;display:block;margin-bottom:12px;color:#7b61ff}
      .eve-schedule-primary{border:0;background:#4a84c1;color:#fff;border-radius:11px;padding:9px 15px;margin-top:12px}
      .eve-schedule-item{display:grid;grid-template-columns:62px 1fr auto;gap:10px;align-items:start;margin-bottom:8px;padding:12px;border-radius:15px;background:rgba(255,255,255,.9);box-shadow:0 2px 9px rgba(0,0,0,.055);border-left:4px solid #4a84c1}
      .eve-schedule-item.active{border-left-color:#34c759;background:rgba(235,255,240,.94)}
      .eve-schedule-item.completed{border-left-color:#8e8e93;opacity:.72}
      .eve-schedule-item.cancelled,.eve-schedule-item.missed{border-left-color:#ff3b30;opacity:.68}
      .eve-schedule-item.adjusted{border-left-color:#ff9500}
      .eve-schedule-time{font-size:12px;line-height:1.35;color:#4a84c1;font-weight:700}
      .eve-schedule-item.active .eve-schedule-time{color:#248a3d}
      .eve-schedule-title{font-weight:700;font-size:14px;line-height:1.35}
      .eve-schedule-description{font-size:12px;line-height:1.45;margin-top:4px;opacity:.68;white-space:pre-wrap}
      .eve-schedule-meta{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}
      .eve-schedule-chip{font-size:10px;border-radius:8px;padding:3px 6px;background:rgba(0,0,0,.055)}
      .eve-schedule-item-actions{display:flex;flex-direction:column;gap:5px}
      .eve-schedule-item-actions button{border:0;background:rgba(0,0,0,.055);border-radius:8px;width:30px;height:28px;color:inherit}
      .eve-schedule-bottom-bar{position:absolute;left:0;right:0;bottom:0;padding:9px 12px calc(9px + env(safe-area-inset-bottom));background:rgba(250,250,250,.92);backdrop-filter:blur(16px);border-top:1px solid rgba(0,0,0,.08);display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
      .eve-schedule-bottom-bar button{border:0;border-radius:11px;padding:9px 5px;background:rgba(74,132,193,.11);color:#4a84c1;font-size:12px}
      body[data-theme="dark"] #${SCREEN_ID},body[data-theme="dark"] #${SCREEN_ID} .eve-schedule-app-content{background:#1a1a1a}
      body[data-theme="dark"] .eve-schedule-summary,body[data-theme="dark"] .eve-schedule-item{background:rgba(44,44,46,.92);color:#eee}
      body[data-theme="dark"] .eve-schedule-bottom-bar{background:rgba(28,28,30,.93);border-top-color:#444}
      @media(max-width:380px){.eve-schedule-item{grid-template-columns:56px 1fr auto;padding:10px;gap:7px}.eve-schedule-bottom-bar button{font-size:11px}}
    `;
    document.head.append(style);
  }

  function injectHomeIcon() {
    if (document.getElementById(HOME_ID)) return true;
    const section = document.querySelector('#home-grid .home-section.bottom-left');
    const grid = section?.querySelector('.apps-grid-2, .apps-grid');
    if (!grid) return false;
    // 与 Chat／纪念日相同，作为主屏幕独立 App 图标呈现。
    grid.classList.remove('apps-grid-2');
    grid.classList.add('apps-grid');
    const item = document.createElement('a');
    item.href = '#';
    item.id = HOME_ID;
    item.className = 'mini-app';
    item.innerHTML = `<div class="mini-app-icon"><i class="fas fa-calendar-alt"></i><span class="eve-schedule-home-badge" data-eve-schedule-badge></span></div><span>行程</span>`;
    item.addEventListener('click', event => { event.preventDefault(); open(); });
    grid.append(item);
    return true;
  }

  function statusBarMarkup() {
    return `<div class="app-status-bar"><div class="app-status-time"></div><div class="app-status-right"><div class="app-signal-icon signal-icon"><div class="signal-row"><div class="signal-bar"></div><div class="signal-bar"></div><div class="signal-bar"></div><div class="signal-bar"></div></div></div><div class="app-battery-container"><div class="app-battery-icon"><div class="app-battery-level"></div></div></div></div></div>`;
  }

  function injectScreen() {
    if (document.getElementById(SCREEN_ID)) return true;
    const host = document.getElementById('phone-screen') || document.body;
    if (!host) return false;
    const screen = document.createElement('div');
    screen.id = SCREEN_ID;
    screen.className = 'app-screen';
    screen.innerHTML = `
      <div class="app-top-container">
        ${statusBarMarkup()}
        <div class="app-header">
          <button class="back-button" data-eve-schedule-back>‹</button>
          <div class="app-title">角色行程</div>
          <div class="eve-schedule-header-actions">
            <button class="eve-schedule-icon-btn" data-eve-schedule-generate title="生成今日行程"><i class="fas fa-magic"></i></button>
            <button class="eve-schedule-icon-btn" data-eve-schedule-add title="新增行程"><i class="fas fa-plus"></i></button>
          </div>
        </div>
      </div>
      <div class="app-content eve-schedule-app-content">
        <div class="eve-schedule-date-nav"><button data-eve-schedule-prev>‹</button><div class="eve-schedule-date-main"><b data-eve-schedule-date></b><small data-eve-schedule-subtitle></small></div><button data-eve-schedule-next>›</button></div>
        <button class="eve-schedule-today-button" data-eve-schedule-today>回到今天</button>
        <div class="eve-schedule-summary" data-eve-schedule-summary></div>
        <div class="eve-schedule-list" data-eve-schedule-list></div>
      </div>
      <div class="eve-schedule-bottom-bar">
        <button data-eve-schedule-refresh><i class="fas fa-sync-alt"></i> 刷新</button>
        <button data-eve-schedule-settings><i class="fas fa-sliders-h"></i> 设置</button>
        <button data-eve-schedule-clear><i class="fas fa-trash-alt"></i> 清空当天</button>
      </div>`;
    host.append(screen);

    screen.querySelector('[data-eve-schedule-back]').onclick = close;
    screen.querySelector('[data-eve-schedule-prev]').onclick = () => { viewDate = shiftDate(viewDate, -1); render(); };
    screen.querySelector('[data-eve-schedule-next]').onclick = () => { viewDate = shiftDate(viewDate, 1); render(); };
    screen.querySelector('[data-eve-schedule-today]').onclick = () => { viewDate = currentDate(); render(); };
    screen.querySelector('[data-eve-schedule-generate]').onclick = generateViewedDay;
    screen.querySelector('[data-eve-schedule-add]').onclick = addItem;
    screen.querySelector('[data-eve-schedule-refresh]').onclick = () => render({ tick: true });
    screen.querySelector('[data-eve-schedule-settings]').onclick = () => api()?.openSettings?.();
    screen.querySelector('[data-eve-schedule-clear]').onclick = () => {
      if (!hasCharacter()) return toast('请先在 Chat 中打开一个角色', 'error');
      if (!confirm(`清空 ${dateLabel(viewDate)} 的行程？`)) return;
      api()?.clearDay?.({ date: viewDate, scope: chat().scope });
      render();
    };
    return true;
  }

  function openNativeScreen() {
    const screen = document.getElementById(SCREEN_ID);
    if (!screen) return;
    try { if (typeof showApp === 'function') showApp(SCREEN_ID); } catch (_) {}
    // 部分旧版 showApp 只识别写死的页面；若动态页面未显示，使用安全回退。
    const visible = (() => {
      try { return getComputedStyle(screen).display !== 'none'; } catch (_) { return screen.style.display !== 'none'; }
    })();
    if (visible) return;
    document.querySelectorAll('.app-screen').forEach(item => { item.style.display = 'none'; });
    screen.style.display = 'flex';
    const home = document.getElementById('home-grid'); if (home) home.style.display = 'none';
    const dock = document.getElementById('dock-bar'); if (dock) dock.style.display = 'none';
  }
  function close() {
    const screen = document.getElementById(SCREEN_ID);
    try { if (typeof hideApp === 'function') hideApp(SCREEN_ID); } catch (_) {}
    const stillVisible = screen && (() => {
      try { return getComputedStyle(screen).display !== 'none'; } catch (_) { return screen.style.display !== 'none'; }
    })();
    if (!stillVisible) return;
    if (screen) screen.style.display = 'none';
    const home = document.getElementById('home-grid'); if (home) home.style.display = '';
    const dock = document.getElementById('dock-bar'); if (dock) dock.style.display = '';
  }
  function open() {
    injectStyle(); injectHomeIcon(); injectScreen();
    viewDate ||= currentDate();
    openNativeScreen();
    render({ tick: true });
    emit('eve:schedule-app-opened', { date: viewDate, chat: chat() });
  }

  async function generateViewedDay() {
    if (!hasCharacter()) return toast('请先在 Chat 中打开一个角色，再回来生成行程', 'error');
    const schedule = api();
    if (!schedule) return toast('行程模块尚未载入', 'error');
    const button = document.querySelector(`#${SCREEN_ID} [data-eve-schedule-generate]`);
    try {
      if (button) button.disabled = true;
      await schedule.generateDay({
        date: viewDate,
        scope: chat().scope,
        force: true,
        fullDay: schedule.getSettings?.().mode !== 'on-demand'
      });
      toast(`${dateLabel(viewDate)} 行程已生成`);
      await render();
    } catch (error) { toast(error?.message || String(error), 'error'); }
    finally { if (button) button.disabled = false; }
  }

  function addItem() {
    if (!hasCharacter()) return toast('请先在 Chat 中打开一个角色', 'error');
    const title = prompt('行程标题'); if (!title) return;
    const start = prompt('开始时间 HH:MM', '19:00'); if (start === null) return;
    const end = prompt('结束时间 HH:MM', '20:00'); if (end === null) return;
    const description = prompt('说明（可留空）', '') ?? '';
    api()?.addItem?.({ title, start, end, description, locked: true }, { date: viewDate, scope: chat().scope });
    render();
  }

  function editItem(item) {
    const title = prompt('行程标题', item.title); if (title === null) return;
    const start = prompt('开始时间 HH:MM', item.start); if (start === null) return;
    const end = prompt('结束时间 HH:MM', item.end); if (end === null) return;
    const description = prompt('说明', item.description || ''); if (description === null) return;
    const privateItem = confirm('是否设为私密行程？\n私密行程仍会影响角色状态，但不会主动向使用者完整汇报');
    api()?.updateItem?.(item.id, { title, start, end, description, private: privateItem, locked: item.locked }, { date: viewDate, scope: chat().scope });
    render();
  }

  function cycleStatus(item) {
    const choices = ['planned', 'active', 'completed', 'adjusted', 'cancelled', 'missed'];
    const labels = choices.map((value, index) => `${index + 1}. ${STATUS_LABELS[value]}`).join('\n');
    const input = prompt(`选择状态\n${labels}`, String(Math.max(1, choices.indexOf(item.status) + 1)));
    if (input === null) return;
    const next = choices[Number(input) - 1];
    if (!next) return toast('状态编号无效', 'error');
    api()?.updateItem?.(item.id, { status: next }, { date: viewDate, scope: chat().scope });
    render();
  }

  function itemMarkup(item) {
    const status = statusClass(item.status);
    const privacy = item.private ? '<span class="eve-schedule-chip">私密</span>' : '';
    const locked = item.locked ? '<span class="eve-schedule-chip">锁定</span>' : '';
    return `<div class="eve-schedule-item ${status}" data-eve-schedule-item="${escapeHtml(item.id)}">
      <div class="eve-schedule-time">${escapeHtml(item.start)}<br>${escapeHtml(item.end)}</div>
      <div><div class="eve-schedule-title">${escapeHtml(item.title)}</div><div class="eve-schedule-description">${escapeHtml(item.description || '')}</div><div class="eve-schedule-meta"><span class="eve-schedule-chip">${escapeHtml(STATUS_LABELS[status] || status)}</span><span class="eve-schedule-chip">${escapeHtml(item.type || 'daily')}</span>${locked}${privacy}</div></div>
      <div class="eve-schedule-item-actions"><button data-status title="状态"><i class="fas fa-check-circle"></i></button><button data-edit title="编辑"><i class="fas fa-pen"></i></button><button data-delete title="删除"><i class="fas fa-trash"></i></button></div>
    </div>`;
  }

  async function render(options = {}) {
    if (rendering) return;
    rendering = true;
    try {
      injectHomeIcon(); injectScreen();
      viewDate ||= currentDate();
      const schedule = api();
      const current = chat();
      const screen = document.getElementById(SCREEN_ID);
      if (!screen) return;
      if (options.tick && isToday(viewDate) && schedule?.tick && hasCharacter()) {
        try { await schedule.tick({ forceGenerate: false }); } catch (_) {}
      }
      const day = hasCharacter() ? schedule?.getDay?.({ date: viewDate, scope: current.scope }) : null;
      screen.querySelector('[data-eve-schedule-date]').textContent = dateLabel(viewDate);
      screen.querySelector('[data-eve-schedule-subtitle]').textContent = `${isToday(viewDate) ? '今天｜' : ''}${current.name || '尚未选择角色'}`;
      screen.querySelector('[data-eve-schedule-today]').style.visibility = isToday(viewDate) ? 'hidden' : 'visible';
      const summary = screen.querySelector('[data-eve-schedule-summary]');
      const list = screen.querySelector('[data-eve-schedule-list]');

      if (!hasCharacter()) {
        summary.innerHTML = '<div class="eve-schedule-summary-top"><span class="eve-schedule-summary-character">尚未选择角色</span></div><div class="eve-schedule-summary-current">行程按角色独立保存，请先进入 Chat 打开一个角色</div>';
        list.innerHTML = '<div class="eve-schedule-empty"><i class="fas fa-user-clock"></i>先选择一个角色，行程 App 才知道要查看谁的一天<br><button class="eve-schedule-primary" data-go-chat>前往 Chat</button></div>';
        list.querySelector('[data-go-chat]').onclick = () => { close(); try { if (typeof showApp === 'function') showApp('chat-screen'); } catch (_) {} };
        updateDockBadge();
        return;
      }

      const active = day ? schedule?.currentItem?.(day) : null;
      const next = day ? schedule?.nextItem?.(day) : null;
      summary.innerHTML = `<div class="eve-schedule-summary-top"><span class="eve-schedule-summary-character">${escapeHtml(current.name || '当前角色')}</span><span class="eve-schedule-summary-source">${escapeHtml(day?.source || '尚未生成')}</span></div><div class="eve-schedule-summary-current">${active ? `现在：<b>${escapeHtml(active.title)}</b>（${escapeHtml(active.start)}-${escapeHtml(active.end)}）` : next ? `下一项：<b>${escapeHtml(next.title)}</b>（${escapeHtml(next.start)}）` : day?.items?.length ? '当天行程已经结束' : '今天还没有行程'}</div>`;

      list.innerHTML = '';
      if (!day?.items?.length) {
        list.innerHTML = `<div class="eve-schedule-empty"><i class="fas fa-calendar-plus"></i>${dateLabel(viewDate)} 还没有行程<br><button class="eve-schedule-primary" data-empty-generate>生成行程</button></div>`;
        list.querySelector('[data-empty-generate]').onclick = generateViewedDay;
      } else {
        for (const item of day.items) {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = itemMarkup(item);
          const row = wrapper.firstElementChild;
          row.querySelector('[data-status]').onclick = () => cycleStatus(item);
          row.querySelector('[data-edit]').onclick = () => editItem(item);
          row.querySelector('[data-delete]').onclick = () => {
            if (!confirm(`删除“${item.title}”？`)) return;
            schedule.removeItem(item.id, { date: viewDate, scope: current.scope });
            render();
          };
          list.append(row);
        }
      }
      updateDockBadge();
    } finally { rendering = false; }
  }

  function updateDockBadge() {
    const badge = document.querySelector(`#${HOME_ID} [data-eve-schedule-badge]`);
    if (!badge) return;
    if (!hasCharacter() || !api()) { badge.style.display = 'none'; return; }
    const current = chat();
    const day = api().getDay?.({ date: currentDate(), scope: current.scope });
    const count = (day?.items || []).filter(item => ['planned', 'adjusted', 'active'].includes(item.status)).length;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.style.display = count ? 'block' : 'none';
  }

  function bindEvents() {
    ['eve:schedule-updated', 'eve:schedule-day-cleared', 'eve:schedule-generation-complete', 'eve:schedule-item-started', 'eve:environment-updated'].forEach(name => {
      on(window, name, () => {
        updateDockBadge();
        const screen = document.getElementById(SCREEN_ID);
        if (screen && screen.offsetParent !== null) render();
      });
    });
  }

  function getDiagnostics() {
    return {
      version: VERSION,
      initialized,
      homeIconInjected: Boolean(document.getElementById(HOME_ID)),
      screenInjected: Boolean(document.getElementById(SCREEN_ID)),
      currentDate: viewDate || currentDate(),
      chat: chat(),
      scheduleLoaded: Boolean(api())
    };
  }

  function init() {
    if (initialized) return Promise.resolve(getDiagnostics());
    initialized = true;
    injectStyle();
    const retry = setInterval(() => {
      const ready = injectHomeIcon() && injectScreen();
      if (ready) { clearInterval(retry); updateDockBadge(); }
    }, 400);
    setTimeout(() => clearInterval(retry), 30000);
    injectHomeIcon(); injectScreen(); bindEvents(); updateDockBadge();
    window.EVE ||= {}; window.EVE.scheduleApp = window.EVEScheduleApp;
    emit('eve:schedule-app-ready', getDiagnostics());
    return Promise.resolve(getDiagnostics());
  }
  function destroy() {
    disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} });
    document.getElementById(HOME_ID)?.remove();
    document.getElementById(SCREEN_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    initialized = false;
  }

  window.EVEScheduleApp = Object.freeze({
    version: VERSION, init, destroy, open, close, render, getDiagnostics
  });
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init, { once: true })
    : init();
})(window, document);
