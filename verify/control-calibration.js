// Control experiment: runs the engine on purely random draws and reports how
// often each status fires. Takes about 2.5 minutes.
// Run:  node verify/control-calibration.js
const { analyzePrecursors } = require('../lib/precursor-engine.js');
function mulberry32(a){return()=>{a=(a+0x6d2b79f5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}}
function randomDraws(n,seed){const rng=mulberry32(seed);const out=[];
 for(let i=0;i<n;i++){const pool=Array.from({length:80},(_,k)=>k+1);
  for(let j=79;j>0;j--){const k=Math.floor(rng()*(j+1));[pool[j],pool[k]]=[pool[k],pool[j]]}
  const m=(6*60+(i%300)*4);const h=Math.floor(m/60)%12||12;
  out.push({draw_id:3290000+i,draw_time:`${h}:${String(m%60).padStart(2,'0')} ${m>=720?'p.m.':'a.m.'}`,draw_date:'2026-06-01',numbers:pool.slice(0,20).sort((a,b)=>a-b)});}
 return out;}
const targets=[[9,15,56,75,79],[3,13,17,28,50],[11,17,47,51,72],[9,17,37,51,56],[9,22,37,56,71],[2,24,37,44,61],[5,19,33,48,62],[7,21,44,58,66]];
const status={}; const lifts=[],rates=[],scores=[]; let n=0,val4=0;
const t0=Date.now();
outer:
for(let seed=1;seed<=40;seed++){
  const draws=randomDraws(3000,seed*104729);
  for(const t of targets){
    if(Date.now()-t0>250000) break outer;
    const r=analyzePrecursors(draws,t); if(!r.ok) continue;
    const f=r.hitTierForecast; if(!f) continue;
    n++; status[f.status]=(status[f.status]||0)+1;
    if(f.validatedFourPlus) val4++;
    scores.push(f.fourPlusScore||0);
    const c=f.fourPlusOutcomeCalibration;
    if(c){lifts.push(c.lift||0); rates.push(c.successRate||0);}
  }
}
const out = require('path').join(require('os').tmpdir(), 'calib.json');
require('fs').writeFileSync(out, JSON.stringify({ n, val4, status, lifts, rates, scores }));
console.log('live checks on purely random draws:',n,' elapsed',((Date.now()-t0)/1000).toFixed(0)+'s');
console.log('status:',JSON.stringify(status));
console.log('validatedFourPlus fired:',val4);
