const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function setup(withConversationStyle = false) {
  const storage = new Map();
  const listeners = new Map();
  const eventTarget = {
    addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
    removeEventListener() {},
    dispatchEvent(event) { (listeners.get(event.type) || []).forEach(fn => fn(event)); }
  };
  let sent;
  const window = { ...eventTarget, currentChatCharacter:{ id:'A', name:'A' },
    fetch:async (_, init) => { sent = JSON.parse(init.body); return new Response('{"choices":[]}', { headers:{ 'content-type':'application/json' } }); }
  };
  const document = { ...eventTarget, readyState:'loading', body:{},
    querySelectorAll:() => [], getElementById:() => null };
  const context = vm.createContext({ window, document, console, Request, Response, Headers,
    localStorage:{ getItem:key => storage.get(key) || null, setItem:(key,value) => storage.set(key,value) },
    CustomEvent:class { constructor(type, options) { this.type=type; this.detail=options?.detail; } },
    MutationObserver:class { observe() {} disconnect() {} }, setTimeout, clearTimeout, setInterval, clearInterval
  });
  const files = ['js/adapter.js','js/cross-dimension.js','plugins/scene-state/core.js'];
  if (withConversationStyle) files.push('js/conversation-style.js');
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'), context);
  }
  const cross = window.EVECrossDimension, scene = window.EVESceneState, adapter = window.EVEAdapter;
  return { window, cross, scene, adapter, storage, sent:() => sent };
}
const marker = '【EVE跨次元现实边界】';
const count = body => JSON.stringify(body).split(marker).length - 1;

test('actual fetch retains boundary after persona rules despite oversized background', async () => {
  const { window, cross, adapter, sent } = setup();
  adapter.registerContextProvider('long-background', () => 'x'.repeat(20000));
  cross.setEnabled(true);
  await adapter.init();
  await window.fetch('https://example.test/v1/chat/completions', { method:'POST', body:JSON.stringify({
    model:'test', messages:[{ role:'system',content:'原角色设定：我们住在同一个屋子。以 JSON 回复。' },{ role:'user',content:'我们不是同一个次元。' }]
  }) });
  const messages=sent().messages;
  assert.match(messages[messages.length-2].content, /不同次元的存在/);
  assert.equal(messages.at(-1).content, '我们不是同一个次元。');
  assert.match(JSON.stringify(messages), /以 JSON 回复/);
  assert.equal(count(sent()), 1);
});

test('Gemini variants and Responses preserve existing instructions and avoid duplicate retry rules', () => {
  const {cross}=setup(); cross.setEnabled(true);
  for(const body of [
    {contents:[],systemInstruction:{parts:[{text:'原规则'}]}},
    {contents:[],system_instruction:{parts:[{text:'原规则'}]}},
    {input:'你好',instructions:'原规则'},
    {messages:[{role:'developer',content:[{type:'text',text:'原规则'}]},{role:'user',content:'你好'}]}
  ]) {
    const enabled=cross.injectRequest(body);
    assert.equal(count(enabled),1);
    assert.match(JSON.stringify(enabled),/原规则/);
    assert.equal(count(cross.injectRequest(enabled)),1);
    cross.setEnabled(false);
    assert.equal(count(cross.injectRequest(enabled)),0);
    cross.setEnabled(true);
  }
});

test('default off, per-character isolation, persistence, and disabled requests stay unchanged', () => {
  const {window,cross,storage}=setup();
  const body={messages:[{role:'system',content:'原设定'},{role:'user',content:'你好'}]};
  assert.equal(cross.isEnabled(),false);
  assert.equal(JSON.stringify(cross.injectRequest(body)),JSON.stringify(body));
  cross.setEnabled(true);
  assert.equal(JSON.parse(storage.get('eve_cross_dimension_by_character_v1')).A,true);
  window.currentChatCharacter={id:'B'};
  assert.equal(cross.isEnabled(),false);
  assert.equal(count(cross.injectRequest(body)),0);
  assert.equal(count(cross.injectRequest(body,{chat:{id:'A'}})),1);
});

test('face-to-face scene cannot contradict active boundary and stored scene remains intact', () => {
  const {cross,scene}=setup();
  scene.update({mode:'face-to-face',location:'卧室',pendingActions:['抱住你']});
  const original=JSON.stringify(scene.getState());
  assert.match(scene.getPromptContext(),/互动形式：面对面/);
  cross.setEnabled(true);
  assert.match(scene.getPromptContext(),/不在同一个物理空间/);
  assert.doesNotMatch(scene.getPromptContext(),/互动形式：面对面|不要.*远程聊天/);
  assert.equal(JSON.stringify(scene.getState()),original);
  cross.setEnabled(false);
  assert.match(scene.getPromptContext(),/互动形式：面对面/);
});

test('conversation style reaches the real request with cross-dimension mode both off and on', async () => {
  const {window,cross,adapter,sent}=setup(true);
  adapter.registerContextProvider('long-context',()=> 'x'.repeat(20000));
  await adapter.init();
  const messages=[{role:'system',content:'角色很直接。回复必须为 JSON 数组。'},
    {role:'user',content:'今天不想上课，只想撒娇一下。'}];
  for(const enabled of [false,true]) {
    cross.setEnabled(enabled);
    await window.fetch('https://example.test/v1/chat/completions',{method:'POST',body:JSON.stringify({messages})});
    const output=sent();
    assert.match(output.messages.at(-2).content,/EVE聊天分寸/);
    assert.equal(count(output),enabled ? 1 : 0);
    assert.equal(output.messages.at(-1).content,messages.at(-1).content);
    assert.match(JSON.stringify(output),/回复必须为 JSON 数组/);
    assert.equal(JSON.stringify(window.EVEConversationStyle.injectRequest(output)),JSON.stringify(output));
  }
});

test('conversation style supports Gemini and Responses and skips unrelated tasks without touching history', () => {
  const {window}=setup(true), style=window.EVEConversationStyle;
  for(const body of [
    {contents:[],systemInstruction:{parts:[{text:'原规则'}]}},
    {contents:[],system_instruction:{parts:[{text:'原规则'}]}},
    {input:'我只是想你了',instructions:'原规则'}
  ]) {
    const output=style.injectRequest(body);
    assert.match(JSON.stringify(output),/原规则/);
    assert.match(JSON.stringify(output),/EVE聊天分寸/);
    assert.equal(JSON.stringify(style.injectRequest(output)),JSON.stringify(output));
    assert.doesNotMatch(JSON.stringify(style.injectRequest(output,{feature:'diary'})),/EVE聊天分寸/);
  }
  const history={messages:[{role:'assistant',content:'之前的回答'},{role:'user',content:'今天有点烦'}]};
  assert.equal(JSON.stringify(style.injectRequest(history,{feature:'memory-analysis'})),JSON.stringify(history));
  assert.equal(JSON.stringify(style.injectRequest(history,{chat:{id:''}})),JSON.stringify(history));
});
