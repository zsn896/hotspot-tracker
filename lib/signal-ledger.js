'use strict';

const { db } = require('../api/lib');
const { readPages } = require('./db-pages');
const { contiguousDraws } = require('./draw-sequence');

/**
 * Signal ledger.
 *
 * The engine already decides when a signal is STRONG. This module does the one
 * thing that settles whether that decision is worth anything: it writes every
 * episode down before the outcome is known, then scores it afterwards, and
 * reports the total beside what chance alone would have produced.
 *
 * Three rules make the number trustworthy:
 *
 *   1. EPISODES, NOT CHECKS. A signal that stays STRONG across five draws is one
 *      event. Scoring it once per draw counts a single outcome five times and
 *      inflates every rate.
 *   2. THE WINDOW IS FIXED AT THE EPISODE START. It does not slide forward while
 *      the signal persists. Otherwise a signal that stays active for fifty draws
 *      gets fifty chances to be "right" inside a five-draw promise.
 *   3. THE OUTCOME IS WRITTEN AFTER THE WINDOW CLOSES. Nothing is scored from
 *      draws that already existed when the episode was opened.
 *
 * Nothing here changes how signals are produced. It only records them.
 */

const DEFAULT_WINDOW = 5;      // leadMax in the precursor engine
const SUCCESS_THRESHOLD = 4;   // a 4+ inside the window
const POOL = 80;
const DRAWN = 20;
const GROUP = 5;

// ---------------------------------------------------------------------------
// Chance model (exact, no approximation)
// ---------------------------------------------------------------------------

function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  k = Math.min(k, n - k);
  let s = 0;
  for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1);
  return s;
}

/** P(exactly k of the 5 target numbers appear in one draw). */
function hypergeometric(k) {
  if (k < 0 || k > GROUP) return 0;
  return Math.exp(logChoose(DRAWN, k) + logChoose(POOL - DRAWN, GROUP - k) - logChoose(POOL, GROUP));
}

/** P(at least `threshold` hits in a single draw). 4+ is about 1.27%. */
function perDrawRate(threshold = SUCCESS_THRESHOLD) {
  let p = 0;
  for (let k = threshold; k <= GROUP; k++) p += hypergeometric(k);
  return p;
}

/** P(at least one qualifying draw in a window of `window` draws). */
function chanceRate(window = DEFAULT_WINDOW, threshold = SUCCESS_THRESHOLD) {
  return 1 - (1 - perDrawRate(threshold)) ** window;
}

/** Exact binomial upper tail, P(X >= k). */
function binomialTailAtLeast(k, n, p) {
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isInteger(k) || !Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError('Invalid binomial parameters');
  }
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p === 0) return 0;
  if (p === 1) return 1;
  const upper = k > n * p;
  let i = upper ? k : k - 1;
  let term = Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  let sum = term;
  // Sum the smaller tail directly, avoiding cancellation at tiny p-values.
  while (upper ? i < n : i > 0) {
    term *= upper ? (n - i) / (i + 1) * p / (1 - p) : i / (n - i + 1) * (1 - p) / p;
    i += upper ? 1 : -1;
    sum += term;
    if (term <= sum * Number.EPSILON) break;
  }
  return Math.min(1, Math.max(0, upper ? sum : 1 - sum));
}

function criticalCount(n, p, alpha) {
  let lo = 0, hi = n + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (binomialTailAtLeast(mid, n, p) > alpha) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Wilson score interval — stays inside [0,1] at small n and extreme rates. */
function wilson(successes, trials, z = 1.959963985) {
  if (!trials) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return [
    Math.max(0, (centre - spread) / denom),
    Math.min(1, (centre + spread) / denom),
  ];
}

/**
 * Smallest lift this many episodes could have detected.
 *
 * Without it, "no effect found" is unreadable: a null result from 40 episodes
 * means nothing, and a null result from 4,000 means a great deal.
 */
function minimumDetectableLift(n, p0, { alpha = 0.05, power = 0.8 } = {}) {
  if (!n || !(p0 > 0 && p0 < 1)) return null;
  const critical = criticalCount(n, p0, alpha);
  for (let lift = 1.05; lift <= 40; lift += 0.05) {
    if (p0 * lift >= 1) break;
    if (binomialTailAtLeast(critical, n, p0 * lift) >= power) return Number(lift.toFixed(2));
  }
  return null;
}

/** Episodes needed to prove a given lift. */
function requiredEpisodes(lift, p0, { alpha = 0.05, power = 0.8 } = {}) {
  if (!(lift > 1 && p0 > 0 && p0 < 1 && p0 * lift <= 1)) return null;
  for (let n = 20; n <= 400000; n = Math.ceil(n * 1.06)) {
    const critical = criticalCount(n, p0, alpha);
    if (binomialTailAtLeast(critical, n, p0 * lift) >= power) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(values) {
  return [...new Set((values || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= POOL)
    .sort((a, b) => a - b);
}

const targetKey = (numbers) => normalize(numbers).join('-');

function hitCount(draw, target) {
  const set = new Set(normalize(draw?.numbers));
  return normalize(target).filter(n => set.has(n)).length;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record one live observation. Call once per cron tick, per watched target.
 *
 * Returns what happened so the caller can log it: 'opened' for a new episode,
 * 'extended' when the same signal is still active, 'ignored' when the status is
 * not being tracked.
 *
 * An episode is extended only when the tier is unchanged and the observation is
 * contiguous with the last one. A gap means the signal switched off and back on,
 * which is a genuinely separate event.
 */
async function recordObservation(target, forecast, latestDrawId, options = {}) {
  const window = options.window ?? DEFAULT_WINDOW;
  const trackStatuses = options.trackStatuses || ['STRONG'];
  const key = targetKey(target);
  const drawId = Number(latestDrawId);

  if (!Array.isArray(target) || target.length !== GROUP || normalize(target).length !== GROUP ||
      !Number.isSafeInteger(drawId) || drawId < 1 || !Number.isSafeInteger(window) || window < 1 || window > 20 || !forecast) {
    return { action: 'ignored', reason: 'bad-input' };
  }
  if (!trackStatuses.includes(forecast.status)) return { action: 'ignored', reason: `status-${forecast.status}` };

  const open = (await db(
    `signal_episodes?select=id,status,last_draw_id,start_draw_id&target=eq.${encodeURIComponent(key)}` +
    `&order=start_draw_id.desc&limit=1`
  )) || [];
  const current = open[0];
  if (current && drawId < Number(current.last_draw_id)) return { action: 'ignored', reason: 'stale-observation' };

  // Same tier and contiguous with the previous observation: one episode.
  if (current && current.status === forecast.status && drawId - Number(current.last_draw_id) <= 1) {
    if (drawId > Number(current.last_draw_id)) {
      await db(`signal_episodes?id=eq.${current.id}&last_draw_id=lt.${drawId}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { last_draw_id: drawId },
      });
    }
    return { action: 'extended', episodeId: current.id, startDrawId: Number(current.start_draw_id) };
  }

  const signal = forecast.fourPlusOutcomeCalibration?.signal
    || forecast.activeSignals?.[0]?.numbers
    || [];

  const created = await db('signal_episodes?on_conflict=target,status,start_draw_id', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=representation',
    body: [{
      target: key,
      status: forecast.status,
      expected_tier: forecast.expectedTier || null,
      four_plus_score: Number(forecast.fourPlusScore || 0),
      signal_numbers: normalize(signal),
      start_draw_id: drawId,
      last_draw_id: drawId,
      // Fixed at the start. It does not move as the signal persists.
      window_end_draw_id: drawId + window,
      resolved: false,
    }],
  });

  return { action: 'opened', episodeId: created?.[0]?.id || null, startDrawId: drawId };
}

/**
 * Score every episode whose window has closed.
 *
 * `loadDraws(fromId, toId)` must return the stored draws in that inclusive
 * range; it is injected so this module never assumes a table layout it does not
 * own.
 */
async function resolveEpisodes(loadDraws, latestDrawId, options = {}) {
  const limit = options.limit || 200;
  const threshold = SUCCESS_THRESHOLD;
  const drawId = Number(latestDrawId);
  if (!Number.isSafeInteger(drawId) || drawId < 1) return { resolved: 0, successes: 0 };
  if (options.threshold != null && options.threshold !== SUCCESS_THRESHOLD) {
    throw new RangeError('Stored outcomes use threshold 4; select other thresholds in ledgerReport');
  }

  const pending = await readPages(db,
    `signal_episodes?select=id,target,start_draw_id,window_end_draw_id&resolved=eq.false` +
    `&window_end_draw_id=lte.${drawId}&order=id.asc&limit=${limit}`
  , { limit });
  if (!pending.length) return { resolved: 0, successes: 0 };

  let resolved = 0;
  let successes = 0;

  for (const episode of pending) {
    const from = Number(episode.start_draw_id) + 1;
    const to = Number(episode.window_end_draw_id);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || to - from >= 20) continue;
    const raw = await loadDraws(from, to);
    const draws = contiguousDraws(raw, from - 1, to);
    // Refuse to score a window with missing draws: an incomplete window would
    // silently be recorded as a failure.
    if (!Array.isArray(raw) || raw.length !== to - from + 1 || draws.length !== raw.length) continue;

    const target = String(episode.target).split('-').map(Number);
    if (target.length !== GROUP || normalize(target).length !== GROUP) continue;
    let best = 0;
    let outcomeDrawId = null;
    let lead = null;
    for (const draw of draws) {
      const hits = hitCount(draw, target);
      if (hits > best) best = hits;
      if (hits >= threshold && outcomeDrawId === null) {
        outcomeDrawId = Number(draw.draw_id);
        lead = outcomeDrawId - Number(episode.start_draw_id);
      }
    }

    await db(`signal_episodes?id=eq.${episode.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        resolved: true,
        best_hit_count: best,
        outcome_draw_id: outcomeDrawId,
        success: outcomeDrawId !== null,
        lead_draws: lead,
      },
    });

    resolved++;
    if (outcomeDrawId !== null) successes++;
  }

  return { resolved, successes };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function summarise(rows, p0, label, threshold = SUCCESS_THRESHOLD) {
  const n = rows.length;
  const hits = rows.filter(r => r.success).length;
  const rate = n ? hits / n : 0;
  const expected = n * p0;
  const pValue = n ? binomialTailAtLeast(hits, n, p0) : 1;
  const ci = wilson(hits, n);
  const mdl = minimumDetectableLift(n, p0);

  let conclusion;
  if (!n) conclusion = 'No resolved episodes yet. Nothing can be concluded.';
  else if (pValue < 0.05) conclusion = `Signals are followed by ${threshold}+ more often than chance in this sample, under the independent-episode model. This is not a guarantee of future results.`;
  else if (mdl == null) conclusion = 'Too few episodes to detect any effect.';
  else conclusion = `No edge detected. With ${n} episodes this test could only have found a lift of ${mdl}x or larger, so smaller edges are still untested.`;

  return {
    label,
    episodes: n,
    successes: hits,
    failures: n - hits,
    observedRate: Number(rate.toFixed(5)),
    expectedByChance: Number(expected.toFixed(2)),
    chanceRate: Number(p0.toFixed(5)),
    lift: expected > 0 ? Number((hits / expected).toFixed(2)) : null,
    pValue: Number(pValue.toExponential(3)),
    significant: pValue < 0.05,
    confidenceInterval: ci ? [Number(ci[0].toFixed(5)), Number(ci[1].toFixed(5))] : null,
    minimumDetectableLift: mdl,
    conclusion,
  };
}

/**
 * The ledger report. This is the number that settles the question.
 *
 * Every rate is shown beside the exact chance expectation for the same window,
 * so a success count can never be read without its denominator.
 */
async function ledgerReport(options = {}) {
  const window = options.window ?? DEFAULT_WINDOW;
  const threshold = options.threshold ?? SUCCESS_THRESHOLD;
  const limit = options.limit || 5000;
  if (!Number.isInteger(window) || window < 1 || window > 20 || !Number.isInteger(threshold) || threshold < 3 || threshold > GROUP) {
    throw new RangeError('Window must be an integer from 1 to 20 and threshold from 3 to 5');
  }
  const p0 = chanceRate(window, threshold);

  const loaded = await readPages(db,
    `signal_episodes?select=id,target,status,best_hit_count,lead_draws,start_draw_id,window_end_draw_id,four_plus_score` +
    `&resolved=eq.true&order=id.desc&limit=${limit}`
  , { limit });
  const rows = loaded.filter(row =>
    Number(row.window_end_draw_id) - Number(row.start_draw_id) === window &&
    normalize(String(row.target).split('-')).length === GROUP &&
    Number.isInteger(row.best_hit_count) && row.best_hit_count >= 0 && row.best_hit_count <= GROUP
  ).map(row => ({ ...row, success: Number(row.best_hit_count) >= threshold }));
  const openCount = (await readPages(db, 'signal_episodes?select=id&resolved=eq.false&order=id.asc', { limit })).length;

  const byTarget = new Map();
  for (const row of rows) {
    if (!byTarget.has(row.target)) byTarget.set(row.target, []);
    byTarget.get(row.target).push(row);
  }

  const leads = threshold === SUCCESS_THRESHOLD
    ? rows.filter(r => r.success && r.lead_draws).map(r => Number(r.lead_draws)) : [];
  const bestCounts = [0, 0, 0, 0, 0, 0];
  for (const row of rows) bestCounts[Math.min(GROUP, Number(row.best_hit_count || 0))]++;

  return {
    ok: true,
    model: 'SIGNAL_LEDGER_FORWARD_OUTCOMES_V1',
    definition: {
      episode: 'One contiguous run of the same status for one target. Repeated checks inside a run are one event.',
      window: `${window} draws after the episode opened, fixed at the start and not extended while the signal persists.`,
      success: `at least ${threshold} of the 5 target numbers in one draw inside that window`,
    },
    chanceModel: {
      perDrawRate: Number(perDrawRate(threshold).toFixed(6)),
      windowRate: Number(p0.toFixed(6)),
      note: 'Exact hypergeometric value for a fair game. This is what the observed rate must beat.',
    },
    openEpisodes: openCount,
    sample: { loaded: loaded.length, included: rows.length, limit, capped: loaded.length === limit, openCountCapped: openCount === limit },
    inferenceNote: 'Binomial p-values and intervals assume independent episodes. Overlapping windows, shared targets, and multiple comparisons can violate this assumption; results are exploratory.',
    overall: summarise(rows, p0, 'matching resolved episodes', threshold),
    byStatus: [...new Set(rows.map(r => r.status))].map(status =>
      summarise(rows.filter(r => r.status === status), p0, status, threshold)),
    byTarget: [...byTarget.entries()]
      .map(([target, list]) => summarise(list, p0, target, threshold))
      .sort((a, b) => b.episodes - a.episodes),
    bestHitDistribution: bestCounts,
    successLeadDraws: leads.length
      ? { min: Math.min(...leads), max: Math.max(...leads), mean: Number((leads.reduce((s, x) => s + x, 0) / leads.length).toFixed(2)) }
      : null,
    // Sample-size planning, so it is clear how far the experiment still has to go.
    powerPlan: {
      episodesFor2x: requiredEpisodes(2, p0),
      episodesFor3x: requiredEpisodes(3, p0),
      episodesFor5x: requiredEpisodes(5, p0),
    },
  };
}

module.exports = {
  recordObservation,
  resolveEpisodes,
  ledgerReport,
  perDrawRate,
  chanceRate,
  binomialTailAtLeast,
  wilson,
  minimumDetectableLift,
  requiredEpisodes,
  summarise,
  targetKey,
  hitCount,
};
