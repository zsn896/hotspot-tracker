'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/stats');

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} !~= ${b}`);

test('logChoose matches exact binomial coefficients', () => {
  close(S.choose(5, 2), 10);
  close(S.choose(80, 5), 24040016);
  close(S.choose(20, 5), 15504);
  assert.equal(S.logChoose(3, 5), -Infinity);
});

test('hit distribution is a proper probability distribution', () => {
  const dist = S.hitDistribution();
  assert.equal(dist.length, 6);
  close(dist.reduce((a, b) => a + b, 0), 1, 1e-12);
  assert.ok(dist.every((p) => p >= 0 && p <= 1));
  // Mean of the distribution must equal n*K/N = 1.25.
  close(dist.reduce((s, p, k) => s + p * k, 0), 1.25, 1e-12);
});

test('full 5-number hit is 1 in 1551 per draw', () => {
  close(S.fullHitProbability(), 15504 / 24040016, 1e-12);
  assert.equal(Math.round(1 / S.fullHitProbability()), 1551);
});

test('binomial tail agrees with a direct summation', () => {
  const n = 30;
  const p = 0.17;
  for (const k of [0, 1, 3, 7, 30, 31]) {
    let direct = 0;
    for (let i = k; i <= n; i++) direct += S.choose(n, i) * p ** i * (1 - p) ** (n - i);
    close(S.binomialTailAtLeast(k, n, p), Math.min(1, direct), 1e-9);
  }
});

test('chi-square p-values match published critical values', () => {
  close(S.chiSquareP(3.841459, 1), 0.05, 1e-5);
  close(S.chiSquareP(11.070498, 5), 0.05, 1e-5);
  close(S.chiSquareP(23.209251, 10), 0.01, 1e-5);
  assert.equal(S.chiSquareP(0, 4), 1);
});

test('goodness of fit accepts data drawn from the reference distribution', () => {
  const probs = S.hitDistribution();
  const n = 2000;
  const observed = probs.map((p) => Math.round(p * n));
  const gof = S.chiSquareGoodnessOfFit(observed, probs);
  assert.ok(gof.pValue > 0.99, `expected a near-perfect fit, got p=${gof.pValue}`);
});

test('goodness of fit rejects an obviously skewed sample', () => {
  const probs = S.hitDistribution();
  const gof = S.chiSquareGoodnessOfFit([0, 0, 0, 60, 30, 10], probs);
  assert.ok(gof.pValue < 1e-6, `expected rejection, got p=${gof.pValue}`);
});

test('goodness of fit pools sparse tail cells', () => {
  const probs = S.hitDistribution();
  // With 20 draws, expected counts for 4 and 5 hits are 0.24 and 0.01.
  const gof = S.chiSquareGoodnessOfFit([5, 8, 5, 2, 0, 0], probs);
  assert.ok(gof.pooledFrom !== null, 'sparse cells should be pooled');
  assert.ok(gof.df < 5);
  assert.ok(gof.pValue >= 0 && gof.pValue <= 1);
});

test('Wilson interval stays inside [0,1] at the extremes', () => {
  const zero = S.wilsonInterval(0, 20);
  assert.equal(zero.low, 0);
  assert.ok(zero.high > 0 && zero.high < 0.2);
  const all = S.wilsonInterval(20, 20);
  assert.equal(all.high, 1);
  assert.ok(all.low > 0.8);
  assert.deepEqual(S.wilsonInterval(0, 0), { point: null, low: null, high: null });
  // A textbook normal interval would give [0,0] here; Wilson must not.
  assert.ok(zero.high > 0);
});

test('Bonferroni threshold shrinks with the search size', () => {
  close(S.bonferroniThreshold(1, 0.05), 0.05);
  close(S.bonferroniThreshold(10000, 0.05), 5e-6);
});

test('Benjamini-Hochberg rejects only the genuinely small p-values', () => {
  const { rejected } = S.benjaminiHochberg([1e-9, 0.2, 0.6, 0.9], 0.05);
  assert.deepEqual(rejected, [true, false, false, false]);
  const none = S.benjaminiHochberg([0.4, 0.5, 0.9], 0.05);
  assert.equal(none.cutoff, null);
  assert.deepEqual(none.rejected, [false, false, false]);
});

test('descriptive helpers behave on edge cases', () => {
  assert.equal(S.mean([]), 0);
  assert.equal(S.median([]), 0);
  assert.equal(S.median([3, 1, 2]), 2);
  assert.equal(S.median([4, 1, 3, 2]), 2.5);
  assert.equal(S.stdev([5]), 0, 'a single point has no sample spread');
  close(S.stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2.13809, 1e-4);
});
