'use strict';

const DEFAULT_OPTIONS = {
  leadMin: 1,
  leadMax: 5,
  discoveryRatio: 0.70,
  minDiscoveryHits: 20,
  minCandidateSupport: 4,
  candidateLimit: 240,
  resultLimit: 24,
  confidenceHistory: 12
};

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function hitCount(draw, numbers) {
  const set = new Set(norm(draw?.numbers));
  return norm(numbers).filter(n => set.has(n)).length;
}

function combinations3(values) {
  const a = norm(values);
  const out = [];
  for (let i = 0; i < a.length - 2; i++) {
    for (let j = i + 1; j < a.length - 1; j++) {
      for (let k = j + 1; k < a.length; k++) {
        out.push([a[i], a[j], a[k]]);
      }
    }
  }
  return out;
}

function tripleKey(values) {
  return norm(values).join('-');
}

function parseTripleKey(key) {
  return String(key).split('-').map(Number);
}

function drawHasTriple(draw, triple) {
  const set = new Set(norm(draw?.numbers));
  return triple.every(n => set.has(n));
}

function hour24(timeText) {
  const text = String(timeText || '').trim().toLowerCase();
  const m = text.match(/(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  if (!Number.isFinite(hour) || hour < 1 || hour > 12) return null;
  const ampm = m[3].toLowerCase();
  if (ampm === 'a' && hour === 12) hour = 0;
  if (ampm === 'p' && hour !== 12) hour += 12;
  return hour;
}

function safeRate(a, b) {
  return b > 0 ? a / b : 0;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function futureHitFlags(hitMask, start, leadMin, leadMax, endExclusive) {
  for (let lead = leadMin; lead <= leadMax; lead++) {
    const idx = start + lead;
    if (idx >= endExclusive) break;
    if (hitMask[idx]) return true;
  }
  return false;
}

function hitSummary(draws, target) {
  const out = { total: 0, three: 0, four: 0, five: 0, byHour: {} };
  for (const draw of draws) {
    const hits = hitCount(draw, target);
    if (hits < 3) continue;
    out.total++;
    if (hits === 3) out.three++;
    else if (hits === 4) out.four++;
    else if (hits >= 5) out.five++;
    const h = hour24(draw?.draw_time);
    if (h != null) out.byHour[h] = (out.byHour[h] || 0) + 1;
  }
  return out;
}

function discoverCandidateTriples(draws, hitMask, start, end, options) {
  const { leadMin, leadMax, minCandidateSupport } = options;
  const stats = new Map();
  let eligibleHits = 0;

  for (let hitIndex = start; hitIndex < end; hitIndex++) {
    if (!hitMask[hitIndex]) continue;
    if (hitIndex - leadMax < start) continue;
    eligibleHits++;

    const anySeen = new Set();

    for (let lead = leadMin; lead <= leadMax; lead++) {
      const predecessor = draws[hitIndex - lead];
      const triples = combinations3(predecessor?.numbers || []);
      for (const triple of triples) {
        const key = triple.join('-');
        let item = stats.get(key);
        if (!item) {
          item = { key, precursorHits: 0, leadCounts: Array(leadMax + 1).fill(0) };
          stats.set(key, item);
        }
        item.leadCounts[lead]++;
        anySeen.add(key);
      }
    }

    for (const key of anySeen) {
      const item = stats.get(key);
      item.precursorHits++;
    }
  }

  const candidates = [...stats.values()]
    .filter(x => x.precursorHits >= minCandidateSupport)
    .sort((a, b) => b.precursorHits - a.precursorHits)
    .slice(0, options.candidateLimit);

  return { eligibleHits, candidates };
}

function segmentMetrics(draws, hitMask, start, end, candidates, options) {
  const { leadMin, leadMax } = options;
  const width = Math.max(1, end - start);
  let baselineOpportunities = 0;
  let baselineForwardHits = 0;

  for (let i = start; i < end; i++) {
    if (i + leadMin >= end) break;
    baselineOpportunities++;
    if (futureHitFlags(hitMask, i, leadMin, leadMax, end)) baselineForwardHits++;
  }

  const baselineForwardRate = safeRate(baselineForwardHits, baselineOpportunities);
  const results = [];

  for (const candidate of candidates) {
    const triple = parseTripleKey(candidate.key);
    let signalDraws = 0;
    let signalThenHit = 0;
    let drawOccurrences = 0;
    let precursorEligibleHits = 0;
    let precursorHitMatches = 0;
    const leadCounts = Array(leadMax + 1).fill(0);

    for (let i = start; i < end; i++) {
      if (!drawHasTriple(draws[i], triple)) continue;
      drawOccurrences++;
      if (i + leadMin < end) {
        signalDraws++;
        if (futureHitFlags(hitMask, i, leadMin, leadMax, end)) signalThenHit++;
      }
    }

    for (let hitIndex = start; hitIndex < end; hitIndex++) {
      if (!hitMask[hitIndex] || hitIndex - leadMax < start) continue;
      precursorEligibleHits++;
      let matched = false;
      for (let lead = leadMin; lead <= leadMax; lead++) {
        if (drawHasTriple(draws[hitIndex - lead], triple)) {
          leadCounts[lead]++;
          matched = true;
        }
      }
      if (matched) precursorHitMatches++;
    }

    const occurrenceRate = safeRate(drawOccurrences, width);
    const forwardHitRate = safeRate(signalThenHit, signalDraws);
    const forwardLift = baselineForwardRate > 0 ? forwardHitRate / baselineForwardRate : 0;
    const precursorCoverage = safeRate(precursorHitMatches, precursorEligibleHits);

    let bestLead = null;
    let bestLeadCount = 0;
    for (let lead = leadMin; lead <= leadMax; lead++) {
      if (leadCounts[lead] > bestLeadCount) {
        bestLead = lead;
        bestLeadCount = leadCounts[lead];
      }
    }

    results.push({
      numbers: triple,
      signalDraws,
      signalThenHit,
      occurrenceRate: round(occurrenceRate),
      forwardHitRate: round(forwardHitRate),
      baselineForwardRate: round(baselineForwardRate),
      forwardLift: round(forwardLift, 3),
      precursorEligibleHits,
      precursorHitMatches,
      precursorCoverage: round(precursorCoverage),
      bestLead,
      bestLeadCount,
      leadCounts: leadCounts.slice(leadMin, leadMax + 1)
    });
  }

  return {
    start,
    end,
    draws: width,
    baselineOpportunities,
    baselineForwardHits,
    baselineForwardRate: round(baselineForwardRate),
    candidates: results
  };
}

function confidenceLabel(discovery, validation) {
  const support = Math.min(discovery.signalDraws || 0, validation.signalDraws || 0);
  const lift = Number(validation.forwardLift || 0);
  const coverage = Number(validation.precursorCoverage || 0);

  if (support >= 8 && lift >= 1.6 && coverage >= 0.18) return 'STRONG';
  if (support >= 5 && lift >= 1.3 && coverage >= 0.12) return 'MODERATE';
  if (support >= 3 && lift >= 1.1) return 'WEAK';
  return 'UNCONFIRMED';
}

function activeSignalsAtIndex(draws, ranked, options, index) {
  const out = [];
  const first = Math.max(0, index - options.leadMax + 1);

  for (const item of ranked) {
    let latestSignalIndex = -1;
    for (let i = first; i <= index; i++) {
      if (drawHasTriple(draws[i], item.numbers)) latestSignalIndex = i;
    }
    if (latestSignalIndex < 0) continue;

    out.push({
      numbers: item.numbers,
      confidence: item.confidence,
      validationLift: Number(item.validation?.forwardLift || 0),
      validationCoverage: Number(item.validation?.precursorCoverage || 0),
      validationSignals: Number(item.validation?.signalDraws || 0),
      bestLead: item.validation?.bestLead || item.discovery?.bestLead || null,
      appearedDrawId: Number(draws[latestSignalIndex]?.draw_id || 0) || null,
      appearedTime: draws[latestSignalIndex]?.draw_time || '',
      drawsAgo: index - latestSignalIndex
    });
  }

  return out.sort((a, b) =>
    b.validationLift - a.validationLift ||
    b.validationCoverage - a.validationCoverage
  );
}

function activeSignals(draws, ranked, options) {
  if (!draws.length) return [];
  return activeSignalsAtIndex(draws, ranked, options, draws.length - 1);
}

function confidenceBase(label) {
  if (label === 'STRONG') return 50;
  if (label === 'MODERATE') return 36;
  if (label === 'WEAK') return 20;
  return 8;
}

function scoreLiveSignal(signal, options) {
  const lift = Number(signal.validationLift || 0);
  const coverage = Number(signal.validationCoverage || 0);
  const support = Number(signal.validationSignals || 0);
  const age = Math.max(0, Number(signal.drawsAgo || 0));
  const recency = clamp((options.leadMax - age) / Math.max(1, options.leadMax), 0, 1);

  return Math.round(clamp(
    confidenceBase(signal.confidence) +
    clamp((lift - 1) * 22, 0, 26) +
    clamp(coverage * 45, 0, 10) +
    clamp(support / 12, 0, 1) * 8 +
    recency * 12,
    0,
    100
  ));
}

function confidenceLevel(score) {
  if (score >= 80) return 'VERY_HIGH';
  if (score >= 65) return 'HIGH';
  if (score >= 45) return 'MEDIUM';
  if (score >= 25) return 'LOW';
  return 'QUIET';
}

function liveConfidenceAtIndex(draws, ranked, options, target, index) {
  const signals = activeSignalsAtIndex(draws, ranked, options, index);
  const targetHits = hitCount(draws[index], target);

  if (targetHits >= 3) {
    return {
      drawId: Number(draws[index]?.draw_id || 0) || null,
      time: draws[index]?.draw_time || '',
      score: 12,
      level: 'HIT_RESET',
      hitNow: true,
      hitCount: targetHits,
      activeSignals: signals.slice(0, 5)
    };
  }

  const scored = signals
    .map(signal => ({ ...signal, liveScore: scoreLiveSignal(signal, options) }))
    .sort((a, b) => b.liveScore - a.liveScore);

  const strongest = Number(scored[0]?.liveScore || 0);
  const second = Number(scored[1]?.liveScore || 0);
  const third = Number(scored[2]?.liveScore || 0);
  const multiSignalBonus = Math.min(15, Math.round(second * 0.10 + third * 0.06));
  const score = Math.round(clamp(strongest + multiSignalBonus, 0, 100));

  return {
    drawId: Number(draws[index]?.draw_id || 0) || null,
    time: draws[index]?.draw_time || '',
    score,
    level: confidenceLevel(score),
    hitNow: false,
    hitCount: targetHits,
    activeSignals: scored.slice(0, 5)
  };
}

function buildLiveConfidence(draws, ranked, options, target) {
  if (!draws.length) {
    return {
      score: 0,
      level: 'QUIET',
      trend: 'STABLE',
      delta: 0,
      activeSignals: [],
      history: []
    };
  }

  const count = Math.max(2, Number(options.confidenceHistory || 12));
  const start = Math.max(0, draws.length - count);
  const history = [];

  for (let i = start; i < draws.length; i++) {
    history.push(liveConfidenceAtIndex(draws, ranked, options, target, i));
  }

  const current = history.at(-1);
  const previous = history.at(-2) || current;
  const delta = Number(current.score || 0) - Number(previous.score || 0);
  const trend = delta >= 6
    ? 'RISING'
    : delta <= -6
      ? 'FALLING'
      : 'STABLE';

  return {
    score: Number(current.score || 0),
    level: current.level || confidenceLevel(Number(current.score || 0)),
    trend,
    delta,
    hitNow: Boolean(current.hitNow),
    hitCount: Number(current.hitCount || 0),
    latestDrawId: current.drawId,
    latestTime: current.time,
    activeSignals: current.activeSignals || [],
    history: history.map(row => ({
      drawId: row.drawId,
      time: row.time,
      score: row.score,
      level: row.level,
      hitNow: row.hitNow,
      hitCount: row.hitCount
    }))
  };
}

function analyzePrecursors(inputDraws, targetNumbers, rawOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...rawOptions };
  const target = norm(targetNumbers);
  const draws = (inputDraws || [])
    .filter(d => Number.isFinite(Number(d?.draw_id)) && norm(d?.numbers).length === 20)
    .sort((a, b) => Number(a.draw_id) - Number(b.draw_id));

  if (target.length < 3 || target.length > 5) {
    return { ok: false, reason: 'target-must-have-3-to-5-numbers' };
  }
  if (draws.length < 80) {
    return { ok: false, reason: 'not-enough-draws', have: draws.length, need: 80 };
  }

  const hitMask = draws.map(draw => hitCount(draw, target) >= 3);
  const split = Math.max(
    options.leadMax + 10,
    Math.min(draws.length - (options.leadMax + 10), Math.floor(draws.length * options.discoveryRatio))
  );

  const discoveryHits = hitMask.slice(0, split).filter(Boolean).length;
  const validationHits = hitMask.slice(split).filter(Boolean).length;
  if (discoveryHits < options.minDiscoveryHits) {
    return {
      ok: false,
      reason: 'not-enough-discovery-hits',
      discoveryHits,
      validationHits,
      draws: draws.length
    };
  }

  const discoveryCandidates = discoverCandidateTriples(draws, hitMask, 0, split, options);
  const discovery = segmentMetrics(draws, hitMask, 0, split, discoveryCandidates.candidates, options);
  const validation = segmentMetrics(draws, hitMask, split, draws.length, discoveryCandidates.candidates, options);

  const validationMap = new Map(
    validation.candidates.map(x => [tripleKey(x.numbers), x])
  );

  const ranked = discovery.candidates
    .map(d => {
      const v = validationMap.get(tripleKey(d.numbers));
      const confidence = confidenceLabel(d, v || {});
      const stability = v && d.forwardLift > 0
        ? Math.min(v.forwardLift, d.forwardLift) / Math.max(v.forwardLift, d.forwardLift)
        : 0;
      const score = (
        Math.min(3, Number(v?.forwardLift || 0)) * 35 +
        Math.min(1, Number(v?.precursorCoverage || 0) * 3) * 25 +
        Math.min(1, Number(stability || 0)) * 20 +
        Math.min(1, Number(v?.signalDraws || 0) / 12) * 20
      );
      return {
        numbers: d.numbers,
        confidence,
        score: Math.round(score),
        discovery: d,
        validation: v || null,
        stableLiftRatio: round(stability, 3)
      };
    })
    .filter(x => x.validation && x.validation.signalDraws >= 2)
    .sort((a, b) =>
      b.score - a.score ||
      Number(b.validation?.forwardLift || 0) - Number(a.validation?.forwardLift || 0) ||
      Number(b.validation?.precursorCoverage || 0) - Number(a.validation?.precursorCoverage || 0)
    )
    .slice(0, options.resultLimit);

  const summary = hitSummary(draws, target);
  const first = draws[0];
  const last = draws.at(-1);
  const currentSignals = activeSignals(draws, ranked, options);
  const liveConfidence = buildLiveConfidence(draws, ranked, options, target);

  return {
    ok: true,
    model: 'HISTORICAL_PRECURSOR_VALIDATED_V2',
    target,
    rule: 'A target HIT is any draw containing 3 or more target numbers. Candidate precursor triples are discovered only in the first 70% of the history and evaluated on the later 30%. Forward lift compares the chance of a target HIT within the next 1-5 draws after the signal against the unconditional historical chance. Live confidence is recalculated from validated precursor signals after every new draw.',
    noFutureLeakage: true,
    analyzedDraws: draws.length,
    range: {
      firstDrawId: Number(first?.draw_id || 0) || null,
      firstDate: first?.draw_date || '',
      lastDrawId: Number(last?.draw_id || 0) || null,
      lastDate: last?.draw_date || '',
      lastTime: last?.draw_time || ''
    },
    targetHits: summary,
    split: {
      discoveryDraws: split,
      validationDraws: draws.length - split,
      discoveryHits,
      validationHits,
      discoveryRatio: round(split / draws.length, 3)
    },
    leadWindow: {
      min: options.leadMin,
      max: options.leadMax
    },
    candidatesDiscovered: discoveryCandidates.candidates.length,
    baseline: {
      discoveryForwardHitRate: discovery.baselineForwardRate,
      validationForwardHitRate: validation.baselineForwardRate
    },
    precursors: ranked,
    activeSignals: currentSignals,
    liveConfidence
  };
}

module.exports = {
  analyzePrecursors,
  combinations3,
  hitCount
};
