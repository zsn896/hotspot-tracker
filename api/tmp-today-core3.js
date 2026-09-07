'use strict';

const { db } = require('./lib');

const TARGET = [11,17,47,51,72];
const PAGE_SIZE = 1000;
const MAX_DRAWS = 54000;

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

async function loadRows(limit=MAX_DRAWS){
  const out=[];
  for(let offset=0; offset<limit; offset+=PAGE_SIZE){
    const take=Math.min(PAGE_SIZE, limit-offset);
    const page=(await db(`hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=${take}&offset=${offset}`))||[];
    if(!page.length) break;
    out.push(...page);
    if(page.length<take) break;
  }
  return out.filter(r=>Number.isFinite(Number(r?.draw_id))&&norm(r?.numbers).length===20);
}

function key(a){return [...a].sort((x,y)=>x-y).join(',');}
function rank(map,total){return [...map.entries()].map(([number,count])=>({number:Number(number),count,rate:total?Number((count/total).toFixed(6)):0})).sort((a,b)=>b.count-a.count||a.number-b.number);}

module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const rows=await loadRows();
    const latest=rows[0];
    const today=String(latest?.draw_date||'');
    const targetSet=new Set(TARGET);
    const todayRows=rows.filter(r=>String(r.draw_date||'')===today);

    const tripleStats=new Map();
    for(const triple of combos3(TARGET)) tripleStats.set(key(triple),{triple,count:0,events:[],todayCompanionCounts:new Map()});

    for(const row of todayRows){
      const nums=norm(row.numbers); const set=new Set(nums);
      for(const stat of tripleStats.values()){
        if(stat.triple.every(n=>set.has(n))){
          stat.count++;
          const companions=nums.filter(n=>!targetSet.has(n));
          companions.forEach(n=>stat.todayCompanionCounts.set(n,(stat.todayCompanionCounts.get(n)||0)+1));
          stat.events.push({drawId:Number(row.draw_id),time:row.draw_time||'',targetHits:TARGET.filter(n=>set.has(n)),companions});
        }
      }
    }

    const top3=[...tripleStats.values()].sort((a,b)=>b.count-a.count||key(a.triple).localeCompare(key(b.triple))).slice(0,3);

    const history=rows;
    const results=[];
    for(const stat of top3){
      const histComp=new Map(); let histEvents=0;
      for(const row of history){
        const nums=norm(row.numbers), set=new Set(nums);
        if(stat.triple.every(n=>set.has(n))){
          histEvents++;
          nums.filter(n=>!targetSet.has(n)).forEach(n=>histComp.set(n,(histComp.get(n)||0)+1));
        }
      }
      const histTop=rank(histComp,histEvents).slice(0,15);
      const todayRank=rank(stat.todayCompanionCounts,stat.count).slice(0,20);
      const histTopSet=new Set(histTop.map(x=>x.number));
      const overlap=todayRank.filter(x=>histTopSet.has(x.number));
      results.push({
        triple:stat.triple,
        todayCount:stat.count,
        todayEvents:stat.events,
        historyEvents:histEvents,
        historicalTopCompanions:histTop,
        todayTopCompanions:todayRank,
        historicalTopPresentToday:overlap,
        overlapCount:overlap.length
      });
    }

    return res.status(200).json({ok:true,today,latestDrawId:Number(latest?.draw_id||0),todayDraws:todayRows.length,analyzedHistoryDraws:history.length,target:TARGET,top3:results});
  }catch(e){return res.status(500).json({ok:false,error:e.message||String(e)});}
};
