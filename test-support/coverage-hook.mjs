import { takeCoverage } from 'node:v8';
// IPC is only opened by test harnesses. Flush real server counters before the
// Windows child is stopped; force-terminating it would lose coverage evidence.
process.on('message',message=>{
  if(message==='smartnotes-test-stop'){takeCoverage();process.exit(0);}
});
