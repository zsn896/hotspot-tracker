'use strict';

const {
  db,
  score,
  analyzeTopGroups
} = require('../api/lib');

const CONTROL_PREFIX =
  'AUTO_CONTROL_';

const GROUP_NAME =
  'AUTO Group Five';

const ARCHIVE_PREFIX =
  'AUTO Group Five Archive ';

/*
  GROUP FIVE RULE

  Analyze latest 50 draws
  Track next 20 future draws
  Clear old cycle results
  Analyze latest 50 again
  Repeat
*/

const ANALYSIS_DRAWS = 50;
const TRACK_DRAWS = 20;


/* =========================================================
   NORMALIZE NUMBERS
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
        Number.isInteger(n) &&
        n >= 1 &&
        n <= 80
    )
    .sort(
      (a, b) =>
        a - b
    );
}


/* =========================================================
   GET DAILY CONTROL
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
   GET CURRENT ACTIVE GROUP FIVE
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
   GET CURRENT CYCLE DRAWS
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
   FALLBACK FIVE NUMBERS
========================================================= */

function fallbackFive(draws) {

  const counts =
    new Map();


  for (
    const d of draws
  ) {

    for (
      const n of norm(
        d.numbers
      )
    ) {

      counts.set(
        n,
        (
          counts.get(n) ||
          0
        ) + 1
      );
    }
  }


  return [
    ...counts.entries()
  ]
    .sort(
      (a, b) =>
        b[1] - a[1]
        ||
        a[0] - b[0]
    )
    .slice(
      0,
      5
    )
    .map(
      ([n]) =>
        n
    )
    .sort(
      (a, b) =>
        a - b
    );
}


/* =========================================================
   SELECT FIVE FROM LAST 50 DRAWS
========================================================= */

function selectFive(
  windowDraws
) {

  const selected =
    analyzeTopGroups(
      windowDraws,
      1
    );


  const numbers =
    norm(
      selected?.[0]
        ?.numbers ||
      []
    );


  if (
    numbers.length === 5
  ) {

    return {

      numbers,

      method:
        '50-draw rolling analyzeTopGroups'
    };
  }


  /*
    Fallback in case advanced analyzer
    does not return exactly five numbers.
  */

  const fallback =
    fallbackFive(
      windowDraws
    );


  if (
    fallback.length !== 5
  ) {

    return null;
  }


  return {

    numbers:
      fallback,

    method:
      '50-draw rolling frequency fallback'
  };
}


/* =========================================================
   GET LAST 50 DRAWS ENDING AT SPECIFIC DRAW
========================================================= */

function getWindowEndingAt(
  draws,
  endId
) {

  return draws

    .filter(
      d =>
        Number(
          d.draw_id
        )
        <=
        Number(
          endId
        )
    )

    .slice(
      -ANALYSIS_DRAWS
    );
}


/* =========================================================
   CREATE GROUP FIVE
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

          numbers,

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


/* =========================================================
   CLEAR OLD RESULTS AND ARCHIVE GROUP
========================================================= */

async function archiveGroupAndClearResults(
  group
) {

  /*
    Delete all results belonging
    to the completed Group Five cycle.
  */

  await db(
    `tracker_results?group_id=eq.${group.id}`,
    {

      method:
        'DELETE',

      prefer:
        'return=minimal'
    }
  );


  /*
    Keep only the old group marker
    so cycle count can still be known.
  */

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
   REMOVE ACCIDENTAL RESULTS ABOVE 20
========================================================= */

async function deleteOverflowResults(
  groupId,
  cutoffId
) {

  await db(
    `tracker_results?group_id=eq.${groupId}&draw_id=gt.${Number(
      cutoffId
    )}`,
    {

      method:
        'DELETE',

      prefer:
        'return=minimal'
    }
  );
}


/* =========================================================
   TRACK FUTURE DRAWS
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


  /*
    Group Five can only track
    twenty future draws.
  */

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
    const d of pending
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
   GROUP FIVE ENGINE

   RULE

   1. Read latest 50 draws.
   2. Analyze those 50 draws.
   3. Select exactly 5 numbers.
   4. Track those same numbers for
      exactly 20 FUTURE draws.
   5. When 20 future draws finish:
      - clear old results
      - archive old group marker
      - take the latest 50 draws
        ending at that cutoff
      - analyze them
      - select new five numbers
   6. Track new numbers for next 20.
   7. Repeat continuously.
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


  /*
    First selection cannot happen
    until 50 draws exist.
  */

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
        draws.length
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


  let method =
    null;


  /* =======================================================
     FIRST 50-DRAW ANALYSIS
  ======================================================= */

  if (
    !group
  ) {

    const firstWindow =
      draws.slice(
        -ANALYSIS_DRAWS
      );


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
          'Unable to select five numbers from latest 50 draws'
      };
    }


    /*
      The selection occurs immediately
      after the last draw used in analysis.

      Therefore only later draws count
      toward the 20-draw test.
    */

    const startId =
      Number(
        firstWindow
          .at(-1)
          .draw_id
      );


    group =
      await createGroup(
        pick.numbers,
        startId
      );


    created =
      true;


    method =
      pick.method;
  }


  if (
    !group
  ) {

    return {

      ok:
        false,

      active:
        false,

      error:
        'Unable to create Group Five'
    };
  }


  const latestId =
    Number(
      draws
        .at(-1)
        .draw_id
    );


  /*
    The loop allows the worker
    to catch up if cron was delayed.
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
      startId +
      TRACK_DRAWS;


    /*
      Track current five numbers
      up to maximum 20 future draws.
    */

    const tracked =
      await trackGroup(
        group,
        draws,
        latestId
      );


    processed +=
      tracked.processed;


    /*
      Still inside current
      twenty-draw tracking window.
    */

    if (
      latestId <
      cutoff
    ) {

      break;
    }


    /*
      Safety:
      never retain results past
      the twentieth future draw.
    */

    await deleteOverflowResults(
      group.id,
      cutoff
    );


    /*
      At the end of the 20-draw cycle,
      analyze the latest 50 draws
      ending exactly at the cutoff.
    */

    const window =
      getWindowEndingAt(
        draws,
        cutoff
      );


    if (
      window.length <
      ANALYSIS_DRAWS
    ) {

      break;
    }


    const pick =
      selectFive(
        window
      );


    if (
      !pick
    ) {

      break;
    }


    /*
      Old cycle is now complete.
      Remove its results.
    */

    await archiveGroupAndClearResults(
      group
    );


    /*
      New five numbers begin after
      the cutoff draw.

      They will only be compared
      against future draws.
    */

    group =
      await createGroup(
        pick.numbers,
        cutoff
      );


    rotated++;


    method =
      pick.method;


    if (
      !group
    ) {

      break;
    }
  }


  return {

    ok:
      true,

    active:
      true,

    created,

    rotated,

    processed,

    groupId:
      group?.id ||
      null,

    numbers:
      group?.numbers ||
      null,

    analysisWindow:
      ANALYSIS_DRAWS,

    trackingWindow:
      TRACK_DRAWS,

    startDrawId:
      group?.start_draw_id ||
      null,

    lastSeenDrawId:
      group?.last_seen_draw_id ||
      null,

    nextSelectionAfterDrawId:
      group
        ?
        Number(
          group.start_draw_id
        )
        +
        TRACK_DRAWS
        :
        null,

    method,

    rule:
      'Analyze latest 50 draws, select five numbers, track next 20 future draws, clear old cycle results, then analyze latest 50 and repeat.'
  };
}


module.exports = {
  runGroupFive
};
