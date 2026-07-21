/** EVE Chat Feature Settings UI v0.8.0 */
(function (window, document) {
  'use strict';
  if (window.EVEFeatureSettings?.version) return;
  const VERSION = '0.9.0';
  let initialized = false;
  let retryTimer = null;

  function toast(message, type = 'success') {
    try { if (typeof showToast === 'function') return showToast(message, type); } catch (_) {}
    if (window.showToast) return window.showToast(message, type);
    alert(message);
  }
  function module(name) { return window[name] || null; }
  function sectionByTitle(title) {
    return [...document.querySelectorAll('#api-chat-settings-screen .settings-section')]
      .find(section => section.querySelector('.section-title')?.textContent.trim() === title);
  }
  function switchMarkup(id, checked) {
    return `<label class="toggle-switch" onclick="event.stopPropagation()"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span class="toggle-slider"></span></label>`;
  }
  function row(label, description, rightHtml = '<i class="fas fa-chevron-right"></i>') {
    const element = document.createElement('div');
    element.className = 'setting-item';
    element.innerHTML = `<div class="setting-left"><div class="setting-label">${label}</div><div class="setting-desc">${description}</div></div><div class="setting-right">${rightHtml}</div>`;
    return element;
  }
  function createSection() {
    const section = document.createElement('div');
    section.className = 'settings-section';
    section.id = 'eve-extension-settings-section';
    section.innerHTML = `<div class="section-header"><i class="fas fa-puzzle-piece section-icon"></i><span class="section-title">EVE 扩展功能</span></div><div class="setting-card" data-eve-list></div>`;
    const card = section.querySelector('[data-eve-list]');

    const weather = row('实时天气增强', '使用真实城市的当地时间与天气，并提供给 AI', switchMarkup('eve-weather-toggle', module('EVEWeather')?.getSettings?.().enabled !== false));
    weather.onclick = event => { if (!event.target.closest('.toggle-switch')) openWeatherSettings(); };
    card.append(weather);

    const proactive = row('AI 主动聊天', '按固定或随机时间主动发言，可设置夜间勿扰', switchMarkup('eve-proactive-toggle', Boolean(module('EVEProactive')?.getSettings?.().enabled)));
    proactive.onclick = event => { if (!event.target.closest('.toggle-switch')) openProactiveSettings(); };
    card.append(proactive);

    const autoReply = row('自动回复我的消息', '发送消息后自动触发角色回复，可设置延迟', switchMarkup('eve-auto-reply-toggle', Boolean(module('EVEAdapter')?.getSettings?.().autoReplyEnabled)));
    autoReply.onclick = event => { if (!event.target.closest('.toggle-switch')) openAutoReplySettings(); };
    card.append(autoReply);

    const memory = row('扩展记忆', '提取重要资料并在相关对话中自动调用', switchMarkup('eve-memory-toggle', module('EVEMemory')?.getSettings?.().enabled !== false));
    memory.onclick = event => { if (!event.target.closest('.toggle-switch')) module('EVEMemory')?.openManager?.(); };
    card.append(memory);

    const timeline = row('共同时间线', '记录重要对话、主动消息与事件', switchMarkup('eve-timeline-toggle', module('EVETimeline')?.getSettings?.().enabled !== false));
    timeline.onclick = event => { if (!event.target.closest('.toggle-switch')) module('EVETimeline')?.openManager?.(); };
    card.append(timeline);

    const recall = row('消息撤回同步', '允许撤回角色消息，并同步清理关联记忆与时间线', switchMarkup('eve-recall-toggle', module('EVERecall')?.getSettings?.().enabled !== false));
    recall.onclick = event => { if (!event.target.closest('.toggle-switch')) openRecallSettings(); };
    card.append(recall);

    const stickers = row('表情包管理', '批量导入、分类、标签、收藏、搜索与删除');
    stickers.onclick = () => module('EVEStickers')?.openManager?.();
    card.append(stickers);

    const moments = row('动态回复增强', '修复角色评论回复与批量评论失败，保留原动态页面', switchMarkup('eve-moments-toggle', module('EVEMoments')?.getSettings?.().enabled !== false));
    moments.onclick = event => { if (!event.target.closest('.toggle-switch')) openMomentsSettings(); };
    card.append(moments);

    const notifications = row('后台通知', '新聊天消息与动态互动的浏览器通知', switchMarkup('eve-notifications-toggle', Boolean(module('EVENotifications')?.getSettings?.().enabled)));
    notifications.onclick = event => { if (!event.target.closest('.toggle-switch')) openNotificationSettings(); };
    card.append(notifications);

    const health = row('扩展功能健康检查', '检查模块载入、AI 接线、设置与错误状态');
    health.onclick = () => module('EVEHealth')?.openPanel?.();
    card.append(health);

    const other = sectionByTitle('其他设置');
    const container = document.querySelector('#api-chat-settings-screen .settings-container');
    if (other) other.before(section); else container?.append(section);
    bindSwitches();
    return section;
  }

  function bindSwitches() {
    const bind = (id, callback) => {
      const input = document.getElementById(id); if (!input || input.dataset.eveBound) return;
      input.dataset.eveBound = '1'; input.addEventListener('change', () => callback(input.checked));
    };
    bind('eve-weather-toggle', enabled => module('EVEWeather')?.configure?.({ enabled }));
    bind('eve-proactive-toggle', enabled => module('EVEProactive')?.configure?.({ enabled }));
    bind('eve-auto-reply-toggle', enabled => module('EVEAdapter')?.configure?.({ autoReplyEnabled:enabled }));
    bind('eve-memory-toggle', enabled => module('EVEMemory')?.configure?.({ enabled }));
    bind('eve-timeline-toggle', enabled => module('EVETimeline')?.configure?.({ enabled }));
    bind('eve-recall-toggle', enabled => module('EVERecall')?.configure?.({ enabled }));
    bind('eve-moments-toggle', enabled => module('EVEMoments')?.configure?.({ enabled }));
    bind('eve-notifications-toggle', async enabled => {
      const api = module('EVENotifications');
      if (!api) return;
      if (enabled && api.getPermission?.() !== 'granted') {
        const permission = await api.requestPermission?.();
        if (permission !== 'granted') {
          api.configure?.({ enabled:false });
          const input = document.getElementById('eve-notifications-toggle'); if (input) input.checked = false;
          return toast('未取得通知权限', 'error');
        }
      }
      api.configure?.({ enabled });
    });
  }

  function modal(title, content, onSave) {
    document.getElementById('eve-feature-modal')?.remove();
    const overlay = document.createElement('div'); overlay.id = 'eve-feature-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:14px';
    const panel = document.createElement('div'); panel.style.cssText = 'width:min(520px,100%);max-height:90vh;overflow:auto;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;box-shadow:0 15px 50px #0005';
    panel.innerHTML = `<div style="display:flex;padding:15px 17px;border-bottom:1px solid #ddd"><b style="flex:1">${title}</b><button data-close type="button">✕</button></div><div data-body style="padding:15px 17px"></div><div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 17px;border-top:1px solid #ddd"><button data-cancel type="button">取消</button><button data-save type="button" style="background:#4a84c1;color:#fff;border:0;border-radius:9px;padding:8px 18px">保存</button></div>`;
    panel.querySelector('[data-body]').append(content); overlay.append(panel); document.body.append(overlay);
    const close = () => overlay.remove(); panel.querySelector('[data-close]').onclick = close; panel.querySelector('[data-cancel]').onclick = close; overlay.onclick = event => { if (event.target === overlay) close(); };
    panel.querySelector('[data-save]').onclick = async () => { try { await onSave(content); close(); toast('设置已保存'); refreshToggles(); } catch (error) { console.error(error); toast(`保存失败：${error.message || error}`, 'error'); } };
    return overlay;
  }
  function field(label, control, description = '') {
    const wrap = document.createElement('label'); wrap.style.cssText = 'display:block;margin-bottom:14px';
    wrap.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${label}</div>`;
    wrap.append(control); if (description) wrap.insertAdjacentHTML('beforeend', `<div style="font-size:12px;opacity:.65;margin-top:4px">${description}</div>`); return wrap;
  }
  function numberInput(value, min, max) { const input = document.createElement('input'); input.type = 'number'; input.value = value; input.min = min; input.max = max; input.style.cssText = 'width:100%;box-sizing:border-box;padding:9px;border:1px solid #ccc;border-radius:9px'; return input; }
  function selectInput(value, options) { const select = document.createElement('select'); select.style.cssText = 'width:100%;padding:9px;border:1px solid #ccc;border-radius:9px'; select.innerHTML = options.map(([v,l]) => `<option value="${v}" ${v===value?'selected':''}>${l}</option>`).join(''); return select; }
  function checkbox(label, checked) { const wrap = document.createElement('label'); wrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin:10px 0'; wrap.innerHTML = `<input type="checkbox" ${checked?'checked':''}><span>${label}</span>`; return wrap; }

  function openWeatherSettings() {
    const api = module('EVEWeather'); if (!api) return toast('天气模块未载入', 'error'); const s = api.getSettings();
    const body = document.createElement('div');
    const refresh = numberInput(s.refreshMinutes,10,360), user = checkbox('注入使用者所在地天气',s.includeUser), character = checkbox('注入角色所在地天气',s.includeCharacter), prompt = checkbox('把天气与时间提供给 AI',s.promptEnabled);
    body.append(field('更新频率（分钟）',refresh,'城市在原有“现实感知 → 配置地点信息”中设置'),user,character,prompt);
    const button=document.createElement('button');button.type='button';button.textContent='立即更新天气';button.onclick=()=>api.refresh({force:true}).then(()=>toast('天气已更新')).catch(e=>toast(e.message,'error'));body.append(button);
    modal('实时天气增强',body,()=>api.configure({refreshMinutes:refresh.value,includeUser:user.querySelector('input').checked,includeCharacter:character.querySelector('input').checked,promptEnabled:prompt.querySelector('input').checked}));
  }
  function openProactiveSettings() {
    const api=module('EVEProactive');if(!api)return toast('主动聊天模块未载入','error');const s=api.getSettings(),body=document.createElement('div');
    const mode=selectInput(s.intervalMode,[['random','不定时'],['fixed','固定间隔']]),fixed=numberInput(s.fixedIntervalMinutes,5,10080),min=numberInput(s.randomMinMinutes,5,10080),max=numberInput(s.randomMaxMinutes,5,10080),idle=numberInput(s.idleRequiredMinutes,0,10080),daily=numberInput(s.dailyLimit,0,100),quietStart=numberInput(s.quietStartHour,0,23),quietEnd=numberInput(s.quietEndHour,0,23),onlyOpen=checkbox('只在角色聊天页面开启时触发',s.onlyWhenChatOpen),catchUp=checkbox('回到页面时补做已到期的触发',s.catchUpAfterResume);
    body.append(field('触发方式',mode),field('固定间隔（分钟）',fixed),field('随机最短间隔（分钟）',min),field('随机最长间隔（分钟）',max),field('至少闲置多久（分钟）',idle),field('每日最多主动消息',daily),field('勿扰开始小时（0-23）',quietStart),field('勿扰结束小时（0-23）',quietEnd),onlyOpen,catchUp);
    const test=document.createElement('button');test.type='button';test.textContent='立即测试主动消息';test.onclick=()=>api.triggerNow({force:true,immediate:true}).then(result=>toast(result?.sent===false?`未发送：${result.reason}`:'已触发测试',result?.sent===false?'error':'success'));body.append(test);
    modal('AI 主动聊天',body,()=>api.configure({intervalMode:mode.value,fixedIntervalMinutes:fixed.value,randomMinMinutes:min.value,randomMaxMinutes:max.value,idleRequiredMinutes:idle.value,dailyLimit:daily.value,quietStartHour:quietStart.value,quietEndHour:quietEnd.value,onlyWhenChatOpen:onlyOpen.querySelector('input').checked,catchUpAfterResume:catchUp.querySelector('input').checked}));
  }
  function openAutoReplySettings() {
    const api=module('EVEAdapter');if(!api)return toast('AI 适配模块未载入','error');const s=api.getSettings(),body=document.createElement('div'),delay=numberInput(s.autoReplyDelaySeconds,0,120);body.append(field('自动回复延迟（秒）',delay,'如果原本已经开始生成回复，扩展不会重复触发。'));modal('自动回复我的消息',body,()=>api.configure({autoReplyDelaySeconds:delay.value}));
  }
  function openRecallSettings() {
    const api=module('EVERecall');if(!api)return toast('撤回模块未载入','error');const s=api.getSettings(),body=document.createElement('div');
    const assistant=checkbox('允许撤回角色消息',s.allowAssistantRecall),memory=checkbox('同步删除扩展记忆',s.purgeExtensionMemory),timeline=checkbox('同步删除扩展时间线',s.purgeExtensionTimeline),native=checkbox('清理有来源消息 ID 的原生记忆',s.purgeNativeSourceLinkedMemory),fallback=checkbox('尝试用文本匹配旧记忆（可能误删，不建议）',s.nativeTextFallback);body.append(assistant,memory,timeline,native,fallback);modal('消息撤回同步',body,()=>api.configure({allowAssistantRecall:assistant.querySelector('input').checked,purgeExtensionMemory:memory.querySelector('input').checked,purgeExtensionTimeline:timeline.querySelector('input').checked,purgeNativeSourceLinkedMemory:native.querySelector('input').checked,nativeTextFallback:fallback.querySelector('input').checked}));
  }

  function openMomentsSettings() {
    const api=module('EVEMoments');if(!api)return toast('动态增强模块未载入','error');const s=api.getSettings(),body=document.createElement('div');
    const replies=checkbox('修复角色回复用户评论',s.repairReplies),batch=checkbox('批量评论失败时自动后备生成',s.repairBatchComments),style=checkbox('使用微信式评论区细节样式',s.wechatStyle),notify=checkbox('把动态互动发送给通知模块',s.notifyInteractions),fallback=checkbox('增强失败时回退到原生动态回复',s.fallbackToOriginal),retry=numberInput(s.retryCount,0,5),max=numberInput(s.maxBatchComments,1,8),chars=numberInput(s.replyMaxChars,20,300);
    body.append(replies,batch,style,notify,fallback,field('失败重试次数',retry),field('后备批量评论最多角色数',max),field('单条评论最长字符数',chars));
    const test=document.createElement('button');test.type='button';test.textContent='查看动态模块诊断';test.onclick=()=>{const report=api.getDiagnostics?.();prompt('动态模块诊断',JSON.stringify(report,null,2));};body.append(test);
    modal('动态回复增强',body,()=>api.configure({repairReplies:replies.querySelector('input').checked,repairBatchComments:batch.querySelector('input').checked,wechatStyle:style.querySelector('input').checked,notifyInteractions:notify.querySelector('input').checked,fallbackToOriginal:fallback.querySelector('input').checked,retryCount:retry.value,maxBatchComments:max.value,replyMaxChars:chars.value}));
  }
  function openNotificationSettings() {
    const api=module('EVENotifications');if(!api)return toast('通知模块未载入','error');const s=api.getSettings(),body=document.createElement('div');
    const chat=checkbox('聊天新消息通知',s.chatEnabled),moments=checkbox('动态评论与回复通知',s.momentEnabled),proactive=checkbox('主动聊天通知',s.proactiveEnabled),bridge=checkbox('桥接 EVE 原生通知事件',s.bridgeOriginal),preview=checkbox('显示通知内容预览',s.previewEnabled),hidden=checkbox('仅页面不在前台时通知',s.onlyWhenHidden),vibrate=checkbox('允许震动（浏览器支持时）',s.vibrate);
    body.append(chat,moments,proactive,bridge,preview,hidden,vibrate);
    const status=document.createElement('div');status.style.cssText='font-size:13px;margin:12px 0;opacity:.75';status.textContent=`当前权限：${api.getPermission?.() || '未知'}`;body.append(status);
    const permission=document.createElement('button');permission.type='button';permission.textContent='申请通知权限';permission.style.marginRight='8px';permission.onclick=async()=>{const result=await api.requestPermission?.();status.textContent=`当前权限：${result}`;toast(result==='granted'?'通知权限已开启':`通知权限：${result}`,result==='granted'?'success':'error');};body.append(permission);
    const test=document.createElement('button');test.type='button';test.textContent='发送测试通知';test.onclick=async()=>{const result=await api.test?.();toast(result?.shown?'测试通知已发送':`通知未发送：${result?.reason || '未知原因'}`,result?.shown?'success':'error');};body.append(test);
    modal('后台通知',body,()=>api.configure({chatEnabled:chat.querySelector('input').checked,momentEnabled:moments.querySelector('input').checked,proactiveEnabled:proactive.querySelector('input').checked,bridgeOriginal:bridge.querySelector('input').checked,previewEnabled:preview.querySelector('input').checked,onlyWhenHidden:hidden.querySelector('input').checked,vibrate:vibrate.querySelector('input').checked}));
  }

  function refreshToggles() {
    const map = {
      'eve-weather-toggle':module('EVEWeather')?.getSettings?.().enabled,
      'eve-proactive-toggle':module('EVEProactive')?.getSettings?.().enabled,
      'eve-auto-reply-toggle':module('EVEAdapter')?.getSettings?.().autoReplyEnabled,
      'eve-memory-toggle':module('EVEMemory')?.getSettings?.().enabled,
      'eve-timeline-toggle':module('EVETimeline')?.getSettings?.().enabled,
      'eve-recall-toggle':module('EVERecall')?.getSettings?.().enabled,
      'eve-moments-toggle':module('EVEMoments')?.getSettings?.().enabled,
      'eve-notifications-toggle':module('EVENotifications')?.getSettings?.().enabled
    };
    Object.entries(map).forEach(([id,value])=>{const input=document.getElementById(id);if(input)input.checked=Boolean(value)});
  }
  function inject() {
    if (document.getElementById('eve-extension-settings-section')) { refreshToggles(); return true; }
    const container = document.querySelector('#api-chat-settings-screen .settings-container');
    if (!container) return false;
    createSection(); refreshToggles(); return true;
  }
  function init() {
    if (initialized) return; initialized = true;
    if (!inject()) retryTimer = setInterval(() => { if (inject()) { clearInterval(retryTimer); retryTimer = null; } }, 1000);
    window.addEventListener('eve:weather-settings-updated',refreshToggles);window.addEventListener('eve:proactive-settings-updated',refreshToggles);window.addEventListener('eve:adapter-settings-updated',refreshToggles);window.addEventListener('eve:recall-settings-updated',refreshToggles);window.addEventListener('eve:moments-settings-updated',refreshToggles);window.addEventListener('eve:notification-settings-updated',refreshToggles);
  }
  function destroy() { clearInterval(retryTimer); document.getElementById('eve-extension-settings-section')?.remove(); document.getElementById('eve-feature-modal')?.remove(); initialized=false; }

  window.EVEFeatureSettings=Object.freeze({version:VERSION,init,destroy,inject,refresh:refreshToggles,openWeatherSettings,openProactiveSettings,openAutoReplySettings,openRecallSettings,openMomentsSettings,openNotificationSettings});
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init,{once:true}):init();
})(window,document);
