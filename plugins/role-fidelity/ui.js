/** EVE Role Fidelity UI v1.1.0 */
(function (window, document) {
  'use strict';
  if (window.EVERoleFidelityUI?.version) return;
  const VERSION = '1.1.0';
  let initialized = false;
  let retryTimer = null;

  function rf() { return window.EVERoleFidelity; }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]); }
  function toast(text, type='success') { if (typeof window.showToast === 'function') window.showToast(text, type); else alert(text); }
  function currentChat() { return window.EVEAdapter?.getCurrentChat?.() || { id:'', name:'', title:'', open:false }; }

  function addStyles() {
    if (document.getElementById('eve-role-fidelity-style')) return;
    const style = document.createElement('style'); style.id='eve-role-fidelity-style';
    style.textContent = `
      #eve-role-fidelity-modal{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:10px}
      #eve-role-fidelity-modal .rf-panel{width:min(760px,100%);max-height:94vh;overflow:auto;background:var(--secondary-bg,#fff);color:var(--text-primary,#222);border-radius:20px;box-shadow:0 18px 60px #0005}
      #eve-role-fidelity-modal .rf-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;padding:15px 17px;border-bottom:1px solid rgba(0,0,0,.09);background:var(--secondary-bg,#fff)}
      #eve-role-fidelity-modal .rf-title{flex:1;font-size:17px;font-weight:700}
      #eve-role-fidelity-modal .rf-close{border:0;background:transparent;font-size:20px;cursor:pointer}
      #eve-role-fidelity-modal .rf-body{padding:13px}
      #eve-role-fidelity-modal .rf-card{border:1px solid rgba(0,0,0,.1);border-radius:14px;margin-bottom:12px;overflow:hidden;background:rgba(127,127,127,.035)}
      #eve-role-fidelity-modal .rf-card h3{font-size:15px;margin:0;padding:12px 14px;border-bottom:1px solid rgba(0,0,0,.08)}
      #eve-role-fidelity-modal .rf-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(150px,44%);gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid rgba(0,0,0,.055)}
      #eve-role-fidelity-modal .rf-row:last-child{border-bottom:0}
      #eve-role-fidelity-modal .rf-label b{display:block;font-size:14px}.rf-label small{opacity:.65;line-height:1.4}
      #eve-role-fidelity-modal input[type=text],#eve-role-fidelity-modal input[type=number],#eve-role-fidelity-modal select,#eve-role-fidelity-modal textarea{width:100%;box-sizing:border-box;border:1px solid rgba(0,0,0,.16);border-radius:9px;background:var(--secondary-bg,#fff);color:inherit;padding:8px;font:inherit}
      #eve-role-fidelity-modal textarea{min-height:90px;resize:vertical;line-height:1.5}
      #eve-role-fidelity-modal .rf-actions{display:flex;flex-wrap:wrap;gap:8px;padding:11px 14px}
      #eve-role-fidelity-modal button.rf-btn{border:0;border-radius:10px;padding:9px 13px;background:#4a84c1;color:#fff;cursor:pointer;font-weight:600}
      #eve-role-fidelity-modal button.rf-btn.secondary{background:rgba(127,127,127,.15);color:inherit}
      #eve-role-fidelity-modal button.rf-btn.danger{background:#d9534f}
      #eve-role-fidelity-modal .rf-status{font-size:12px;line-height:1.55;padding:9px 14px;background:rgba(74,132,193,.08);white-space:pre-wrap}
      #eve-role-fidelity-modal .rf-two{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px 14px}
      #eve-role-fidelity-modal .rf-field label{display:block;font-size:12px;font-weight:650;margin-bottom:5px}
      #eve-role-fidelity-modal .rf-full{grid-column:1/-1}
      @media(max-width:560px){#eve-role-fidelity-modal .rf-row{grid-template-columns:1fr}#eve-role-fidelity-modal .rf-two{grid-template-columns:1fr}}
      body[data-theme=dark] #eve-role-fidelity-modal .rf-head{background:#222}
    `;
    document.head.appendChild(style);
  }

  function settingsItem() {
    const item = document.createElement('div');
    item.id='eve-role-fidelity-setting-item'; item.className='setting-item';
    item.innerHTML=`<div class="setting-left"><div class="setting-label">角色贴合增强</div><div class="setting-desc">通用角色档案与萧逸专属深度模块</div></div><div class="setting-right"><button type="button" class="rf-open-setting" style="border:0;background:rgba(74,132,193,.12);color:#4a84c1;border-radius:10px;padding:7px 11px">设置</button></div>`;
    item.querySelector('button').onclick=openManager;
    return item;
  }
  function injectSetting() {
    if (document.getElementById('eve-role-fidelity-setting-item')) return true;
    const section = document.getElementById('eve-extension-settings-section');
    if (section) {
      const holder = section.querySelector('.settings-list,.settings-section-content,.settings-group') || section;
      holder.appendChild(settingsItem()); return true;
    }
    const container = document.querySelector('#api-chat-settings-screen .settings-container');
    if (!container) return false;
    const wrap=document.createElement('div');wrap.className='settings-section';wrap.id='eve-role-fidelity-standalone-section';
    wrap.innerHTML='<div class="section-header"><h3>角色贴合</h3></div>';
    wrap.appendChild(settingsItem());container.appendChild(wrap);return true;
  }

  function profileOptions(selected) {
    const options = ['<option value="">不绑定专属档案</option>'];
    for (const profile of rf()?.listProfiles?.() || []) options.push(`<option value="${escapeHtml(profile.id)}" ${selected===profile.id?'selected':''}>${escapeHtml(profile.name)}${profile.builtin?'（内置）':''}</option>`);
    return options.join('');
  }

  function modalHtml() {
    const api=rf(); const settings=api?.getSettings?.() || {}; const chat=currentChat(); const binding=chat.id ? api?.getBinding?.(chat.id) : '';
    const diagnostics=api?.diagnostics?.() || {};
    return `<div class="rf-panel" role="dialog" aria-modal="true">
      <div class="rf-head"><div class="rf-title">角色贴合增强</div><button class="rf-close" data-close>✕</button></div>
      <div class="rf-body">
        <div class="rf-card"><h3>当前角色</h3>
          <div class="rf-status">聊天角色：${escapeHtml(chat.name || chat.title || '尚未打开角色聊天')}\n角色ID：${escapeHtml(chat.id || '无')}\n当前识别：${escapeHtml(diagnostics.activeProfile?.name || '未启用角色档案')} ${diagnostics.activeProfile?.reason?`（${escapeHtml(diagnostics.activeProfile.reason)}）`:''}</div>
          <div class="rf-row"><div class="rf-label"><b>绑定角色档案</b><small>按角色ID绑定，不会污染其他角色</small></div><select id="rf-bind-profile">${profileOptions(binding)}</select></div>
          <div class="rf-actions"><button class="rf-btn" data-bind ${chat.id?'':'disabled'}>保存绑定</button><button class="rf-btn secondary" data-export-active>导出当前档案</button></div>
        </div>

        <div class="rf-card"><h3>通用引擎</h3>
          <div class="rf-row"><div class="rf-label"><b>启用角色贴合</b></div><input id="rf-enabled" type="checkbox" ${settings.enabled?'checked':''}></div>
          <div class="rf-row"><div class="rf-label"><b>自动匹配角色名称</b><small>绑定优先，自动匹配只作后备</small></div><input id="rf-auto-match" type="checkbox" ${settings.autoMatch?'checked':''}></div>
          <div class="rf-row"><div class="rf-label"><b>贴合强度</b></div><select id="rf-strictness"><option value="normal" ${settings.strictness==='normal'?'selected':''}>普通</option><option value="strict" ${settings.strictness==='strict'?'selected':''}>严格</option><option value="extreme" ${settings.strictness==='extreme'?'selected':''}>极严格</option></select></div>
          <div class="rf-row"><div class="rf-label"><b>程序修正语言格式</b><small>例如按角色习惯处理句尾标点</small></div><input id="rf-normalize" type="checkbox" ${settings.normalizeOutput?'checked':''}></div>
          <div class="rf-row"><div class="rf-label"><b>本地OOC检测</b><small>不额外调用API，只记录明显偏差</small></div><input id="rf-ooc" type="checkbox" ${settings.detectOoc?'checked':''}></div>
          <div class="rf-row"><div class="rf-label"><b>使用角色推荐生成参数</b><small>萧逸专属档案会降低过高温度</small></div><input id="rf-tune" type="checkbox" ${settings.tuneGeneration?'checked':''}></div>
          <div class="rf-row"><div class="rf-label"><b>每轮参考示例数</b></div><input id="rf-example-limit" type="number" min="0" max="10" value="${Number(settings.exampleLimit)||4}"></div>
          <div class="rf-actions"><button class="rf-btn" data-save-settings>保存通用设置</button><button class="rf-btn secondary" data-diagnostics>查看诊断</button></div>
        </div>

        <div class="rf-card" id="rf-xiaoyi-card" style="display:${(rf()?.listProfiles?.()||[]).some(x=>x.id==='xiaoyi')?'block':'none'}"><h3>萧逸专属模块</h3>
          <div class="rf-status">内置：萧逸・夕月专属版\n包含深层性格逻辑、聊天／动态分场景语言、R1五冠王职业层与句尾标点规则</div>
          <div class="rf-actions"><button class="rf-btn secondary" data-r1-settings>R1实时赛事设置</button><button class="rf-btn secondary" data-xiaoyi-summary>查看萧逸档案摘要</button></div>
        </div>

        <div class="rf-card"><h3>创建通用角色档案</h3>
          <div class="rf-two">
            <div class="rf-field"><label>角色名称</label><input id="rf-custom-name" type="text" placeholder="例如：某个角色"></div>
            <div class="rf-field"><label>别名（逗号分隔）</label><input id="rf-custom-aliases" type="text" placeholder="英文名、昵称"></div>
            <div class="rf-field rf-full"><label>角色核心与背景</label><textarea id="rf-custom-core" placeholder="粘贴角色人设、性格和重要经历"></textarea></div>
            <div class="rf-field rf-full"><label>语言习惯</label><textarea id="rf-custom-speech" placeholder="例如：短消息、少用句号、会反问"></textarea></div>
            <div class="rf-field rf-full"><label>与使用者的关系</label><textarea id="rf-custom-relationship" placeholder="固定关系设定"></textarea></div>
            <div class="rf-field rf-full"><label>禁止偏差（每行一条）</label><textarea id="rf-custom-forbidden" placeholder="心理咨询师式回复\n无条件顺从"></textarea></div>
          </div>
          <div class="rf-actions"><button class="rf-btn" data-create-profile>保存通用档案</button><button class="rf-btn secondary" data-import-profile>导入JSON</button></div>
        </div>
      </div>
    </div>`;
  }

  function openManager() {
    if (!rf()) return toast('角色贴合引擎尚未载入','error');
    addStyles(); document.getElementById('eve-role-fidelity-modal')?.remove();
    const overlay=document.createElement('div');overlay.id='eve-role-fidelity-modal';overlay.innerHTML=modalHtml();document.body.appendChild(overlay);
    const close=()=>overlay.remove(); overlay.querySelector('[data-close]').onclick=close; overlay.onclick=e=>{if(e.target===overlay)close()};
    overlay.querySelector('[data-bind]').onclick=()=>{const chat=currentChat();if(!chat.id)return toast('请先打开一个角色聊天','error');const value=overlay.querySelector('#rf-bind-profile').value;rf().bindProfile(chat.id,value||null);toast(value?'角色档案已绑定':'已取消绑定');close();openManager()};
    overlay.querySelector('[data-save-settings]').onclick=()=>{rf().configure({enabled:overlay.querySelector('#rf-enabled').checked,autoMatch:overlay.querySelector('#rf-auto-match').checked,strictness:overlay.querySelector('#rf-strictness').value,normalizeOutput:overlay.querySelector('#rf-normalize').checked,detectOoc:overlay.querySelector('#rf-ooc').checked,tuneGeneration:overlay.querySelector('#rf-tune').checked,exampleLimit:Number(overlay.querySelector('#rf-example-limit').value)||4});toast('角色贴合设置已保存');};
    overlay.querySelector('[data-diagnostics]').onclick=()=>{const text=JSON.stringify(rf().diagnostics(),null,2);navigator.clipboard?.writeText(text).then(()=>toast('诊断已复制')).catch(()=>prompt('诊断内容',text));};
    overlay.querySelector('[data-export-active]').onclick=()=>{const active=rf().resolveActive();if(!active)return toast('当前没有启用角色档案','error');downloadText(`${active.id}-role-profile.json`,rf().exportProfile(active.id));};
    overlay.querySelector('[data-create-profile]').onclick=()=>{const name=overlay.querySelector('#rf-custom-name').value.trim();if(!name)return toast('请填写角色名称','error');const profile=rf().saveCustomProfile({name,aliases:overlay.querySelector('#rf-custom-aliases').value.split(/[，,]/).map(x=>x.trim()).filter(Boolean),summary:overlay.querySelector('#rf-custom-core').value.trim(),speechStyle:{prompt:overlay.querySelector('#rf-custom-speech').value.trim()},relationship:{summary:overlay.querySelector('#rf-custom-relationship').value.trim()},forbiddenDeviations:overlay.querySelector('#rf-custom-forbidden').value.split('\n').map(x=>x.trim()).filter(Boolean),sceneRules:{chat:['像真实聊天一样自然回应，不要把人设资料逐条朗读']}});toast(`已创建：${profile.name}`);close();openManager()};
    overlay.querySelector('[data-import-profile]').onclick=()=>{const input=document.createElement('input');input.type='file';input.accept='application/json,.json';input.onchange=async()=>{try{const profile=rf().importProfile(await input.files[0].text());toast(`已导入：${profile.name}`);close();openManager()}catch(error){toast(`导入失败：${error.message}`,'error')}};input.click()};
    overlay.querySelector('[data-r1-settings]').onclick=()=>window.EVEXiaoYiR1?.openSettings?.() || toast('R1模块尚未载入','error');
    overlay.querySelector('[data-xiaoyi-summary]').onclick=()=>{const p=rf().getProfile('xiaoyi');alert([p?.summary,'','R1身份：'+(p?.racingIdentity?.title||'R1五冠王'),'关系：'+(p?.relationship?.summary||'')].filter(Boolean).join('\n'))};
  }

  function downloadText(name,text){const blob=new Blob([text],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  function init(){if(initialized)return;initialized=true;addStyles();if(!injectSetting())retryTimer=setInterval(()=>{if(injectSetting()){clearInterval(retryTimer);retryTimer=null}},700);}
  function destroy(){if(retryTimer)clearInterval(retryTimer);document.getElementById('eve-role-fidelity-setting-item')?.remove();document.getElementById('eve-role-fidelity-standalone-section')?.remove();document.getElementById('eve-role-fidelity-modal')?.remove();initialized=false;}
  window.EVERoleFidelityUI=Object.freeze({version:VERSION,init,destroy,openManager,inject:injectSetting});
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init,{once:true}):init();
})(window,document);
