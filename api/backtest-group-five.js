'use strict';

const { db } = require('./lib');
const { selectFive: newSelectFive } = require('../lib/group-five');

const ANALYSIS = 50;
const TRACK = 20;
const CYCLES = 10;
const STEP = 20;

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

function combos(values, size, fn) {
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
  combos(values, 2, fn);
}

function combos3(values, fn) {
  combos(values, 3, fn);
}

function mean(values) {
  return values.length
    ? values.reduce((s, n) => s + n, 0) / values.length
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

function hitCount(draw, numbers) {
  const set =
    new Set(
      norm(
        draw?.numbers
      )
    );

  let hits = 0;

  for (const n of numbers) {
    if (set.has(Number(n))) {
      hits++;
    }
  }

  return hits;
}

function recencyWeight(index, total) {
  return total <= 1
    ? 1
    : 1 +
      index /
      (
        total - 1
      );
}


/* =========================================================
   OLD SELECTOR
   Commit db5c69275294dcfb1fe93340739f7f753147fa46
========================================================= */

function buildCoreMap(window) {
  const map =
    new Map();

  for (
    let i = 0;
    i < window.length;
    i++
  ) {
    const nums =
      norm(
        window[i]?.numbers
      );

    const weight =
      recencyWeight(
        i,
        window.length
      );

    combos3(
      nums,
      core => {
        const key =
          core.join(',');

        const old =
          map.get(key) ||
          {
            core,
            count: 0,
            weightedCount: 0,
            lastIndex: -1,
            drawIndexes: []
          };

        old.count++;
        old.weightedCount += weight;
        old.lastIndex = i;
        old.drawIndexes.push(i);

        map.set(
          key,
          old
        );
      }
    );
  }

  return map;
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
    const nums =
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
      of nums
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

function buildCandidates(window) {
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

          coreLastIndex:
            coreInfo.lastIndex,

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

function strongGapStats(indexes) {
  if (
    indexes.length < 3
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
    i < indexes.length;
    i++
  ) {
    gaps.push(
      indexes[i] -
      indexes[i - 1]
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

function evaluateOldCandidate(
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

  const s =
    candidate.support;

  const score =
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
    s.coreCount * 5
    +
    s.coreWeighted * 3
    +
    s.companionWeighted * 1.5
    +
    s.companionMin * 1.25
    +
    gap.consistency * 14
    +
    strongRecency * 18
    +
    exactRecency * 25;

  return {
    numbers:
      candidate.numbers,

    score,

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

function oldSelectFive(window) {
  const evaluated =
    buildCandidates(window)
      .map(
        c =>
          evaluateOldCandidate(
            window,
            c
          )
      )
      .sort(
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
   TEST SCORING
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
            (s, h) =>
              s + h,
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

function winner(
  oldR,
  newR
) {
  const oldT = [
    oldR.exact5,
    oldR.fourPlus,
    oldR.threePlus,
    oldR.best,
    oldR.averageHits
  ];

  const newT = [
    newR.exact5,
    newR.fourPlus,
    newR.threePlus,
    newR.best,
    newR.averageHits
  ];

  for (
    let i = 0;
    i < oldT.length;
    i++
  ) {
    if (
      newT[i] >
      oldT[i]
    ) {
      return 'new';
    }

    if (
      newT[i] <
      oldT[i]
    ) {
      return 'old';
    }
  }

  return 'tie';
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

    const cycles = [];

    const totals = {
      old: {
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

        avgHits:
          0
      },

      new: {
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

        avgHits:
          0
      },

      ties:
        0
    };

    for (
      let i = 0;
      i < CYCLES;
      i++
    ) {
      const start =
        i * STEP;

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
        oldSelectFive(
          analysis
        );

      const newPick =
        newSelectFive(
          analysis
        );

      const newNumbers =
        norm(
          newPick?.numbers || []
        );

      if (
        !oldNumbers
        ||
        oldNumbers.length !== 5
        ||
        newNumbers.length !== 5
        ||
        future.length !== TRACK
      ) {
        cycles.push({
          cycle:
            i + 1,

          error:
            'Incomplete selection or future window.'
        });

        continue;
      }

      const oldR =
        scoreFuture(
          oldNumbers,
          future
        );

      const newR =
        scoreFuture(
          newNumbers,
          future
        );

      const w =
        winner(
          oldR,
          newR
        );

      if (
        w === 'old'
      ) {
        totals.old.wins++;
      }
      else if (
        w === 'new'
      ) {
        totals.new.wins++;
      }
      else {
        totals.ties++;
      }

      for (
        const [
          key,
          r
        ]
        of [
          [
            'old',
            oldR
          ],
          [
            'new',
            newR
          ]
        ]
      ) {
        totals[
          key
        ].threePlus +=
          r.threePlus;

        totals[
          key
        ].fourPlus +=
          r.fourPlus;

        totals[
          key
        ].exact5 +=
          r.exact5;

        totals[
          key
        ].bestOverall =
          Math.max(
            totals[
              key
            ].bestOverall,
            r.best
          );

        totals[
          key
        ].avgHits +=
          r.averageHits;
      }

      cycles.push({
        cycle:
          i + 1,

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

          ...oldR
        },

        new: {
          numbers:
            newNumbers,

          ...newR
        },

        winner:
          w
      });
    }

    totals.old.meanCycleAverageHits =
      Number(
        (
          totals.old.avgHits
          /
          CYCLES
        )
          .toFixed(3)
      );

    totals.new.meanCycleAverageHits =
      Number(
        (
          totals.new.avgHits
          /
          CYCLES
        )
          .toFixed(3)
      );

    delete totals.old.avgHits;
    delete totals.new.avgHits;

    const verdict =
      totals.new.wins >
      totals.old.wins
        ? 'new'
        : totals.old.wins >
          totals.new.wins
            ? 'old'
            : 'tie';

    return res
      .status(200)
      .json({
        ok:
          true,

        test:
          'Legacy selector vs current Persistent Core 3',

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

          note:
            'Ten rolling historical 50-draw tests are used because a single Hot Spot day does not contain ten complete 20-draw Group Five cycles.'
        },

        source: {
          old:
            'group-five.js before Persistent Core 3 refactor (commit db5c69275294dcfb1fe93340739f7f753147fa46)',

          new:
            'current lib/group-five.js selectFive()'
        },

        totals,

        verdict,

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
          e.message
          ||
          String(e)
      });
  }
};
