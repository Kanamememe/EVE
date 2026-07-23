/**
 * EVE Daily Schedule Home App v1.3.0
 * Adds an independent home-screen icon and full schedule screen.
 */
(function (window, document) {
  'use strict';
  if (window.EVEDailyScheduleApp?.version) return;

  const VERSION = '1.3.0';
  const SCREEN_ID = 'eve-schedule-screen';
  const ICON_ID = 'eve-schedule-home-app';
  const STYLE_ID = 'eve-schedule-app-style';
  const disposers = [];
  let initialized = false;
  let selectedDate = '';

  function api() { return window.EVEDailySchedule || null; }
  function chat() { return window.EVEAdapter?.getCurrentChat?.() || { id:'', name:'角色行程', scope:'global', open:false }; }
  function clean(value, max = 500) { return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max); }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]); }
  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    if (window.showToast) return window.showToast(message, type);
    console.log('[EVEDailyScheduleApp]', message);
  }
  function emit(name, detail = {}) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} }
  function on(target, name, handler, options) { target.addEventListener(name, handler, options); disposers.push(() => target.removeEventListener(name, handler, options)); }
  function clock() {
    const native = api()?.getClock?.();
    if (native?.date) return native;
    const env = window.EVEWeather?.getEnvironment?.();
    const character = env?.character || env;
    if (character?.localDate) return { date:character.localDate, time:character.localTime || '', timezone:character.timezone || '' };
    const now = new Date();
    return {
      date:`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,
      time:`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`,
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    };
  }
  function shiftDate(value, amount) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Date(`${value}T12:00:00`) : new Date();
    date.setDate(date.getDate() + amount);
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }
  function displayDate(value) {
    try { return new Intl.DateTimeFormat('zh-CN', { month:'long', day:'numeric', weekday:'short' }).format(new Date(`${value}T12:00:00`)); }
    catch (_) { return value; }
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .home-section.top-right .eve-apps-grid-4{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:3px 9px;width:100%;height:100%;padding:1px;align-items:center}
      .home-section.top-right .eve-apps-grid-4 .mini-app{min-width:0;min-height:0;font-size:10px!important;line-height:1.1}
      .home-section.top-right .eve-apps-grid-4 .mini-app-icon{width:42px!important;height:42px!important;border-radius:13px!important;margin-bottom:2px}
      .home-section.top-right .eve-apps-grid-4 .mini-app-icon i{font-size:21px!important}
      .eve-home-app-badge{position:absolute;top:-4px;right:-6px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#ff3b30;color:#fff;font-size:10px;line-height:17px;text-align:center;font-weight:700;box-shadow:0 1px 4px #0005;display:none}
      #${ICON_ID} .mini-app-icon{position:relative}
      #${SCREEN_ID}{background:var(--body-bg,#fff)}
      #${SCREEN_ID} .eve-schedule-app-content{padding:0;overflow-y:auto;background:var(--color-gray-bg-light,#f7f7f8)}
      .eve-schedule-toolbar{display:flex;align-items:center;gap:8px;padding:12px 14px;background:var(--secondary-bg,#fff);border-bottom:1px solid var(--color-border,#eee);position:sticky;top:0;z-index:3}
      .eve-schedule-toolbar button{border:0;background:rgba(74,132,193,.12);color:#356b9f;border-radius:10px;padding:7px 10px;font-size:13px}
      .eve-schedule-toolbar .eve-schedule-date{flex:1;text-align:center;font-weight:700;font-size:15px}
      .eve-schedule-summary{margin:12px 12px 8px;padding:14px;border-radius:16px;background:linear-gradient(135deg,rgba(74,132,193,.16),rgba(255,255,255,.8));border:1px solid rgba(74,132,193,.15);box-shadow:0 4px 14px rgba(0,0,0,.05)}
      .eve-schedule-summary-title{display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:8px}
      .eve-schedule-summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .eve-schedule-summary-box{background:rgba(255,255,255,.72);border-radius:12px;padding:9px;min-width:0}
      .eve-schedule-summary-box small{display:block;opacity:.58;margin-bottom:3px}
      .eve-schedule-summary-box b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
      .eve-schedule-list{padding:4px 12px 94px}
      .eve-schedule-card{display:grid;grid-template-columns:62px 1fr auto;gap:10px;align-items:start;background:var(--secondary-bg,#fff);border-radius:14px;padding:12px;margin-bottom:9px;border:1px solid rgba(0,0,0,.06);box-shadow:0 3px 10px rgba(0,0,0,.04)}
      .eve-schedule-card.active{border-color:rgba(52,199,89,.45);box-shadow:0 3px 13px rgba(52,199,89,.12)}
      .eve-schedule-card.completed{opacity:.63}
      .eve-schedule-time{font-weight:800;color:#4a84c1;font-size:13px;line-height:1.45}
      .eve-schedule-card.active .eve-schedule-time{color:#28a745}
      .eve-schedule-title{font-weight:700;font-size:14px;margin-bottom:4px;word-break:break-word}
      .eve-schedule-desc{font-size:12px;line-height:1.45;opacity:.62;word-break:break-word}
      .eve-schedule-status{display:inline-block;margin-top:5px;border-radius:8px;padding:2px 7px;background:rgba(74,132,193,.1);font-size:10px;color:#4a84c1}
      .eve-schedule-card-actions{display:flex;flex-direction:column;gap:5px}
      .eve-schedule-card-actions button{border:0;border-radius:8px;padding:5px 7px;background:rgba(0,0,0,.055);font-size:11px;white-space:nowrap}
      .eve-schedule-empty{text-align:center;padding:70px 24px;color:#888}
      .eve-schedule-empty i{display:block;font-size:42px;margin-bottom:12px;color:#9bb8d3}
      .eve-schedule-bottom{position:absolute;left:0;right:0;bottom:0;height:62px;padding:8px 12px calc(8px + env(safe-area-inset-bottom));box-sizing:content-box;background:rgba(255,255,255,.93);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-top:1px solid rgba(0,0,0,.08);display:grid;grid-template-columns:repeat(3,1fr);gap:8px;z-index:12}
      .eve-schedule-bottom button{border:0;border-radius:12px;background:rgba(74,132,193,.1);color:#3f75aa;font-weight:600;font-size:12px}
      .eve-schedule-header-actions{position:absolute;right:19px;top:52px;transform:translateY(-50%);display:flex;gap:8px}
      .eve-schedule-header-actions button{border:0;background:transparent;font-size:17px;color:#333;padding:5px}
      body[data-theme="dark"] #${SCREEN_ID} .eve-schedule-app-content{background:#1a1a1a}
      body[data-theme="dark"] .eve-schedule-card,body[data-theme="dark"] .eve-schedule-summary,body[data-theme="dark"] .eve-schedule-toolbar{background:#292929;color:#eee;border-color:#444}
      body[data-theme="dark"] .eve-schedule-summary-box{background:#333}
      body[data-theme="dark"] .eve-schedule-bottom{background:rgba(30,30,30,.94);border-color:#444}
      body[data-theme="dark"] .eve-schedule-header-actions button{color:#fff}
    `;
    document.head.appendChild(style);
  }

  function ensureHomeIcon() {
    if (document.getElementById(ICON_ID)) return true;
    const grid = document.querySelector('.home-section.top-right .apps-grid-2, .home-section.top-right .apps-grid, .home-section.top-right .eve-apps-grid-4');
    if (!grid) return false;
    grid.classList.remove('apps-grid-2', 'apps-grid');
    grid.classList.add('eve-apps-grid-4');
    const link = document.createElement('a');
    link.href = '#'; link.className = 'mini-app'; link.id = ICON_ID;
    link.innerHTML = '<div class="mini-app-icon"><i class="fas fa-calendar-alt"></i><span class="eve-home-app-badge" data-badge></span></div><span>行程</span>';
    link.addEventListener('click', event => { event.preventDefault(); open(); });
    grid.appendChild(link); updateBadge(); return true;
  }
  function statusBarMarkup() {
    return `<div class="app-status-bar"><div class="app-status-time"></div><div class="app-status-right"><div class="app-signal-icon signal-icon"><div class="signal-row"><div class="signal-bar"></div><div class="signal-bar"></div><div class="signal-bar"></div><div class="signal-bar"></div></div></div><div class="app-battery-container"><div class="app-battery-icon"><div class="app-battery-level"></div></div></div></div></div>`;
  }
  function ensureScreen() {
    if (document.getElementById(SCREEN_ID)) return true;
    const wallpaper = document.querySelector('#phone-screen .wallpaper') || document.getElementById('phone-screen');
    if (!wallpaper) return false;
    const screen = document.createElement('div'); screen.id = SCREEN_ID; screen.className = 'app-screen';
    screen.innerHTML = `<div class="app-top-container">${statusBarMarkup()}<div class="app-header"><button class="back-button" data-back>‹</button><div class="app-title">角色行程</div><div class="eve-schedule-header-actions"><button data-refresh title="重新生成"><i class="fas fa-sync-alt"></i></button><button data-add title="添加行程"><i class="fas fa-plus"></i></button></div></div></div><div class="app-content eve-schedule-app-content"><div class="eve-schedule-toolbar"><button data-prev>‹</button><button data-today>今天</button><div class="eve-schedule-date" data-date></div><button data-next>›</button></div><div class="eve-schedule-summary" data-summary></div><div class="eve-schedule-list" data-list></div></div><div class="eve-schedule-bottom"><button data-generate><i class="fas fa-magic"></i><br>生成行程</button><button data-manage><i class="fas fa-list"></i><br>详细管理</button><button data-settings><i class="fas fa-sliders-h"></i><br>行程设置</button></div>`;
    wallpaper.appendChild(screen);
    screen.querySelector('[data-back]').onclick = close;
    screen.querySelector('[data-prev]').onclick = () => { selectedDate = shiftDate(selectedDate, -1); render(); };
    screen.querySelector('[data-next]').onclick = () => { selectedDate = shiftDate(selectedDate, 1); render(); };
    screen.querySelector('[data-today]').onclick = () => { selectedDate = clock().date; render(); };
    screen.querySelector('[data-refresh]').onclick = () => generate(true);
    screen.querySelector('[data-generate]').onclick = () => generate(true);
    screen.querySelector('[data-add]').onclick = addManual;
    screen.querySelector('[data-manage]').onclick = () => api()?.openManager?.();
    screen.querySelector('[data-settings]').onclick = () => api()?.openSettings?.();
    return true;
  }
  function close() {
    try { if (typeof hideApp === 'function') return hideApp(SCREEN_ID); } catch (_) {}
    const screen = document.getElementById(SCREEN_ID); if (screen) screen.style.display = 'none';
  }
  function open() {
    if (!ensureScreen()) return toast('行程界面尚未准备好', 'error');
    selectedDate = selectedDate || clock().date;
    try { if (typeof showApp === 'function') showApp(SCREEN_ID); else document.getElementById(SCREEN_ID).style.display = 'flex'; }
    catch (_) { document.getElementById(SCREEN_ID).style.display = 'flex'; }
    render(); emit('eve:schedule-app-opened', { date:selectedDate, chat:chat() });
  }
  function editItem(item) {
    const schedule = api(); if (!schedule) return;
    const title = prompt('行程标题', item.title); if (title === null) return;
    const start = prompt('开始时间 HH:MM', item.start); if (start === null) return;
    const end = prompt('结束时间 HH:MM', item.end); if (end === null) return;
    const description = prompt('说明', item.description || ''); if (description === null) return;
    schedule.updateItem(item.id, { title:clean(title,100), start:clean(start,5), end:clean(end,5), description:clean(description,500) }, { date:selectedDate });
    render();
  }
  function addManual() {
    const schedule = api(); if (!schedule) return toast('行程模块未载入', 'error');
    const title = prompt('行程标题'); if (!title) return;
    const start = prompt('开始时间 HH:MM', '19:00'); if (start === null) return;
    const end = prompt('结束时间 HH:MM', '20:00'); if (end === null) return;
    const description = prompt('说明（可留空）', '') ?? '';
    schedule.addItem({ title:clean(title,100), start:clean(start,5), end:clean(end,5), description:clean(description,500), locked:true }, { date:selectedDate });
    render(); toast('已添加行程');
  }
  async function generate(force) {
    const schedule = api(); if (!schedule) return toast('行程模块未载入', 'error');
    const button = document.querySelector(`#${SCREEN_ID} [data-generate]`);
    try {
      if (button) button.disabled = true;
      await schedule.generateDay({ date:selectedDate || clock().date, force:Boolean(force), fullDay:schedule.getSettings?.().mode !== 'on-demand' });
      render(); toast('行程已生成');
    } catch (error) { toast(error?.message || String(error), 'error'); }
    finally { if (button) button.disabled = false; }
  }
  function renderSummary(day) {
    const box = document.querySelector(`#${SCREEN_ID} [data-summary]`); if (!box) return;
    const currentClock = clock(); const currentChat = chat(); const isToday = selectedDate === currentClock.date;
    const current = isToday && day ? api()?.currentItem?.(day) : null;
    const next = isToday && day ? api()?.nextItem?.(day) : day?.items?.find(item => ['planned','adjusted'].includes(item.status));
    box.innerHTML = `<div class="eve-schedule-summary-title"><i class="fas fa-user-clock"></i><span>${escapeHtml(currentChat.name || '当前角色')}</span><small style="margin-left:auto;opacity:.58;font-weight:400">${escapeHtml(day?.timezone || currentClock.timezone || '')}</small></div><div class="eve-schedule-summary-grid"><div class="eve-schedule-summary-box"><small>${isToday ? '当前安排' : '首项安排'}</small><b>${escapeHtml(current?.title || day?.items?.[0]?.title || '暂无')}</b></div><div class="eve-schedule-summary-box"><small>${isToday ? '下一项' : '共计'}</small><b>${escapeHtml(isToday ? (next ? `${next.start} ${next.title}` : '今天已无安排') : `${day?.items?.length || 0} 项行程`)}</b></div></div>`;
  }
  function render() {
    ensureHomeIcon(); ensureScreen();
    const schedule = api(); const currentClock = clock(); selectedDate = selectedDate || currentClock.date;
    const screen = document.getElementById(SCREEN_ID); if (!screen) return;
    screen.querySelector('[data-date]').textContent = displayDate(selectedDate);
    const day = schedule?.getDay?.({ date:selectedDate }) || null; renderSummary(day);
    const list = screen.querySelector('[data-list]'); list.innerHTML = '';
    if (!schedule) { list.innerHTML = '<div class="eve-schedule-empty"><i class="fas fa-exclamation-circle"></i>行程模块未载入</div>'; return; }
    if (!chat().id && !chat().name) { list.innerHTML = '<div class="eve-schedule-empty"><i class="fas fa-comment-dots"></i>请先打开一个角色聊天室<br><small>行程会按角色分别保存</small></div>'; return; }
    if (!day?.items?.length) { list.innerHTML = '<div class="eve-schedule-empty"><i class="far fa-calendar-plus"></i>这一天还没有行程<br><small>点击下方“生成行程”或右上角＋手动添加</small></div>'; updateBadge(); return; }
    const labels = { planned:'计划中', active:'进行中', completed:'已完成', adjusted:'已调整', cancelled:'已取消', missed:'错过' };
    day.items.forEach(item => {
      const card = document.createElement('div'); card.className = `eve-schedule-card ${item.status || ''}`;
      card.innerHTML = `<div class="eve-schedule-time">${escapeHtml(item.start)}<br><span style="opacity:.5;font-weight:500">${escapeHtml(item.end)}</span></div><div><div class="eve-schedule-title">${escapeHtml(item.title)}${item.locked ? ' 🔒' : ''}${item.private ? ' 🔐' : ''}</div><div class="eve-schedule-desc">${escapeHtml(item.description || item.type || '')}</div><span class="eve-schedule-status">${escapeHtml(labels[item.status] || item.status)}</span></div><div class="eve-schedule-card-actions"><button data-edit>编辑</button><button data-done>${item.status === 'completed' ? '恢复' : '完成'}</button><button data-lock>${item.locked ? '解锁' : '锁定'}</button><button data-delete style="color:#c33">删除</button></div>`;
      card.querySelector('[data-edit]').onclick = () => editItem(item);
      card.querySelector('[data-done]').onclick = () => { schedule.updateItem(item.id, { status:item.status === 'completed' ? 'planned' : 'completed', completedAt:item.status === 'completed' ? 0 : Date.now() }, { date:selectedDate }); render(); };
      card.querySelector('[data-lock]').onclick = () => { schedule.updateItem(item.id, { locked:!item.locked }, { date:selectedDate }); render(); };
      card.querySelector('[data-delete]').onclick = () => { if (confirm(`删除“${item.title}”？`)) { schedule.removeItem(item.id, { date:selectedDate }); render(); } };
      list.appendChild(card);
    });
    updateBadge();
  }
  function updateBadge() {
    const badge = document.querySelector(`#${ICON_ID} [data-badge]`); if (!badge) return;
    const day = api()?.getDay?.({ date:clock().date });
    const count = (day?.items || []).filter(item => ['planned','active','adjusted'].includes(item.status)).length;
    badge.textContent = count > 99 ? '99+' : String(count); badge.style.display = count ? 'block' : 'none';
  }
  function getDiagnostics() { return { version:VERSION, initialized, icon:Boolean(document.getElementById(ICON_ID)), screen:Boolean(document.getElementById(SCREEN_ID)), selectedDate, scheduleLoaded:Boolean(api()) }; }
  function init() {
    if (initialized) return Promise.resolve(getDiagnostics());
    initialized = true; ensureStyle();
    const retry = setInterval(() => { const icon=ensureHomeIcon(), screen=ensureScreen(); if (icon && screen) clearInterval(retry); }, 500);
    setTimeout(() => clearInterval(retry), 30000); ensureHomeIcon(); ensureScreen();
    on(window, 'eve:schedule-updated', () => { updateBadge(); if (document.getElementById(SCREEN_ID)?.style.display === 'flex') render(); });
    on(window, 'eve:schedule-day-cleared', () => { updateBadge(); render(); });
    on(window, 'eve:schedule-item-started', () => { updateBadge(); render(); });
    on(window, 'eve:schedule-ready', () => { updateBadge(); render(); });
    on(window, 'eve:adapter-ready', updateBadge);
    window.EVE ||= {}; window.EVE.dailyScheduleApp = window.EVEDailyScheduleApp;
    emit('eve:schedule-app-ready', getDiagnostics()); return Promise.resolve(getDiagnostics());
  }
  function destroy() {
    disposers.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} });
    document.getElementById(ICON_ID)?.remove(); document.getElementById(SCREEN_ID)?.remove(); document.getElementById(STYLE_ID)?.remove(); initialized = false;
  }

  window.EVEDailyScheduleApp = Object.freeze({ version:VERSION, init, destroy, open, close, render, updateBadge, getDiagnostics });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once:true }) : init();
})(window, document);
