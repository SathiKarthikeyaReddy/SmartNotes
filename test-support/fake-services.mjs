// Test-process-only provider doubles. Production never imports this module.
import fs from 'node:fs';
import webpush from 'web-push';
const file=process.env.SMARTNOTES_TEST_FIXTURE;
if(!file)throw new Error('Missing isolated test fixture');
const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
const record=(type,data)=>fs.appendFileSync(file+'.events',JSON.stringify({type,data})+'\n');
const RealDate=Date;
globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[read().now ?? RealDate.now()]));}static now(){return read().now ?? RealDate.now();}};
const originalInterval=globalThis.setInterval;
globalThis.setInterval=(fn,ms,...args)=>originalInterval(fn,read().interval ?? ms,...args);
webpush.sendNotification=async(subscription,payload)=>{
  const f=read();record('push',{endpoint:subscription.endpoint,payload:JSON.parse(payload)});
  const status=f.pushStatus?.[subscription.endpoint];
  if(status){const error=new Error('Mock push failure');error.statusCode=status;throw error;}
};
globalThis.fetch=async(input,options={})=>{
  let f=read();const u=new URL(input);record('call',{url:u.href,method:options.method || 'GET'});
  if(f.delay)await new Promise(r=>setTimeout(r,f.delay));
  if(f.networkError)throw new Error('Mock network disconnected');
  if(u.pathname.endsWith('/token'))return Response.json(f.token || {access_token:'fake-access',refresh_token:'fake-refresh',expires_in:3600});
  if(u.pathname.endsWith('/profile'))return Response.json(f.profile || {emailAddress:'test@example.com'});
  if(u.hostname==='generativelanguage.googleapis.com') {
    const prompt=JSON.parse(options.body).contents[0].parts[0].text;
    const data=JSON.parse(prompt.split('UNTRUSTED EMAIL DATA:\n')[1]);
    const subject=data.messages.at(-1).subject;
    if(f.aiErrorSubjects?.includes(subject))return new Response('Rate limit',{status:429});
    const answer=f.ai?.[subject] || {actionable:false};
    return Response.json({candidates:[{content:{parts:[{text:typeof answer==='string'?answer:JSON.stringify(answer)}]}}]});
  }
  if(u.hostname==='gmail.googleapis.com') {
    if(u.pathname.endsWith('/messages'))return Response.json({messages:(f.gmail || []).map(m=>({id:m.id}))});
    const m=(f.gmail || []).find(m=>u.pathname.endsWith('/'+m.id));
    if(!m)return new Response('Missing',{status:404});
    return Response.json(m);
  }
  throw new Error(`Unexpected external test request: ${u.origin}${u.pathname}`);
};
