'use strict';

const { db } = require('./lib');
const CORE = [3,63,71];
const START_DRAW = 3299127;

function norm(values){
  return [...new Set((values||[]).map(Number))]
    .filter(n=>Number.isInteger(n)&&n>=1&&n<=80)
    .sort((a,b)=>a-b);
}
function scoreWindow(rows, idx, window){
  const counts=new Map();
  for(let i=Math.max(0,idx-window); i<idx; i++){
    const nums=norm(rows[i].numbers);
    const hasCore=CORE.every(n=>nums.includes(n));
    if(!hasCore) continue;
    const age=idx-i;
    const weight=1/age;
    for(const n of nums){
      if(CORE.includes(n)) continue;
      counts.set(n,(counts.get(n)||0)+weight);
    }
  }
  return [...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0]-b[0]);
}
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows=(await db(`hotspot_draws?select=draw_id,draw_date,draw_time,numbers&draw_id=gte.${START_DRAW}&order=draw_id.asc&limit=1000`))||[];
    const valid=rows.filter(r=>norm(r.numbers).length===20);
    const windows=[6,10,15,20];
    const results=[];
    for(const w of windows){
      let trials=0,hit3=0,hit4=0,hit5=0;
      const details=[];
      for(let idx=w; idx<valid.length; idx++){
        const rank=scoreWindow(valid,idx,w);
        if(rank.length<2) continue;
        const picks=[...CORE, rank[0][0], rank[1][0]];
        const actual=new Set(norm(valid[idx].numbers));
        const present=picks.filter(n=>actual.has(n));
        const h=present.length;
        trials++;
        if(h>=3) hit3++;
        if(h>=4) hit4++;
        if(h>=5) hit5++;
        if(h>=4) details.push({drawId:Number(valid[idx].draw_id),time:valid[idx].draw_time,picks,present,hits:h});
      }
      results.push({window:w,trials,hit3,hit4,hit5,rate4:trials?hit4/trials:0,rate5:trials?hit5/trials:0,details});
    }
    return res.status(200).json({ok:true,core:CORE,startDraw:START_DRAW,latestDrawId:Number(valid.at(-1)?.draw_id||0),results});
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
