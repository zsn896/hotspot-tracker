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
    const counts=new Map();
    for(let i=start;i<valid.length;i++){
      const nums=norm(valid[i].numbers);
      if(!CORE.every(n=>nums.includes(n))) continue;
      const age=valid.length-i;
      const weight=1/age;
      for(const n of nums){
        if(CORE.includes(n)) continue;
        counts.set(n,(counts.get(n)||0)+weight);
      }
    }
    const ranked=[...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0]-b[0]);
    const companions=ranked.slice(0,10).map(([number,score])=>({number,score:Number(score.toFixed(6))}));
    const picks=[...CORE,...ranked.slice(0,2).map(x=>x[0])].sort((a,b)=>a-b);
    return res.status(200).json({ok:true,core:CORE,window:WINDOW,latestDrawId:Number(latest?.draw_id||0),latestDate:latest?.draw_date||'',latestTime:latest?.draw_time||'',companions,picks});
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
