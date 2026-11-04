import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function until(fn,timeout=6000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await fn();if(last)return last;}catch(e){last=e;}await sleep(25);}throw new Error(`Condition timed out: ${String(last)}`);}
export async function harness({seed,fixture,env={}}={}) {
  const parent=path.resolve('data','tests');await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(path.join(parent,'edge-'));
  const port=45000+Math.floor(Math.random()*19000),origin=`http://localhost:${port}`;
  const fixtureFile=path.join(dir,'service-fixture.json');
  if(seed)await writeFile(path.join(dir,'state.json'),JSON.stringify(seed));
  if(fixture)await writeFile(fixtureFile,JSON.stringify(fixture));
  const vars={...process.env,PORT:String(port),APP_URL:origin,DATA_DIR:dir,ENCRYPTION_KEY:randomBytes(32).toString('base64'),GEMINI_API_KEY:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',MICROSOFT_CLIENT_ID:'',MICROSOFT_CLIENT_SECRET:'',...env,...(fixture?{SMARTNOTES_TEST_FIXTURE:fixtureFile}:{})};
  let child,stderr='';
  async function start(){
    stderr='';child=spawn(process.execPath,['--import',pathToFileURL(path.resolve('test-support/coverage-hook.mjs')).href,...(fixture?['--import',pathToFileURL(path.resolve('test-support/fake-services.mjs')).href]:[]),'server.js'],{env:vars,stdio:['ignore','pipe','pipe','ipc']});
    child.stderr.on('data',d=>stderr+=String(d));
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw new Error(`Server exited ${code}: ${stderr}`);}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error(`Startup timeout: ${stderr}`)),10000);timer.unref();})]);
  }
  async function stop(){if(!child || child.exitCode!==null || child.signalCode!==null)return;const done=once(child,'exit');child.send('smartnotes-test-stop');await done;}
  async function req(p,method='GET',body,headers={}){const r=await fetch(origin+p,{method,redirect:'manual',headers:{Origin:origin,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data,headers:r.headers};}
  const getState=async()=>(await req('/api/state')).data;
  async function updateFixture(update){
    const f=JSON.parse(await readFile(fixtureFile,'utf8'));update(f);await writeFile(fixtureFile+'.tmp',JSON.stringify(f));
    for(let attempt=0;;attempt++){try{await rename(fixtureFile+'.tmp',fixtureFile);break;}catch(e){if(!['EPERM','EBUSY','EACCES'].includes(e.code) || attempt>=6)throw e;await sleep(20*2**attempt);}}
  }
  async function inspectFixture(){
    const f=JSON.parse(await readFile(fixtureFile,'utf8'));let text='';try{text=await readFile(fixtureFile+'.events','utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
    const rows=text.split('\n'),events=[];for(let i=0;i<rows.length;i++){if(!rows[i])continue;try{events.push(JSON.parse(rows[i]));}catch(e){if(i<rows.length-1)throw e;}}
    return {...f,calls:events.filter(e=>e.type==='call').map(e=>e.data),pushes:events.filter(e=>e.type==='push').map(e=>e.data)};
  }
  await start();
  return {dir,origin,env:vars,req,state:getState,start,stop,fixture:inspectFixture,updateFixture,stderr:()=>stderr,close:async()=>{await stop();await rm(dir,{recursive:true,force:true});}};
}
