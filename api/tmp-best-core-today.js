'use strict';

const { db } = require('./lib');
const PAGE_SIZE = 1000;

function norm(values){
  return [...new Set((values||[]).map(Number))]
    .filter(n=>Number.isInteger(n)&&n>=1&&n<=80)
    .sort((a,b)=>a-b);
}
function combos3(nums){
  const out=[];
  for(let i=0;i<nums.length-2;i++) for(let j=i+1;j<nums.length-1;j++) for(let k=j+1;k<nums.length;k++) out.push([nums[i],nums[j],nums[k]]);
  return out;
}
function key(a){return a.join(',');}

module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows=(await db(`hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=${PAGE_SIZE}`))||[]
      .filter(r=>norm(r.numbers).length===20);
    const latest=rows[0];
    const today=String(latest?.draw_date||'');
    const todayRows=rows.filter(r=>String(r.draw_date||'')===today);
    const map=new Map();

    for(const r of todayRows){
      const nums=norm(r.numbers);
      for(const tri of combos3(nums)){
        const k=key(tri);
        let s=map.get(k);
        if(!s){s={triple:tri,count:0,comp:new Map(),common:null,draws:[]};map.set(k,s);}
        s.count++;
        s.draws.push({drawId:Number(r.draw_id),time:r.draw_time||''});
        const comps=nums.filter(n=>!tri.includes(n));
        const set=new Set(comps);
        s.common=s.common===null?set:new Set([...s.common].filter(n=>set.has(n)));
        for(const n of comps) s.comp.set(n,(s.comp.get(n)||0)+1);
      }
    }

    const ranked=[...map.values()].sort((a,b)=>b.count-a.count||key(a.triple).localeCompare(key(b.triple)));
    const top=ranked[0];
    const companionRanking=[...top.comp.entries()]
      .map(([number,count])=>({number,count,rate:Number((count/top.count).toFixed(4))}))
      .sort((a,b)=>b.count-a.count||a.number-b.number);

    return res.status(200).json({
      ok:true,
      today,
      latestDrawId:Number(latest?.draw_id||0),
      todayDraws:todayRows.length,
      bestCore:{
        triple:top.triple,
        count:top.count,
        commonCompanions:[...(top.common||[])].sort((a,b)=>a-b),
        topCompanions:companionRanking.slice(0,15),
        draws:top.draws
      },
      top5Cores:ranked.slice(0,5).map(s=>({triple:s.triple,count:s.count,commonCompanions:[...(s.common||[])].sort((a,b)=>a-b)}))
    });
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
