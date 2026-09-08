'use strict';

const { db } = require('./lib');
const CORE = [3,63,71];
const WINDOW = 15;

function norm(values){
  return [...new Set((values||[]).map(Number))]
    .filter(n=>Number.isInteger(n)&&n>=1&&n<=80)
    .sort((a,b)=>a-b);
}

module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows=(await db('hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=100'))||[];
    const valid=rows.filter(r=>norm(r.numbers).length===20).reverse();
    const latest=valid.at(-1);
    const start=Math.max(0,valid.length-WINDOW);
    const recent=valid.slice(start);
    const coreRows=[];
    for(let i=0;i<recent.length;i++){
      const nums=norm(recent[i].numbers);
      if(CORE.every(n=>nums.includes(n))) coreRows.push({index:i,row:recent[i],nums});
    }
    const counts=new Map();
    for(const c of coreRows){
      const age=recent.length-c.index;
      const weight=1/age;
      for(const n of c.nums){
        if(CORE.includes(n)) continue;
        counts.set(n,(counts.get(n)||0)+weight);
      }
    }
    const ranked=[...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0]-b[0]);
    const companions=ranked.slice(0,10).map(([number,score])=>({number,score:Number(score.toFixed(6))}));
    const ready=coreRows.length>0 && ranked.length>=2;
    const picks=ready?[...CORE,ranked[0][0],ranked[1][0]].sort((a,b)=>a-b):CORE;
    return res.status(200).json({ok:true,window:WINDOW,latestDrawId:Number(latest?.draw_id||0),latestDate:latest?.draw_date||'',latestTime:latest?.draw_time||'',core:CORE,coreAppearances:coreRows.length,coreDraws:coreRows.map(x=>({drawId:Number(x.row.draw_id),time:x.row.draw_time||''})),companions,ready,picks});
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
