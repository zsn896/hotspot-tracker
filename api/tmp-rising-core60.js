'use strict';

const { db } = require('./lib');

function norm(values){
  return [...new Set((values||[]).map(Number))]
    .filter(n=>Number.isInteger(n)&&n>=1&&n<=80)
    .sort((a,b)=>a-b);
}

module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows=(await db('hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=100'))||[];
    const valid=rows.filter(r=>norm(r.numbers).length===20).slice(0,60).reverse();
    const latest=valid.at(-1);
    const map=new Map();
    for(let i=0;i<valid.length;i++){
      const nums=norm(valid[i].numbers);
      const recent=i>=45; // last 15 of 60
      const mid=i>=30;    // last 30 of 60
      for(let a=0;a<18;a++) for(let b=a+1;b<19;b++) for(let c=b+1;c<20;c++){
        const key=`${nums[a]},${nums[b]},${nums[c]}`;
        let s=map.get(key); if(!s){s={triple:[nums[a],nums[b],nums[c]],total:0,last30:0,last15:0,lastDraw:0,lastTime:''};map.set(key,s);}
        s.total++; if(mid)s.last30++; if(recent)s.last15++;
        s.lastDraw=Number(valid[i].draw_id); s.lastTime=valid[i].draw_time||'';
      }
    }
    const arr=[...map.values()].map(s=>{
      const old30=s.total-s.last30;
      const prev15=s.last30-s.last15;
      const recentRate=s.last15/15;
      const prevRate=prev15/15;
      const rise=recentRate-prevRate;
      const score=s.last15*3 + prev15*1.5 + old30*0.25 + rise*5;
      return {...s,prev15,old30,rise:Number(rise.toFixed(4)),score:Number(score.toFixed(4))};
    }).filter(s=>s.last15>=2)
      .sort((a,b)=>b.score-a.score||b.last15-a.last15||b.total-a.total||a.triple[0]-b.triple[0]||a.triple[1]-b.triple[1]||a.triple[2]-b.triple[2]);
    return res.status(200).json({ok:true,checkedDraws:valid.length,latestDrawId:Number(latest?.draw_id||0),latestTime:latest?.draw_time||'',top:arr.slice(0,20)});
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
