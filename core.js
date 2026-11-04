import { randomUUID } from 'node:crypto';

export const DAY = 86400000;
export const id = () => randomUUID();
export function parseDeadline(value) {
  if(value == null) return null;
  const match=typeof value==='string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if(!match)throw new Error('Invalid deadline: use an ISO date with an explicit timezone');
  const [,year,month,day,hour,minute,second]=match;
  const leap=Number(year)%4===0 && (Number(year)%100!==0 || Number(year)%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(+month<1 || +month>12 || +day<1 || +day>days[+month-1] || +hour>23 || +minute>59 || +(second || 0)>59 || !Number.isFinite(Date.parse(value)))throw new Error('Invalid deadline: calendar date or time does not exist');
  return new Date(value).toISOString();
}
export const initialState = () => ({ tasks: [], notes: [], accounts: [], messages: [], notifications: [], subscriptions: [], settings: { autoCreate: true, sound: false, reminders: [1440, 60] } });
export function validateSavedState(saved) {
  if(!saved || typeof saved!=='object' || Array.isArray(saved))throw new Error('Invalid saved workspace; restore a valid backup');
  for(const name of ['tasks','notes','accounts','messages','notifications','subscriptions']) {
    if(!Array.isArray(saved[name]) || saved[name].some(item=>!item || typeof item!=='object' || Array.isArray(item)))throw new Error(`Invalid saved workspace collection: ${name}`);
  }
  const settings=saved.settings;
  if(!settings || typeof settings!=='object' || Array.isArray(settings) || typeof settings.autoCreate!=='boolean' || typeof settings.sound!=='boolean')throw new Error('Invalid saved settings');
  if(!Array.isArray(settings.reminders) || settings.reminders.some(n=>typeof n!=='number' || !Number.isFinite(n) || n<0))throw new Error('Invalid saved reminders');
  return saved;
}
export function validateAnalysis(raw, messages) {
  if (!raw || typeof raw.actionable !== 'boolean') throw new Error('AI returned an invalid action result');
  if (!raw.actionable) return { actionable: false };
  if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 240) throw new Error('AI returned an invalid task title');
  const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim() : '';
  // Evidence must be verbatim in a source message, not an invented explanation.
  if (!evidence || !messages.some(m => `${m.subject}\n${m.body}`.includes(evidence))) throw new Error('AI evidence could not be verified against the email');
  const deadline = parseDeadline(raw.deadline);
  return { actionable: true, title: raw.title.trim(), summary: String(raw.summary || '').slice(0, 2000), evidence, deadline,
    priority: ['high','medium','low'].includes(raw.priority) ? raw.priority : 'medium', confidence: typeof raw.confidence==='number' && Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0,
    uncertain: raw.uncertain !== false, completed: raw.completed === true, cancelled: raw.cancelled === true };
}
export function addNotification(state, task, message, key) {
  if (state.notifications.some(n => n.key === key)) return;
  state.notifications.unshift({ id: id(), taskId: task.id, title: task.title, message, key, createdAt: new Date().toISOString(), read: false, pushed: false });
}
export function applyAnalysis(state, account, messages, analysis, now = Date.now()) {
  if (!analysis.actionable) return null;
  if(!Array.isArray(messages) || !messages.length || !messages[0]?.threadId)throw new Error('A nonempty email conversation is required');
  const thread = messages[0].threadId;
  if(messages.some(m=>!m.id || m.threadId!==thread))throw new Error('Messages must belong to one conversation');
  if(messages.some(m=>m.accountId && m.accountId!==account.id))throw new Error('Source message belongs to another account');
  let task = state.tasks.find(t => t.accountId === account.id && t.threadId === thread);
  if(analysis.cancelled && !task)return null;
  const latest = [...messages].sort((a,b) => Date.parse(b.receivedAt)-Date.parse(a.receivedAt))[0];
  const risky = messages.some(m => m.folder === 'spam');
  const review = risky || analysis.uncertain || analysis.confidence < .9 || !analysis.deadline || analysis.completed || analysis.cancelled || !state.settings.autoCreate || (task && task.status !== 'open');
  const candidate = { title: analysis.title, summary: analysis.summary, deadline: analysis.deadline, priority: analysis.priority, evidence: analysis.evidence, confidence: analysis.confidence, completed: analysis.completed, cancelled:analysis.cancelled === true };
  const signature=JSON.stringify([messages.map(m=>m.id).sort(),candidate,risky ? 'spam' : latest.folder]);
  if(task?.analysisSignature===signature)return task;
  if (task) {
    task.history ||= [];
    task.history.unshift({ at: new Date(now).toISOString(), message: review ? 'Follow-up needs review' : 'Updated from follow-up email', previousDeadline: task.deadline, proposedDeadline: analysis.deadline });
    task.sourceIds = messages.map(m => m.id);
    task.folder = risky ? 'spam' : latest.folder;
    if (review) task.proposal = candidate;
    else { Object.assign(task, candidate); task.proposal = null; task.snoozedUntil = null; }
    task.updatedAt = new Date(now).toISOString();
    addNotification(state, task, review ? 'Review a follow-up before changing this task.' : 'A follow-up updated this task and its reminders.', `update:${task.id}:${latest.id}`);
  } else {
    task = { id: id(), ...candidate, accountId: account.id, threadId: thread, sourceIds: messages.map(m => m.id), folder: risky ? 'spam' : latest.folder, status: review ? 'review' : 'open', proposal: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), history: [] };
    state.tasks.unshift(task);
    addNotification(state, task, review ? 'An email may need your attention. Review the suggested task.' : 'New email task created.', `created:${task.id}`);
  }
  task.analysisSignature=signature;
  task.revision=(task.revision || 0)+1;
  return task;
}
export function dueReminders(state, now = Date.now()) {
  for (const t of state.tasks) {
    if (t.status !== 'open' || !t.deadline || (t.snoozedUntil && Date.parse(t.snoozedUntil) > now)) continue;
    const due = Date.parse(t.deadline);
    const offsets = [...state.settings.reminders].sort((a,b) => a-b);
    // If several thresholds passed while offline, emit only the most relevant one.
    const offset = due <= now ? 0 : offsets.find(m => due-now <= m*60000);
    if (offset == null) continue;
    addNotification(state, t, offset === 0 ? 'This task is overdue.' : `Due within ${offset >= 60 ? `${offset/60} hours` : `${offset} minutes`}.`, `reminder:${t.id}:${t.deadline}:${offset}:${t.snoozedUntil || ''}`);
  }
}
export function rankTasks(tasks, sort = 'priority') {
  return [...tasks].sort((a,b) => {
    const urgency = t => ({high:0,medium:1,low:2}[t.priority] ?? 1);
    const date = t => t.deadline ? Date.parse(t.deadline) : Infinity;
    return sort === 'deadline' ? date(a)-date(b) || urgency(a)-urgency(b) : urgency(a)-urgency(b) || date(a)-date(b);
  });
}
