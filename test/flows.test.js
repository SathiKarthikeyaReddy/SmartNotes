import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { harness, until, sleep } from '../test-support/harness.mjs';
import { initialState, DAY } from '../core.js';
import { seal, unseal } from '../mail.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const now=Date.parse('2026-11-03T06:00:00Z');
const body='Please complete your assessment by 2026-11-06T12:00:00Z.';
const analysis={actionable:true,title:'Complete assessment',summary:'Submit before deadline',evidence:body,deadline:'2026-11-06T12:00:00Z',priority:'high',confidence:.98,uncertain:false,completed:false};
const mail=(id,subject='Assessment',extra={})=>({id,threadId:'thread',internalDate:String(now),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'Subject',value:subject},{name:'From',value:'careers@example.com'}],body:{data:Buffer.from(body).toString('base64url')}},...extra});
function encrypted(key){const old=process.env.ENCRYPTION_KEY;process.env.ENCRYPTION_KEY=key;try{return seal({access_token:'fake-access',refresh_token:'fake-refresh',expiresAt:now+DAY});}finally{if(old===undefined)delete process.env.ENCRYPTION_KEY;else process.env.ENCRYPTION_KEY=old;}}
async function sync(h){await h.req('/api/sync','POST');await until(async()=>!(await h.state()).syncing);}

test('end-to-end sync with isolated Gmail and AI doubles',async t=>{
  const key=randomBytes(32).toString('base64'),s=initialState();s.accounts=[{id:'a',provider:'gmail',email:'test@example.com',token:encrypted(key),lastSync:null}];
  const h=await harness({seed:s,env:{ENCRYPTION_KEY:key,GEMINI_API_KEY:'fake'},fixture:{now,interval:40,gmail:[mail('one'),mail('bad','Failure',{threadId:'other'})],ai:{Assessment:analysis,Failure:analysis},aiErrorSubjects:['Failure']}});
  try {
    await until(async()=>{const s=await h.state();return !s.syncing && s.accounts[0].lastSync;});
    await t.test('one failing AI thread does not block a successful thread',async()=>{const s=await h.state();assert.equal(s.tasks.length,1);assert.ok(s.accounts[0].error.includes('1 thread'));assert.equal(s.messages.find(m=>m.providerId==='one').processed,true);assert.ok(s.messages.find(m=>m.providerId==='bad').analysisError);assert.notEqual(s.messages.find(m=>m.providerId==='bad').processed,true);});
    await t.test('failed analysis is retried despite unchanged mail',async()=>{await h.updateFixture(f=>f.aiErrorSubjects=[]);await sync(h);const s=await h.state();assert.equal(s.tasks.length,2);assert.equal(s.accounts[0].error,null);assert.ok(s.messages.every(m=>m.processed));});
    await t.test('unchanged repeated sync makes no model calls or duplicate tasks',async()=>{const before=(await h.fixture()).calls.filter(c=>c.url.includes('generateContent')).length;await sync(h);const f=await h.fixture();assert.equal(f.calls.filter(c=>c.url.includes('generateContent')).length,before);assert.equal((await h.state()).tasks.length,2);});
    await t.test('follow-up extends existing task rather than creating duplicate',async()=>{await h.updateFixture(f=>{f.gmail.push(mail('two','Extended',{internalDate:String(now+1000)}));f.ai.Extended={...analysis,deadline:'2026-11-08T12:00:00Z'};});await sync(h);const s=await h.state(),task=s.tasks.find(t=>t.threadId==='thread');assert.equal(s.tasks.length,2);assert.equal(task.deadline,'2026-11-08T12:00:00.000Z');assert.equal(task.sourceIds.length,2);assert.equal(task.history.length,1);});
    await t.test('ambiguous follow-up preserves accepted deadline and proposes revision',async()=>{await h.updateFixture(f=>{f.gmail.push(mail('three','Ambiguous',{internalDate:String(now+2000)}));f.ai.Ambiguous={...analysis,deadline:null,uncertain:true};});await sync(h);const task=(await h.state()).tasks.find(t=>t.threadId==='thread');assert.equal(task.deadline,'2026-11-08T12:00:00.000Z');assert.equal(task.proposal.deadline,null);});
    await t.test('rejecting ambiguous follow-up retains original task',async()=>{const task=(await h.state()).tasks.find(t=>t.threadId==='thread');await h.req(`/api/tasks/${task.id}`,'PATCH',{action:'dismiss'});const v=(await h.state()).tasks.find(t=>t.id===task.id);assert.equal(v.status,'open');assert.equal(v.proposal,null);});
    await t.test('manual deadline edit during AI request cannot be overwritten',async()=>{
      const before=(await h.fixture()).calls.filter(c=>c.url.includes('generateContent')).length;
      await h.updateFixture(f=>{f.delay=80;f.gmail.push(mail('manual-race','Race',{internalDate:String(now+2500)}));f.ai.Race=analysis;});
      await h.req('/api/sync','POST');await until(async()=>(await h.fixture()).calls.filter(c=>c.url.includes('generateContent')).length>before);
      const task=(await h.state()).tasks.find(t=>t.threadId==='thread');
      await h.req(`/api/tasks/${task.id}`,'PATCH',{title:'Manually corrected',deadline:'2026-11-12T12:00:00Z',priority:'high'});
      await until(async()=>!(await h.state()).syncing);const updated=(await h.state()).tasks.find(t=>t.id===task.id);
      assert.equal(updated.title,'Manually corrected');assert.equal(updated.deadline,'2026-11-12T12:00:00.000Z');assert.ok(updated.proposal);await h.updateFixture(f=>f.delay=0);
    });
    await t.test('mail indicating completion waits for approval',async()=>{await h.updateFixture(f=>{f.gmail.push(mail('four','Submitted',{internalDate:String(now+3000)}));f.ai.Submitted={...analysis,completed:true};});await sync(h);const task=(await h.state()).tasks.find(t=>t.threadId==='thread');assert.equal(task.status,'open');assert.equal(task.proposal.completed,true);await h.req(`/api/tasks/${task.id}`,'PATCH',{action:'accept'});assert.equal((await h.state()).tasks.find(t=>t.id===task.id).status,'completed');});
    await t.test('a later action does not automatically reopen completed task',async()=>{await h.updateFixture(f=>{f.gmail.push(mail('five','Another action',{internalDate:String(now+4000)}));f.ai['Another action']=analysis;});await sync(h);const task=(await h.state()).tasks.find(t=>t.threadId==='thread');assert.equal(task.status,'completed');assert.ok(task.proposal);});
    await t.test('network outage preserves previous tasks and last successful scan',async()=>{const previous=await h.state();await h.updateFixture(f=>f.networkError=true);await sync(h);const s=await h.state();assert.equal(s.tasks.length,previous.tasks.length);assert.equal(s.accounts[0].lastSync,previous.accounts[0].lastSync);assert.match(s.accounts[0].error,/disconnected/);await h.updateFixture(f=>f.networkError=false);});
    await t.test('sync lock prevents overlap and disconnect while busy',async()=>{await h.updateFixture(f=>f.delay=120);await h.req('/api/sync','POST');await until(async()=>(await h.state()).syncing);assert.equal((await h.req('/api/accounts/a','DELETE')).status,409);await h.req('/api/sync','POST');await until(async()=>!(await h.state()).syncing);await h.updateFixture(f=>f.delay=0);});
    await t.test('restart keeps processed-message state and does not recreate tasks',async()=>{const before=(await h.state()).tasks.map(t=>t.id).sort();await h.stop();await h.start();await until(async()=>!(await h.state()).syncing);assert.deepEqual((await h.state()).tasks.map(t=>t.id).sort(),before);});
    await t.test('disconnect removes only linked mail/tasks/notifications',async()=>{await h.req('/api/notes','POST',{title:'Keep',content:'My note'});await h.req('/api/tasks','POST',{title:'Manual task'});await h.req('/api/accounts/a','DELETE');const s=await h.state();assert.equal(s.messages.length,0);assert.equal(s.accounts.length,0);assert.equal(s.tasks.length,1);assert.equal(s.tasks[0].title,'Manual task');assert.equal(s.notes.length,1);assert.equal(s.notifications.length,0);});
  } finally {await h.close();}
});

test('OAuth authorization state, account linking and refresh boundaries',async t=>{
  const h=await harness({env:{GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret'},fixture:{now,interval:40,gmail:[]}});
  async function begin(){const r=await h.req('/auth/gmail');assert.equal(r.status,302);const url=new URL(r.headers.get('location'));return {state:url.searchParams.get('state'),cookie:r.headers.get('set-cookie').split(';')[0],url};}
  try {
    await t.test('OAuth requests read-only consent and PKCE challenge',async()=>{const b=await begin();assert.equal(b.url.searchParams.get('code_challenge_method'),'S256');assert.ok(b.url.searchParams.get('code_challenge'));assert.ok(b.url.searchParams.get('scope').includes('gmail.readonly'));});
    await t.test('unconfigured provider fails locally',async()=>assert.equal((await h.req('/auth/outlook')).status,400));
    await t.test('missing state rejected',async()=>assert.equal((await h.req('/auth/gmail/callback?code=x')).status,400));
    await t.test('random state rejected',async()=>assert.equal((await h.req('/auth/gmail/callback?code=x&state=unknown')).status,400));
    await t.test('state from different browser session rejected',async()=>{const b=await begin();assert.equal((await h.req(`/auth/gmail/callback?code=x&state=${b.state}`)).status,400);});
    await t.test('user denying consent creates no account',async()=>{const b=await begin();assert.equal((await h.req(`/auth/gmail/callback?error=access_denied&state=${b.state}`,'GET',undefined,{Cookie:b.cookie})).status,400);assert.equal((await h.state()).accounts.length,0);});
    await t.test('expired state rejected',async()=>{const b=await begin();await h.updateFixture(f=>f.now+=600001);assert.equal((await h.req(`/auth/gmail/callback?code=x&state=${b.state}`,'GET',undefined,{Cookie:b.cookie})).status,400);});
    let used;
    await t.test('valid callback stores account without exposing token',async()=>{used=await begin();assert.equal((await h.req(`/auth/gmail/callback?code=x&state=${used.state}`,'GET',undefined,{Cookie:used.cookie})).status,302);const s=await h.state();assert.equal(s.accounts.length,1);assert.equal(s.accounts[0].email,'test@example.com');assert.equal(s.accounts[0].token,undefined);});
    await t.test('callback state cannot be replayed',async()=>assert.equal((await h.req(`/auth/gmail/callback?code=x&state=${used.state}`,'GET',undefined,{Cookie:used.cookie})).status,400));
    await t.test('reconnecting same account does not duplicate account',async()=>{const b=await begin();await h.req(`/auth/gmail/callback?code=x&state=${b.state}`,'GET',undefined,{Cookie:b.cookie});assert.equal((await h.state()).accounts.length,1);});
    await t.test('reconnect response without refresh token preserves previous refresh token',async()=>{await h.updateFixture(f=>f.token={access_token:'fresh-access',expires_in:3600});const b=await begin();await h.req(`/auth/gmail/callback?code=x&state=${b.state}`,'GET',undefined,{Cookie:b.cookie});const saved=JSON.parse(await readFile(path.join(h.dir,'state.json'),'utf8'));const old=process.env.ENCRYPTION_KEY;process.env.ENCRYPTION_KEY=h.env.ENCRYPTION_KEY;try{assert.equal(unseal(saved.accounts[0].token).refresh_token,'fake-refresh');}finally{if(old===undefined)delete process.env.ENCRYPTION_KEY;else process.env.ENCRYPTION_KEY=old;}});
    await t.test('second mailbox is stored separately',async()=>{await h.updateFixture(f=>f.profile={emailAddress:'second@example.com'});const b=await begin();await h.req(`/auth/gmail/callback?code=x&state=${b.state}`,'GET',undefined,{Cookie:b.cookie});assert.equal((await h.state()).accounts.length,2);});
    await t.test('malformed token response does not add mailbox',async()=>{await h.updateFixture(f=>f.token={});const b=await begin();assert.equal((await h.req(`/auth/gmail/callback?code=x&state=${b.state}`,'GET',undefined,{Cookie:b.cookie})).status,400);assert.equal((await h.state()).accounts.length,2);});
  }finally{await h.close();}
});

test('background push delivery, invalid subscriptions and retry recovery',async t=>{
  const good='https://fcm.googleapis.com/fcm/send/good',retry='https://fcm.googleapis.com/fcm/send/retry',expired='https://fcm.googleapis.com/fcm/send/expired';
  const s=initialState();s.tasks=[{id:'due',title:'Due soon',status:'open',deadline:new Date(now+1800000).toISOString()}];s.subscriptions=[good,retry,expired].map(endpoint=>({endpoint,keys:{}}));
  const h=await harness({seed:s,fixture:{now,interval:30,pushStatus:{[retry]:503,[expired]:410}}});
  try {
    await until(async()=>(await h.fixture()).pushes?.length>=3);
    await t.test('active due task produces background push',async()=>{const pushes=(await h.fixture()).pushes;assert.ok(pushes.some(p=>p.endpoint===good && p.payload.title==='Due soon'));});
    await t.test('transient failure remains eligible for retry',async()=>{await h.updateFixture(f=>delete f.pushStatus[retry]);await until(async()=>(await h.fixture()).pushes.filter(p=>p.endpoint===retry).length>=2);});
    await t.test('successful endpoint does not receive duplicate notification on retry',async()=>{const pushes=(await h.fixture()).pushes;assert.equal(pushes.filter(p=>p.endpoint===good).length,1);});
    await t.test('expired subscription removed instead of retried forever',async()=>{const pushes=(await h.fixture()).pushes;assert.equal(pushes.filter(p=>p.endpoint===expired).length,1);});
    await t.test('no duplicate reminder on repeated background ticks',async()=>{await sleep(100);const s=await h.state();assert.equal(s.notifications.filter(n=>n.key.startsWith('reminder:')).length,1);});
    await t.test('completed task suppresses new overdue push',async()=>{await h.req('/api/tasks/due','PATCH',{action:'complete'});await h.updateFixture(f=>f.now+=DAY);await sleep(100);assert.equal((await h.state()).notifications.filter(n=>n.key.startsWith('reminder:')).length,1);});
  }finally{await h.close();}
});
