'use strict';

function validNumbers(numbers, size) {
  return Array.isArray(numbers) && numbers.length === size && new Set(numbers).size === size &&
    numbers.every(n => Number.isInteger(n) && n >= 1 && n <= 80);
}

// Descriptive ranking only: no score here is a forecast probability.
function selectRecentSix(groups, draws, latestId) {
  if (!Array.isArray(groups) || groups.length !== 6 || groups.some(g => !validNumbers(g?.numbers, 5))) throw Error('يلزم وجود ست مجموعات من خمسة أرقام');
  const rows = Array.isArray(draws) ? draws.slice().sort((a,b) => a.draw_id-b.draw_id) : [];
  if (!Number.isSafeInteger(latestId) || rows.length !== 50 || rows.some((d,i) => Number(d.draw_id) !== latestId-49+i || !validNumbers(d.numbers,20))) throw Error('آخر 50 سحبة غير مكتملة؛ أعد المحاولة بعد التحديث');
  const pool = [...new Set(groups.flatMap(g=>g.numbers))].sort((a,b)=>a-b);
  const sets = rows.map(d=>new Set(d.numbers));
  const weights = rows.map((_,i)=>Math.pow(0.5,(49-i)/25));
  const cores=[];
  let combinationsChecked=0;
  for(let a=0;a<pool.length-2;a++)for(let b=a+1;b<pool.length-1;b++)for(let c=b+1;c<pool.length;c++){
    combinationsChecked++;
    const numbers=[pool[a],pool[b],pool[c]], indices=[];
    sets.forEach((s,i)=>{if(numbers.every(n=>s.has(n)))indices.push(i)});
    // A one-off triple is not a recurring core.
    if(indices.length<2)continue;
    const segments=Array(5).fill(0);indices.forEach(i=>segments[Math.floor(i/10)]++);
    cores.push({numbers,indices,count:indices.length,weightedCount:indices.reduce((sum,i)=>sum+weights[i],0),
      recent10:indices.filter(i=>i>=40).length,recent20:indices.filter(i=>i>=30).length,segments});
  }
  cores.sort((a,b)=>b.weightedCount-a.weightedCount||b.count-a.count||b.recent10-a.recent10||
    b.segments.filter(Boolean).length-a.segments.filter(Boolean).length||a.numbers[0]-b.numbers[0]||a.numbers[1]-b.numbers[1]||a.numbers[2]-b.numbers[2]);
  let chosen=null;
  for(const core of cores){
    // Companion support is counted ONLY on draws containing the complete core.
    const companions=pool.filter(n=>!core.numbers.includes(n)).map(number=>{
      const indices=core.indices.filter(i=>sets[i].has(number));
      return {number,count:indices.length,weightedCount:indices.reduce((sum,i)=>sum+weights[i],0),drawIds:indices.map(i=>rows[i].draw_id)};
    }).filter(x=>x.count>0);
    if(companions.length<2)continue;
    let pair=null;
    for(let a=0;a<companions.length-1;a++)for(let b=a+1;b<companions.length;b++){
      const selected=[companions[a],companions[b]];
      const both=core.indices.filter(i=>selected.every(n=>sets[i].has(n.number)));
      const score=selected[0].weightedCount+selected[1].weightedCount;
      const bothScore=both.reduce((sum,i)=>sum+weights[i],0);
      if(!pair||score>pair.score||(score===pair.score&&bothScore>pair.bothScore))pair={selected,score,bothScore,both};
    }
    chosen={core,pair};break;
  }
  if(!chosen)throw Error('لا توجد مجموعة مؤهلة: يلزم تكرار الثلاثية مرتين ووجود رقمين ظهرا معها؛ لن تضاف أرقام بلا دليل');
  const {core,pair}=chosen;
  const numbers=[...core.numbers,...pair.selected.map(x=>x.number)].sort((a,b)=>a-b);
  const evidence=rows.map(d=>({drawId:d.draw_id,date:d.draw_date,time:d.draw_time,matched:numbers.filter(n=>d.numbers.includes(n))})).filter(d=>d.matched.length>=3);
  const three=evidence.filter(d=>d.matched.length===3).length,four=evidence.filter(d=>d.matched.length===4).length,five=evidence.filter(d=>d.matched.length===5).length;
  return {numbers,core:core.numbers,additions:pair.selected.map(x=>x.number),
    have:50,firstDrawId:latestId-49,latestDrawId:latestId,lastDrawTime:rows[49].draw_time,lastDrawDate:rows[49].draw_date,
    selectionRule:'fixed-core-conditional-v3',strategy:'ثلاثية ثابتة متكررة ورقمان ظهرا معها',candidateCount:pool.length,combinationsChecked,
    coreEvidence:{count:core.count,weightedCount:core.weightedCount,recent10:core.recent10,recent20:core.recent20,segments:core.segments,
      drawIds:core.indices.map(i=>rows[i].draw_id)},
    companionEvidence:pair.selected,fullFiveWithCore:pair.both.length,
    jointCounts:{three,four,five,threePlus:three+four+five,fourPlus:four+five},evidence};
}
module.exports={selectRecentSix};
