// Ledger behaviour checks: episode counting, window integrity, null result.
// Run:  node verify/ledger-selftest.js
// Build a throwaway sandbox mirroring the project layout, so signal-ledger.js
// resolves `../api/lib` to an in-memory database instead of Supabase. Nothing is
// written into the package itself.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
fs.mkdirSync(path.join(sandbox, 'lib'));
fs.mkdirSync(path.join(sandbox, 'api'));
fs.copyFileSync(path.join(__dirname, '..', 'lib', 'signal-ledger.js'), path.join(sandbox, 'lib', 'signal-ledger.js'));
fs.copyFileSync(path.join(__dirname, 'fake-db.js'), path.join(sandbox, 'api', 'lib.js'));

const L = require(path.join(sandbox, 'lib', 'signal-ledger.js'));
const { tables, reset } = require(path.join(sandbox, 'api', 'lib.js'));
process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true }));


function mulberry32(a){return()=>{a=(a+0x6d2b79f5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}}
function makeDraws(n,seed){const rng=mulberry32(seed);const out=[];
 for(let i=0;i<n;i++){const p=Array.from({length:80},(_,k)=>k+1);
  for(let j=79;j>0;j--){const k=Math.floor(rng()*(j+1));[p[j],p[k]]=[p[k],p[j]]}
  out.push({draw_id:3300000+i,numbers:p.slice(0,20).sort((a,b)=>a-b)})}
 return out;}

const target=[9,15,56,75,79];
const draws=makeDraws(30000,2024);
const byId=new Map(draws.map(d=>[d.draw_id,d]));
const loadDraws=async(from,to)=>{const out=[];for(let id=from;id<=to;id++)if(byId.has(id))out.push(byId.get(id));return out};

(async()=>{
  console.log('=== TEST 1: episode counting (checks must NOT be counted separately) ===');
  reset();
  // signal stays STRONG for 6 consecutive draws, then gap, then STRONG again
  const f=s=>({status:s,expectedTier:'4_PLUS',fourPlusScore:80,fourPlusOutcomeCalibration:{signal:[3,17,28]}});
  for(let d=3300100;d<=3300105;d++) await L.recordObservation(target,f('STRONG'),d);
  await L.recordObservation(target,f('QUIET'),3300106);
  for(let d=3300120;d<=3300122;d++) await L.recordObservation(target,f('STRONG'),d);
  console.log('  18 observations recorded ->',tables.signal_episodes.length,'episodes (expected 2)');
  console.log('  episode 1 start/last/windowEnd:',tables.signal_episodes[0].start_draw_id,tables.signal_episodes[0].last_draw_id,tables.signal_episodes[0].window_end_draw_id);
  console.log('  window fixed at start? ',tables.signal_episodes[0].window_end_draw_id===tables.signal_episodes[0].start_draw_id+5);

  console.log();
  console.log('=== TEST 2: incomplete window is NOT scored as a failure ===');
  reset();
  await L.recordObservation(target,f('STRONG'),3300100);
  const partial=async(a,b)=>{const r=await loadDraws(a,b);return r.slice(0,2)};
  console.log('  resolve with missing draws ->',JSON.stringify(await L.resolveEpisodes(partial,3300200)));

  console.log();
  console.log('=== TEST 3: full run — 1200 random STRONG episodes, no real signal ===');
  reset();
  let opened=0;
  for(let i=0;i<1200;i++){
    const d=3300200+i*11;                       // spaced apart -> independent episodes
    const r=await L.recordObservation(target,f('STRONG'),d);
    if(r.action==='opened')opened++;
  }
  const res=await L.resolveEpisodes(loadDraws,3399999,{limit:5000});
  console.log('  opened',opened,'| resolved',res.resolved,'| successes',res.successes);
  const rep=await L.ledgerReport();
  const o=rep.overall;
  console.log();
  console.log('  chance model  : per draw',rep.chanceModel.perDrawRate,' in a 5-draw window',rep.chanceModel.windowRate);
  console.log('  episodes      :',o.episodes);
  console.log('  successes     :',o.successes,' expected by chance',o.expectedByChance);
  console.log('  observed rate :',o.observedRate,' vs chance',o.chanceRate);
  console.log('  lift          :',o.lift,'  p =',o.pValue,'  significant:',o.significant);
  console.log('  95% CI        :',JSON.stringify(o.confidenceInterval));
  console.log('  best-hit dist :',JSON.stringify(rep.bestHitDistribution));
  console.log('  lead draws    :',JSON.stringify(rep.successLeadDraws));
  console.log();
  console.log('  VERDICT:',o.conclusion);
  console.log('  power plan   :',JSON.stringify(rep.powerPlan));
})();
