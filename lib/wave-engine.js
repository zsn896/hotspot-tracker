'use strict';

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function hitNumbers(draw, group) {
  const set = new Set(norm(draw?.numbers));
  return group.filter(n => set.has(n));
}

function choose3(values) {
  const out = [];

  for (let i = 0; i < values.length - 2; i++) {
    for (let j = i + 1; j < values.length - 1; j++) {
      for (let k = j + 1; k < values.length; k++) {
        out.push([values[i], values[j], values[k]]);
      }
    }
  }

  return out;
}

function coreKey(numbers) {
  return norm(numbers).slice(0, 3).join(',');
}

function windowStats(rows, group) {
  let twoPlus = 0;
  let threePlus = 0;
  let fourPlus = 0;
  let exact5 = 0;
  let totalHits = 0;

  const core3 = new Map();
  const numberHits = new Map(group.map(n => [n, 0]));

  for (const draw of rows) {
    const hits = hitNumbers(draw, group);

    totalHits += hits.length;

    if (hits.length >= 2) twoPlus++;

    if (hits.length >= 3) {
      threePlus++;

      for (const core of choose3(hits)) {
        const key = coreKey(core);
        core3.set(key, Number(core3.get(key) || 0) + 1);
      }
    }

    if (hits.length >= 4) fourPlus++;
    if (hits.length === 5) exact5++;

    for (const n of hits) {
      numberHits.set(n, Number(numberHits.get(n) || 0) + 1);
    }
  }

  const coreRows = [...core3.entries()]
    .map(([key, count]) => ({
      numbers: key.split(',').map(Number),
      count
    }))
    .sort((a, b) =>
      b.count - a.count ||
      a.numbers.join(',').localeCompare(b.numbers.join(','))
    );

  const coreOccurrences = coreRows.reduce(
    (sum, item) => sum + Number(item.count || 0),
    0
  );

  return {
    draws: rows.length,

    averageHits:
      rows.length
        ? totalHits / rows.length
        : 0,

    twoPlus,
    threePlus,
    fourPlus,
    exact5,

    uniqueCore3: core3.size,
    coreOccurrences,
    core3: coreRows,

    numberHits: [...numberHits.entries()]
      .map(([number, count]) => ({ number, count }))
      .sort((a, b) =>
        b.count - a.count ||
        a.number - b.number
      )
  };
}

function ratio(current, baseline, floor = 0.01) {
  return current / Math.max(floor, baseline);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function logChoose(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) {
    return Number.NEGATIVE_INFINITY;
  }

  const m = Math.min(k, n - k);
  let out = 0;

  for (let i = 1; i <= m; i++) {
    out += Math.log(n - m + i) - Math.log(i);
  }

  return out;
}

function hypergeometricProbability(successesDrawn, populationSuccesses = 5, populationSize = 80, drawSize = 20) {
  const k = Number(successesDrawn);

  if (
    !Number.isInteger(k) ||
    k < 0 ||
    k > populationSuccesses ||
    drawSize - k < 0 ||
    drawSize - k > populationSize - populationSuccesses
  ) {
    return 0;
  }

  const logP =
    logChoose(populationSuccesses, k) +
    logChoose(populationSize - populationSuccesses, drawSize - k) -
    logChoose(populationSize, drawSize);

  return Math.exp(logP);
}

function theoreticalFiveNumberBaseline() {
  const exact = {};

  for (let k = 0; k <= 5; k++) {
    exact[k] = hypergeometricProbability(k);
  }

  const sumFrom = start => {
    let total = 0;
    for (let k = start; k <= 5; k++) total += exact[k];
    return total;
  };

  return {
    model: 'HYPERGEOMETRIC_80_CHOOSE_20_FOR_FIXED_5',
    populationSize: 80,
    drawSize: 20,
    trackedNumbers: 5,
    exact: Object.fromEntries(
      Object.entries(exact).map(([k, p]) => [k, Number(p.toFixed(8))])
    ),
    twoPlusRate: Number(sumFrom(2).toFixed(8)),
    threePlusRate: Number(sumFrom(3).toFixed(8)),
    fourPlusRate: Number(sumFrom(4).toFixed(8)),
    exact5Rate: Number(exact[5].toFixed(8))
  };
}

function binomialUpperTail(n, observed, probability) {
  const trials = Number(n);
  const hits = Number(observed);
  const p = Number(probability);

  if (!Number.isInteger(trials) || trials < 0 || !Number.isInteger(hits) || hits < 0) {
    return null;
  }

  if (hits <= 0) return 1;
  if (hits > trials) return 0;
  if (!(p > 0 && p < 1)) return p >= 1 ? 1 : 0;

  let total = 0;

  for (let k = hits; k <= trials; k++) {
    const logP =
      logChoose(trials, k) +
      k * Math.log(p) +
      (trials - k) * Math.log(1 - p);

    total += Math.exp(logP);
  }

  return clamp(total, 0, 1);
}

function surpriseForWindow(stats, expectedThreePlusRate) {
  const draws = Math.max(0, Number(stats?.draws || 0));
  const observed = Math.max(0, Number(stats?.threePlus || 0));
  const expectedRate = Number(expectedThreePlusRate || 0);
  const observedRate = draws ? observed / draws : 0;
  const expectedCount = draws * expectedRate;
  const pValue = draws
    ? binomialUpperTail(draws, observed, expectedRate)
    : null;

  const surpriseLog10 = pValue == null
    ? 0
    : -Math.log10(Math.max(1e-12, pValue));

  const score = Math.round(clamp(surpriseLog10 * 28, 0, 100));
  const lift = expectedRate > 0 ? observedRate / expectedRate : 0;

  let evidence = 'NORMAL';
  if (pValue != null && observedRate > expectedRate) {
    if (pValue <= 0.01) evidence = 'VERY_UNUSUAL';
    else if (pValue <= 0.05) evidence = 'UNUSUAL';
    else if (pValue <= 0.15) evidence = 'ELEVATED';
  }

  return {
    draws,
    observedThreePlus: observed,
    observedRate: Number(observedRate.toFixed(4)),
    expectedThreePlus: Number(expectedCount.toFixed(3)),
    expectedRate: Number(expectedRate.toFixed(4)),
    liftVsRandom: Number(lift.toFixed(3)),
    upperTailPValue: pValue == null ? null : Number(pValue.toFixed(8)),
    surpriseScore: score,
    evidence,
    interpretation:
      evidence === 'VERY_UNUSUAL'
        ? 'Recent 3+ frequency is very unusual versus the fixed-five random baseline.'
        : evidence === 'UNUSUAL'
          ? 'Recent 3+ frequency is unusual versus the fixed-five random baseline.'
          : evidence === 'ELEVATED'
            ? 'Recent 3+ frequency is elevated, but evidence is not yet strong.'
            : 'Recent 3+ frequency is compatible with ordinary random variation.'
  };
}

function leaderOf(stats) {
  const row = stats?.core3?.[0] || null;

  return row
    ? {
        numbers: norm(row.numbers).slice(0, 3),
        count: Number(row.count || 0)
      }
    : null;
}

function coreCountIn(stats, numbers) {
  if (!stats || !Array.isArray(stats.core3) || !Array.isArray(numbers)) return 0;
  const key = coreKey(numbers);
  const row = stats.core3.find(item => coreKey(item.numbers) === key);
  return Number(row?.count || 0);
}

function sameCore(a, b) {
  if (!a || !b) return false;
  return coreKey(a.numbers) === coreKey(b.numbers);
}

function coreSupport(stats, limit = 5) {
  const total = Math.max(1, Number(stats?.coreOccurrences || 0));

  return (stats?.core3 || [])
    .slice(0, limit)
    .map(item => ({
      numbers: norm(item.numbers).slice(0, 3),
      count: Number(item.count || 0),
      share: Number((Number(item.count || 0) / total).toFixed(3))
    }));
}

function rotationMetrics(currentStats, previousStats) {
  const currentLeader = leaderOf(currentStats);
  const previousLeader = leaderOf(previousStats);

  const leaderChanged =
    Boolean(currentLeader && previousLeader) &&
    !sameCore(currentLeader, previousLeader);

  const breadth = Math.min(10, Number(currentStats?.uniqueCore3 || 0));
  const breadthRate = breadth / 10;

  const active = coreSupport(currentStats, 5);
  const meaningfulCores = active.filter(item => item.count >= 1).length;

  const topShare = Number(active?.[0]?.share || 0);
  const secondShare = Number(active?.[1]?.share || 0);
  const distributedLeadership =
    meaningfulCores >= 2 &&
    secondShare >= 0.15;

  let score = 0;

  score += clamp(breadthRate * 45, 0, 45);
  score += clamp(meaningfulCores * 6, 0, 24);

  if (leaderChanged) score += 18;
  if (distributedLeadership) score += 13;

  if (topShare > 0.75 && breadth <= 2) {
    score -= 12;
  }

  score = Math.round(clamp(score, 0, 100));

  return {
    currentLeaderCore3: currentLeader,
    previousLeaderCore3: previousLeader,
    leaderChanged,
    rotationBreadth: breadth,
    rotationBreadthRate: Number(breadthRate.toFixed(3)),
    meaningfulCores,
    distributedLeadership,
    topCoreShare: Number(topShare.toFixed(3)),
    score,
    activeCores: active
  };
}

function analyzeGroupWave(inputDraws, inputGroup) {
  const group = norm(inputGroup);

  const draws = Array.isArray(inputDraws)
    ? [...inputDraws]
        .filter(d => norm(d?.numbers).length === 20)
        .sort((a, b) =>
          Number(a.draw_id || a.id || 0) -
          Number(b.draw_id || b.id || 0)
        )
    : [];

  if (group.length !== 5) {
    return {
      ok: false,
      reason: 'group-must-have-five-unique-numbers'
    };
  }

  if (draws.length < 20) {
    return {
      ok: true,
      group,
      state: 'DORMANT',
      stateAr: 'جمود / بيانات غير كافية',
      score: 0,
      alert: false,
      alertLevel: 'NONE',
      reason: 'need-at-least-20-draws',
      leadership: {
        currentLeaderCore3: null,
        previousLeaderCore3: null,
        leaderChanged: false,
        rotationBreadth: 0,
        rotationBreadthRate: 0,
        meaningfulCores: 0,
        distributedLeadership: false,
        topCoreShare: 0,
        score: 0,
        activeCores: []
      }
    };
  }

  const w10 = windowStats(draws.slice(-10), group);
  const w20 = windowStats(draws.slice(-20), group);
  const w40 = windowStats(
    draws.slice(-Math.min(40, draws.length)),
    group
  );

  const theoreticalBaseline = theoreticalFiveNumberBaseline();
  const statistical20 = surpriseForWindow(w20, theoreticalBaseline.threePlusRate);
  const statistical40 = surpriseForWindow(w40, theoreticalBaseline.threePlusRate);

  const previous10 =
    draws.length >= 20
      ? windowStats(draws.slice(-20, -10), group)
      : null;

  const previous20 =
    draws.length >= 40
      ? windowStats(draws.slice(-40, -20), group)
      : null;

  const baselineRows = draws.slice(
    0,
    Math.max(0, draws.length - 20)
  );

  const baseline = windowStats(
    baselineRows.length >= 20
      ? baselineRows
      : draws,
    group
  );

  const bDraws = Math.max(1, baseline.draws);
  const rDraws = Math.max(1, w20.draws);

  const baseTwo = baseline.twoPlus / bDraws;
  const baseThree = baseline.threePlus / bDraws;
  const baseFour = baseline.fourPlus / bDraws;

  const recentTwo = w20.twoPlus / rDraws;
  const recentThree = w20.threePlus / rDraws;
  const recentFour = w20.fourPlus / rDraws;

  const twoLift = ratio(recentTwo, baseTwo, 0.02);
  const threeLift = ratio(recentThree, baseThree, 0.005);
  const fourLift = ratio(recentFour, baseFour, 0.0025);
  const averageLift = ratio(
    w20.averageHits,
    baseline.averageHits,
    0.2
  );

  const shortAcceleration =
    w10.threePlus * 2 - w20.threePlus;

  const shortAverageAcceleration =
    previous10
      ? w10.averageHits - previous10.averageHits
      : 0;

  const leadership = rotationMetrics(w10, previous10);
  const broaderLeadership = rotationMetrics(w20, previous20);

  const quietPrevious10 =
    previous10
      ? previous10.threePlus <= 1 &&
        previous10.fourPlus === 0 &&
        previous10.averageHits <= w20.averageHits
      : false;

  const shortReturn =
    quietPrevious10 &&
    w10.threePlus >= 2 &&
    (
      leadership.rotationBreadth >= 2 ||
      leadership.leaderChanged ||
      shortAverageAcceleration >= 0.2
    );

  const quietPrevious20 =
    previous20
      ? previous20.threePlus <=
          Math.max(1, Math.floor(baseline.threePlus / Math.max(1, baseline.draws) * 20)) &&
        previous20.fourPlus === 0
      : false;

  const broaderReturn =
    quietPrevious20 &&
    w20.threePlus >= 2 &&
    (
      threeLift >= 1.1 ||
      broaderLeadership.rotationBreadth >= 3
    );

  const rebound = shortReturn || broaderReturn;

  const coolingEvidence =
    previous10
      ? (
          previous10.threePlus > w10.threePlus &&
          previous10.threePlus >= 2
        ) ||
        (
          previous10.fourPlus > w10.fourPlus &&
          previous10.fourPlus >= 1
        ) ||
        (
          previous10.averageHits - w10.averageHits >= 0.35
        )
      : false;

  let score = 0;

  score += clamp((twoLift - 0.9) * 18, 0, 18);
  score += clamp((threeLift - 0.8) * 28, 0, 32);
  score += clamp((fourLift - 0.8) * 12, 0, 16);
  score += clamp((averageLift - 0.9) * 18, 0, 12);
  score += clamp(shortAcceleration * 5, 0, 10);

  score += clamp(leadership.score * 0.18, 0, 18);
  score += clamp(broaderLeadership.score * 0.10, 0, 10);

  if (rebound) score += 10;
  if (w20.fourPlus > 0) score += 8;
  if (w20.exact5 > 0) score += 10;

  score = Math.round(clamp(score, 0, 100));

  let state = 'DORMANT';
  let stateAr = 'جمود';
  let alert = false;
  let alertLevel = 'NONE';

  const strongRotation =
    broaderLeadership.rotationBreadth >= 3 &&
    broaderLeadership.meaningfulCores >= 2;

  const earlyRotation =
    leadership.rotationBreadth >= 2 ||
    leadership.leaderChanged ||
    broaderLeadership.rotationBreadth >= 2;

  const strongLeader = broaderLeadership.currentLeaderCore3;
  const strongLeader20Count = Number(strongLeader?.count || 0);
  const strongLeader10Count = strongLeader
    ? coreCountIn(w10, strongLeader.numbers)
    : 0;
  const strongLeaderPrevious20Count = strongLeader
    ? coreCountIn(previous20, strongLeader.numbers)
    : 0;

  const strongCoreEvidence = Boolean(
    strongLeader &&
    strongLeader20Count >= 2 &&
    strongLeader10Count >= 1 &&
    (
      strongLeaderPrevious20Count >= 1 ||
      strongLeader20Count >= 3
    )
  );

  const strongWaveEvidence =
    w20.threePlus >= 4 &&
    score >= 68 &&
    strongCoreEvidence &&
    (
      strongRotation ||
      w20.fourPlus >= 2
    );

  if (strongWaveEvidence) {
    state = 'STRONG';
    stateAr = 'نشاط قوي';
    alert = true;
    alertLevel = 'HIGH';
  }

  else if (
    rebound &&
    score >= 42
  ) {
    state = 'REBOUND_WATCH';
    stateAr = 'مراقبة عودة النشاط';
    alert = true;
    alertLevel = score >= 70 ? 'HIGH' : 'MEDIUM';
  }

  else if (
    score >= 52 &&
    w20.threePlus >= 2 &&
    earlyRotation
  ) {
    state = 'RISING';
    stateAr = 'النشاط يصعد';
    alert = true;
    alertLevel = 'MEDIUM';
  }

  else if (
    score >= 32 &&
    (
      w20.twoPlus >= 5 ||
      w20.threePlus >= 1
    ) &&
    earlyRotation
  ) {
    state = 'EARLY_SIGNAL';
    stateAr = 'إشارات مبكرة';
    alert = true;
    alertLevel = 'LOW';
  }

  else if (coolingEvidence) {
    state = 'COOLING';
    stateAr = 'دخول فترة تبريد';
  }

  const leaders = w20.numberHits.slice(0, 3);
  const activeCores = broaderLeadership.activeCores;

  return {
    ok: true,
    group,
    state,
    stateAr,
    score,
    alert,
    alertLevel,

    metrics: {
      last10: w10,
      previous10,
      last20: w20,
      previous20,
      last40: w40,

      theoreticalBaseline,
      statisticalSurprise: {
        last20: statistical20,
        last40: statistical40,
        note: 'This measures how unusual the observed 3+ frequency is versus a fixed five-number random baseline. It is not a probability of future success.'
      },

      baseline: {
        draws: baseline.draws,
        averageHits: Number(baseline.averageHits.toFixed(3)),
        twoPlusRate: Number(baseTwo.toFixed(4)),
        threePlusRate: Number(baseThree.toFixed(4)),
        fourPlusRate: Number(baseFour.toFixed(4))
      },

      lifts: {
        twoPlus: Number(twoLift.toFixed(3)),
        threePlus: Number(threeLift.toFixed(3)),
        fourPlus: Number(fourLift.toFixed(3)),
        averageHits: Number(averageLift.toFixed(3))
      },

      shortAcceleration,
      shortAverageAcceleration: Number(shortAverageAcceleration.toFixed(3)),
      coolingEvidence,
      rebound,
      reboundEvidence: {
        shortReturn,
        broaderReturn,
        quietPrevious10,
        quietPrevious20
      },
      strongEvidence: {
        qualified: strongWaveEvidence,
        leaderCore3: strongLeader?.numbers || [],
        leaderLast20Count: strongLeader20Count,
        leaderLast10Count: strongLeader10Count,
        leaderPrevious20Count: strongLeaderPrevious20Count,
        coreEvidence: strongCoreEvidence,
        strongRotation,
        last20ThreePlus: w20.threePlus,
        last20FourPlus: w20.fourPlus,
        minimumScore: 68,
        statistical20Evidence: statistical20.evidence,
        statistical20SurpriseScore: statistical20.surpriseScore,
        statistical20PValue: statistical20.upperTailPValue
      }
    },

    leadership: {
      ...leadership,
      broader20: broaderLeadership
    },

    leaders,
    activeCores,

    messageAr:
      state === 'STRONG'
        ? 'المجموعة داخل موجة قوية مع Core3 قائد مدعوم حديثًا واستمرارية فعلية داخل الخمسة.'
        :
      state === 'REBOUND_WATCH'
        ? 'ظهرت عودة نشاط بعد هدوء، مع انتقال أو اتساع في قيادة ثلاثيات المجموعة.'
        :
      state === 'RISING'
        ? 'النشاط يصعد، لكن شروط STRONG الكاملة لم تتأكد بعد من Core3 قائد واستمرارية كافية.'
        :
      state === 'EARLY_SIGNAL'
        ? 'ظهرت إشارات مبكرة مع بداية دوران القوة داخل المجموعة وتستحق المراقبة.'
        :
      state === 'COOLING'
        ? 'نشاط المجموعة يتراجع مقارنة بالفترة السابقة؛ راقب عودة ثلاثيات جديدة بدل انتظار وقت ثابت.'
        :
        'لا توجد موجة واضحة حاليًا، ويستمر النظام بمراقبة دوران القوة بين ثلاثيات المجموعة.'
  };
}

module.exports = {
  analyzeGroupWave,
  windowStats,
  rotationMetrics,
  theoreticalFiveNumberBaseline,
  surpriseForWindow
};