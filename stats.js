'use strict';

/**
 * Pure statistics. No I/O, no globals, no dependencies — every function here is
 * deterministic and unit-tested in test/stats.test.js.
 *
 * The whole point of this module is to let the app answer one question honestly:
 * "is what we are seeing distinguishable from chance?" For California Hot Spot
 * the chance model is exactly known (20 numbers drawn without replacement from
 * 80, independently each draw), so we can compute exact reference values instead
 * of hand-waving.
 */

const { POOL_SIZE, DRAWN_PER_DRAW, GROUP_SIZE } = require('./config');

// ---------------------------------------------------------------------------
// Combinatorics
// ---------------------------------------------------------------------------

/** log(n choose k), stable for the sizes used here. */
function logChoose(n, k) {
  if (k < 0 || k > n || n < 0) return -Infinity;
  k = Math.min(k, n - k);
  let s = 0;
  for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1);
  return s;
}

function choose(n, k) {
  const v = Math.exp(logChoose(n, k));
  return Number.isFinite(v) ? Math.round(v) : v;
}

// ---------------------------------------------------------------------------
// The chance model for a single draw
// ---------------------------------------------------------------------------

/**
 * P(exactly `k` of our `n` chosen numbers are among the `K` drawn), where the
 * pool has `N` numbers. Classic hypergeometric.
 */
function hypergeometricPmf(k, { N = POOL_SIZE, K = DRAWN_PER_DRAW, n = GROUP_SIZE } = {}) {
  if (k < 0 || k > n || k > K || n - k > N - K) return 0;
  return Math.exp(logChoose(K, k) + logChoose(N - K, n - k) - logChoose(N, n));
}

/**
 * The full reference distribution for how many of our 5 numbers show up in one
 * draw: [P(0), P(1), ..., P(5)]. This is the yardstick every tracking result is
 * measured against. Mean = n*K/N = 1.25 hits per draw.
 */
function hitDistribution({ N = POOL_SIZE, K = DRAWN_PER_DRAW, n = GROUP_SIZE } = {}) {
  const out = [];
  for (let k = 0; k <= n; k++) out.push(hypergeometricPmf(k, { N, K, n }));
  return out;
}

/** P(all `n` chosen numbers appear in a single draw). ~1 in 1,551 for a 5-group. */
function fullHitProbability(opts = {}) {
  const n = opts.n ?? GROUP_SIZE;
  return hypergeometricPmf(n, { ...opts, n });
}

function expectedHitsPerDraw({ N = POOL_SIZE, K = DRAWN_PER_DRAW, n = GROUP_SIZE } = {}) {
  return (n * K) / N;
}

// ---------------------------------------------------------------------------
// Tail probabilities
// ---------------------------------------------------------------------------

/**
 * Exact binomial upper tail: P(X >= k) for X ~ Binomial(n, p).
 *
 * The previous implementation used a Poisson approximation. Poisson is fine at
 * these magnitudes, but exact is just as cheap here and removes an approximation
 * we would otherwise have to caveat when reporting p-values.
 */
function binomialTailAtLeast(k, n, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  // Sum the smaller side to limit cancellation.
  let cdfBelow = 0;
  for (let i = 0; i < k; i++) {
    cdfBelow += Math.exp(logChoose(n, i) + i * logP + (n - i) * logQ);
  }
  return Math.min(1, Math.max(0, 1 - cdfBelow));
}

// ---------------------------------------------------------------------------
// Incomplete gamma -> chi-square p-values
// (Numerical Recipes style: series below the crossover, continued fraction above)
// ---------------------------------------------------------------------------

function logGamma(x) {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function gammaSeries(a, x) {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let i = 0; i < 500; i++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaContinuedFraction(a, x) {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;  if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Regularised upper incomplete gamma Q(a, x) = 1 - P(a, x). */
function gammaQ(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

/** Upper-tail p-value for a chi-square statistic with `df` degrees of freedom. */
function chiSquareP(statistic, df) {
  if (!Number.isFinite(statistic) || statistic <= 0 || df <= 0) return 1;
  return Math.min(1, Math.max(0, gammaQ(df / 2, statistic / 2)));
}

/**
 * Pearson goodness-of-fit of an observed count vector against expected counts.
 *
 * Cells with a tiny expected count make the chi-square approximation unreliable,
 * so we pool the sparse tail from the right until every retained cell has an
 * expected count of at least `minExpected` (the standard rule of thumb is 5).
 * `df` is reduced accordingly and the pooling is reported so the caller can be
 * transparent about it rather than silently reporting a bogus p-value.
 */
function chiSquareGoodnessOfFit(observed, expectedProbs, { minExpected = 5 } = {}) {
  const total = observed.reduce((s, x) => s + x, 0);
  if (!total) return { statistic: 0, df: 0, pValue: 1, total: 0, cells: [], pooledFrom: null, reliable: false };

  const expected = expectedProbs.map((p) => p * total);
  // Pool from the right-hand tail inward.
  let cut = expected.length;
  while (cut > 1 && expected.slice(cut - 1).reduce((s, x) => s + x, 0) < minExpected) cut--;

  const obs = observed.slice(0, cut - 1);
  const exp = expected.slice(0, cut - 1);
  obs.push(observed.slice(cut - 1).reduce((s, x) => s + x, 0));
  exp.push(expected.slice(cut - 1).reduce((s, x) => s + x, 0));

  let statistic = 0;
  const cells = [];
  for (let i = 0; i < obs.length; i++) {
    const contribution = exp[i] > 0 ? ((obs[i] - exp[i]) ** 2) / exp[i] : 0;
    statistic += contribution;
    cells.push({
      index: i,
      pooled: i === obs.length - 1 && cut < expected.length,
      observed: obs[i],
      expected: +exp[i].toFixed(3),
      contribution: +contribution.toFixed(3),
    });
  }

  const df = Math.max(1, obs.length - 1);
  return {
    statistic: +statistic.toFixed(4),
    df,
    pValue: chiSquareP(statistic, df),
    total,
    cells,
    pooledFrom: cut < expected.length ? cut - 1 : null,
    reliable: exp.every((e) => e >= minExpected),
  };
}

// ---------------------------------------------------------------------------
// Interval estimation
// ---------------------------------------------------------------------------

/**
 * Wilson score interval for a proportion. Chosen over the textbook normal
 * interval because it stays inside [0,1] and behaves at small n / extreme p,
 * both of which happen constantly here (e.g. 0 five-hits out of 20 draws).
 */
function wilsonInterval(successes, trials, z = 1.959963985) {
  if (!trials) return { point: null, low: null, high: null };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return {
    point: p,
    low: Math.max(0, (centre - spread) / denom),
    high: Math.min(1, (centre + spread) / denom),
  };
}

// ---------------------------------------------------------------------------
// Multiple testing
// ---------------------------------------------------------------------------

/** Family-wise threshold. Conservative, but valid under any dependence. */
function bonferroniThreshold(candidateCount, alpha = 0.05) {
  return candidateCount > 0 ? alpha / candidateCount : alpha;
}

/**
 * Benjamini-Hochberg: returns, for each input p-value, whether it survives at
 * false-discovery-rate `alpha`, plus the largest p-value that does. Much less
 * brutal than Bonferroni when tens of thousands of candidates are screened.
 */
function benjaminiHochberg(pValues, alpha = 0.05, totalTested = pValues.length) {
  const m = Math.max(totalTested, pValues.length);
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let cutoff = -1;
  for (let rank = order.length; rank >= 1; rank--) {
    if (order[rank - 1].p <= (rank / m) * alpha) { cutoff = order[rank - 1].p; break; }
  }
  return { cutoff: cutoff < 0 ? null : cutoff, rejected: pValues.map((p) => cutoff >= 0 && p <= cutoff) };
}

// ---------------------------------------------------------------------------
// Descriptive helpers
// ---------------------------------------------------------------------------

const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);

function median(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than two points. */
function stdev(a) {
  if (a.length < 2) return 0;
  const mu = mean(a);
  return Math.sqrt(sum(a.map((x) => (x - mu) ** 2)) / (a.length - 1));
}

module.exports = {
  logChoose, choose, logGamma,
  hypergeometricPmf, hitDistribution, fullHitProbability, expectedHitsPerDraw,
  binomialTailAtLeast, gammaQ, chiSquareP, chiSquareGoodnessOfFit,
  wilsonInterval, bonferroniThreshold, benjaminiHochberg,
  sum, mean, median, stdev,
};
