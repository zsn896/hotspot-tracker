// Confirms the ledger detects a genuine planted edge.
// Run:  node verify/ledger-detection.js
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
const target=[9,15,56,75,79];
const rng=mulberry32(77);
function makeDraws(n){const out=[];
 for(let i=0;i<n;i++){const p=Array.from({length:80},(_,k)=>k+1);
  for(let j=79;j>0;j--){const k=Math.floor(rng()*(j+1));[p[j],p[k]]=[p[k],p[j]]}
  out.push({draw_id:3300000+i,numbers:p.slice(0,20).sort((a,b)=>a-b)})}
 return out;}
const draws=makeDraws(30000);
const f={status:'STRONG',expectedTier:'4_PLUS',fourPlusScore:80,fourPlusOutcomeCalibration:{signal:[3,17,28]}};

(async()=>{
 for(const lift of [1.5,2,3]){
  reset();
  const local=draws.map(d=>({...d}));
  const byId=new Map(local.map(d=>[d.draw_id,d]));
  const load=async(a,b)=>{const o=[];for(let id=a;id<=b;id++)if(byId.has(id))o.push(byId.get(id));return o};
  const ids=[];
  for(let i=0;i<400;i++) ids.push(3300200+i*11);
  // plant: raise the chance of a 4+ inside each signal window by the given lift
  const extra=0.062084*(lift-1);
  for(const id of ids){
   if(rng()<extra){
    const pick=id+1+Math.floor(rng()*5); const d=byId.get(pick);
    if(d){const rest=d.numbers.filter(n=>!target.includes(n)).slice(0,16);
      d.numbers=[...target.slice(0,4),...rest].sort((a,b)=>a-b);}
   }
   await L.recordObservation(target,f,id);
  }
  await L.resolveEpisodes(load,3399999,{limit:5000});
  const o=(await L.ledgerReport()).overall;
  console.log('planted lift '+lift+'x -> episodes',o.episodes,'| successes',o.successes,'(expected',o.expectedByChance+')',
    '| measured lift',o.lift,'| p',o.pValue,'| DETECTED:',o.significant);
 }
})();
