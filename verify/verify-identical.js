// Proves the optimised engine returns exactly what the original returned.
// Run:  node verify/verify-identical.js
const OLD = require('../reference/precursor-engine.original.js');
const NEW = require('../lib/precursor-engine.js');

function mulberry32(a){return()=>{a=(a+0x6d2b79f5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}}
function randomDraws(n,seed){const rng=mulberry32(seed);const out=[];
 for(let i=0;i<n;i++){const pool=Array.from({length:80},(_,k)=>k+1);
  for(let j=79;j>0;j--){const k=Math.floor(rng()*(j+1));[pool[j],pool[k]]=[pool[k],pool[j]]}
  const m=(6*60+(i%300)*4);const h=Math.floor(m/60)%12||12;
  out.push({draw_id:3290000+i,draw_time:`${h}:${String(m%60).padStart(2,'0')} ${m>=720?'p.m.':'a.m.'}`,draw_date:'2026-06-01',numbers:pool.slice(0,20).sort((a,b)=>a-b)});}
 return out;}

const cases=[
  {n:1200,seed:11,t:[9,15,56,75,79]},
  {n:1500,seed:23,t:[3,13,17,28,50]},
  {n:1500,seed:37,t:[11,17,47,51,72]},
  {n:900, seed:41,t:[9,22,37,56,71]},
  {n:1500,seed:53,t:[2,24,37,44,61]},
  {n:1200,seed:67,t:[5,19,33,48,62]},
];
let identical=0, tOld=0, tNew=0;
for(const c of cases){
  const draws=randomDraws(c.n,c.seed);
  let s=Date.now(); const a=OLD.analyzePrecursors(draws.map(d=>({...d})),c.t); tOld+=Date.now()-s;
  s=Date.now();     const b=NEW.analyzePrecursors(draws.map(d=>({...d})),c.t); tNew+=Date.now()-s;
  const ja=JSON.stringify(a), jb=JSON.stringify(b);
  if(ja===jb){identical++;}
  else{
    console.log('MISMATCH seed',c.seed,'len',ja.length,'vs',jb.length);
    // locate first difference
    for(let i=0;i<Math.max(ja.length,jb.length);i++) if(ja[i]!==jb[i]){
      console.log('  at char',i,'\n  old:',ja.slice(Math.max(0,i-90),i+90),'\n  new:',jb.slice(Math.max(0,i-90),i+90));break}
  }
}
console.log('\nidentical outputs:',identical+'/'+cases.length);
console.log('original total: '+tOld+' ms   optimised total: '+tNew+' ms   speedup: '+(tOld/tNew).toFixed(1)+'x');
