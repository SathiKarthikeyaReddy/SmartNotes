export default async function* report(events){
  const tests=[];let summary={},coverage;
  for await(const event of events){
    if(event.type==='test:pass' || event.type==='test:fail')tests.push({name:event.data.name,file:event.data.file,status:event.type==='test:pass'?'PASS':'FAIL',nesting:event.data.nesting,durationMs:event.data.details?.duration_ms,error:event.data.details?.error?.message});
    if(event.type==='test:summary')summary=event.data;
    if(event.type==='test:coverage')coverage=event.data;
  }
  yield JSON.stringify({summary,coverage,tests},null,2)+'\n';
}
