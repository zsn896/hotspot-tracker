'use strict';
// Fixed experiment: discovery 60%, calibration 20%, untouched test 20%.
// This research model does not replace production signals automatically.
const WINDOW = 5;
function choose(n,k) { let v=1; for(let i=1;i<=k;i++) v=v*(n-i+1)/i; return v; }
const PER_DRAW=(choose(5,4)*choose(75,16)+choose(75,15))/choose(80,20);
const BASELINE=1-Math.pow(1-PER_DRAW,WINDOW);
function lower(h,n) {
  if(!n)return 0;
  const z=1.96,p=h/n;
  return (p+z*z/(2*n)-z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n);
}
function prepare(input,target) {
  if(!Array.isArray(target)||target.length!==5||new Set(target).size!==5||
    target.some(n=>!Number.isInteger(n)||n<1||n>80)) throw Error('Expected five distinct integers from 1 to 80');
  const seen=new Set();
  return input.filter(d=>Array.isArray(d.numbers)&&d.numbers.length===20&&new Set(d.numbers).size===20&&
    d.numbers.every(n=>Number.isInteger(n)&&n>=1&&n<=80)&&Number.isSafeInteger(Number(d.draw_id))&&Number(d.draw_id)>0)
    .sort((a,b)=>Number(a.draw_id)-Number(b.draw_id)).map(d=>{
      const id=Number(d.draw_id);
      if(seen.has(id))throw Error('Duplicate draw IDs');
      seen.add(id);
      const flags=new Uint8Array(81);d.numbers.forEach(n=>flags[n]=1);
      return {id, numbers:[...d.numbers].sort((a,b)=>a-b), flags, hits:target.reduce((s,n)=>s+flags[n],0)};
    });
}
function contiguous(rows,a,b) {
  if(a<0||b>=rows.length)return false;
  for(let i=a+1;i<=b;i++)if(rows[i].id!==rows[i-1].id+1)return false;
  return true;
}
function active(rows,i,triples) {
  if(rows[i].hits>=3||!contiguous(rows,i-4,i))return false;
  for(let k=i-4;k<=i;k++)for(const t of triples)
    if(t.every(n=>rows[k].flags[n]))return true;
  return false;
}
function discover(rows,end) {
  const counts=new Map();
  for(let h=5;h<end;h++){
    if(rows[h].hits<4||!contiguous(rows,h-5,h))continue;
    const once=new Set();
    for(let k=h-5;k<h;k++){
      const a=rows[k].numbers;
      for(let i=0;i<18;i++)for(let j=i+1;j<19;j++)for(let l=j+1;l<20;l++)
        once.add((a[i]*81+a[j])*81+a[l]);
    }
    for(const key of once)counts.set(key,(counts.get(key)||0)+1);
  }
  return [...counts].filter(x=>x[1]>=4).sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,60)
    .map(([key])=>[Math.floor(key/6561),Math.floor(key/81)%81,key%81]);
}
function evaluate(rows,triples,start,end,probability=BASELINE) {
  const outcomes=[];let wasActive=false,blockedUntil=-1;
  for(let i=start;i<end;i++){
    const on=active(rows,i,triples);
    const onset=on&&!wasActive;wasActive=on;
    if(!onset||i<=blockedUntil||i+WINDOW>=end||!contiguous(rows,i,i+WINDOW))continue;
    let y=0;for(let k=i+1;k<=i+WINDOW;k++)if(rows[k].hits>=4)y=1;
    outcomes.push({issuedAfter:rows[i].id,end:rows[i+WINDOW].id,y});
    blockedUntil=i+WINDOW;
  }
  const n=outcomes.length,h=outcomes.reduce((s,o)=>s+o.y,0);
  const brier=n?outcomes.reduce((s,o)=>s+(probability-o.y)**2,0)/n:null;
  const baseBrier=n?outcomes.reduce((s,o)=>s+(BASELINE-o.y)**2,0)/n:null;
  const half=Math.floor(n/2);
  const halves=[outcomes.slice(0,half),outcomes.slice(half)].map(a=>({
    episodes:a.length,rate:a.length?a.reduce((s,o)=>s+o.y,0)/a.length:null
  }));
  return {episodes:n,successes:h,failures:n-h,rate:n?h/n:null,lower95:lower(h,n),
    brier,baselineBrier:baseBrier,halves,outcomes};
}
function fit(rows,candidates,discoveryEnd,calibrationEnd) {
  const ranked=candidates.map(triple=>{
    const m=evaluate(rows,[triple],discoveryEnd,calibrationEnd);
    return {triple,m};
  }).filter(x=>x.m.episodes>=20).sort((a,b)=>b.m.lower95-a.m.lower95||
    b.m.successes-a.m.successes||a.triple.join('-').localeCompare(b.triple.join('-')));
  const policies=[1,2,3].filter(n=>ranked.length>=n).map(n=>{
    const triples=ranked.slice(0,n).map(x=>x.triple);
    return {triples,metrics:evaluate(rows,triples,discoveryEnd,calibrationEnd)};
  }).sort((a,b)=>b.metrics.lower95-a.metrics.lower95||a.triples.length-b.triples.length);
  const winner=policies[0]||{triples:[],metrics:evaluate(rows,[],discoveryEnd,calibrationEnd)};
  const probability=(winner.metrics.successes+30*BASELINE)/(winner.metrics.episodes+30);
  return {triples:winner.triples,probability,calibration:winner.metrics};
}
function compact(m) { const {outcomes,...rest}=m;return rest; }
function research(input,target,legacyTriples=[]) {
  const rows=prepare(input,target);
  if(rows.length<1500)return {ok:false,reason:'need-at-least-1500-valid-draws',have:rows.length};
  const discoveryEnd=Math.floor(rows.length*.6),calibrationEnd=Math.floor(rows.length*.8);
  const candidates=discover(rows,discoveryEnd);
  const policy=fit(rows,candidates,discoveryEnd,calibrationEnd);
  const trial=evaluate(rows,policy.triples,calibrationEnd,rows.length,policy.probability);
  // Legacy candidates must be frozen using discovery data only by the caller.
  const legacy=evaluate(rows,legacyTriples,calibrationEnd,rows.length);
  const passed=trial.episodes>=40&&trial.successes>=5&&trial.lower95>BASELINE&&
    trial.brier<trial.baselineBrier&&trial.halves.every(h=>h.episodes>=20&&h.rate>BASELINE);
  return {ok:true,model:'FOUR_PLUS_PURGED_HOLDOUT_V1',mode:'research-only',baseline:BASELINE,
    target,analyzedDraws:rows.length,latestDrawId:rows.at(-1).id,
    split:{discoveryEndId:rows[discoveryEnd-1].id,calibrationEndId:rows[calibrationEnd-1].id,
      testStartId:rows[calibrationEnd].id,testEndId:rows.at(-1).id},
    candidates:candidates.length,selectedTriples:policy.triples,
    estimatedProbability:policy.probability,calibration:compact(policy.calibration),test:compact(trial),
    legacyFrozenCandidates:compact(legacy),
    comparisonNote:'Legacy benchmark freezes its precursor list after discovery; it is not a replay of the adaptive production engine. Different policies can issue on different windows.',
    eligibleForProspectiveTrial:passed,
    currentSignal:passed&&active(rows,rows.length-1,policy.triples)?'RESEARCH_CANDIDATE':'ABSTAIN',
    reason:passed?'Historical gate passed; an independent prospective trial is still required.':'No sufficient stable held-out advantage; do not promote this model.',
    limitations:'Nominal intervals assume independent outcomes. Historical target selection, repeated experiments, moving splits and shared targets can bias inference. Shrunk calibration rate is not a verified next-draw probability. No live predictions are written by this endpoint.'};
}
module.exports={research,prepare,discover,fit,evaluate,BASELINE};
