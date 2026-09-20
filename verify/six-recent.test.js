'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { selectRecentSix } = require('../lib/six-recent');
const A = [1, 2, 3, 4, 5], B = [6, 7, 8, 9, 10];
const groups = Array.from({ length: 6 }, () => ({ numbers: A.slice() }));
const twoGroups = Array.from({ length: 6 }, (_, i) => ({ numbers: (i < 3 ? A : B).slice() }));
function draw(id, pick) {
  return { draw_id: id, draw_date: '2026-09-20', draw_time: '10:00 a.m.',
    numbers: [...pick, ...Array.from({ length: 20 - pick.length }, (_, i) => 40 + i)] };
}
function windowFor(fn) { return Array.from({ length: 50 }, (_, i) => draw(101 + i, fn(i))); }
const counts = hits => ({
  three: hits.filter(n => n === 3).length, four: hits.filter(n => n === 4).length, five: hits.filter(n => n === 5).length,
  threePlus: hits.filter(n => n >= 3).length, fourPlus: hits.filter(n => n >= 4).length
});
function recount(numbers, rows) { return counts(rows.map(d => numbers.filter(n => d.numbers.includes(n)).length)); }
function combinations(pool, prefix = [], start = 0) {
  if (prefix.length === 5) return [prefix];
  const result = [];
  for (let i = start; i <= pool.length - (5 - prefix.length); i++) result.push(...combinations(pool, [...prefix, pool[i]], i + 1));
  return result;
}
// Independent, deliberately simple oracle: sets/arrays, not the production bit masks.
function reference(groups, rows) {
  const pool = [...new Set(groups.flatMap(g => g.numbers))].sort((a, b) => a - b);
  const first = rows.slice(0, 30), last = rows.slice(30);
  const compare = (a, b) => b.threePlus - a.threePlus || b.fourPlus - a.fourPlus || b.five - a.five;
  const numeric = (a, b) => { for (let i = 0; i < 5; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const candidates = combinations(pool).map(numbers => ({ numbers, jointCounts: recount(numbers, first) })).filter(c =>
    c.jointCounts.threePlus >= 2 && c.numbers.every(n => first.some(d =>
      d.numbers.includes(n) && c.numbers.filter(x => d.numbers.includes(x)).length >= 3))
  ).sort((a, b) => compare(a.jointCounts, b.jointCounts) || numeric(a.numbers, b.numbers));
  const shortlist = candidates.slice(0, 20);
  const winner = shortlist.slice().sort((a, b) =>
    compare(recount(a.numbers, last), recount(b.numbers, last)) ||
    compare(a.jointCounts, b.jointCounts) || numeric(a.numbers, b.numbers))[0];
  return { shortlist, eligible: candidates.length, winner };
}

test('requires six valid groups and exactly 50 complete consecutive pinned draws', () => {
  const rows = windowFor(() => A);
  assert.equal(selectRecentSix(groups, rows, 150).have, 50);
  for (const source of [null, groups.slice(1), [...groups, groups[0]], [...groups.slice(1), { numbers: [1, 1, 2, 3, 4] }],
    [...groups.slice(1), { numbers: [1, 2, 3, 4, 81] }], Array(6)]) {
    assert.throws(() => selectRecentSix(source, rows, 150), /ست مجموعات/);
  }
  for (const bad of [rows.slice(1), [...rows, draw(151, A)], rows.map((d, i) => i === 12 ? rows[11] : d), Array(50)]) {
    assert.throws(() => selectRecentSix(groups, bad, 150), /50 سحبة/);
  }
  for (const id of [151, 49, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => selectRecentSix(groups, rows, id), /50 سحبة/);
  for (const numbers of [[...A, ...Array(15).fill(40)], [...A, ...Array.from({ length: 15 }, (_, i) => 81 + i)], Array(20)]) {
    assert.throws(() => selectRecentSix(groups, [{ ...rows[0], numbers }, ...rows.slice(1)], 150), /50 سحبة/);
  }
});

test('latest 20 draws can change the winner but cannot change nomination, eligibility, or shortlist order', () => {
  const first = i => i % 2 ? A : B;
  const a = selectRecentSix(twoGroups, windowFor(i => i < 30 ? first(i) : A), 150);
  const b = selectRecentSix(twoGroups, windowFor(i => i < 30 ? first(i) : B), 150);
  assert.deepEqual(a.numbers, A); assert.deepEqual(b.numbers, B);
  assert.deepEqual(a.shortlist, b.shortlist);
  assert.equal(a.eligibleCandidateCount, b.eligibleCandidateCount);
  assert.equal(a.combinationsChecked, b.combinationsChecked);
});

test('evaluates the whole five without requiring one repeated fixed triple', () => {
  const rotating = [[6, 7, 8], [6, 9, 10], [7, 9, 10], [8, 9, 10]];
  const rows = windowFor(i => i < 10 ? [1, 2, 3] : i === 10 ? [1, 2, 3, 4] : i === 11 ? [1, 2, 3, 5] :
    i < 30 ? rotating[i % 4] : i < 32 ? A : rotating[i % 4]);
  const result = selectRecentSix(twoGroups, rows, 150);
  assert.deepEqual(result.numbers, B);
  assert.equal(result.nomination.jointCounts.threePlus, 18);
  assert.equal(result.comparison.jointCounts.threePlus, 18);
  assert.equal(result.jointCounts.five, 0);
  assert.equal(result.core, undefined);
});

test('one draw counts once even when all five and all their triples appear', () => {
  const result = selectRecentSix(groups, windowFor(() => A), 150);
  assert.deepEqual(result.nomination.jointCounts, { three: 0, four: 0, five: 30, threePlus: 30, fourPlus: 30 });
  assert.deepEqual(result.comparison.jointCounts, { three: 0, four: 0, five: 20, threePlus: 20, fourPlus: 20 });
  assert.equal(result.evidence.length, 50);
});

test('cannot nominate from comparison-only appearances or add unsupported filler numbers', () => {
  assert.throws(() => selectRecentSix(groups, windowFor(i => i < 30 ? [1, 2] : A), 150), /لا توجد مجموعة مؤهلة/);
  assert.throws(() => selectRecentSix(groups, windowFor(i => i === 0 || i >= 30 ? A : [1, 2]), 150), /لا توجد مجموعة مؤهلة/);
  assert.throws(() => selectRecentSix(groups, windowFor(i => i < 15 ? [1, 2, 3] : i < 30 ? [4, 5] : A), 150), /لن تضاف أرقام بلا دليل/);
});

test('declines a shortlist with no 3+ joint appearances in the latest 20', () => {
  assert.throws(() => selectRecentSix(groups, windowFor(i => i < 30 ? A : [1, 2]), 150), /أحدث 20 سحبة/);
});

test('comparison prioritizes number of 3+ draws before rarer full-five matches', () => {
  const rows = windowFor(i => i < 30 ? (i % 2 ? A : B) : i < 40 ? [1, 2, 3] : i < 49 ? B : []);
  const result = selectRecentSix(twoGroups, rows, 150);
  assert.deepEqual(result.numbers, A);
  assert.equal(result.comparison.jointCounts.threePlus, 10);
});

test('comparison breaks a 3+ tie by 4+, then breaks a 4+ tie by 5', () => {
  const four = windowFor(i => i < 30 ? (i % 2 ? A : B) : i < 35 ? [1, 2, 3] : i < 40 ? [6, 7, 8, 9] : []);
  assert.deepEqual(selectRecentSix(twoGroups, four, 150).numbers, B);
  const five = windowFor(i => i < 30 ? (i % 2 ? A : B) : i < 35 ? [1, 2, 3, 4] : i < 40 ? B : []);
  assert.deepEqual(selectRecentSix(twoGroups, five, 150).numbers, B);
});

test('shortlist is capped at 20 using nomination counts and deterministic numeric ties', () => {
  const result = selectRecentSix(twoGroups, windowFor(() => [...A, ...B]), 150);
  assert.equal(result.candidateCount, 10);
  assert.equal(result.combinationsChecked, 252);
  assert.equal(result.eligibleCandidateCount, 252);
  assert.equal(result.shortlistLimit, 20); assert.equal(result.shortlistSize, 20);
  assert.deepEqual(result.shortlist.map(c => c.numbers), combinations([...A, ...B]).slice(0, 20));
  assert.deepEqual(result.numbers, A);
});

test('optimized selector matches independent full-five enumeration on varied draws', () => {
  for (const initial of [17, 82, 541]) {
    let seed = initial;
    const rows = windowFor(() => [...A, ...B].filter(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % 100 < 45;
    }));
    const result = selectRecentSix(twoGroups, rows, 150), expected = reference(twoGroups, rows);
    assert.equal(result.eligibleCandidateCount, expected.eligible);
    assert.deepEqual(result.shortlist, expected.shortlist);
    assert.deepEqual(result.numbers, expected.winner.numbers);
  }
});

test('evidence recounts both disjoint phases with real draw ids and no forecast success claims', () => {
  const rows = windowFor(i => i % 6 === 0 ? A : i % 6 === 1 ? [1, 2, 3, 4] : i % 6 === 2 ? [3, 4, 5] : [1]);
  const result = selectRecentSix(groups, rows, 150);
  assert.deepEqual(result.nomination, { have: 30, firstDrawId: 101, lastDrawId: 130, jointCounts: recount(A, rows.slice(0, 30)) });
  assert.deepEqual(result.comparison, { have: 20, firstDrawId: 131, lastDrawId: 150, jointCounts: recount(A, rows.slice(30)) });
  assert.deepEqual(result.jointCounts, recount(A, rows));
  assert.equal(result.evidence.length, result.jointCounts.threePlus);
  for (const e of result.evidence) {
    const d = rows.find(d => d.draw_id === e.drawId);
    assert.deepEqual(e.matched, A.filter(n => d.numbers.includes(n)));
    assert.equal(e.phase, e.drawId <= 130 ? 'nomination' : 'comparison');
    assert.equal(e.date, d.draw_date); assert.equal(e.time, d.draw_time);
  }
  assert.equal(result.historicalOnly, true);
  assert.equal(result.selectionRule, 'whole-five-temporal-30-20-v4');
  for (const key of ['success', 'accuracy', 'probability']) assert.equal(result[key], undefined);
});

test('group/draw ordering cannot change selection and inputs are not mutated', () => {
  const rows = windowFor(i => i % 2 ? A : B);
  const before = JSON.stringify({ groups: twoGroups, rows });
  const result = selectRecentSix(twoGroups, rows, 150);
  const shuffled = selectRecentSix(twoGroups.slice().reverse().map(g => ({ numbers: g.numbers.slice().reverse() })),
    rows.slice().reverse().map(d => ({ ...d, draw_id: String(d.draw_id), numbers: d.numbers.slice().reverse() })), 150);
  assert.deepEqual(shuffled, result);
  assert.equal(JSON.stringify({ groups: twoGroups, rows }), before);
});

test('supports 30 distinct candidates including number 80 and checks every possible five', () => {
  const source = Array.from({ length: 6 }, (_, g) => ({ numbers: Array.from({ length: 5 }, (_, i) => 51 + 5 * g + i) }));
  const target = [51, 58, 64, 72, 80];
  const rows = Array.from({ length: 50 }, (_, i) => ({
    draw_id: 101 + i, numbers: [...target, ...Array.from({ length: 15 }, (_, n) => n + 1)]
  }));
  const result = selectRecentSix(source, rows, 150);
  assert.equal(result.candidateCount, 30);
  assert.equal(result.combinationsChecked, 142506);
  assert.deepEqual(result.numbers, target);
  assert.equal(result.eligibleCandidateCount, 1);
  assert.equal(result.jointCounts.five, 50);
});
