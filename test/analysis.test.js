'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/analysis');
const T = require('../lib/time');
const { makeRng, randomDraw } = require('./simulate');

function draw(id, numbers, time = '6:00 p.m.') {
  return { draw_id: id, draw_time: time, numbers: [...numbers].sort((a, b) => a - b) };
}

const rng = makeRng(7);
const randomWindow = (n, start = 9000000) => Array.from({ length: n }, (_, i) => randomDraw(rng, start, i));

test('group encoding round-trips for every ordering', () => {
  for (const g of [[1, 2, 3, 4, 5], [76, 77, 78, 79, 80], [4, 19, 33, 51, 68]]) {
    assert.deepEqual(A.decodeGroup(A.encodeGroup(g)), g);
  }
});

test('popcount is correct', () => {
  assert.equal(A.popcount(0), 0);
  assert.equal(A.popcount(0xffffffff), 32);
  assert.equal(A.popcount(0b1011), 3);
});

test('bitset counting matches a brute-force scan', () => {
  const draws = randomWindow(64);
  const index = A.buildOccurrenceIndex(draws);
  for (let t = 0; t < 200; t++) {
    const source = draws[t % draws.length].numbers;
    const group = [...source].slice(0, 5).sort((a, b) => a - b);
    const brute = draws.filter((d) => group.every((n) => d.numbers.includes(n))).length;
    assert.equal(A.countOccurrences(group, index), brute);
    assert.equal(A.occurrenceIndices(group, index).length, brute);
  }
});

test('combination enumeration produces C(n,5) unique subsets', () => {
  const seen = new Set();
  A.forEachCombination([1, 2, 3, 4, 5, 6, 7], 5, (c) => seen.add(c.join(',')));
  assert.equal(seen.size, 21); // C(7,5)
  // Above the safety cap nothing is enumerated at all.
  const capped = [];
  A.forEachCombination(Array.from({ length: 20 }, (_, i) => i + 1), 5, (c) => capped.push(c));
  assert.equal(capped.length, 0);
});

test('mining reports the intersection cap instead of hiding it', () => {
  const shared = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const draws = [
    draw(1, [...shared, 71, 72, 73, 74, 75, 76]),
    draw(2, [...shared, 61, 62, 63, 64, 65, 66]),
  ];
  const { skippedPairs, largestIntersection, candidates } = A.mineCandidates(draws);
  assert.equal(largestIntersection, 14);
  assert.equal(skippedPairs, 1);
  assert.equal(candidates.size, 0);
});

test('timing stats describe gaps and never invent a zero-width window', () => {
  const g = [1, 2, 3, 4, 5];
  const filler = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
  const draws = [];
  for (let i = 0; i < 30; i++) {
    draws.push(draw(1000 + i, i % 10 === 0 ? [...g, ...filler.slice(0, 15)] : filler));
  }
  const stats = A.groupTimingStats(draws, g);
  assert.deepEqual(stats.occurrences, [1000, 1010, 1020]);
  assert.deepEqual(stats.gaps, [10, 10]);
  assert.equal(stats.meanGap, 10);
  assert.equal(stats.gapsObserved, 2);
  // Two identical gaps give sd = 0; the window must still have real width.
  assert.ok(stats.expectedToDrawId - stats.expectedFromDrawId >= 4);
  assert.ok(stats.expectedFromDrawId > 1029, 'window must lie ahead of the latest draw');
  assert.equal(stats.gapEvidence, 'low');
});

test('timing stats handle a group that never appears', () => {
  const stats = A.groupTimingStats(randomWindow(20), [1, 2, 3, 4, 5].map((n) => n));
  assert.ok(stats.count >= 0);
  if (stats.count === 0) {
    assert.equal(stats.lastDrawId, null);
    assert.equal(stats.expectedFromDrawId, null);
    assert.equal(stats.gapEvidence, 'none');
  }
});

test('selection refuses to run on too little data', () => {
  const { groups, diagnostics } = A.selectGroups(randomWindow(4));
  assert.equal(groups.length, 0);
  assert.ok(diagnostics.error);
});

test('selection scores out of sample, not on the mining window', () => {
  const { groups, diagnostics } = A.selectGroups(randomWindow(120), { limit: 2 });
  assert.equal(diagnostics.mineWindowDraws + diagnostics.testWindowDraws, 120);
  assert.equal(diagnostics.mineWindowDraws, 60);
  assert.ok(diagnostics.candidatesTested > 0);
  for (const g of groups) {
    // A count scored on the mining half would be >= 2 by construction; an
    // out-of-sample count is free to be 1.
    assert.ok(g.outOfSampleCount >= 1);
    assert.ok(g.outOfSampleCount <= diagnostics.testWindowDraws);
    assert.ok(g.pValue >= 0 && g.pValue <= 1);
  }
});

test('chance benchmark expectations are internally consistent', () => {
  const { diagnostics } = A.selectGroups(randomWindow(180));
  const level1 = diagnostics.chanceBenchmark[0];
  assert.equal(level1.atLeast, 1);
  assert.equal(level1.observedCandidates, diagnostics.candidatesWithOutOfSampleHit);
  // Expectation is exact by linearity even though candidates overlap heavily.
  const ratio = level1.observedCandidates / level1.expectedIfRandom;
  assert.ok(ratio > 0.5 && ratio < 2, `observed/expected out of range: ${ratio}`);
  // Counts must be monotone decreasing as the threshold rises.
  for (let i = 1; i < diagnostics.chanceBenchmark.length; i++) {
    assert.ok(diagnostics.chanceBenchmark[i].observedCandidates <= diagnostics.chanceBenchmark[i - 1].observedCandidates);
  }
});

test('a planted group is detected and flagged as significant', () => {
  // Sanity check in the other direction: the selector must not be blind.
  const planted = [6, 17, 28, 39, 52];
  const draws = randomWindow(160).map((d, i) => {
    if (i % 7 !== 0) return d;
    const rest = d.numbers.filter((n) => !planted.includes(n)).slice(0, 15);
    return { ...d, numbers: [...planted, ...rest].sort((a, b) => a - b) };
  });
  const { groups } = A.selectGroups(draws, { limit: 2 });
  assert.equal(groups[0].numbers.join(','), planted.join(','));
  assert.ok(groups[0].passesBonferroni, 'a genuine signal must survive the correction');
});

test('block report summarises exactly 20 draws', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    draw_id: 500 + i, hit_count: i % 4, bulls_eye_match: i % 5 === 0, time: '7:00 p.m.',
  }));
  const block = A.blockReport(rows, 1);
  assert.equal(block.fromDrawId, 500);
  assert.equal(block.toDrawId, 519);
  assert.equal(block.distribution.reduce((a, b) => a + b, 0), 20);
  assert.equal(block.bestHit, 3);
  assert.equal(A.blockReport(rows, 2), null, 'an incomplete block yields no report');
});

test('tracking evaluation matches the chance model on chance-like data', () => {
  const probs = require('../lib/stats').hitDistribution();
  const rows = [];
  probs.forEach((p, k) => {
    for (let i = 0; i < Math.round(p * 4000); i++) rows.push({ hit_count: k, bulls_eye_match: false });
  });
  const evaluation = A.evaluateTracking(rows);
  assert.ok(Math.abs(evaluation.observedMeanHits - 1.25) < 0.02);
  assert.ok(evaluation.chiSquare.pValue > 0.9);
  assert.match(evaluation.conclusion, /no measurable edge/);
});

test('tracking evaluation flags data that does not fit', () => {
  const rows = Array.from({ length: 200 }, () => ({ hit_count: 4, bulls_eye_match: true }));
  const evaluation = A.evaluateTracking(rows);
  assert.ok(evaluation.chiSquare.pValue < 1e-6);
  assert.equal(evaluation.observedMeanHits, 4);
  assert.ok(evaluation.meanZScore > 10);
});

test('tracking evaluation is safe with no rows', () => {
  const evaluation = A.evaluateTracking([]);
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.draws, 0);
});

test('normal CDF matches known quantiles', () => {
  assert.ok(Math.abs(A.normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(A.normalCdf(1.959964) - 0.975) < 1e-5);
  assert.ok(Math.abs(A.normalCdf(-1.959964) - 0.025) < 1e-5);
});

// --- time helpers ---------------------------------------------------------

test('draw times parse and format round-trip', () => {
  assert.equal(T.parseDrawMinutes('6:04 p.m.'), 18 * 60 + 4);
  assert.equal(T.parseDrawMinutes('12:00 a.m.'), 0);
  assert.equal(T.parseDrawMinutes('12:30 p.m.'), 12 * 60 + 30);
  assert.equal(T.parseDrawMinutes('nonsense'), null);
  assert.equal(T.formatMinutes(0), '12:00 AM');
  assert.equal(T.formatMinutes(13 * 60 + 5), '1:05 PM');
  assert.equal(T.formatMinutes(1440 + 60), '1:00 AM', 'must wrap past midnight');
});

test('cycle boundaries put the small hours in the previous cycle', () => {
  assert.equal(T.cycleDateKey({ minutes: 60, dateKey: '2026-06-04' }), '2026-06-03');
  assert.equal(T.cycleDateKey({ minutes: 700, dateKey: '2026-06-04' }), '2026-06-04');
  assert.equal(T.previousDateKey('2026-01-01'), '2025-12-31');
  assert.equal(T.previousDateKey('2024-03-01'), '2024-02-29', 'leap year');
});

test('schedule mode covers every minute of the day exactly once', () => {
  const seen = new Set();
  for (let m = 0; m < 1440; m++) seen.add(T.scheduleMode(m, true));
  assert.deepEqual([...seen].sort(), ['cleanup', 'collecting', 'idle', 'tracking']);
  assert.equal(T.scheduleMode(6 * 60), 'collecting');
  assert.equal(T.scheduleMode(18 * 60, false), 'preparing');
  assert.equal(T.scheduleMode(18 * 60, true), 'tracking');
  assert.equal(T.scheduleMode(2 * 60), 'idle');
  assert.equal(T.scheduleMode(2 * 60 + 30), 'cleanup');
  assert.equal(T.scheduleMode(23 * 60, true), 'tracking');
  assert.equal(T.scheduleMode(1 * 60, true), 'tracking');
});

test('projected draw times follow the four-minute cadence', () => {
  assert.equal(T.projectDrawTime(105, 100, 18 * 60), '6:20 PM');
  assert.equal(T.projectDrawTime(95, 100, 18 * 60), '5:40 PM');
  assert.equal(T.projectDrawTime(null, 100, 18 * 60), null);
});

// --- worker helpers -------------------------------------------------------

test('collection start id is inferred from the four-minute cadence', () => {
  const { inferCollectionStartId } = require('../api/worker');
  const ok = inferCollectionStartId({ id: 1000, time: '6:00 a.m.' }, { minutes: 6 * 60 });
  assert.equal(ok.startId, 1000);

  const noon = inferCollectionStartId({ id: 1090, time: '12:00 p.m.' }, { minutes: 12 * 60 });
  assert.equal(noon.startId, 1000, '6 hours = 90 draws');

  // A stale anchor from outside the 6:00 AM - 2:00 AM window must be refused
  // rather than silently anchoring the whole cycle in the wrong place.
  const stale = inferCollectionStartId({ id: 1000, time: '4:00 a.m.' }, { minutes: 7 * 60 });
  assert.ok(stale.error);
  assert.equal(stale.startId, undefined);

  assert.ok(inferCollectionStartId({ id: 1000, time: 'garbage' }, { minutes: 400 }).error);
});

test('worker secret comparison rejects wrong and short values', () => {
  const { secretMatches } = require('../api/worker');
  assert.equal(secretMatches('abc123', 'abc123'), true);
  assert.equal(secretMatches('abc124', 'abc123'), false);
  assert.equal(secretMatches('', 'abc123'), false);
  assert.equal(secretMatches(undefined, 'abc123'), false);
});

test('group validation normalises and rejects bad input', () => {
  const { uniqueSortedGroup } = require('../lib/validate');
  assert.deepEqual(uniqueSortedGroup(['9', '2', '40', '7', '15']), [2, 7, 9, 15, 40]);
  assert.equal(uniqueSortedGroup(['1', '1', '2', '3', '4']), null, 'duplicates leave only four');
  assert.equal(uniqueSortedGroup(['1', '2', '3', '4', '99']), null, 'out of range');
  assert.equal(uniqueSortedGroup([]), null);
});
