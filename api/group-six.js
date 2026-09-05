'use strict';

const { db, score } = require('../api/lib');
const { deepAnalyze50 } = require('../lib/group-five');

const CONTROL_PREFIX = 'AUTO_CONTROL_';
const GROUP_NAME = 'AUTO Group Six';
const ARCHIVE_PREFIX = 'AUTO Group Six Archive ';

const MIN_ANALYSIS_DRAWS = 50;
const TRACK_DRAWS = 20;
const PERSISTENCE_SEGMENTS = 4;
const RECENT_WINDOW = 40;
const TOP_COMPANIONS = 18;

const LEARNER_DAY_DRAWS = 180;
const LEARNER_FIRST_TRAIN = 50;
const LEARNER_FORWARD_BLOCK = 20;
const LEARNER_POOL_SIZE = 14;
const LEARNER_RECENT = 40;


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


function recencyWeight(index, total) {
  if (total <= 1) {
    return 1;
  }

  return (
    1 +
    index /
    (total - 1)
  );
}


function segmentForIndex(index, total) {
  if (total <= 1) {
    return 0;
  }

  return Math.min(
    PERSISTENCE_SEGMENTS - 1,
    Math.floor(
      index *
      PERSISTENCE_SEGMENTS /
      total
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

  let count = 0;

  for (const n of numbers) {
    if (
      set.has(
        Number(n)
      )
    ) {
      count++;
    }
  }

  return count;
}


function cumulativeWindow(inputDraws) {
  const rows =
    Array.isArray(inputDraws)
      ? [...inputDraws]
      : [];

  return (
    rows.length >=
    MIN_ANALYSIS_DRAWS
      ? rows
      : []
  );
}


function getWindowEndingAt(
  draws,
  endId
) {
  return cumulativeWindow(
    (draws || []).filter(
      d =>
        Number(d.draw_id) <=
        Number(endId)
    )
  );
}


function analysisSizeForGroupStart(
  controlStartId,
  groupStartId
) {
  return (
    Number(groupStartId) -
    Number(controlStartId) +
    1
  );
}


function isAlignedGroupStart(
  groupStartId,
  firstSelectionEndId
) {
  const start =
    Number(
      groupStartId
    );

  const first =
    Number(
      firstSelectionEndId
    );

  if (
    !start ||
    !first ||
    start < first
  ) {
    return false;
  }

  return (
    (start - first) %
    TRACK_DRAWS
    === 0
  );
}


/* =========================================================
   DAILY CONTROL
========================================================= */

async function getControl() {
  const rows =
    await db(
      `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id&name=like.${encodeURIComponent(
        CONTROL_PREFIX + '*'
      )}&order=id.desc&limit=20`
    );

  return (
    (rows || []).find(
      r =>
        /^AUTO_CONTROL_\d{4}-\d{2}-\d{2}$/.test(
          String(
            r.name || ''
          )
        )
    )
    ||
    null
  );
}


/* =========================================================
   CURRENT GROUP SIX
========================================================= */

async function getCurrentGroup() {
  const rows =
    await db(
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=eq.${encodeURIComponent(
        GROUP_NAME
      )}&active=eq.true&order=id.desc&limit=1`
    );

  return (
    rows?.[0] ||
    null
  );
}


/* =========================================================
   DAILY DRAWS
========================================================= */

async function getCycleDraws(
  control
) {
  if (!control) {
    return [];
  }

  return (
    (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gte.${Number(
          control.start_draw_id
        )}&order=draw_id.asc&limit=500`
      )
    )
    ||
    []
  );
}


/* =========================================================
   CORE 3
========================================================= */

function selectPersistentCore3(
  window
) {
  const ranked =
    deepAnalyze50(
      window
    );

  const core =
    norm(
      ranked?.[0]?.core ||
      []
    );

  if (
    core.length !== 3
  ) {
    return null;
  }

  return {
    core,

    sourceScore:
      Number(
        ranked?.[0]?.score ||
        0
      ),

    coreCount:
      Number(
        ranked?.[0]?.coreCount ||
        0
      ),

    coreRecentCount:
      Number(
        ranked?.[0]?.coreRecentCount ||
        0
      ),

    coreSegmentCount:
      Number(
        ranked?.[0]?.coreSegmentCount ||
        0
      ),

    coreConsistency:
      Number(
        ranked?.[0]?.coreConsistency ||
        0
      )
  };
}


/* =========================================================
   FULL WINDOW COMPANIONS
========================================================= */

function fullWindowCompanionStats(
  window,
  core
) {
  const map =
    new Map();

  const recentStart =
    Math.max(
      0,
      window.length -
      RECENT_WINDOW
    );

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

    const segment =
      segmentForIndex(
        i,
        window.length
      );

    const coreHits =
      hitCount(
        window[i],
        core
      );

    for (
      const n
      of nums
    ) {
      if (
        core.includes(n)
      ) {
        continue;
      }

      const old =
        map.get(n)
        ||
        {
          number: n,
          count: 0,
          weightedCount: 0,
          recentCount: 0,
          lastIndex: -1,
          segments:
            new Set(),
          coreOverlapHits: 0,
          weightedCoreOverlap: 0
        };

      old.count++;

      old.weightedCount +=
        weight;

      old.lastIndex =
        Math.max(
          old.lastIndex,
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

      if (
        coreHits > 0
      ) {
        old.coreOverlapHits +=
          coreHits;

        old.weightedCoreOverlap +=
          coreHits *
          weight;
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
          item.segments.size;

        const age =
          window.length -
          1 -
          item.lastIndex;

        const recency =
          1 /
          (
            1 +
            Math.max(
              0,
              age
            )
          );

        const supportScore =
          item.count * 4
          +
          item.weightedCount * 5
          +
          item.recentCount * 7
          +
          segmentCount * 8
          +
          item.coreOverlapHits * 3
          +
          item.weightedCoreOverlap * 4
          +
          recency * 12;

        return {
          ...item,
          segmentCount,
          age,
          recency,
          supportScore
        };
      }
    )
    .sort(
      (a, b) =>
        b.supportScore -
        a.supportScore

        ||

        b.recentCount -
        a.recentCount

        ||

        b.segmentCount -
        a.segmentCount

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


/* =========================================================
   GROUP SIX PAIR ANALYSIS
========================================================= */

function evaluatePair(
  window,
  core,
  a,
  b
) {
  const numbers =
    norm([
      ...core,
      a.number,
      b.number
    ]);

  if (
    numbers.length !== 5
  ) {
    return null;
  }

  let exact5 = 0;
  let fourPlus = 0;
  let threePlus = 0;
  let weightedStrong = 0;
  let recentStrong = 0;
  let pairTogether = 0;
  let weightedPairTogether = 0;

  const recentStart =
    Math.max(
      0,
      window.length -
      RECENT_WINDOW
    );

  for (
    let i = 0;
    i < window.length;
    i++
  ) {
    const drawNums =
      new Set(
        norm(
          window[i]?.numbers
        )
      );

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
        i >= recentStart
      ) {
        recentStrong +=
          hits === 5
            ? 10
            : hits === 4
              ? 5
              : 2;
      }
    }

    if (
      drawNums.has(
        a.number
      )
      &&
      drawNums.has(
        b.number
      )
    ) {
      pairTogether++;

      weightedPairTogether +=
        weight;
    }
  }

  const balance =
    1 /
    (
      1 +
      Math.abs(
        a.supportScore -
        b.supportScore
      )
    );

  const scoreValue =
    a.supportScore
    +
    b.supportScore
    +
    pairTogether * 5
    +
    weightedPairTogether * 5
    +
    threePlus * 3
    +
    fourPlus * 16
    +
    exact5 * 45
    +
    weightedStrong * 2
    +
    recentStrong * 4
    +
    balance * 10;

  return {
    numbers,

    pair: [
      a.number,
      b.number
    ],

    score:
      scoreValue,

    exact5,
    fourPlus,
    threePlus,
    pairTogether,
    weightedPairTogether,

    companionA:
      a,

    companionB:
      b
  };
}


/* =========================================================
   EXISTING GROUP SIX SELECTOR
========================================================= */

function selectGroupSix(
  inputDraws
) {
  const window =
    cumulativeWindow(
      inputDraws
    );

  if (
    window.length <
    MIN_ANALYSIS_DRAWS
  ) {
    return null;
  }

  const coreInfo =
    selectPersistentCore3(
      window
    );

  if (
    !coreInfo
  ) {
    return null;
  }

  const companions =
    fullWindowCompanionStats(
      window,
      coreInfo.core
    );

  const pairs = [];

  for (
    let i = 0;
    i < companions.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < companions.length;
      j++
    ) {
      const evaluated =
        evaluatePair(
          window,
          coreInfo.core,
          companions[i],
          companions[j]
        );

      if (
        evaluated
      ) {
        pairs.push(
          evaluated
        );
      }
    }
  }

  pairs.sort(
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

      b.threePlus -
      a.threePlus

      ||

      b.pairTogether -
      a.pairTogether

      ||

      a.numbers
        .join(',')
        .localeCompare(
          b.numbers.join(',')
        )
  );

  const winner =
    pairs[0];

  if (
    !winner ||
    winner.numbers.length !== 5
  ) {
    return null;
  }

  return {
    numbers:
      winner.numbers,

    method:
      'group-six-core3-plus-full-window-companion-pair',

    analysis: {
      window:
        window.length,

      core:
        coreInfo.core,

      coreCount:
        coreInfo.coreCount,

      coreRecentCount:
        coreInfo.coreRecentCount,

      coreSegmentCount:
        coreInfo.coreSegmentCount,

      coreConsistency:
        Number(
          coreInfo
            .coreConsistency
            .toFixed(3)
        ),

      companionPool:
        companions.length,

      pairCandidates:
        pairs.length,

      selectedPair:
        winner.pair,

      score:
        Number(
          winner
            .score
            .toFixed(3)
        ),

      historicalThreePlus:
        winner.threePlus,

      historicalFourPlus:
        winner.fourPlus,

      historicalExact5:
        winner.exact5,

      pairTogether:
        winner.pairTogether,

      companions: [
        winner.companionA,
        winner.companionB
      ].map(
        x => ({
          number:
            x.number,

          count:
            x.count,

          recentCount:
            x.recentCount,

          segmentCount:
            x.segmentCount,

          supportScore:
            Number(
              x
                .supportScore
                .toFixed(3)
            )
        })
      )
    }
  };
}


/* =========================================================
   12H LEARNER - NUMBER FEATURES
========================================================= */

function learnerNumberFeatures(
  window
) {
  const total =
    window.length;

  const recentStart =
    Math.max(
      0,
      total -
      Math.min(
        LEARNER_RECENT,
        total
      )
    );

  const map =
    new Map(
      Array.from(
        {
          length: 80
        },
        (
          _,
          i
        ) => [
          i + 1,
          {
            number:
              i + 1,

            count:
              0,

            weightedCount:
              0,

            recentCount:
              0,

            lastIndex:
              -1,

            appearances:
              [],

            segments:
              new Set()
          }
        ]
      )
    );

  for (
    let i = 0;
    i < total;
    i++
  ) {
    const nums =
      norm(
        window[i]?.numbers
      );

    const weight =
      recencyWeight(
        i,
        total
      );

    const segment =
      segmentForIndex(
        i,
        total
      );

    for (
      const n
      of nums
    ) {
      const item =
        map.get(n);

      item.count++;

      item.weightedCount +=
        weight;

      item.lastIndex =
        i;

      item.appearances.push(
        i
      );

      item.segments.add(
        segment
      );

      if (
        i >= recentStart
      ) {
        item.recentCount++;
      }
    }
  }

  return [
    ...map.values()
  ]
    .map(
      item => {
        const gaps = [];

        for (
          let i = 1;
          i < item.appearances.length;
          i++
        ) {
          gaps.push(
            item.appearances[i]
            -
            item.appearances[i - 1]
          );
        }

        const meanGap =
          gaps.length
            ? gaps.reduce(
                (
                  a,
                  b
                ) =>
                  a + b,
                0
              )
              /
              gaps.length
            : total;

        const variance =
          gaps.length
            ? gaps.reduce(
                (
                  sum,
                  gap
                ) =>
                  sum +
                  Math.pow(
                    gap -
                    meanGap,
                    2
                  ),
                0
              )
              /
              gaps.length
            : total *
              total;

        const gapStd =
          Math.sqrt(
            variance
          );

        const gapCv =
          meanGap > 0
            ? gapStd /
              meanGap
            : 999;

        const age =
          item.lastIndex >= 0
            ? total -
              1 -
              item.lastIndex
            : total;

        const recency =
          1 /
          (
            1 +
            Math.max(
              0,
              age
            )
          );

        const segmentCount =
          item.segments.size;

        const consistency =
          1 /
          (
            1 +
            Math.max(
              0,
              gapCv
            )
          );

        const strength =
          item.count * 3
          +
          item.weightedCount * 4
          +
          item.recentCount * 6
          +
          segmentCount * 8
          +
          recency * 12
          +
          consistency * 14;

        return {
          number:
            item.number,

          count:
            item.count,

          weightedCount:
            item.weightedCount,

          recentCount:
            item.recentCount,

          segmentCount,

          meanGap,

          gapCv,

          age,

          recency,

          consistency,

          strength
        };
      }
    )
    .sort(
      (a, b) =>
        b.strength -
        a.strength

        ||

        b.recentCount -
        a.recentCount

        ||

        b.count -
        a.count

        ||

        a.number -
        b.number
    );
}


/* =========================================================
   12H LEARNER - PAIR MATRIX
========================================================= */

function learnerPairMatrix(
  window
) {
  const pairCounts =
    new Map();

  for (
    const draw
    of window
  ) {
    const nums =
      norm(
        draw?.numbers
      );

    for (
      let i = 0;
      i < nums.length;
      i++
    ) {
      for (
        let j = i + 1;
        j < nums.length;
        j++
      ) {
        const key =
          `${nums[i]}-${nums[j]}`;

        pairCounts.set(
          key,
          Number(
            pairCounts.get(
              key
            ) || 0
          )
          +
          1
        );
      }
    }
  }

  return pairCounts;
}


function learnerPairCount(
  matrix,
  a,
  b
) {
  const x =
    Math.min(
      a,
      b
    );

  const y =
    Math.max(
      a,
      b
    );

  return Number(
    matrix.get(
      `${x}-${y}`
    ) || 0
  );
}


/* =========================================================
   SCORE ANY FIVE NUMBERS
========================================================= */

function evaluateNumbersOnRows(
  numbers,
  rows
) {
  const histogram = [
    0,
    0,
    0,
    0,
    0,
    0
  ];

  let totalHits =
    0;

  for (
    const draw
    of rows
  ) {
    const hits =
      hitCount(
        draw,
        numbers
      );

    histogram[
      Math.max(
        0,
        Math.min(
          5,
          hits
        )
      )
    ]++;

    totalHits +=
      hits;
  }

  const exact5 =
    histogram[5];

  const fourPlus =
    histogram[4] +
    histogram[5];

  const threePlus =
    histogram[3] +
    histogram[4] +
    histogram[5];

  const averageHits =
    rows.length
      ? totalHits /
        rows.length
      : 0;

  return {
    draws:
      rows.length,

    exact5,

    fourPlus,

    threePlus,

    bestHit:
      rows.length
        ? (
            [
              5,
              4,
              3,
              2,
              1,
              0
            ].find(
              h =>
                histogram[h] > 0
            )
            ??
            0
          )
        : 0,

    averageHits,

    distribution: {
      zero:
        histogram[0],

      one:
        histogram[1],

      two:
        histogram[2],

      three:
        histogram[3],

      four:
        histogram[4],

      five:
        histogram[5]
    }
  };
}


function learnerValidationScore(
  result
) {
  return (
    Number(
      result?.exact5 ||
      0
    )
    *
    100

    +

    Number(
      result?.fourPlus ||
      0
    )
    *
    25

    +

    Number(
      result?.threePlus ||
      0
    )
    *
    6

    +

    Number(
      result?.averageHits ||
      0
    )
    *
    3
  );
}


/* =========================================================
   STRATEGY 1
   PERSISTENT CORE + PAIR
========================================================= */

function strategyPersistent(
  window
) {
  const pick =
    selectGroupSix(
      window
    );

  if (
    !pick?.numbers?.length
  ) {
    return null;
  }

  return {
    id:
      'persistent-core-pair',

    label:
      'Persistent Core + Pair',

    numbers:
      pick.numbers,

    core:
      pick.analysis?.core ||
      [],

    detail:
      pick.analysis ||
      null
  };
}


/* =========================================================
   STRATEGY 2
   HOT + STABLE
========================================================= */

function strategyHotStable(
  window
) {
  const features =
    learnerNumberFeatures(
      window
    );

  const numbers =
    norm(
      features
        .slice(
          0,
          5
        )
        .map(
          x =>
            x.number
        )
    );

  if (
    numbers.length !== 5
  ) {
    return null;
  }

  return {
    id:
      'hot-stable-5',

    label:
      'Hot + Stable 5',

    numbers,

    core:
      features
        .slice(
          0,
          3
        )
        .map(
          x =>
            x.number
        ),

    detail: {
      leaders:
        features
          .slice(
            0,
            5
          )
          .map(
            x => ({
              number:
                x.number,

              count:
                x.count,

              recentCount:
                x.recentCount,

              segmentCount:
                x.segmentCount,

              gapCv:
                Number(
                  x
                    .gapCv
                    .toFixed(3)
                ),

              strength:
                Number(
                  x
                    .strength
                    .toFixed(3)
                )
            })
          )
    }
  };
}


/* =========================================================
   STRATEGY 3
   CORE + MOMENTUM
========================================================= */

function strategyCoreMomentum(
  window
) {
  const coreInfo =
    selectPersistentCore3(
      window
    );

  if (
    !coreInfo
  ) {
    return null;
  }

  const features =
    learnerNumberFeatures(
      window
    );

  const pairMatrix =
    learnerPairMatrix(
      window
    );

  const candidates =
    features
      .filter(
        x =>
          !coreInfo
            .core
            .includes(
              x.number
            )
      )
      .map(
        x => {
          const corePairSupport =
            coreInfo.core.reduce(
              (
                sum,
                c
              ) =>
                sum +
                learnerPairCount(
                  pairMatrix,
                  c,
                  x.number
                ),
              0
            );

          return {
            ...x,

            corePairSupport,

            combined:
              x.strength
              +
              corePairSupport *
              4
          };
        }
      )
      .sort(
        (a, b) =>
          b.combined -
          a.combined

          ||

          b.corePairSupport -
          a.corePairSupport

          ||

          b.recentCount -
          a.recentCount

          ||

          a.number -
          b.number
      );

  const numbers =
    norm([
      ...coreInfo.core,

      ...candidates
        .slice(
          0,
          2
        )
        .map(
          x =>
            x.number
        )
    ]);

  if (
    numbers.length !== 5
  ) {
    return null;
  }

  return {
    id:
      'core-momentum',

    label:
      'Core + Momentum',

    numbers,

    core:
      coreInfo.core,

    detail: {
      core:
        coreInfo.core,

      companions:
        candidates
          .slice(
            0,
            2
          )
          .map(
            x => ({
              number:
                x.number,

              count:
                x.count,

              recentCount:
                x.recentCount,

              corePairSupport:
                x.corePairSupport,

              combined:
                Number(
                  x
                    .combined
                    .toFixed(3)
                )
            })
          )
    }
  };
}


/* =========================================================
   STRATEGY 4
   SYNERGY ENSEMBLE
========================================================= */

function learnerCombinationScore(
  numbers,
  featureByNumber,
  pairMatrix,
  window
) {
  let individual =
    0;

  let pairSupport =
    0;

  for (
    const n
    of numbers
  ) {
    individual +=
      Number(
        featureByNumber.get(
          n
        )?.strength ||
        0
      );
  }

  for (
    let i = 0;
    i < numbers.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < numbers.length;
      j++
    ) {
      pairSupport +=
        learnerPairCount(
          pairMatrix,
          numbers[i],
          numbers[j]
        );
    }
  }

  const history =
    evaluateNumbersOnRows(
      numbers,
      window
    );

  const scoreValue =
    individual
    +
    pairSupport * 4
    +
    history.threePlus * 3
    +
    history.fourPlus * 12
    +
    history.exact5 * 35
    +
    history.averageHits * 8;

  return {
    score:
      scoreValue,

    pairSupport,

    history
  };
}


function strategySynergyEnsemble(
  window
) {
  const features =
    learnerNumberFeatures(
      window
    );

  const pool =
    features
      .slice(
        0,
        LEARNER_POOL_SIZE
      )
      .map(
        x =>
          x.number
      );

  const featureByNumber =
    new Map(
      features.map(
        x => [
          x.number,
          x
        ]
      )
    );

  const pairMatrix =
    learnerPairMatrix(
      window
    );

  let best =
    null;

  for (
    let a = 0;
    a < pool.length - 4;
    a++
  ) {
    for (
      let b = a + 1;
      b < pool.length - 3;
      b++
    ) {
      for (
        let c = b + 1;
        c < pool.length - 2;
        c++
      ) {
        for (
          let d = c + 1;
          d < pool.length - 1;
          d++
        ) {
          for (
            let e = d + 1;
            e < pool.length;
            e++
          ) {
            const numbers = [
              pool[a],
              pool[b],
              pool[c],
              pool[d],
              pool[e]
            ]
              .sort(
                (
                  x,
                  y
                ) =>
                  x - y
              );

            const evaluated =
              learnerCombinationScore(
                numbers,
                featureByNumber,
                pairMatrix,
                window
              );

            if (
              !best
              ||
              evaluated.score >
              best.score
              ||
              (
                evaluated.score ===
                best.score

                &&

                numbers.join(',') <
                best.numbers.join(',')
              )
            ) {
              best = {
                numbers,
                ...evaluated
              };
            }
          }
        }
      }
    }
  }

  if (
    !best
  ) {
    return null;
  }

  const rankedCore =
    best.numbers
      .map(
        n =>
          featureByNumber.get(
            n
          )
      )
      .filter(
        Boolean
      )
      .sort(
        (a, b) =>
          b.strength -
          a.strength
      )
      .slice(
        0,
        3
      )
      .map(
        x =>
          x.number
      )
      .sort(
        (
          a,
          b
        ) =>
          a - b
      );

  return {
    id:
      'synergy-ensemble',

    label:
      'Synergy Ensemble',

    numbers:
      best.numbers,

    core:
      rankedCore,

    detail: {
      poolSize:
        pool.length,

      combinationScore:
        Number(
          best
            .score
            .toFixed(3)
        ),

      pairSupport:
        best.pairSupport,

      trainingHistory:
        best.history
    }
  };
}


/* =========================================================
   STRATEGY COLLECTION
========================================================= */

function learnerStrategies(
  window
) {
  return [
    strategyPersistent(
      window
    ),

    strategyHotStable(
      window
    ),

    strategyCoreMomentum(
      window
    ),

    strategySynergyEnsemble(
      window
    )
  ]
    .filter(
      Boolean
    );
}


function learnerPickByStrategyId(
  strategyId,
  window
) {
  const strategies =
    learnerStrategies(
      window
    );

  return (
    strategies.find(
      s =>
        s.id ===
        strategyId
    )
    ||
    strategies[0]
    ||
    null
  );
}


/* =========================================================
   WALK FORWARD LEARNING
========================================================= */

function walkForwardLearn(
  draws
) {
  const strategyTotals =
    new Map();

  const stages =
    [];

  for (
    let trainSize =
      LEARNER_FIRST_TRAIN;

    trainSize +
      LEARNER_FORWARD_BLOCK
      <=
      draws.length;

    trainSize +=
      LEARNER_FORWARD_BLOCK
  ) {
    const train =
      draws.slice(
        0,
        trainSize
      );

    const validation =
      draws.slice(
        trainSize,
        trainSize +
        LEARNER_FORWARD_BLOCK
      );

    if (
      validation.length !==
      LEARNER_FORWARD_BLOCK
    ) {
      continue;
    }

    const stageResults =
      [];

    for (
      const strategy
      of learnerStrategies(
        train
      )
    ) {
      const result =
        evaluateNumbersOnRows(
          strategy.numbers,
          validation
        );

      const validationScore =
        learnerValidationScore(
          result
        );

      stageResults.push({
        id:
          strategy.id,

        label:
          strategy.label,

        numbers:
          strategy.numbers,

        core:
          strategy.core,

        result,

        validationScore
      });

      const total =
        strategyTotals.get(
          strategy.id
        )
        ||
        {
          id:
            strategy.id,

          label:
            strategy.label,

          stages:
            0,

          validationScore:
            0,

          exact5:
            0,

          fourPlus:
            0,

          threePlus:
            0,

          averageHitsTotal:
            0,

          wins:
            0
        };

      total.stages++;

      total.validationScore +=
        validationScore;

      total.exact5 +=
        result.exact5;

      total.fourPlus +=
        result.fourPlus;

      total.threePlus +=
        result.threePlus;

      total.averageHitsTotal +=
        result.averageHits;

      strategyTotals.set(
        strategy.id,
        total
      );
    }

    stageResults.sort(
      (a, b) =>
        b.validationScore -
        a.validationScore

        ||

        b.result.exact5 -
        a.result.exact5

        ||

        b.result.fourPlus -
        a.result.fourPlus

        ||

        b.result.threePlus -
        a.result.threePlus

        ||

        b.result.averageHits -
        a.result.averageHits

        ||

        a.id.localeCompare(
          b.id
        )
    );

    if (
      stageResults[0]
    ) {
      const winnerTotal =
        strategyTotals.get(
          stageResults[0].id
        );

      if (
        winnerTotal
      ) {
        winnerTotal.wins++;
      }
    }

    stages.push({
      trainDraws:
        trainSize,

      validationDraws:
        validation.length,

      validationFromDrawId:
        validation[0]?.draw_id ||
        null,

      validationToDrawId:
        validation.at(-1)?.draw_id ||
        null,

      winner:
        stageResults[0]?.id ||
        null,

      strategies:
        stageResults
    });
  }

  const leaderboard =
    [
      ...strategyTotals.values()
    ]
      .map(
        item => ({
          ...item,

          averageHits:
            item.stages
              ? item.averageHitsTotal /
                item.stages
              : 0
        })
      )
      .sort(
        (a, b) =>
          b.validationScore -
          a.validationScore

          ||

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

          ||

          a.id.localeCompare(
            b.id
          )
      );

  return {
    stages,
    leaderboard
  };
}


/* =========================================================
   CONFIDENCE
========================================================= */

function learnerConfidence(
  leaderboard,
  stageCount
) {
  if (
    !leaderboard.length
  ) {
    return 35;
  }

  const first =
    Number(
      leaderboard[0]
        ?.validationScore ||
      0
    );

  const second =
    Number(
      leaderboard[1]
        ?.validationScore ||
      0
    );

  const margin =
    Math.max(
      0,
      first -
      second
    );

  const marginPart =
    first > 0
      ? Math.min(
          25,
          (
            margin /
            first
          )
          *
          50
        )
      : 0;

  const stagePart =
    Math.min(
      30,
      stageCount *
      6
    );

  const highHitPart =
    Math.min(
      10,

      Number(
        leaderboard[0]
          ?.fourPlus ||
        0
      )
      *
      3

      +

      Number(
        leaderboard[0]
          ?.exact5 ||
        0
      )
      *
      5
    );

  return Math.round(
    Math.max(
      35,

      Math.min(
        95,

        35
        +
        marginPart
        +
        stagePart
        +
        highHitPart
      )
    )
  );
}


/* =========================================================
   DAILY 12H PATTERN LEARNER
========================================================= */

async function runDailyPatternLearner() {
  const control =
    await getControl();

  if (
    !control
  ) {
    return {
      ok:
        true,

      mode:
        'daily-pattern-learner',

      active:
        false,

      reason:
        'no-daily-control',

      schedule:
        '6:00 AM – 6:00 PM'
    };
  }

  const rawDraws =
    await getCycleDraws(
      control
    );

  const draws =
    rawDraws
      .filter(
        d =>
          Number.isFinite(
            Number(
              d?.draw_id
            )
          )
          &&
          norm(
            d?.numbers
          ).length === 20
      )
      .sort(
        (a, b) =>
          Number(
            a.draw_id
          )
          -
          Number(
            b.draw_id
          )
      )
      .slice(
        0,
        LEARNER_DAY_DRAWS
      );

  const have =
    draws.length;

  if (
    have <
    LEARNER_FIRST_TRAIN
  ) {
    return {
      ok:
        true,

      mode:
        'daily-pattern-learner',

      active:
        false,

      learning:
        true,

      have,

      need:
        LEARNER_FIRST_TRAIN,

      remaining:
        LEARNER_FIRST_TRAIN -
        have,

      dayTarget:
        LEARNER_DAY_DRAWS,

      schedule:
        '6:00 AM – 6:00 PM',

      message:
        'The learner is collecting the first 50 draws before producing a serious suggestion.'
    };
  }

  const learned =
    walkForwardLearn(
      draws
    );

  const winnerStrategyId =
    learned
      .leaderboard[0]
      ?.id
    ||
    'synergy-ensemble';

  const finalPick =
    learnerPickByStrategyId(
      winnerStrategyId,
      draws
    )
    ||
    strategySynergyEnsemble(
      draws
    )
    ||
    strategyHotStable(
      draws
    );

  const features =
    learnerNumberFeatures(
      draws
    );

  const coreInfo =
    selectPersistentCore3(
      draws
    );

  const confidence =
    learnerConfidence(
      learned.leaderboard,
      learned.stages.length
    );

  const completed =
    have >=
    LEARNER_DAY_DRAWS;

  return {
    ok:
      true,

    mode:
      'daily-pattern-learner',

    active:
      true,

    learning:
      !completed,

    completed,

    schedule:
      '6:00 AM – 6:00 PM',

    have,

    dayTarget:
      LEARNER_DAY_DRAWS,

    remaining:
      Math.max(
        0,
        LEARNER_DAY_DRAWS -
        have
      ),

    controlStartDrawId:
      Number(
        control.start_draw_id
      ),

    latestDrawId:
      Number(
        draws.at(-1)
          ?.draw_id ||
        0
      ),

    suggestion: {
      numbers:
        norm(
          finalPick?.numbers ||
          []
        ),

      core:
        norm(
          finalPick?.core
          ||
          coreInfo?.core
          ||
          []
        )
          .slice(
            0,
            3
          ),

      strategy:
        finalPick?.id
        ||
        winnerStrategyId,

      strategyLabel:
        finalPick?.label
        ||
        winnerStrategyId,

      confidence,

      provisional:
        !completed
    },

    walkForward: {
      completedStages:
        learned.stages.length,

      blockSize:
        LEARNER_FORWARD_BLOCK,

      firstTrainingWindow:
        LEARNER_FIRST_TRAIN,

      leaderboard:
        learned
          .leaderboard
          .map(
            item => ({
              id:
                item.id,

              label:
                item.label,

              stages:
                item.stages,

              wins:
                item.wins,

              exact5:
                item.exact5,

              fourPlus:
                item.fourPlus,

              threePlus:
                item.threePlus,

              averageHits:
                Number(
                  item
                    .averageHits
                    .toFixed(3)
                ),

              validationScore:
                Number(
                  item
                    .validationScore
                    .toFixed(3)
                )
            })
          ),

      stages:
        learned.stages
    },

    strongestNumbers:
      features
        .slice(
          0,
          10
        )
        .map(
          x => ({
            number:
              x.number,

            count:
              x.count,

            recentCount:
              x.recentCount,

            segmentCount:
              x.segmentCount,

            meanGap:
              Number(
                x
                  .meanGap
                  .toFixed(2)
              ),

            gapCv:
              Number(
                x
                  .gapCv
                  .toFixed(3)
              ),

            strength:
              Number(
                x
                  .strength
                  .toFixed(3)
              )
          })
        ),

    patternCore: {
      numbers:
        coreInfo?.core ||
        [],

      count:
        Number(
          coreInfo?.coreCount ||
          0
        ),

      recentCount:
        Number(
          coreInfo?.coreRecentCount ||
          0
        ),

      segmentCount:
        Number(
          coreInfo?.coreSegmentCount ||
          0
        ),

      consistency:
        Number(
          Number(
            coreInfo?.coreConsistency ||
            0
          )
            .toFixed(3)
        )
    },

    rule:
      'Uses same-day 6 AM–6 PM draws only. It compares several deterministic selection strategies with walk-forward tests: train on past draws, score only on the next unseen 20 draws, then use the best-performing strategy for one five-number suggestion.',

    warning:
      'This detects patterns in observed data; it does not prove or reconstruct the lottery draw mechanism and does not guarantee future results.'
  };
}


/* =========================================================
   EXISTING GROUP SIX DATABASE
========================================================= */

async function createGroup(
  numbers,
  startDrawId
) {
  const rows =
    await db(
      'tracker_groups',
      {
        method:
          'POST',

        prefer:
          'return=representation',

        body: {
          name:
            GROUP_NAME,

          numbers:
            norm(
              numbers
            ),

          active:
            true,

          start_draw_id:
            Number(
              startDrawId
            ),

          last_seen_draw_id:
            Number(
              startDrawId
            )
        }
      }
    );

  return (
    rows?.[0] ||
    null
  );
}


async function discardGroup(
  group
) {
  if (
    !group?.id
  ) {
    return;
  }

  await db(
    `tracker_results?group_id=eq.${group.id}`,
    {
      method:
        'DELETE',

      prefer:
        'return=minimal'
    }
  );

  await db(
    `tracker_groups?id=eq.${group.id}`,
    {
      method:
        'DELETE',

      prefer:
        'return=minimal'
    }
  );
}


async function archiveGroupAndClearResults(
  group
) {
  await db(
    `tracker_results?group_id=eq.${group.id}`,
    {
      method:
        'DELETE',

      prefer:
        'return=minimal'
    }
  );

  await db(
    `tracker_groups?id=eq.${group.id}`,
    {
      method:
        'PATCH',

      prefer:
        'return=minimal',

      body: {
        name:
          `${ARCHIVE_PREFIX}${group.start_draw_id}`,

        active:
          false,

        last_seen_draw_id:
          Number(
            group.start_draw_id
          )
          +
          TRACK_DRAWS
      }
    }
  );
}


/* =========================================================
   TRACK EXISTING GROUP SIX
========================================================= */

async function trackGroup(
  group,
  draws,
  latestId
) {
  const after =
    Number(
      group.last_seen_draw_id
      ??
      group.start_draw_id
    );

  const cutoff =
    Number(
      group.start_draw_id
    )
    +
    TRACK_DRAWS;

  const target =
    Math.min(
      Number(
        latestId
      ),
      cutoff
    );

  if (
    target <= after
  ) {
    return {
      processed:
        0,

      lastSeen:
        after,

      capReached:
        after >= cutoff
    };
  }

  const pending =
    draws.filter(
      d =>
        Number(
          d.draw_id
        ) > after

        &&

        Number(
          d.draw_id
        ) <= target
    );

  for (
    const d
    of pending
  ) {
    const s =
      score(
        {
          numbers:
            d.numbers,

          bullsEye:
            d.bulls_eye
        },

        group.numbers
      );

    await db(
      'tracker_results?on_conflict=group_id,draw_id',
      {
        method:
          'POST',

        prefer:
          'resolution=merge-duplicates,return=minimal',

        body: {
          group_id:
            group.id,

          draw_id:
            d.draw_id,

          hit_count:
            s.count,

          hit_numbers:
            s.hit,

          bulls_eye:
            s.bullsEye,

          bulls_eye_match:
            s.bullsEyeMatch
        }
      }
    );
  }

  const lastSeen =
    pending.at(-1)
      ?.draw_id
    ??
    after;

  await db(
    `tracker_groups?id=eq.${group.id}`,
    {
      method:
        'PATCH',

      prefer:
        'return=minimal',

      body: {
        last_seen_draw_id:
          Number(
            lastSeen
          )
      }
    }
  );

  group.last_seen_draw_id =
    Number(
      lastSeen
    );

  return {
    processed:
      pending.length,

    lastSeen:
      Number(
        lastSeen
      ),

    capReached:
      Number(
        lastSeen
      ) >= cutoff
  };
}


/* =========================================================
   EXISTING GROUP SIX ENGINE
========================================================= */

async function runGroupSix() {
  const control =
    await getControl();

  if (
    !control
  ) {
    return {
      ok:
        true,

      active:
        false,

      reason:
        'no-daily-control'
    };
  }

  const draws =
    await getCycleDraws(
      control
    );

  if (
    draws.length <
    MIN_ANALYSIS_DRAWS
  ) {
    return {
      ok:
        true,

      active:
        false,

      waitingFor:
        MIN_ANALYSIS_DRAWS,

      have:
        draws.length,

      remaining:
        MIN_ANALYSIS_DRAWS -
        draws.length,

      rule:
        'Group Six waits for the first 50 daily draws.'
    };
  }

  const firstSelectionEndId =
    Number(
      control.start_draw_id
    )
    +
    MIN_ANALYSIS_DRAWS
    -
    1;

  const firstWindow =
    getWindowEndingAt(
      draws,
      firstSelectionEndId
    );

  if (
    firstWindow.length !==
    MIN_ANALYSIS_DRAWS
  ) {
    return {
      ok:
        true,

      active:
        false,

      waitingFor:
        MIN_ANALYSIS_DRAWS,

      have:
        Math.min(
          draws.length,
          MIN_ANALYSIS_DRAWS
        ),

      remaining:
        Math.max(
          0,
          MIN_ANALYSIS_DRAWS -
          draws.length
        ),

      error:
        'First exact 50-draw cumulative window is not complete.'
    };
  }

  let group =
    await getCurrentGroup();

  let created =
    false;

  let rotated =
    0;

  let processed =
    0;

  let repairedAlignment =
    false;

  let method =
    null;

  let selectionAnalysis =
    null;

  if (
    group
    &&
    !isAlignedGroupStart(
      group.start_draw_id,
      firstSelectionEndId
    )
  ) {
    await discardGroup(
      group
    );

    group =
      null;

    repairedAlignment =
      true;
  }

  if (
    !group
  ) {
    const pick =
      selectGroupSix(
        firstWindow
      );

    if (
      !pick
    ) {
      return {
        ok:
          false,

        active:
          false,

        error:
          'Unable to select Group Six from first 50 cumulative draws.'
      };
    }

    group =
      await createGroup(
        pick.numbers,
        firstSelectionEndId
      );

    if (
      !group
    ) {
      return {
        ok:
          false,

        active:
          false,

        error:
          'Unable to create Group Six.'
      };
    }

    created =
      true;

    method =
      pick.method;

    selectionAnalysis =
      pick.analysis ||
      null;
  }

  const latestId =
    Number(
      draws.at(-1)
        .draw_id
    );

  for (
    let guard = 0;
    guard < 20;
    guard++
  ) {
    const startId =
      Number(
        group.start_draw_id
      );

    const cutoff =
      startId +
      TRACK_DRAWS;

    const trackedNow =
      await trackGroup(
        group,
        draws,
        latestId
      );

    processed +=
      trackedNow.processed;

    if (
      latestId < cutoff
    ) {
      break;
    }

    const window =
      getWindowEndingAt(
        draws,
        cutoff
      );

    const expectedWindowSize =
      analysisSizeForGroupStart(
        control.start_draw_id,
        cutoff
      );

    if (
      window.length <
      MIN_ANALYSIS_DRAWS

      ||

      window.length !==
      expectedWindowSize
    ) {
      break;
    }

    const pick =
      selectGroupSix(
        window
      );

    if (
      !pick
    ) {
      break;
    }

    await archiveGroupAndClearResults(
      group
    );

    group =
      await createGroup(
        pick.numbers,
        cutoff
      );

    if (
      !group
    ) {
      break;
    }

    rotated++;

    method =
      pick.method;

    selectionAnalysis =
      pick.analysis ||
      null;
  }

  const startId =
    Number(
      group?.start_draw_id ||
      0
    );

  const lastSeen =
    Number(
      group?.last_seen_draw_id
      ??
      startId
    );

  const tracked =
    Math.max(
      0,

      Math.min(
        TRACK_DRAWS,

        lastSeen -
        startId
      )
    );

  const analysisWindow =
    analysisSizeForGroupStart(
      control.start_draw_id,
      startId
    );

  return {
    ok:
      true,

    active:
      true,

    created,

    rotated,

    processed,

    repairedAlignment,

    groupId:
      group?.id ||
      null,

    name:
      GROUP_NAME,

    numbers:
      norm(
        group?.numbers ||
        []
      ),

    startDrawId:
      startId,

    lastSeenDrawId:
      lastSeen,

    tracked,

    remaining:
      Math.max(
        0,
        TRACK_DRAWS -
        tracked
      ),

    nextSelectionAfterDrawId:
      startId +
      TRACK_DRAWS,

    firstSelectionEndId,

    analysisWindow,

    trackingWindow:
      TRACK_DRAWS,

    method:
      method ||
      'existing-active-group-six',

    selectionAnalysis,

    rule:
      'Group Six: Persistent Core 3 chooses the fixed three-number core, then two companions are selected from the full cumulative 50/70/90/... window. The five numbers are fixed for exactly 20 future draws.',

    bestRule:
      'Every future draw counts toward 20. Group Six is independent from Group Five.'
  };
}


/* =========================================================
   API HANDLER

   Learner:
   /api/group-six?mode=learner

   Existing Group Six:
   /api/group-six
========================================================= */

async function handler(
  req,
  res
) {
  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );

  try {
    if (
      req.method !==
      'GET'
    ) {
      return res
        .status(405)
        .json({
          ok:
            false,

          error:
            'Method not allowed'
        });
    }

    const mode =
      String(
        req.query?.mode ||
        'group-six'
      )
        .trim()
        .toLowerCase();

    if (
      mode ===
      'learner'

      ||

      mode ===
      '12h'

      ||

      mode ===
      'daily-pattern-learner'
    ) {
      const result =
        await runDailyPatternLearner();

      return res
        .status(200)
        .json(
          result
        );
    }

    if (
      mode ===
      'group-six'

      ||

      mode ===
      'six'

      ||

      mode ===
      'run'
    ) {
      const result =
        await runGroupSix();

      return res
        .status(200)
        .json(
          result
        );
    }

    return res
      .status(400)
      .json({
        ok:
          false,

        error:
          'Unknown Group Six mode.'
      });

  } catch (error) {
    console.error(
      'Group Six API error:',
      error
    );

    return res
      .status(500)
      .json({
        ok:
          false,

        error:
          error?.message ||
          String(
            error
          )
      });
  }
}


module.exports =
  handler;

module.exports.runGroupSix =
  runGroupSix;

module.exports.selectGroupSix =
  selectGroupSix;

module.exports.fullWindowCompanionStats =
  fullWindowCompanionStats;

module.exports.runDailyPatternLearner =
  runDailyPatternLearner;

module.exports.walkForwardLearn =
  walkForwardLearn;
