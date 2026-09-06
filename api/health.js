'use strict';

const { db, californiaNowParts, cycleDateKey, scheduleMode } = require('./lib');
const { runDailyPatternLearner } = require('./group-six');
const { selectFive: persistentSelectFive } = require('../lib/group-five');
const { analyzeGroupWave } = require('../lib/wave-engine');

const WAVE_BACKTEST_CUTOFF = 3298607;
const WAVE_BACKTEST_WINDOW = 250;
const WAVE_BACKTEST_WINDOWS = 3;
const WAVE_FIRST_ANALYSIS = 50;
const WAVE_TRACK = 20;
const WAVE_CYCLES_PER_WINDOW = 10;

const GROUP_FIVE_NAME = 'AUTO Group Five';
const CONTROL_PREFIX = 'AUTO_CONTROL_';
const CORE3_MAX_ACTIVE = 3;
const CORE3_MIN_OCCURRENCES = 10;
const CORE3_MAX_STALE_DRAWS = 25;
const TRACKER_MAX_SETS = 24;

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function drawHas(draw, number) {
  return norm(draw?.numbers).includes(Number(number));
}

function hitCount(draw, numbers) {
  const set = new Set(norm(draw?.numbers));
  return norm(numbers).filter(n => set.has(n)).length;
}

function matchedNumbers(draw, numbers) {
  const set = new Set(norm(draw?.numbers));
  return norm(numbers).filter(n => set.has(n));
}

function avg(values) {
  return values.length ? values.reduce((s, n) => s + n, 0) / values.length : 0;
}

function summarize(values) {
  if (!values.length) return { count: 0, average: null, min: null, max: null };
  return {
    count: values.length,
    average: Number(avg(values).toFixed(2)),
    min: Math.min(...values),
    max: Math.max(...values)
  };
}

function coreStatsFromOccurrences(numbers, occurrences, drawCount) {
  const gaps = [];
  for (let i = 1; i < occurrences.length; i++) {
    gaps.push(occurrences[i].index - occurrences[i - 1].index);
  }
  const meanGap = gaps.length ? avg(gaps) : null;
  const variance = gaps.length > 1
    ? avg(gaps.map(gap => (gap - meanGap) ** 2))
    : 0;
  const deviation = gaps.length ? Math.sqrt(variance) : null;
  const cv = meanGap && deviation != null ? deviation / meanGap : null;
  const recentStart = Math.max(0, drawCount - 20);

  return {
    numbers,
    count: occurrences.length,
    recent20: occurrences.filter(x => x.index >= recentStart).length,
    occurrences,
    gaps,
    meanGap: meanGap == null ? null : Number(meanGap.toFixed(2)),
    consistency: cv == null ? null : Number((1 / (1 + cv)).toFixed(3)),
    last: occurrences.at(-1) || null
  };
}

function occurrenceStatsForSet(draws, setNumbers) {
  const numbers = norm(setNumbers);
  const occurrences = [];
  draws.forEach((draw, index) => {
    if (hitCount(draw, numbers) === numbers.length) {
      occurrences.push({
        index,
        drawId: Number(draw.draw_id),
        time: draw.draw_time || '',
        date: draw.draw_date || '',
        hits: numbers.length,
        matchedNumbers: numbers
      });
    }
  });
  return coreStatsFromOccurrences(numbers, occurrences, draws.length);
}

function occurrenceStatsForThreePlus(draws, setNumbers) {
  const numbers = norm(setNumbers);
  const occurrences = [];
  draws.forEach((draw, index) => {
    const matched = matchedNumbers(draw, numbers);
    if (matched.length >= 3) {
      occurrences.push({
        index,
        drawId: Number(draw.draw_id),
        time: draw.draw_time || '',
        date: draw.draw_date || '',
        hits: matched.length,
        matchedNumbers: matched
      });
    }
  });
  return coreStatsFromOccurrences(numbers, occurrences, draws.length);
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

function discoverDynamicCore3(draws) {
  const map = new Map();
  draws.forEach((draw, index) => {
    const numbers = norm(draw?.numbers);
    if (numbers.length !== 20) return;
    for (let i = 0; i < numbers.length - 2; i++) {
      for (let j = i + 1; j < numbers.length - 1; j++) {
        for (let k = j + 1; k < numbers.length; k++) {
          const core = [numbers[i], numbers[j], numbers[k]];
          const key = core.join('-');
          let item = map.get(key);
          if (!item) {
            item = { numbers: core, occurrences: [] };
            map.set(key, item);
          }
          item.occurrences.push({
            index,
            drawId: Number(draw.draw_id),
            time: draw.draw_time || '',
            date: draw.draw_date || ''
          });
        }
      }
    }
  });

  return [...map.values()]
    .filter(x => x.occurrences.length >= CORE3_MIN_OCCURRENCES)
    .map(x => coreStatsFromOccurrences(x.numbers, x.occurrences, draws.length))
    .sort((a, b) =>
      b.count - a.count ||
      b.recent20 - a.recent20 ||
      Number(b.last?.index ?? -1) - Number(a.last?.index ?? -1) ||
      Number(b.consistency || 0) - Number(a.consistency || 0) ||
      a.numbers.join(',').localeCompare(b.numbers.join(','))
    );
}

function coreSource(core, groupFiveNumbers, learnerNumbers) {
  const sources = [];
  const inSet = set => set.length && core.every(n => set.includes(n));
  if (inSet(groupFiveNumbers)) sources.push('GROUP_FIVE');
  if (inSet(learnerNumbers)) sources.push('12H_LEARNER');
  if (!sources.length) sources.push('LIVE_DATA');
  return sources;
}

function liveDetailFromStats(stat, draws, sources = ['LIVE_DATA']) {
  const latestIndex = draws.length - 1;
  const lastIndex = Number(stat.last?.index ?? -1);
  const currentGap = lastIndex >= 0 ? Math.max(0, latestIndex - lastIndex) : null;
  const meanStep = stat.meanGap == null ? null : Math.max(1, Math.round(stat.meanGap));
  const expectedDrawId = stat.last?.drawId && meanStep
    ? Number(stat.last.drawId) + meanStep
    : null;
  const remainingToAverage = currentGap != null && meanStep
    ? meanStep - currentGap
    : null;
  const latestDrawId = Number(draws.at(-1)?.draw_id || 0) || null;
  const appearedNow = Boolean(stat.last?.drawId && latestDrawId && Number(stat.last.drawId) === latestDrawId);

  return {
    numbers: stat.numbers,
    sources,
    strength: {
      together: stat.count,
      recent20: stat.recent20,
      consistency: stat.consistency
    },
    analysis: {
      together: stat.count,
      recent20: stat.recent20,
      gaps: stat.gaps,
      meanGap: stat.meanGap,
      consistency: stat.consistency,
      lastTogetherDrawId: stat.last?.drawId || null,
      lastTogetherTime: stat.last?.time || '',
      lastHitCount: Number(stat.last?.hits || 0) || null,
      lastMatchedNumbers: norm(stat.last?.matchedNumbers || []),
      occurrences: stat.occurrences.map(x => ({
        drawId: x.drawId,
        time: x.time,
        date: x.date,
        hits: Number(x.hits || 0) || null,
        matchedNumbers: norm(x.matchedNumbers || [])
      }))
    },
    current: {
      appearedNow,
      status: appearedNow ? 'HIT_NOW' : 'WAITING',
      currentGap,
      expectedGap: stat.meanGap,
      meanStep,
      expectedDrawId,
      remainingToAverage,
      latestDrawId,
      lastHitCount: Number(stat.last?.hits || 0) || null,
      lastMatchedNumbers: norm(stat.last?.matchedNumbers || [])
    }
  };
}

function automaticCoreState(detail) {
  if (detail?.current?.appearedNow) return 'HIT_NOW';
  if (detail?.current?.currentGap == null) return 'NO_HISTORY';
  if (detail.current.currentGap > CORE3_MAX_STALE_DRAWS) return 'HISTORICAL_STRONG';
  return 'ACTIVE_STRONG';
}

async function liveDrawContext() {
  const controls = (
    await db(
      `tracker_groups?select=id,name,start_draw_id&name=like.${encodeURIComponent(CONTROL_PREFIX + '*')}&order=id.desc&limit=20`
    )
  ) || [];
  const control = controls.find(r => /^AUTO_CONTROL_\d{4}-\d{2}-\d{2}$/.test(String(r.name || ''))) || null;

  let rawDraws = [];
  if (Number(control?.start_draw_id || 0)) {
    rawDraws = (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers&draw_id=gte.${Number(control.start_draw_id)}&order=draw_id.asc&limit=220`
      )
    ) || [];
  } else {
    rawDraws = (
      await db('hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=180')
    ) || [];
  }

  const draws = rawDraws
    .filter(d => Number.isFinite(Number(d?.draw_id)) && norm(d?.numbers).length === 20)
    .sort((a, b) => Number(a.draw_id) - Number(b.draw_id));

  return { control, draws };
}

async function groupFiveCore3Detail() {
  const { draws } = await liveDrawContext();

  const groupRows = (
    await db(
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&active=eq.true&name=eq.${encodeURIComponent(GROUP_FIVE_NAME)}&order=id.desc&limit=1`
    )
  ) || [];
  const group = groupRows[0] || null;
  const groupFiveNumbers = norm(group?.numbers);
  const groupStartDrawId = Number(group?.start_draw_id || 0);

  let learner = null;
  try { learner = await runDailyPatternLearner(); } catch { learner = null; }
  const learnerNumbers = norm(learner?.suggestion?.numbers || []);

  if (draws.length < 20) {
    return {
      ok: true,
      active: false,
      dynamic: true,
      groupFive: { numbers: groupFiveNumbers, startDrawId: groupStartDrawId || null },
      learner: { numbers: learnerNumbers },
      have: draws.length,
      need: 20,
      core3: null,
      activeCore3: [],
      historicalStrongCore3: []
    };
  }

  const ranked = discoverDynamicCore3(draws);
  const qualified = ranked.map(stat => {
    const detail = liveDetailFromStats(
      stat,
      draws,
      coreSource(stat.numbers, groupFiveNumbers, learnerNumbers)
    );
    return {
      ...detail,
      autoState: automaticCoreState(detail),
      qualifies: true,
      qualification: {
        minimumTogether: CORE3_MIN_OCCURRENCES,
        actualTogether: stat.count,
        maxActiveGap: CORE3_MAX_STALE_DRAWS
      }
    };
  });

  const activeStrongCore3 = qualified
    .filter(x => x.autoState === 'ACTIVE_STRONG' || x.autoState === 'HIT_NOW')
    .slice(0, CORE3_MAX_ACTIVE);

  const historicalStrongCore3 = qualified
    .filter(x => x.autoState === 'HISTORICAL_STRONG')
    .slice(0, TRACKER_MAX_SETS);

  return {
    ok: true,
    active: Boolean(activeStrongCore3[0]),
    dynamic: true,
    analysisWindow: draws.length,
    latestDrawId: Number(draws.at(-1)?.draw_id || 0) || null,
    rules: {
      minimumJointAppearances: CORE3_MIN_OCCURRENCES,
      maxGapForActiveStrong: CORE3_MAX_STALE_DRAWS,
      noRandomSelection: true
    },
    groupFive: {
      numbers: groupFiveNumbers,
      startDrawId: groupStartDrawId || null,
      active: Boolean(group)
    },
    learner: {
      numbers: learnerNumbers,
      active: Boolean(learner?.active)
    },
    core3: activeStrongCore3[0] || null,
    activeCore3: activeStrongCore3,
    historicalStrongCore3,
    qualifiedStrongCount: qualified.length,
    selectionRule:
      'Automatic Core3 candidates must have appeared together at least 10 times in collected data. Candidates with more than 25 draws since the last 3/3 appearance leave Active Strong and remain in Historical Strong. No low-count candidate is promoted as strong.',
    candidatesEvaluated: qualified.length
  };
}

function parseTrackerSets(raw) {
  const text = Array.isArray(raw) ? raw.join(';') : String(raw || '');
  const out = [];
  const seen = new Set();

  for (const part of text.split(';')) {
    if (out.length >= TRACKER_MAX_SETS) break;
    const numbers = norm(String(part).split(/[^0-9]+/).filter(Boolean));
    if (numbers.length < 3 || numbers.length > 5) continue;
    const key = numbers.join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(numbers);
  }
  return out;
}

function evaluateTrackedSet(draws, numbers) {
  const fullStats = occurrenceStatsForSet(draws, numbers);
  const full = liveDetailFromStats(fullStats, draws, ['MANUAL_FULL_SET']);

  const threePlusStats = numbers.length === 3
    ? fullStats
    : occurrenceStatsForThreePlus(draws, numbers);
  const threePlus = liveDetailFromStats(threePlusStats, draws, ['MANUAL_ANY_3_PLUS']);

  let strongestCore3 = null;
  if (numbers.length >= 3) {
    const rankedCore3 = combinations3(numbers)
      .map(core => occurrenceStatsForSet(draws, core))
      .sort((a, b) =>
        b.count - a.count ||
        b.recent20 - a.recent20 ||
        Number(b.last?.index ?? -1) - Number(a.last?.index ?? -1) ||
        Number(b.consistency || 0) - Number(a.consistency || 0)
      );
    strongestCore3 = rankedCore3[0]
      ? liveDetailFromStats(rankedCore3[0], draws, ['STRONGEST_INTERNAL_CORE3'])
      : null;
  }

  return {
    numbers,
    type: numbers.length === 3 ? 'CORE3' : 'MANUAL_GROUP_3_PLUS',
    trackingMode: 'ANY_3_PLUS',
    hitRule: 'Any draw containing 3, 4, or 5 numbers from the tracked set counts as a cycle hit.',
    fullSet: full,
    threePlus,
    core3: threePlus,
    strongestCore3,
    rating: {
      together: threePlus.strength.together,
      recent20: threePlus.strength.recent20,
      consistency: threePlus.strength.consistency
    }
  };
}

async function trackerEvaluate(rawSets) {
  const sets = parseTrackerSets(rawSets);
  if (!sets.length) {
    return {
      ok: false,
      reason: 'no-valid-sets',
      message: 'Send 3 to 5 numbers per set, separated by semicolons.'
    };
  }

  const { draws } = await liveDrawContext();
  if (!draws.length) {
    return { ok: false, reason: 'no-draws' };
  }

  return {
    ok: true,
    latestDrawId: Number(draws.at(-1)?.draw_id || 0) || null,
    latestTime: draws.at(-1)?.draw_time || '',
    analysisWindow: draws.length,
    trackers: sets.map(numbers => evaluateTrackedSet(draws, numbers))
  };
}

function collectRuns(records) {
  const runs = [];
  for (const cycle of records) {
    let current = null;
    for (const row of cycle.timeline) {
      if (!current || current.state !== row.state) {
        if (current) runs.push(current);
        current = {
          window: cycle.window,
          cycle: cycle.cycle,
          numbers: cycle.numbers,
          state: row.state,
          startOffset: row.offset,
          endOffset: row.offset,
          length: 1
        };
      } else {
        current.endOffset = row.offset;
        current.length++;
      }
    }
    if (current) runs.push(current);
  }
  return runs;
}

function transitionStats(records) {
  const earlyToStrong = [];
  const risingToStrong = [];
  const strongToCooling = [];
  const strongToRebound = [];
  for (const cycle of records) {
    const t = cycle.timeline;
    for (let i = 0; i < t.length; i++) {
      if (t[i].state === 'EARLY_SIGNAL' || t[i].state === 'RISING') {
        const j = t.findIndex((r, idx) => idx > i && r.state === 'STRONG');
        if (j > i) {
          if (t[i].state === 'EARLY_SIGNAL') earlyToStrong.push(j - i);
          if (t[i].state === 'RISING') risingToStrong.push(j - i);
        }
      }
      if (t[i].state === 'STRONG') {
        const coolingIndex = t.findIndex((r, idx) => idx > i && r.state === 'COOLING');
        const reboundIndex = t.findIndex((r, idx) => idx > i && r.state === 'REBOUND_WATCH');
        if (coolingIndex > i) strongToCooling.push(coolingIndex - i);
        if (reboundIndex > i) strongToRebound.push(reboundIndex - i);
      }
    }
  }
  return {
    earlyToStrong: summarize(earlyToStrong),
    risingToStrong: summarize(risingToStrong),
    strongToCooling: summarize(strongToCooling),
    strongToRebound: summarize(strongToRebound)
  };
}

function statePerformance(records) {
  const map = new Map();
  for (const cycle of records) {
    for (const row of cycle.timeline) {
      const old = map.get(row.state) || {
        observations: 0,
        hitsTotal: 0,
        threePlus: 0,
        fourPlus: 0,
        exact5: 0
      };
      old.observations++;
      old.hitsTotal += row.nextHit;
      if (row.nextHit >= 3) old.threePlus++;
      if (row.nextHit >= 4) old.fourPlus++;
      if (row.nextHit === 5) old.exact5++;
      map.set(row.state, old);
    }
  }
  return Object.fromEntries([...map.entries()].map(([state, s]) => [state, {
    observations: s.observations,
    averageNextHit: Number((s.hitsTotal / s.observations).toFixed(3)),
    threePlus: s.threePlus,
    fourPlus: s.fourPlus,
    exact5: s.exact5,
    threePlusRate: Number((s.threePlus / s.observations).toFixed(4)),
    fourPlusRate: Number((s.fourPlus / s.observations).toFixed(4)),
    exact5Rate: Number((s.exact5 / s.observations).toFixed(4))
  }]));
}

async function waveCycleBacktest() {
  const rows = (
    await db(
      `hotspot_draws?select=draw_id,draw_date,draw_time,numbers&draw_id=lte.${WAVE_BACKTEST_CUTOFF}&order=draw_id.desc&limit=${WAVE_BACKTEST_WINDOW * WAVE_BACKTEST_WINDOWS}`
    )
  ) || [];

  const draws = rows
    .filter(d => Number.isFinite(Number(d?.draw_id)) && norm(d?.numbers).length === 20)
    .sort((a, b) => Number(a.draw_id) - Number(b.draw_id));

  if (draws.length < WAVE_BACKTEST_WINDOW * WAVE_BACKTEST_WINDOWS) {
    return {
      ok: false,
      reason: 'not-enough-historical-draws',
      have: draws.length,
      need: WAVE_BACKTEST_WINDOW * WAVE_BACKTEST_WINDOWS
    };
  }

  const cycles = [];
  for (let w = 0; w < WAVE_BACKTEST_WINDOWS; w++) {
    const window = draws.slice(w * WAVE_BACKTEST_WINDOW, (w + 1) * WAVE_BACKTEST_WINDOW);
    for (let c = 0; c < WAVE_CYCLES_PER_WINDOW; c++) {
      const analysisSize = WAVE_FIRST_ANALYSIS + c * WAVE_TRACK;
      const analysis = window.slice(0, analysisSize);
      const future = window.slice(analysisSize, analysisSize + WAVE_TRACK);
      if (future.length < WAVE_TRACK) continue;

      const selected = persistentSelectFive(analysis);
      const numbers = norm(selected?.numbers || selected);
      if (numbers.length !== 5) continue;

      const timeline = [];
      for (let i = 0; i < future.length; i++) {
        const known = [...analysis, ...future.slice(0, i)];
        const wave = analyzeGroupWave(known, numbers);
        timeline.push({
          offset: i + 1,
          beforeDrawId: Number(future[i].draw_id),
          state: wave?.state || 'DORMANT',
          score: Number(wave?.score || 0),
          nextHit: hitCount(future[i], numbers)
        });
      }
      cycles.push({ window: w + 1, cycle: c + 1, analysisDraws: analysisSize, numbers, timeline });
    }
  }

  const runs = collectRuns(cycles);
  const states = ['DORMANT', 'EARLY_SIGNAL', 'RISING', 'STRONG', 'COOLING', 'REBOUND_WATCH'];
  const durationByState = Object.fromEntries(states.map(state => [state,
    summarize(runs.filter(r => r.state === state).map(r => r.length))
  ]));

  return {
    ok: true,
    test: 'Historical Wave Cycle Backtest',
    noFutureLeakage: true,
    rules: {
      fixedCutoffDrawId: WAVE_BACKTEST_CUTOFF,
      windows: WAVE_BACKTEST_WINDOWS,
      drawsPerWindow: WAVE_BACKTEST_WINDOW,
      cyclesPerWindow: WAVE_CYCLES_PER_WINDOW,
      trackingDrawsPerCycle: WAVE_TRACK,
      totalCycles: cycles.length,
      totalEvaluatedDraws: cycles.reduce((s, c) => s + c.timeline.length, 0),
      selector: 'Persistent Core3 Group Five selector',
      waveStateComputed: 'Before each evaluated future draw using only prior known draws'
    },
    durationByState,
    transitions: transitionStats(cycles),
    nextDrawPerformanceByState: statePerformance(cycles),
    strongRuns: runs.filter(r => r.state === 'STRONG').map(r => ({
      window: r.window,
      cycle: r.cycle,
      numbers: r.numbers,
      startOffset: r.startOffset,
      endOffset: r.endOffset,
      length: r.length
    })),
    sampleCycles: cycles.slice(0, 6)
  };
}

async function learnerWaveDetail() {
  const learner = await runDailyPatternLearner();
  const numbers = norm(learner?.suggestion?.numbers || []);

  if (!learner?.ok || !learner?.active || numbers.length !== 5 || !Number(learner?.controlStartDrawId)) {
    return {
      ok: true,
      active: false,
      numbers,
      have: Number(learner?.have || 0),
      state: learner?.wave?.state || null,
      message: 'Learner wave details are not ready yet.'
    };
  }

  const rows = (
    await db(
      `hotspot_draws?select=draw_id,draw_date,draw_time,numbers&draw_id=gte.${Number(learner.controlStartDrawId)}&order=draw_id.asc&limit=500`
    )
  ) || [];

  const draws = rows
    .filter(d => Number.isFinite(Number(d?.draw_id)) && norm(d?.numbers).length === 20)
    .slice(0, Number(learner.have || 0));
  const latest = draws.at(-1) || null;
  const recent40 = draws.slice(-40);

  const numberStats = numbers.map(number => {
    const appearances = draws.filter(d => drawHas(d, number));
    const recentAppearances = recent40.filter(d => drawHas(d, number));
    const last = appearances.at(-1) || null;
    const lastIndex = last
      ? draws.findLastIndex(d => Number(d.draw_id) === Number(last.draw_id))
      : -1;
    return {
      number,
      count: appearances.length,
      recent40: recentAppearances.length,
      lastDrawId: last ? Number(last.draw_id) : null,
      lastTime: last?.draw_time || '',
      lastDate: last?.draw_date || '',
      drawsSinceLast: lastIndex >= 0 ? Math.max(0, draws.length - 1 - lastIndex) : null
    };
  });

  const last20 = learner?.wave?.metrics?.last20 || {};
  const last10 = learner?.wave?.metrics?.last10 || {};

  return {
    ok: true,
    active: true,
    have: Number(learner.have || draws.length),
    latestDrawId: latest ? Number(latest.draw_id) : null,
    latestTime: latest?.draw_time || '',
    numbers,
    wave: {
      state: learner?.wave?.state || 'DORMANT',
      stateAr: learner?.wave?.stateAr || '',
      score: Number(learner?.wave?.score || 0),
      alertLevel: learner?.wave?.alertLevel || 'NONE'
    },
    numberStats,
    comparison: {
      last10: {
        draws: Number(last10.draws || 0),
        threePlus: Number(last10.threePlus || 0),
        fourPlus: Number(last10.fourPlus || 0),
        exact5: Number(last10.exact5 || 0)
      },
      last20: {
        draws: Number(last20.draws || 0),
        threePlus: Number(last20.threePlus || 0),
        fourPlus: Number(last20.fourPlus || 0),
        exact5: Number(last20.exact5 || 0)
      }
    },
    compact: true
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store,max-age=0');

  try {
    const mode = String(req.query?.mode || '').trim().toLowerCase();

    if (mode === 'learner-wave-detail') {
      return res.status(200).json(await learnerWaveDetail());
    }

    if (mode === 'group-five-core3') {
      const detail = await groupFiveCore3Detail();
      return res.status(detail.ok ? 200 : 400).json(detail);
    }

    if (mode === 'tracker-evaluate') {
      const result = await trackerEvaluate(req.query?.sets || req.query?.numbers || '');
      return res.status(result.ok ? 200 : 400).json(result);
    }

    if (mode === 'wave-cycle-backtest') {
      const result = await waveCycleBacktest();
      return res.status(result.ok ? 200 : 400).json(result);
    }

    const now = californiaNowParts();
    return res.status(200).json({
      ok: true,
      version: require('../package.json').version,
      californiaTime: `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`,
      cycle: cycleDateKey(now),
      mode: scheduleMode(now.minutes),
      configured: {
        supabaseUrl: Boolean(process.env.SUPABASE_URL),
        supabaseKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
        workerSecret: Boolean(process.env.WORKER_SECRET)
      },
      collectionDraws: 180,
      source: 'California Lottery official'
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
