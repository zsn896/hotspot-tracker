'use strict';

const { db } = require('./lib');

const TRACK_DRAWS = 20;
const TEST_CYCLES = 10;
const MIN_ANALYSIS_DRAWS = 50;

const TOP_PERSISTENT_CORES = 40;
const MIN_CORE_OCCURRENCES = 2;
const MAX_COMPANIONS_PER_CORE = 16;
const PERSISTENCE_SEGMENTS = 4;
const RECENT_CORE_MAX = 60;
const RECENT_COMPANION_MAX = 40;


function norm(values) {

  return [
    ...new Set(
      (values || [])
        .map(Number)
    )
  ]
    .filter(
      n =>
        Number.isInteger(n)
        &&
        n >= 1
        &&
        n <= 80
    )
    .sort(
      (a, b) =>
        a - b
    );
}


function combos3(
  values,
  fn
) {

  const a =
    norm(values);

  for (
    let i = 0;
    i < a.length - 2;
    i++
  ) {

    for (
      let j = i + 1;
      j < a.length - 1;
      j++
    ) {

      for (
        let k = j + 1;
        k < a.length;
        k++
      ) {

        fn([
          a[i],
          a[j],
          a[k]
        ]);
      }
    }
  }
}


function mean(values) {

  return values.length
    ? values.reduce(
        (s, n) =>
          s + n,
        0
      )
      /
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


function recencyWeight(
  index,
  total
) {

  return total <= 1
    ? 1
    : 1 +
      index /
      (
        total - 1
      );
}


function segmentForIndex(
  index,
  total
) {

  if (
    total <= 1
  ) {
    return 0;
  }

  return Math.min(
    PERSISTENCE_SEGMENTS - 1,

    Math.floor(
      index
      *
      PERSISTENCE_SEGMENTS
      /
      total
    )
  );
}


function gapStats(indexes) {

  if (
    !indexes.length
  ) {

    return {
      meanGap: 0,
      cv: null,
      consistency: 0
    };
  }


  if (
    indexes.length < 3
  ) {

    return {
      meanGap: 0,
      cv: null,
      consistency: 0.35
    };
  }


  const gaps = [];


  for (
    let i = 1;
    i < indexes.length;
    i++
  ) {

    gaps.push(
      indexes[i]
      -
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


/* =========================================================
   PERSISTENT CORE 3
========================================================= */

function buildPersistentCoreMap(
  window
) {

  const map =
    new Map();


  const recentStart =
    window.length
    -
    Math.min(
      RECENT_CORE_MAX,
      window.length
    );


  for (
    let i = 0;
    i < window.length;
    i++
  ) {

    const nums =
      norm(
        window[i]
          ?.numbers
      );


    const weight =
      recencyWeight(
        i,
        window.length
      );


    const segment =
      segmentForIndex(
        i,
        window.length
      );


    combos3(
      nums,
      core => {

        const key =
          core.join(',');


        const old =
          map.get(key)
          ||
          {

            core,

            count:
              0,

            weightedCount:
              0,

            recentCount:
              0,

            firstIndex:
              i,

            lastIndex:
              i,

            indexes:
              [],

            segments:
              new Set()
          };


        old.count++;


        old.weightedCount +=
          weight;


        old.firstIndex =
          Math.min(
            old.firstIndex,
            i
          );


        old.lastIndex =
          Math.max(
            old.lastIndex,
            i
          );


        old.indexes.push(
          i
        );


        old.segments.add(
          segment
        );


        if (
          i >= recentStart
        ) {

          old.recentCount++;
        }


        map.set(
          key,
          old
        );
      }
    );
  }


  return map;
}


function evaluateCorePersistence(
  coreInfo,
  windowLength
) {

  const latestIndex =
    windowLength - 1;


  const span =
    coreInfo.lastIndex
    -
    coreInfo.firstIndex;


  const spanRatio =
    windowLength > 1
      ? span /
        (
          windowLength - 1
        )
      : 0;


  const age =
    latestIndex
    -
    coreInfo.lastIndex;


  const recency =
    1 /
    (
      1 + age
    );


  const segmentCount =
    coreInfo
      .segments
      .size;


  const gap =
    gapStats(
      coreInfo.indexes
    );


  const persistenceScore =

    coreInfo.count
    *
    12

    +

    coreInfo.weightedCount
    *
    5

    +

    coreInfo.recentCount
    *
    9

    +

    segmentCount
    *
    14

    +

    spanRatio
    *
    18

    +

    recency
    *
    20

    +

    gap.consistency
    *
    12;


  return {

    ...coreInfo,

    segmentCount,

    span,

    spanRatio,

    age,

    consistency:
      gap.consistency,

    persistenceScore
  };
}


function topPersistentCores(
  window
) {

  return [
    ...buildPersistentCoreMap(
      window
    ).values()
  ]

    .filter(
      core =>
        core.count
        >=
        MIN_CORE_OCCURRENCES
    )

    .map(
      core =>
        evaluateCorePersistence(
          core,
          window.length
        )
    )

    .filter(
      core =>
        core.segmentCount >= 2
        ||
        core.count >= 4
    )

    .sort(
      (a, b) =>

        b.persistenceScore
        -
        a.persistenceScore

        ||

        b.segmentCount
        -
        a.segmentCount

        ||

        b.recentCount
        -
        a.recentCount

        ||

        b.count
        -
        a.count

        ||

        b.lastIndex
        -
        a.lastIndex

        ||

        a.core
          .join(',')
          .localeCompare(
            b.core.join(',')
          )
    )

    .slice(
      0,
      TOP_PERSISTENT_CORES
    );
}


function companionSupport(
  window,
  coreInfo
) {

  const map =
    new Map();


  const recentStart =
    window.length
    -
    Math.min(
      RECENT_COMPANION_MAX,
      window.length
    );


  for (
    const drawIndex
    of coreInfo.indexes
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


    const segment =
      segmentForIndex(
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
        map.get(n)
        ||
        {

          number:
            n,

          count:
            0,

          weightedCount:
            0,

          recentCount:
            0,

          lastIndex:
            -1,

          segments:
            new Set()
        };


      old.count++;


      old.weightedCount +=
        weight;


      old.lastIndex =
        Math.max(
          old.lastIndex,
          drawIndex
        );


      old.segments.add(
        segment
      );


      if (
        drawIndex >=
        recentStart
      ) {

        old.recentCount++;
      }


      map.set(
        n,
        old
      );
    }
  }


  return [
    ...map.values()
  ]

    .map(
      item => {

        const segmentCount =
          item
            .segments
            .size;


        const age =
          window.length
          -
          1
          -
          item.lastIndex;


        const recency =
          1 /
          (
            1
            +
            Math.max(
              0,
              age
            )
          );


        const supportScore =

          item.count
          *
          10

          +

          item.weightedCount
          *
          4

          +

          item.recentCount
          *
          8

          +

          segmentCount
          *
          9

          +

          recency
          *
          12;


        return {

          ...item,

          segmentCount,

          supportScore
        };
      }
    )

    .sort(
      (a, b) =>

        b.supportScore
        -
        a.supportScore

        ||

        b.segmentCount
        -
        a.segmentCount

        ||

        b.recentCount
        -
        a.recentCount

        ||

        b.count
        -
        a.count

        ||

        b.lastIndex
        -
        a.lastIndex

        ||

        a.number
        -
        b.number
    )

    .slice(
      0,
      MAX_COMPANIONS_PER_CORE
    );
}


function newSelect(
  window
) {

  if (
    !Array.isArray(
      window
    )
    ||
    window.length <
      MIN_ANALYSIS_DRAWS
  ) {

    return null;
  }


  const candidates = [];


  for (
    const coreInfo
    of topPersistentCores(
      window
    )
  ) {

    const companions =
      companionSupport(
        window,
        coreInfo
      );


    const two =
      companions
        .slice(
          0,
          2
        )
        .map(
          x =>
            x.number
        );


    const numbers =
      norm([
        ...coreInfo.core,
        ...two
      ]);


    if (
      numbers.length !== 5
    ) {

      continue;
    }


    const companionScore =
      companions

        .filter(
          x =>
            two.includes(
              x.number
            )
        )

        .reduce(
          (sum, x) =>
            sum
            +
            x.supportScore,
          0
        );


    candidates.push({

      numbers,

      score:

        coreInfo.persistenceScore
        *
        3

        +

        companionScore,

      coreSegmentCount:
        coreInfo.segmentCount,

      coreRecentCount:
        coreInfo.recentCount,

      coreCount:
        coreInfo.count,

      coreSpan:
        coreInfo.span
    });
  }


  candidates.sort(
    (a, b) =>

      b.score
      -
      a.score

      ||

      b.coreSegmentCount
      -
      a.coreSegmentCount

      ||

      b.coreRecentCount
      -
      a.coreRecentCount

      ||

      b.coreCount
      -
      a.coreCount

      ||

      b.coreSpan
      -
      a.coreSpan

      ||

      a.numbers
        .join(',')
        .localeCompare(
          b.numbers.join(',')
        )
  );


  return (
    candidates[0]
      ?.numbers
    ||
    null
  );
}


/* =========================================================
   RESULTS
========================================================= */

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


  return numbers.reduce(
    (
      count,
      n
    ) =>
      count
      +
      (
        set.has(
          Number(n)
        )
          ? 1
          : 0
      ),
    0
  );
}


function score20(
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


  const distribution = {

    zero:
      0,

    one:
      0,

    two:
      0,

    three:
      0,

    four:
      0,

    five:
      0
  };


  for (
    const h
    of hits
  ) {

    if (h === 0) {
      distribution.zero++;
    }

    if (h === 1) {
      distribution.one++;
    }

    if (h === 2) {
      distribution.two++;
    }

    if (h === 3) {
      distribution.three++;
    }

    if (h === 4) {
      distribution.four++;
    }

    if (h === 5) {
      distribution.five++;
    }
  }


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

    distribution
  };
}


function cycleWinner(
  oldResult,
  newResult
) {

  const oldTuple = [

    oldResult.exact5,

    oldResult.fourPlus,

    oldResult.threePlus,

    oldResult.best,

    oldResult.averageHits
  ];


  const newTuple = [

    newResult.exact5,

    newResult.fourPlus,

    newResult.threePlus,

    newResult.best,

    newResult.averageHits
  ];


  for (
    let i = 0;
    i < oldTuple.length;
    i++
  ) {

    if (
      newTuple[i]
      >
      oldTuple[i]
    ) {

      return 'new';
    }


    if (
      newTuple[i]
      <
      oldTuple[i]
    ) {

      return 'old';
    }
  }


  return 'tie';
}


/* =========================================================
   FIND HISTORICAL DAY
========================================================= */

async function findDayWithTenOldArchives() {

  const controls =
    await db(

      `tracker_groups?select=id,name,start_draw_id,created_at&name=like.${encodeURIComponent(
        'AUTO_CONTROL_*'
      )}&order=id.desc&limit=10`
    );


  for (
    const control
    of controls || []
  ) {

    const start =
      Number(
        control
          .start_draw_id
        ||
        0
      );


    if (!start) {
      continue;
    }


    const firstSelectionEnd =

      start
      +
      MIN_ANALYSIS_DRAWS
      -
      1;


    const maxStart =

      firstSelectionEnd
      +
      (
        TEST_CYCLES - 1
      )
      *
      TRACK_DRAWS;


    const archives =
      await db(

        `tracker_groups?select=id,name,numbers,start_draw_id,last_seen_draw_id,created_at&name=like.${encodeURIComponent(
          'AUTO Group Five Archive *'
        )}&start_draw_id=gte.${firstSelectionEnd}&start_draw_id=lte.${maxStart}&order=start_draw_id.asc&limit=20`
      );


    const aligned =
      (
        archives || []
      )
        .filter(
          (
            g,
            index
          ) =>

            Number(
              g.start_draw_id
            )

            ===

            firstSelectionEnd
            +
            index
            *
            TRACK_DRAWS
        );


    if (
      aligned.length
      >=
      TEST_CYCLES
    ) {

      const lastNeeded =

        maxStart
        +
        TRACK_DRAWS;


      const draws =
        await db(

          `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gte.${start}&draw_id=lte.${lastNeeded}&order=draw_id.asc&limit=300`
        );


      if (
        (
          draws || []
        ).length
        >=
        MIN_ANALYSIS_DRAWS
        +
        TEST_CYCLES
        *
        TRACK_DRAWS
      ) {

        return {

          control,

          archives:
            aligned.slice(
              0,
              TEST_CYCLES
            ),

          draws
        };
      }
    }
  }


  return null;
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

    const found =
      await findDayWithTenOldArchives();


    if (!found) {

      return res
        .status(404)
        .json({

          ok:
            false,

          error:
            'Could not find a completed day with 10 aligned archived Group Five cycles.'
        });
    }


    const {
      control,
      archives,
      draws
    } =
      found;


    const start =
      Number(
        control.start_draw_id
      );


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

        avgHitsSum:
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

        avgHitsSum:
          0
      },


      ties:
        0
    };


    for (
      let i = 0;
      i < TEST_CYCLES;
      i++
    ) {

      const archive =
        archives[i];


      const selectionEndId =
        Number(
          archive.start_draw_id
        );


      const analysisDraws =
        draws.filter(
          d =>

            Number(
              d.draw_id
            )
            >=
            start

            &&

            Number(
              d.draw_id
            )
            <=
            selectionEndId
        );


      const futureDraws =
        draws.filter(
          d =>

            Number(
              d.draw_id
            )
            >
            selectionEndId

            &&

            Number(
              d.draw_id
            )
            <=
            selectionEndId
            +
            TRACK_DRAWS
        );


      const oldNumbers =
        norm(
          archive.numbers
        );


      const newNumbers =
        newSelect(
          analysisDraws
        );


      if (
        oldNumbers.length !== 5
        ||
        !newNumbers
        ||
        futureDraws.length
        !==
        TRACK_DRAWS
      ) {

        cycles.push({

          cycle:
            i + 1,

          selectionEndId,

          error:
            'Missing old numbers, new selection, or complete 20-draw future window.'
        });

        continue;
      }


      const oldResult =
        score20(
          oldNumbers,
          futureDraws
        );


      const newResult =
        score20(
          newNumbers,
          futureDraws
        );


      const winner =
        cycleWinner(
          oldResult,
          newResult
        );


      if (
        winner === 'old'
      ) {

        totals.old.wins++;
      }

      else if (
        winner === 'new'
      ) {

        totals.new.wins++;
      }

      else {

        totals.ties++;
      }


      for (
        const [
          key,
          result
        ]
        of [
          [
            'old',
            oldResult
          ],
          [
            'new',
            newResult
          ]
        ]
      ) {

        totals[
          key
        ].threePlus +=
          result.threePlus;


        totals[
          key
        ].fourPlus +=
          result.fourPlus;


        totals[
          key
        ].exact5 +=
          result.exact5;


        totals[
          key
        ].bestOverall =
          Math.max(
            totals[
              key
            ].bestOverall,

            result.best
          );


        totals[
          key
        ].avgHitsSum +=
          result.averageHits;
      }


      cycles.push({

        cycle:
          i + 1,

        analysisDraws:
          analysisDraws.length,

        selectionEndDrawId:
          selectionEndId,

        testFromDrawId:
          futureDraws[0]
            ?.draw_id
          ||
          null,

        testToDrawId:
          futureDraws.at(-1)
            ?.draw_id
          ||
          null,


        old: {

          numbers:
            oldNumbers,

          ...oldResult
        },


        new: {

          numbers:
            newNumbers,

          ...newResult
        },


        winner
      });
    }


    totals.old.meanCycleAverageHits =
      Number(
        (
          totals.old.avgHitsSum
          /
          TEST_CYCLES
        )
          .toFixed(3)
      );


    totals.new.meanCycleAverageHits =
      Number(
        (
          totals.new.avgHitsSum
          /
          TEST_CYCLES
        )
          .toFixed(3)
      );


    delete totals.old.avgHitsSum;
    delete totals.new.avgHitsSum;


    let verdict =
      'tie';


    if (
      totals.new.wins
      >
      totals.old.wins
    ) {

      verdict =
        'new';
    }


    if (
      totals.old.wins
      >
      totals.new.wins
    ) {

      verdict =
        'old';
    }


    return res
      .status(200)
      .json({

        ok:
          true,

        test:
          'Actual archived old Group Five vs current Persistent Core 3',


        control: {

          name:
            control.name,

          startDrawId:
            start
        },


        rules: {

          cycles:
            TEST_CYCLES,

          cumulativeWindows:
            '50,70,90,110,130,150,170,190,210,230',

          futureDrawsPerCycle:
            TRACK_DRAWS,

          oldSelectionSource:
            'actual archived Group Five numbers',

          newSelectionSource:
            'current Persistent Core 3 rerun only on data available at selection time',

          futureLeakage:
            false
        },


        totals,

        verdict,

        cycles
      });


  } catch (e) {

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
