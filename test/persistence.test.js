import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { harness } from '../test-support/harness.mjs';
import { initialState, rankTasks, dueReminders } from '../core.js';
for(const [label,text] of [['truncated JSON','{"tasks":'],['null root','null'],['missing collections','{}'],['wrong collection type',JSON.stringify({...initialState(),tasks:{}})],['invalid settings',JSON.stringify({...initialState(),settings:{autoCreate:'yes'}})]])test(`corrupt state ${label} stops startup and preserves original file`,async()=>{
  const h=await harness();
  try{await h.stop();const file=path.join(h.dir,'state.json');await writeFile(file,text);await assert.rejects(h.start(),/exited/);assert.equal(await readFile(file,'utf8'),text);}finally{await h.close();}
});
test('sorting 10,000 tasks is deterministic and leaves data intact',()=>{
  const values=Array.from({length:10000},(_,i)=>({id:String(i),priority:['low','medium','high'][i%3],deadline:i%5===0?null:new Date(Date.UTC(2026,10,3)+(i%500)*60000).toISOString()}));
  const original=JSON.stringify(values),sorted=rankTasks(values);assert.equal(sorted.length,10000);assert.equal(new Set(sorted.map(t=>t.id)).size,10000);assert.equal(JSON.stringify(values),original);assert.equal(sorted[0].priority,'high');assert.equal(sorted.at(-1).priority,'low');
});
test('seeded mixed task simulation keeps reminder identities unique',()=>{
  let seed=73129;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/2**32);
  const now=Date.parse('2026-11-03T00:00:00Z'),s=initialState();
  s.tasks=Array.from({length:200},(_,i)=>({id:String(i),title:'Task',status:['open','review','completed','dismissed'][Math.floor(random()*4)],deadline:random()<.1?null:new Date(now+Math.floor(random()*172800000)).toISOString()}));
  for(let i=0;i<300;i++)dueReminders(s,now+i*600000);
  assert.equal(new Set(s.notifications.map(n=>n.key)).size,s.notifications.length);
  for(const t of s.tasks){const count=s.notifications.filter(n=>n.taskId===t.id).length;if(t.status!=='open' || !t.deadline)assert.equal(count,0);else assert.ok(count<=3);}
});
