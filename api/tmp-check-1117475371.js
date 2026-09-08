'use strict';

const { db } = require('./lib');
const TARGET = [11,17,47,53,71];

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

module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows=(await db('hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=100'))||[];
    const valid=rows.filter(r=>norm(r.numbers).length===20).slice(0,60).reverse();
    const latest=valid.at(-1);
    const dist={0:0,1:0,2:0,3:0,4:0,5:0};
    const hitRows=[];
    for(const r of valid){
      const nums=norm(r.numbers);
      const hits=TARGET.filter(n=>nums.includes(n));
      dist[hits.length]++;
      if(hits.length>=3) hitRows.push({drawId:Number(r.draw_id),time:r.draw_time||'',hits:hits.length,numbers:hits});
    }
    const last15=valid.slice(-15);
    const tripleStats=combos3(TARGET).map(triple=>{
      let total=0,last30=0,last15c=0,lastDraw=0,lastTime='';
      for(let i=0;i<valid.length;i++){
        const nums=norm(valid[i].numbers);
        if(triple.every(n=>nums.includes(n))){
          total++;
          if(i>=30) last30++;
          if(i>=45) last15c++;
          lastDraw=Number(valid[i].draw_id); lastTime=valid[i].draw_time||'';
        }
      }
      return {triple,total,last30,last15:last15c,lastDraw,lastTime};
    }).sort((a,b)=>b.last15-a.last15||b.last30-a.last30||b.total-a.total||a.triple[0]-b.triple[0]||a.triple[1]-b.triple[1]||a.triple[2]-b.triple[2]);
    return res.status(200).json({ok:true,target:TARGET,checkedDraws:valid.length,latestDrawId:Number(latest?.draw_id||0),latestTime:latest?.draw_time||'',distribution:dist,threePlus:hitRows.length,recentHitRows:hitRows.slice(-10),topTriples:tripleStats.slice(0,10)});
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
