'use strict';

const { db } = require('./lib');

const PAGE_SIZE = 1000;
const MAX_DRAWS = 8000;
const DEFAULT_LOOKBACK = 10;
const VALIDATION_RATIO = 0.30;

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function parseTarget(raw) {
  return norm(String(raw || '').split(/[^0-9]+/).filter(Boolean));
}

function matched(draw, target) {
  const set = new Set(norm(draw?.numbers));
  return target.filter(n => set.has(n));
}

function combinations3(values) {
  const a = norm(values);
  const out = [];
  for (let i = 0; i < a.length - 2; i++) {
    for (let j = i + 1; j < a.length - 1; j++) {
      for (let k = j + 1; k < a.length; k++) out.push([a[i], a[j], a[k]]);
    }
  }
  return out;
}

async function loadRows(limit = MAX_DRAWS) {
  const out = [];
  let offset = 0;
  while (out.length < limit) {
    const take = Math.min(PAGE_SIZE, limit - out.length);
    const rows = (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&order=draw_id.desc&limit=${take}&offset=${offset}`
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

function buildFiveStudy(rows, target, lookback) {
  const exactFiveIndexes = [];
  rows.forEach((draw, index) => {
    if (matched(draw, target).length === 5) exactFiveIndexes.push(index);
  });

  const eventGaps = [];
  for (let i = 1; i < exactFiveIndexes.length; i++) {
    eventGaps.push(Number(rows[exactFiveIndexes[i]].draw_id) - Number(rows[exactFiveIndexes[i - 1]].draw_id));
  }

  const precursorTripleStats = new Map();
  const targetNumberPresence = Object.fromEntries(target.map(n => [n, 0]));
  const priorHitCountDistribution = { zero: 0, one: 0, two: 0, three: 0, four: 0, five: 0 };

  const events = exactFiveIndexes.map((eventIndex, eventOrder) => {
    const event = rows[eventIndex];
    const start = Math.max(0, eventIndex - lookback);
    const prior = rows.slice(start, eventIndex);

    const timeline = prior.map((draw, i) => {
      const hitNumbers = matched(draw, target);
      const count = hitNumbers.length;
      const key = count === 0 ? 'zero' : count === 1 ? 'one' : count === 2 ? 'two' : count === 3 ? 'three' : count === 4 ? 'four' : 'five';
      priorHitCountDistribution[key]++;
      hitNumbers.forEach(n => { targetNumberPresence[n] = (targetNumberPresence[n] || 0) + 1; });
      return {
        lead: eventIndex - (start + i),
        drawId: Number(draw.draw_id),
        date: draw.draw_date || '',
        time: draw.draw_time || '',
        hitCount: count,
        matchedTarget: hitNumbers,
        numbers: norm(draw.numbers)
      };
    });

    prior.slice(Math.max(0, prior.length - 5)).forEach((draw, localIndex, arr) => {
      const lead = arr.length - localIndex;
      combinations3(draw.numbers).forEach(triple => {
        const key = triple.join('-');
        const old = precursorTripleStats.get(key) || {
          numbers: triple,
          appearances: 0,
          eventIds: new Set(),
          leadCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
        };
        old.appearances++;
        old.eventIds.add(Number(event.draw_id));
        old.leadCounts[lead] = (old.leadCounts[lead] || 0) + 1;
        precursorTripleStats.set(key, old);
      });
    });

    const threePlus = timeline.filter(x => x.hitCount >= 3);
    const threePlusGaps = [];
    for (let i = 1; i < threePlus.length; i++) threePlusGaps.push(threePlus[i].drawId - threePlus[i - 1].drawId);

    return {
      order: eventOrder + 1,
      drawId: Number(event.draw_id),
      date: event.draw_date || '',
      time: event.draw_time || '',
      bullsEye: Number.isInteger(Number(event.bulls_eye)) ? Number(event.bulls_eye) : null,
      gapFromPreviousFive: eventOrder === 0 ? null : Number(event.draw_id) - Number(rows[exactFiveIndexes[eventOrder - 1]].draw_id),
      priorWindow: timeline,
      priorSummary: {
        lookbackDraws: timeline.length,
        threePlusCount: threePlus.length,
        fourPlusCount: timeline.filter(x => x.hitCount >= 4).length,
        maxHitBeforeFive: timeline.length ? Math.max(...timeline.map(x => x.hitCount)) : 0,
        nearestThreePlusLead: threePlus.length ? threePlus.at(-1).lead : null,
        threePlusGaps
      }
    };
  });

  const precursorTriples = [...precursorTripleStats.values()]
    .map(x => ({
      numbers: x.numbers,
      appearances: x.appearances,
      eventsCovered: x.eventIds.size,
      eventCoverage: exactFiveIndexes.length ? Number((x.eventIds.size / exactFiveIndexes.length).toFixed(4)) : 0,
      leadCounts: x.leadCounts
    }))
    .filter(x => x.eventsCovered >= 2)
    .sort((a, b) => b.eventsCovered - a.eventsCovered || b.appearances - a.appearances)
    .slice(0, 50);

  const totalPriorDraws = events.reduce((s, e) => s + e.priorWindow.length, 0);
  const targetPresence = target.map(n => ({
    number: n,
    appearances: targetNumberPresence[n] || 0,
    rate: totalPriorDraws ? Number(((targetNumberPresence[n] || 0) / totalPriorDraws).toFixed(4)) : 0
  })).sort((a, b) => b.appearances - a.appearances || a.number - b.number);

  return {
    exactFiveCount: events.length,
    eventGaps,
    events,
    aggregate: {
      lookbackDraws: lookback,
      totalPriorDraws,
      priorHitCountDistribution,
      targetPresence,
      recurringPrecursorTriples1to5: precursorTriples
    }
  };
}

function futureExactFive(hitCounts, index, horizon) {
  const end = Math.min(hitCounts.length - 1, index + horizon);
  for (let i = index + 1; i <= end; i++) {
    if (hitCounts[i] === 5) return i;
  }
  return -1;
}

function recentState(hitCounts, targetMatches, index) {
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
    if (threePlusPositions[i] - threePlusPositions[i - 1] <= 5) compressedThreePlus = true;
  }

  const recent20ExactFive = last20.filter(x => x === 5).length;
  const recent10ThreePlus = last10.filter(x => x >= 3).length;
  const recent10TwoPlus = last10.filter(x => x >= 2).length;
  const recent5DistinctTargetNumbers = union5.size;
  const recent5TotalTargetHits = last5.reduce((s, x) => s + x, 0);

  const cluster20 = recent20ExactFive > 0;
  const expansion10 =
    recent10ThreePlus >= 1 &&
    recent10TwoPlus >= 2 &&
    recent5DistinctTargetNumbers >= 4 &&
    recent5TotalTargetHits >= 6;
  const compressionExpansion = compressedThreePlus && recent5DistinctTargetNumbers >= 4;

  const singlePulse =
    expansion10 &&
    recent20ExactFive === 0 &&
    recent10ThreePlus === 1 &&
    !compressedThreePlus;
  const singlePulseFullCoverage = singlePulse && recent5DistinctTargetNumbers === 5;
  const singlePulseDense = singlePulse && recent5TotalTargetHits >= 8;
  const singlePulseFullDense = singlePulseFullCoverage && recent5TotalTargetHits >= 8;

  return {
    cluster20,
    expansion10,
    compressionExpansion,
    clusterOrExpansion: cluster20 || expansion10,
    singlePulse,
    singlePulseFullCoverage,
    singlePulseDense,
    singlePulseFullDense,
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

function baselineRate(hitCounts, startIndex, endIndex, horizon) {
  let opportunities = 0;
  let successes = 0;
  const end = Math.min(hitCounts.length - horizon, endIndex ?? hitCounts.length - horizon);
  for (let i = Math.max(20, startIndex); i < end; i++) {
    opportunities++;
    if (futureExactFive(hitCounts, i, horizon) >= 0) successes++;
  }
  return {
    opportunities,
    successes,
    successRate: opportunities ? Number((successes / opportunities).toFixed(6)) : 0
  };
}

function collectEpisodes(rows, hitCounts, targetMatches, startIndex, endIndex, ruleKey) {
  const episodes = [];
  let previousActive = false;
  const start = Math.max(20, startIndex);
  const end = Math.min(rows.length - 1, endIndex ?? rows.length - 1);

  for (let i = start; i < end; i++) {
    const state = recentState(hitCounts, targetMatches, i);
    const active = Boolean(state[ruleKey]);
    if (active && !previousActive) {
      episodes.push({
        index: i,
        drawId: Number(rows[i].draw_id),
        date: rows[i].draw_date || '',
        time: rows[i].draw_time || '',
        evidence: state.evidence
      });
    }
    previousActive = active;
  }
  return episodes;
}

function evaluateRule(rows, hitCounts, targetMatches, startIndex, ruleKey, endIndex = rows.length - 1) {
  const episodes = collectEpisodes(rows, hitCounts, targetMatches, startIndex, endIndex, ruleKey);

  const summarizeHorizon = horizon => {
    const baseline = baselineRate(hitCounts, startIndex, endIndex, horizon);
    const eligible = episodes.filter(e => e.index + horizon < Math.min(rows.length, endIndex + 1));
    const successes = [];
    const failures = [];
    const uniqueFutureEvents = new Set();

    eligible.forEach(e => {
      const found = futureExactFive(hitCounts, e.index, horizon);
      if (found >= 0 && found <= endIndex) {
        uniqueFutureEvents.add(Number(rows[found].draw_id));
        successes.push({
          signalDrawId: e.drawId,
          signalTime: e.time,
          eventDrawId: Number(rows[found].draw_id),
          eventTime: rows[found].draw_time || '',
          leadDraws: found - e.index,
          evidence: e.evidence
        });
      } else {
        failures.push({ signalDrawId: e.drawId, signalTime: e.time, evidence: e.evidence });
      }
    });

    const rate = eligible.length ? successes.length / eligible.length : 0;
    return {
      horizonDraws: horizon,
      signalEpisodes: eligible.length,
      successes: successes.length,
      failures: failures.length,
      successRate: Number(rate.toFixed(6)),
      baselineSuccessRate: baseline.successRate,
      liftVsBaseline: baseline.successRate > 0 ? Number((rate / baseline.successRate).toFixed(3)) : null,
      uniqueExactFiveEventsCaught: uniqueFutureEvents.size,
      successCases: successes.slice(0, 30),
      failureCases: failures.slice(0, 30)
    };
  };

  return {
    rule: ruleKey,
    episodeDefinition: 'A signal is counted only when the rule changes from inactive to active, so consecutive active draws do not inflate opportunity counts.',
    horizons: {
      oneToFive: summarizeHorizon(5),
      oneToTwenty: summarizeHorizon(20)
    }
  };
}

function buildDiscriminatorStudy(rows, hitCounts, targetMatches, validationStartIndex) {
  const rules = ['singlePulse', 'singlePulseFullCoverage', 'singlePulseDense', 'singlePulseFullDense'];
  const definitions = {
    singlePulse: 'Expansion state with no 5/5 in prior 20 draws, exactly one 3+ in prior 10 draws, and no compressed 3+ pair.',
    singlePulseFullCoverage: 'singlePulse plus all five target numbers appeared somewhere across the latest 5 draws.',
    singlePulseDense: 'singlePulse plus at least 8 total target-number hits across the latest 5 draws.',
    singlePulseFullDense: 'singlePulseFullCoverage plus at least 8 total target-number hits across the latest 5 draws.'
  };

  return {
    model: 'EXACT_5_SUCCESS_PROFILE_FILTERS_V1',
    exploratory: true,
    warning: 'These filters were chosen after inspecting the three successful Expansion cases, so their validation results are descriptive and can overfit. They must not be treated as proven until they survive fresh future draws or an untouched dataset.',
    commonProfileObservedInThreeShortHorizonSuccesses: {
      recent20ExactFive: 0,
      recent10ThreePlus: 1,
      compressedThreePlus: false
    },
    definitions,
    validation: Object.fromEntries(rules.map(rule => [
      rule,
      evaluateRule(rows, hitCounts, targetMatches, validationStartIndex, rule)
    ])),
    fullHistoryReference: Object.fromEntries(rules.map(rule => [
      rule,
      evaluateRule(rows, hitCounts, targetMatches, 20, rule)
    ]))
  };
}

function buildWalkForwardBacktest(rows, target) {
  const targetMatches = rows.map(draw => matched(draw, target));
  const hitCounts = targetMatches.map(x => x.length);
  const validationStartIndex = Math.floor(rows.length * (1 - VALIDATION_RATIO));
  const exactFiveValidation = hitCounts.slice(validationStartIndex).filter(x => x === 5).length;

  const rules = ['cluster20', 'expansion10', 'compressionExpansion', 'clusterOrExpansion'];
  return {
    model: 'EXACT_5_CLUSTER_EXPANSION_WALK_FORWARD_V2_FILTER_TEST',
    noFutureLeakage: true,
    caveat: 'The original rule family and the added discriminator filters were motivated by patterns already observed in this target. Chronology is respected, but the discriminator study is exploratory rather than a fully independent untouched-data experiment.',
    definitions: {
      cluster20: 'At least one exact 5/5 occurred in the most recent 20 completed draws.',
      expansion10: 'Past-only state: at least one 3+ in the latest 10 draws, at least two 2+ draws in the latest 10, at least four distinct target numbers seen across the latest 5 draws, and at least six total target hits across those latest 5 draws.',
      compressionExpansion: 'At least two 3+ occurrences inside the latest 10 draws separated by no more than 5 draws, plus at least four distinct target numbers seen across the latest 5 draws.',
      clusterOrExpansion: 'cluster20 OR expansion10.'
    },
    validation: {
      startIndex: validationStartIndex,
      startDrawId: rows[validationStartIndex] ? Number(rows[validationStartIndex].draw_id) : null,
      draws: rows.length - validationStartIndex,
      exactFiveEvents: exactFiveValidation,
      rules: Object.fromEntries(rules.map(rule => [rule, evaluateRule(rows, hitCounts, targetMatches, validationStartIndex, rule)]))
    },
    discriminatorStudy: buildDiscriminatorStudy(rows, hitCounts, targetMatches, validationStartIndex),
    fullHistoryReference: {
      draws: rows.length,
      exactFiveEvents: hitCounts.filter(x => x === 5).length,
      rules: Object.fromEntries(rules.map(rule => [rule, evaluateRule(rows, hitCounts, targetMatches, 20, rule)]))
    }
  };
}

module.exports = async function handler(req, res) {
  try {
    const target = parseTarget(req.query?.numbers || req.query?.set || '');
    if (target.length !== 5) {
      return res.status(400).json({ ok: false, reason: 'send-exactly-5-target-numbers' });
    }

    const requested = Number(req.query?.lookback || DEFAULT_LOOKBACK);
    const lookback = Math.max(1, Math.min(20, Number.isFinite(requested) ? Math.round(requested) : DEFAULT_LOOKBACK));
    const rows = await loadRows(MAX_DRAWS);
    const study = buildFiveStudy(rows, target, lookback);
    const walkForward = buildWalkForwardBacktest(rows, target);

    return res.status(200).json({
      ok: true,
      model: 'EXACT_5_OF_5_EVENT_STUDY_V3_DISCRIMINATOR',
      target,
      noFutureLeakage: true,
      analyzedDraws: rows.length,
      range: rows.length ? {
        firstDrawId: Number(rows[0].draw_id),
        firstDate: rows[0].draw_date || '',
        lastDrawId: Number(rows.at(-1).draw_id),
        lastDate: rows.at(-1).draw_date || '',
        lastTime: rows.at(-1).draw_time || ''
      } : null,
      study,
      walkForward,
      note: 'Historical research only. The discriminator filters were derived after inspecting successful cases and therefore require fresh out-of-sample confirmation before use as a predictive signal.'
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
};