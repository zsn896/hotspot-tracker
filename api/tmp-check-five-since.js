'use strict';

const { db } = require('./lib');
const TARGET = [17,47,52,53,72];
const START_DRAW = 3299244;

function norm(values){
  return [...new Set((values||[]).map(Number))]
    .filter(n=>Number.isInteger(n)&&n>=1&&n<=80)
    .sort((a,b)=>a-b);
}

module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows = (await db(`hotspot_draws?select=draw_id,draw_date,draw_time,numbers&draw_id=gt.${START_DRAW}&order=draw_id.asc&limit=1000`)) || [];
    const valid = rows.filter(r=>norm(r.numbers).length===20);
    const hits=[];
    let maxHit=0;
    let maxRows=[];
    for(const r of valid){
      const set=new Set(norm(r.numbers));
      const present=TARGET.filter(n=>set.has(n));
      if(present.length>maxHit){maxHit=present.length;maxRows=[];}
      if(present.length===maxHit) maxRows.push({drawId:Number(r.draw_id),date:r.draw_date,time:r.draw_time,present});
      if(present.length===5) hits.push({drawId:Number(r.draw_id),date:r.draw_date,time:r.draw_time,numbers:norm(r.numbers)});
    }
    return res.status(200).json({ok:true,target:TARGET,startAfterDraw:START_DRAW,checkedDraws:valid.length,latestDrawId:valid.length?Number(valid[valid.length-1].draw_id):START_DRAW,exact5Count:hits.length,hits,maxHit,maxRows:maxRows.slice(-20)});
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
