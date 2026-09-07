'use strict';

const { db } = require('./lib');

const TARGET = [11,17,47,51,72];
const FOCUS = [17,47,72];
const PAGE_SIZE = 1000;
const MAX_DRAWS = 54000;

function norm(values){
  return [...new Set((values||[]).map(Number))]
    .filter(n=>Number.isInteger(n)&&n>=1&&n<=80)
    .sort((a,b)=>a-b);
}

function combos3(arr){
  const out=[];
  for(let i=0;i<arr.length-2;i++) for(let j=i+1;j<arr.length-1;j++) for(let k=j+1;k<arr.length;k++) out.push([arr[i],arr[j],arr[k]]);
  return out;
}

function key(arr){return [...arr].sort((a,b)=>a-b).join(',');}

async function loadRows(limit=MAX_DRAWS){
  const out=[];
  for(let offset=0; offset<limit; offset+=PAGE_SIZE){
    const take=Math.min(PAGE_SIZE,limit-offset);
    const page=(await db(`hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=${take}&offset=${offset}`))||[];
    if(!page.length) break;
    out.push(...page);
    if(page.length<take) break;
  }
  return out.filter(r=>Number.isFinite(Number(r?.draw_id))&&norm(r?.numbers).length===20);
}

function evaluateWindow(rows){
  const triples=combos3(TARGET).map(triple=>({triple,key:key(triple),count:0,strongCount:0,fourPlusCount:0,fiveCount:0}));
  let strongDraws=0,fourPlusDraws=0,fiveDraws=0;
  for(const row of rows){
    const nums=norm(row.numbers); const set=new Set(nums);
    const targetHits=TARGET.filter(n=>set.has(n));
    if(targetHits.length>=3) strongDraws++;
    if(targetHits.length>=4) fourPlusDraws++;
    if(targetHits.length===5) fiveDraws++;
    for(const s of triples){
      if(s.triple.every(n=>set.has(n))){
        s.count++;
        if(targetHits.length>=3) s.strongCount++;
        if(targetHits.length>=4) s.fourPlusCount++;
        if(targetHits.length===5) s.fiveCount++;
      }
    }
  }
  triples.sort((a,b)=>b.count-a.count||a.key.localeCompare(b.key));
  const focus=triples.find(x=>x.key===key(FOCUS));
  return {
    draws:rows.length,
    strongDraws,fourPlusDraws,fiveDraws,
    ranking:triples.map((x,i)=>({...x,rank:i+1,rate:rows.length?Number((x.count/rows.length).toFixed(6)):0,shareStrong:strongDraws?Number((x.strongCount/strongDraws).toFixed(6)):0,shareFourPlus:fourPlusDraws?Number((x.fourPlusCount/fourPlusDraws).toFixed(6)):0,shareFive:fiveDraws?Number((x.fiveCount/fiveDraws).toFixed(6)):0})),
    focus:focus?{...focus,rank:triples.findIndex(x=>x.key===key(FOCUS))+1,rate:rows.length?Number((focus.count/rows.length).toFixed(6)):0,shareStrong:strongDraws?Number((focus.strongCount/strongDraws).toFixed(6)):0,shareFourPlus:fourPlusDraws?Number((focus.fourPlusCount/fourPlusDraws).toFixed(6)):0,shareFive:fiveDraws?Number((focus.fiveCount/fiveDraws).toFixed(6)):0}:null
  };
}

module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const all=await loadRows();
    const w180=all.slice(0,180);
    const w500=all.slice(0,500);
    const w1000=all.slice(0,1000);
    return res.status(200).json({
      ok:true,
      target:TARGET,
      focus:FOCUS,
      latestDrawId:all[0]?Number(all[0].draw_id):null,
      availableHistoryDraws:all.length,
      windows:{last180:evaluateWindow(w180),last500:evaluateWindow(w500),last1000:evaluateWindow(w1000),allAvailable:evaluateWindow(all)}
    });
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
