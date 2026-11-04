import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyAnalysis, validateAnalysis, dueReminders, DAY, rankTasks } from '../core.js';
const now=Date.parse('2026-11-03T06:00:00Z');
const account={id:'a',email:'you@example.com'};
const mail={id:'m1',threadId:'thread',body:'Complete the assessment by November 5.',subject:'Assessment',receivedAt:new Date(now).toISOString(),folder:'promotions'};
const result={actionable:true,title:'Complete assessment',summary:'Finish your assessment',deadline:new Date(now+2*DAY).toISOString(),priority:'high',evidence:mail.body,confidence:.98,uncertain:false,completed:false};
test('auto creates confident action and routes spam/ambiguous deadlines to review',()=>{
  for(const [message,analysis,status] of [[mail,result,'open'],[{...mail,folder:'spam'},result,'review'],[mail,{...result,deadline:null},'review'],[mail,{...result,uncertain:true},'review']]){
    const s=initialState();assert.equal(applyAnalysis(s,account,[message],analysis,now).status,status);
  }
});
test('follow-up revises same task, stores previous deadline, and reschedules reminder',()=>{
  const s=initialState();const t=applyAnalysis(s,account,[mail],result,now);const before=t.deadline;
  const follow={...mail,id:'m2',receivedAt:new Date(now+1000).toISOString()};
  applyAnalysis(s,account,[mail,follow],{...result,deadline:new Date(now+4*DAY).toISOString()},now+1000);
  assert.equal(s.tasks.length,1);assert.notEqual(t.deadline,before);assert.equal(t.history[0].previousDeadline,before);
  dueReminders(s,now+DAY);assert.equal(s.notifications.filter(n=>n.key.startsWith('reminder:')).length,0);
});
test('uncertain follow-up preserves accepted deadline until approval',()=>{
  const s=initialState();const t=applyAnalysis(s,account,[mail],result,now);
  applyAnalysis(s,account,[{...mail,id:'m2'}],{...result,uncertain:true,deadline:null},now+1);
  assert.equal(t.deadline,result.deadline);assert.equal(t.proposal.deadline,null);
});
test('completed tasks never automatically reopen or auto complete another task',()=>{
  const s=initialState();const t=applyAnalysis(s,account,[mail],result,now);t.status='completed';
  applyAnalysis(s,account,[{...mail,id:'m2'}],result,now+1);assert.equal(t.status,'completed');assert.ok(t.proposal);
});
test('accounts with equal thread IDs cannot merge tasks',()=>{
  const s=initialState();applyAnalysis(s,account,[mail],result,now);applyAnalysis(s,{id:'b'},[mail],result,now);assert.equal(s.tasks.length,2);
});
test('AI output requires literal evidence and an explicit deadline timezone',()=>{
  assert.throws(()=>validateAnalysis({...result,evidence:'Invented quote'},[mail]),/evidence/);
  assert.throws(()=>validateAnalysis({...result,deadline:'2026-11-05T09:00:00'},[mail]),/deadline/);
  assert.equal(validateAnalysis(result,[mail]).deadline,result.deadline);
});
test('reminder thresholds are deduplicated, completed tasks skipped, snooze respected',()=>{
  const s=initialState();const t=applyAnalysis(s,account,[mail],result,now);
  dueReminders(s,now+DAY);dueReminders(s,now+DAY+1000);
  assert.equal(s.notifications.filter(n=>n.key.startsWith('reminder:')).length,1);
  t.snoozedUntil=new Date(now+2*DAY+10000).toISOString();dueReminders(s,now+2*DAY);assert.equal(s.notifications.length,2);
  dueReminders(s,now+2*DAY+20000);assert.equal(s.notifications.length,3);
  t.status='completed';dueReminders(s,now+3*DAY);assert.equal(s.notifications.length,3);
});
test('coming online late sends only relevant overdue reminder',()=>{
  const s=initialState();applyAnalysis(s,account,[mail],result,now);dueReminders(s,now+3*DAY);
  assert.equal(s.notifications.length,2);assert.match(s.notifications[0].message,/overdue/);
});
test('priority and deadline ordering are explicit',()=>{
  const a={priority:'low',deadline:new Date(now).toISOString()},b={priority:'high',deadline:new Date(now+DAY).toISOString()};
  assert.equal(rankTasks([a,b])[0],b);assert.equal(rankTasks([a,b],'deadline')[0],a);
});
