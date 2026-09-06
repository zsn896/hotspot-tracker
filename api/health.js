'use strict';

const {
  db,
  californiaNowParts,
  cycleDateKey,
  scheduleMode
} = require('./lib');

const {
  runDailyPatternLearner
} = require('./group-six');

const {
  selectFive: persistentSelectFive
} = require('../lib/group-five');

const {
  analyzeGroupWave
} = require('../lib/wave-engine');

const WAVE_BACKTEST_CUTOFF = 3298607;
const WAVE_BACKTEST_WINDOW = 250;
const WAVE_BACKTEST_WINDOWS = 3;
const WAVE_FIRST_ANALYSIS = 50;
const WAVE_TRACK = 20;
const WAVE_CYCLES_PER_WINDOW = 10;

const GROUP_FIVE_NAME = 'AUTO Group Five';
const CONTROL_PREFIX = 'AUTO_CONTROL_';
const GROUP_FIVE_FIRST_ANALYSIS_DRAWS = 50;

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(
      n =>
        Number.isInteger(n) &&
        n >= 1 &&
        n <= 80
    )
    .sort((a, b) => a - b);
}

function drawHas(draw, number) {
  return norm(draw?.numbers)
    .includes(Number(number));
}

function hitCount(draw, numbers) {
  const set = new Set(norm(draw?.numbers));
  return norm(numbers).filter(n => set.has(n)).length;
}

function avg(values) {
  return values.length
    ? values.reduce((s, n) => s + n, 0) / values.length
    : 0;
}

function summarize(values) {
  if (!values.length) {
    return {
      count: 0,
      average: null,
      min: null,
      max: null
    };
  }

  return {
    count: values.length,
    average: Number(avg(values).toFixed(2)),
    min: Math.min(...values),
    max: Math.max(...values)
  };
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

function coreOccurrenceStats(draws, core) {
  const occurrences = [];

  draws.forEach((draw, index) => {
    if (hitCount(draw, core) === 3) {
      occurrences.push({
        index,
        drawId: Number(draw.draw_id),
        time: draw.draw_time || '',
        date: draw.draw_date || ''
      });
    }
  });

  const gaps = [];

  for (let i = 1; i < occurrences.length; i++) {
    gaps.push(
      occurrences[i].index -
      occurrences[i - 1].index
    );
  }

  const meanGap =
    gaps.length
      ? avg(gaps)
      : null;

  const variance =
    gaps.length > 1
      ? avg(
          gaps.map(
            gap =>
              (gap - meanGap) ** 2
          )
        )
      : 0;

  const deviation =
    gaps.length
      ? Math.sqrt(variance)
      : null;

  const cv =
    meanGap && deviation != null
      ? deviation / meanGap
      : null;

  return {
    numbers: core,
    count: occurrences.length,
    occurrences,
    gaps,
    meanGap:
      meanGap == null
        ? null
        : Number(meanGap.toFixed(2)),
    consistency:
      cv == null
        ? null
        : Number((1 / (1 + cv)).toFixed(3)),
    last:
      occurrences.at(-1) || null
  };
}

function strongestCore3(draws, fiveNumbers) {
  const cores =
    combinations3(fiveNumbers)
      .map(core => coreOccurrenceStats(draws, core))
      .sort(
        (a, b) =>
          b.count - a.count ||
          Number(b.last?.index ?? -1) -
            Number(a.last?.index ?? -1) ||
          Number(b.consistency || 0) -
            Number(a.consistency || 0) ||
          a.numbers.join(',').localeCompare(
            b.numbers.join(',')
          )
      );

  return {
    leader: cores[0] || null,
    ranked: cores
  };
}

function trackedCoreStats(rows, core) {
  const occurrences = [];
  let twoOfThree = 0;

  rows.forEach((row, index) => {
    const hits = norm(row?.hit_numbers);
    const count =
      core.filter(n => hits.includes(n)).length;

    if (count === 3) {
      occurrences.push({
        index,
        drawId: Number(row.draw_id),
        time: row.time || '',
        date: row.date || ''
      });
    } else if (count === 2) {
      twoOfThree++;
    }
  });

  return {
    trackedDraws: rows.length,
    together3: occurrences.length,
    partial2: twoOfThree,
    occurrences,
    last:
      occurrences.at(-1) || null
  };
}

function currentCoreStatus(
  analysisStats,
  trackedStats,
  analysisDrawCount
) {
  if (!analysisStats || analysisStats.count < 2) {
    return {
      state: 'INSUFFICIENT',
      currentGap: null,
      expectedGap: analysisStats?.meanGap ?? null,
      messageAr:
        'لا توجد اجتماعات كافية لهذا الثلاثي للحكم على دورة تكراره.'
    };
  }

  const lastAnalysisIndex =
    analysisStats.last?.index ?? -1;

  const lastTrackedIndex =
    trackedStats.last?.index ?? -1;

  const currentIndex =
    analysisDrawCount +
    trackedStats.trackedDraws - 1;

  const lastTogetherIndex =
    lastTrackedIndex >= 0
      ? analysisDrawCount + lastTrackedIndex
      : lastAnalysisIndex;

  const currentGap =
    Math.max(
      0,
      currentIndex - lastTogetherIndex
    );

  const expectedGap =
    Number(analysisStats.meanGap || 0);

  let state = 'ACTIVE';
  let messageAr =
    'الثلاثي ما زال ضمن نمط الفاصل التاريخي تقريبًا.';

  if (
    expectedGap > 0 &&
    currentGap > expectedGap * 1.75
  ) {
    state = 'COOLING';
    messageAr =
      'مر وقت أطول بوضوح من متوسط فاصل ظهور الثلاثي؛ التجمع يبرد حاليًا.';
  } else if (
    expectedGap > 0 &&
    currentGap > expectedGap * 1.25
  ) {
    state = 'WATCH';
    messageAr =
      'الثلاثي تجاوز متوسط فاصل ظهوره قليلًا ويحتاج مراقبة السحبات القادمة.';
  }

  return {
    state,
    currentGap,
    expectedGap:
      expectedGap || null,
    messageAr
  };
}

async function groupFiveCore3Detail() {
  const groups =
    (
      await db(
        `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&active=eq.true&name=eq.${encodeURIComponent(
          GROUP_FIVE_NAME
        )}&order=id.desc&limit=1`
      )
    ) || [];

  const group = groups[0] || null;
  const numbers = norm(group?.numbers);

  if (!group || numbers.length !== 5) {
    return {
      ok: true,
      active: false,
      numbers,
      message:
        'Group Five is not active.'
    };
  }

  const controls =
    (
      await db(
        `tracker_groups?select=id,name,start_draw_id&name=like.${encodeURIComponent(
          CONTROL_PREFIX + '*'
        )}&order=id.desc&limit=20`
      )
    ) || [];

  const control =
    controls.find(
      r =>
        /^AUTO_CONTROL_\d{4}-\d{2}-\d{2}$/.test(
          String(r.name || '')
        )
    ) || null;

  const groupStart =
    Number(group.start_draw_id || 0);

  const controlStart =
    Number(control?.start_draw_id || 0);

  const analysisWindow =
    controlStart && groupStart >= controlStart
      ? Math.max(
          GROUP_FIVE_FIRST_ANALYSIS_DRAWS,
          groupStart - controlStart + 1
        )
      : GROUP_FIVE_FIRST_ANALYSIS_DRAWS;

  const analysisRows =
    (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers&draw_id=lte.${groupStart}&order=draw_id.desc&limit=${analysisWindow}`
      )
    ) || [];

  const analysisDraws =
    analysisRows
      .filter(
        d =>
          Number.isFinite(Number(d?.draw_id)) &&
          norm(d?.numbers).length === 20
      )
      .sort(
        (a, b) =>
          Number(a.draw_id) -
          Number(b.draw_id)
      );

  const coreResult =
    strongestCore3(
      analysisDraws,
      numbers
    );

  const leader =
    coreResult.leader;

  if (!leader || leader.numbers.length !== 3) {
    return {
      ok: true,
      active: true,
      numbers,
      analysisWindow,
      core3: null,
      message:
        'No valid Core3 found.'
    };
  }

  let trackingRows =
    (
      await db(
        `tracker_results?select=draw_id,hit_count,hit_numbers,created_at&group_id=eq.${Number(
          group.id
        )}&order=draw_id.asc&limit=200`
      )
    ) || [];

  const ids =
    trackingRows.map(r => Number(r.draw_id))
      .filter(Number.isFinite);

  let meta = {};

  if (ids.length) {
    const drawMeta =
      (
        await db(
          `hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=in.(${ids.join(
            ','
          )})`
        )
      ) || [];

    meta =
      Object.fromEntries(
        drawMeta.map(
          d => [
            Number(d.draw_id),
            d
          ]
        )
      );
  }

  trackingRows =
    trackingRows.map(
      row => ({
        ...row,
        date:
          meta[Number(row.draw_id)]
            ?.draw_date || '',
        time:
          meta[Number(row.draw_id)]
            ?.draw_time || ''
      })
    );

  const tracked =
    trackedCoreStats(
      trackingRows,
      leader.numbers
    );

  const current =
    currentCoreStatus(
      leader,
      tracked,
      analysisDraws.length
    );

  return {
    ok: true,
    active: true,
    groupFive: {
      numbers,
      startDrawId: groupStart,
      analysisWindow:
        analysisDraws.length,
      trackedDraws:
        trackingRows.length
    },
    core3: {
      numbers:
        leader.numbers,
      analysis: {
        together:
          leader.count,
        gaps:
          leader.gaps,
        meanGap:
          leader.meanGap,
        consistency:
          leader.consistency,
        lastTogetherDrawId:
          leader.last?.drawId || null,
        lastTogetherTime:
          leader.last?.time || '',
        occurrences:
          leader.occurrences.map(
            x => ({
              drawId: x.drawId,
              time: x.time,
              date: x.date
            })
          )
      },
      sinceSelection: {
        together:
          tracked.together3,
        partial2:
          tracked.partial2,
        lastTogetherDrawId:
          tracked.last?.drawId || null,
        lastTogetherTime:
          tracked.last?.time || '',
        occurrences:
          tracked.occurrences.map(
            x => ({
              drawId: x.drawId,
              time: x.time,
              date: x.date
            })
          )
      },
      current
    },
    selectionRule:
      'Among the 10 possible Core3 combinations inside Group Five, choose the triplet with the most joint appearances during the analysis window; ties prefer the most recent, then the most consistent.',
    topCore3:
      coreResult.ranked
        .slice(0, 3)
        .map(
          x => ({
            numbers: x.numbers,
            together: x.count,
            meanGap: x.meanGap,
            consistency: x.consistency,
            lastTogetherDrawId:
              x.last?.drawId || null
          })
        )
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
      if (t[i].state === 'STRONG') continue;

      if (
        t[i].state === 'EARLY_SIGNAL' ||
        t[i].state === 'RISING'
      ) {
        const j = t.findIndex(
          (r, idx) => idx > i && r.state === 'STRONG'
        );

        if (j > i) {
          const lag = j - i;
          if (t[i].state === 'EARLY_SIGNAL') earlyToStrong.push(lag);
          if (t[i].state === 'RISING') risingToStrong.push(lag);
        }
      }
    }

    for (let i = 0; i < t.length; i++) {
      if (t[i].state !== 'STRONG') continue;

      const coolingIndex = t.findIndex(
        (r, idx) => idx > i && r.state === 'COOLING'
      );

      const reboundIndex = t.findIndex(
        (r, idx) => idx > i && r.state === 'REBOUND_WATCH'
      );

      if (coolingIndex > i) strongToCooling.push(coolingIndex - i);
      if (reboundIndex > i) strongToRebound.push(reboundIndex - i);
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

  return Object.fromEntries(
    [...map.entries()].map(([state, s]) => [
      state,
      {
        observations: s.observations,
        averageNextHit: Number((s.hitsTotal / s.observations).toFixed(3)),
        threePlus: s.threePlus,
        fourPlus: s.fourPlus,
        exact5: s.exact5,
        threePlusRate: Number((s.threePlus / s.observations).toFixed(4)),
        fourPlusRate: Number((s.fourPlus / s.observations).toFixed(4)),
        exact5Rate: Number((s.exact5 / s.observations).toFixed(4))
      }
    ])
  );
}

async function waveCycleBacktest() {
  const rows = (
    await db(
      `hotspot_draws?select=draw_id,draw_date,draw_time,numbers&draw_id=lte.${WAVE_BACKTEST_CUTOFF}&order=draw_id.desc&limit=${WAVE_BACKTEST_WINDOW * WAVE_BACKTEST_WINDOWS}`
    )
  ) || [];

  const draws = rows
    .filter(
      d =>
        Number.isFinite(Number(d?.draw_id)) &&
        norm(d?.numbers).length === 20
    )
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
    const window = draws.slice(
      w * WAVE_BACKTEST_WINDOW,
      (w + 1) * WAVE_BACKTEST_WINDOW
    );

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
        const known = [
          ...analysis,
          ...future.slice(0, i)
        ];

        const wave = analyzeGroupWave(known, numbers);
        const nextDraw = future[i];

        timeline.push({
          offset: i + 1,
          beforeDrawId: Number(nextDraw.draw_id),
          state: wave?.state || 'DORMANT',
          score: Number(wave?.score || 0),
          nextHit: hitCount(nextDraw, numbers)
        });
      }

      cycles.push({
        window: w + 1,
        cycle: c + 1,
        analysisDraws: analysisSize,
        numbers,
        timeline
      });
    }
  }

  const runs = collectRuns(cycles);
  const states = [
    'DORMANT',
    'EARLY_SIGNAL',
    'RISING',
    'STRONG',
    'COOLING',
    'REBOUND_WATCH'
  ];

  const durationByState = Object.fromEntries(
    states.map(state => [
      state,
      summarize(
        runs
          .filter(r => r.state === state)
          .map(r => r.length)
      )
    ])
  );

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
    strongRuns: runs
      .filter(r => r.state === 'STRONG')
      .map(r => ({
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
  const learner =
    await runDailyPatternLearner();

  const numbers =
    norm(
      learner?.suggestion?.numbers || []
    );

  if (
    !learner?.ok ||
    !learner?.active ||
    numbers.length !== 5 ||
    !Number(
      learner?.controlStartDrawId
    )
  ) {
    return {
      ok: true,
      active: false,
      numbers,
      have:
        Number(learner?.have || 0),
      state:
        learner?.wave?.state || null,
      message:
        'Learner wave details are not ready yet.'
    };
  }

  const rows =
    (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers&draw_id=gte.${Number(
          learner.controlStartDrawId
        )}&order=draw_id.asc&limit=500`
      )
    ) || [];

  const draws = rows
    .filter(
      d =>
        Number.isFinite(
          Number(d?.draw_id)
        ) &&
        norm(d?.numbers).length === 20
    )
    .slice(
      0,
      Number(learner.have || 0)
    );

  const latest =
    draws.at(-1) || null;

  const recent40 =
    draws.slice(-40);

  const numberStats =
    numbers.map(number => {
      const appearances =
        draws.filter(
          d =>
            drawHas(d, number)
        );

      const recentAppearances =
        recent40.filter(
          d =>
            drawHas(d, number)
        );

      const last =
        appearances.at(-1) || null;

      const lastIndex =
        last
          ? draws.findLastIndex(
              d =>
                Number(d.draw_id) ===
                Number(last.draw_id)
            )
          : -1;

      return {
        number,
        count:
          appearances.length,
        recent40:
          recentAppearances.length,
        lastDrawId:
          last
            ? Number(last.draw_id)
            : null,
        lastTime:
          last?.draw_time || '',
        lastDate:
          last?.draw_date || '',
        drawsSinceLast:
          lastIndex >= 0
            ? Math.max(
                0,
                draws.length -
                1 -
                lastIndex
              )
            : null
      };
    });

  const last20 =
    learner?.wave?.metrics?.last20 || {};

  const last10 =
    learner?.wave?.metrics?.last10 || {};

  return {
    ok: true,
    active: true,
    have:
      Number(
        learner.have ||
        draws.length
      ),
    latestDrawId:
      latest
        ? Number(latest.draw_id)
        : null,
    latestTime:
      latest?.draw_time || '',
    numbers,
    wave: {
      state:
        learner?.wave?.state ||
        'DORMANT',
      stateAr:
        learner?.wave?.stateAr || '',
      score:
        Number(
          learner?.wave?.score || 0
        ),
      alertLevel:
        learner?.wave?.alertLevel ||
        'NONE'
    },
    numberStats,
    comparison: {
      last10: {
        draws:
          Number(last10.draws || 0),
        threePlus:
          Number(last10.threePlus || 0),
        fourPlus:
          Number(last10.fourPlus || 0),
        exact5:
          Number(last10.exact5 || 0)
      },
      last20: {
        draws:
          Number(last20.draws || 0),
        threePlus:
          Number(last20.threePlus || 0),
        fourPlus:
          Number(last20.fourPlus || 0),
        exact5:
          Number(last20.exact5 || 0)
      }
    },
    compact: true
  };
}

module.exports = async (req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );

  try {
    const mode =
      String(
        req.query?.mode || ''
      )
        .trim()
        .toLowerCase();

    if (
      mode ===
      'learner-wave-detail'
    ) {
      const detail =
        await learnerWaveDetail();

      return res
        .status(200)
        .json(detail);
    }

    if (
      mode ===
      'group-five-core3'
    ) {
      const detail =
        await groupFiveCore3Detail();

      return res
        .status(detail.ok ? 200 : 400)
        .json(detail);
    }

    if (
      mode ===
      'wave-cycle-backtest'
    ) {
      const result =
        await waveCycleBacktest();

      return res
        .status(result.ok ? 200 : 400)
        .json(result);
    }

    const now =
      californiaNowParts();

    return res.status(200).json({
      ok: true,

      version:
        require('../package.json')
          .version,

      californiaTime:
        `${String(now.hour).padStart(2, '0')}:` +
        `${String(now.minute).padStart(2, '0')}`,

      cycle:
        cycleDateKey(now),

      mode:
        scheduleMode(
          now.minutes
        ),

      configured: {
        supabaseUrl:
          Boolean(
            process.env.SUPABASE_URL
          ),

        supabaseKey:
          Boolean(
            process.env
              .SUPABASE_SERVICE_ROLE_KEY
          ),

        workerSecret:
          Boolean(
            process.env.WORKER_SECRET
          )
      },

      collectionDraws: 180,

      source:
        'California Lottery official'
    });

  } catch (e) {

    return res
      .status(500)
      .json({
        ok: false,
        error:
          e.message ||
          String(e)
      });
  }
};
