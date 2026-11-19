// Bounded, read-only load probe. Never calls refresh or external feed URLs.
// Usage: node scripts/performance-load.mjs [base URL] [output JSON] [profile]
import http from 'node:http';
import https from 'node:https';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const base = process.argv[2] || 'https://tab1.net';
const output = process.argv[3] || 'performance/2026-11-16/load-public.json';
const profile = process.argv[4] || 'mixed';
const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 100 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 100 }) };
const sources = '/api/sources?ids=bbc.top,bbc.world,football.1,football.2,football.3,guardian.top,guardian.world,sky.top,sky.world';
const paths = ['/', '/api/feeds.json', sources, '/api/feeds.json', sources, '/', '/api/feeds.json', sources, '/api/catalogue.json', '/static/style.css'];
const etags = new Map();
let active = 0, stop = false;
const records = [], phases = [];
const quantile = (xs, q) => xs.length ? [...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*q)-1] : 0;
async function request(path, phase, conditional = true) {
  const start = performance.now(); active++;
  const result = await new Promise(resolve => {
    const url = new URL(path, base);
    const headers = { 'User-Agent': 'tab1.net-owner-performance-review/1.0', 'Accept-Encoding': 'gzip', 'Accept-Language': 'en-GB' };
    if (conditional && etags.has(path)) headers['If-None-Match'] = etags.get(path);
    const req = (url.protocol === 'https:' ? https : http).get(url, { agent: agents[url.protocol], headers }, res => {
      const ttfb = performance.now()-start;
      let bytes = 0;
      res.on('data', b => { bytes += b.length; });
      res.on('end', () => {
        if (res.headers.etag) etags.set(path, res.headers.etag);
        resolve({ status: res.statusCode, bytes, ttfb, cache: res.headers['cf-cache-status'], encoding: res.headers['content-encoding'], etag: res.headers.etag });
      });
      res.on('error', e => resolve({ status: 0, error: e.message }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('5s request timeout')));
    req.on('error', e => resolve({ status: 0, error: e.message }));
  });
  active--;
  const record = { phase, path, at: new Date().toISOString(), ms: performance.now()-start, ...result };
  records.push(record);
  const recent = records.slice(-50);
  if (recent.length === 50 && (recent.filter(r => r.status === 0 || r.status >= 400).length > 1 || quantile(recent.map(r=>r.ms), .95) > 2000)) stop = true;
}
function summarize(name, started, count, skipped) {
  const rows = records.slice(count), statuses = {}, caches = {};
  for (const r of rows) { statuses[r.status] = (statuses[r.status]||0)+1; caches[r.cache||'none'] = (caches[r.cache||'none']||0)+1; }
  const summary = { name, count: rows.length, skipped, durationSeconds: (performance.now()-started)/1000, p50: quantile(rows.map(r=>r.ms),.5), p95:quantile(rows.map(r=>r.ms),.95), p99:quantile(rows.map(r=>r.ms),.99), max: Math.max(...rows.map(r=>r.ms)), statuses, caches, bytes:rows.reduce((s,r)=>s+(r.bytes||0),0), stopped:stop };
  phases.push(summary); console.log(JSON.stringify(summary));
}
try {
  for (const path of [...new Set(paths)]) await request(path, 'warmup', false);
  const plan = profile === 'soak500-30m' ? [[500/60,1800]] : profile === 'soak500' ? [[500/60,300]] : profile === 'varied' ? [[17,30]] : profile === 'poll500' ? [[500/60,60]] : profile === 'origin' ? [[5,15],[20,20],[50,20]] : [[5,20],[17,30],[35,30],[60,30]];
  for (const [rate, seconds] of plan) {
    if (stop) break;
    const name = `${profile}-${rate.toFixed(2)}-${seconds}s`, started = performance.now(), count=records.length;
    let skipped=0;
    const pending=[];
    for (let i=0;i<Math.round(rate*seconds) && !stop;i++) {
      const delay=started+i*1000/rate-performance.now();
      if(delay>0) await new Promise(r=>setTimeout(r,delay));
      if(active>=80) { skipped++; continue; }
      if (i > 0 && i % Math.round(rate*60) === 0) {
        const recent = records.slice(-1000);
        console.log(JSON.stringify({ progress: name, elapsedSeconds: Math.round((performance.now()-started)/1000), completed: records.length-count, errors: recent.filter(r=>r.status===0||r.status>=400).length, p95: quantile(recent.map(r=>r.ms),.95) }));
      }
      if(profile==='poll500' || profile==='soak500' || profile==='soak500-30m') pending.push(request('/api/feeds.json',name),request(sources,name));
      else if(profile==='varied') {
        const ids=sources.split('=')[1].split(',').filter((_,bit)=>((i%511+1)&(1<<bit)));
        pending.push(request('/api/sources?ids='+ids.join(','),name,false));
      }
      else pending.push(request(paths[i%paths.length],name,paths[i%paths.length]!=='/'));
    }
    await Promise.all(pending); summarize(name,started,count,skipped);
  }
  if (!stop && profile === 'mixed') {
    const started=performance.now(), count=records.length;
    await Promise.all(Array.from({length:100},()=>request('/','100-simultaneous-html',false)));
    summarize('100-simultaneous-html',started,count,0);
  }
} finally {
  await writeFile(output, JSON.stringify({ base, profile, date:new Date().toISOString(), guardrails:'max 80 ongoing during scheduled phases, 5s timeout; stop at >1 failure / 50 or p95 >2s; final HTML burst capped at 100', phases, records },null,2));
  Object.values(agents).forEach(a=>a.destroy());
}
process.exitCode=stop?2:0;
