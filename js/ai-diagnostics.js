/** EVE Chat AI Limit Diagnostics v1.5.6 */
(function (window, document) {
  'use strict';
  if (window.EVEAIDiagnostics?.version) return;
  const VERSION = '1.5.6';
  const SETTINGS_KEY = 'eve_ai_diagnostics_settings_v1';
  const HISTORY_KEY = 'eve_ai_diagnostics_history_v1';
  const DEFAULTS = Object.freeze({ enabled:true, historyLimit:30, debug:false });
  let settings = readJson(SETTINGS_KEY, DEFAULTS);
  let history = readJson(HISTORY_KEY, { items:[] }).items || [];
  let initialized = false;
  let panel = null;
  const disposers = [];

  function readJson(key, fallback) { try { const value=JSON.parse(localStorage.getItem(key)||'null'); return value&&typeof value==='object'?Object.assign({},fallback,value):Object.assign({},fallback); } catch(_){ return Object.assign({},fallback); } }
  function clean(value,max=1000){return String(value??'').replace(/\s+/g,' ').trim().slice(0,max)}
  function clone(value){try{return window.structuredClone?window.structuredClone(value):JSON.parse(JSON.stringify(value))}catch(_){return value}}
  function emit(name,detail={}){try{window.dispatchEvent(new CustomEvent(name,{detail}))}catch(_){}}
  function on(target,name,handler,options){target.addEventListener(name,handler,options);disposers.push(()=>target.removeEventListener(name,handler,options))}
  function toast(message,type='success'){try{if(typeof showToast==='function')return showToast(message,type)}catch(_){}if(window.showToast)return window.showToast(message,type);console.log('[EVEAIDiagnostics]',message)}
  function configure(next={}){settings=Object.assign({},DEFAULTS,settings,next||{});settings.enabled=Boolean(settings.enabled);settings.debug=Boolean(settings.debug);settings.historyLimit=Math.max(5,Math.min(200,Number(settings.historyLimit)||30));localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));trim();emit('eve:ai-diagnostics-settings-updated',{settings:getSettings()});return getSettings()}
  function getSettings(){return Object.assign({},settings)}
  function persist(){try{localStorage.setItem(HISTORY_KEY,JSON.stringify({items:history}))}catch(_){}}
  function trim(){history=history.slice(0,settings.historyLimit);persist()}
  function ratingLabel(rating){if(!rating)return'';return `${rating.category||''}:${rating.probability||rating.probabilityScore||''}${rating.blocked?'(blocked)':''}`}
  function classify(item){
    if(item.networkError){
      const value=String(item.networkError||'');
      const cors=/load failed|failed to fetch|cors|network request failed/i.test(value);
      return{type:'network',label:cors?'浏览器网络／CORS请求失败':'网络或请求错误',severity:'error'};
    }
    if(item.status&&item.status>=400)return{type:'http',label:`HTTP ${item.status}`,severity:'error'};
    if(item.blockReason)return{type:'prompt-block',label:`Prompt被拦截：${item.blockReason}`,severity:'error'};
    if(String(item.finishReason).toUpperCase()==='SAFETY')return{type:'safety',label:'生成内容被安全机制截断',severity:'error'};
    if(item.error)return{type:'api-error',label:item.error.message||item.error.status||'API错误',severity:'error'};
    if(item.parseError)return{type:'parse',label:'回应解析失败',severity:'warning'};
    if(item.emptyResponse)return{type:'empty',label:'API成功但没有可显示文字',severity:'warning'};
    if(item.finishReason&& !['STOP','stop',''].includes(item.finishReason))return{type:'finish',label:`完成原因：${item.finishReason}`,severity:'warning'};
    return{type:'ok',label:'请求与回应正常',severity:'success'};
  }
  function add(raw){
    if(!settings.enabled)return null;
    const item=Object.assign({id:`diag_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,timestamp:Date.now()},clone(raw||{}));
    item.classification=classify(item);
    history.unshift(item);trim();emit('eve:ai-diagnostic-recorded',clone(item));if(settings.debug)console.log('[EVEAIDiagnostics]',item);return clone(item)
  }
  function getLatest(){return history.length?clone(history[0]):null}
  function getHistory(){return clone(history)}
  function clear(){history=[];persist();emit('eve:ai-diagnostics-cleared',{});return true}
  function formatSafety(list){return (list||[]).map(ratingLabel).filter(Boolean).join('，')||'未回传'}
  function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch])}
  function formatTime(timestamp){try{return new Date(timestamp).toLocaleString('zh-TW')}catch(_){return String(timestamp||'')}}
  function openPanel(){
    panel?.remove();const overlay=document.createElement('div');panel=overlay;overlay.id='eve-ai-diagnostics-panel';overlay.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:12px';
    const box=document.createElement('div');box.style.cssText='width:min(800px,100%);max-height:94vh;overflow:hidden;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:18px;display:flex;flex-direction:column;box-shadow:0 18px 60px #0006';
    box.innerHTML=`<div style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #ddd"><b style="flex:1">AI 限制诊断</b><button data-clear>清空</button><button data-close>✕</button></div><div data-list style="overflow:auto;min-height:260px"></div>`;overlay.append(box);document.body.append(overlay);
    const render=()=>{const list=box.querySelector('[data-list]');list.innerHTML='';if(!history.length){list.innerHTML='<div style="padding:55px;text-align:center;opacity:.6">还没有 AI 请求记录</div>';return}for(const item of history){const color=item.classification?.severity==='error'?'#d33':item.classification?.severity==='warning'?'#d58b00':'#28a745';const card=document.createElement('details');card.style.cssText='border-bottom:1px solid #ddd';card.innerHTML=`<summary style="cursor:pointer;padding:12px 15px;display:flex;gap:9px;align-items:center"><b style="color:${color};min-width:64px">${escapeHtml(item.classification?.type||'unknown')}</b><span style="flex:1">${escapeHtml(item.classification?.label||'')}</span><small>${escapeHtml(formatTime(item.timestamp))}</small></summary><div style="padding:0 15px 14px;font-size:13px;line-height:1.65"><div><b>模型：</b>${escapeHtml(item.model||'未知')}</div><div><b>请求地址：</b>${escapeHtml(item.url||'未记录')}</div><div><b>HTTP：</b>${escapeHtml(item.status||0)} / ${item.ok?'OK':'失败'}</div>${item.networkError?`<div><b>底层错误：</b>${escapeHtml(item.errorName?`${item.errorName}: ${item.networkError}`:item.networkError)}</div><div><b>浏览器联网状态：</b>${item.online===false?'离线':'在线或未知'}</div><div style="margin-top:6px;padding:8px;border-radius:8px;background:#d3313112">若 HTTP 为 0 且错误是 Load failed／Failed to fetch，通常代表请求在浏览器层被拦截，例如 CORS、DNS、TLS、内容拦截器或自定义请求头预检失败</div>`:''}<div><b>Prompt blockReason：</b>${escapeHtml(item.blockReason||'无')}</div><div><b>finishReason：</b>${escapeHtml(item.finishReason||'未回传')}</div><div><b>安全分类：</b>${escapeHtml(formatSafety(item.safetyRatings))}</div><div><b>Prompt安全分类：</b>${escapeHtml(formatSafety(item.promptSafetyRatings))}</div><div><b>文字长度：</b>${escapeHtml(item.textLength??0)}</div>${item.provider?`<div><b>服务商：</b>${escapeHtml(item.provider)}</div>`:''}${item.error?`<div><b>API错误：</b>${escapeHtml(JSON.stringify(item.error))}</div>`:''}${item.requestSummary?`<div><b>请求摘要：</b><pre style="white-space:pre-wrap;font-size:11px;background:#0001;padding:8px;border-radius:8px">${escapeHtml(JSON.stringify(item.requestSummary,null,2))}</pre></div>`:''}${item.parseError?`<div><b>解析错误：</b>${escapeHtml(item.parseError)}</div>`:''}<div><b>Safety Settings：</b><pre style="white-space:pre-wrap;font-size:11px;background:#0001;padding:8px;border-radius:8px">${escapeHtml(JSON.stringify(item.safetySettings||[],null,2))}</pre></div></div>`;list.append(card)}};
    box.querySelector('[data-close]').onclick=()=>overlay.remove();overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};box.querySelector('[data-clear]').onclick=()=>{if(confirm('清空AI诊断记录？')){clear();render()}};render()
  }
  function getDiagnostics(){return{version:VERSION,initialized,settings:getSettings(),records:history.length,latest:getLatest()}}
  function init(){if(initialized)return;initialized=true;on(window,'eve:ai-response-detail',event=>add(event.detail||{}));on(window,'eve:ai-error',event=>{const error=event.detail?.error;add({timestamp:Date.now(),url:event.detail?.url||'',networkError:clean(error?.message||error),errorName:clean(error?.name,120),online:typeof navigator!=='undefined'?navigator.onLine:undefined,status:0,ok:false})});on(window,'eve:provider-http-error',event=>{const d=event.detail||{};add({timestamp:d.timestamp||Date.now(),url:d.url||'',model:d.model||'',status:Number(d.status||400),ok:false,error:d.error||{message:d.message||'Provider request failed'},provider:d.provider||'',requestSummary:d.requestSummary||null})});on(window,'eve:provider-compat-retry',event=>{const d=event.detail||{};if(!d.recovered)add({timestamp:d.timestamp||Date.now(),url:d.url||'',status:Number(d.retryStatus||400),ok:false,error:{message:d.retryMessage||d.initialMessage||'兼容重试仍失败'},provider:d.provider||'',requestSummary:d.requestSummary||null})});window.EVE||={};window.EVE.aiDiagnostics=window.EVEAIDiagnostics;emit('eve:ai-diagnostics-ready',getDiagnostics())}
  function destroy(){disposers.splice(0).forEach(fn=>{try{fn()}catch(_){}});panel?.remove();panel=null;initialized=false}
  window.EVEAIDiagnostics=Object.freeze({version:VERSION,init,destroy,configure,getSettings,add,getLatest,getHistory,clear,openPanel,getDiagnostics});
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init,{once:true}):init();
})(window,document);
