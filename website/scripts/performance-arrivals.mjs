// Replay only first-party requests from a measured first navigation, not external images.
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const dir = process.argv[2] || 'performance/2026-11-16';
const entries = JSON.parse(await readFile(`${dir}/desktop.har`)).log.entries;
const secondDocument = entries.findIndex((e,i)=>i>0 && e.request.url==='https://tab1.net/');
const urls = [...new Set(entries.slice(0,secondDocument).map(e=>e.request.url).filter(u=>new URL(u).origin==='https://tab1.net'))];
const requests=[], visits=[], pending=[];
let stop=false;
async function request(url,visit) {
  const start=performance.now();
  try {
    const r=await fetch(url,{headers:{'User-Agent':'tab1.net-owner-performance-review/1.0'},signal:AbortSignal.timeout(5000)});
    const body=await r.arrayBuffer();
    requests.push({visit,url,status:r.status,cache:r.headers.get('cf-cache-status'),ms:performance.now()-start,decodedBytes:body.byteLength});
    if(!r.ok) stop=true;
  } catch(e) {requests.push({visit,url,status:0,error:e.message,ms:performance.now()-start});stop=true;}
}
async function visit(id) {
  const start=performance.now();
  await request('https://tab1.net/',id);
  let i=1;
  await Promise.all(Array.from({length:6},async()=>{while(i<urls.length && !stop)await request(urls[i++],id);}));
  const ms=performance.now()-start;visits.push({id,ms});if(ms>5000)stop=true;
}
const started=performance.now();
for(let i=0;i<100 && !stop;i++) {
  const delay=started+i*500-performance.now();if(delay>0)await new Promise(r=>setTimeout(r,delay));
  pending.push(visit(i));
}
await Promise.all(pending);
const p=(xs,q)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*q)-1];
const counts=key=>Object.fromEntries([...new Set(requests.map(r=>r[key]))].map(v=>[v,requests.filter(r=>r[key]===v).length]));
const summary={visits:visits.length,requests:requests.length,urlsPerVisit:urls.length,durationSeconds:(performance.now()-started)/1000,visitP50:p(visits.map(v=>v.ms),.5),visitP95:p(visits.map(v=>v.ms),.95),requestP95:p(requests.map(v=>v.ms),.95),statuses:counts('status'),caches:counts('cache'),stopped:stop};
console.log(JSON.stringify(summary));
await writeFile(process.argv[3] || `${dir}/load-arrivals.json`,JSON.stringify({description:'100 first-party HAR replays; 2 arrivals/second; six parallel resource requests per visit; no rendering or third-party load; see review for overlapping workloads',summary,visits,requests},null,2));
