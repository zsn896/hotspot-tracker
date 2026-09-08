'use strict';

const { db } = require('./lib');
const TARGET = [3,9,50,63,71];
const START_DRAW = 3299269;

function norm(values){
  return [...new Set((values||[]).map(Number))]
    .filter(n=>Number.isInteger(n)&&n>=1&&n<=80)
    .sort((a,b)=>a-b);
}

module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows=(await db(`hotspot_draws?select=draw_id,draw_date,draw_time,numbers&draw_id=gt.${START_DRAW}&order=draw_id.asc&limit=1000`))||[];
    const valid=rows.filter(r=>norm(r.numbers).length===20);
    const counts={0:0,1:0,2:0,3:0,4:0,5:0};
    const strong=[];
    let maxHit=0;
    for(const r of valid){
      const set=new Set(norm(r.numbers));
      const present=TARGET.filter(n=>set.has(n));
      const h=present.length;
      counts[h]=(counts[h]||0)+1;
      if(h>maxHit) maxHit=h;
      if(h>=3) strong.push({drawId:Number(r.draw_id),date:r.draw_date,time:r.draw_time,present,hits:h});
    }
    return res.status(200).json({ok:true,target:TARGET,startAfterDraw:START_DRAW,checkedDraws:valid.length,latestDrawId:valid.length?Number(valid[valid.length-1].draw_id):START_DRAW,maxHit,counts,strong});
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
