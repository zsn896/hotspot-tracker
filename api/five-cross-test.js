'use strict';

const { db } = require('./lib');

const PAGE_SIZE = 1000;
const MAX_DRAWS = 8000;
const VALIDATION_RATIO = 0.30;
const HORIZON = 5;

// IMPORTANT: this endpoint freezes the Single Pulse rule exactly as defined
// in api/five-study.js. It does not tune thresholds per target.
const DEFAULT_CONTROL_TARGETS = [
  [3, 13, 17, 28, 50],
  [9, 17, 37, 51, 56],
  [9, 22, 37, 56, 71],
  [11, 17, 47, 51, 72]
];

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function parseTarget(raw) {
  return norm(String(raw || '').split(/[^0-9]+/).filter(Boolean));
}

function parseTargets(raw) {
  if (!raw) return DEFAULT_CONTROL_TARGETS.map(norm);
  return String(raw)
    .split(/[;|]/)
    .map(parseTarget)
    .filter(x => x.length === 5);
}

function matched(draw, target) {
  const set = new Set(norm(draw?.numbers));
  return target.filter(n => set.has(n));
}

async function loadRows(limit = MAX_DRAWS) {
  const out = [];
  let offset = 0;
  while (out.length < limit) {
    const take = Math.min(PAGE_SIZE, limit - out.length);
    const rows = (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=${take}&offset=${offset}`
      )
    ) || [];
    if (!rows.length) break;
    out.push(...rows);
    if (rows.length < take) break;
    offset += rows.length;
  }
  return out
    .filter(d => Number.isFinite(Number(d?.draw_id)) && norm(d?.numbers).length === 20)
    .sort((a, b) => Number(a.draw_id) - Number(b.draw_id));
}

function futureExactFive(hitCounts, index, horizon = HORIZON) {
  const end = Math.min(hitCounts.length - 1, index + horizon);
  for (let i = index + 1; i <= end; i++) {
    if (hitCounts[i] === 5) return i;
  }
  return -1;
}

function frozenSinglePulseState(hitCounts, targetMatches, index) {
  const last20Start = Math.max(0, index - 19);
  const last10Start = Math.max(0, index - 9);
  const last5Start = Math.max(0, index - 4);
  const last20 = hitCounts.slice(last20Start, index + 1);
  const last10 = hitCounts.slice(last10Start, index + 1);
  const last5 = hitCounts.slice(last5Start, index + 1);

  const union5 = new Set();
  for (let i = last5Start; i <= index; i++) {
    (targetMatches[i] || []).forEach(n => union5.add(n));
  }

  const threePlusPositions = [];
  for (let i = last10Start; i <= index; i++) {
    if (hitCounts[i] >= 3) threePlusPositions.push(i);
  }

  let compressedThreePlus = false;
  for (let i = 1; i < threePlusPositions.length; i++) {
    if (threePlusPositions[i] - threePlusPositions[i - 1] <= 5) {
      compressedThreePlus = true;
      break;
    }
  }

  const recent20ExactFive = last20.filter(x => x === 5).length;
  const recent10ThreePlus = last10.filter(x => x >= 3).length;
  const recent10TwoPlus = last10.filter(x => x >= 2).length;
  const recent5DistinctTargetNumbers = union5.size;
  const recent5TotalTargetHits = last5.reduce((sum, x) => sum + x, 0);

  const expansion10 =
    recent10ThreePlus >= 1 &&
    recent10TwoPlus >= 2 &&
    recent5DistinctTargetNumbers >= 4 &&
    recent5TotalTargetHits >= 6;

  const active =
    expansion10 &&
    recent20ExactFive === 0 &&
    recent10ThreePlus === 1 &&
    !compressedThreePlus;

  return {
    active,
    evidence: {
      recent20ExactFive,
      recent10ThreePlus,
      recent10TwoPlus,
      recent5DistinctTargetNumbers,
      recent5TotalTargetHits,
      compressedThreePlus
    }
  };
}

function collectEpisodes(rows, hitCounts, targetMatches, startIndex, endIndex) {
  const episodes = [];
  let previousActive = false;
  const start = Math.max(20, startIndex);
  const end = Math.min(rows.length - 1, endIndex);

  for (let i = start; i < end; i++) {
    const state = frozenSinglePulseState(hitCounts, targetMatches, i);
    if (state.active && !previousActive) {
      episodes.push({
        index: i,
        drawId: Number(rows[i].draw_id),
        date: rows[i].draw_date || '',
        time: rows[i].draw_time || '',
        evidence: state.evidence
      });
    }
    previousActive = state.active;
  }
  return episodes;
}

function baselineRate(hitCounts, startIndex, endIndex, horizon = HORIZON) {
  let opportunities = 0;
  let successes = 0;
  const end = Math.min(endIndex, hitCounts.length - horizon - 1);
  for (let i = Math.max(20, startIndex); i <= end; i++) {
    opportunities++;
    if (futureExactFive(hitCounts, i, horizon) >= 0) successes++;
  }
  return opportunities ? successes / opportunities : 0;
}

function evaluateTarget(rows, target) {
  const targetMatches = rows.map(draw => matched(draw, target));
  const hitCounts = targetMatches.map(x => x.length);
  const validationStartIndex = Math.floor(rows.length * (1 - VALIDATION_RATIO));
  const endIndex = rows.length - 1;
  const episodes = collectEpisodes(rows, hitCounts, targetMatches, validationStartIndex, endIndex)
    .filter(e => e.index + HORIZON <= endIndex);

  const successes = [];
  const failures = [];
  const uniqueEvents = new Set();

  for (const episode of episodes) {
    const found = futureExactFive(hitCounts, episode.index, HORIZON);
    if (found >= 0 && found <= endIndex) {
      uniqueEvents.add(Number(rows[found].draw_id));
      successes.push({
        signalDrawId: episode.drawId,
        signalTime: episode.time,
        eventDrawId: Number(rows[found].draw_id),
        eventTime: rows[found].draw_time || '',
        leadDraws: found - episode.index,
        evidence: episode.evidence
      });
    } else {
      failures.push({
        signalDrawId: episode.drawId,
        signalTime: episode.time,
        evidence: episode.evidence
      });
    }
  }

  const successRate = episodes.length ? successes.length / episodes.length : 0;
  const baseline = baselineRate(hitCounts, validationStartIndex, endIndex, HORIZON);
  const exactFiveValidation = hitCounts.slice(validationStartIndex).filter(x => x === 5).length;

  return {
    target,
    validation: {
      startDrawId: rows[validationStartIndex] ? Number(rows[validationStartIndex].draw_id) : null,
      draws: rows.length - validationStartIndex,
      exactFiveEvents: exactFiveValidation
    },
    frozenSinglePulse1to5: {
      signalEpisodes: episodes.length,
      successes: successes.length,
      failures: failures.length,
      successRate: Number(successRate.toFixed(6)),
      baselineSuccessRate: Number(baseline.toFixed(6)),
      liftVsBaseline: baseline > 0 ? Number((successRate / baseline).toFixed(3)) : null,
      uniqueExactFiveEventsCaught: uniqueEvents.size,
      successCases: successes.slice(0, 12),
      failureCases: failures.slice(0, 12)
    }
  };
}

function aggregate(results) {
  const eligible = results.filter(r => r.frozenSinglePulse1to5.baselineSuccessRate > 0);
  const totalSignals = eligible.reduce((s, r) => s + r.frozenSinglePulse1to5.signalEpisodes, 0);
  const totalSuccesses = eligible.reduce((s, r) => s + r.frozenSinglePulse1to5.successes, 0);
  const totalFailures = eligible.reduce((s, r) => s + r.frozenSinglePulse1to5.failures, 0);
  const weightedBaselineNumerator = eligible.reduce(
    (s, r) => s + r.frozenSinglePulse1to5.baselineSuccessRate * r.frozenSinglePulse1to5.signalEpisodes,
    0
  );
  const pooledRate = totalSignals ? totalSuccesses / totalSignals : 0;
  const weightedBaseline = totalSignals ? weightedBaselineNumerator / totalSignals : 0;

  return {
    eligibleTargets: eligible.length,
    totalTargets: results.length,
    totalSignals,
    totalSuccesses,
    totalFailures,
    pooledSuccessRate: Number(pooledRate.toFixed(6)),
    weightedBaselineSuccessRate: Number(weightedBaseline.toFixed(6)),
    pooledLiftVsWeightedBaseline: weightedBaseline > 0 ? Number((pooledRate / weightedBaseline).toFixed(3)) : null,
    targetsAboveBaseline: eligible.filter(r => (r.frozenSinglePulse1to5.liftVsBaseline || 0) > 1).length,
    targetsAtOrBelowBaseline: eligible.filter(r => (r.frozenSinglePulse1to5.liftVsBaseline || 0) <= 1).length
  };
}

module.exports = async function handler(req, res) {
  try {
    const targets = parseTargets(req.query?.sets || req.query?.targets || '');
    if (!targets.length) {
      return res.status(400).json({ ok: false, reason: 'send-one-or-more-5-number-sets-separated-by-semicolons' });
    }
    if (targets.length > 12) {
      return res.status(400).json({ ok: false, reason: 'maximum-12-target-sets' });
    }

    const rows = await loadRows(MAX_DRAWS);
    const results = targets.map(target => evaluateTarget(rows, target));

    return res.status(200).json({
      ok: true,
      model: 'FROZEN_SINGLE_PULSE_CROSS_TARGET_OOS_V1',
      noFutureLeakage: true,
      frozenRule: {
        horizonDraws: 5,
        definition: 'Expansion10 AND no exact 5/5 in the latest 20 draws AND exactly one 3+ in the latest 10 draws AND no compressed 3+ pair. Expansion10 remains: at least one 3+ in 10, at least two 2+ in 10, at least four distinct target numbers across 5, and at least six total target hits across 5.',
        tuningPerTarget: false
      },
      analyzedDraws: rows.length,
      validationRatio: VALIDATION_RATIO,
      sourceTargetExcludedByDefault: [9, 15, 56, 75, 79],
      range: rows.length ? {
        firstDrawId: Number(rows[0].draw_id),
        lastDrawId: Number(rows.at(-1).draw_id),
        lastDate: rows.at(-1).draw_date || '',
        lastTime: rows.at(-1).draw_time || ''
      } : null,
      aggregate: aggregate(results),
      results,
      note: 'This is a cross-target check of the already-frozen Single Pulse rule. The default control targets were not used to define the Single Pulse thresholds in five-study.js. Treat this as a stronger check than same-target tuning, but not as proof of predictive edge.'
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
};