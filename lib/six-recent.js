'use strict';

// Rank only candidates belonging to the six groups, using one pinned live window.
function selectRecentSix(groups, draws, latestId) {
  const rows = draws.slice().sort((a, b) => a.draw_id - b.draw_id);
  if (groups.length !== 6 || groups.some(g => g.numbers.length !== 5)) throw Error('يلزم وجود ست مجموعات من خمسة أرقام');
  if (rows.length !== 50 || rows.some((d, i) => Number(d.draw_id) !== latestId - 49 + i || new Set(d.numbers).size !== 20)) throw Error('آخر 50 سحبة غير مكتملة؛ أعد المحاولة بعد التحديث');
  const pool = [...new Set(groups.flatMap(g => g.numbers))].sort((a,b) => a-b);
  const singles = new Map(), pairs = new Map();
  rows.forEach((d, i) => {
    const present = pool.filter(n => d.numbers.includes(n));
    const weight = Math.pow(0.5, (49 - i) / 25);
    present.forEach(n => singles.set(n, (singles.get(n) || 0) + weight));
    present.forEach((a, j) => present.slice(j + 1).forEach(b => {
      const key = a + ',' + b;
      pairs.set(key, (pairs.get(key) || 0) + weight);
    }));
  });
  const candidates = pool.filter(n => singles.has(n));
  let best = null;
  function visit(selected, start, pairScore, frequency) {
    if (selected.length === 5) {
      if (!best || pairScore > best.pairScore || (pairScore === best.pairScore && frequency > best.frequency)) best = {numbers:selected.slice(),pairScore,frequency};
      return;
    }
    for (let i = start; i <= candidates.length - (5 - selected.length); i++) {
      const n = candidates[i];
      const together = selected.reduce((sum, a) => sum + (pairs.get(a + ',' + n) || 0), 0);
      visit([...selected, n], i + 1, pairScore + together, frequency + singles.get(n));
    }
  }
  visit([], 0, 0, 0);
  if (!best || best.pairScore === 0) throw Error('لا توجد بيانات ظهور مشترك كافية للاختيار');
  return {...best, have:50, firstDrawId:latestId-49, latestDrawId:latestId,
    lastDrawTime:rows[49].draw_time, lastDrawDate:rows[49].draw_date,
    strategy:'الظهور المشترك في آخر 50 سحبة',
    evidence:rows.map(d => ({drawId:d.draw_id, time:d.draw_time, matched:best.numbers.filter(n => d.numbers.includes(n))})).filter(d => d.matched.length >= 3)};
}
module.exports = {selectRecentSix};
