'use strict';

const { db } = require('./lib');
const CORE = [17,47,72];
const PAGE_SIZE = 1000;
const MAX_DRAWS = 54000;

function norm(values){
  return [...new Set((values||[]).map(Number))]
    .filter(n=>Number.isInteger(n)&&n>=1&&n<=80)
    .sort((a,b)=>a-b);
}

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

function rank(map,total){
  return [...map.entries()].map(([number,count])=>({
    number:Number(number),count,
    rate: total ? Number((count/total).toFixed(6)) : 0
  })).sort((a,b)=>b.count-a.count||a.number-b.number);
}

module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows=await loadRows();
    const matches=[];
    const counts=new Map();
    let intersection=null;
    for(const row of rows){
      const nums=norm(row.numbers); const set=new Set(nums);
      if(CORE.every(n=>set.has(n))){
        const companions=nums.filter(n=>!CORE.includes(n));
        matches.push({drawId:Number(row.draw_id),date:row.draw_date||'',time:row.draw_time||'',companions});
        companions.forEach(n=>counts.set(n,(counts.get(n)||0)+1));
        const s=new Set(companions);
        if(intersection===null) intersection=new Set(s);
        else intersection=new Set([...intersection].filter(n=>s.has(n)));
      }
    }
    const ranking=rank(counts,matches.length);
    return res.status(200).json({
      ok:true,
      core:CORE,
      analyzedDraws:rows.length,
      coreOccurrences:matches.length,
      companionsPresentInEveryCoreDraw:[...(intersection||[])].sort((a,b)=>a-b),
      topCompanions:ranking.slice(0,20),
      pairsFromTop10: ranking.slice(0,10).flatMap((a,i,arr)=>arr.slice(i+1).map(b=>[a.number,b.number])).map(pair=>({pair,cooccur:matches.filter(m=>pair.every(n=>m.companions.includes(n))).length})).sort((a,b)=>b.cooccur-a.cooccur||a.pair[0]-b.pair[0]||a.pair[1]-b.pair[1]).slice(0,15),
      latestExamples:matches.slice(0,20)
    });
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
