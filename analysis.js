'use strict';

const {
  POOL_SIZE, GROUP_SIZE, MAX_INTERSECTION_FOR_COMBOS, ALPHA,
  TRACKING_BLOCK_SIZE, DRAW_INTERVAL_MIN,
} = require('./config');
const S = require('./stats');
const { parseDrawMinutes, formatMinutes, projectDrawTime } = require('./time');

const drawId = (d) => Number(d.draw_id ?? d.id);
const drawTime = (d) => d.draw_time ?? d.time;
const drawNumbers = (d) => d.numbers || [];

// ---------------------------------------------------------------------------
// Compact encoding for 5-number groups
//
// A sorted 5-subset of 1..80 packs into one integer below 80^5 = 3.3e9, well
// inside the exact-integer range of a double. Storing candidates as numbers
// rather than "3,17,41,58,79" strings cuts both memory and hashing cost by a
// large factor, which matters when the search space is ~35,000 candidates.
// ---------------------------------------------------------------------------

function encodeGroup(sorted) {
  let key = 0;
  for (const n of sorted) key = key * POOL_SIZE + (n - 1);
  return key;
}

function decodeGroup(key) {
  const out = new Array(GROUP_SIZE);
  for (let i = GROUP_SIZE - 1; i >= 0; i--) {
    out[i] = (key % POOL_SIZE) + 1;
    key = Math.floor(key / POOL_SIZE);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bitset occurrence index
//
// Counting how often a 5-group appears used to be O(draws x 5) set lookups per
// candidate — roughly 15 million operations for one selection run. Here each
// number carries a bitmap of the draws it appeared in, so a candidate's count is
// four ANDs and a popcount over a handful of 32-bit words.
// ---------------------------------------------------------------------------

function popcount(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

function buildOccurrenceIndex(draws) {
  const words = Math.ceil(draws.length / 32) || 1;
  const masks = Array.from({ length: POOL_SIZE + 1 }, () => new Uint32Array(words));
  draws.forEach((draw, i) => {
    const word = i >>> 5;
    const bit = 1 << (i & 31);
    for (const n of drawNumbers(draw)) {
      if (n >= 1 && n <= POOL_SIZE) masks[n][word] |= bit;
    }
  });
  return { masks, words, size: draws.length };
}

function countOccurrences(numbers, index) {
  const { masks, words } = index;
  let total = 0;
  for (let w = 0; w < words; w++) {
    let acc = masks[numbers[0]][w];
    for (let i = 1; i < numbers.length && acc; i++) acc &= masks[numbers[i]][w];
    if (acc) total += popcount(acc);
  }
  return total;
}

/** Indices of the draws containing every number in the group. */
function occurrenceIndices(numbers, index) {
  const { masks, words } = index;
  const out = [];
  for (let w = 0; w < words; w++) {
    let acc = masks[numbers[0]][w];
    for (let i = 1; i < numbers.length && acc; i++) acc &= masks[numbers[i]][w];
    while (acc) {
      const bit = acc & -acc;
      out.push(w * 32 + Math.log2(bit >>> 0));
      acc ^= bit;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

function forEachCombination(sorted, size, visit) {
  const n = sorted.length;
  if (n < size || n > MAX_INTERSECTION_FOR_COMBOS) return;
  const idx = new Array(size).fill(0).map((_, i) => i);
  const pick = new Array(size);
  for (;;) {
    for (let i = 0; i < size; i++) pick[i] = sorted[idx[i]];
    visit(pick);
    let i = size - 1;
    while (i >= 0 && idx[i] === n - size + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1] + 1;
  }
}

/**
 * Every 5-subset shared by at least one pair of draws in `draws`.
 *
 * The cap on intersection size is a guard, not a heuristic: two draws sharing 20
 * numbers would generate C(20,5) = 15,504 candidates from a single pair, and a
 * handful of such pairs could blow past the function timeout. Intersections
 * larger than 12 are astronomically rare (the mean overlap is 5), and the cap is
 * reported so a skipped pair is never silent.
 */
function mineCandidates(draws) {
  const numbers = draws.map((d) => [...drawNumbers(d)].sort((a, b) => a - b));
  const present = draws.map((d) => {
    const flags = new Uint8Array(POOL_SIZE + 1);
    for (const n of drawNumbers(d)) flags[n] = 1;
    return flags;
  });

  const candidates = new Set();
  let skippedPairs = 0;
  let largestIntersection = 0;

  for (let i = 0; i < draws.length - 1; i++) {
    const flags = present[i];
    for (let j = i + 1; j < draws.length; j++) {
      const shared = numbers[j].filter((n) => flags[n]);
      if (shared.length > largestIntersection) largestIntersection = shared.length;
      if (shared.length < GROUP_SIZE) continue;
      if (shared.length > MAX_INTERSECTION_FOR_COMBOS) { skippedPairs++; continue; }
      forEachCombination(shared, GROUP_SIZE, (combo) => candidates.add(encodeGroup(combo)));
    }
  }
  return { candidates, skippedPairs, largestIntersection };
}

// ---------------------------------------------------------------------------
// Timing / gap description
// ---------------------------------------------------------------------------

/**
 * Descriptive statistics for one group over a window of draws: when it appeared,
 * how far apart the appearances were, and a projected next-appearance window.
 *
 * The projection is deliberately labelled as description, not prediction. Hot
 * Spot draws are independent, so the interval below says "if the observed spacing
 * continued, it would land here" — it carries no information about the next draw.
 */
function groupTimingStats(draws, numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const occurrences = [];
  for (const d of draws) {
    const drawn = new Set(drawNumbers(d));
    if (sorted.every((n) => drawn.has(n))) occurrences.push(drawId(d));
  }

  const gaps = [];
  for (let i = 1; i < occurrences.length; i++) gaps.push(occurrences[i] - occurrences[i - 1]);

  const avg = S.mean(gaps);
  const med = S.median(gaps);
  const sd = S.stdev(gaps);
  const cv = avg > 0 ? sd / avg : null;

  const latestId = draws.length ? drawId(draws[draws.length - 1]) : null;
  const latestMinutes = draws.length ? parseDrawMinutes(drawTime(draws[draws.length - 1])) : null;
  const lastSeen = occurrences.length ? occurrences[occurrences.length - 1] : null;
  const expectedGap = gaps.length ? Math.max(1, Math.round((avg + med) / 2)) : null;

  let centre = lastSeen && expectedGap ? lastSeen + expectedGap : null;
  if (centre) while (centre <= latestId) centre += expectedGap;

  // With one or two observed gaps the sample deviation is not a usable width
  // (a single gap has zero spread by definition, which would render as a falsely
  // precise window). Fall back to a width proportional to the gap itself and
  // widen by 1 + 2/n, so n=1 triples the interval and the inflation decays
  // towards 1 as evidence accumulates.
  const n = gaps.length;
  const baseHalf = sd > 0 ? sd / 2 : (expectedGap ? expectedGap * 0.4 : null);
  const half = baseHalf != null ? Math.max(2, Math.round(baseHalf * (n ? 1 + 2 / n : 1))) : null;
  const from = centre && half != null ? Math.max(latestId + 1, centre - half) : null;
  const to = centre && half != null ? centre + half : null;

  const clock = (id) => projectDrawTime(id, latestId, latestMinutes);
  const evidence = gaps.length === 0 ? 'none'
    : gaps.length === 1 ? 'very low'
      : gaps.length <= 3 ? 'low'
        : gaps.length <= 6 ? 'moderate' : 'higher';

  const times = new Map(draws.map((d) => [drawId(d), parseDrawMinutes(drawTime(d))]));

  return {
    numbers: sorted,
    count: occurrences.length,
    occurrences,
    gaps,
    meanGap: gaps.length ? +avg.toFixed(2) : null,
    medianGap: gaps.length ? +med.toFixed(2) : null,
    minGap: gaps.length ? Math.min(...gaps) : null,
    maxGap: gaps.length ? Math.max(...gaps) : null,
    standardDeviation: +sd.toFixed(2),
    coefficientVariation: cv == null ? null : +cv.toFixed(3),
    lastDrawId: lastSeen,
    lastAppearanceTime: lastSeen ? formatMinutes(times.get(lastSeen)) : null,
    sinceLastDraws: lastSeen ? latestId - lastSeen : null,
    sinceLastMinutes: lastSeen ? (latestId - lastSeen) * DRAW_INTERVAL_MIN : null,
    expectedGapDraws: expectedGap,
    expectedCentreDrawId: centre,
    expectedFromDrawId: from,
    expectedToDrawId: to,
    expectedCentreTime: clock(centre),
    expectedFromTime: clock(from),
    expectedToTime: clock(to),
    gapEvidence: evidence,
    gapsObserved: gaps.length,
  };
}

// ---------------------------------------------------------------------------
// Group selection
// ---------------------------------------------------------------------------

/**
 * Choose the groups to track.
 *
 * Design: candidates are mined from the FIRST half of the window and scored on
 * the SECOND half only. This matters. Every candidate is, by construction, a
 * subset shared by the pair of draws that produced it, so it always has at least
 * two hits in the data it came from — ranking by frequency over that same window
 * is circular and flags a "hot" group virtually every time, even on purely random
 * input. Splitting the window makes the score an honest out-of-sample count.
 *
 * The returned `chanceBenchmark` is the piece that keeps the result interpretable:
 * for each hit level it states how many candidates a random game would be
 * expected to produce at that level, next to how many were actually observed. By
 * linearity of expectation that comparison is exact even though the candidates
 * overlap heavily.
 */
function selectGroups(draws, { limit = 2, alpha = ALPHA } = {}) {
  if (!Array.isArray(draws) || draws.length < 8) {
    return { groups: [], diagnostics: { error: 'Not enough draws to run a split-sample analysis' } };
  }

  const startedAt = Date.now();
  const mid = Math.floor(draws.length / 2);
  const mineWindow = draws.slice(0, mid);
  const testWindow = draws.slice(mid);

  const { candidates, skippedPairs, largestIntersection } = mineCandidates(mineWindow);
  const index = buildOccurrenceIndex(testWindow);
  const singleDrawProb = S.fullHitProbability();

  const scored = [];
  const histogram = new Map(); // out-of-sample count -> number of candidates
  for (const key of candidates) {
    const numbers = decodeGroup(key);
    const count = countOccurrences(numbers, index);
    histogram.set(count, (histogram.get(count) || 0) + 1);
    if (count >= 1) scored.push({ numbers, outOfSampleCount: count });
  }

  for (const c of scored) {
    c.pValue = S.binomialTailAtLeast(c.outOfSampleCount, testWindow.length, singleDrawProb);
  }
  scored.sort((a, b) => a.pValue - b.pValue
    || b.outOfSampleCount - a.outOfSampleCount
    || a.numbers.join(',').localeCompare(b.numbers.join(',')));

  const tested = candidates.size;
  const bonferroni = S.bonferroniThreshold(tested, alpha);
  const bh = S.benjaminiHochberg(scored.map((c) => c.pValue), alpha, tested);

  // How many candidates would a fair game be expected to push to each level?
  const maxCount = Math.max(0, ...histogram.keys());
  const chanceBenchmark = [];
  for (let k = 1; k <= Math.max(1, maxCount); k++) {
    let observed = 0;
    for (const [count, n] of histogram) if (count >= k) observed += n;
    chanceBenchmark.push({
      atLeast: k,
      observedCandidates: observed,
      expectedIfRandom: +(tested * S.binomialTailAtLeast(k, testWindow.length, singleDrawProb)).toFixed(1),
    });
  }

  const groups = scored.slice(0, limit).map((c, rank) => {
    const stats = groupTimingStats(draws, c.numbers);
    return {
      ...stats,
      rank: rank + 1,
      outOfSampleCount: c.outOfSampleCount,
      pValue: c.pValue,
      pValueFormatted: c.pValue.toExponential(2),
      passesBonferroni: c.pValue < bonferroni,
      passesFdr: Boolean(bh.rejected[scored.indexOf(c)]),
      verdict: c.pValue < bonferroni
        ? 'Stronger than chance after correcting for the search'
        : 'Indistinguishable from chance once the search size is accounted for',
    };
  });

  return {
    groups,
    diagnostics: {
      windowDraws: draws.length,
      mineWindowDraws: mineWindow.length,
      testWindowDraws: testWindow.length,
      candidatesTested: tested,
      candidatesWithOutOfSampleHit: scored.length,
      skippedPairs,
      largestIntersection,
      singleDrawProbability: singleDrawProb,
      oneInN: Math.round(1 / singleDrawProb),
      bonferroniThreshold: bonferroni,
      fdrCutoff: bh.cutoff,
      alpha,
      chanceBenchmark,
      anySignificant: groups.some((g) => g.passesBonferroni),
      elapsedMs: Date.now() - startedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Tracking performance
// ---------------------------------------------------------------------------

/** One 20-draw report block. */
function blockReport(rows, blockNumber, size = TRACKING_BLOCK_SIZE) {
  const slice = rows.slice((blockNumber - 1) * size, blockNumber * size);
  if (slice.length < size) return null;

  const histogram = new Array(GROUP_SIZE + 1).fill(0);
  for (const r of slice) histogram[Math.min(GROUP_SIZE, r.hit_count)]++;
  const totalHits = slice.reduce((s, r) => s + r.hit_count, 0);

  return {
    block: blockNumber,
    fromDrawId: slice[0].draw_id,
    toDrawId: slice[slice.length - 1].draw_id,
    fromTime: slice[0].time || '',
    toTime: slice[slice.length - 1].time || '',
    bestHit: Math.max(...slice.map((r) => r.hit_count)),
    exact5: histogram[5],
    fourPlus: histogram[4] + histogram[5],
    threePlus: histogram[3] + histogram[4] + histogram[5],
    averageHits: +(totalHits / size).toFixed(2),
    bullsEyeMatches: slice.filter((r) => r.bulls_eye_match).length,
    distribution: histogram,
  };
}

/**
 * Measure tracked results against the exact chance model.
 *
 * This is the answer to the question the whole app exists to ask. It reports the
 * observed hit distribution beside the theoretical one, a chi-square
 * goodness-of-fit test, and the average hits per draw against the fixed
 * expectation of 1.25. A tracked group performing exactly at chance is the
 * expected outcome, and the interface should be able to say so with a number.
 */
function evaluateTracking(rows) {
  const n = rows.length;
  const expectedProbs = S.hitDistribution();
  if (!n) {
    return { draws: 0, expectedProbs, observed: new Array(GROUP_SIZE + 1).fill(0), ready: false };
  }

  const observed = new Array(GROUP_SIZE + 1).fill(0);
  for (const r of rows) observed[Math.min(GROUP_SIZE, r.hit_count)]++;

  const totalHits = rows.reduce((s, r) => s + r.hit_count, 0);
  const observedMean = totalHits / n;
  const expectedMean = S.expectedHitsPerDraw();

  // Standard error of the mean hit count under the chance model.
  const variance = expectedProbs.reduce((s, p, k) => s + p * (k - expectedMean) ** 2, 0);
  const se = Math.sqrt(variance / n);
  const z = se > 0 ? (observedMean - expectedMean) / se : 0;

  const gof = S.chiSquareGoodnessOfFit(observed, expectedProbs);
  const threePlus = observed[3] + observed[4] + observed[5];
  const bullsEyeHits = rows.filter((r) => r.bulls_eye_match).length;

  return {
    draws: n,
    ready: true,
    observed,
    expected: expectedProbs.map((p) => +(p * n).toFixed(2)),
    expectedProbs,
    observedMeanHits: +observedMean.toFixed(3),
    expectedMeanHits: expectedMean,
    meanZScore: +z.toFixed(2),
    // Two-sided normal p-value for the mean-hits difference.
    meanPValue: +(2 * (1 - normalCdf(Math.abs(z)))).toFixed(4),
    chiSquare: gof,
    threePlus: { count: threePlus, rate: +(threePlus / n).toFixed(4), interval: S.wilsonInterval(threePlus, n) },
    expectedThreePlusRate: +(expectedProbs[3] + expectedProbs[4] + expectedProbs[5]).toFixed(4),
    exactFive: { count: observed[5], expected: +(expectedProbs[5] * n).toFixed(3) },
    bullsEye: {
      count: bullsEyeHits,
      rate: +(bullsEyeHits / n).toFixed(4),
      expectedRate: GROUP_SIZE / POOL_SIZE,
      interval: S.wilsonInterval(bullsEyeHits, n),
    },
    conclusion: gof.pValue >= 0.05
      ? 'Results match the chance model — no measurable edge.'
      : 'Results differ from the chance model in this sample.',
  };
}

/** Abramowitz & Stegun 26.2.17 — plenty accurate for a display statistic. */
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

module.exports = {
  encodeGroup, decodeGroup,
  buildOccurrenceIndex, countOccurrences, occurrenceIndices, popcount,
  forEachCombination, mineCandidates,
  groupTimingStats, selectGroups,
  blockReport, evaluateTracking, normalCdf,
};
