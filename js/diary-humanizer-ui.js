/** EVE Diary Humanizer UI v1.5.7 */
(function (window, document) {
  'use strict';
  const VERSION='1.5.7';
  if (window.EVEDiaryHumanizerUI?.version === VERSION) return;
  let observer=null;

  function clean(value,max=500){return String(value??'').replace(/\r\n?/g,'\n').trim().slice(0,max)}
  function reportReason(value){return /根据(?:今天|当天|现有|留下的)?记录|资料|系统|AI|场景状态|时间线|整理|生成过程/.test(String(value||''))}
  function parseCard(card){
    const meta=card.querySelector('.eve-diary-meta');
    const title=clean(card.querySelector('.eve-diary-title')?.textContent,120);
    const date=(meta?.textContent||'').match(/\d{4}-\d{2}-\d{2}/)?.[0]||'';
    const content=clean(card.querySelector('.eve-diary-body')?.childNodes?.[0]?.textContent||card.querySelector('.eve-diary-body')?.textContent,300);
    return {meta,title,date,content};
  }
  async function findEntry(card){
    const api=window.EVEDiary;
    if(!api?.list)return null;
    const info=parseCard(card);
    if(!info.date)return null;
    try{
      const entries=await api.list({date:info.date,limit:50});
      return entries.find(entry=>entry.title===info.title&&clean(entry.content,300)===info.content)
        || entries.find(entry=>entry.title===info.title)
        || null;
    }catch(_){return null}
  }
  async function patchCard(card){
    if(!card||card.dataset.eveDiaryUi===VERSION)return;
    const info=parseCard(card);
    const entry=await findEntry(card);
    const generated=entry&&(/^(?:ai|local-human-fallback)/.test(String(entry.source||'')));
    if(generated&&info.meta){
      info.meta.textContent=info.meta.textContent
        .replace(/\s*·\s*(?:AI整理|手写|角色书写)/g,'')
        .replace(/\s*·\s*·\s*/g,' · ')
        .trim();
      const actions=card.querySelector('.eve-diary-actions');
      if(actions&&!actions.querySelector('[data-rewrite-human]')){
        const button=document.createElement('button');
        button.type='button';button.dataset.rewriteHuman='1';button.textContent='重写';
        button.onclick=async()=>{
          button.disabled=true;
          try{
            await window.EVEDiary?.generate?.({date:entry.date,force:true});
            await window.EVEDiaryApp?.render?.();
          }catch(error){
            (window.showToast||window.alert)?.(error?.message||String(error),'error');
          }finally{button.disabled=false}
        };
        actions.prepend(button);
      }
    }
    const reason=card.querySelector('.eve-diary-reason');
    if(reason&&reportReason(reason.textContent)){
      const mood=(reason.textContent||'').match(/心情[：:]\s*([^·\n]+)/)?.[1]?.trim();
      if(mood)reason.textContent=`心情：${mood}`;else reason.remove();
    }
    card.dataset.eveDiaryUi=VERSION;
  }
  function patch(root=document){
    root.querySelectorAll?.('.eve-diary-card').forEach(card=>patchCard(card));
  }
  function install(){
    observer?.disconnect();
    observer=new MutationObserver(records=>{
      for(const record of records){
        for(const node of record.addedNodes||[]){
          if(node.nodeType!==1)continue;
          if(node.matches?.('.eve-diary-card'))patchCard(node);
          patch(node);
        }
      }
    });
    observer.observe(document.documentElement,{childList:true,subtree:true});
    patch();
    return true;
  }
  window.EVEDiaryHumanizerUI=Object.freeze({version:VERSION,install,patch});
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',install,{once:true}):install();
})(window,document);
