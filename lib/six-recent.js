'use strict';

function validNumbers(numbers, size) {
  return Array.isArray(numbers) && numbers.length === size &&
    new Set(numbers).size === size &&
    numbers.every(n => Number.isInteger(n) && n >= 1 && n <= 80);
}

// At most 30 source numbers: one bit per candidate lets us count same-draw
// matches for every possible five without approximating them with pair totals.
function bitCount(value) {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// The ordering describes past joint appearances, not future hit probability.
function betterJointScore(score, best) {
  if (!best) return true;
  for (const field of ['threePlus', 'fourPlus', 'five', 'recentJointScore', 'pairScore', 'frequency']) {
    if (score[field] !== best[field]) return score[field] > best[field];
  }
  return false;
}

function selectRecentSix(groups, draws, latestId) {
  if (!Array.isArray(groups) || groups.length !== 6 || groups.some(g => !validNumbers(g?.numbers, 5))) throw Error('يلزم وجود ست مجموعات من خمسة أرقام');
  const rows = Array.isArray(draws) ? draws.slice().sort((a, b) => a.draw_id - b.draw_id) : [];
  if (!Number.isSafeInteger(latestId) || rows.length !== 50 || rows.some((d, i) => Number(d.draw_id) !== latestId - 49 + i || !validNumbers(d.numbers, 20))) throw Error('آخر 50 سحبة غير مكتملة؛ أعد المحاولة بعد التحديث');
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
  const bits = new Map(candidates.map((n, i) => [n, 1 << i]));
  const masks = rows.map(d => d.numbers.reduce((mask, n) => mask | (bits.get(n) || 0), 0));
  const weights = rows.map((_, i) => Math.pow(0.5, (49 - i) / 25));
  let combinationsChecked = 0;
  let best = null;
  function visit(selected, start, pairScore, frequency, mask) {
    if (selected.length === 5) {
      combinationsChecked++;
      const score = {threePlus:0, fourPlus:0, five:0, recentJointScore:0, pairScore, frequency};
      for (let i = 0; i < masks.length; i++) {
        const hits = bitCount(mask & masks[i]);
        if (hits >= 3) { score.threePlus++; score.recentJointScore += weights[i]; }
        if (hits >= 4) score.fourPlus++;
        if (hits === 5) score.five++;
      }
      if (betterJointScore(score, best)) best = {numbers:selected.slice(), ...score};
      return;
    }
    for (let i = start; i <= candidates.length - (5 - selected.length); i++) {
      const n = candidates[i];
      const together = selected.reduce((sum, a) => sum + (pairs.get(a + ',' + n) || 0), 0);
      visit([...selected, n], i + 1, pairScore + together, frequency + singles.get(n), mask | bits.get(n));
    }
  }
  visit([], 0, 0, 0, 0);
  if (!best || best.threePlus === 0) throw Error('لم يظهر ثلاثة أرقام معًا من المجموعات الست في آخر 50 سحبة؛ لا توجد مجموعة مؤهلة للاختيار');
  return {...best, have:50, firstDrawId:latestId-49, latestDrawId:latestId,
    lastDrawTime:rows[49].draw_time, lastDrawDate:rows[49].draw_date,
    selectionRule:'joint-3plus-count-v2', candidateCount:candidates.length, combinationsChecked,
    jointCounts:{three:best.threePlus-best.fourPlus, four:best.fourPlus-best.five, five:best.five, threePlus:best.threePlus, fourPlus:best.fourPlus},
    strategy:'أكثر سحبات الظهور المشترك لثلاثة أرقام فأكثر من خمسة',
    evidence:rows.map(d => ({drawId:d.draw_id, date:d.draw_date, time:d.draw_time, matched:best.numbers.filter(n => d.numbers.includes(n))})).filter(d => d.matched.length >= 3)};
}
module.exports = {selectRecentSix};
