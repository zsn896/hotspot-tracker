'use strict';

const {
  db,
  score
} = require('../api/lib');


const CONTROL_PREFIX =
  'AUTO_CONTROL_';

const GROUP_NAME =
  'AUTO Group Five';

const ARCHIVE_PREFIX =
  'AUTO Group Five Archive ';


/*
  ==========================================================
  GROUP FIVE FINAL RULE
  ==========================================================

  DAILY:

  First cycle:
  1. Wait for first 50 draws of the daily cycle.
  2. Analyze EXACTLY those first 50.
  3. Select 5 numbers.
  4. Track NEXT 20 future draws.

  Rolling cycles:
  5. When 20/20 is complete:
     - newest 50 are already available
     - effectively 30 old + 20 new
  6. Analyze newest 50 immediately.
  7. Select new 5 numbers.
  8. Track next 20.
  9. Repeat.

  IMPORTANT:
  - Never change numbers before 20/20.
  - Every future draw counts toward progress,
    including 0/5, 1/5 and 2/5.
  - Results are stored for every tracked draw.
  - UI can display Best from 3/5+.
*/


const ANALYSIS_DRAWS =
  50;

const TRACK_DRAWS =
  20;

const RECENT_WINDOW =
  15;

const TOP_CORES =
  70;

const TOP_COMPANIONS =
  12;

const MIN_CORE_OCCURRENCES =
  2;


/* =========================================================
   NORMALIZE
========================================================= */

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


/* =========================================================
   COMBINATIONS
========================================================= */

function combos(
  values,
  size,
  fn
) {

  const a =
    norm(values);

  function walk(
    start,
    picked
  ) {

    if (
      picked.length ===
      size
    ) {

      fn(
        [...picked]
      );

      return;
    }

    for (
      let i = start;
      i <=
      a.length -
      (
        size -
        picked.length
      );
      i++
    ) {

      picked.push(
        a[i]
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
}


function combos2(
  values,
  fn
) {

  combos(
    values,
    2,
    fn
  );
}


function combos3(
  values,
  fn
) {

  combos(
    values,
    3,
    fn
  );
}


/* =========================================================
   MATH
========================================================= */

function mean(values) {

  if (
    !values.length
  ) {

    return 0;
  }

  return (
    values.reduce(
      (sum, n) =>
        sum + n,
      0
    )
    /
    values.length
  );
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
   ACTIVE GROUP FIVE
========================================================= */

async function getCurrentGroup() {

  const rows =
    await db(
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=eq.${encodeURIComponent(
        GROUP_NAME
      )}&active=eq.true&order=id.desc&limit=1`
    );

  return (
    rows?.[0]
    ||
    null
  );
}


/* =========================================================
   DAILY DRAWS
========================================================= */

async function getCycleDraws(
  control
) {

  if (
    !control
  ) {

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
   EXACT 50
========================================================= */

function exact50(
  draws
) {

  const rows =
    (draws || [])
      .slice(
        -ANALYSIS_DRAWS
      );

  if (
    rows.length !==
    ANALYSIS_DRAWS
  ) {

    return [];
  }

  return rows;
}


function getWindowEndingAt(
  draws,
  endId
) {

  const eligible =
    (draws || [])
      .filter(
        d =>
          Number(
            d.draw_id
          )
          <=
          Number(
            endId
          )
      );

  return exact50(
    eligible
  );
}


/* =========================================================
   HIT COUNT
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

  let hits =
    0;

  for (
    const n of
    numbers
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


/* =========================================================
   RECENCY WEIGHT
========================================================= */

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
    1
    +
    (
      index /
      (
        total - 1
      )
    )
  );
}


/* =========================================================
   CORE MAP
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

    const d =
      window[
        drawIndex
      ];

    const numbers =
      norm(
        d.numbers
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
          coreMap.get(
            key
          )
          ||
          {
            core,
            count:
              0,
            weightedCount:
              0,
            lastIndex:
              -1,
            drawIndexes:
              []
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


/* =========================================================
   TOP CORES
========================================================= */

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


/* =========================================================
   COMPANIONS
========================================================= */

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

    const d =
      window[
        drawIndex
      ];

    const numbers =
      norm(
        d.numbers
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
          number:
            n,
          count:
            0,
          weighted:
            0,
          lastIndex:
            -1
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


/* =========================================================
   BUILD 5-NUMBER CANDIDATES
========================================================= */

function buildCandidates(
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
        x =>
          x.number
      );

    const companionLookup =
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
          numbers.length !==
          5
        ) {

          return;
        }

        const key =
          numbers.join(',');

        const p1 =
          companionLookup.get(
            pair[0]
          );

        const p2 =
          companionLookup.get(
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
            (
              Number(
                p1?.weighted || 0
              )
              +
              Number(
                p2?.weighted || 0
              )
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


/* =========================================================
   STRONG GAP STATS
========================================================= */

function strongGapStats(
  strongIndexes
) {

  if (
    strongIndexes.length <
    3
  ) {

    return {
      meanGap:
        0,

      deviation:
        0,

      cv:
        null,

      consistency:
        0
    };
  }

  const gaps =
    [];

  for (
    let i = 1;
    i <
    strongIndexes.length;
    i++
  ) {

    gaps.push(
      strongIndexes[i]
      -
      strongIndexes[
        i - 1
      ]
    );
  }

  const avg =
    mean(
      gaps
    );

  const sd =
    stdDev(
      gaps
    );

  const cv =
    avg > 0
      ?
      sd / avg
      :
      null;

  const consistency =
    cv == null
      ?
      0
      :
      1 /
      (
        1 + cv
      );

  return {
    meanGap:
      avg,

    deviation:
      sd,

    cv,

    consistency
  };
}


/* =========================================================
   EVALUATE ONE CANDIDATE
========================================================= */

function evaluateCandidate(
  window,
  candidate
) {

  let exact5 =
    0;

  let four =
    0;

  let three =
    0;

  let totalHits =
    0;

  let weightedHits =
    0;

  let weightedStrong =
    0;

  let recentHits =
    0;

  let recentStrong =
    0;

  let lastStrongIndex =
    -1;

  let lastExactIndex =
    -1;

  const strongIndexes =
    [];


  for (
    let i = 0;
    i <
    window.length;
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

    totalHits +=
      hits;

    weightedHits +=
      (
        hits * hits
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
            ?
            10
            :
            hits === 4
              ?
              5
              :
              2
        )
        *
        weight;


      if (
        i >=
        window.length -
        RECENT_WINDOW
      ) {

        recentStrong +=
          (
            hits === 5
              ?
              10
              :
              hits === 4
                ?
                5
                :
                2
          );
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
      ?
      1 /
      (
        1
        +
        (
          latestIndex -
          lastStrongIndex
        )
      )
      :
      0;


  const exactRecency =
    lastExactIndex >= 0
      ?
      1 /
      (
        1
        +
        (
          latestIndex -
          lastExactIndex
        )
      )
      :
      0;


  const support =
    candidate.support;


  const deepScore =

    exact5 *
      120

    +

    four *
      34

    +

    three *
      9

    +

    weightedStrong *
      5.5

    +

    recentStrong *
      7

    +

    weightedHits *
      1.35

    +

    recentHits *
      1.8

    +

    support.coreCount *
      5

    +

    support.coreWeighted *
      3

    +

    support.companionWeighted *
      1.5

    +

    support.companionMin *
      1.25

    +

    gap.consistency *
      14

    +

    strongRecency *
      18

    +

    exactRecency *
      25;


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

    totalHits,

    weightedHits,

    recentHits,

    recentStrong,

    lastStrongIndex,

    strongGapMean:
      gap.meanGap,

    strongGapCV:
      gap.cv,

    consistency:
      gap.consistency,

    core:
      support.core,

    coreCount:
      support.coreCount,

    coreWeighted:
      support.coreWeighted,

    companionWeighted:
      support
        .companionWeighted,

    companionMin:
      support
        .companionMin
  };
}


/* =========================================================
   DEEP ANALYZE EXACTLY 50
========================================================= */

function deepAnalyze50(
  inputDraws
) {

  const window =
    exact50(
      inputDraws
    );

  if (
    window.length !==
    ANALYSIS_DRAWS
  ) {

    return [];
  }


  const candidates =
    buildCandidates(
      window
    );


  const evaluated =
    candidates.map(
      candidate =>
        evaluateCandidate(
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
          b.numbers
            .join(',')
        )
  );


  return evaluated;
}


/* =========================================================
   FALLBACK
========================================================= */

function fallbackFive(
  inputDraws
) {

  const window =
    exact50(
      inputDraws
    );

  if (
    window.length !==
    ANALYSIS_DRAWS
  ) {

    return [];
  }


  const individual =
    new Map();

  const pairCounts =
    new Map();


  for (
    let i = 0;
    i <
    window.length;
    i++
  ) {

    const nums =
      norm(
        window[i]
          .numbers
      );

    const weight =
      recencyWeight(
        i,
        window.length
      );


    for (
      const n
      of nums
    ) {

      individual.set(
        n,
        (
          individual.get(n)
          ||
          0
        )
        +
        weight
      );
    }


    combos2(
      nums,
      pair => {

        const key =
          pair.join(',');

        pairCounts.set(
          key,
          (
            pairCounts.get(
              key
            )
            ||
            0
          )
          +
          weight
        );
      }
    );
  }


  const ranked =
    [
      ...individual
        .entries()
    ]
      .sort(
        (a, b) =>
          b[1] -
          a[1]
          ||
          a[0] -
          b[0]
      )
      .slice(
        0,
        18
      )
      .map(
        ([n]) =>
          n
      );


  let best =
    null;


  const a =
    ranked;


  for (
    let i = 0;
    i <
    a.length - 4;
    i++
  ) {

    for (
      let j = i + 1;
      j <
      a.length - 3;
      j++
    ) {

      for (
        let k = j + 1;
        k <
        a.length - 2;
        k++
      ) {

        for (
          let l = k + 1;
          l <
          a.length - 1;
          l++
        ) {

          for (
            let m = l + 1;
            m <
            a.length;
            m++
          ) {

            const nums = [
              a[i],
              a[j],
              a[k],
              a[l],
              a[m]
            ];

            let individualScore =
              0;

            let pairScore =
              0;


            for (
              const n
              of nums
            ) {

              individualScore +=
                individual.get(
                  n
                )
                ||
                0;
            }


            combos2(
              nums,
              pair => {

                pairScore +=
                  pairCounts.get(
                    pair.join(',')
                  )
                  ||
                  0;
              }
            );


            const candidateScore =
              individualScore
              +
              pairScore *
              0.5;


            if (
              !best
              ||
              candidateScore >
              best.score
            ) {

              best = {

                numbers:
                  nums,

                score:
                  candidateScore
              };
            }
          }
        }
      }
    }
  }


  return (
    best
      ?
      norm(
        best.numbers
      )
      :
      []
  );
}


/* =========================================================
   SELECT FIVE
========================================================= */

function selectFive(
  inputDraws
) {

  const window =
    exact50(
      inputDraws
    );


  if (
    window.length !==
    ANALYSIS_DRAWS
  ) {

    return null;
  }


  const ranked =
    deepAnalyze50(
      window
    );


  const winner =
    ranked?.[0];


  const numbers =
    norm(
      winner?.numbers
      ||
      []
    );


  if (
    numbers.length ===
    5
  ) {

    return {

      numbers,

      method:
        'deep50-core3-recency-4of5-5of5-consistency',

      analysis: {

        window:
          50,

        candidateCount:
          ranked.length,

        score:
          Number(
            winner.score
              .toFixed(3)
          ),

        exact5:
          winner.exact5,

        fourPlus:
          winner.fourPlus,

        threePlus:
          winner.threePlus,

        recentStrong:
          winner.recentStrong,

        core:
          winner.core,

        coreCount:
          winner.coreCount,

        strongGapMean:
          Number(
            winner
              .strongGapMean
              .toFixed(2)
          ),

        strongGapCV:
          winner
            .strongGapCV == null
              ?
              null
              :
              Number(
                winner
                  .strongGapCV
                  .toFixed(3)
              )
      }
    };
  }


  const fallback =
    fallbackFive(
      window
    );


  if (
    fallback.length !==
    5
  ) {

    return null;
  }


  return {

    numbers:
      fallback,

    method:
      'deep50-recency-frequency-pair-fallback',

    analysis: {

      window:
        50,

      fallback:
        true
    }
  };
}


/* =========================================================
   CREATE ACTIVE GROUP
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
    rows?.[0]
    ||
    null
  );
}


/* =========================================================
   DELETE INVALID / MISALIGNED GROUP
========================================================= */

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


/* =========================================================
   ARCHIVE FINISHED 20-DRAW CYCLE
========================================================= */

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
   TRACK EXACTLY NEXT 20

   Every draw counts:
   0/5
   1/5
   2/5
   3/5
   4/5
   5/5

   All are stored so progress is exact.

   UI filters 3/5+ for Best / Results.
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
    target <=
    after
  ) {

    return {

      processed:
        0,

      lastSeen:
        after,

      capReached:
        after >=
        cutoff
    };
  }


  const pending =
    draws.filter(
      d =>
        Number(
          d.draw_id
        )
        >
        after
        &&
        Number(
          d.draw_id
        )
        <=
        target
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
      )
      >=
      cutoff
  };
}


/* =========================================================
   VALID GROUP START

   First selection:
   daily start + 49

   Future selections:
   first selection + 20
   first selection + 40
   first selection + 60
   ...

   Example:
   first draw = 1000
   first selection = 1049
   second = 1069
   third = 1089
========================================================= */

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
    !start
    ||
    !first
    ||
    start <
    first
  ) {

    return false;
  }


  return (
    (
      start -
      first
    )
    %
    TRACK_DRAWS
    ===
    0
  );
}


/* =========================================================
   GROUP FIVE ENGINE
========================================================= */

async function runGroupFive() {

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


  /* =======================================================
     FIRST 50 ONLY
  ======================================================= */

  if (
    draws.length <
    ANALYSIS_DRAWS
  ) {

    return {

      ok:
        true,

      active:
        false,

      waitingFor:
        ANALYSIS_DRAWS,

      have:
        draws.length,

      remaining:
        ANALYSIS_DRAWS -
        draws.length,

      rule:
        'First cycle waits for 50 daily draws only.'
    };
  }


  /*
    This is the ONLY correct first selection point.

    If daily control begins at draw 3298257:
    first selection is draw:
    3298257 + 49 = 3298306
  */

  const firstSelectionEndId =
    Number(
      control.start_draw_id
    )
    +
    ANALYSIS_DRAWS
    -
    1;


  const firstWindow =
    getWindowEndingAt(
      draws,
      firstSelectionEndId
    );


  if (
    firstWindow.length !==
    ANALYSIS_DRAWS
  ) {

    return {

      ok:
        true,

      active:
        false,

      waitingFor:
        ANALYSIS_DRAWS,

      have:
        Math.min(
          draws.length,
          ANALYSIS_DRAWS
        ),

      remaining:
        Math.max(
          0,
          ANALYSIS_DRAWS -
          draws.length
        ),

      error:
        'First exact 50-draw window is not complete.'
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


  /* =======================================================
     SELF-REPAIR OLD WRONG GROUP

     Previous bug could create a group at arbitrary latest draw.

     Example:
       correct first start = 3298306
       wrong group start   = 3298315

     3298315 is not:
       3298306 + N*20

     Therefore it is invalid and must be rebuilt.
  ======================================================= */

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


  /* =======================================================
     CREATE FIRST CORRECT GROUP

     IMPORTANT:
     Use FIRST 50 draws,
     NOT latest 50 draws.
  ======================================================= */

  if (
    !group
  ) {

    const pick =
      selectFive(
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
          'Unable to select Group Five from first exact 50 draws.'
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
          'Unable to create Group Five.'
      };
    }


    created =
      true;

    method =
      pick.method;

    selectionAnalysis =
      pick.analysis
      ||
      null;
  }


  const latestId =
    Number(
      draws
        .at(-1)
        .draw_id
    );


  /*
    ========================================================
    ROLLING CATCH-UP LOOP

    Example:

    Cycle 1:
      analyze 1-50
      track 51-70

    Cycle 2:
      analyze 21-70
      track 71-90

    Cycle 3:
      analyze 41-90
      track 91-110

    This is exactly:
      30 retained old draws
      +
      20 newly tracked draws
      =
      latest 50
    ========================================================
  */


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
      startId
      +
      TRACK_DRAWS;


    /*
      Count and score every future draw
      until exactly 20.
    */

    const trackedNow =
      await trackGroup(
        group,
        draws,
        latestId
      );


    processed +=
      trackedNow.processed;


    /*
      Still inside current 20-draw cycle.
      DO NOT change numbers.
    */

    if (
      latestId <
      cutoff
    ) {

      break;
    }


    /*
      Exactly 20/20 reached.

      New analysis window ends at cutoff
      and contains newest 50 draws.

      This is automatically:
      30 previous
      +
      20 new.
    */

    const window =
      getWindowEndingAt(
        draws,
        cutoff
      );


    if (
      window.length !==
      ANALYSIS_DRAWS
    ) {

      break;
    }


    const pick =
      selectFive(
        window
      );


    /*
      Never destroy current completed group
      unless a valid next selection exists.
    */

    if (
      !pick
    ) {

      break;
    }


    /*
      Current cycle completed.
      Clear its result list and archive marker.

      Next group starts exactly at cutoff.
      Therefore next future draw becomes 1/20.
    */

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
      pick.analysis
      ||
      null;


    /*
      Loop continues because worker may have
      missed several draws/cycles.

      It will automatically catch up.
    */
  }


  const startId =
    Number(
      group?.start_draw_id
      ||
      0
    );


  const lastSeen =
    Number(
      group?.last_seen_draw_id
      ??
      startId
    );


  /*
    Progress is based ONLY on number of
    future draws processed.

    NOT based on number of successful hits.
  */

  const tracked =
    Math.max(
      0,
      Math.min(
        TRACK_DRAWS,
        lastSeen -
        startId
      )
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
      group?.id
      ||
      null,

    numbers:
      norm(
        group?.numbers
        ||
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
      startId
      +
      TRACK_DRAWS,

    firstSelectionEndId,

    analysisWindow:
      ANALYSIS_DRAWS,

    trackingWindow:
      TRACK_DRAWS,

    method:
      method
      ||
      'existing-active-group',

    selectionAnalysis,

    rule:
      'First 50 → select 5 → track 20 → newest 50 (30 old + 20 new) → select new 5 → repeat',

    bestRule:
      'Every draw counts toward 20. UI keeps Best Result from 3/5 or better.'
  };
}


/* =========================================================
   EXPORTS
========================================================= */

module.exports = {

  runGroupFive,

  deepAnalyze50,

  selectFive
};
