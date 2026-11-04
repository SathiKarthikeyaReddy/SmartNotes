import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { initialState } from '../core.js';
const html=await readFile(new URL('../app.html',import.meta.url),'utf8');
const code=await readFile(new URL('../app.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
function seed(){return {...initialState(),configuration:{gmail:false,outlook:false,ai:false},syncing:false};}
const task=(id,extra={})=>({id,title:`Task ${id}`,status:'open',priority:'medium',deadline:'2028-11-05T12:00:00Z',summary:'Please act',sourceIds:[],...extra});
async function client(data=seed(),before=()=>{}) {
  const dom=new JSDOM(html,{url:'http://localhost:3000',runScripts:'outside-only'}),w=dom.window;
  const calls=[];let fail=false;let reject=false;const blobs=[];
  w.fetch=async(url,opts={})=>{if(reject)throw new Error('offline');calls.push({url,method:opts.method || 'GET',body:opts.body?JSON.parse(opts.body):null});return {ok:!fail,json:async()=>fail?{error:'Service unavailable'}:url==='/api/state'?structuredClone(data):url==='/api/push-key'?{key:Buffer.alloc(65,1).toString('base64url')}:{ok:true}};};
  w.setInterval=fn=>{w.__tick=fn;return 1;};w.confirm=()=>false;
  w.HTMLDialogElement.prototype.showModal=function(){if(this.open)throw new Error('Dialog already open');this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:test';};w.URL.revokeObjectURL=()=>{};
  w.HTMLAnchorElement.prototype.click=function(){};
  before(w);
  const api=await w.eval(`(async()=>{${code}\nreturn {refresh,render,openDetail,openEditor,importNotes,safeMailLink,setView};})()`);
  const click=async selector=>{const b=w.document.querySelector(selector);assert.ok(b,`Missing ${selector}`);b.click();await flush();};
  return {w,d:w.document,api,calls,blobs,data,click,fail:value=>fail=value,reject:value=>reject=value,close:()=>w.close()};
}

test('client interaction and hostile-content regression suite',async t=>{
  let c=await client();
  try {
    await t.test('empty workspace renders setup and zero counts',()=>{assert.equal(c.d.getElementById('openStat').textContent,'0');assert.match(c.d.getElementById('items').textContent,/clearer day/);assert.equal(c.d.getElementById('setupBanner').hidden,false);});
    for(const view of ['review','completed','notes','tasks'])await t.test(`navigate ${view}`,async()=>{await c.click(`[data-view="${view}"]`);assert.equal(c.d.querySelector('.nav-item.active').dataset.view,view);assert.equal(c.d.getElementById('newButton').textContent,view==='notes'?'+ New note':'+ New task');});
    await t.test('new task opens accessible form',async()=>{await c.click('#newButton');assert.equal(c.d.getElementById('editor').open,true);assert.equal(c.d.getElementById('taskFields').hidden,false);c.d.getElementById('editor').close();});
    await t.test('manual task submits title priority and local deadline as UTC',async()=>{c.api.openEditor('task');c.d.getElementById('editTitle').value='Assessment';c.d.getElementById('editPriority').value='high';c.d.getElementById('editDeadline').value='2028-11-05T18:00';c.d.getElementById('editorForm').dispatchEvent(new c.w.Event('submit',{bubbles:true,cancelable:true}));await flush();const r=c.calls.findLast(r=>r.url==='/api/tasks');assert.equal(r.method,'POST');assert.equal(r.body.priority,'high');assert.equal(r.body.deadline,new Date('2028-11-05T18:00').toISOString());assert.equal(c.d.getElementById('editor').open,false);});
    await t.test('API error keeps unsaved form open and explains failure',async()=>{c.api.openEditor('task');c.d.getElementById('editTitle').value='Keep this draft';c.fail(true);c.d.getElementById('editorForm').dispatchEvent(new c.w.Event('submit',{bubbles:true,cancelable:true}));await flush();assert.equal(c.d.getElementById('editor').open,true);assert.equal(c.d.getElementById('editTitle').value,'Keep this draft');assert.match(c.d.getElementById('toast').textContent,/Service unavailable/);c.fail(false);c.d.getElementById('editor').close();});
    await t.test('account connect buttons disabled until configured',async()=>{await c.click('#topAccounts');assert.ok([...c.d.querySelectorAll('[data-connect]')].every(b=>b.disabled));c.d.getElementById('accounts').close();});
    await t.test('settings show missing AI configuration',async()=>{await c.click('#topSettings');assert.match(c.d.getElementById('modelStatus').textContent,/not configured/);c.d.getElementById('settings').close();});
    await t.test('unsupported notification browser shows a useful error',async()=>{await c.click('#enablePush');assert.match(c.d.getElementById('toast').textContent,/does not support/);});
    await t.test('offline polling leaves existing data and reports disconnection',async()=>{c.reject(true);await c.w.__tick();await flush();assert.match(c.d.getElementById('syncStatus').textContent,/disconnected/);c.reject(false);});
    await t.test('empty import makes no note writes',async()=>{const count=c.calls.length;await c.api.importNotes([]);assert.equal(c.calls.slice(count).filter(r=>r.url==='/api/notes').length,0);});
    for(const value of [null,{},'bad',[{title:'Missing content'}],[{title:42,content:'x'}]])await t.test(`invalid import rejected ${JSON.stringify(value)}`,()=>assert.rejects(c.api.importNotes(value),/notes|entries/i));
    await t.test('import validates whole collection before partial writes',async()=>{const count=c.calls.length;await assert.rejects(c.api.importNotes([{title:'Good',content:'Body'},{title:'Bad'}]));assert.equal(c.calls.slice(count).filter(r=>r.url==='/api/notes').length,0);});
    await t.test('import handles null entries without crashing',()=>assert.rejects(c.api.importNotes([null]),/entries|valid/i));
    await t.test('import preserves old note category and color',async()=>{await c.api.importNotes([{id:'old',title:'Existing',content:'Body',category:'ideas',color:'#fff3cd'}]);const r=c.calls.findLast(r=>r.url==='/api/notes');assert.equal(r.body.category,'ideas');assert.equal(r.body.color,'#fff3cd');});
  } finally{c.close();}
  const s=seed();s.accounts=[{id:'a',provider:'gmail',email:'you@example.com',error:'Quota exceeded'}];
  s.tasks=[task('low',{priority:'low',deadline:null}),task('high',{priority:'high',accountId:'a',folder:'promotions'}),task('review',{status:'review',folder:'spam'}),task('proposal',{proposal:{title:'Revision'}}),task('done',{status:'completed'})];
  s.notes=[{id:'n1',title:'Work note',content:'Content',category:'work',color:'#fff3cd'},{id:'n2',title:'Idea',content:'Literal [a.*] <script>bad()</script>',category:'ideas'}];
  s.messages=[{id:'source',subject:'<img src=x onerror=bad()>',body:'<script>bad()</script>',sender:'<svg onload=bad()>',folder:'spam',receivedAt:'2026-11-03T00:00:00Z',link:'javascript:bad()'}];s.tasks[2].sourceIds=['source'];
  s.notifications=[{id:'n',title:'New action',message:'Act now',createdAt:'2026-11-03T00:00:00Z',read:false}];
  c=await client(s);
  try {
    await t.test('stats include active tasks, reviews and completed separately',()=>{assert.equal(c.d.getElementById('openStat').textContent,'3');assert.equal(c.d.getElementById('reviewStat').textContent,'2');assert.equal(c.d.getElementById('completeStat').textContent,'1');});
    await t.test('connection errors are visible in main workspace',()=>{assert.equal(c.d.getElementById('syncProblems').hidden,false);assert.match(c.d.getElementById('syncProblems').textContent,/Quota exceeded/);});
    await t.test('priority sorting puts high before low',()=>assert.match(c.d.querySelector('#items .task-title').textContent,/high/));
    await t.test('review view includes proposed changes on active tasks',async()=>{await c.click('[data-view="review"]');assert.equal(c.d.querySelectorAll('#items .task-card').length,2);});
    await t.test('email HTML is rendered as text, never active elements',()=>{c.api.openDetail('review');const d=c.d.getElementById('detailContent');assert.equal(d.querySelector('script,img,svg'),null);assert.match(d.textContent,/<script>bad/);assert.equal(d.querySelector('a'),null);c.d.getElementById('details').close();});
    for(const value of ['javascript:alert(1)','data:text/html,bad','http://mail.google.com/x','https://mail.google.com.evil.test/x','https://user:password@mail.google.com/x'])await t.test(`mail link rejects ${value}`,()=>assert.equal(c.api.safeMailLink(value),false));
    for(const value of ['https://mail.google.com/mail/u/0/#all/1','https://outlook.live.com/mail/0/id/1','https://outlook.office.com/mail/id/1'])await t.test(`mail link accepts ${value}`,()=>assert.equal(c.api.safeMailLink(value),true));
    await t.test('note category filter restricts list',async()=>{await c.click('[data-view="notes"]');const select=c.d.getElementById('noteCategoryFilter');select.value='work';select.dispatchEvent(new c.w.Event('change'));assert.equal(c.d.querySelectorAll('#items .note-card').length,1);assert.match(c.d.getElementById('items').textContent,/Work note/);select.value='all';select.dispatchEvent(new c.w.Event('change'));});
    await t.test('literal regex characters in search are safe',()=>{const input=c.d.getElementById('searchInput');input.value='[a.*]';input.dispatchEvent(new c.w.Event('input'));assert.equal(c.d.querySelectorAll('#items .note-card').length,1);assert.equal(c.d.querySelector('#items script'),null);input.value='';input.dispatchEvent(new c.w.Event('input'));});
    await t.test('note colors represented without injecting markup',()=>{const card=c.d.querySelector('#items .note-card');assert.ok(card.style.borderLeft.includes('4px'));});
    await t.test('note editor loads original category and content',()=>{c.api.openEditor('note','n2');assert.equal(c.d.getElementById('editCategory').value,'ideas');assert.match(c.d.getElementById('editContent').value,/<script>/);assert.equal(c.d.getElementById('noteFields').hidden,false);c.d.getElementById('editor').close();});
    await t.test('notifications display and mark-read request',async()=>{await c.click('#bellButton');assert.match(c.d.getElementById('notificationList').textContent,/Act now/);await c.click('#readButton');assert.ok(c.calls.some(r=>r.url==='/api/read' && r.method==='POST'));});
    await t.test('complete action sends PATCH for selected task',async()=>{c.api.setView('tasks');await c.click('[data-action="complete"][data-id="high"]');assert.ok(c.calls.some(r=>r.url==='/api/tasks/high' && r.method==='PATCH' && r.body.action==='complete'));});
    await t.test('export creates downloadable artifact',async()=>{await c.click('#exportButton');assert.equal(c.blobs.length,1);assert.equal(c.blobs[0].type,'application/json');});
    await t.test('server reconnection restores ready state without losing notes',async()=>{c.data.accounts[0].error=null;await c.api.refresh();assert.equal(c.d.getElementById('syncStatus').textContent,'Ready');assert.equal(c.data.notes.length,2);});
    await t.test('new notification makes in-app toast',async()=>{c.data.notifications.unshift({id:'new',title:'Deadline changed',message:'New deadline',createdAt:new Date().toISOString()});await c.api.refresh();assert.match(c.d.getElementById('toast').textContent,/New deadline/);});
  } finally{c.close();}
});

test('client startup tolerates corrupt stored notes and blocked storage',async t=>{
  await t.test('malformed legacy JSON cannot make loaded dashboard unusable',async()=>{const c=await client(seed(),w=>w.localStorage.setItem('smartNotes','{bad'));try{assert.equal(c.d.getElementById('openStat').textContent,'0');assert.ok(!c.d.getElementById('toast').textContent.includes('Could not load SmartNotes'));}finally{c.close();}});
  await t.test('unavailable localStorage cannot abort startup',async()=>{let c;try{c=await client(seed(),w=>Object.defineProperty(w,'localStorage',{get(){throw new w.DOMException('Blocked','SecurityError');}}));assert.equal(c.d.getElementById('openStat').textContent,'0');}finally{c?.close();}});
});

test('notification permissions, subscriptions and optional in-tab sound',async t=>{
  function notifications(w,{permission='granted',existing=true,registrationError=false}={}){
    w.Notification={permission,requestPermission:async()=>permission};w.PushManager=function(){};
    const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/fake',keys:{},toJSON(){return {endpoint:this.endpoint,keys:this.keys};}};
    const registration={pushManager:{getSubscription:async()=>existing?subscription:null,subscribe:async()=>subscription}};
    Object.defineProperty(w.navigator,'serviceWorker',{value:{register:async()=>{if(registrationError)throw new Error('Registration failed');return registration;},ready:Promise.resolve(registration)}});
  }
  await t.test('denied permission explains how to enable alerts',async()=>{const c=await client(seed(),w=>notifications(w,{permission:'denied'}));try{await c.click('#enablePush');assert.match(c.d.getElementById('toast').textContent,/Allow notifications/);assert.equal(c.calls.filter(r=>r.url==='/api/push').length,0);}finally{c.close();}});
  for(const existing of [true,false])await t.test(`granted permission stores ${existing?'existing':'new'} subscription`,async()=>{const c=await client(seed(),w=>notifications(w,{existing}));try{await c.click('#enablePush');assert.ok(c.calls.some(r=>r.url==='/api/push' && r.method==='POST'));assert.match(c.d.getElementById('pushStatus').textContent,/enabled/);}finally{c.close();}});
  await t.test('worker registration failure is surfaced without claiming enabled',async()=>{const c=await client(seed(),w=>notifications(w,{registrationError:true}));try{await c.click('#enablePush');assert.match(c.d.getElementById('toast').textContent,/Registration failed/);assert.ok(!c.d.getElementById('pushStatus').textContent.includes('enabled'));}finally{c.close();}});
  for(const enabled of [false,true])await t.test(`in-tab sound ${enabled?'enabled':'disabled'} respects preference`,async()=>{
    let sounds=0;const s=seed();s.settings.sound=enabled;
    const c=await client(s,w=>{w.AudioContext=class {state='running';currentTime=0;destination={};createOscillator(){return {connect(){},frequency:{value:0},start(){sounds++;},stop(){}};}createGain(){return {connect(){},gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}}};}};});
    try{await c.click('#newButton');c.data.notifications.push({id:'sound-check',message:'Due soon'});await c.api.refresh();assert.equal(sounds,enabled?1:0);}finally{c.close();}
  });
  await t.test('dark theme preference loads without changing server data',async()=>{const c=await client(seed(),w=>w.localStorage.setItem('smartNotesTheme','dark'));try{assert.ok(c.d.documentElement.classList.contains('dark'));await c.click('#themeButton');assert.ok(!c.d.documentElement.classList.contains('dark'));assert.equal(c.w.localStorage.getItem('smartNotesTheme'),'light');}finally{c.close();}});
});
