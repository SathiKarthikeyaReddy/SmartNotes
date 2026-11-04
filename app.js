const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const storageGet=key=>{try{return localStorage.getItem(key);}catch{return null;}};
const storageSet=(key,value)=>{try{localStorage.setItem(key,value);}catch{toast('Your browser blocked saving local preferences. Your server data is still available.');}};
let state, view='tasks', filter='all', editorKind='task', audio;
let seenNotifications=new Set();
const date = value => value ? new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'No deadline — review needed';
const isReview = t => t.status==='review' || !!t.proposal;
function toast(text) { $('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5500); }
async function api(path,method='GET',body) {
  const response=await fetch(`/api${path}`,{method,headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok) throw new Error(result.error || 'Request failed');return result;
}
const on = (id, event, handler) => $(id).addEventListener(event, async e=>{try{await handler(e);}catch(error){toast(error.message);}});
function show(id) {$(id).showModal();}
function sound() {
  if(!state.settings.sound || !audio) return;
  const osc=audio.createOscillator(),gain=audio.createGain();osc.connect(gain);gain.connect(audio.destination);osc.frequency.value=660;gain.gain.setValueAtTime(.06,audio.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.6);osc.start();osc.stop(audio.currentTime+.6);
}
document.addEventListener('click',()=>{if(!audio && window.AudioContext) audio=new AudioContext();if(audio?.state==='suspended') void audio.resume();});
async function refresh(initial=false) {
  state=await api('/state');
  if(initial) seenNotifications=new Set(state.notifications.map(n=>n.id));
  else {
    const added=state.notifications.filter(n=>!seenNotifications.has(n.id));
    if(added.length) {toast(added[0].message);sound();}
    state.notifications.forEach(n=>seenNotifications.add(n.id));
  }
  render();
}
function setView(next) {view=next;filter='all';$('searchInput').value='';render();}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;render();}));
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
function render() {
  if(!state)return;
  const open=state.tasks.filter(t=>t.status==='open'),reviews=state.tasks.filter(isReview),done=state.tasks.filter(t=>t.status==='completed');
  $('taskCount').textContent=open.length;$('reviewCount').textContent=reviews.length;
  $('openStat').textContent=open.length;$('reviewStat').textContent=reviews.length;$('completeStat').textContent=done.length;
  $('dueStat').textContent=open.filter(t=>t.deadline && Date.parse(t.deadline)-Date.now()<=86400000).length;
  $('unreadCount').textContent=state.notifications.filter(n=>!n.read).length;
  $('syncStatus').textContent=state.syncing?'Checking your accounts…':state.accounts.some(a=>a.error)?'Connection needs attention':'Ready';
  $('syncButton').disabled=state.syncing;
  const errors=state.accounts.filter(a=>a.error);
  $('syncProblems').hidden=!errors.length;
  $('syncProblems').textContent=errors.map(a=>`${a.email}: ${a.error}`).join(' · ');
  $('setupBanner').hidden=state.accounts.some(a=>a.provider!=='sample');
  $('demoButton').textContent=state.accounts.some(a=>a.provider==='sample')?'Sample emails loaded ✓':'Explore sample emails ↗';
  $('demoButton').disabled=state.accounts.some(a=>a.provider==='sample');
  $('accountList').innerHTML=state.accounts.map(a=>`<div class="account-mini"><span class="provider-mark">${a.provider==='sample'?'S':a.provider==='gmail'?'G':'O'}</span><div>${escape(a.email)}${a.provider==='sample'?'<small class="muted"> · sample</small>':''}${a.error?`<div class="error-text">${escape(a.error)}</div>`:''}</div><button data-disconnect="${escape(a.id)}" aria-label="Disconnect ${escape(a.email)}">×</button></div>`).join('');
  const labels={tasks:'Action desk',review:'Needs review',completed:'Completed',notes:'My notes'};
  $('viewLabel').textContent=labels[view];
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('selected',b.dataset.filter===filter));
  $('pageTitle').innerHTML={tasks:'Your next steps, <em>in focus.</em>',review:'A second look, <em>for certainty.</em>',completed:'Look at what <em>you’ve done.</em>',notes:'A little space <em>for your thoughts.</em>'}[view];
  $('pageSubtitle').textContent={tasks:'A little clarity for everything that needs you.',review:'Check the source, confirm the details, and decide what matters.',completed:'Your finished actions, kept together.',notes:'Your original SmartNotes workspace, with a clearer view.'}[view];
  $('newButton').textContent=view==='notes'?'+ New note':'+ New task';
  $('listTitle').textContent={tasks:'On your radar',review:'Suggested actions & updates',completed:'Off your list',notes:'Your notebook'}[view];
  $('filterTabs').hidden=view==='notes';
  $('sortSelect').hidden=view==='notes';
  $('noteCategoryFilter').hidden=view!=='notes';
  const query=$('searchInput').value.trim().toLowerCase();
  let items=view==='notes'?state.notes:state.tasks.filter(t=>view==='review'?isReview(t):view==='completed'?t.status==='completed':t.status==='open');
  items=items.filter(t=>JSON.stringify([t.title,t.summary,t.content,t.category,t.evidence,state.accounts.find(a=>a.id===t.accountId)?.email]).toLowerCase().includes(query));
  if(view==='notes' && $('noteCategoryFilter').value!=='all')items=items.filter(n=>n.category===$('noteCategoryFilter').value);
  if(view!=='notes') {
    if(filter==='high')items=items.filter(t=>t.priority==='high');
    if(filter==='soon')items=items.filter(t=>t.deadline && Date.parse(t.deadline)-Date.now()<=86400000);
    const rank={high:0,medium:1,low:2}, deadline=t=>t.deadline?Date.parse(t.deadline):Infinity;
    items.sort((a,b)=>$('sortSelect').value==='deadline'?deadline(a)-deadline(b)||rank[a.priority]-rank[b.priority]:rank[a.priority]-rank[b.priority]||deadline(a)-deadline(b));
  }
  $('resultCount').textContent=`${items.length} ${view==='notes'?'notes':'actions'}`;
  $('items').innerHTML=items.length?items.map(view==='notes'?noteCard:taskCard).join(''):`<div class="empty"><span class="little-spark">✧</span><h3>${query?'Nothing matches your search':view==='review'?'Everything looks clear':view==='completed'?'Room for a small win':view==='notes'?'Keep a thought here':'A clearer day starts here'}</h3><p>${view==='tasks'?'Connect an email account, try sample emails, or add your first task.':view==='notes'?'Create a note or import your original SmartNotes export.':'Your actions will appear here when they’re ready.'}</p>${view==='tasks'?'<button class="primary" data-open-accounts>Connect email</button>':''}</div>`;
  const failures=state.messages.filter(m=>m.analysisError);
  if(failures.length && view==='review') $('items').insertAdjacentHTML('afterbegin',`<div class="info-box"><strong>Some emails could not be analyzed</strong><p>These are not counted as successfully checked. Retry Check mail or inspect them yourself.</p>${failures.map(m=>`<p><button class="text-link" data-failed="${escape(m.id)}">${escape(m.subject || '(No subject)')} →</button></p>`).join('')}</div>`);
  if(view==='notes')document.querySelectorAll('.note-card').forEach((card,i)=>{const color=items[i]?.color;if(/^#[0-9a-f]{6}$/i.test(color))card.style.borderLeft=`4px solid ${color}`;});
  $('todayDate').textContent=new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
  const next=[...open].filter(t=>t.deadline).sort((a,b)=>Date.parse(a.deadline)-Date.parse(b.deadline))[0];
  $('nextDeadline').textContent=next?`${next.title} · ${date(next.deadline)}`:'Your next deadline will appear here.';
}
function taskCard(t) {
  const account=state.accounts.find(a=>a.id===t.accountId),proposal=t.proposal;
  return `<article class="task-card"><button class="check-task" data-action="${t.status==='completed'?'reopen':'complete'}" data-id="${escape(t.id)}" aria-label="${t.status==='completed'?'Reopen':'Complete'} ${escape(t.title)}">${t.status==='completed'?'✓':''}</button><div class="task-main"><div class="task-top"><button class="task-title" data-detail="${escape(t.id)}">${escape(t.title)}</button><span class="priority ${escape(t.priority)}">${escape(t.priority)}</span></div><p class="task-summary">${escape(proposal?`Follow-up: ${proposal.summary}`:t.summary || 'A next step worth making time for.')}</p><div class="task-meta"><span class="deadline ${t.deadline && Date.parse(t.deadline)<Date.now()?'overdue':''}">◷ ${escape(date(t.deadline))}</span><span>${escape(account?.email || 'Added by you')}${account?.provider==='sample'?' · SAMPLE':''}</span>${t.folder?`<span class="${t.folder==='spam'?'spam':''}">${escape(t.folder)}</span>`:''}${proposal?'<span>Update needs review</span>':''}${t.snoozedUntil && Date.parse(t.snoozedUntil)>Date.now()?'<span>Snoozed 1 hour</span>':''}</div>${isReview(t)?`<div class="review-actions"><button data-detail="${escape(t.id)}">Review source & ${proposal?'update':'accept'}</button><button data-action="dismiss" data-id="${escape(t.id)}">Dismiss</button></div>`:''}</div><button class="task-menu" data-edit="${escape(t.id)}" aria-label="Edit ${escape(t.title)}">⋯</button></article>`;
}
function noteCard(n) {return `<article class="task-card note-card"><div class="task-main"><div class="task-top"><button class="task-title" data-note="${escape(n.id)}">${escape(n.title)}</button><span class="priority low">${escape(n.category)}</span></div><p class="task-summary">${escape(n.content)}</p><div class="task-meta"><span>${escape(date(n.updatedAt || n.createdAt))}</span><button data-delete-note="${escape(n.id)}">Delete</button></div></div><button data-note="${escape(n.id)}" aria-label="Edit note">✎</button></article>`;}
function openEditor(kind,id) {
  editorKind=kind;const item=(kind==='note'?state.notes:state.tasks).find(t=>t.id===id);
  $('editId').value=id || '';$('editTitle').value=item?.title || '';$('editContent').value=item?.content || item?.summary || '';
  $('editPriority').value=item?.priority || 'medium';$('editCategory').value=item?.category || 'personal';$('editColor').value=/^#[0-9a-f]{6}$/i.test(item?.color)?item.color:'#ffffff';
  $('editDeadline').value=item?.deadline?new Date(Date.parse(item.deadline)-new Date(item.deadline).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  $('taskFields').hidden=kind==='note';$('noteFields').hidden=kind!=='note';$('editorTitle').textContent=`${id?'Edit':'New'} ${kind}`;show('editor');
}
function openDetail(id) {
  const t=state.tasks.find(t=>t.id===id);if(!t)return;
  const p=t.proposal;
  const messages=state.messages.filter(m=>(t.sourceIds || []).includes(m.id));
  $('detailContent').innerHTML=`<h3>${escape(t.title)}</h3><p>${escape(t.summary)}</p><div class="info-box"><strong>${escape(date(t.deadline))}</strong><br>${escape(t.priority)} priority ${t.confidence!=null?`· ${Math.round(t.confidence*100)}% model confidence (not a guarantee)`:''}</div>${t.folder==='spam'?'<div class="info-box">This message came from spam. Check the sender independently before following any links.</div>':''}${p?`<section class="email-source"><h4>Proposed follow-up change</h4><p>${escape(p.title)}</p><p>${escape(p.summary)}</p><p>Deadline: ${escape(date(p.deadline))}</p><p>${p.completed?'The email suggests this task is complete.':''}</p><blockquote>${escape(p.evidence)}</blockquote></section>`:`${t.evidence?`<blockquote>${escape(t.evidence)}</blockquote>`:''}`}${messages.map(m=>`<section class="email-source"><h4>${escape(m.subject)}</h4><small>${escape(m.sender)} · ${escape(date(m.receivedAt))} · ${escape(m.folder)}</small><pre>${escape(m.body)}</pre>${safeMailLink(m.link)?`<a href="${escape(m.link)}" target="_blank" rel="noopener noreferrer">Open original email ↗</a>`:'<small>Sample email — no real mailbox link</small>'}</section>`).join('')}<div class="dialog-actions">${isReview(t)?`<button class="primary" data-action="accept" data-id="${escape(t.id)}">${p?'Approve update':'Accept task'}</button>`:''}<button class="secondary" data-edit="${escape(t.id)}">Edit details</button>${t.status==='open'?`<button class="secondary" data-action="snooze" data-id="${escape(t.id)}">Snooze 1 hour</button><button class="primary" data-action="complete" data-id="${escape(t.id)}">Mark complete</button>`:''}</div>${(t.history || []).length?`<h4>History</h4>${t.history.map(h=>`<p class="muted">${escape(date(h.at))}: ${escape(h.message)}<br>${escape(date(h.previousDeadline))} → ${escape(date(h.proposedDeadline))}</p>`).join('')}`:''}`;
  if(!$('details').open)show('details');
}
function safeMailLink(value) {try{const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password && !u.port && ['mail.google.com','outlook.live.com','outlook.office.com','outlook.office365.com'].includes(u.hostname);}catch{return false;}}
function openAccounts() {
  $('providerOptions').innerHTML=['gmail','outlook'].map(p=>`<div class="provider-option"><div><strong>${p==='gmail'?'Gmail / Google Workspace':'Outlook / Microsoft 365'}</strong><small>${state.configuration[p]?'Read-only access · multiple accounts supported':'Setup required: add provider credentials and encryption key to .env'}</small></div><button class="primary" data-connect="${p}" ${state.configuration[p]?'':'disabled'}>Connect</button></div>`).join('');show('accounts');
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b || b.disabled)return;
  try {
    if(b.dataset.openAccounts!==undefined)openAccounts();
    if(b.dataset.connect)location.href=`/auth/${b.dataset.connect}`;
    if(b.dataset.detail)openDetail(b.dataset.detail);
    if(b.dataset.failed) {const m=state.messages.find(m=>m.id===b.dataset.failed);$('detailContent').innerHTML=`<h3>${escape(m.subject)}</h3><p class="muted">${escape(m.sender)} · ${escape(m.analysisError)}</p><section class="email-source"><pre>${escape(m.body)}</pre>${safeMailLink(m.link)?`<a href="${escape(m.link)}" target="_blank" rel="noopener noreferrer">Open original email ↗</a>`:''}</section><p>Add a manual task using New task if this message needs action.</p>`;show('details');}
    if(b.dataset.edit){$('details').close();openEditor('task',b.dataset.edit);}
    if(b.dataset.note)openEditor('note',b.dataset.note);
    if(b.dataset.action){await api(`/tasks/${b.dataset.id}`,'PATCH',{action:b.dataset.action});$('details').close();await refresh();toast('Task updated');}
    if(b.dataset.deleteNote && confirm('Delete this note?')) {await api(`/notes/${b.dataset.deleteNote}`,'DELETE');await refresh();}
    if(b.dataset.disconnect && confirm('Disconnect this account and remove its imported emails and tasks from SmartNotes?')) {await api(`/accounts/${b.dataset.disconnect}`,'DELETE');await refresh();}
  } catch(error){toast(error.message);}
});
on('searchInput','input',()=>render());on('sortSelect','change',()=>render());
on('noteCategoryFilter','change',()=>render());
on('newButton','click',()=>openEditor(view==='notes'?'note':'task'));
on('connectButton','click',openAccounts);on('accountAdd','click',openAccounts);on('reviewLink','click',()=>setView('review'));
on('topAccounts','click',openAccounts);on('topSettings','click',()=>$('settingsButton').click());
on('syncButton','click',async()=>{await api('/sync','POST');await refresh();toast('Checking connected accounts');});
on('demoButton','click',async()=>{await api('/demo','POST');await refresh();});
on('editorForm','submit',async e=>{
  e.preventDefault();const id=$('editId').value;
  if(editorKind==='note') await api('/notes','POST',{id,title:$('editTitle').value,content:$('editContent').value,category:$('editCategory').value,color:$('editColor').value});
  else await api(id?`/tasks/${id}`:'/tasks',id?'PATCH':'POST',{title:$('editTitle').value,summary:$('editContent').value,deadline:$('editDeadline').value?new Date($('editDeadline').value).toISOString():null,priority:$('editPriority').value});
  $('editor').close();await refresh();toast('Saved');
});
on('settingsButton','click',()=>{
  $('autoSetting').checked=state.settings.autoCreate;$('soundSetting').checked=state.settings.sound;
  $('pushStatus').textContent='Notification permission: '+('Notification' in window?Notification.permission:'unsupported browser');
  $('modelStatus').textContent=state.configuration.ai?`AI reader: ${state.configuration.model}. Email text is sent to Gemini for analysis.`:'AI reader is not configured. Add GEMINI_API_KEY in .env for real mail.';show('settings');
});
for(const [element,key] of [['autoSetting','autoCreate'],['soundSetting','sound']]) on(element,'change',async()=>{await api('/settings','POST',{[key]:$(element).checked});await refresh();});
on('themeButton','click',()=>{document.documentElement.classList.toggle('dark');storageSet('smartNotesTheme',document.documentElement.classList.contains('dark')?'dark':'light');});
if(storageGet('smartNotesTheme')==='dark')document.documentElement.classList.add('dark');
on('enablePush','click',async()=>{
  if(!('serviceWorker' in navigator) || !('PushManager' in window))throw new Error('This browser does not support background push notifications');
  if(await Notification.requestPermission()!=='granted')throw new Error('Allow notifications in your browser settings to receive alerts');
  const registration=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
  const {key}=await api('/push-key');const bytes=Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-key.length%4)%4)),c=>c.charCodeAt(0));
  const subscription=await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
  await api('/push','POST',subscription.toJSON());$('pushStatus').textContent='Browser notifications enabled. Keep your SmartNotes server running.';toast('Notifications enabled');
});
on('bellButton','click',()=>{
  $('notificationList').innerHTML=state.notifications.length?state.notifications.map(n=>`<article class="notification ${n.read?'':'unread'}"><strong>${escape(n.title)}</strong><p>${escape(n.message)}</p><small class="muted">${escape(date(n.createdAt))}</small></article>`).join(''):'<p class="muted">A little quiet. Your reminders will appear here.</p>';show('notifications');
});
on('readButton','click',async()=>{await api('/read','POST');$('notifications').close();await refresh();});
on('exportButton','click',()=>{
  const copy={...state,configuration:undefined};const blob=new Blob([JSON.stringify(copy,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`smartnotes-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
async function importNotes(notes) {
  if(!Array.isArray(notes))throw new Error('Choose a SmartNotes JSON notes export');
  const valid=notes.filter(n=>n && typeof n.title==='string' && n.title.trim() && typeof n.content==='string');
  if(valid.length!==notes.length)throw new Error('Some entries are not valid notes');
  for(const n of valid)await api('/notes','POST',{...n,id:typeof n.id==='string'?n.id:undefined});
  await refresh();toast(`${valid.length} notes imported`);
}
on('importButton','click',()=>$('importFile').click());on('importFile','change',async e=>{const f=e.target.files[0];if(!f)return;if(f.size>2e6)throw new Error('Choose a file smaller than 2 MB');const data=JSON.parse(await f.text());await importNotes(Array.isArray(data)?data:data.notes);e.target.value='';});
try {
  await refresh(true);
  // Same-origin migration is explicit and keeps the original browser copy intact.
  try {
    const old=JSON.parse(storageGet('smartNotes') || '[]');
    if(Array.isArray(old) && old.length && !storageGet('smartNotesMigratedV2') && confirm(`Import your ${old.length} original SmartNotes notes into the new workspace?`)){await importNotes(old);storageSet('smartNotesMigratedV2','yes');}
  } catch {toast('Previous browser notes could not be imported. Your new workspace is ready; you can import a valid JSON export in Settings.');}
}catch(error){toast(`Could not load SmartNotes: ${error.message}`);}
setInterval(()=>refresh().catch(()=>{$('syncStatus').textContent='Server disconnected — reminders paused';}),10000);
