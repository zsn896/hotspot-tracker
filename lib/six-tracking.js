'use strict';
function summarizeCycle(numbers, start, latest, draws) {
  const end = start + 20, target = Math.max(start, Math.min(latest, end));
  const byId = new Map(draws.map(d => [Number(d.draw_id), d]));
  const results = [];
  for (let id = start + 1; id <= target; id++) {
    const draw = byId.get(id);
    if (!draw || !Array.isArray(draw.numbers) || new Set(draw.numbers).size !== 20) throw Error('نتائج بعض السحبات غير متوفرة؛ أعد التحديث');
    const matched = numbers.filter(n => draw.numbers.includes(n));
    results.push({drawId:id,date:draw.draw_date,time:draw.draw_time,numbers:draw.numbers,matched,hitCount:matched.length});
  }
  return {startDrawId:start,endDrawId:end,latestDrawId:latest,completed:results.length,remaining:20-results.length,
    finished:results.length===20,results,last:results.at(-1)||null,
    hits:results.filter(r=>r.hitCount>=3).length,
    three:results.filter(r=>r.hitCount===3).length,four:results.filter(r=>r.hitCount===4).length,five:results.filter(r=>r.hitCount===5).length};
}
module.exports={summarizeCycle};
