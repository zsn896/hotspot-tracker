const cheerio=require('cheerio');
const OFFICIAL='https://www.calottery.com/en/draw-games/hot-spot/past-winning-numbers';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function uniqSorted(nums){return [...new Set((nums||[]).map(Number))].filter(n=>n>=1&&n<=80).sort((a,b)=>a-b)}
function parse(html){
  const $=cheerio.load(html);
  const t=$('body').text().replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
  const no=(t.match(/Draw Number:\s*(\d{7})/i)||[])[1];
  const dm=t.match(/Draw Date:\s*([^|]+?)\s*\|\s*Draw Time:\s*([0-9:]+\s*[ap]\.??m\.?)/i);
  if(!no||!dm)return null;
  let seg=t.slice(t.indexOf(dm[0])+dm[0].length);
  const stop=seg.search(/Check out the Hot Spot|Hot Spot Payouts|Overall odds/i);
  if(stop>0)seg=seg.slice(0,stop);
  const bull=(seg.match(/Bulls[-‑–—]?eye\s+number\s+is(?:\s*\{number\})?\s*(?:number\s*)?(\d{1,2})/i)||[])[1];
  const raw=seg.match(/\b(?:[1-9]|[1-7]\d|80)\b/g)||[];
  const numbers=uniqSorted(raw.slice(0,20));
  if(numbers.length!==20)return null;
  return {id:+no,date:dm[1].trim(),time:dm[2].trim(),numbers,bullsEye:bull?Number(bull):null};
}
function valid(d){return d&&Number.isInteger(d.id)&&d.numbers?.length===20&&new Set(d.numbers).size===20&&d.numbers.every(n=>n>=1&&n<=80)&&(d.bullsEye===null||(Number.isInteger(d.bullsEye)&&d.bullsEye>=1&&d.bullsEye<=80&&d.numbers.includes(d.bullsEye)))}
async function getDraw(id){
  let last;
  for(let a=0;a<3;a++)try{
    const u=new URL(OFFICIAL);
    if(id)u.searchParams.set('query',id);
    u.searchParams.set('_v',Date.now().toString(36)+Math.random().toString(36).slice(2));
    const r=await fetch(u,{cache:'no-store',headers:{'user-agent':'Mozilla/5.0','cache-control':'no-cache','pragma':'no-cache','accept-language':'en-US,en;q=0.9'}});
    if(!r.ok)throw Error(`California Lottery HTTP ${r.status}`);
    const d=parse(await r.text());
    if(!valid(d))throw Error('Invalid parsed draw');
    if(id&&d.id!==id)throw Error(`Expected ${id}, got ${d.id}`);
    return d;
  }catch(e){last=e;await sleep(150*(a+1))}
  throw last||Error('Fetch failed');
}
async function getMany(ids){const out=[];const C=8;for(let i=0;i<ids.length;i+=C)out.push(...await Promise.all(ids.slice(i,i+C).map(getDraw)));return out.sort((a,b)=>a.id-b.id)}
function score(draw,group){const set=new Set(draw.numbers);const hit=group.filter(n=>set.has(n));const bullsEyeMatch=Number.isInteger(draw.bullsEye)&&group.includes(draw.bullsEye);return {count:hit.length,hit,bullsEye:draw.bullsEye,bullsEyeMatch};}
function sb(){const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw Error('Supabase environment variables are missing');return {url:url.replace(/\/$/,''),key}}
async function db(path,{method='GET',body,prefer}={}){const {url,key}=sb();const h={'apikey':key,'authorization':`Bearer ${key}`,'content-type':'application/json'};if(prefer)h.prefer=prefer;const r=await fetch(`${url}/rest/v1/${path}`,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});const txt=await r.text();if(!r.ok)throw Error(`Supabase ${r.status}: ${txt.slice(0,300)}`);if(!txt)return null;try{return JSON.parse(txt)}catch{return txt}}

// Guarded: without a cap, two draws that happen to share a large intersection
// (rare, but not impossible over a 180-draw window) generate C(inter,5) candidates,
// e.g. C(20,5)=15504 from a single pair. With 180 draws that risked a combinatorial
// blow-up large enough to exceed the Vercel function timeout. 12 keeps C(12,5)=792
// per pair while still covering every intersection size seen in practice.
const MAX_INTERSECTION_FOR_COMBOS=12;
function combos5(a,fn){const n=a.length;if(n>MAX_INTERSECTION_FOR_COMBOS)return;for(let i=0;i<n-4;i++)for(let j=i+1;j<n-3;j++)for(let k=j+1;k<n-2;k++)for(let l=k+1;l<n-1;l++)for(let m=l+1;m<n;m++)fn([a[i],a[j],a[k],a[l],a[m]])}

// --- Statistical significance of a candidate 5-number group ---
// Hot Spot draws 20 of 80 numbers independently each time, so the probability
// that one specific, pre-chosen 5-number group is fully contained in a single
// draw is a fixed hypergeometric value (~1 in 1550). That means, given a window
// of N draws, we *expect* a small baseline number of "hits" purely by chance.
// The old code ranked candidates only by raw count, but candidates were not
// chosen in advance — they were mined from the data itself (every 5-subset of
// every pair of draws that shared >=5 numbers). Searching that many candidates
// and keeping whichever had the highest count is a textbook multiple-comparisons
// trap: with thousands of candidates tested, *something* will look "hot" even
// when the underlying draws are perfectly random. These helpers let the caller
// tell the difference between "unusually frequent even after accounting for how
// many candidates were tested" and "just noise that happened to win the search".
function logChoose(n,k){if(k<0||k>n)return -Infinity;let s=0;for(let i=0;i<k;i++)s+=Math.log(n-i)-Math.log(i+1);return s}
// P(a single fixed 5-number group is fully drawn in one Hot Spot draw) = C(20,5)/C(80,5)
const SINGLE_DRAW_HIT_PROB=Math.exp(logChoose(20,5)-logChoose(80,5));
// P(that group hits >= k times in n independent draws), Poisson approximation
// (accurate here since SINGLE_DRAW_HIT_PROB is tiny and n is at most a few hundred)
function pValueAtLeast(k,n){if(k<=0)return 1;const lambda=n*SINGLE_DRAW_HIT_PROB;let cdf=0,p=Math.exp(-lambda);for(let i=0;i<k;i++){cdf+=p;p*=lambda/(i+1)}return Math.max(0,Math.min(1,1-cdf))}
// Bonferroni-style correction: if we tested `candidateCount` groups, a single
// group's raw p-value must be that much smaller before we call it significant.
function bonferroniThreshold(candidateCount,alpha=0.05){return candidateCount>0?alpha/candidateCount:alpha}
function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:0}
function median(a){if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2}
function parseDrawMinutes(timeText){const t=String(timeText||'').toLowerCase().match(/(\d{1,2}):(\d{2})\s*([ap])/);if(!t)return null;let h=+t[1]%12;if(t[3]==='p')h+=12;return h*60+(+t[2]);}
function formatMinutes(m){if(m==null)return null;m=((Math.round(m)%1440)+1440)%1440;let h=Math.floor(m/60),min=m%60,ap=h>=12?'PM':'AM';h=h%12||12;return `${h}:${String(min).padStart(2,'0')} ${ap}`}
function drawTimeMap(draws){const x=new Map();for(const d of draws)x.set(Number(d.draw_id??d.id),parseDrawMinutes(d.draw_time??d.time));return x}
function statsForGroup(draws,numbers){
  const occ=[];for(const d of draws){const set=new Set(d.numbers||[]);if(numbers.every(n=>set.has(n)))occ.push(Number(d.draw_id??d.id));}
  const gaps=[];for(let i=1;i<occ.length;i++)gaps.push(occ[i]-occ[i-1]);
  const avg=mean(gaps),med=median(gaps),sd=gaps.length?Math.sqrt(mean(gaps.map(x=>(x-avg)**2))):0;
  const cv=avg>0?sd/avg:999;
  const expectedGap=gaps.length?Math.max(1,Math.round((avg+med)/2)):null;
  const latest=Number(draws.at(-1)?.draw_id??draws.at(-1)?.id??0),last=occ.at(-1)||null;
  let center=last&&expectedGap?last+expectedGap:null;if(center){while(center<=latest)center+=expectedGap;}
  // With very few observed gaps, sd alone is not a trustworthy width: with 1 gap, sd
  // is mathematically 0 (a single point has no spread) even though the true variability
  // is completely unknown; with 2 gaps it's still noisy. Rather than report a falsely
  // narrow window in those cases, fall back to a width proportional to the gap size
  // itself, then apply a small-sample widening factor (same spirit as a wider
  // confidence interval for a smaller sample): factor = 1 + 2/n, so n=1 -> x3,
  // n=2 -> x2, n=3 -> x1.67, n=5 -> x1.4, shrinking toward x1 as more gaps accumulate.
  const n=gaps.length;
  const baseHalf=sd>0?sd/2:(expectedGap?expectedGap*0.4:null);
  const widenFactor=n?1+2/n:1;
  const half=baseHalf!=null?Math.max(2,Math.round(baseHalf*widenFactor)):null;
  const from=center?Math.max(latest+1,center-half):null,to=center?center+half:null;
  const times=drawTimeMap(draws),latestMinutes=parseDrawMinutes(draws.at(-1)?.draw_time??draws.at(-1)?.time);
  const toClock=id=>id&&latestMinutes!=null?formatMinutes(latestMinutes+(id-latest)*4):null;
  // Honest confidence label based purely on how many past gaps this estimate rests on.
  // This describes how much data backs the window, NOT how likely the group is to
  // actually reappear there — Hot Spot draws are independent, so no sample size
  // changes the true odds of the next draw.
  const confidence=occ.length<3?'very low (1 gap or fewer)':occ.length===3?'low (2 gaps)':occ.length<6?'moderate (3-4 gaps)':'higher sample, still not predictive of a random game';
  return {numbers,count:occ.length,occurrences:occ,gaps,meanGap:+avg.toFixed(2),medianGap:+med.toFixed(2),minGap:gaps.length?Math.min(...gaps):0,maxGap:gaps.length?Math.max(...gaps):0,standardDeviation:+sd.toFixed(2),coefficientVariation:cv===999?null:+cv.toFixed(3),lastDrawId:last,lastAppearanceTime:last?formatMinutes(times.get(last)):null,sinceLastDraws:last?latest-last:null,sinceLastMinutes:last?(latest-last)*4:null,expectedGapDraws:expectedGap,expectedCenterDrawId:center,expectedFromDrawId:from,expectedToDrawId:to,expectedCenterTime:toClock(center),expectedFromTime:toClock(from),expectedToTime:toClock(to),estimateConfidence:confidence};
}
function mineCandidates(sourceDraws){
  const sourceSets=sourceDraws.map(d=>new Set(d.numbers||[]));
  const candidates=new Set();
  for(let i=0;i<sourceDraws.length-1;i++){
    const A=sourceSets[i];
    for(let j=i+1;j<sourceDraws.length;j++){
      const inter=(sourceDraws[j].numbers||[]).filter(n=>A.has(n));
      if(inter.length<5)continue;
      combos5(inter,c=>candidates.add(c.join(',')));
    }
  }
  return candidates;
}
function countInDraws(nums,drawSets){let count=0;for(const s of drawSets)if(nums.every(n=>s.has(n)))count++;return count}
function analyzeTopGroups(draws,limit=2){
  if(!Array.isArray(draws)||draws.length<4)return [];
  // Every candidate group is, by construction, a subset shared by whichever pair of
  // draws produced it — so it is *guaranteed* to already have >=2 hits in the very
  // data it came from. Ranking candidates by their count over that same window (the
  // original approach, and an earlier version of this fix) is circular: it tests a
  // hypothesis on the data used to generate it, and in testing this against purely
  // random control draws it flagged a "hot" group as statistically significant in
  // 14 of 15 trials — i.e. it fires almost every time even when nothing is there.
  // Fix: mine candidates from the first half of the window only, then rank them by
  // how often they occur in the second half — a genuine, out-of-sample count.
  const mid=Math.floor(draws.length/2);
  const mineHalf=draws.slice(0,mid),testHalf=draws.slice(mid);
  const testSets=testHalf.map(d=>new Set(d.numbers||[]));
  const candidates=mineCandidates(mineHalf);
  const scored=[];
  for(const key of candidates){
    const nums=key.split(',').map(Number);
    const outOfSampleCount=countInDraws(nums,testSets);
    if(outOfSampleCount>=1)scored.push({numbers:nums,outOfSampleCount});
  }
  // pValue here describes how unusual the out-of-sample count is under a pure-chance
  // model — useful as a ranking signal and to show the user actual odds, but it is
  // NOT a claim that the group will repeat: Hot Spot draws are independent, so this
  // score cannot predict the next draw regardless of how the group performed so far.
  const threshold=bonferroniThreshold(candidates.size);
  for(const c of scored)c.pValue=pValueAtLeast(c.outOfSampleCount,testHalf.length);
  scored.sort((a,b)=>a.pValue-b.pValue||b.outOfSampleCount-a.outOfSampleCount);
  const shortlist=scored.slice(0,Math.max(limit,25));
  // Full descriptive stats (gaps, last-seen time, expected window) are computed over
  // the WHOLE window for display purposes only — that part was never the problem.
  const out=shortlist.map(c=>{const s=statsForGroup(draws,c.numbers);s.pValue=+c.pValue.toExponential(3);s.significant=c.pValue<threshold;s.candidatesTested=candidates.size;s.outOfSampleCount=c.outOfSampleCount;return s});
  out.sort((a,b)=>a.pValue-b.pValue||b.count-a.count||((a.coefficientVariation??999)-(b.coefficientVariation??999))||b.lastDrawId-a.lastDrawId||a.numbers.join(',').localeCompare(b.numbers.join(',')));
  return out.slice(0,limit).filter(g=>g.count>=2);
}
function californiaNowParts(date=new Date()){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const o={};for(const p of parts)if(p.type!=='literal')o[p.type]=p.value;
  const hour=+o.hour,minute=+o.minute;
  return {dateKey:`${o.year}-${o.month}-${o.day}`,hour,minute,minutes:hour*60+minute};
}
function previousDateKey(dateKey){
  const [y,m,d]=String(dateKey).split('-').map(Number);
  const x=new Date(Date.UTC(y,m-1,d)-86400000);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth()+1).padStart(2,'0')}-${String(x.getUTCDate()).padStart(2,'0')}`;
}
function cycleDateKey(now){return now.minutes<360?previousDateKey(now.dateKey):now.dateKey}
function scheduleMode(minutes,hasGroups=false){
  if(minutes>=150&&minutes<360)return 'cleanup';
  if(minutes>=120&&minutes<150)return 'idle';
  if(minutes>=360&&minutes<1080)return 'collecting';
  return hasGroups?'tracking':'preparing';
}
module.exports={uniqSorted,getDraw,getMany,score,db,statsForGroup,analyzeTopGroups,parseDrawMinutes,formatMinutes,californiaNowParts,previousDateKey,cycleDateKey,scheduleMode};
