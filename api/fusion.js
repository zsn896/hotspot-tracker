'use strict';

const {
  getDraw,
  getMany,
  db,
  score
} = require('./lib');


const SOURCE_NAMES = [
  'MANUAL Group',
  'MANUAL Group 2'
];

const GROUP_NAME =
  'MANUAL Group 3';

const MAX_BACKFILL = 80;
const MAX_ANALYSIS_DRAWS = 500;

const MIN_ANALYSIS_DRAWS = 20;
const VALIDATION_RATIO = 0.30;
const RECENT_WINDOW = 40;


/* =========================================================
   BASIC HELPERS
========================================================= */

function nums(value) {
  return Array.isArray(value)
    ? value
        .map(Number)
        .filter(Number.isFinite)
    : [];
}


function uniqueSorted(value) {
  return [
    ...new Set(
      nums(value)
    )
  ].sort(
    (a, b) => a - b
  );
}


function sameNumbers(a, b) {
  const x =
    uniqueSorted(a);

  const y =
    uniqueSorted(b);

  return (
    x.length === 5 &&
    y.length === 5 &&
    x.every(
      (n, i) =>
        n === y[i]
    )
  );
}


/* =========================================================
   DATABASE HELPERS
========================================================= */

async function storeDraw(draw) {
  if (!draw?.id) {
    return;
  }

  await db(
    'hotspot_draws?on_conflict=draw_id',
    {
      method: 'POST',

      prefer:
        'resolution=merge-duplicates,return=minimal',

      body: {
        draw_id:
          draw.id,

        draw_date:
          draw.date,

        draw_time:
          draw.time,

        numbers:
          draw.numbers,

        bulls_eye:
          draw.bullsEye
      }
    }
  );
}


async function getByName(name) {
  const rows =
    await db(
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=eq.${encodeURIComponent(
        name
      )}&order=id.desc&limit=1`
    );

  return rows?.[0] || null;
}


const getFusion =
  () =>
    getByName(
      GROUP_NAME
    );


/* =========================================================
   SAFE DRAW FETCH
========================================================= */

async function safeDraw(
  id,
  map
) {
  const fromBatch =
    map.get(
      Number(id)
    );

  if (fromBatch?.id) {
    return fromBatch;
  }

  try {
    const draw =
      await getDraw(
        Number(id)
      );

    return (
      Number(draw?.id) ===
      Number(id)
    )
      ? draw
      : null;

  } catch (_) {
    return null;
  }
}


/* =========================================================
   FUSION TRACKING
========================================================= */

async function backfill(
  group,
  suppliedLatest = null
) {
  if (!group?.active) {
    return {
      processed: 0,
      latest:
        suppliedLatest,
      stoppedAtMissing:
        null
    };
  }


  const latest =
    suppliedLatest ||
    await getDraw(null);


  await storeDraw(
    latest
  );


  const after =
    Number(
      group.last_seen_draw_id
      ??
      group.start_draw_id
      ??
      latest.id
    );


  if (
    !Number.isFinite(after)
    ||
    after >=
      Number(latest.id)
  ) {
    return {
      processed: 0,
      latest,
      stoppedAtMissing:
        null
    };
  }


  const end =
    Math.min(
      Number(latest.id),
      after +
      MAX_BACKFILL
    );


  const ids =
    Array.from(
      {
        length:
          end - after
      },

      (_, i) =>
        after + i + 1
    );


  let batch = [];

  try {
    batch =
      (
        await getMany(
          ids
        )
      ) || [];

  } catch (_) {
    batch = [];
  }


  const map =
    new Map(
      batch
        .filter(
          d => d?.id
        )
        .map(
          d => [
            Number(d.id),
            d
          ]
        )
    );


  let processed = 0;
  let last = after;

  let stoppedAtMissing =
    null;


  for (
    const id
    of ids
  ) {

    const draw =
      await safeDraw(
        id,
        map
      );


    if (
      !draw ||
      Number(draw.id) !==
        Number(id)
    ) {
      stoppedAtMissing =
        Number(id);

      break;
    }


    await storeDraw(
      draw
    );


    const result =
      score(
        draw,
        group.numbers
      );


    if (
      Number(
        result?.count || 0
      ) >= 3
    ) {

      await db(
        'tracker_results?on_conflict=group_id,draw_id',
        {
          method: 'POST',

          prefer:
            'resolution=merge-duplicates,return=minimal',

          body: {
            group_id:
              group.id,

            draw_id:
              draw.id,

            hit_count:
              result.count,

            hit_numbers:
              result.hit,

            bulls_eye:
              result.bullsEye,

            bulls_eye_match:
              result.bullsEyeMatch
          }
        }
      );
    }


    last =
      Number(
        draw.id
      );

    processed++;
  }


  if (last > after) {

    await db(
      `tracker_groups?id=eq.${group.id}`,
      {
        method: 'PATCH',

        prefer:
          'return=minimal',

        body: {
          last_seen_draw_id:
            last
        }
      }
    );


    group.last_seen_draw_id =
      last;
  }


  return {
    processed,
    latest,
    lastProcessed:
      last,
    stoppedAtMissing
  };
}


/* =========================================================
   RESULT META
========================================================= */

async function attachMeta(rows) {
  rows =
    Array.isArray(rows)
      ? rows
      : [];


  if (!rows.length) {
    return [];
  }


  const ids = [
    ...new Set(
      rows
        .map(
          row =>
            Number(
              row.draw_id
            )
        )
        .filter(
          Number.isFinite
        )
    )
  ];


  if (!ids.length) {
    return rows;
  }


  const draws =
    (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=in.(${ids.join(
          ','
        )})`
      )
    ) || [];


  const meta =
    Object.fromEntries(
      draws.map(
        draw => [
          Number(
            draw.draw_id
          ),
          draw
        ]
      )
    );


  return rows.map(
    row => ({
      ...row,

      date:
        meta[
          Number(
            row.draw_id
          )
        ]?.draw_date || '',

      time:
        meta[
          Number(
            row.draw_id
          )
        ]?.draw_time || ''
    })
  );
}


/* =========================================================
   READ GROUP 3
========================================================= */

async function readFusion(
  group
) {
  if (!group) {
    return null;
  }


  const rows =
    (
      await db(
        `tracker_results?select=draw_id,hit_count,hit_numbers,bulls_eye,bulls_eye_match,created_at&group_id=eq.${group.id}&hit_count=gte.3&order=draw_id.desc&limit=100`
      )
    ) || [];


  const withMeta =
    await attachMeta(
      rows
    );


  const last =
    withMeta[0] ||
    null;


  return {
    id:
      group.id,

    slot:
      3,

    name:
      group.name,

    generated:
      true,

    numbers:
      nums(
        group.numbers
      ),

    active:
      Boolean(
        group.active
      ),

    startDrawId:
      group.start_draw_id,

    trackingLastSeenDrawId:
      group.last_seen_draw_id,

    lastSeenDrawId:
      last?.draw_id
      ??
      null,

    lastSeenResult:
      last
        ? {
            drawId:
              last.draw_id,

            hitCount:
              Number(
                last.hit_count || 0
              ),

            hitNumbers:
              nums(
                last.hit_numbers
              ),

            date:
              last.date || '',

            time:
              last.time || '',

            bullsEye:
              last.bulls_eye,

            bullsEyeMatch:
              Boolean(
                last.bulls_eye_match
              )
          }
        : null,

    matches:
      withMeta,

    createdAt:
      group.created_at
  };
}


/* =========================================================
   COMBINATIONS
========================================================= */

function combos5(values) {
  const out = [];

  for (
    let a = 0;
    a < values.length - 4;
    a++
  ) {

    for (
      let b = a + 1;
      b < values.length - 3;
      b++
    ) {

      for (
        let c = b + 1;
        c < values.length - 2;
        c++
      ) {

        for (
          let d = c + 1;
          d < values.length - 1;
          d++
        ) {

          for (
            let e = d + 1;
            e < values.length;
            e++
          ) {

            out.push([
              values[a],
              values[b],
              values[c],
              values[d],
              values[e]
            ]);
          }
        }
      }
    }
  }

  return out;
}


/* =========================================================
   HIT HELPERS
========================================================= */

function hitCount(
  drawNumbers,
  combo
) {
  const drawSet =
    new Set(
      nums(
        drawNumbers
      )
    );


  return combo.reduce(
    (count, number) =>
      count +
      (
        drawSet.has(
          Number(number)
        )
          ? 1
          : 0
      ),

    0
  );
}


function containsAll(
  drawNumbers,
  values
) {
  const set =
    new Set(
      nums(
        drawNumbers
      )
    );

  return values.every(
    number =>
      set.has(
        Number(number)
      )
  );
}


/* =========================================================
   SOURCE BALANCE
========================================================= */

function coverage(
  combo,
  group1,
  group2
) {
  const a =
    new Set(
      nums(group1)
    );

  const b =
    new Set(
      nums(group2)
    );


  return {
    from1:
      combo.filter(
        number =>
          a.has(
            Number(number)
          )
      ).length,

    from2:
      combo.filter(
        number =>
          b.has(
            Number(number)
          )
      ).length
  };
}


/* =========================================================
   INDIVIDUAL NUMBER STRENGTH
========================================================= */

function buildNumberStats(
  candidates,
  draws
) {
  const map =
    new Map();


  for (
    const number
    of candidates
  ) {

    map.set(
      Number(number),
      {
        number:
          Number(number),

        count:
          0,

        weightedCount:
          0,

        recentCount:
          0,

        segments:
          new Set(),

        lastIndex:
          -1
      }
    );
  }


  const total =
    Math.max(
      1,
      draws.length
    );


  draws.forEach(
    (draw, index) => {

      const drawSet =
        new Set(
          nums(
            draw.numbers
          )
        );


      const weight =
        0.45 +
        0.55 *
        (
          (index + 1) /
          total
        );


      const segment =
        Math.min(
          3,
          Math.floor(
            index /
            Math.max(
              1,
              total / 4
            )
          )
        );


      for (
        const number
        of candidates
      ) {

        if (
          drawSet.has(
            Number(number)
          )
        ) {

          const stat =
            map.get(
              Number(number)
            );


          stat.count++;

          stat.weightedCount +=
            weight;

          stat.lastIndex =
            index;

          stat.segments.add(
            segment
          );


          if (
            index >=
            Math.max(
              0,
              total -
              RECENT_WINDOW
            )
          ) {

            stat.recentCount++;
          }
        }
      }
    }
  );


  for (
    const stat
    of map.values()
  ) {

    const recency =
      stat.lastIndex >= 0
        ? (
            stat.lastIndex +
            1
          ) /
          total
        : 0;


    stat.segmentCount =
      stat.segments.size;


    stat.score =
      stat.count * 3
      +
      stat.weightedCount * 5
      +
      stat.recentCount * 6
      +
      stat.segmentCount * 8
      +
      recency * 10;


    delete stat.segments;
  }


  return map;
}


/* =========================================================
   PAIR STRENGTH
========================================================= */

function pairKey(a, b) {
  return [
    Number(a),
    Number(b)
  ]
    .sort(
      (x, y) =>
        x - y
    )
    .join(':');
}


function buildPairStats(
  candidates,
  draws
) {
  const map =
    new Map();


  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {

    for (
      let j = i + 1;
      j < candidates.length;
      j++
    ) {

      map.set(
        pairKey(
          candidates[i],
          candidates[j]
        ),
        {
          count:
            0,

          weightedCount:
            0,

          recentCount:
            0,

          segments:
            new Set()
        }
      );
    }
  }


  const total =
    Math.max(
      1,
      draws.length
    );


  draws.forEach(
    (draw, index) => {

      const weight =
        0.45 +
        0.55 *
        (
          (index + 1) /
          total
        );


      const segment =
        Math.min(
          3,
          Math.floor(
            index /
            Math.max(
              1,
              total / 4
            )
          )
        );


      for (
        let i = 0;
        i < candidates.length;
        i++
      ) {

        for (
          let j = i + 1;
          j < candidates.length;
          j++
        ) {

          const a =
            candidates[i];

          const b =
            candidates[j];


          if (
            containsAll(
              draw.numbers,
              [a, b]
            )
          ) {

            const stat =
              map.get(
                pairKey(
                  a,
                  b
                )
              );


            stat.count++;

            stat.weightedCount +=
              weight;

            stat.segments.add(
              segment
            );


            if (
              index >=
              Math.max(
                0,
                total -
                RECENT_WINDOW
              )
            ) {

              stat.recentCount++;
            }
          }
        }
      }
    }
  );


  for (
    const stat
    of map.values()
  ) {

    stat.segmentCount =
      stat.segments.size;


    stat.score =
      stat.count * 4
      +
      stat.weightedCount * 5
      +
      stat.recentCount * 6
      +
      stat.segmentCount * 7;


    delete stat.segments;
  }


  return map;
}


/* =========================================================
   TRIPLE STRENGTH
========================================================= */

function tripleKey(
  a,
  b,
  c
) {
  return [
    Number(a),
    Number(b),
    Number(c)
  ]
    .sort(
      (x, y) =>
        x - y
    )
    .join(':');
}


function comboTriples(combo) {
  const out = [];

  for (
    let a = 0;
    a < combo.length - 2;
    a++
  ) {

    for (
      let b = a + 1;
      b < combo.length - 1;
      b++
    ) {

      for (
        let c = b + 1;
        c < combo.length;
        c++
      ) {

        out.push([
          combo[a],
          combo[b],
          combo[c]
        ]);
      }
    }
  }

  return out;
}


function buildTripleStats(
  candidates,
  draws
) {
  const map =
    new Map();


  const triples =
    comboTriples(
      candidates
    );


  for (
    const triple
    of triples
  ) {

    map.set(
      tripleKey(
        ...triple
      ),
      {
        count:
          0,

        weightedCount:
          0,

        recentCount:
          0,

        segments:
          new Set()
      }
    );
  }


  const total =
    Math.max(
      1,
      draws.length
    );


  draws.forEach(
    (draw, index) => {

      const weight =
        0.45 +
        0.55 *
        (
          (index + 1) /
          total
        );


      const segment =
        Math.min(
          3,
          Math.floor(
            index /
            Math.max(
              1,
              total / 4
            )
          )
        );


      for (
        const triple
        of triples
      ) {

        if (
          containsAll(
            draw.numbers,
            triple
          )
        ) {

          const stat =
            map.get(
              tripleKey(
                ...triple
              )
            );


          stat.count++;

          stat.weightedCount +=
            weight;

          stat.segments.add(
            segment
          );


          if (
            index >=
            Math.max(
              0,
              total -
              RECENT_WINDOW
            )
          ) {

            stat.recentCount++;
          }
        }
      }
    }
  );


  for (
    const stat
    of map.values()
  ) {

    stat.segmentCount =
      stat.segments.size;


    stat.score =
      stat.count * 8
      +
      stat.weightedCount * 8
      +
      stat.recentCount * 12
      +
      stat.segmentCount * 12;


    delete stat.segments;
  }


  return map;
}


/* =========================================================
   COMBO RESULT PROFILE
========================================================= */

function resultProfile(
  combo,
  draws
) {
  let exact5 = 0;
  let fourOnly = 0;
  let fourPlus = 0;
  let threeOnly = 0;
  let threePlus = 0;

  let totalHits = 0;

  let weightedStrong =
    0;

  let recentStrong =
    0;

  let longestDry =
    0;

  let currentDry =
    0;

  let strongSegments =
    new Set();


  const total =
    Math.max(
      1,
      draws.length
    );


  draws.forEach(
    (draw, index) => {

      const hits =
        hitCount(
          draw.numbers,
          combo
        );


      totalHits +=
        hits;


      const weight =
        0.50 +
        0.50 *
        (
          (index + 1) /
          total
        );


      const segment =
        Math.min(
          3,
          Math.floor(
            index /
            Math.max(
              1,
              total / 4
            )
          )
        );


      if (hits >= 3) {

        threePlus++;

        strongSegments.add(
          segment
        );

        currentDry = 0;

      } else {

        currentDry++;

        longestDry =
          Math.max(
            longestDry,
            currentDry
          );
      }


      if (hits === 3) {
        threeOnly++;

        weightedStrong +=
          5 * weight;
      }


      if (hits === 4) {
        fourOnly++;
        fourPlus++;

        weightedStrong +=
          32 * weight;
      }


      if (hits >= 5) {
        exact5++;
        fourPlus++;

        weightedStrong +=
          180 * weight;
      }


      if (
        index >=
        Math.max(
          0,
          total -
          RECENT_WINDOW
        )
      ) {

        if (hits === 3) {
          recentStrong +=
            6;
        }

        if (hits === 4) {
          recentStrong +=
            40;
        }

        if (hits >= 5) {
          recentStrong +=
            220;
        }
      }
    }
  );


  return {
    exact5,
    fourOnly,
    fourPlus,
    threeOnly,
    threePlus,

    totalHits,

    averageHits:
      total
        ? totalHits / total
        : 0,

    weightedStrong,

    recentStrong,

    longestDry,

    strongSegmentCount:
      strongSegments.size
  };
}


/* =========================================================
   SYNERGY SCORE
========================================================= */

function synergyScore(
  combo,
  numberStats,
  pairStats,
  tripleStats
) {
  let numberScore = 0;
  let pairScore = 0;
  let tripleScore = 0;


  for (
    const number
    of combo
  ) {

    numberScore +=
      Number(
        numberStats.get(
          Number(number)
        )?.score || 0
      );
  }


  for (
    let i = 0;
    i < combo.length;
    i++
  ) {

    for (
      let j = i + 1;
      j < combo.length;
      j++
    ) {

      pairScore +=
        Number(
          pairStats.get(
            pairKey(
              combo[i],
              combo[j]
            )
          )?.score || 0
        );
    }
  }


  for (
    const triple
    of comboTriples(
      combo
    )
  ) {

    tripleScore +=
      Number(
        tripleStats.get(
          tripleKey(
            ...triple
          )
        )?.score || 0
      );
  }


  return {
    numberScore,
    pairScore,
    tripleScore,

    total:
      numberScore
      +
      pairScore * 1.25
      +
      tripleScore * 1.8
  };
}


/* =========================================================
   WALK-FORWARD TEST
========================================================= */

function splitHistory(draws) {
  const total =
    draws.length;


  let validationSize =
    Math.max(
      10,
      Math.round(
        total *
        VALIDATION_RATIO
      )
    );


  validationSize =
    Math.min(
      validationSize,
      Math.max(
        10,
        total - 10
      )
    );


  const splitIndex =
    Math.max(
      10,
      total -
      validationSize
    );


  return {
    train:
      draws.slice(
        0,
        splitIndex
      ),

    validation:
      draws.slice(
        splitIndex
      )
  };
}


/* =========================================================
   FULL COMBO EVALUATION
========================================================= */

function evaluateCombo({
  combo,
  allDraws,
  trainDraws,
  validationDraws,
  group1,
  group2,
  numberStats,
  pairStats,
  tripleStats
}) {

  const full =
    resultProfile(
      combo,
      allDraws
    );


  const train =
    resultProfile(
      combo,
      trainDraws
    );


  const validation =
    resultProfile(
      combo,
      validationDraws
    );


  const source =
    coverage(
      combo,
      group1,
      group2
    );


  const synergy =
    synergyScore(
      combo,
      numberStats,
      pairStats,
      tripleStats
    );


  const balance =
    Math.min(
      source.from1,
      source.from2
    );


  const validationRate =
    validationDraws.length
      ? validation.threePlus /
        validationDraws.length
      : 0;


  const trainRate =
    trainDraws.length
      ? train.threePlus /
        trainDraws.length
      : 0;


  const stabilityGap =
    Math.abs(
      trainRate -
      validationRate
    );


  /*
    This score is NOT used alone.
    Final ranking is lexicographic below,
    so 5/5 and 4/5 always dominate
    ordinary 3/5 activity.
  */
  const deepScore =
    validation.exact5 * 100000
    +
    validation.fourPlus * 15000
    +
    validation.threePlus * 1700
    +
    validation.recentStrong * 80
    +
    validation.strongSegmentCount * 350
    +
    train.exact5 * 25000
    +
    train.fourPlus * 5000
    +
    train.threePlus * 500
    +
    full.exact5 * 10000
    +
    full.fourPlus * 2200
    +
    full.threePlus * 180
    +
    synergy.total
    +
    balance * 500
    -
    stabilityGap * 5000
    -
    validation.longestDry * 35;


  return {
    numbers:
      combo,

    /*
      Compatibility with current frontend.
    */
    exact5:
      full.exact5,

    fourPlus:
      full.fourPlus,

    threePlus:
      full.threePlus,

    recentStrong:
      full.recentStrong,

    totalHits:
      full.totalHits,

    averageHits:
      full.averageHits,

    fromGroup1:
      source.from1,

    fromGroup2:
      source.from2,

    balance,

    /*
      Deep-analysis details.
    */
    training: {
      draws:
        trainDraws.length,

      exact5:
        train.exact5,

      fourPlus:
        train.fourPlus,

      threePlus:
        train.threePlus,

      averageHits:
        train.averageHits,

      longestDry:
        train.longestDry,

      strongSegments:
        train.strongSegmentCount
    },

    validation: {
      draws:
        validationDraws.length,

      exact5:
        validation.exact5,

      fourPlus:
        validation.fourPlus,

      threePlus:
        validation.threePlus,

      averageHits:
        validation.averageHits,

      longestDry:
        validation.longestDry,

      strongSegments:
        validation.strongSegmentCount
    },

    synergy: {
      numberScore:
        synergy.numberScore,

      pairScore:
        synergy.pairScore,

      tripleScore:
        synergy.tripleScore,

      total:
        synergy.total
    },

    stabilityGap,

    deepScore
  };
}


/* =========================================================
   FINAL RANKING

   Priority:
   1. Validation 5/5
   2. Validation 4/5+
   3. Validation 3/5+
   4. Validation spread/stability
   5. Training 5/5
   6. Training 4/5+
   7. Full-history strength
   8. Pair/triple synergy
========================================================= */

function rankFusion(a, b) {
  return (
    b.validation.exact5 -
      a.validation.exact5

    ||

    b.validation.fourPlus -
      a.validation.fourPlus

    ||

    b.validation.threePlus -
      a.validation.threePlus

    ||

    b.validation.strongSegments -
      a.validation.strongSegments

    ||

    a.validation.longestDry -
      b.validation.longestDry

    ||

    b.training.exact5 -
      a.training.exact5

    ||

    b.training.fourPlus -
      a.training.fourPlus

    ||

    b.training.threePlus -
      a.training.threePlus

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

    a.stabilityGap -
      b.stabilityGap

    ||

    b.synergy.total -
      a.synergy.total

    ||

    b.balance -
      a.balance

    ||

    b.deepScore -
      a.deepScore

    ||

    a.numbers
      .join(',')
      .localeCompare(
        b.numbers.join(',')
      )
  );
}


/* =========================================================
   SELECT FUSION
========================================================= */

async function selectFusion() {

  const [
    group1,
    group2
  ] =
    await Promise.all(
      SOURCE_NAMES.map(
        getByName
      )
    );


  if (
    !group1 ||
    !group2
  ) {

    throw new Error(
      'Manual Group 1 and Manual Group 2 are required first.'
    );
  }


  const n1 =
    uniqueSorted(
      group1.numbers
    );


  const n2 =
    uniqueSorted(
      group2.numbers
    );


  if (
    n1.length !== 5 ||
    n2.length !== 5
  ) {

    throw new Error(
      'Groups 1 and 2 must each contain exactly 5 numbers.'
    );
  }


  const candidates =
    uniqueSorted([
      ...n1,
      ...n2
    ]);


  if (
    candidates.length < 5
  ) {

    throw new Error(
      'Not enough unique source numbers.'
    );
  }


  const latest =
    await getDraw(null);


  await storeDraw(
    latest
  );


  /*
    Only analyze the period where both
    Manual Group 1 and Manual Group 2
    existed together.

    This prevents one group having more
    historical exposure than the other.
  */
  const start =
    Math.max(
      Number(
        group1.start_draw_id || 0
      ),

      Number(
        group2.start_draw_id || 0
      )
    );


  const end =
    Math.min(
      Number(
        group1.last_seen_draw_id
        ||
        latest.id
      ),

      Number(
        group2.last_seen_draw_id
        ||
        latest.id
      ),

      Number(
        latest.id
      )
    );


  if (
    !Number.isFinite(start)
    ||
    !Number.isFinite(end)
    ||
    end <= start
  ) {

    throw new Error(
      'Not enough shared tracked history yet.'
    );
  }


  const fromId =
    Math.max(
      start + 1,

      end -
      MAX_ANALYSIS_DRAWS +
      1
    );


  const rows =
    (
      await db(
        `hotspot_draws?select=draw_id,numbers,bulls_eye,draw_date,draw_time&draw_id=gte.${fromId}&draw_id=lte.${end}&order=draw_id.asc&limit=${MAX_ANALYSIS_DRAWS}`
      )
    ) || [];


  const draws =
    rows
      .filter(
        row =>
          Array.isArray(
            row.numbers
          )
      )
      .map(
        row => ({
          id:
            Number(
              row.draw_id
            ),

          numbers:
            nums(
              row.numbers
            )
        })
      );


  if (
    draws.length <
    MIN_ANALYSIS_DRAWS
  ) {

    throw new Error(
      `Need at least ${MIN_ANALYSIS_DRAWS} shared historical draws before generating Group 3.`
    );
  }


  const {
    train,
    validation
  } =
    splitHistory(
      draws
    );


  /*
    Strength statistics are built ONLY
    from training history.

    The validation block remains unseen
    until each five-number combination
    is tested.
  */
  const numberStats =
    buildNumberStats(
      candidates,
      train
    );


  const pairStats =
    buildPairStats(
      candidates,
      train
    );


  const tripleStats =
    buildTripleStats(
      candidates,
      train
    );


  let combinations =
    combos5(
      candidates
    );


  /*
    Fusion must genuinely combine
    the two manual groups.

    With 5 numbers total,
    minimum 2 must come from each side.
  */
  const balanced =
    combinations.filter(
      combo => {

        const source =
          coverage(
            combo,
            n1,
            n2
          );


        return (
          source.from1 >= 2
          &&
          source.from2 >= 2
        );
      }
    );


  if (
    balanced.length
  ) {
    combinations =
      balanced;
  }


  const ranked =
    combinations
      .map(
        combo =>
          evaluateCombo({
            combo,

            allDraws:
              draws,

            trainDraws:
              train,

            validationDraws:
              validation,

            group1:
              n1,

            group2:
              n2,

            numberStats,

            pairStats,

            tripleStats
          })
      )
      .sort(
        rankFusion
      );


  const best =
    ranked[0];


  if (!best) {

    throw new Error(
      'Unable to generate Group 3.'
    );
  }


  return {
    latest,

    best,

    combinationsTested:
      ranked.length,

    analyzedDraws:
      draws.length,

    trainingDraws:
      train.length,

    validationDraws:
      validation.length,

    analyzedFromDrawId:
      draws[0]?.id,

    analyzedToDrawId:
      draws[
        draws.length - 1
      ]?.id,

    method:
      'manual-fusion-deep-walk-forward-v2'
  };
}


/* =========================================================
   GENERATE
========================================================= */

async function generate() {

  const selection =
    await selectFusion();


  const selected =
    uniqueSorted(
      selection
        .best
        .numbers
    );


  const old =
    await getFusion();


  /*
    If deep analysis still chooses
    exactly the same five numbers,
    preserve the original tracking start.
  */
  if (
    old?.active
    &&
    sameNumbers(
      old.numbers,
      selected
    )
  ) {

    const sync =
      await backfill(
        old,
        selection.latest
      );


    return {
      ok:
        true,

      unchanged:
        true,

      message:
        'Deep analysis still ranks the same Fusion numbers first. Existing tracking was preserved.',

      method:
        selection.method,

      selection: {
        ...selection.best,

        combinationsTested:
          selection
            .combinationsTested,

        analyzedDraws:
          selection
            .analyzedDraws,

        trainingDraws:
          selection
            .trainingDraws,

        validationDraws:
          selection
            .validationDraws,

        analyzedFromDrawId:
          selection
            .analyzedFromDrawId,

        analyzedToDrawId:
          selection
            .analyzedToDrawId
      },

      manual:
        await readFusion(
          old
        ),

      processed:
        sync.processed,

      latest: {
        id:
          selection.latest.id,

        date:
          selection.latest.date,

        time:
          selection.latest.time
      }
    };
  }


  /*
    A new selection means:
    - old Group 3 results are cleared
    - new five numbers are frozen
    - tracking begins AFTER current draw
  */
  if (old) {

    await db(
      `tracker_results?group_id=eq.${old.id}`,
      {
        method:
          'DELETE',

        prefer:
          'return=minimal'
      }
    );


    await db(
      `tracker_groups?id=eq.${old.id}`,
      {
        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {
          numbers:
            selected,

          active:
            true,

          start_draw_id:
            selection.latest.id,

          last_seen_draw_id:
            selection.latest.id
        }
      }
    );

  } else {

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
            selected,

          active:
            true,

          start_draw_id:
            selection.latest.id,

          last_seen_draw_id:
            selection.latest.id
        }
      }
    );
  }


  const current =
    await getFusion();


  return {
    ok:
      true,

    unchanged:
      false,

    message:
      'Deep Fusion Group 3 selected. Tracking starts from future draws only.',

    method:
      selection.method,

    selection: {
      ...selection.best,

      combinationsTested:
        selection
          .combinationsTested,

      analyzedDraws:
        selection
          .analyzedDraws,

      trainingDraws:
        selection
          .trainingDraws,

      validationDraws:
        selection
          .validationDraws,

      analyzedFromDrawId:
        selection
          .analyzedFromDrawId,

      analyzedToDrawId:
        selection
          .analyzedToDrawId
    },

    manual:
      await readFusion(
        current
      ),

    latest: {
      id:
        selection.latest.id,

      date:
        selection.latest.date,

      time:
        selection.latest.time
    }
  };
}


/* =========================================================
   STOP
========================================================= */

async function stop() {

  const group =
    await getFusion();


  if (!group) {

    return {
      ok:
        true,

      message:
        'Manual Group 3 does not exist yet.',

      manual:
        null
    };
  }


  let latest = null;
  let processed = 0;


  if (group.active) {

    latest =
      await getDraw(null);


    await storeDraw(
      latest
    );


    processed =
      (
        await backfill(
          group,
          latest
        )
      ).processed;


    await db(
      `tracker_groups?id=eq.${group.id}`,
      {
        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {
          active:
            false
        }
      }
    );
  }


  return {
    ok:
      true,

    message:
      'Manual Group 3 tracking stopped. Existing results were kept.',

    manual:
      await readFusion(
        await getFusion()
      ),

    processed,

    latest:
      latest
        ? {
            id:
              latest.id,

            date:
              latest.date,

            time:
              latest.time
          }
        : null
  };
}


/* =========================================================
   CLEAR
========================================================= */

async function clear() {

  const group =
    await getFusion();


  if (group) {

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


  return {
    ok:
      true,

    message:
      'Manual Group 3 cleared.',

    manual:
      null
  };
}


/* =========================================================
   STATE
========================================================= */

async function state() {

  const group =
    await getFusion();


  let latest = null;
  let processed = 0;

  let stoppedAtMissing =
    null;


  if (group?.active) {

    latest =
      await getDraw(null);


    await storeDraw(
      latest
    );


    const sync =
      await backfill(
        group,
        latest
      );


    processed =
      sync.processed;


    stoppedAtMissing =
      sync.stoppedAtMissing;
  }


  return {
    ok:
      true,

    manual:
      await readFusion(
        await getFusion()
      ),

    processed,

    stoppedAtMissing,

    latest:
      latest
        ? {
            id:
              latest.id,

            date:
              latest.date,

            time:
              latest.time
          }
        : null
  };
}


/* =========================================================
   API
========================================================= */

module.exports =
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
      req.method === 'GET'
    ) {

      return res
        .status(200)
        .json(
          await state()
        );
    }


    if (
      req.method === 'POST'
    ) {

      const action =
        String(
          req.body?.action
          ||
          'generate'
        )
          .trim()
          .toLowerCase();


      if (
        action ===
        'generate'
      ) {

        return res
          .status(200)
          .json(
            await generate()
          );
      }


      if (
        action ===
        'stop'
      ) {

        return res
          .status(200)
          .json(
            await stop()
          );
      }


      if (
        action ===
        'clear'
      ) {

        return res
          .status(200)
          .json(
            await clear()
          );
      }


      return res
        .status(400)
        .json({
          ok:
            false,

          error:
            'Unknown Fusion Group action.'
        });
    }


    return res
      .status(405)
      .json({
        ok:
          false,

        error:
          'Method not allowed'
      });


  } catch (error) {

    console.error(
      'Fusion Group API error:',
      error
    );


    return res
      .status(500)
      .json({
        ok:
          false,

        error:
          error?.message
          ||
          String(error)
      });
  }
};
