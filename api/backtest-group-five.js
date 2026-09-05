'use strict';

const { db } = require('./lib');
const { selectFive: persistentSelectFive } = require('../lib/group-five');

const FIXED_CUTOFF_DRAW_ID = 3298607;
const WINDOW_SIZE = 250;
const WINDOW_COUNT = 4;
const FIRST_ANALYSIS = 50;
const TRACK_DRAWS = 20;
const CYCLES_PER_WINDOW = 10;

const RECENT_WINDOW = 15;
const TOP_CORES = 70;
const TOP_COMPANIONS = 12;
const MIN_CORE_OCCURRENCES = 2;

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

function combinations(values, size, fn) {
  const a = norm(values);

  function walk(start, picked) {
    if (picked.length === size) {
      fn([...picked]);
      return;
    }

    for (
      let i = start;
      i <= a.length - (size - picked.length);
      i++
    ) {
      picked.push(a[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  }

  walk(0, []);
}

function combos2(values, fn) {
  combinations(values, 2, fn);
}

function combos3(values, fn) {
  combinations(values, 3, fn);
}

function mean(values) {
  return values.length
    ? values.reduce((sum, n) => sum + n, 0) / values.length
    : 0;
}

function stdDev(values) {
  if (values.length < 2) {
    return 0;
  }

  const avg = mean(values);

  return Math.sqrt(
    mean(
      values.map(
        n =>
          (n - avg) ** 2
      )
    )
  );
}

function recencyWeight(index, total) {
  if (total <= 1) {
    return 1;
  }

  return 1 + index / (total - 1);
}

function hitCount(draw, numbers) {
  const set =
    new Set(
      norm(
        draw?.numbers
      )
    );

  let count = 0;

  for (const n of numbers) {
    if (set.has(Number(n))) {
      count++;
    }
  }

  return count;
}


/* =========================================================
   LEGACY SELECTOR
========================================================= */

function buildCoreMap(window) {
  const coreMap =
    new Map();

  for (
    let drawIndex = 0;
    drawIndex < window.length;
    drawIndex++
  ) {
    const numbers =
      norm(
        window[drawIndex]?.numbers
      );

    const weight =
      recencyWeight(
        drawIndex,
        window.length
      );

    combos3(
      numbers,
      core => {
        const key =
          core.join(',');

        const old =
          coreMap.get(key)
          ||
          {
            core,
            count: 0,
            weightedCount: 0,
            lastIndex: -1,
            drawIndexes: []
          };

        old.count++;
        old.weightedCount += weight;
        old.lastIndex = drawIndex;
        old.drawIndexes.push(drawIndex);

        coreMap.set(
          key,
          old
        );
      }
    );
  }

  return coreMap;
}

function topCores(window) {
  return [
    ...buildCoreMap(window).values()
  ]
    .filter(
      x =>
        x.count >=
        MIN_CORE_OCCURRENCES
    )
    .sort(
      (a, b) =>
        b.count -
        a.count

        ||

        b.weightedCount -
        a.weightedCount

        ||

        b.lastIndex -
        a.lastIndex
    )
    .slice(
      0,
      TOP_CORES
    );
}

function companionsForCore(
  window,
  coreInfo
) {
  const counts =
    new Map();

  for (
    const drawIndex
    of coreInfo.drawIndexes
  ) {
    const numbers =
      norm(
        window[
          drawIndex
        ]?.numbers
      );

    const weight =
      recencyWeight(
        drawIndex,
        window.length
      );

    for (
      const n
      of numbers
    ) {
      if (
        coreInfo.core
          .includes(n)
      ) {
        continue;
      }

      const old =
        counts.get(n)
        ||
        {
          number: n,
          count: 0,
          weighted: 0,
          lastIndex: -1
        };

      old.count++;
      old.weighted += weight;
      old.lastIndex = drawIndex;

      counts.set(
        n,
        old
      );
    }
  }

  return [
    ...counts.values()
  ]
    .sort(
      (a, b) =>
        b.weighted -
        a.weighted

        ||

        b.count -
        a.count

        ||

        b.lastIndex -
        a.lastIndex

        ||

        a.number -
        b.number
    )
    .slice(
      0,
      TOP_COMPANIONS
    );
}

function buildLegacyCandidates(window) {
  const candidates =
    new Map();

  for (
    const coreInfo
    of topCores(window)
  ) {
    const companions =
      companionsForCore(
        window,
        coreInfo
      );

    const companionNumbers =
      companions.map(
        x => x.number
      );

    const lookup =
      new Map(
        companions.map(
          x => [
            x.number,
            x
          ]
        )
      );

    combos2(
      companionNumbers,
      pair => {
        const numbers =
          norm([
            ...coreInfo.core,
            ...pair
          ]);

        if (
          numbers.length !== 5
        ) {
          return;
        }

        const p1 =
          lookup.get(
            pair[0]
          );

        const p2 =
          lookup.get(
            pair[1]
          );

        const support = {
          core:
            coreInfo.core,

          coreCount:
            coreInfo.count,

          coreWeighted:
            coreInfo.weightedCount,

          companionWeighted:
            Number(
              p1?.weighted || 0
            )
            +
            Number(
              p2?.weighted || 0
            ),

          companionMin:
            Math.min(
              Number(
                p1?.weighted || 0
              ),
              Number(
                p2?.weighted || 0
              )
            )
        };

        const key =
          numbers.join(',');

        const existing =
          candidates.get(
            key
          );

        if (
          !existing

          ||

          support.coreWeighted >
          existing
            .support
            .coreWeighted

          ||

          (
            support.coreWeighted ===
            existing
              .support
              .coreWeighted

            &&

            support.companionWeighted >
            existing
              .support
              .companionWeighted
          )
        ) {
          candidates.set(
            key,
            {
              numbers,
              support
            }
          );
        }
      }
    );
  }

  return [
    ...candidates.values()
  ];
}

function strongGapStats(
  strongIndexes
) {
  if (
    strongIndexes.length < 3
  ) {
    return {
      meanGap: 0,
      deviation: 0,
      cv: null,
      consistency: 0
    };
  }

  const gaps = [];

  for (
    let i = 1;
    i < strongIndexes.length;
    i++
  ) {
    gaps.push(
      strongIndexes[i] -
      strongIndexes[i - 1]
    );
  }

  const avg =
    mean(gaps);

  const sd =
    stdDev(gaps);

  const cv =
    avg > 0
      ? sd / avg
      : null;

  return {
    meanGap:
      avg,

    deviation:
      sd,

    cv,

    consistency:
      cv == null
        ? 0
        : 1 /
          (
            1 + cv
          )
  };
}

function evaluateLegacyCandidate(
  window,
  candidate
) {
  let exact5 = 0;
  let four = 0;
  let three = 0;

  let weightedHits = 0;
  let weightedStrong = 0;

  let recentHits = 0;
  let recentStrong = 0;

  let lastStrongIndex = -1;
  let lastExactIndex = -1;

  const strongIndexes = [];

  for (
    let i = 0;
    i < window.length;
    i++
  ) {
    const hits =
      hitCount(
        window[i],
        candidate.numbers
      );

    const weight =
      recencyWeight(
        i,
        window.length
      );

    weightedHits +=
      (
        hits *
        hits
      )
      *
      weight;

    if (
      i >=
      window.length -
      RECENT_WINDOW
    ) {
      recentHits += hits;
    }

    if (
      hits === 5
    ) {
      exact5++;
      lastExactIndex = i;
    }

    if (
      hits >= 4
    ) {
      four++;
    }

    if (
      hits >= 3
    ) {
      three++;
      lastStrongIndex = i;

      strongIndexes.push(
        i
      );

      weightedStrong +=
        (
          hits === 5
            ? 10
            : hits === 4
              ? 5
              : 2
        )
        *
        weight;

      if (
        i >=
        window.length -
        RECENT_WINDOW
      ) {
        recentStrong +=
          hits === 5
            ? 10
            : hits === 4
              ? 5
              : 2;
      }
    }
  }

  const gap =
    strongGapStats(
      strongIndexes
    );

  const latestIndex =
    window.length - 1;

  const strongRecency =
    lastStrongIndex >= 0
      ? 1 /
        (
          1 +
          latestIndex -
          lastStrongIndex
        )
      : 0;

  const exactRecency =
    lastExactIndex >= 0
      ? 1 /
        (
          1 +
          latestIndex -
          lastExactIndex
        )
      : 0;

  const support =
    candidate.support;

  const deepScore =
    exact5 * 120
    +
    four * 34
    +
    three * 9
    +
    weightedStrong * 5.5
    +
    recentStrong * 7
    +
    weightedHits * 1.35
    +
    recentHits * 1.8
    +
    support.coreCount * 5
    +
    support.coreWeighted * 3
    +
    support.companionWeighted * 1.5
    +
    support.companionMin * 1.25
    +
    gap.consistency * 14
    +
    strongRecency * 18
    +
    exactRecency * 25;

  return {
    numbers:
      candidate.numbers,

    score:
      deepScore,

    exact5,

    fourPlus:
      four,

    threePlus:
      three,

    weightedHits,

    recentStrong,

    lastStrongIndex
  };
}

function legacySelectFive(window) {
  const evaluated =
    buildLegacyCandidates(
      window
    )
      .map(
        candidate =>
          evaluateLegacyCandidate(
            window,
            candidate
          )
      );

  evaluated.sort(
    (a, b) =>
      b.score -
      a.score

      ||

      b.exact5 -
      a.exact5

      ||

      b.fourPlus -
      a.fourPlus

      ||

      b.recentStrong -
      a.recentStrong

      ||

      b.threePlus -
      a.threePlus

      ||

      b.weightedHits -
      a.weightedHits

      ||

      b.lastStrongIndex -
      a.lastStrongIndex

      ||

      a.numbers
        .join(',')
        .localeCompare(
          b.numbers.join(',')
        )
  );

  return (
    evaluated[0]
      ?.numbers
    ||
    null
  );
}


/* =========================================================
   TEST RESULTS
========================================================= */

function scoreFuture(
  numbers,
  draws
) {
  const hits =
    draws.map(
      d =>
        hitCount(
          d,
          numbers
        )
    );

  const total =
    hits.reduce(
      (sum, n) =>
        sum + n,
      0
    );

  return {
    best:
      Math.max(
        ...hits
      ),

    threePlus:
      hits.filter(
        n =>
          n >= 3
      ).length,

    fourPlus:
      hits.filter(
        n =>
          n >= 4
      ).length,

    exact5:
      hits.filter(
        n =>
          n === 5
      ).length,

    averageHits:
      Number(
        (
          total /
          hits.length
        )
          .toFixed(3)
      ),

    hits
  };
}

function compareResults(
  a,
  b
) {
  const aTuple = [
    a.exact5,
    a.fourPlus,
    a.threePlus,
    a.best,
    a.averageHits
  ];

  const bTuple = [
    b.exact5,
    b.fourPlus,
    b.threePlus,
    b.best,
    b.averageHits
  ];

  for (
    let i = 0;
    i < aTuple.length;
    i++
  ) {
    if (
      aTuple[i] >
      bTuple[i]
    ) {
      return 1;
    }

    if (
      aTuple[i] <
      bTuple[i]
    ) {
      return -1;
    }
  }

  return 0;
}

function getWinner(
  oldResult,
  persistentResult
) {
  const cmp =
    compareResults(
      oldResult,
      persistentResult
    );

  if (
    cmp > 0
  ) {
    return 'old';
  }

  if (
    cmp < 0
  ) {
    return 'persistent';
  }

  return 'tie';
}


/* =========================================================
   TOTALS
========================================================= */

function emptyTotals() {
  return {
    wins: 0,
    threePlus: 0,
    fourPlus: 0,
    exact5: 0,
    bestOverall: 0,
    averageAccumulator: 0
  };
}

function addResult(
  totals,
  result
) {
  totals.threePlus +=
    result.threePlus;

  totals.fourPlus +=
    result.fourPlus;

  totals.exact5 +=
    result.exact5;

  totals.bestOverall =
    Math.max(
      totals.bestOverall,
      result.best
    );

  totals.averageAccumulator +=
    result.averageHits;
}

function finalizeTotals(
  totals,
  cycleCount
) {
  totals.meanCycleAverageHits =
    Number(
      (
        totals.averageAccumulator /
        cycleCount
      )
        .toFixed(3)
    );

  delete totals.averageAccumulator;

  return totals;
}


/* =========================================================
   FIXED DRAW POOL
========================================================= */

async function loadFixedDrawPool() {
  const totalNeeded =
    WINDOW_SIZE *
    WINDOW_COUNT;

  const rows =
    await db(
      `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=lte.${FIXED_CUTOFF_DRAW_ID}&order=draw_id.desc&limit=${totalNeeded}`
    );

  const draws =
    [
      ...(rows || [])
    ].reverse();

  if (
    draws.length !==
    totalNeeded
  ) {
    return {
      ok:
        false,

      error:
        `Need ${totalNeeded} fixed historical draws through ${FIXED_CUTOFF_DRAW_ID}, found ${draws.length}.`
    };
  }

  if (
    Number(
      draws.at(-1)
        ?.draw_id
    )
    !==
    FIXED_CUTOFF_DRAW_ID
  ) {
    return {
      ok:
        false,

      error:
        'Fixed cutoff draw is not the last loaded draw.',

      expectedCutoff:
        FIXED_CUTOFF_DRAW_ID,

      actualLastDrawId:
        Number(
          draws.at(-1)
            ?.draw_id || 0
        )
    };
  }

  for (
    let i = 1;
    i < draws.length;
    i++
  ) {
    const previous =
      Number(
        draws[i - 1]
          ?.draw_id
      );

    const current =
      Number(
        draws[i]
          ?.draw_id
      );

    if (
      current !==
      previous + 1
    ) {
      return {
        ok:
          false,

        error:
          'Fixed historical draw pool is not contiguous.',

        previousDrawId:
          previous,

        currentDrawId:
          current,

        index:
          i
      };
    }
  }

  return {
    ok:
      true,

    draws
  };
}


/* =========================================================
   ONE 250-DRAW WINDOW
========================================================= */

function testWindow(
  draws,
  windowIndex
) {
  const totals = {
    old:
      emptyTotals(),

    persistent:
      emptyTotals(),

    ties:
      0
  };

  const cycles = [];

  for (
    let cycleIndex = 0;
    cycleIndex <
    CYCLES_PER_WINDOW;
    cycleIndex++
  ) {
    const analysisSize =
      FIRST_ANALYSIS
      +
      cycleIndex *
      TRACK_DRAWS;

    const analysis =
      draws.slice(
        0,
        analysisSize
      );

    const future =
      draws.slice(
        analysisSize,
        analysisSize +
        TRACK_DRAWS
      );

    const oldNumbers =
      legacySelectFive(
        analysis
      );

    const persistentPick =
      persistentSelectFive(
        analysis
      );

    const persistentNumbers =
      norm(
        persistentPick
          ?.numbers || []
      );

    if (
      !oldNumbers
      ||
      oldNumbers.length !== 5
      ||
      persistentNumbers.length !== 5
      ||
      future.length !==
      TRACK_DRAWS
    ) {
      cycles.push({
        cycle:
          cycleIndex + 1,

        analysisDraws:
          analysisSize,

        error:
          'Selector or future window incomplete.'
      });

      continue;
    }

    const oldResult =
      scoreFuture(
        oldNumbers,
        future
      );

    const persistentResult =
      scoreFuture(
        persistentNumbers,
        future
      );

    const winner =
      getWinner(
        oldResult,
        persistentResult
      );

    if (
      winner === 'old'
    ) {
      totals.old.wins++;
    }
    else if (
      winner === 'persistent'
    ) {
      totals
        .persistent
        .wins++;
    }
    else {
      totals.ties++;
    }

    addResult(
      totals.old,
      oldResult
    );

    addResult(
      totals.persistent,
      persistentResult
    );

    cycles.push({
      cycle:
        cycleIndex + 1,

      analysisDraws:
        analysisSize,

      analysisFromDrawId:
        analysis[0]
          ?.draw_id,

      analysisToDrawId:
        analysis.at(-1)
          ?.draw_id,

      testFromDrawId:
        future[0]
          ?.draw_id,

      testToDrawId:
        future.at(-1)
          ?.draw_id,

      old: {
        numbers:
          oldNumbers,

        ...oldResult
      },

      persistent: {
        numbers:
          persistentNumbers,

        ...persistentResult
      },

      winner
    });
  }

  finalizeTotals(
    totals.old,
    CYCLES_PER_WINDOW
  );

  finalizeTotals(
    totals.persistent,
    CYCLES_PER_WINDOW
  );

  const windowComparison =
    compareResults(
      {
        exact5:
          totals.old.exact5,

        fourPlus:
          totals.old.fourPlus,

        threePlus:
          totals.old.threePlus,

        best:
          totals.old.bestOverall,

        averageHits:
          totals.old
            .meanCycleAverageHits
      },

      {
        exact5:
          totals
            .persistent
            .exact5,

        fourPlus:
          totals
            .persistent
            .fourPlus,

        threePlus:
          totals
            .persistent
            .threePlus,

        best:
          totals
            .persistent
            .bestOverall,

        averageHits:
          totals
            .persistent
            .meanCycleAverageHits
      }
    );

  return {
    window:
      windowIndex + 1,

    firstDrawId:
      draws[0]
        ?.draw_id,

    lastDrawId:
      draws.at(-1)
        ?.draw_id,

    drawCount:
      draws.length,

    totals,

    windowWinner:
      windowComparison > 0
        ? 'old'
        : windowComparison < 0
          ? 'persistent'
          : 'tie',

    cycles
  };
}


/* =========================================================
   API
========================================================= */

module.exports =
async (
  req,
  res
) => {
  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );

  try {
    const loaded =
      await loadFixedDrawPool();

    if (
      !loaded.ok
    ) {
      return res
        .status(409)
        .json({
          ok:
            false,

          test:
            'Fixed Draw-ID Group Five backtest',

          ...loaded
        });
    }

    const windows = [];

    for (
      let i = 0;
      i < WINDOW_COUNT;
      i++
    ) {
      const start =
        i *
        WINDOW_SIZE;

      const slice =
        loaded.draws.slice(
          start,
          start +
          WINDOW_SIZE
        );

      windows.push(
        testWindow(
          slice,
          i
        )
      );
    }

    const overall = {
      old:
        emptyTotals(),

      persistent:
        emptyTotals(),

      ties:
        0,

      windowWins: {
        old:
          0,

        persistent:
          0,

        ties:
          0
      }
    };

    for (
      const window
      of windows
    ) {
      overall.old.wins +=
        window
          .totals
          .old
          .wins;

      overall.old.threePlus +=
        window
          .totals
          .old
          .threePlus;

      overall.old.fourPlus +=
        window
          .totals
          .old
          .fourPlus;

      overall.old.exact5 +=
        window
          .totals
          .old
          .exact5;

      overall.old.bestOverall =
        Math.max(
          overall
            .old
            .bestOverall,

          window
            .totals
            .old
            .bestOverall
        );

      overall.old.averageAccumulator +=
        window
          .totals
          .old
          .meanCycleAverageHits
        *
        CYCLES_PER_WINDOW;


      overall.persistent.wins +=
        window
          .totals
          .persistent
          .wins;

      overall.persistent.threePlus +=
        window
          .totals
          .persistent
          .threePlus;

      overall.persistent.fourPlus +=
        window
          .totals
          .persistent
          .fourPlus;

      overall.persistent.exact5 +=
        window
          .totals
          .persistent
          .exact5;

      overall.persistent.bestOverall =
        Math.max(
          overall
            .persistent
            .bestOverall,

          window
            .totals
            .persistent
            .bestOverall
        );

      overall.persistent.averageAccumulator +=
        window
          .totals
          .persistent
          .meanCycleAverageHits
        *
        CYCLES_PER_WINDOW;

      overall.ties +=
        window
          .totals
          .ties;

      if (
        window.windowWinner ===
        'old'
      ) {
        overall
          .windowWins
          .old++;
      }
      else if (
        window.windowWinner ===
        'persistent'
      ) {
        overall
          .windowWins
          .persistent++;
      }
      else {
        overall
          .windowWins
          .ties++;
      }
    }

    const totalCycles =
      WINDOW_COUNT *
      CYCLES_PER_WINDOW;

    finalizeTotals(
      overall.old,
      totalCycles
    );

    finalizeTotals(
      overall.persistent,
      totalCycles
    );

    const comparison =
      compareResults(
        {
          exact5:
            overall.old.exact5,

          fourPlus:
            overall.old.fourPlus,

          threePlus:
            overall.old.threePlus,

          best:
            overall.old.bestOverall,

          averageHits:
            overall.old
              .meanCycleAverageHits
        },

        {
          exact5:
            overall
              .persistent
              .exact5,

          fourPlus:
            overall
              .persistent
              .fourPlus,

          threePlus:
            overall
              .persistent
              .threePlus,

          best:
            overall
              .persistent
              .bestOverall,

          averageHits:
            overall
              .persistent
              .meanCycleAverageHits
        }
      );

    const verdict =
      comparison > 0
        ? 'old'
        : comparison < 0
          ? 'persistent'
          : 'tie';

    return res
      .status(200)
      .json({
        ok:
          true,

        test:
          'Fixed Draw-ID Group Five backtest',

        rules: {
          fixedCutoffDrawId:
            FIXED_CUTOFF_DRAW_ID,

          firstLoadedDrawId:
            loaded.draws[0]
              ?.draw_id,

          lastLoadedDrawId:
            loaded.draws.at(-1)
              ?.draw_id,

          windows:
            WINDOW_COUNT,

          drawsPerWindow:
            WINDOW_SIZE,

          cyclesPerWindow:
            CYCLES_PER_WINDOW,

          totalCycles,

          futureDrawsPerCycle:
            TRACK_DRAWS,

          totalFutureDrawsTested:
            totalCycles *
            TRACK_DRAWS,

          cumulativeWindows:
            [
              50,
              70,
              90,
              110,
              130,
              150,
              170,
              190,
              210,
              230
            ],

          futureLeakage:
            false,

          movingWithNewDraws:
            false
        },

        overall,

        verdict,

        windows
      });
  }
  catch (e) {
    return res
      .status(500)
      .json({
        ok:
          false,

        error:
          e.message ||
          String(e)
      });
  }
};
