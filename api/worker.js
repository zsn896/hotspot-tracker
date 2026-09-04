const {
  getDraw,
  getMany,
  score,
  db,
  analyzeTopGroups,
  parseDrawMinutes,
  californiaNowParts,
  cycleDateKey
} = require('./lib');

const COLLECTION_DRAWS = 180;
const CONTROL_PREFIX = 'AUTO_CONTROL_';
const AUTO_PREFIX = 'AUTO Group ';
const MANUAL_PREFIX = 'MANUAL Group';
const SPECIAL_NAME = 'AUTO Group Special';

const MAX_BACKFILL = 80;
const TRACKING_BLOCKS = 6;
const MAX_TRACKED_DRAWS =
  TRACKING_BLOCKS * 20;

const SELECTION_MINUTES = 1085;


/* =========================================================
   STORE DRAW
========================================================= */

async function store(d) {
  await db(
    'hotspot_draws?on_conflict=draw_id',
    {
      method: 'POST',

      prefer:
        'resolution=merge-duplicates,return=minimal',

      body: {
        draw_id: d.id,
        draw_date: d.date,
        draw_time: d.time,
        numbers: d.numbers,
        bulls_eye: d.bullsEye
      }
    }
  );
}


/* =========================================================
   AUTOMATIC CLEANUP
========================================================= */

async function cleanupAutoCycle() {

  const groups =
    (
      await db(
        'tracker_groups?select=id,name'
      )
    ) || [];

  const autoCycleGroups =
    groups.filter(
      g => {

        const name =
          String(
            g.name || ''
          );

        return (
          name.startsWith(
            CONTROL_PREFIX
          ) ||
          name.startsWith(
            AUTO_PREFIX
          )
        );
      }
    );

  for (
    const g of autoCycleGroups
  ) {

    await db(
      `tracker_results?group_id=eq.${g.id}`,
      {
        method:
          'DELETE',

        prefer:
          'return=minimal'
      }
    );
  }

  for (
    const g of autoCycleGroups
  ) {

    await db(
      `tracker_groups?id=eq.${g.id}`,
      {
        method:
          'DELETE',

        prefer:
          'return=minimal'
      }
    );
  }
}


/* =========================================================
   AUTOMATIC CONTROL

   IMPORTANT FIX:
   Only AUTO_CONTROL_YYYY-MM-DD is a real daily control.

   Special/Advanced marker rows that merely start with
   AUTO_CONTROL_ are ignored.
========================================================= */

async function getControl() {

  const rows =
    await db(
      `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id,created_at&name=like.${encodeURIComponent(
        CONTROL_PREFIX + '*'
      )}&order=id.desc&limit=20`
    );

  return (
    (rows || []).find(
      r =>
        /^AUTO_CONTROL_\d{4}-\d{2}-\d{2}$/.test(
          String(r.name || '')
        )
    ) ||
    null
  );
}


async function createControl(
  dateKey,
  startId
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
            `${CONTROL_PREFIX}${dateKey}`,

          numbers:
            [1, 2, 3, 4, 5],

          active:
            false,

          start_draw_id:
            startId,

          last_seen_draw_id:
            startId - 1
        }
      }
    );

  return (
    rows?.[0] ||
    null
  );
}


/* =========================================================
   AUTOMATIC GROUPS
========================================================= */

async function getAutoGroups() {

  return (
    (
      await db(
        `tracker_groups?select=id,name,numbers,start_draw_id,last_seen_draw_id&active=eq.true&name=like.${encodeURIComponent(
          AUTO_PREFIX + '*'
        )}&order=id.asc`
      )
    ) || []
  );
}


/* =========================================================
   MANUAL GROUPS
========================================================= */

async function getManualGroups() {

  return (
    (
      await db(
        `tracker_groups?select=id,name,numbers,start_draw_id,last_seen_draw_id&active=eq.true&name=like.${encodeURIComponent(
          MANUAL_PREFIX + '*'
        )}&order=id.asc`
      )
    ) || []
  );
}


/* =========================================================
   UPSERT AUTOMATIC GROUP
========================================================= */

async function upsertAuto(
  slot,
  numbers,
  collectionEndId
) {

  const name =
    `${AUTO_PREFIX}${slot}`;

  const old =
    await db(
      `tracker_groups?select=id&name=eq.${encodeURIComponent(
        name
      )}&order=id.desc&limit=1`
    );

  if (
    old?.[0]
  ) {

    await db(
      `tracker_results?group_id=eq.${old[0].id}`,
      {
        method:
          'DELETE',

        prefer:
          'return=minimal'
      }
    );

    await db(
      `tracker_groups?id=eq.${old[0].id}`,
      {
        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {

          numbers,

          active:
            true,

          start_draw_id:
            collectionEndId,

          last_seen_draw_id:
            collectionEndId
        }
      }
    );

    return old[0].id;
  }

  const x =
    await db(
      'tracker_groups',
      {
        method:
          'POST',

        prefer:
          'return=representation',

        body: {

          name,

          numbers,

          active:
            true,

          start_draw_id:
            collectionEndId,

          last_seen_draw_id:
            collectionEndId
        }
      }
    );

  return (
    x?.[0]?.id
  );
}


/* =========================================================
   SPECIAL GROUP HELPERS
========================================================= */

function combinations(
  values,
  size
) {

  const out = [];

  const a =
    Array.from(
      new Set(
        (values || [])
          .map(Number)
      )
    )
      .filter(
        Number.isFinite
      );

  function walk(
    start,
    picked
  ) {

    if (
      picked.length ===
      size
    ) {

      out.push(
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

  return out;
}


function sameFive(
  a,
  b
) {

  const aa =
    [
      ...new Set(
        (a || [])
          .map(Number)
      )
    ]
      .sort(
        (x, y) =>
          x - y
      );

  const bb =
    [
      ...new Set(
        (b || [])
          .map(Number)
      )
    ]
      .sort(
        (x, y) =>
          x - y
      );

  return (
    aa.length === 5 &&
    bb.length === 5 &&
    aa.every(
      (
        n,
        i
      ) =>
        n === bb[i]
    )
  );
}


function containsAll(
  draw,
  numbers
) {

  const set =
    new Set(
      (
        draw?.numbers ||
        []
      ).map(Number)
    );

  return (
    numbers.every(
      n =>
        set.has(
          Number(n)
        )
    )
  );
}


function buildSpecialGroup(
  draws,
  group1,
  group2
) {

  const history =
    Array.isArray(draws)
      ? draws
      : [];

  const g1 =
    Array.from(
      new Set(
        (group1 || [])
          .map(Number)
      )
    )
      .sort(
        (a, b) =>
          a - b
      );

  const g2 =
    Array.from(
      new Set(
        (group2 || [])
          .map(Number)
      )
    )
      .sort(
        (a, b) =>
          a - b
      );

  if (
    g1.length !== 5 ||
    g2.length !== 5 ||
    history.length < 2
  ) {

    return null;
  }

  const candidates = [];


  function analyzeDirection(
    anchorGroup,
    otherGroup,
    anchorName
  ) {

    for (
      const triple
      of combinations(
        anchorGroup,
        3
      )
    ) {

      const anchorDraws =
        history.filter(
          d =>
            containsAll(
              d,
              triple
            )
        );

      if (
        anchorDraws.length < 2
      ) {

        continue;
      }

      const availableOther =
        otherGroup.filter(
          n =>
            !triple.includes(
              n
            )
        );

      for (
        const pair
        of combinations(
          availableOther,
          2
        )
      ) {

        const numbers =
          [
            ...triple,
            ...pair
          ]
            .sort(
              (a, b) =>
                a - b
            );

        if (
          new Set(
            numbers
          ).size !== 5
        ) {

          continue;
        }

        if (
          sameFive(
            numbers,
            g1
          ) ||
          sameFive(
            numbers,
            g2
          )
        ) {

          continue;
        }

        const firstSupport =
          anchorDraws.filter(
            d =>
              containsAll(
                d,
                [pair[0]]
              )
          ).length;

        const secondSupport =
          anchorDraws.filter(
            d =>
              containsAll(
                d,
                [pair[1]]
              )
          ).length;

        const pairTogetherDraws =
          anchorDraws.filter(
            d =>
              containsAll(
                d,
                pair
              )
          );

        const pairTogether =
          pairTogetherDraws.length;

        if (
          firstSupport < 1 ||
          secondSupport < 1
        ) {

          continue;
        }

        const latestTogetherDrawId =
          pairTogetherDraws.length

            ? Math.max(
                ...pairTogetherDraws.map(
                  d =>
                    Number(
                      d.draw_id ??
                      d.id ??
                      0
                    )
                )
              )

            : Math.max(
                ...anchorDraws.map(
                  d =>
                    Number(
                      d.draw_id ??
                      d.id ??
                      0
                    )
                )
              );

        candidates.push({

          numbers,

          anchorSource:
            anchorName,

          anchorTriple:
            [...triple],

          companionPair:
            [...pair],

          anchorOccurrences:
            anchorDraws.length,

          companionOccurrences:
            [
              firstSupport,
              secondSupport
            ],

          pairTogetherOccurrences:
            pairTogether,

          latestTogetherDrawId,

          minCompanionSupport:
            Math.min(
              firstSupport,
              secondSupport
            ),

          totalCompanionSupport:
            firstSupport +
            secondSupport
        });
      }
    }
  }


  analyzeDirection(
    g1,
    g2,
    'AUTO Group 1'
  );

  analyzeDirection(
    g2,
    g1,
    'AUTO Group 2'
  );


  if (
    !candidates.length
  ) {

    return null;
  }


  const bestByNumbers =
    new Map();


  function better(
    a,
    b
  ) {

    if (
      !b
    ) {

      return true;
    }

    return (

      a.pairTogetherOccurrences >
      b.pairTogetherOccurrences

      ||

      (
        a.pairTogetherOccurrences ===
        b.pairTogetherOccurrences
        &&
        a.minCompanionSupport >
        b.minCompanionSupport
      )

      ||

      (
        a.pairTogetherOccurrences ===
        b.pairTogetherOccurrences
        &&
        a.minCompanionSupport ===
        b.minCompanionSupport
        &&
        a.totalCompanionSupport >
        b.totalCompanionSupport
      )

      ||

      (
        a.pairTogetherOccurrences ===
        b.pairTogetherOccurrences
        &&
        a.minCompanionSupport ===
        b.minCompanionSupport
        &&
        a.totalCompanionSupport ===
        b.totalCompanionSupport
        &&
        a.anchorOccurrences >
        b.anchorOccurrences
      )

      ||

      (
        a.pairTogetherOccurrences ===
        b.pairTogetherOccurrences
        &&
        a.minCompanionSupport ===
        b.minCompanionSupport
        &&
        a.totalCompanionSupport ===
        b.totalCompanionSupport
        &&
        a.anchorOccurrences ===
        b.anchorOccurrences
        &&
        a.latestTogetherDrawId >
        b.latestTogetherDrawId
      )
    );
  }


  for (
    const c of candidates
  ) {

    const key =
      c.numbers.join(',');

    const old =
      bestByNumbers.get(
        key
      );

    if (
      better(
        c,
        old
      )
    ) {

      bestByNumbers.set(
        key,
        c
      );
    }
  }


  const ranked =
    Array.from(
      bestByNumbers.values()
    )
      .sort(
        (
          a,
          b
        ) => {

          return (
            b.pairTogetherOccurrences -
            a.pairTogetherOccurrences

            ||

            b.minCompanionSupport -
            a.minCompanionSupport

            ||

            b.totalCompanionSupport -
            a.totalCompanionSupport

            ||

            b.anchorOccurrences -
            a.anchorOccurrences

            ||

            b.latestTogetherDrawId -
            a.latestTogetherDrawId
          );
        }
      );

  return (
    ranked[0] ||
    null
  );
}


/* =========================================================
   DATE HELPERS
========================================================= */

function drawDateKey(
  dateText
) {

  const d =
    new Date(
      String(
        dateText ||
        ''
      ) +
      ' 12:00:00 UTC'
    );

  if (
    Number.isNaN(
      d.getTime()
    )
  ) {

    return null;
  }

  return (
    `${d.getUTCFullYear()}-${String(
      d.getUTCMonth() + 1
    ).padStart(
      2,
      '0'
    )}-${String(
      d.getUTCDate()
    ).padStart(
      2,
      '0'
    )}`
  );
}


/* =========================================================
   FIND 6:00 AM START
========================================================= */

async function findCycleStart(
  latest,
  now
) {

  const mins =
    parseDrawMinutes(
      latest.time
    );

  if (
    mins == null ||
    mins < 360
  ) {

    return null;
  }

  const estimate =
    latest.id -
    Math.floor(
      (
        mins - 360
      ) / 4
    );

  const from =
    Math.max(
      1,
      estimate - 20
    );

  const to =
    Math.min(
      latest.id,
      estimate + 20
    );

  if (
    to < from
  ) {

    return null;
  }

  const ids =
    Array.from(
      {
        length:
          to - from + 1
      },
      (
        _,
        i
      ) =>
        from + i
    );

  const ds =
    await getMany(
      ids
    );

  const candidates =
    ds.filter(
      d =>
        drawDateKey(
          d.date
        ) ===
        now.dateKey
        &&
        parseDrawMinutes(
          d.time
        ) != null
        &&
        parseDrawMinutes(
          d.time
        ) >= 360
        &&
        parseDrawMinutes(
          d.time
        ) <= 1080
    );

  return (
    candidates.find(
      d =>
        parseDrawMinutes(
          d.time
        ) === 360
    )
    ||
    candidates
      .sort(
        (
          a,
          b
        ) =>
          parseDrawMinutes(
            a.time
          ) -
          parseDrawMinutes(
            b.time
          )
          ||
          a.id -
          b.id
      )[0]
    ||
    null
  );
}


/* =========================================================
   COLLECTION WINDOW
========================================================= */

function inCollectionWindow(
  d,
  key
) {

  const m =
    parseDrawMinutes(
      d.draw_time ??
      d.time
    );

  return (
    drawDateKey(
      d.draw_date ??
      d.date
    ) === key
    &&
    m != null
    &&
    m >= 360
    &&
    m <= 1080
  );
}


/* =========================================================
   BACKFILL
========================================================= */

async function backfill(
  control,
  latest
) {

  let after =
    Number(
      control.last_seen_draw_id ??
      (
        control.start_draw_id -
        1
      )
    );

  if (
    after >=
    latest.id
  ) {

    await store(
      latest
    );

    return 0;
  }

  const end =
    Math.min(
      latest.id,
      after +
      MAX_BACKFILL
    );

  const ids =
    Array.from(
      {
        length:
          end - after
      },
      (
        _,
        i
      ) =>
        after + i + 1
    );

  const ds =
    await getMany(
      ids
    );

  for (
    const d of ds
  ) {

    await store(
      d
    );
  }

  const last =
    ds.at(-1)?.id ??
    after;

  await db(
    `tracker_groups?id=eq.${control.id}`,
    {
      method:
        'PATCH',

      prefer:
        'return=minimal',

      body: {
        last_seen_draw_id:
          last
      }
    }
  );

  control.last_seen_draw_id =
    last;

  return ds.length;
}


/* =========================================================
   REPAIR COLLECTION
========================================================= */

async function repairCollection(
  control,
  key
) {

  const startId =
    Number(
      control.start_draw_id
    );

  const expectedIds =
    Array.from(
      {
        length:
          COLLECTION_DRAWS
      },
      (
        _,
        i
      ) =>
        startId + i
    );

  const existing =
    (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=gte.${startId}&draw_id=lte.${startId + COLLECTION_DRAWS - 1}&order=draw_id.asc`
      )
    ) || [];

  const have =
    new Set(
      existing
        .filter(
          d =>
            inCollectionWindow(
              d,
              key
            )
        )
        .map(
          d =>
            Number(
              d.draw_id
            )
        )
    );

  const missing =
    expectedIds.filter(
      id =>
        !have.has(
          id
        )
    );

  if (
    !missing.length
  ) {

    return 0;
  }

  const ds =
    await getMany(
      missing
    );

  let repaired =
    0;

  for (
    const d of ds
  ) {

    if (
      inCollectionWindow(
        d,
        key
      )
    ) {

      await store(
        d
      );

      repaired++;
    }
  }

  return repaired;
}


/* =========================================================
   LOAD TRACKING DRAWS
========================================================= */

async function loadDrawRange(
  after,
  end
) {

  let cached =
    (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gt.${after}&draw_id=lte.${end}&order=draw_id.asc`
      )
    ) || [];

  if (
    cached.length <
    end - after
  ) {

    const have =
      new Set(
        cached.map(
          d =>
            Number(
              d.draw_id
            )
        )
      );

    const missing =
      [];

    for (
      let id =
        after + 1;
      id <= end;
      id++
    ) {

      if (
        !have.has(
          id
        )
      ) {

        missing.push(
          id
        );
      }
    }

    if (
      missing.length
    ) {

      const ds =
        await getMany(
          missing
        );

      for (
        const d of ds
      ) {

        await store(
          d
        );
      }

      cached =
        (
          await db(
            `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gt.${after}&draw_id=lte.${end}&order=draw_id.asc`
          )
        ) || [];
    }
  }

  return cached;
}


/* =========================================================
   AUTOMATIC TRACKING
========================================================= */

async function processTracking(
  groups,
  latest
) {

  let processed =
    0;

  const details =
    [];

  for (
    const g of groups
  ) {

    const after =
      Number(
        g.last_seen_draw_id ??
        g.start_draw_id
      );

    const trackingCap =
      Number(
        g.start_draw_id
      ) +
      MAX_TRACKED_DRAWS;

    if (
      after >= latest.id ||
      after >= trackingCap
    ) {

      details.push({
        group:
          g.name,

        processed:
          0,

        lastSeen:
          after,

        capReached:
          after >=
          trackingCap
      });

      continue;
    }

    const end =
      Math.min(
        latest.id,
        after +
        MAX_BACKFILL,
        trackingCap
      );

    const cached =
      await loadDrawRange(
        after,
        end
      );

    for (
      const d of cached
    ) {

      const s =
        score(
          {
            numbers:
              d.numbers,

            bullsEye:
              d.bulls_eye
          },
          g.numbers
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
              g.id,

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

    const last =
      cached.at(-1)
        ?.draw_id ??
      after;

    await db(
      `tracker_groups?id=eq.${g.id}`,
      {
        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {
          last_seen_draw_id:
            last
        }
      }
    );

    processed +=
      cached.length;

    details.push({

      group:
        g.name,

      processed:
        cached.length,

      lastSeen:
        last
    });
  }

  return {
    processed,
    details
  };
}


/* =========================================================
   MANUAL TRACKING
========================================================= */

async function processManualTracking(
  groups,
  latest
) {

  let processed =
    0;

  for (
    const g of groups
  ) {

    const after =
      Number(
        g.last_seen_draw_id ??
        g.start_draw_id
      );

    if (
      after >=
      latest.id
    ) {

      continue;
    }

    const end =
      Math.min(
        latest.id,
        after +
        MAX_BACKFILL
      );

    const cached =
      await loadDrawRange(
        after,
        end
      );

    for (
      const d of cached
    ) {

      const s =
        score(
          {
            numbers:
              d.numbers,

            bullsEye:
              d.bulls_eye
          },
          g.numbers
        );

      if (
        s.count >= 3
      ) {

        await db(
          'tracker_results?on_conflict=group_id,draw_id',
          {
            method:
              'POST',

            prefer:
              'resolution=merge-duplicates,return=minimal',

            body: {

              group_id:
                g.id,

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
    }

    const last =
      cached.at(-1)
        ?.draw_id ??
      after;

    await db(
      `tracker_groups?id=eq.${g.id}`,
      {
        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {
          last_seen_draw_id:
            last
        }
      }
    );

    processed +=
      cached.length;
  }

  return processed;
}


/* =========================================================
   WORKER
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

    if (
      process.env
        .WORKER_SECRET
    ) {

      const token =
        req.headers[
          'x-worker-secret'
        ]
        ||
        req.query.secret;

      if (
        token !==
        process.env
          .WORKER_SECRET
      ) {

        return res
          .status(401)
          .json({
            ok:
              false,

            error:
              'Unauthorized'
          });
      }
    }


    const now =
      californiaNowParts();


    /* =====================================================
       DAILY CLEANUP
    ===================================================== */

    if (
      now.minutes >= 150 &&
      now.minutes < 360
    ) {

      await cleanupAutoCycle();

      return res
        .status(200)
        .json({

          ok:
            true,

          mode:
            'cleanup',

          message:
            'Automatic daily cycle cleared. Manual groups and manual 3+/5 history were preserved.',

          source:
            'California Lottery official'
        });
    }


    if (
      now.minutes >= 120 &&
      now.minutes < 150
    ) {

      return res
        .status(200)
        .json({

          ok:
            true,

          mode:
            'idle',

          message:
            'Automatic tracking cycle ended at 2:00 AM. Cleanup is scheduled for 2:30 AM.',

          source:
            'California Lottery official'
        });
    }


    /* =====================================================
       GET REAL DAILY CONTROL
    ===================================================== */

    let control =
      await getControl();

    const cycleKey =
      cycleDateKey(
        now
      );


    if (
      control &&
      !String(
        control.name
      ).endsWith(
        cycleKey
      )
    ) {

      await cleanupAutoCycle();

      control =
        null;
    }


    /* =====================================================
       LATEST OFFICIAL DRAW
    ===================================================== */

    const latest =
      await getDraw(
        null
      );

    await store(
      latest
    );


    /* =====================================================
       MANUAL GROUPS
    ===================================================== */

    const manualGroups =
      await getManualGroups();

    const manualProcessed =
      await processManualTracking(
        manualGroups,
        latest
      );


    /* =====================================================
       CREATE DAILY CONTROL
    ===================================================== */

    if (
      !control
    ) {

      const first =
        await findCycleStart(
          latest,
          now
        );

      if (
        !first
      ) {

        return res
          .status(200)
          .json({

            ok:
              true,

            mode:
              'collecting',

            collection: {
              have:
                0,

              need:
                COLLECTION_DRAWS,

              remaining:
                COLLECTION_DRAWS
            },

            latest: {
              id:
                latest.id,

              time:
                latest.time
            },

            stored:
              0,

            activeGroups:
              0,

            processed:
              0,

            manualProcessed,

            message:
              'Waiting for the official 6:00 AM draw.',

            source:
              'California Lottery official'
          });
      }


      control =
        await createControl(
          cycleKey,
          first.id
        );

      await store(
        first
      );
    }


    /* =====================================================
       VALIDATE 6:00 AM CONTROL
    ===================================================== */

    if (
      now.minutes >= 360 &&
      now.minutes <
      SELECTION_MINUTES
    ) {

      const controlDateKey =
        String(
          control.name
        ).replace(
          CONTROL_PREFIX,
          ''
        );

      const startDraw =
        await getDraw(
          Number(
            control.start_draw_id
          )
        );

      const startMinutes =
        parseDrawMinutes(
          startDraw.time
        );

      if (
        !inCollectionWindow(
          startDraw,
          controlDateKey
        )
        ||
        startMinutes !== 360
      ) {

        await cleanupAutoCycle();

        const first =
          await findCycleStart(
            latest,
            now
          );

        if (
          !first
        ) {

          return res
            .status(200)
            .json({

              ok:
                true,

              mode:
                'collecting',

              collection: {
                have:
                  0,

                need:
                  COLLECTION_DRAWS,

                remaining:
                  COLLECTION_DRAWS
              },

              latest: {
                id:
                  latest.id,

                time:
                  latest.time
              },

              stored:
                0,

              activeGroups:
                0,

              processed:
                0,

              manualProcessed,

              message:
                'Waiting for the exact official 6:00 AM draw.',

              source:
                'California Lottery official'
            });
        }


        control =
          await createControl(
            cycleKey,
            first.id
          );

        await store(
          first
        );
      }
    }


    /* =====================================================
       STORE MISSING DRAWS
    ===================================================== */

    const stored =
      await backfill(
        control,
        latest
      );


    const collectionDateKey =
      String(
        control.name
      ).replace(
        CONTROL_PREFIX,
        ''
      );


    let repaired =
      0;


    if (
      now.minutes >= 1080
    ) {

      repaired =
        await repairCollection(
          control,
          collectionDateKey
        );
    }


    /* =====================================================
       LOAD COLLECTION
    ===================================================== */

    const rawHistory =
      (
        await db(
          `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gte.${control.start_draw_id}&order=draw_id.asc&limit=220`
        )
      ) || [];


    const history =
      rawHistory.filter(
        d =>
          inCollectionWindow(
            d,
            collectionDateKey
          )
      );


    const collectionEndId =
      history.at(-1)
        ?.draw_id
      ??
      Number(
        control.start_draw_id
      );


    /* =====================================================
       COLLECTION PERIOD
    ===================================================== */

    if (
      now.minutes >= 360 &&
      now.minutes <
      SELECTION_MINUTES
    ) {

      const have =
        Math.min(
          history.length,
          COLLECTION_DRAWS
        );

      return res
        .status(200)
        .json({

          ok:
            true,

          mode:
            now.minutes < 1080
              ? 'collecting'
              : 'preparing',

          collection: {

            have,

            need:
              COLLECTION_DRAWS,

            remaining:
              Math.max(
                0,
                COLLECTION_DRAWS -
                have
              )
          },

          latest: {

            id:
              latest.id,

            time:
              latest.time
          },

          stored,

          repaired,

          activeGroups:
            0,

          processed:
            0,

          manualProcessed,

          message:
            now.minutes >= 1080
              ? 'Collection finished. Waiting until 6:05 PM before automatic selection.'
              : undefined,

          source:
            'California Lottery official'
        });
    }


    /* =====================================================
       REQUIRE COMPLETE 180 DRAWS
    ===================================================== */

    if (
      history.length <
      COLLECTION_DRAWS
    ) {

      return res
        .status(200)
        .json({

          ok:
            true,

          mode:
            'preparing',

          collection: {

            have:
              history.length,

            need:
              COLLECTION_DRAWS,

            remaining:
              COLLECTION_DRAWS -
              history.length
          },

          latest: {

            id:
              latest.id,

            time:
              latest.time
          },

          stored,

          repaired,

          activeGroups:
            0,

          processed:
            0,

          manualProcessed,

          message:
            `Waiting for complete collection: ${history.length}/${COLLECTION_DRAWS}. No groups will be selected until all 180 official draws are present.`,

          source:
            'California Lottery official'
        });
    }


    /* =====================================================
       USE EXACTLY FIRST 180 DRAWS
    ===================================================== */

    const completeHistory =
      history
        .sort(
          (
            a,
            b
          ) =>
            a.draw_id -
            b.draw_id
        )
        .slice(
          0,
          COLLECTION_DRAWS
        );


    const finalCollectionEndId =
      completeHistory
        .at(-1)
        ?.draw_id
      ??
      collectionEndId;


    /* =====================================================
       AUTOMATIC GROUP 1 + GROUP 2
    ===================================================== */

    let groups =
      await getAutoGroups();


    let selected =
      null;


    let specialSelected =
      null;


    let group1 =
      groups.find(
        g =>
          g.name ===
          `${AUTO_PREFIX}1`
      )
      ||
      null;


    let group2 =
      groups.find(
        g =>
          g.name ===
          `${AUTO_PREFIX}2`
      )
      ||
      null;


    if (
      !group1
      ||
      !group2
    ) {

      selected =
        analyzeTopGroups(
          completeHistory,
          2
        );


      if (
        selected.length !== 2
      ) {

        throw Error(
          'Could not identify two repeated 5-number groups from the complete 180-draw collection.'
        );
      }


      await upsertAuto(
        1,
        selected[0].numbers,
        finalCollectionEndId
      );


      await upsertAuto(
        2,
        selected[1].numbers,
        finalCollectionEndId
      );


      groups =
        await getAutoGroups();


      group1 =
        groups.find(
          g =>
            g.name ===
            `${AUTO_PREFIX}1`
        )
        ||
        null;


      group2 =
        groups.find(
          g =>
            g.name ===
            `${AUTO_PREFIX}2`
        )
        ||
        null;
    }


    /* =====================================================
       SPECIAL GROUP
    ===================================================== */

    const existingSpecial =
      groups.find(
        g =>
          g.name ===
          SPECIAL_NAME
      )
      ||
      null;


    if (
      !existingSpecial
      &&
      group1
      &&
      group2
    ) {

      specialSelected =
        buildSpecialGroup(
          completeHistory,
          group1.numbers,
          group2.numbers
        );


      if (
        specialSelected
          ?.numbers
          ?.length === 5
      ) {

        await upsertAuto(
          'Special',
          specialSelected.numbers,
          finalCollectionEndId
        );


        groups =
          await getAutoGroups();
      }
    }


    /* =====================================================
       AUTOMATIC TRACKING

       This tracks ALL active automatic groups:
       Group 1
       Group 2
       Special
       Advanced
    ===================================================== */

    const tracking =
      await processTracking(
        groups,
        latest
      );


    /* =====================================================
       RESPONSE
    ===================================================== */

    return res
      .status(200)
      .json({

        ok:
          true,

        mode:
          'tracking',

        collection: {

          have:
            completeHistory.length,

          need:
            COLLECTION_DRAWS,

          remaining:
            0
        },

        latest: {

          id:
            latest.id,

          time:
            latest.time
        },

        stored,

        repaired,

        activeGroups:
          groups.length,

        selected,

        specialSelected,

        processed:
          tracking.processed,

        manualProcessed,

        details:
          tracking.details,

        source:
          'California Lottery official'
      });


  } catch (
    e
  ) {

    res
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
