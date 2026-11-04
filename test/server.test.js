import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

test('API integration: persistence, samples, reviews, notes, origin defense, credential hiding',async()=>{
  const testRoot=path.resolve('data','tests');await mkdir(testRoot,{recursive:true});
  const data=await mkdtemp(path.join(testRoot,'run-'));
  const port=35000+Math.floor(Math.random()*10000),origin=`http://localhost:${port}`;
  const env={...process.env,PORT:String(port),APP_URL:origin,DATA_DIR:data,GEMINI_API_KEY:'',GOOGLE_CLIENT_ID:'',MICROSOFT_CLIENT_ID:''};
  let child;
  async function start(){child=spawn(process.execPath,['--import',pathToFileURL(path.resolve('test-support/coverage-hook.mjs')).href,'server.js'],{env,stdio:['ignore','pipe','pipe','ipc']});await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Server startup timeout')),10000);t.unref();})]);}
  async function stop(){const exit=once(child,'exit');child.send('smartnotes-test-stop');await exit;}
  const req=async(p,method='GET',body,requestOrigin=origin)=>{const r=await fetch(origin+p,{method,headers:{Origin:requestOrigin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  try {
    await start();assert.equal((await fetch(origin)).status,200);
    assert.equal((await req('/api/demo','POST',{},'https://attacker.example')).status,403);
    const sample=await req('/api/demo','POST');assert.equal(sample.status,200,JSON.stringify(sample.data));assert.equal(sample.data.tasks.length,3);assert.equal(sample.data.tasks.filter(t=>t.status==='review').length,1);
    const second=await req('/api/demo','POST');assert.equal(second.data.tasks.length,3);
    assert.ok(sample.data.accounts.every(a=>!('token' in a)));
    const t=sample.data.tasks.find(t=>t.status==='review');await req(`/api/tasks/${t.id}`,'PATCH',{action:'accept'});
    assert.equal((await req('/api/state')).data.tasks.find(v=>v.id===t.id).status,'open');
    await req('/api/notes','POST',{title:'Existing note',content:'Keep my notes',category:'ideas',color:'#fff3cd'});
    assert.equal((await req('/api/state')).data.notes[0].content,'Keep my notes');
    assert.equal((await req('/api/tasks','POST',{title:'Invalid deadline',deadline:'bad'})).status,400);
    assert.equal((await req('/api/push','POST',{endpoint:'https://localhost/private',keys:{auth:'x',p256dh:'x'}})).status,400);
    await stop();await start();assert.equal((await req('/api/state')).data.notes.length,1);
    await req(`/api/accounts/${sample.data.accounts[0].id}`,'DELETE');const clean=(await req('/api/state')).data;assert.equal(clean.messages.length,0);assert.equal(clean.tasks.length,0);assert.equal(clean.notes.length,1);
  } finally {if(child && child.exitCode===null)await stop();await rm(data,{recursive:true,force:true});}
});
