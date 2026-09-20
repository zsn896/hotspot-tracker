'use strict';

const ANALYSIS_DRAWS = 50;
const NOMINATION_DRAWS = 30;
// Fixed before seeing the comparison draws; never tuned to a winning result.
const SHORTLIST_LIMIT = 20;
const MIN_NOMINATION_EVENTS = 2;

function validNumbers(numbers, size) {
  return Array.isArray(numbers) && numbers.length === size && new Set(numbers).size === size &&
    Array.from(numbers).every(n => Number.isInteger(n) && n >= 1 && n <= 80);
}

function countJointAppearances(mask, drawMasks) {
  let three = 0, four = 0, five = 0, supportedMask = 0;
  for (const drawMask of drawMasks) {
    const matched = mask & drawMask;
    let bits = matched, hits = 0;
    while (bits) { hits++; bits &= bits - 1; }
    // A draw is one event, even when several triples of the five appeared.
    if (hits < 3) continue;
    supportedMask |= matched;
    if (hits === 3) three++;
    else if (hits === 4) four++;
    else five++;
  }
  return { jointCounts: { three, four, five, threePlus: three + four + five, fourPlus: four + five }, supportedMask };
}

// Lexicographic priorities, not a fabricated probability or an arbitrary weighted score.
function compareCounts(a, b) {
  return b.threePlus - a.threePlus || b.fourPlus - a.fourPlus || b.five - a.five;
}

function compareNumbers(a, b) {
  for (let i = 0; i < 5; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function compareNominees(a, b) {
  return compareCounts(a.nomination, b.nomination) || compareNumbers(a.numbers, b.numbers);
}

// The latest 20 draws MUST NOT participate in this stage, including eligibility
// checks, the candidate pool, tie-breaks, or the shortlist size.
function nominate(pool, trainingMasks) {
  const shortlist = [];
  let combinationsChecked = 0, eligibleCandidateCount = 0;
  for (let a = 0; a < pool.length - 4; a++)
    for (let b = a + 1; b < pool.length - 3; b++)
      for (let c = b + 1; c < pool.length - 2; c++)
        for (let d = c + 1; d < pool.length - 1; d++)
          for (let e = d + 1; e < pool.length; e++) {
            combinationsChecked++;
            // Six groups of five contain at most 30 distinct numbers, so a
            // positive 30-bit mask suffices; enumerate every complete five.
            const mask = (1 << a) | (1 << b) | (1 << c) | (1 << d) | (1 << e);
            const support = countJointAppearances(mask, trainingMasks);
            if (support.jointCounts.threePlus < MIN_NOMINATION_EVENTS || support.supportedMask !== mask) continue;
            eligibleCandidateCount++;
            const candidate = { mask, numbers: [pool[a], pool[b], pool[c], pool[d], pool[e]], nomination: support.jointCounts };
            if (shortlist.length === SHORTLIST_LIMIT && compareNominees(candidate, shortlist[shortlist.length - 1]) >= 0) continue;
            let index = 0;
            while (index < shortlist.length && compareNominees(shortlist[index], candidate) <= 0) index++;
            shortlist.splice(index, 0, candidate);
            if (shortlist.length > SHORTLIST_LIMIT) shortlist.pop();
          }
  return { shortlist, combinationsChecked, eligibleCandidateCount };
}

// Descriptive selection only. Both 30 and 20 are used to choose the five;
// neither partition is an independent forecast test. Tracking remains separate.
function selectRecentSix(groups, draws, latestId) {
  if (!Array.isArray(groups) || groups.length !== 6 ||
      Array.from(groups).some(g => !validNumbers(g?.numbers, 5))) {
    throw Error('يلزم وجود ست مجموعات من خمسة أرقام');
  }
  const rows = Array.isArray(draws) ? Array.from(draws).sort((a, b) => Number(a?.draw_id) - Number(b?.draw_id)) : [];
  if (!Number.isSafeInteger(latestId) || latestId < ANALYSIS_DRAWS || rows.length !== ANALYSIS_DRAWS ||
      rows.some((d, i) => Number(d?.draw_id) !== latestId - 49 + i || !validNumbers(d?.numbers, 20))) {
    throw Error('آخر 50 سحبة غير مكتملة؛ أعد المحاولة بعد التحديث');
  }

  const pool = [...new Set(groups.flatMap(g => g.numbers))].sort((a, b) => a - b);
  const numberBits = new Map(pool.map((n, i) => [n, 1 << i]));
  const drawMasks = rows.map(d => d.numbers.reduce((mask, n) => mask | (numberBits.get(n) || 0), 0));
  const { shortlist, combinationsChecked, eligibleCandidateCount } = nominate(pool, drawMasks.slice(0, NOMINATION_DRAWS));
  if (!shortlist.length) {
    throw Error('لا توجد مجموعة مؤهلة: يلزم ظهور 3 أرقام فأكثر في سحبتين من أول 30، ومشاركة كل رقم من الخمسة في ظهور مشترك؛ لن تضاف أرقام بلا دليل');
  }

  const comparisonMasks = drawMasks.slice(NOMINATION_DRAWS);
  const finalists = shortlist.map(candidate => ({
    ...candidate,
    comparison: countJointAppearances(candidate.mask, comparisonMasks).jointCounts
  })).sort((a, b) => compareCounts(a.comparison, b.comparison) || compareNominees(a, b));
  const winner = finalists[0];
  if (!winner.comparison.threePlus) {
    throw Error('لا توجد مجموعة مؤهلة: لم يظهر 3 أرقام معًا لأي خماسية مرشحة في أحدث 20 سحبة؛ أعد التحليل بعد سحبات جديدة');
  }

  const numbers = winner.numbers.slice();
  const evidence = rows.map((d, i) => ({
    drawId: Number(d.draw_id), date: d.draw_date, time: d.draw_time,
    matched: numbers.filter(n => d.numbers.includes(n)),
    phase: i < NOMINATION_DRAWS ? 'nomination' : 'comparison'
  })).filter(d => d.matched.length >= 3);
  const jointCounts = {};
  for (const key of ['three', 'four', 'five', 'threePlus', 'fourPlus']) {
    jointCounts[key] = winner.nomination[key] + winner.comparison[key];
  }

  return {
    numbers, have: ANALYSIS_DRAWS, firstDrawId: latestId - 49, latestDrawId: latestId,
    lastDrawTime: rows[49].draw_time, lastDrawDate: rows[49].draw_date,
    selectionRule: 'whole-five-temporal-30-20-v4', strategy: 'خماسية كاملة: ترشيح 30 ثم مفاضلة 20',
    candidateCount: pool.length, combinationsChecked, eligibleCandidateCount,
    shortlistLimit: SHORTLIST_LIMIT, shortlistSize: shortlist.length,
    // Nomination order is preserved for auditing the chronological separation.
    shortlist: shortlist.map(c => ({ numbers: c.numbers, jointCounts: c.nomination })),
    nomination: { have: 30, firstDrawId: latestId - 49, lastDrawId: latestId - 20, jointCounts: winner.nomination },
    comparison: { have: 20, firstDrawId: latestId - 19, lastDrawId: latestId, jointCounts: winner.comparison },
    historicalOnly: true, jointCounts, evidence
  };
}

module.exports = { selectRecentSix };
