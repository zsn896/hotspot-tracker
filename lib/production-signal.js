'use strict';

/*
 * Production-only evidence gate.
 *
 * This is deliberately conservative: it ranks an already generated candidate,
 * but it never calls a random-looking one STRONG.  Every statistic is computed
 * from draws before the next selection and malformed/non-contiguous archives
 * are rejected instead of being silently treated as evidence.
 */

const DRAW_SIZE = 20;
const UNIVERSE_SIZE = 80;
const TARGET_SIZE = 5;
const WINDOWS = [20, 40, 80];

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= UNIVERSE_SIZE)
    .sort((a, b) => a - b);
}

function validDraw(draw) {
  const id = Number(draw?.draw_id);
  const numbers = norm(draw?.numbers);
  return Number.isInteger(id) && id > 0 && numbers.length === DRAW_SIZE;
}

function prepareDraws(input) {
  const rows = Array.isArray(input) ? input : [];
  if (rows.some(row => !validDraw(row))) {
    return { ok: false, draws: [], reason: 'malformed-draw-record' };
  }
  const ordered = rows
    .map(draw => ({ ...draw, draw_id: Number(draw.draw_id), numbers: norm(draw.numbers) }))
    .sort((a, b) => a.draw_id - b.draw_id);

  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].draw_id !== ordered[i - 1].draw_id + 1) {
      return { ok: false, draws: [], reason: 'non-contiguous-draw-ids' };
    }
  }
  return { ok: ordered.length > 0, draws: ordered, reason: ordered.length ? null : 'no-valid-draws' };
}

function hitCount(draw, target) {
  const set = new Set(draw.numbers);
  return target.reduce((hits, n) => hits + (set.has(n) ? 1 : 0), 0);
}

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let i = 1; i <= k; i += 1) value = value * (n - k + i) / i;
  return value;
}

function fourPlusBaseline() {
  const denominator = choose(UNIVERSE_SIZE, DRAW_SIZE);
  const numerator = choose(TARGET_SIZE, 4) * choose(UNIVERSE_SIZE - TARGET_SIZE, DRAW_SIZE - 4)
    + choose(TARGET_SIZE, 5) * choose(UNIVERSE_SIZE - TARGET_SIZE, DRAW_SIZE - 5);
  return numerator / denominator;
}

function wilsonLower(successes, trials, z = 1.645) {
  if (!trials) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return Math.max(0, (center - spread) / denominator);
}

function scoreCandidate(inputDraws, numbers) {
  const prepared = prepareDraws(inputDraws);
  const target = norm(numbers);
  if (!prepared.ok || target.length !== TARGET_SIZE) {
    return {
      status: 'ABSTAIN',
      evidenceScore: 0,
      reason: prepared.reason || 'candidate-must-contain-five-unique-numbers',
      stableWindows: 0,
      baseline: fourPlusBaseline()
    };
  }

  const draws = prepared.draws;
  const baseline = fourPlusBaseline();
  const windows = WINDOWS
    .filter(size => draws.length >= size)
    .map(size => draws.slice(-size));
  const windowStats = windows.map(rows => {
    const hits = rows.map(draw => hitCount(draw, target));
    const fourPlus = hits.filter(hit => hit >= 4).length;
    const threePlus = hits.filter(hit => hit >= 3).length;
    const recent = hits.slice(-Math.min(10, hits.length)).filter(hit => hit >= 3).length;
    return {
      size: rows.length,
      fourPlus,
      threePlus,
      fourPlusRate: fourPlus / rows.length,
      threePlusRate: threePlus / rows.length,
      recentThreePlus: recent
    };
  });

  // Stability is measured over each complete window.  Recent activity may
  // improve ranking, but it must not make an old 40/80-draw window look strong.
  const strongWindows = windowStats.filter(stat =>
    stat.threePlus >= 2 && stat.fourPlus >= 1
  ).length;
  const consistency = windowStats.length ? strongWindows / windowStats.length : 0;
  const latest = windowStats[0] || { fourPlus: 0, threePlus: 0, size: 0, fourPlusRate: 0 };
  const allFourPlus = windowStats.length ? windowStats[windowStats.length - 1].fourPlus : 0;
  const allTrials = windowStats.length ? windowStats[windowStats.length - 1].size : 0;
  const lower = wilsonLower(allFourPlus, allTrials);
  const lift = baseline > 0 ? Math.min(3, lower / baseline) : 0;
  const age = draws.length - 1 - draws.map(draw => hitCount(draw, target) >= 3 ? 1 : 0).lastIndexOf(1);
  const recency = age <= draws.length ? 1 / (1 + Math.max(0, age)) : 0;

  const evidenceScore = Math.round(Math.min(100,
    consistency * 40 +
    Math.min(25, latest.threePlus * 5) +
    Math.min(20, latest.fourPlus * 10) +
    Math.min(10, lift * 5) +
    recency * 5
  ));

  let status = 'ABSTAIN';
  if (windowStats.length >= 2 && strongWindows >= 2 && evidenceScore >= 60 && lower > baseline) status = 'MEDIUM';
  if (windowStats.length === 3 && strongWindows === 3 && evidenceScore >= 78 && lower > baseline * 1.25) status = 'STRONG';

  return {
    status,
    evidenceScore,
    baseline,
    lowerBound: lower,
    stableWindows: strongWindows,
    consistency,
    recencyGap: age,
    windows: windowStats,
    reason: status === 'ABSTAIN' ? 'evidence-is-not-stable-across-windows' : 'multi-window-evidence-passed'
  };
}

module.exports = { scoreCandidate, prepareDraws, fourPlusBaseline };
