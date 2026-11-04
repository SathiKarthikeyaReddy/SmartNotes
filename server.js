import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomBytes, createHash, createECDH } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import webpush from 'web-push';
import { initialState, validateSavedState, id, validateAnalysis, applyAnalysis, dueReminders, parseDeadline, DAY } from './core.js';
import { oauthConfig, exchange, seal, unseal, encryptionReady, jsonRequest, fetchMail, analyze } from './mail.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root,'data');
await mkdir(dataDir,{recursive:true});
const file = path.join(dataDir,'state.json');
let storedText;
try { storedText=await readFile(file,'utf8'); } catch(e) { if(e.code!=='ENOENT')throw e; }
// Parsing/validation is deliberately outside the missing-file catch. Corruption
// stops startup before any write; the original file is preserved for recovery.
let state=storedText===undefined ? initialState() : validateSavedState(JSON.parse(storedText));
let saveQueue = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(state);
  saveQueue = saveQueue.catch(()=>{}).then(async () => {
    await writeFile(`${file}.tmp`,snapshot,{mode:0o600});
    for(let attempt=0;;attempt++) {
      try {await rename(`${file}.tmp`,file);break;}
      catch(e) {if(!['EPERM','EBUSY','EACCES'].includes(e.code) || attempt>=6)throw e;await new Promise(resolve=>setTimeout(resolve,30*2**attempt));}
    }
  });
  return saveQueue;
}
let vapid;
try { vapid = JSON.parse(await readFile(path.join(dataDir,'push.json'),'utf8')); } catch(e) { if(e.code !== 'ENOENT') throw e; vapid = webpush.generateVAPIDKeys(); await writeFile(path.join(dataDir,'push.json'),JSON.stringify(vapid),{mode:0o600}); }
webpush.setVapidDetails(process.env.PUSH_CONTACT || 'mailto:admin@example.com',vapid.publicKey,vapid.privateKey);
const origin = new URL(process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).origin;
const sessions = new Map(), oauthStates = new Map();
let syncing = false;
const configuration = () => ({ gmail: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && encryptionReady()), outlook: !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET && encryptionReady()), ai:!!process.env.GEMINI_API_KEY, model:process.env.GEMINI_MODEL || 'gemini-2.5-flash' });
function publicState() { return {...state, accounts:state.accounts.map(({token,...a})=>a), notifications:state.notifications.map(({deliveredTo,...n})=>n), subscriptions:undefined, configuration:configuration(), syncing}; }
async function readJSON(req) {
  let body=''; for await (const chunk of req) { body+=chunk; if(Buffer.byteLength(body)>2e6) throw new Error('Request too large'); }
  return body ? JSON.parse(body) : {};
}
async function sync(force = false) {
  if (syncing) return;
  syncing = true;
  try {
    for (const account of state.accounts.filter(a=>a.provider !== 'sample')) {
      if(!force && account.lastSync && Date.now()-Date.parse(account.lastSync)<300000) continue;
      try {
        if (!configuration().ai) throw new Error('Add GEMINI_API_KEY to enable real email analysis');
        const started = new Date().toISOString();
        const incoming = await fetchMail(account);
        const changed = new Set(state.messages.filter(m=>m.accountId===account.id && !m.processed).map(m=>m.threadId));
        const errors=[];
        for (const m of incoming) {
          const prior = state.messages.find(p=>p.id===m.id);
          const hash = createHash('sha256').update(JSON.stringify(m)).digest('hex');
          if (!prior) state.messages.push({...m,hash});
          else if (prior.hash !== hash) Object.assign(prior,m,{hash,processed:false});
          if (!prior || !prior.processed) changed.add(m.threadId);
        }
        for (const threadId of changed) {
          const thread = state.messages.filter(m=>m.accountId===account.id && m.threadId===threadId).sort((a,b)=>Date.parse(a.receivedAt)-Date.parse(b.receivedAt));
          const existing = state.tasks.find(t=>t.accountId===account.id && t.threadId===threadId);
          const revision=existing?.revision || 0;
          try {
            const result = validateAnalysis(await analyze(thread,existing),thread);
            if(existing && (existing.revision || 0)!==revision)result.uncertain=true;
            applyAnalysis(state,account,thread,result);
            thread.forEach(m=>{m.processed=true;delete m.analysisError;});
          } catch(e) {errors.push(e.message);thread.forEach(m=>m.analysisError=e.message);}
          await save();
        }
        account.lastSync=started; account.error=errors.length ? `${errors.length} thread(s) need another analysis attempt: ${errors[0]}` : null;
      } catch(e) { account.error=e.message; }
      await save();
    }
  } finally { syncing=false; }
}
async function reminders() {
  dueReminders(state);
  for(const n of state.notifications.filter(n=>!n.pushed)) {
    const task=state.tasks.find(t=>t.id===n.taskId);
    if(!task || task.status==='dismissed' || (task.status==='completed' && !task.proposal) || (n.key.startsWith('reminder:') && (task.status!=='open' || !n.key.includes(`:${task.deadline}:`) || Date.parse(task.snoozedUntil || '')>Date.now()))) {n.pushed=true;n.read=true;}
  }
  await save();
  for (const n of state.notifications.filter(n=>!n.pushed && !n.read)) {
    if (!state.subscriptions.length) continue;
    n.deliveredTo ||= [];
    for (const subscription of [...state.subscriptions]) {
      if(n.deliveredTo.includes(subscription.endpoint))continue;
      try { await webpush.sendNotification(subscription,JSON.stringify({title:n.title,body:n.message,id:n.id}),{TTL:3600,timeout:15000});n.deliveredTo.push(subscription.endpoint);await save(); }
      catch(e) { if([404,410].includes(e.statusCode)) state.subscriptions=state.subscriptions.filter(s=>s.endpoint!==subscription.endpoint); }
    }
    n.pushed=state.subscriptions.every(s=>n.deliveredTo.includes(s.endpoint));
  }
  await save();
}
function sampleData() {
  if(state.accounts.some(a=>a.provider==='sample')) return;
  const account={id:id(),provider:'sample',email:'you@example.com',lastSync:new Date().toISOString()}; state.accounts.push(account);
  const examples=[['Complete the software engineer assessment','Acme Careers <careers@example.com>','promotions',2,'high'],['Send the project milestone update','Project lead <lead@example.com>','inbox',1,'high'],['Upload graduation documents','Campus office <office@example.com>','spam',4,'medium']];
  for (const [title,sender,folder,days,priority] of examples) {
    const deadline=new Date(Date.now()+days*DAY).toISOString();
    const body=`${title}. Please complete this by ${deadline}.`;
    const m={id:id(),accountId:account.id,threadId:id(),subject:title,sender,folder,receivedAt:new Date().toISOString(),body,processed:true}; state.messages.push(m);
    applyAnalysis(state,account,[m],{actionable:true,title,summary:'Sample email — explore the workflow before connecting your accounts.',deadline,priority,evidence:body,confidence:.98,uncertain:false,completed:false});
  }
}
const allowedStatic = {'/':'app.html','/app.css':'app.css','/app.js':'app.js','/sw.js':'sw.js'};
const server=http.createServer(async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  try {
    if(req.headers.host !== new URL(origin).host) return send(403,{error:'Unexpected host'});
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const url=new URL(req.url,origin);
    const cookies=Object.fromEntries((req.headers.cookie || '').split(';').map(c=>c.trim().split('=')));
    let session=cookies.sn_session;
    if(!sessions.has(session)) { session=randomBytes(32).toString('hex'); sessions.set(session,Date.now()); res.setHeader('Set-Cookie',`sn_session=${session}; HttpOnly; SameSite=Lax; Path=/${origin.startsWith('https:')?'; Secure':''}`); }
    if(req.method !== 'GET' && req.headers.origin !== origin) return send(403,{error:'Request must come from this app'});
    if(req.method==='GET' && allowedStatic[url.pathname]) {
      const name=allowedStatic[url.pathname]; res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':'text/javascript'); return res.end(await readFile(path.join(root,name)));
    }
    if(req.method==='GET' && url.pathname==='/api/state') return send(200,publicState());
    if(req.method==='GET' && url.pathname==='/api/push-key') return send(200,{key:vapid.publicKey});
    if(req.method==='GET' && /^\/auth\/(gmail|outlook)$/.test(url.pathname)) {
      const provider=url.pathname.split('/')[2], c=oauthConfig(provider);
      if(!configuration()[provider]) return send(400,{error:'Configure this provider and ENCRYPTION_KEY in .env, then restart'});
      const nonce=randomBytes(32).toString('hex'), verifier=randomBytes(32).toString('base64url');
      oauthStates.set(nonce,{provider,session,verifier,expires:Date.now()+600000});
      const p=new URLSearchParams({client_id:c.clientId,redirect_uri:c.redirect,response_type:'code',scope:c.scope,state:nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'consent',...(provider==='gmail'?{access_type:'offline'}:{})});
      res.writeHead(302,{Location:`${c.auth}?${p}`}); return res.end();
    }
    if(req.method==='GET' && /^\/auth\/(gmail|outlook)\/callback$/.test(url.pathname)) {
      const nonce=url.searchParams.get('state'), pending=oauthStates.get(nonce); oauthStates.delete(nonce);
      if(!pending || pending.session!==session || pending.expires<Date.now() || pending.provider!==url.pathname.split('/')[2]) return send(400,{error:'Sign-in expired; please try again'});
      if(url.searchParams.has('error')) return send(400,{error:'Email connection was not approved'});
      const token=await exchange(pending.provider,{grant_type:'authorization_code',code:url.searchParams.get('code') || '',code_verifier:pending.verifier});
      const headers={Authorization:`Bearer ${token.access_token}`};
      const profile=await jsonRequest(pending.provider==='gmail'?'https://gmail.googleapis.com/gmail/v1/users/me/profile':'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',{headers});
      const email=profile.emailAddress || profile.mail || profile.userPrincipalName;
      if(!email) throw new Error('Could not identify this mailbox');
      let account=state.accounts.find(a=>a.provider===pending.provider && a.email===email);
      if(account) account.token=seal({...token,refresh_token:token.refresh_token || unseal(account.token).refresh_token});
      else {account={id:id(),provider:pending.provider,email,token:seal(token),lastSync:null};state.accounts.push(account);}
      await save(); void sync().catch(e=>console.error('Sync failed:',e.message)); res.writeHead(302,{Location:'/'}); return res.end();
    }
    if(req.method==='POST' && url.pathname==='/api/sync') { void sync(true).catch(e=>console.error('Sync failed:',e.message)); return send(202,{ok:true}); }
    if(req.method==='POST' && url.pathname==='/api/demo') {sampleData(); await save(); return send(200,publicState());}
    if(req.method==='POST' && url.pathname==='/api/push') {
      const s=await readJSON(req); let target; try {target=new URL(s.endpoint);}catch {throw new Error('Invalid push subscription');}
      const pushHosts=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'];
      if(target.protocol!=='https:' || target.username || target.password || target.port || target.hash || s.endpoint.length>4096 || !(pushHosts.includes(target.hostname) || target.hostname.endsWith('.notify.windows.com')) || !s.keys?.p256dh || !s.keys?.auth) throw new Error('Unsupported push endpoint');
      try {
        if(typeof s.keys.p256dh!=='string' || typeof s.keys.auth!=='string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(s.keys.p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(s.keys.auth) || Buffer.from(s.keys.auth,'base64url').length!==16 || Buffer.from(s.keys.p256dh,'base64url').length!==65)throw new Error();
        createECDH('prime256v1').setPublicKey(Buffer.from(s.keys.p256dh,'base64url'));
      }catch {throw new Error('Invalid push subscription keys');}
      if(!state.subscriptions.some(p=>p.endpoint===s.endpoint)) state.subscriptions.push({endpoint:s.endpoint,keys:s.keys});
      await save();return send(200,{ok:true});
    }
    if(req.method==='POST' && url.pathname==='/api/settings') {
      const data=await readJSON(req);
      for(const key of ['autoCreate','sound']) if(typeof data[key]==='boolean') state.settings[key]=data[key];
      await save();return send(200,state.settings);
    }
    if(req.method==='POST' && url.pathname==='/api/read') {state.notifications.forEach(n=>n.read=true);await save();return send(200,{ok:true});}
    if(req.method==='POST' && url.pathname==='/api/tasks') {
      const data=await readJSON(req); const task=taskInput(data);
      state.tasks.unshift({id:id(),...task,status:'open',createdAt:new Date().toISOString(),history:[]});await save();return send(200,publicState());
    }
    const taskMatch=url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if(taskMatch && req.method==='PATCH') {
      const task=state.tasks.find(t=>t.id===taskMatch[1]);if(!task) return send(404,{error:'Task not found'});
      const data=await readJSON(req);
      if(data.action && !['accept','complete','reopen','dismiss','snooze'].includes(data.action))throw new Error('Unknown task action');
      if(data.action==='accept') {if(task.proposal) {Object.assign(task,task.proposal);task.proposal=null;}task.status=task.cancelled?'dismissed':task.completed?'completed':'open';task.snoozedUntil=null;}
      else if(data.action==='complete') {task.status='completed';task.completed=true;task.proposal=null;task.snoozedUntil=null;}
      else if(data.action==='reopen') {task.status='open';task.completed=false;task.cancelled=false;task.snoozedUntil=null;}
      else if(data.action==='dismiss') {if(task.proposal)task.proposal=null;else task.status='dismissed';}
      else if(data.action==='snooze') task.snoozedUntil=new Date(Date.now()+3600000).toISOString();
      else {const changes=taskInput(data);if(task.deadline!==changes.deadline)task.snoozedUntil=null;Object.assign(task,changes);task.proposal=null;}
      task.updatedAt=new Date().toISOString();task.revision=(task.revision || 0)+1;await save();return send(200,publicState());
    }
    if(req.method==='POST' && url.pathname==='/api/notes') {
      const d=await readJSON(req); if(typeof d.title!=='string' || typeof d.content!=='string' || !d.title.trim()) throw new Error('Note needs a title and content');
      const prior=state.notes.find(n=>n.id===d.id); const note={id:prior?.id || (typeof d.id==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(d.id)?d.id:id()),title:d.title.trim().slice(0,240),content:d.content.slice(0,100000),category:['work','personal','ideas','todo'].includes(d.category)?d.category:'personal',color:/^#[0-9a-f]{6}$/i.test(d.color)?d.color:'#ffffff',createdAt:prior?.createdAt || (typeof d.createdAt==='string' && Number.isFinite(Date.parse(d.createdAt))?new Date(d.createdAt).toISOString():new Date().toISOString()),updatedAt:new Date().toISOString()};
      if(prior) Object.assign(prior,note);else state.notes.unshift(note);await save();return send(200,publicState());
    }
    const noteMatch=url.pathname.match(/^\/api\/notes\/([^/]+)$/);
    if(noteMatch && req.method==='DELETE') {if(!state.notes.some(n=>n.id===noteMatch[1]))return send(404,{error:'Note not found'});state.notes=state.notes.filter(n=>n.id!==noteMatch[1]);await save();return send(200,publicState());}
    const accountMatch=url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
    if(accountMatch && req.method==='DELETE') {
      if(syncing) return send(409,{error:'Wait for the current sync to finish before disconnecting'});
      const a=accountMatch[1];const taskIds=state.tasks.filter(t=>t.accountId===a).map(t=>t.id);
      if(!state.accounts.some(v=>v.id===a))return send(404,{error:'Account not found'});
      state.accounts=state.accounts.filter(v=>v.id!==a);state.messages=state.messages.filter(v=>v.accountId!==a);state.tasks=state.tasks.filter(v=>v.accountId!==a);state.notifications=state.notifications.filter(n=>!taskIds.includes(n.taskId));
      await save();return send(200,publicState());
    }
    send(404,{error:'Not found'});
  } catch(e) {send(400,{error:e.message});}
});
function taskInput(d) {
  if(typeof d.title!=='string' || !d.title.trim()) throw new Error('Task needs a title');
  const deadline=parseDeadline(d.deadline);
  return {title:d.title.trim().slice(0,240),summary:String(d.summary || '').slice(0,2000),deadline,priority:['high','medium','low'].includes(d.priority)?d.priority:'medium'};
}
let reminding=false;
async function checkReminders() {
  if(reminding)return;
  reminding=true;
  try{await reminders();}catch(e){console.error('Reminder check failed:',e.message);}finally{reminding=false;}
}
// Slow mail/model requests must not delay the reminder clock.
const timer=setInterval(()=>{
  void sync().catch(e=>console.error('Background sync failed:',e.message));
  void checkReminders();
},60000);
server.listen(Number(process.env.PORT || 3000),'127.0.0.1',()=>console.log(`SmartNotes is ready at ${origin}`));
void checkReminders();
void sync().catch(e=>console.error('Startup sync failed:',e.message));
process.on('SIGINT',()=>{clearInterval(timer);server.close(()=>process.exit(0));});
