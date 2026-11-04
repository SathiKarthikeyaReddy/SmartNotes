import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import http from 'node:http';
import { harness } from '../test-support/harness.mjs';
import { initialState } from '../core.js';

test('HTTP, mutation, persistence and validation boundaries',async t=>{
  const h=await harness();
  try {
    for(const [path,type] of [['/','text/html'],['/app.css','text/css'],['/app.js','text/javascript'],['/sw.js','text/javascript']])await t.test(`static ${path}`,async()=>{const r=await h.req(path);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),new RegExp(type));assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);});
    for(const path of ['/.env','/data/state.json','/server.js','/package.json','/../server.js','/does-not-exist','/constructor','/toString','/__proto__'])await t.test(`private/unknown path ${path} is not served`,async()=>assert.equal((await h.req(path)).status,404));
    await t.test('wrong host is rejected',async()=>{const status=await new Promise((resolve,reject)=>{http.get(h.origin+'/api/state',{headers:{Host:'attacker.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(status,403);});
    for(const origin of ['https://attacker.example','null','http://localhost:1'])await t.test(`mutation rejects origin ${origin}`,async()=>assert.equal((await h.req('/api/demo','POST',{}, {Origin:origin})).status,403));
    await t.test('malformed JSON returns controlled error',async()=>assert.equal((await h.req('/api/tasks','POST','{broken')).status,400));
    for(const body of [null,[],42,'"text"','{}',{title:''},{title:'  '},{title:123},{title:'x',deadline:'2026-02-29T12:00:00Z'},{title:'x',deadline:'2026-11-03'},{title:'x',deadline:0}])await t.test(`invalid task body ${JSON.stringify(body)}`,async()=>assert.equal((await h.req('/api/tasks','POST',body)).status,400));
    for(const [name,body] of [['no deadline',{title:'Read mail'}],['Unicode',{title:'面接 👩🏽‍💻 مرحبا',summary:'日本語'}],['offset',{title:'Assessment',deadline:'2026-11-06T12:00:00+05:30'}],['past',{title:'Overdue',deadline:'2020-01-01T00:00:00Z'}],['hostile text',{title:'<img src=x onerror=alert(1)>',summary:'<script>steal()</script>'}]])await t.test(`valid task ${name}`,async()=>{const r=await h.req('/api/tasks','POST',body);assert.equal(r.status,200);assert.equal(r.data.tasks[0].title,body.title);});
    await t.test('task field sizes bounded and invalid priority normalized',async()=>{const r=await h.req('/api/tasks','POST',{title:'a'.repeat(1000),summary:'s'.repeat(4000),priority:'invalid',status:'completed',id:'injected'});assert.equal(r.data.tasks[0].title.length,240);assert.equal(r.data.tasks[0].summary.length,2000);assert.equal(r.data.tasks[0].priority,'medium');assert.equal(r.data.tasks[0].status,'open');assert.notEqual(r.data.tasks[0].id,'injected');});
    await t.test('task response cannot inject prototype fields',async()=>{await h.req('/api/tasks','POST','{"title":"Safe","__proto__":{"polluted":true}}');assert.equal({}.polluted,undefined);});
    const task=(await h.state()).tasks[0];
    for(const action of ['complete','reopen','snooze','dismiss'])await t.test(`task action ${action}`,async()=>{const r=await h.req(`/api/tasks/${task.id}`,'PATCH',{action});assert.equal(r.status,200);const v=r.data.tasks.find(v=>v.id===task.id);if(action==='snooze')assert.ok(Date.parse(v.snoozedUntil)>Date.now());else assert.equal(v.status,{complete:'completed',reopen:'open',dismiss:'dismissed'}[action]);});
    await t.test('unknown task action is rejected',async()=>assert.equal((await h.req(`/api/tasks/${task.id}`,'PATCH',{action:'explode',title:'Sneaky'})).status,400));
    await t.test('missing task returns 404',async()=>assert.equal((await h.req('/api/tasks/missing','PATCH',{action:'complete'})).status,404));
    for(const body of [{title:''},{title:'Only title'},{title:'x',content:42},null])await t.test(`invalid note ${JSON.stringify(body)}`,async()=>assert.equal((await h.req('/api/notes','POST',body)).status,400));
    let note;
    await t.test('note create preserves Unicode and escapes only at rendering',async()=>{const r=await h.req('/api/notes','POST',{title:'メモ <b>text</b>',content:'ملاحظة\n<script>bad()</script>',category:'ideas',color:'#d1ecf1'});assert.equal(r.status,200);note=r.data.notes[0];assert.equal(note.content,'ملاحظة\n<script>bad()</script>');});
    await t.test('note edit retains ID and creation time',async()=>{const r=await h.req('/api/notes','POST',{...note,title:'Updated'});assert.equal(r.data.notes.length,1);assert.equal(r.data.notes[0].id,note.id);assert.equal(r.data.notes[0].createdAt,note.createdAt);});
    await t.test('note unknown category and hostile color normalized',async()=>{const r=await h.req('/api/notes','POST',{title:'N',content:'x',category:'unknown',color:'red; background:url(https://evil.test)'});assert.equal(r.data.notes[0].category,'personal');assert.equal(r.data.notes[0].color,'#ffffff');});
    await t.test('settings reject type confusion without changing values',async()=>{const original=(await h.state()).settings;await h.req('/api/settings','POST',{sound:'true',autoCreate:1,reminders:[0],polluted:true});assert.deepEqual((await h.state()).settings,original);});
    await t.test('settings booleans persist after restart',async()=>{await h.req('/api/settings','POST',{sound:true,autoCreate:false});await h.stop();await h.start();assert.equal((await h.state()).settings.sound,true);assert.equal((await h.state()).settings.autoCreate,false);});
    await t.test('concurrent note creates do not lose records',async()=>{await Promise.all(Array.from({length:20},(_,i)=>h.req('/api/notes','POST',{title:`Concurrent ${i}`,content:'Body'})));const s=await h.state();assert.equal(s.notes.filter(n=>n.title.startsWith('Concurrent')).length,20);await h.stop();await h.start();assert.equal((await h.state()).notes.filter(n=>n.title.startsWith('Concurrent')).length,20);});
    await t.test('missing account delete returns 404',async()=>assert.equal((await h.req('/api/accounts/missing','DELETE')).status,404));
    await t.test('missing note delete returns 404',async()=>assert.equal((await h.req('/api/notes/missing','DELETE')).status,404));
    await t.test('delete existing note leaves other notes intact',async()=>{const count=(await h.state()).notes.length;await h.req(`/api/notes/${note.id}`,'DELETE');assert.equal((await h.state()).notes.length,count-1);});
    await t.test('JSON larger than 2 MB rejected without mutation',async()=>{const count=(await h.state()).notes.length;const r=await h.req('/api/notes','POST',{title:'Huge',content:'x'.repeat(2000001)});assert.equal(r.status,400);assert.equal((await h.state()).notes.length,count);});
    const ecdh=createECDH('prime256v1');ecdh.generateKeys();
    const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
    for(const endpoint of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.test/x','https://evil.test/x','https://user:pass@fcm.googleapis.com/x','https://fcm.googleapis.com:444/x','https://fcm.googleapis.com/x#fragment'])await t.test(`push rejects endpoint ${endpoint}`,async()=>assert.equal((await h.req('/api/push','POST',{...subscription,endpoint})).status,400));
    await t.test('push rejects invalid cryptographic keys',async()=>assert.equal((await h.req('/api/push','POST',{...subscription,keys:{p256dh:'x',auth:'x'}})).status,400));
    await t.test('valid subscription accepted and deduplicated',async()=>{assert.equal((await h.req('/api/push','POST',subscription)).status,200);assert.equal((await h.req('/api/push','POST',subscription)).status,200);assert.equal((await h.state()).subscriptions,undefined);});
    await t.test('session cookie is HttpOnly and SameSite',async()=>{const r=await h.req('/');assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);});
    await t.test('credentials and runtime files are never exposed',async()=>{const s=await h.state();assert.equal(s.subscriptions,undefined);assert.ok(s.accounts.every(a=>!a.token));assert.equal((await h.req('/data/push.json')).status,404);});
  } finally {await h.close();}
});

test('review and proposal state transitions',async t=>{
  const s=initialState();s.tasks=[{id:'review',title:'Confirmed complete',status:'review',completed:true,deadline:null},{id:'proposal',title:'Original',status:'open',deadline:'2026-11-10T12:00:00Z',snoozedUntil:'2099-01-01T00:00:00Z',proposal:{title:'Revised',deadline:'2026-11-11T12:00:00Z',completed:false}},{id:'reject',title:'Keep original',status:'open',proposal:{title:'Bad revision'}},{id:'finish',title:'Work',status:'open',proposal:{title:'Work',completed:true}}];
  const h=await harness({seed:s});
  try {
    await t.test('accept completion suggestion creates completed state',async()=>{const r=await h.req('/api/tasks/review','PATCH',{action:'accept'});assert.equal(r.data.tasks.find(t=>t.id==='review').status,'completed');});
    await t.test('accept proposed deadline clears obsolete snooze',async()=>{const r=await h.req('/api/tasks/proposal','PATCH',{action:'accept'});const v=r.data.tasks.find(t=>t.id==='proposal');assert.equal(v.title,'Revised');assert.equal(v.deadline,'2026-11-11T12:00:00Z');assert.equal(v.snoozedUntil,null);});
    await t.test('reject follow-up retains active original',async()=>{const r=await h.req('/api/tasks/reject','PATCH',{action:'dismiss'});const v=r.data.tasks.find(t=>t.id==='reject');assert.equal(v.status,'open');assert.equal(v.title,'Keep original');assert.equal(v.proposal,null);});
    await t.test('approve completion follow-up completes original task',async()=>{const r=await h.req('/api/tasks/finish','PATCH',{action:'accept'});assert.equal(r.data.tasks.find(t=>t.id==='finish').status,'completed');});
    await t.test('reopen clears stale completion flag and snooze',async()=>{const r=await h.req('/api/tasks/review','PATCH',{action:'reopen'});const v=r.data.tasks.find(t=>t.id==='review');assert.equal(v.completed,false);assert.equal(v.snoozedUntil,null);});
  } finally {await h.close();}
});
