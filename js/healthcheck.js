/** EVE Chat Health Check v1.3.0 */
(function (window, document) {
  'use strict';
  if (window.EVEHealth?.version) return;
  const VERSION = '1.3.0';
  const errors = [];
  let initialized = false;

  function clean(value, max = 500) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
  function test(name, pass, detail = '', severity = 'error') { return { name, pass:Boolean(pass), detail:clean(detail), severity }; }
  function capture(type, reason) {
    errors.unshift({ type, message:clean(reason?.message || reason, 1000), stack:clean(reason?.stack, 2500), at:new Date().toISOString() });
    errors.splice(50);
  }
  function run() {
    const adapter = window.EVEAdapter;
    const diagnostics = adapter?.getDiagnostics?.() || null;
    const momentsDiagnostics = window.EVEMoments?.getDiagnostics?.() || null;
    const webIconDiagnostics = window.EVEWebIcon?.getDiagnostics?.() || null;
    const results = [
      test('index-dom', Boolean(document.getElementById('phone-screen') || document.getElementById('api-chat-screen')), 'EVE Chat 主界面'),
      test('adapter-loaded', Boolean(adapter), 'EVEAdapter'),
      test('adapter-fetch-hook', Boolean(diagnostics?.fetchHookInstalled), 'Gemini / API 背景注入', 'warning'),
      test('weather-loaded', Boolean(window.EVEWeather), 'EVEWeather'),
      test('proactive-loaded', Boolean(window.EVEProactive), 'EVEProactive'),
      test('memory-loaded', Boolean(window.EVEMemory), 'EVEMemory'),
      test('memory-inbox-loaded', Boolean(window.EVEMemoryInbox), JSON.stringify(window.EVEMemoryInbox?.getStats?.() || {}), 'warning'),
      test('memory-inbox-confirmation-mode', Boolean(!window.EVEMemoryInbox?.getSettings?.().confirmationMode || window.EVEMemory?.getSettings?.().autoExtract === false), JSON.stringify({ inbox:window.EVEMemoryInbox?.getSettings?.(), memory:window.EVEMemory?.getSettings?.() }), 'warning'),
      test('timeline-loaded', Boolean(window.EVETimeline), 'EVETimeline'),
      test('recall-loaded', Boolean(window.EVERecall), 'EVERecall'),
      test('stickers-loaded', Boolean(window.EVEStickers), 'EVEStickers'),
      test('moments-loaded', Boolean(window.EVEMoments), 'EVEMoments'),
      test('moments-hooks', Boolean(momentsDiagnostics?.hooks?.reply && momentsDiagnostics?.hooks?.batch && momentsDiagnostics?.hooks?.save && momentsDiagnostics?.hooks?.display), JSON.stringify(momentsDiagnostics?.hooks || {}), 'warning'),
      test('moments-threaded-replies', Boolean(window.EVEMoments?.replyToComment && momentsDiagnostics?.hooks?.save && momentsDiagnostics?.hooks?.display), JSON.stringify({ threadedReplies:momentsDiagnostics?.settings?.threadedReplies, showReplyButton:momentsDiagnostics?.settings?.showReplyButton }), 'warning'),
      test('notifications-loaded', Boolean(window.EVENotifications), 'EVENotifications'),
      test('notification-support', Boolean(window.EVENotifications?.getDiagnostics?.().supported), JSON.stringify(window.EVENotifications?.getDiagnostics?.() || {}), 'warning'),
      test('service-worker', Boolean(window.EVENotifications?.getDiagnostics?.().serviceWorkerRegistered), 'eve-sw.js', 'warning'),
      test('web-icon-loaded', Boolean(window.EVEWebIcon), 'EVEWebIcon'),
      test('web-icon-manager', Boolean(window.EVEWebIcon?.openManager && window.EVEWebIcon?.setFromFile && webIconDiagnostics), JSON.stringify(webIconDiagnostics || {}), 'warning'),
      test('role-fidelity-core', Boolean(window.EVERoleFidelity), 'EVERoleFidelity'),
      test('role-fidelity-adapter', Boolean((diagnostics?.contextProviders || []).includes('role-fidelity') && (diagnostics?.requestTransformers || []).includes('role-fidelity-sampling') && (diagnostics?.responseTransformers || []).includes('role-fidelity-output')), JSON.stringify({ context:diagnostics?.contextProviders, request:diagnostics?.requestTransformers, response:diagnostics?.responseTransformers }), 'warning'),
      test('xiaoyi-pack', Boolean(window.EVEXiaoYiPack?.diagnostics?.().registered), JSON.stringify(window.EVEXiaoYiPack?.diagnostics?.() || {}), 'warning'),
      test('xiaoyi-r1-live', Boolean(window.EVEXiaoYiR1), JSON.stringify(window.EVEXiaoYiR1?.getState?.() || {}), 'warning'),
      test('role-fidelity-ui', Boolean(document.getElementById('eve-role-fidelity-setting-item') || window.EVERoleFidelityUI), '角色贴合增强设置', 'warning'),
      test('settings-ui', Boolean(document.getElementById('eve-extension-settings-section')), '设置 → EVE 扩展功能', 'warning'),
      test('chat-input', Boolean(document.getElementById('api-chat-input')), '#api-chat-input'),
      test('smart-reply', Boolean(diagnostics?.smartReplyFunction || diagnostics?.smartReplyButton), '自动回复 / 主动聊天需要原生 triggerSmartReply', 'warning'),
      test('context-providers', Boolean((diagnostics?.contextProviders || []).includes('memory') && (diagnostics?.contextProviders || []).includes('timeline')), (diagnostics?.contextProviders || []).join(', '), 'warning'),
      test('recall-hooks', Boolean(window.EVERecall?.getDiagnostics?.().deleteHook && window.EVERecall?.getDiagnostics?.().internalHook), JSON.stringify(window.EVERecall?.getDiagnostics?.() || {}), 'warning'),
      test('sticker-upload-hook', Boolean(window.EVEStickers?.getStats?.().uploadHook), JSON.stringify(window.EVEStickers?.getStats?.() || {}), 'warning'),
      test('sticker-payload-repair', Boolean((diagnostics?.responseTransformers || []).includes('sticker-payload-fix') && window.EVEStickers?.repairAIResponseText), JSON.stringify(window.EVEStickers?.getStats?.() || {}), 'warning'),
      test('sticker-intelligence-loaded', Boolean(window.EVEStickerIntelligence), JSON.stringify(window.EVEStickerIntelligence?.getDiagnostics?.() || {}), 'warning'),
      test('sticker-intelligence-adapter', Boolean((diagnostics?.contextProviders || []).includes('sticker-intelligence') && (diagnostics?.responseTransformers || []).includes('sticker-intelligence-output')), JSON.stringify({ context:diagnostics?.contextProviders, response:diagnostics?.responseTransformers }), 'warning'),
      test('scene-state-loaded', Boolean(window.EVESceneState), JSON.stringify(window.EVESceneState?.getDiagnostics?.() || {}), 'warning'),
      test('scene-state-adapter', Boolean((diagnostics?.contextProviders || []).includes('scene-state')), (diagnostics?.contextProviders || []).join(', '), 'warning'),
      test('daily-schedule-loaded', Boolean(window.EVEDailySchedule), JSON.stringify(window.EVEDailySchedule?.getDiagnostics?.() || {}), 'warning'),
      test('daily-schedule-app', Boolean(window.EVEScheduleApp?.getDiagnostics?.().homeIconInjected && window.EVEScheduleApp?.getDiagnostics?.().screenInjected), JSON.stringify(window.EVEScheduleApp?.getDiagnostics?.() || {}), 'warning'),
      test('daily-schedule-adapter', Boolean((diagnostics?.contextProviders || []).includes('daily-schedule')), (diagnostics?.contextProviders || []).join(', '), 'warning'),
      test('xiaoyi-schedule-provider', Boolean(window.EVEXiaoYiSchedule?.diagnostics?.().registered), JSON.stringify(window.EVEXiaoYiSchedule?.diagnostics?.() || {}), 'warning'),
      test('ai-diagnostics-loaded', Boolean(window.EVEAIDiagnostics), JSON.stringify(window.EVEAIDiagnostics?.getDiagnostics?.() || {}), 'warning'),
      test('reply-context-loaded', Boolean(window.EVEReplyContext), JSON.stringify(window.EVEReplyContext?.getDiagnostics?.() || {}), 'warning'),
      test('reply-context-provider', Boolean((diagnostics?.contextProviders || []).includes('reply-context')), (diagnostics?.contextProviders || []).join(', '), 'warning'),
      test('reply-output-loaded', Boolean(window.EVEReplyOutput), JSON.stringify(window.EVEReplyOutput?.getDiagnostics?.() || {}), 'warning'),
      test('reply-output-repair', Boolean((diagnostics?.responseTransformers || []).includes('reply-output-fix') && (diagnostics?.contextProviders || []).includes('reply-output-format')), JSON.stringify({ response:diagnostics?.responseTransformers, context:diagnostics?.contextProviders }), 'warning')
    ];
    const hard = results.filter(item => !item.pass && item.severity === 'error');
    const warnings = results.filter(item => !item.pass && item.severity === 'warning');
    return {
      version:VERSION, ok:hard.length === 0, errors:hard.length, warnings:warnings.length,
      results, diagnostics, capturedErrors:errors.slice(), timestamp:new Date().toISOString()
    };
  }
  function print() {
    const report = run();
    const rows = report.results.map(item => ({ status:item.pass?'PASS':item.severity==='warning'?'WARN':'FAIL', test:item.name, detail:item.detail }));
    console.table?.(rows); if (!console.table) console.log(rows);
    console.log('[EVEHealth]', report); return report;
  }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]); }
  function openPanel() {
    document.getElementById('eve-health-panel')?.remove();
    const report = run(), overlay = document.createElement('div'); overlay.id='eve-health-panel';
    overlay.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:12px';
    const panel=document.createElement('div');panel.style.cssText='width:min(720px,100%);max-height:92vh;overflow:auto;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;box-shadow:0 15px 50px #0005';
    const rows=report.results.map(item=>`<div style="display:grid;grid-template-columns:54px 155px 1fr;gap:8px;padding:9px 14px;border-bottom:1px solid #ddd"><b style="color:${item.pass?'#28a745':item.severity==='warning'?'#d58b00':'#d33'}">${item.pass?'正常':item.severity==='warning'?'注意':'失败'}</b><span>${escapeHtml(item.name)}</span><small>${escapeHtml(item.detail)}</small></div>`).join('');
    const captured=report.capturedErrors.length?report.capturedErrors.slice(0,10).map(item=>`<div style="padding:7px 14px;border-bottom:1px solid #ddd"><b>${escapeHtml(item.type)}</b> ${escapeHtml(item.message)}<br><small>${escapeHtml(item.at)}</small></div>`).join(''):'<div style="padding:14px;opacity:.6">没有捕获到扩展错误</div>';
    panel.innerHTML=`<div style="display:flex;align-items:center;padding:15px 17px;border-bottom:1px solid #ddd"><b style="flex:1">EVE 扩展功能健康检查</b><span style="margin-right:10px;color:${report.ok?'#28a745':'#d33'}">${report.ok?'核心正常':'发现问题'}</span><button data-close>✕</button></div>${rows}<details><summary style="padding:12px 14px;cursor:pointer">最近错误记录（${report.capturedErrors.length}）</summary>${captured}</details><div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 14px"><button data-copy>复制诊断</button><button data-refresh>重新检查</button></div>`;
    overlay.append(panel);document.body.append(overlay);
    panel.querySelector('[data-close]').onclick=()=>overlay.remove();overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};
    panel.querySelector('[data-refresh]').onclick=()=>{overlay.remove();openPanel()};
    panel.querySelector('[data-copy]').onclick=async()=>{const text=JSON.stringify(report,null,2);try{await navigator.clipboard.writeText(text)}catch(_){prompt('复制诊断内容',text)}};
  }
  function init() {
    if (initialized) return; initialized=true;
    window.addEventListener('error',event=>capture('error',event.error||event.message));
    window.addEventListener('unhandledrejection',event=>capture('promise',event.reason));
    window.setTimeout(()=>window.dispatchEvent(new CustomEvent('eve:health-ready',{detail:run()})),1500);
  }
  window.EVEHealth=Object.freeze({version:VERSION,init,run,print,openPanel,getErrors:()=>errors.slice()});
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init,{once:true}):init();
})(window,document);
