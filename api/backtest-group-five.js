'use strict';

const { db } = require('./lib');

const {
  selectFive: persistentSelectFive
} = require('../lib/group-five');

const ANALYSIS = 50;
const TRACK = 20;
const CYCLES = 10;
const STEP = 20;

const RECENT_WINDOW = 15;
const TOP_CORES = 70;
const TOP_COMPANIONS = 12;
const MIN_CORE_OCCURRENCES = 2;


/* =========================================================
   BASIC HELPERS
========================================================= */

function norm(values) {
  return [
    ...new Set(
      (values || []).map(Number)
    )
  ]
    .filter(
      n =>
        Number.isInteger(n) &&
        n >= 1 &&
        n <= 80
    )
    .sort(
      (a, b) => a - b
    );
}


function combinations(
  values,
  size
) {
  const input =
    norm(values);

  const out = [];

  function walk(
    start,
    picked
  ) {
    if (
      picked.length === size
    ) {
      out.push([
        ...picked
      ]);

      return;
    }

    for (
      let i = start;
      i <=
      input.length -
      (
        size -
        picked.length
      );
      i++
    ) {
      picked.push(
        input[i]
      );

      walk(
        i + 1,
        picked
      );

      picked.pop();
    }
  }

  walk(
    0,
    []
  );

  return out;
}


function combos2(
  values,
  fn
) {
  for (
    const combo
    of combinations(
      values,
      2
    )
  ) {
    fn(combo);
  }
}


function combos3(
  values,
  fn
) {
  for (
    const combo
    of combinations(
      values,
      3
    )
  ) {
    fn(combo);
  }
}


function mean(values) {
  return values.length
    ? values.reduce(
        (sum, n) =>
          sum + n,
        0
      ) /
      values.length
    : 0;
}


function stdDev(values) {
  if (
    values.length < 2
  ) {
    return 0;
  }

  const avg =
    mean(values);

  return Math.sqrt(
    mean(
      values.map(
        n =>
          (
            n - avg
          ) ** 2
      )
    )
  );
}


function hitCount(
  draw,
  numbers
) {
  const set =
    new Set(
      norm(
        draw?.numbers
      )
    );

  let hits = 0;

  for (
    const n
    of numbers
  ) {
    if (
      set.has(
        Number(n)
      )
    ) {
      hits++;
    }
  }

  return hits;
}


function recencyWeight(
  index,
  total
) {
  if (
    total <= 1
  ) {
    return 1;
  }

  return (
    1 +
    index /
    (
      total - 1
    )
  );
}


/* =========================================================
   LEGACY SELECTOR
========================================================= */

function buildCoreMap(
  window
) {
  const coreMap =
    new Map();

  for (
    let drawIndex = 0;
    drawIndex <
    window.length;
    drawIndex++
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

    combos3(
      numbers,
      core => {
        const key =
          core.join(',');

        const old =
          coreMap.get(key) ||
          {
            core,
            count: 0,
            weightedCount: 0,
            lastIndex: -1,
            drawIndexes: []
          };

        old.count++;

        old.weightedCount +=
          weight;

        old.lastIndex =
          drawIndex;

        old.drawIndexes.push(
          drawIndex
        );

        coreMap.set(
          key,
          old
        );
      }
    );
  }

  return coreMap;
}


function topCores(
  window
) {
  return [
    ...buildCoreMap(
      window
    ).values()
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
        counts.get(n) ||
        {
          number: n,
          count: 0,
          weighted: 0,
          lastIndex: -1
        };

      old.count++;

      old.weighted +=
        weight;

      old.lastIndex =
        drawIndex;

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


function buildLegacyCandidates(
  window
) {
  const candidates =
    new Map();

  const cores =
    topCores(
      window
    );

  for (
    const coreInfo
    of cores
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
  indexes
) {
  if (
    indexes.length < 3
  ) {
    return {
      meanGap: 0,
      cv: null,
      consistency: 0
    };
  }

  const gaps = [];

  for (
    let i = 1;
    i < indexes.length;
    i++
  ) {
    gaps.push(
      indexes[i] -
      indexes[
        i - 1
      ]
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
      recentHits +=
        hits;
    }

    if (
      hits === 5
    ) {
      exact5++;

      lastExactIndex =
        i;
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

      lastStrongIndex =
        i;

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


function legacySelectFive(
  window
) {
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
   HYBRID SELECTOR

   Candidate pool =
   union of legacy five +
   Persistent Core 3 five.

   Max union = 10 numbers.
   Max combinations = C(10,5) = 252.

   Ranking is based ONLY on analysis data.
========================================================= */

function evaluateHybridCandidate(
  window,
  numbers
) {
  let exact5 = 0;
  let fourPlus = 0;
  let threePlus = 0;

  let recentFourPlus = 0;
  let recentThreePlus = 0;

  let weightedHits = 0;
  let weightedStrong = 0;

  let totalHits = 0;
  let lastStrongIndex = -1;

  const strongIndexes = [];

  for (
    let i = 0;
    i < window.length;
    i++
  ) {
    const hits =
      hitCount(
        window[i],
        numbers
      );

    const weight =
      recencyWeight(
        i,
        window.length
      );

    totalHits +=
      hits;

    weightedHits +=
      (
        hits *
        hits
      )
      *
      weight;

    if (
      hits === 5
    ) {
      exact5++;
    }

    if (
      hits >= 4
    ) {
      fourPlus++;
    }

    if (
      hits >= 3
    ) {
      threePlus++;

      lastStrongIndex =
        i;

      strongIndexes.push(
        i
      );

      weightedStrong +=
        (
          hits === 5
            ? 14
            : hits === 4
              ? 7
              : 2
        )
        *
        weight;
    }

    if (
      i >=
      window.length -
      RECENT_WINDOW
    ) {
      if (
        hits >= 4
      ) {
        recentFourPlus++;
      }

      if (
        hits >= 3
      ) {
        recentThreePlus++;
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

  /*
    Hybrid goal:

    1. Strongly protect 4/5 potential.
    2. Keep the new selector's strength in 3/5.
    3. Reward recent strong appearances.
    4. Reward regular spacing.
    5. Avoid using future test draws.
  */
  const score =
    exact5 * 180
    +
    fourPlus * 58
    +
    threePlus * 13
    +
    recentFourPlus * 32
    +
    recentThreePlus * 10
    +
    weightedStrong * 4
    +
    weightedHits * 1.1
    +
    gap.consistency * 18
    +
    strongRecency * 20
    +
    totalHits * 0.35;

  return {
    numbers,

    score,

    exact5,

    fourPlus,

    threePlus,

    recentFourPlus,

    recentThreePlus,

    weightedHits,

    consistency:
      gap.consistency,

    lastStrongIndex
  };
}


function hybridSelectFive(
  window,
  oldNumbers,
  persistentNumbers
) {
  const pool =
    norm([
      ...(oldNumbers || []),
      ...(persistentNumbers || [])
    ]);

  if (
    pool.length < 5
  ) {
    return null;
  }

  /*
    If both selectors returned
    exactly the same five,
    Hybrid is automatically
    that same group.
  */
  if (
    pool.length === 5
  ) {
    return pool;
  }

  const candidates =
    combinations(
      pool,
      5
    );

  const evaluated =
    candidates.map(
      numbers =>
        evaluateHybridCandidate(
          window,
          numbers
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

      b.recentFourPlus -
      a.recentFourPlus

      ||

      b.threePlus -
      a.threePlus

      ||

      b.recentThreePlus -
      a.recentThreePlus

      ||

      b.consistency -
      a.consistency

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
   FUTURE TEST
========================================================= */

function scoreFuture(
  numbers,
  draws
) {
  const hits =
    draws.map(
      draw =>
        hitCount(
          draw,
          numbers
        )
    );

  return {
    best:
      Math.max(
        ...hits
      ),

    threePlus:
      hits.filter(
        h =>
          h >= 3
      ).length,

    fourPlus:
      hits.filter(
        h =>
          h >= 4
      ).length,

    exact5:
      hits.filter(
        h =>
          h === 5
      ).length,

    averageHits:
      Number(
        (
          hits.reduce(
            (sum, h) =>
              sum + h,
            0
          )
          /
          hits.length
        )
          .toFixed(3)
      ),

    hits
  };
}


function compareResult(
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


function cycleWinner(
  oldResult,
  persistentResult,
  hybridResult
) {
  const rows = [
    {
      name:
        'old',

      result:
        oldResult
    },

    {
      name:
        'persistent',

      result:
        persistentResult
    },

    {
      name:
        'hybrid',

      result:
        hybridResult
    }
  ];

  rows.sort(
    (a, b) =>
      compareResult(
        b.result,
        a.result
      )
  );

  const best =
    rows[0];

  const second =
    rows[1];

  if (
    compareResult(
      best.result,
      second.result
    ) === 0
  ) {
    return 'tie';
  }

  return best.name;
}


/* =========================================================
   TOTALS
========================================================= */

function emptyTotals() {
  return {
    wins:
      0,

    threePlus:
      0,

    fourPlus:
      0,

    exact5:
      0,

    bestOverall:
      0,

    averageHitAccumulator:
      0
  };
}


function addResult(
  total,
  result
) {
  total.threePlus +=
    result.threePlus;

  total.fourPlus +=
    result.fourPlus;

  total.exact5 +=
    result.exact5;

  total.bestOverall =
    Math.max(
      total.bestOverall,
      result.best
    );

  total.averageHitAccumulator +=
    result.averageHits;
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
    const need =
      ANALYSIS
      +
      TRACK
      +
      (
        CYCLES - 1
      )
      *
      STEP;

    const rows =
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&order=draw_id.desc&limit=${need}`
      );

    const draws =
      [
        ...(rows || [])
      ].reverse();

    if (
      draws.length <
      need
    ) {
      return res
        .status(404)
        .json({
          ok:
            false,

          error:
            `Need ${need} stored draws, found ${draws.length}.`
        });
    }

    const totals = {
      old:
        emptyTotals(),

      persistent:
        emptyTotals(),

      hybrid:
        emptyTotals(),

      ties:
        0
    };

    const cycles = [];

    for (
      let cycleIndex = 0;
      cycleIndex < CYCLES;
      cycleIndex++
    ) {
      const start =
        cycleIndex *
        STEP;

      const analysis =
        draws.slice(
          start,
          start + ANALYSIS
        );

      const future =
        draws.slice(
          start + ANALYSIS,
          start + ANALYSIS + TRACK
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

      const hybridNumbers =
        hybridSelectFive(
          analysis,
          oldNumbers,
          persistentNumbers
        );

      if (
        !oldNumbers
        ||
        oldNumbers.length !== 5
        ||
        persistentNumbers.length !== 5
        ||
        !hybridNumbers
        ||
        hybridNumbers.length !== 5
        ||
        future.length !== TRACK
      ) {
        cycles.push({
          cycle:
            cycleIndex + 1,

          error:
            'Incomplete selector output or future window.'
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

      const hybridResult =
        scoreFuture(
          hybridNumbers,
          future
        );

      const winner =
        cycleWinner(
          oldResult,
          persistentResult,
          hybridResult
        );

      if (
        winner === 'tie'
      ) {
        totals.ties++;
      }
      else {
        totals[
          winner
        ].wins++;
      }

      addResult(
        totals.old,
        oldResult
      );

      addResult(
        totals.persistent,
        persistentResult
      );

      addResult(
        totals.hybrid,
        hybridResult
      );

      cycles.push({
        cycle:
          cycleIndex + 1,

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

        hybrid: {
          numbers:
            hybridNumbers,

          ...hybridResult
        },

        winner
      });
    }

    for (
      const key
      of [
        'old',
        'persistent',
        'hybrid'
      ]
    ) {
      totals[
        key
      ].meanCycleAverageHits =
        Number(
          (
            totals[
              key
            ].averageHitAccumulator
            /
            CYCLES
          )
            .toFixed(3)
        );

      delete totals[
        key
      ].averageHitAccumulator;
    }

    const ranking =
      [
        'old',
        'persistent',
        'hybrid'
      ]
        .map(
          name => ({
            name,

            wins:
              totals[
                name
              ].wins,

            exact5:
              totals[
                name
              ].exact5,

            fourPlus:
              totals[
                name
              ].fourPlus,

            threePlus:
              totals[
                name
              ].threePlus,

            averageHits:
              totals[
                name
              ].meanCycleAverageHits
          })
        )
        .sort(
          (a, b) =>
            b.exact5 -
            a.exact5

            ||

            b.fourPlus -
            a.fourPlus

            ||

            b.threePlus -
            a.threePlus

            ||

            b.wins -
            a.wins

            ||

            b.averageHits -
            a.averageHits
        );

    return res
      .status(200)
      .json({
        ok:
          true,

        test:
          'Old vs Persistent Core 3 vs Hybrid',

        rules: {
          cycles:
            CYCLES,

          analysisDrawsPerCycle:
            ANALYSIS,

          futureDrawsPerCycle:
            TRACK,

          stepBetweenTests:
            STEP,

          futureLeakage:
            false,

          hybridPool:
            'Union of Old five and Persistent Core 3 five',

          hybridMaximumCandidates:
            252,

          hybridGoal:
            'Preserve 3/5 frequency while restoring stronger 4/5 behavior'
        },

        totals,

        ranking,

        verdict:
          ranking[0]
            ?.name ||
          null,

        cycles
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
