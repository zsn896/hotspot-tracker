'use strict';

const ANALYSIS_DRAWS = 50;
const NOMINATION_DRAWS = 30;
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
// checks or the candidate pool. Yield every eligible five without a ranking cap.
function* nominate(pool, trainingMasks, stats) {
  for (let a = 0; a < pool.length - 4; a++)
    for (let b = a + 1; b < pool.length - 3; b++)
      for (let c = b + 1; c < pool.length - 2; c++)
        for (let d = c + 1; d < pool.length - 1; d++)
          for (let e = d + 1; e < pool.length; e++) {
            stats.combinationsChecked++;
            // Six groups of five contain at most 30 distinct numbers, so a
            // positive 30-bit mask suffices; enumerate every complete five.
            const mask = (1 << a) | (1 << b) | (1 << c) | (1 << d) | (1 << e);
            const support = countJointAppearances(mask, trainingMasks);
            if (support.jointCounts.threePlus < MIN_NOMINATION_EVENTS || support.supportedMask !== mask) continue;
            stats.eligibleCandidateCount++;
            yield { mask, numbers: [pool[a], pool[b], pool[c], pool[d], pool[e]], nomination: support.jointCounts };
          }
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
  const stats = { combinationsChecked: 0, eligibleCandidateCount: 0 };
  const comparisonMasks = drawMasks.slice(NOMINATION_DRAWS);
  let winner = null, comparedCandidateCount = 0;
  // Streaming comparison keeps memory and the response bounded even when all
  // 142,506 possible fives qualify. No eligible candidate is truncated.
  for (const candidate of nominate(pool, drawMasks.slice(0, NOMINATION_DRAWS), stats)) {
    candidate.comparison = countJointAppearances(candidate.mask, comparisonMasks).jointCounts;
    comparedCandidateCount++;
    if (!winner || (compareCounts(candidate.comparison, winner.comparison) || compareNominees(candidate, winner)) < 0) winner = candidate;
  }
  if (!winner) {
    throw Error('لا توجد مجموعة مؤهلة: يلزم ظهور 3 أرقام فأكثر في سحبتين من أول 30، ومشاركة كل رقم من الخمسة في ظهور مشترك؛ لن تضاف أرقام بلا دليل');
  }

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
    selectionRule: 'whole-five-all-eligible-30-20-v5', strategy: 'جميع الخماسيات المؤهلة: ترشيح 30 ثم مفاضلة 20',
    candidateCount: pool.length, ...stats, comparedCandidateCount,
    nomination: { have: 30, firstDrawId: latestId - 49, lastDrawId: latestId - 20, jointCounts: winner.nomination },
    comparison: { have: 20, firstDrawId: latestId - 19, lastDrawId: latestId, jointCounts: winner.comparison },
    historicalOnly: true, jointCounts, evidence
  };
}

module.exports = { selectRecentSix };
