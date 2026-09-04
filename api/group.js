'use strict';

const {
  getDraw,
  getMany,
  db,
  score
} = require('./lib');

const MANUAL_NAMES = {
  1: 'MANUAL Group',
  2: 'MANUAL Group 2'
};

const MAX_BACKFILL = 80;


/* =========================================================
   HELPERS
========================================================= */

function normalizeSlot(value) {
  const slot =
    Number(
      value ?? 1
    );

  if (
    slot !== 1 &&
    slot !== 2
  ) {
    throw new Error(
      'Manual slot must be 1 or 2.'
    );
  }

  return slot;
}


function getManualName(slot) {
  return MANUAL_NAMES[
    normalizeSlot(slot)
  ];
}


function validateNumbers(input) {
  const nums =
    Array.isArray(input)
      ? input.map(Number)
      : [];

  if (
    nums.length !== 5
  ) {
    throw new Error(
      'Enter exactly 5 numbers.'
    );
  }

  if (
    nums.some(
      n =>
        !Number.isInteger(n) ||
        n < 1 ||
        n > 80
    )
  ) {
    throw new Error(
      'Each number must be from 1 to 80.'
    );
  }

  if (
    new Set(nums).size !== 5
  ) {
    throw new Error(
      'The 5 numbers must be different.'
    );
  }

  return [...nums].sort(
    (a, b) =>
      a - b
  );
}


function sameNumbers(a, b) {
  const aa =
    Array.isArray(a)
      ? a
          .map(Number)
          .sort(
            (x, y) =>
              x - y
          )
      : [];

  const bb =
    Array.isArray(b)
      ? b
          .map(Number)
          .sort(
            (x, y) =>
              x - y
          )
      : [];

  return (
    aa.length === 5 &&
    bb.length === 5 &&
    aa.every(
      (n, i) =>
        n === bb[i]
    )
  );
}


/* =========================================================
   DRAW STORAGE
========================================================= */

async function storeDraw(draw) {
  if (
    !draw?.id
  ) {
    return;
  }

  await db(
    'hotspot_draws?on_conflict=draw_id',
    {
      method:
        'POST',

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


/* =========================================================
   MANUAL GROUP DATABASE
========================================================= */

async function getManual(slot) {
  const name =
    getManualName(
      slot
    );

  const rows =
    await db(
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=eq.${encodeURIComponent(
        name
      )}&order=id.desc&limit=1`
    );

  return (
    rows?.[0] ||
    null
  );
}


/* =========================================================
   SAFE DRAW FETCH

   First try the batch result.
   If one draw is missing, retry that draw individually.
========================================================= */

async function getSafeDraw(
  id,
  batchMap
) {
  const fromBatch =
    batchMap.get(
      Number(id)
    );

  if (
    fromBatch?.id
  ) {
    return fromBatch;
  }

  try {
    const direct =
      await getDraw(
        Number(id)
      );

    if (
      direct?.id ===
      Number(id)
    ) {
      return direct;
    }
  } catch (_) {
    // Stop safely in caller.
  }

  return null;
}


/* =========================================================
   TRACKING / BACKFILL

   IMPORTANT:
   last_seen_draw_id can advance ONLY through
   a continuous sequence of confirmed draws.

   Example:
   expected: 100,101,102,103

   if 102 is missing:
   process 100,101
   STOP
   last_seen = 101

   Never jump to 103.
========================================================= */

async function backfillManual(
  group,
  suppliedLatest = null
) {
  if (
    !group ||
    !group.active
  ) {
    return {
      latest:
        suppliedLatest,

      processed:
        0,

      stoppedAtMissing:
        null
    };
  }


  const latest =
    suppliedLatest ||
    await getDraw(
      null
    );


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
    !Number.isFinite(after) ||
    after >=
    Number(latest.id)
  ) {
    return {
      latest,

      processed:
        0,

      stoppedAtMissing:
        null
    };
  }


  const end =
    Math.min(
      Number(
        latest.id
      ),
      after +
      MAX_BACKFILL
    );


  const count =
    end -
    after;


  if (
    count <= 0
  ) {
    return {
      latest,

      processed:
        0,

      stoppedAtMissing:
        null
    };
  }


  const ids =
    Array.from(
      {
        length:
          count
      },
      (_, i) =>
        after +
        i +
        1
    );


  let batchDraws = [];

  try {
    batchDraws =
      (
        await getMany(
          ids
        )
      )
      ||
      [];
  } catch (_) {
    batchDraws = [];
  }


  const batchMap =
    new Map(
      batchDraws
        .filter(
          d =>
            d?.id
        )
        .map(
          d => [
            Number(d.id),
            d
          ]
        )
    );


  let lastProcessed =
    after;

  let processed =
    0;

  let stoppedAtMissing =
    null;


  /*
    STRICTLY process IDs in order.
  */

  for (
    const expectedId
    of ids
  ) {

    const draw =
      await getSafeDraw(
        expectedId,
        batchMap
      );


    /*
      If this exact draw is unavailable:
      STOP HERE.

      Do NOT process anything after it.
      Do NOT advance last_seen past it.
    */

    if (
      !draw ||
      Number(draw.id) !==
      Number(expectedId)
    ) {
      stoppedAtMissing =
        Number(
          expectedId
        );

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


    /*
      Only 3/5 or better is stored
      in tracker_results.

      But every confirmed draw still
      advances last_seen_draw_id.
    */

    if (
      Number(
        result?.count || 0
      ) >= 3
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


    /*
      Advance exactly one confirmed draw.
    */

    lastProcessed =
      Number(
        draw.id
      );

    processed++;
  }


  /*
    Only update last_seen when we actually
    confirmed at least one new sequential draw.
  */

  if (
    lastProcessed >
    after
  ) {
    await db(
      `tracker_groups?id=eq.${group.id}`,
      {
        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {
          last_seen_draw_id:
            lastProcessed
        }
      }
    );


    group.last_seen_draw_id =
      lastProcessed;
  }


  return {
    latest,

    processed,

    lastProcessed,

    stoppedAtMissing
  };
}


/* =========================================================
   READ RESULTS
========================================================= */

async function readManual(
  group,
  slot
) {
  if (
    !group
  ) {
    return null;
  }


  let rows =
    (
      await db(
        `tracker_results?select=draw_id,hit_count,hit_numbers,bulls_eye,bulls_eye_match,created_at&group_id=eq.${group.id}&hit_count=gte.3&order=draw_id.desc&limit=100`
      )
    )
    ||
    [];


  const ids =
    rows
      .map(
        r =>
          Number(
            r.draw_id
          )
      )
      .filter(
        Number.isFinite
      );


  let meta = {};


  if (
    ids.length
  ) {
    const draws =
      (
        await db(
          `hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=in.(${ids.join(
            ','
          )})`
        )
      )
      ||
      [];


    meta =
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
  }


  rows =
    rows.map(
      row => ({
        ...row,

        date:
          meta[
            Number(
              row.draw_id
            )
          ]?.draw_date ||
          '',

        time:
          meta[
            Number(
              row.draw_id
            )
          ]?.draw_time ||
          ''
      })
    );


  return {
    id:
      group.id,

    slot,

    name:
      group.name,

    numbers:
      Array.isArray(
        group.numbers
      )
        ?
        group.numbers
          .map(Number)
        :
        [],

    active:
      Boolean(
        group.active
      ),

    startDrawId:
      group.start_draw_id,

    lastSeenDrawId:
      group.last_seen_draw_id,

    createdAt:
      group.created_at,

    matches:
      rows
  };
}


async function readAllManuals() {
  const group1 =
    await getManual(
      1
    );

  const group2 =
    await getManual(
      2
    );


  return [
    await readManual(
      group1,
      1
    ),

    await readManual(
      group2,
      2
    )
  ];
}


/* =========================================================
   START
========================================================= */

async function startManual(
  slot,
  numbers
) {
  const latest =
    await getDraw(
      null
    );


  await storeDraw(
    latest
  );


  const old =
    await getManual(
      slot
    );


  /* =====================================================
     CASE 1:
     Same numbers already active.
     Keep original start and results.
  ===================================================== */

  if (
    old &&
    old.active &&
    sameNumbers(
      old.numbers,
      numbers
    )
  ) {
    const sync =
      await backfillManual(
        old,
        latest
      );


    const manuals =
      await readAllManuals();


    return {
      ok:
        true,

      unchanged:
        true,

      resumed:
        false,

      message:
        'These numbers are already being tracked. Original start draw was preserved.',

      manuals,

      manual:
        manuals[
          slot - 1
        ],

      processed:
        sync.processed,

      stoppedAtMissing:
        sync.stoppedAtMissing,

      latest: {
        id:
          latest.id,

        date:
          latest.date,

        time:
          latest.time
      }
    };
  }


  /* =====================================================
     CASE 2:
     Same numbers, but previously stopped.

     Resume from NOW.
     Draws while stopped are intentionally skipped.
  ===================================================== */

  if (
    old &&
    !old.active &&
    sameNumbers(
      old.numbers,
      numbers
    )
  ) {
    await db(
      `tracker_groups?id=eq.${old.id}`,
      {
        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {
          active:
            true,

          last_seen_draw_id:
            latest.id
        }
      }
    );


    const manuals =
      await readAllManuals();


    return {
      ok:
        true,

      unchanged:
        false,

      resumed:
        true,

      message:
        'Manual tracking resumed. Previous results were preserved.',

      manuals,

      manual:
        manuals[
          slot - 1
        ],

      latest: {
        id:
          latest.id,

        date:
          latest.date,

        time:
          latest.time
      }
    };
  }


  /* =====================================================
     CASE 3:
     Different numbers in existing slot.

     New manual test.
     Delete previous results for this slot.
  ===================================================== */

  if (
    old
  ) {
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
          numbers,

          active:
            true,

          start_draw_id:
            latest.id,

          last_seen_draw_id:
            latest.id
        }
      }
    );

  } else {

    /* ===================================================
       CASE 4:
       Empty slot.
    =================================================== */

    await db(
      'tracker_groups',
      {
        method:
          'POST',

        prefer:
          'return=representation',

        body: {
          name:
            getManualName(
              slot
            ),

          numbers,

          active:
            true,

          start_draw_id:
            latest.id,

          last_seen_draw_id:
            latest.id
        }
      }
    );
  }


  const manuals =
    await readAllManuals();


  return {
    ok:
      true,

    unchanged:
      false,

    resumed:
      false,

    message:
      'Manual tracking started. Only future draws will be counted.',

    manuals,

    manual:
      manuals[
        slot - 1
      ],

    latest: {
      id:
        latest.id,

      date:
        latest.date,

      time:
        latest.time
    }
  };
}


/* =========================================================
   STOP
========================================================= */

async function stopManual(slot) {
  const group =
    await getManual(
      slot
    );


  if (
    !group
  ) {
    const manuals =
      await readAllManuals();


    return {
      ok:
        true,

      message:
        'No manual group exists in this slot.',

      manuals,

      manual:
        manuals[
          slot - 1
        ]
    };
  }


  let latest =
    null;

  let processed =
    0;

  let stoppedAtMissing =
    null;


  /*
    Before stopping:
    sync only through continuous confirmed draws.
  */

  if (
    group.active
  ) {
    latest =
      await getDraw(
        null
      );


    await storeDraw(
      latest
    );


    const sync =
      await backfillManual(
        group,
        latest
      );


    processed =
      sync.processed;


    stoppedAtMissing =
      sync.stoppedAtMissing;


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


  const manuals =
    await readAllManuals();


  return {
    ok:
      true,

    message:
      'Manual tracking stopped. Existing results were kept.',

    manuals,

    manual:
      manuals[
        slot - 1
      ],

    processed,

    stoppedAtMissing,

    latest:
      latest
        ?
        {
          id:
            latest.id,

          date:
            latest.date,

          time:
            latest.time
        }
        :
        null
  };
}


/* =========================================================
   CLEAR
========================================================= */

async function clearManual(slot) {
  const group =
    await getManual(
      slot
    );


  if (
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
          'DELETE',

        prefer:
          'return=minimal'
      }
    );
  }


  const manuals =
    await readAllManuals();


  return {
    ok:
      true,

    message:
      'Manual group cleared.',

    manuals,

    manual:
      manuals[
        slot - 1
      ]
  };
}


/* =========================================================
   GET / SYNC
========================================================= */

async function getManualState() {
  const group1 =
    await getManual(
      1
    );

  const group2 =
    await getManual(
      2
    );


  const groups = [
    group1,
    group2
  ];


  const activeGroups =
    groups.filter(
      group =>
        group &&
        group.active
    );


  let latest =
    null;

  let processed =
    0;

  const missing = [];


  /*
    Only fetch current draw if at least
    one manual group is active.
  */

  if (
    activeGroups.length
  ) {
    latest =
      await getDraw(
        null
      );


    await storeDraw(
      latest
    );


    for (
      const group
      of activeGroups
    ) {
      const sync =
        await backfillManual(
          group,
          latest
        );


      processed +=
        Number(
          sync.processed ||
          0
        );


      if (
        sync.stoppedAtMissing
      ) {
        missing.push({
          groupId:
            group.id,

          drawId:
            sync.stoppedAtMissing
        });
      }
    }
  }


  /*
    Re-read after syncing so
    lastSeenDrawId is always current.
  */

  const manuals =
    await readAllManuals();


  return {
    ok:
      true,

    manuals,

    manual:
      manuals[0] ||
      null,

    processed,

    missing,

    latest:
      latest
        ?
        {
          id:
            latest.id,

          date:
            latest.date,

          time:
            latest.time
        }
        :
        null
  };
}


/* =========================================================
   API HANDLER
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

    /* =====================================================
       POST
    ===================================================== */

    if (
      req.method ===
      'POST'
    ) {
      const action =
        String(
          req.body?.action ||
          'start'
        )
          .trim()
          .toLowerCase();


      const slot =
        normalizeSlot(
          req.body?.slot ??
          1
        );


      /* START */

      if (
        action ===
        'start'
      ) {
        const numbers =
          validateNumbers(
            req.body?.numbers
          );


        const result =
          await startManual(
            slot,
            numbers
          );


        return res
          .status(200)
          .json(
            result
          );
      }


      /* STOP */

      if (
        action ===
        'stop'
      ) {
        const result =
          await stopManual(
            slot
          );


        return res
          .status(200)
          .json(
            result
          );
      }


      /* CLEAR */

      if (
        action ===
        'clear'
      ) {
        const result =
          await clearManual(
            slot
          );


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
            'Unknown manual action.'
        });
    }


    /* =====================================================
       GET
    ===================================================== */

    if (
      req.method ===
      'GET'
    ) {
      const state =
        await getManualState();


      return res
        .status(200)
        .json(
          state
        );
    }


    /* =====================================================
       OTHER METHODS
    ===================================================== */

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
      'Manual group API error:',
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
};
