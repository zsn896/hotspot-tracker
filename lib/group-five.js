'use strict';

const {
  db,
  score,
  analyzeTopGroups
} = require('../api/lib');

const CONTROL_PREFIX = 'AUTO_CONTROL_';
const GROUP_NAME = 'AUTO Group Five';

const ANALYSIS_DRAWS = 30;
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
   REAL DAILY CONTROL

   IMPORTANT:
   Ignore Special / Advanced marker rows.
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
   CURRENT ACTIVE GROUP FIVE
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
   LOAD ALL DRAWS OF CURRENT DAILY CYCLE
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
   FALLBACK SELECTION

   Only used if normal analyzeTopGroups
   cannot return five numbers.
========================================================= */

function fallbackFive(
  draws
) {

  const counts =
    new Map();

  for (
    const d
    of draws
  ) {

    for (
      const n
      of norm(
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
   SELECT FIVE NUMBERS FROM EXACTLY 30 DRAWS
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
        ?.numbers
      ||
      []
    );


  /*
    Use the same proven analysis
    engine already available
    in api/lib.js.
  */

  if (
    numbers.length === 5
  ) {

    return {

      numbers,

      method:
        '30-draw rolling analyzeTopGroups'
    };
  }


  /*
    Safety fallback.
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
      '30-draw rolling frequency fallback'
  };
}


/* =========================================================
   GET LAST 30 DRAWS ENDING AT A SPECIFIC DRAW
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
   CREATE CURRENT GROUP FIVE
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

          /*
            Selection is completed
            at this draw.

            Tracking begins AFTER it.
          */

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
   ARCHIVE OLD 20-DRAW VERSION

   Results remain attached to the correct
   old numbers and cannot mix with new numbers.
========================================================= */

async function archiveGroup(
  group
) {

  const archiveName =
    `${GROUP_NAME} Archive ${group.start_draw_id}`;

  await db(
    `tracker_groups?id=eq.${group.id}`,
    {

      method:
        'PATCH',

      prefer:
        'return=minimal',

      body: {

        name:
          archiveName,

        active:
          false
      }
    }
  );
}


/* =========================================================
   REMOVE ANY ACCIDENTAL OVERFLOW

   worker.js may occasionally catch several draws
   at once. Group Five must NEVER evaluate more
   than its exact 20 future draws.
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
   TRACK CURRENT NUMBERS

   Maximum = exactly 20 future draws.
========================================================= */

async function trackGroup(
  group,
  draws,
  endId
) {

  const after =
    Number(
      group.last_seen_draw_id
      ??
      group.start_draw_id
    );

  const cap =
    Number(
      group.start_draw_id
    )
    +
    TRACK_DRAWS;

  const target =
    Math.min(
      Number(
        endId
      ),
      cap
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
        after >= cap
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
      ) >= cap
  };
}


/* =========================================================
   GROUP FIVE ENGINE

   LOGIC:

   First selection:
   latest 30 available draws.

   Then:
   track exactly 20 future draws.

   After those 20:
   take latest 30 ending at draw #20.

   This equals:

   latest 20 new draws
   +
   previous 10 draws.

   Then select new five numbers.

   Repeat all day.
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
    Do absolutely nothing
    before first 30 draws exist.
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
     FIRST SELECTION

     Use latest 30 draws available.

     Normally tomorrow this occurs
     immediately when draw #30 arrives.

     If code is deployed in the middle
     of an existing day, it starts
     prospectively from NOW instead
     of pretending old results were predictions.
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
          'Unable to select five numbers from 30 draws'
      };
    }


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
      draws.at(-1)
        .draw_id
    );


  /*
    Loop allows safe recovery if Cron
    was delayed and multiple 20-draw
    periods need processing.
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

    const cap =
      startId +
      TRACK_DRAWS;


    const tracked =
      await trackGroup(
        group,
        draws,
        latestId
      );


    processed +=
      tracked.processed;


    /*
      Current 20-draw test
      has not finished yet.
    */

    if (
      latestId < cap
    ) {

      break;
    }


    /*
      Exact hard boundary = 20.
    */

    await deleteOverflowResults(
      group.id,
      cap
    );


    await db(
      `tracker_groups?id=eq.${group.id}`,
      {

        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {

          last_seen_draw_id:
            cap
        }
      }
    );


    /*
      Now take the latest 30 draws
      ending EXACTLY where the
      20-draw test ended.

      Therefore:

      10 older
      +
      20 just completed
      =
      30 analysis draws.
    */

    const window =
      getWindowEndingAt(
        draws,
        cap
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
      Preserve old results with
      the old five numbers.
    */

    await archiveGroup(
      group
    );


    /*
      New five numbers begin
      AFTER the current cutoff draw.
    */

    group =
      await createGroup(
        pick.numbers,
        cap
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

    method:
      method
      ||
      '30-draw rolling analyzeTopGroups'
  };
}


module.exports = {
  runGroupFive
};
