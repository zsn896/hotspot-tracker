'use strict';

const { db } = require('./lib');
const CORE = [3,63,71];

function norm(values){
  return [...new Set((values||[]).map(Number))]
    .filter(n=>Number.isInteger(n)&&n>=1&&n<=80)
    .sort((a,b)=>a-b);
}

module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows=(await db('hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=1000'))||[];
    const valid=rows.filter(r=>norm(r.numbers).length===20);
    const latest=valid[0];
    const today=String(latest?.draw_date||'');
    const coreRows=valid.filter(r=>String(r.draw_date||'')===today && CORE.every(n=>norm(r.numbers).includes(n)));
    const pairMap=new Map();
    for(const r of coreRows){
      const comps=norm(r.numbers).filter(n=>!CORE.includes(n));
      for(let i=0;i<comps.length-1;i++) for(let j=i+1;j<comps.length;j++){
        const a=comps[i], b=comps[j], k=`${a},${b}`;
        let s=pairMap.get(k); if(!s){s={pair:[a,b],count:0,draws:[]}; pairMap.set(k,s);}
        s.count++; s.draws.push({drawId:Number(r.draw_id),time:r.draw_time||''});
      }
    }
    const ranked=[...pairMap.values()].sort((a,b)=>b.count-a.count||a.pair[0]-b.pair[0]||a.pair[1]-b.pair[1]);
    return res.status(200).json({ok:true,today,latestDrawId:Number(latest?.draw_id||0),core:CORE,coreAppearances:coreRows.length,topPairs:ranked.slice(0,20).map(x=>({...x,rate:coreRows.length?Number((x.count/coreRows.length).toFixed(4)):0}))});
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
