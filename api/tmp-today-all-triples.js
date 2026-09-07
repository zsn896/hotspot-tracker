'use strict';

const { db } = require('./lib');
const PAGE_SIZE = 1000;
const MAX_DRAWS = 1000;
const FOCUS = [17,47,72];

function norm(values){
  return [...new Set((values||[]).map(Number))]
    .filter(n=>Number.isInteger(n)&&n>=1&&n<=80)
    .sort((a,b)=>a-b);
}
function key(a){return a.join(',');}
function combos3(nums){
  const out=[];
  for(let i=0;i<nums.length-2;i++) for(let j=i+1;j<nums.length-1;j++) for(let k=j+1;k<nums.length;k++) out.push([nums[i],nums[j],nums[k]]);
  return out;
}
async function loadRows(){
  const out=[];
  for(let offset=0;offset<MAX_DRAWS;offset+=PAGE_SIZE){
    const page=(await db(`hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=${PAGE_SIZE}&offset=${offset}`))||[];
    if(!page.length) break;
    out.push(...page);
    if(page.length<PAGE_SIZE) break;
  }
  return out.filter(r=>Number.isFinite(Number(r?.draw_id))&&norm(r?.numbers).length===20);
}
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows=await loadRows();
    const latest=rows[0];
    const today=String(latest?.draw_date||'');
    const todayRows=rows.filter(r=>String(r.draw_date||'')===today);
    const map=new Map();
    for(const row of todayRows){
      const nums=norm(row.numbers);
      for(const tri of combos3(nums)){
        const k=key(tri);
        let s=map.get(k);
        if(!s){s={triple:tri,count:0,draws:[],common:null};map.set(k,s);}
        s.count++;
        s.draws.push({drawId:Number(row.draw_id),time:row.draw_time||''});
        const set=new Set(nums.filter(n=>!tri.includes(n)));
        s.common=s.common===null?set:new Set([...s.common].filter(n=>set.has(n)));
      }
    }
    const ranked=[...map.values()].map(s=>({triple:s.triple,count:s.count,commonCompanions:[...(s.common||[])].sort((a,b)=>a-b),draws:s.draws})).sort((a,b)=>b.count-a.count||key(a.triple).localeCompare(key(b.triple)));
    const focus=ranked.find(x=>key(x.triple)===key(FOCUS));
    return res.status(200).json({ok:true,today,todayDraws:todayRows.length,latestDrawId:Number(latest?.draw_id||0),focus,top20:ranked.slice(0,20)});
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
