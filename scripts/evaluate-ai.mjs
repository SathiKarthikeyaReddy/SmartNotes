import { readFile, writeFile } from 'node:fs/promises';
import { analyze } from '../mail.js';
import { validateAnalysis } from '../core.js';
if(!process.argv.includes('--live')) {console.log('Not run: use npm run test:ai:live with your server-side Gemini key. This sends only the synthetic test emails and incurs API usage.');process.exit(0);}
if(!process.env.GEMINI_API_KEY){console.error('Not run: GEMINI_API_KEY is missing. No email was sent.');process.exit(2);}
const cases=JSON.parse(await readFile(new URL('../test-data/ai-cases.json',import.meta.url),'utf8'));
const results=[];
for(const c of cases){
  const messages=c.emails.map((body,i)=>({id:`synthetic-${i}`,subject:c.name,sender:'synthetic@example.com',folder:c.folder || 'inbox',receivedAt:new Date(Date.parse('2026-11-03T06:00:00Z')+i*60000).toISOString(),body}));
  try {
    const actual=validateAnalysis(await analyze(messages,c.existing),messages);
    const mismatches=Object.entries(c.expected).filter(([k,v])=>actual[k]!==v).map(([k,v])=>`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual[k])}`);
    results.push({name:c.name,status:mismatches.length?'FAIL':'PASS',mismatches,actual});
  }catch(e){results.push({name:c.name,status:'ERROR',error:e.message});}
}
const report={model:process.env.GEMINI_MODEL || 'gemini-2.5-flash',ranAt:new Date().toISOString(),results};
const destination=process.argv.find(a=>a.startsWith('--output='))?.slice(9) || 'data/ai-evaluation.json';
await writeFile(destination,JSON.stringify(report,null,2));
const passed=results.filter(r=>r.status==='PASS').length;console.log(`${passed}/${results.length} live AI cases passed. Results: ${destination}`);if(passed!==results.length)process.exitCode=1;
