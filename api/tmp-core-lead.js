'use strict';

const { db } = require('./lib');

const PAGE_SIZE = 1000;
const MAX_DRAWS = 54000;
const TARGET = [11,17,47,51,72];
const CORE = [17,47,51,72];

function norm(values){
  return [...new Set((values||[]).map(Number))]
    .filter(n=>Number.isInteger(n)&&n>=1&&n<=80)
    .sort((a,b)=>a-b);
}

async function loadRows(limit=MAX_DRAWS){
  const out=[];
  for(let offset=0; offset<limit; offset+=PAGE_SIZE){
    const take=Math.min(PAGE_SIZE, limit-offset);
    const page=(await db(`hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.asc&limit=${take}&offset=${offset}`))||[];
    if(!page.length) break;
    out.push(...page);
    if(page.length<take) break;
  }
  return out.filter(r=>Number.isFinite(Number(r?.draw_id))&&norm(r?.numbers).length===20);
}

function hitCount(row, target=TARGET){
  const s=new Set(norm(row?.numbers));
  return target.filter(n=>s.has(n)).length;
}
function hasCore(row){
  const s=new Set(norm(row?.numbers));
  return CORE.every(n=>s.has(n));
}
function horizonsFor(triggerIdxs, exact5Idxs, horizons=[1,3,5,10,20]){
  const exactSet=new Set(exact5Idxs);
  const out={};
  for(const h of horizons){
    let success=0;
    for(const i of triggerIdxs){
      let ok=false;
      for(let j=i+1;j<=Math.min(i+h,rowsGlobal.length-1);j++) if(exactSet.has(j)){ok=true;break;}
      if(ok) success++;
    }
    out[h]={triggers:triggerIdxs.length,success,rate:triggerIdxs.length?Number((success/triggerIdxs.length).toFixed(6)):0};
  }
  return out;
}

let rowsGlobal=[];
module.exports=async function(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows=await loadRows(); rowsGlobal=rows;
    const hits=rows.map(r=>hitCount(r));
    const exact5Idxs=[]; const fourPlusIdxs=[]; const exact4Idxs=[]; const core4OnlyIdxs=[]; const threePlusIdxs=[];
    hits.forEach((h,i)=>{
      if(h>=3) threePlusIdxs.push(i);
      if(h>=4) fourPlusIdxs.push(i);
      if(h===4) exact4Idxs.push(i);
      if(h===5) exact5Idxs.push(i);
      if(h===4 && hasCore(rows[i]) && !new Set(norm(rows[i].numbers)).has(11)) core4OnlyIdxs.push(i);
    });

    function nearestPrior(triggerPredicate){
      const gaps=[]; const details=[];
      for(const idx of exact5Idxs){
        let found=-1;
        for(let j=idx-1;j>=0;j--){ if(triggerPredicate(j)){found=j;break;} }
        if(found>=0){
          const gap=idx-found; gaps.push(gap);
          details.push({eventDrawId:Number(rows[idx].draw_id),eventDate:rows[idx].draw_date,eventTime:rows[idx].draw_time,priorDrawId:Number(rows[found].draw_id),priorHits:hits[found],gapDraws:gap,priorNumbers:TARGET.filter(n=>new Set(norm(rows[found].numbers)).has(n))});
        }
      }
      gaps.sort((a,b)=>a-b);
      const avg=gaps.length?gaps.reduce((a,b)=>a+b,0)/gaps.length:null;
      const med=gaps.length?(gaps.length%2?gaps[(gaps.length-1)/2]:(gaps[gaps.length/2-1]+gaps[gaps.length/2])/2):null;
      return {events:exact5Idxs.length,withPrior:gaps.length,averageGap:avg==null?null:Number(avg.toFixed(3)),medianGap:med,minGap:gaps.length?gaps[0]:null,maxGap:gaps.length?gaps.at(-1):null,gaps,details};
    }

    const baselineIdxs=rows.map((_,i)=>i).filter(i=>i<rows.length-20);
    const result={
      ok:true,
      analyzedDraws:rows.length,
      oldestDrawId:rows[0]?Number(rows[0].draw_id):null,
      newestDrawId:rows.at(-1)?Number(rows.at(-1).draw_id):null,
      target:TARGET,
      core:CORE,
      counts:{threePlus:threePlusIdxs.length,fourPlus:fourPlusIdxs.length,exact4:exact4Idxs.length,core4Only:core4OnlyIdxs.length,exact5:exact5Idxs.length},
      nearestPriorFourPlus:nearestPrior(i=>hits[i]>=4),
      nearestPriorExact4:nearestPrior(i=>hits[i]===4),
      nearestPriorCore4Only:nearestPrior(i=>hits[i]===4&&hasCore(rows[i])&&!new Set(norm(rows[i].numbers)).has(11)),
      forwardExact5AfterFourPlus:horizonsFor(fourPlusIdxs.filter(i=>hits[i]!==5),exact5Idxs),
      forwardExact5AfterExact4:horizonsFor(exact4Idxs,exact5Idxs),
      forwardExact5AfterCore4Only:horizonsFor(core4OnlyIdxs,exact5Idxs),
      baselineExact5FromAnyDraw:horizonsFor(baselineIdxs,exact5Idxs)
    };
    return res.status(200).json(result);
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
