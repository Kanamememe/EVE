/** XiaoYi character pack entry v1.2.0 */
(function (window, document) {
  'use strict';
  if (window.EVEXiaoYiPack?.version) return;
  const VERSION='1.2.0';
  const script=document.currentScript;
  const baseUrl=new URL('./',script?.src||document.baseURI);
  let registered=false;let profile=null;let examples={};let retryTimer=null;let loadingPromise=null;
  async function getJson(path){const response=await fetch(new URL(path,baseUrl).href,{cache:'no-store'});if(!response.ok)throw new Error(`${path}: HTTP ${response.status}`);return response.json()}
  async function loadData(){
    if(loadingPromise)return loadingPromise;
    const embedded=window.EVEXiaoYiEmbeddedData;
    if(embedded?.profile){profile=JSON.parse(JSON.stringify(embedded.profile));examples=JSON.parse(JSON.stringify(embedded.examples||{}));loadingPromise=Promise.resolve({profile,examples});return loadingPromise}
    loadingPromise=Promise.all([
      getJson('profile.json'),getJson('examples/chat.json'),getJson('examples/moments.json'),getJson('examples/moment-replies.json'),getJson('examples/racing.json'),getJson('examples/negative-examples.json')
    ]).then(([p,chat,moments,replies,racing,negative])=>{profile=p;examples={chat,moments,replies,racing,negative};return{profile,examples}});return loadingPromise
  }
  function extraContext(meta={}){
    const sections=[];
    const r1=window.EVEXiaoYiR1?.getPromptContext?.(meta);if(r1)sections.push(r1);
    const text=String(meta.userText||'');
    if (/母亲|抛弃|城堡|少管所|育达|实验|叶传|养父|季希|仓库|黑猫|伤口|过去/.test(text)) sections.push(['【萧逸面对过去的方式】','他的童年经历过抛弃、利用、少管所与人体实验等伤害，这些经历解释他的防御与掌控感，但不要让他主动长篇讲述创伤','他常用玩笑、轻描淡写或行动绕开被怜悯的位置；真正的脆弱应短暂、克制，只在最亲近的人面前露出缝隙','过去没有让他成为反派。他仍重视善意、公平与保护无辜的人'].join('\n'));
    if (/骗|欺骗|撒谎|隐瞒|背叛|不真诚/.test(text)) sections.push(['【真诚底线】','萧逸能包容夕月的笨拙和一时说不出口，但无法容忍故意欺骗与虚伪','察觉欺骗时，他会停止玩笑、恢复冷静和距离感，直接处理问题，不用夸张失控证明受伤'].join('\n'));
    return sections.join('\n\n')
  }
  function validate(text,meta){return window.EVEXiaoYiValidator?.validate?.(text,meta)||[]}
  function normalize(text,meta){return window.EVEXiaoYiPunctuation?.normalize?.(text,meta)??String(text??'')}
  async function register(){if(registered)return diagnostics();if(!window.EVERoleFidelity?.registerPack)return null;const data=await loadData();window.EVERoleFidelity.registerPack({id:'xiaoyi',profile:data.profile,examples:data.examples,getExtraContext:extraContext,validate,normalize});registered=true;window.dispatchEvent(new CustomEvent('eve:xiaoyi-pack-ready',{detail:diagnostics()}));return diagnostics()}
  function diagnostics(){return{version:VERSION,registered,profile:profile?{id:profile.id,name:profile.name,racingIdentity:profile.racingIdentity}:null,exampleCounts:Object.fromEntries(Object.entries(examples).map(([k,v])=>[k,Array.isArray(v)?v.length:0])),r1:Boolean(window.EVEXiaoYiR1),schedule:Boolean(window.EVEXiaoYiSchedule?.diagnostics?.().registered)}}
  async function init(){try{if(await register())return diagnostics()}catch(error){console.error('[EVEXiaoYiPack] 载入失败',error);window.dispatchEvent(new CustomEvent('eve:xiaoyi-pack-error',{detail:{error:String(error?.message||error)}}))}if(!retryTimer)retryTimer=setInterval(async()=>{try{if(await register()){clearInterval(retryTimer);retryTimer=null}}catch(_){}},700);return diagnostics()}
  function destroy(){if(retryTimer)clearInterval(retryTimer);retryTimer=null;if(registered)window.EVERoleFidelity?.unregisterPack?.('xiaoyi');registered=false}
  window.EVEXiaoYiPack=Object.freeze({version:VERSION,init,destroy,diagnostics,getProfile:()=>profile?JSON.parse(JSON.stringify(profile)):null,getExamples:()=>JSON.parse(JSON.stringify(examples)),baseUrl:baseUrl.href});
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init,{once:true}):init();
})(window,document);
