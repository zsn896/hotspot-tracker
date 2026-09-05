'use strict';

const worker =
  require('./worker');

const {
  db,
  getDraw,
  getMany,
  score,
  parseDrawMinutes
} =
  require('./lib');

const {
  runActiveDensitySpecial
} =
  require('../lib/special-active');

const {
  runAdvanced
} =
  require('../lib/advanced');

const {
  runGroupFive
} =
  require('../lib/group-five');

const AUTO_PREFIX = 'AUTO Group ';
const MANUAL_PREFIX = 'MANUAL Group';

const CLOSE_START_MINUTES = 120;
const MAX_CLOSE_BACKFILL = 80;


function createCollector() {

  return {

    statusCode:
      200,

    payload:
      null,

    headers:
      {},


    setHeader(
      name,
      value
    ) {

      this.headers[
        name
      ] =
        value;

      return this;
    },


    status(
      code
    ) {

      this.statusCode =
        code;

      return this;
    },


    json(
      value
    ) {

      this.payload =
        value;

      return value;
    }
  };
}


/* =========================================================
   STORE FINAL DRAW
========================================================= */

async function storeCloseDraw(draw) {

  if (!draw?.id) {
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
   SAFE DRAW FETCH
========================================================= */

async function safeCloseDraw(
  id,
  batchMap
) {

  const fromBatch =
    batchMap.get(
      Number(id)
    );

  if (
    Number(fromBatch?.id) ===
    Number(id)
  ) {

    return fromBatch;
  }

  try {

    const direct =
      await getDraw(
        Number(id)
      );

    if (
      Number(direct?.id) ===
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
   FIND FINAL OFFICIAL DRAW AT OR BEFORE 2:00 AM
========================================================= */

async function getFinalTrackingDraw() {

  const latest =
    await getDraw(
      null
    );

  if (!latest?.id) {
    return null;
  }

  const latestMinutes =
    parseDrawMinutes(
      latest.time
    );

  if (
    latestMinutes != null &&
    latestMinutes <=
      CLOSE_START_MINUTES
  ) {

    return latest;
  }


  for (
    let offset = 1;
    offset <= 20;
    offset++
  ) {

    try {

      const candidate =
        await getDraw(
          Number(latest.id) -
          offset
        );

      const minutes =
        parseDrawMinutes(
          candidate?.time
        );

      if (
        candidate?.id &&
        minutes != null &&
        minutes <=
          CLOSE_START_MINUTES
      ) {

        return candidate;
      }

    } catch (_) {
      // Keep searching backward.
    }
  }

  return null;
}


/* =========================================================
   ALL ACTIVE TRACKED GROUPS
========================================================= */

async function getCloseGroups() {

  const rows =
    (
      await db(
        'tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id&active=eq.true&order=id.asc'
      )
    ) || [];

  return rows.filter(
    g => {

      const name =
        String(
          g.name || ''
        );

      return (
        name.startsWith(
          AUTO_PREFIX
        ) ||
        name.startsWith(
          MANUAL_PREFIX
        )
      );
    }
  );
}


/* =========================================================
   FINALIZE ONE GROUP
========================================================= */

async function finalizeOneCloseGroup(
  group,
  finalDraw
) {

  const after =
    Number(
      group.last_seen_draw_id ??
      group.start_draw_id ??
      finalDraw.id
    );

  if (
    !Number.isFinite(after) ||
    after >=
      Number(finalDraw.id)
  ) {

    return {
      group:
        group.name,

      processed:
        0,

      lastSeen:
        after,

      stoppedAtMissing:
        null
    };
  }


  const end =
    Math.min(
      Number(finalDraw.id),
      after +
      MAX_CLOSE_BACKFILL
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


  const batchMap =
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


  const isManual =
    String(
      group.name || ''
    ).startsWith(
      MANUAL_PREFIX
    );


  let lastProcessed =
    after;

  let processed =
    0;

  let stoppedAtMissing =
    null;


  for (
    const expectedId
    of ids
  ) {

    const draw =
      await safeCloseDraw(
        expectedId,
        batchMap
      );


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


    const drawMinutes =
      parseDrawMinutes(
        draw.time
      );


    /*
      Never count a draw later than 2:00 AM.
    */

    if (
      drawMinutes == null ||
      drawMinutes >
        CLOSE_START_MINUTES
    ) {

      break;
    }


    await storeCloseDraw(
      draw
    );


    const result =
      score(
        draw,
        group.numbers
      );


    /*
      Automatic groups:
      store every result.

      Manual groups:
      store only 3/5 or better.
    */

    if (
      !isManual ||
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


    lastProcessed =
      Number(
        draw.id
      );

    processed++;
  }


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
  }


  return {
    group:
      group.name,

    processed,

    lastSeen:
      lastProcessed,

    stoppedAtMissing
  };
}


/* =========================================================
   FINAL 2:00 AM CATCH-UP
========================================================= */

async function finalizeTrackingClose() {

  const finalDraw =
    await getFinalTrackingDraw();


  if (!finalDraw?.id) {

    return {
      ok:
        false,

      processed:
        0,

      finalDrawId:
        null,

      error:
        'Could not resolve the final official draw at or before 2:00 AM.'
    };
  }


  await storeCloseDraw(
    finalDraw
  );


  const groups =
    await getCloseGroups();


  const details = [];

  let processed =
    0;


  for (
    const group
    of groups
  ) {

    const result =
      await finalizeOneCloseGroup(
        group,
        finalDraw
      );


    details.push(
      result
    );


    processed +=
      Number(
        result.processed || 0
      );
  }


  return {
    ok:
      true,

    processed,

    finalDrawId:
      finalDraw.id,

    finalDrawTime:
      finalDraw.time,

    details
  };
}


/* =========================================================
   CRON HANDLER
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


  const cronSecret =
    process.env
      .CRON_SECRET;


  const auth =
    String(
      req.headers
        .authorization
      ||
      ''
    );


  if (
    !cronSecret ||
    auth !==
      `Bearer ${cronSecret}`
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


  if (
    !process.env
      .WORKER_SECRET
  ) {

    return res
      .status(500)
      .json({

        ok:
          false,

        error:
          'WORKER_SECRET is not configured'
      });
  }


  req.headers[
    'x-worker-secret'
  ] =
    process.env
      .WORKER_SECRET;


  /* =======================================================
     RUN ORIGINAL WORKER FIRST
  ======================================================= */

  const collector =
    createCollector();


  await worker(
    req,
    collector
  );


  const workerPayload =
    collector.payload
    ||
    {

      ok:
        false,

      error:
        'Worker returned no JSON payload'
    };


  let groupFive =
    null;

  let specialActive =
    null;

  let advanced =
    null;

  let closeFinalize =
    null;


  /* =======================================================
     FINAL 2:00 AM FIX

     Between 2:00 AM and 2:30 AM the original worker
     returns IDLE before tracking.

     This finalizer now catches any missed 1:56 / 2:00
     draws for:

     - AUTO Group 1
     - AUTO Group 2
     - AUTO Group Special
     - AUTO Group Advanced
     - AUTO Group Five
     - Manual Group 1
     - Manual Group 2

     It will never count a draw after 2:00 AM.
  ======================================================= */

  if (
    collector.statusCode < 400
    &&
    workerPayload?.ok !== false
    &&
    workerPayload?.mode ===
      'idle'
  ) {

    try {

      closeFinalize =
        await finalizeTrackingClose();

    } catch (
      e
    ) {

      closeFinalize = {

        ok:
          false,

        processed:
          0,

        error:
          e.message
          ||
          String(e)
      };
    }
  }


  /* =======================================================
     GROUP FIVE
  ======================================================= */

  if (
    collector.statusCode < 400
    &&
    workerPayload?.ok !== false
    &&
    (
      workerPayload?.mode ===
        'collecting'
      ||
      workerPayload?.mode ===
        'preparing'
      ||
      workerPayload?.mode ===
        'tracking'
    )
  ) {

    try {

      groupFive =
        await runGroupFive();

    } catch (
      e
    ) {

      groupFive = {

        ok:
          false,

        active:
          false,

        error:
          e.message
          ||
          String(e)
      };
    }
  }


  /* =======================================================
     SPECIAL + ADVANCED
  ======================================================= */

  if (
    collector.statusCode < 400
    &&
    workerPayload?.ok !== false
    &&
    workerPayload?.mode ===
      'tracking'
  ) {

    try {

      specialActive =
        await runActiveDensitySpecial();

    } catch (
      e
    ) {

      specialActive = {

        ok:
          false,

        replaced:
          false,

        error:
          e.message
          ||
          String(e)
      };
    }


    try {

      advanced =
        await runAdvanced();

    } catch (
      e
    ) {

      advanced = {

        ok:
          false,

        created:
          false,

        error:
          e.message
          ||
          String(e)
      };
    }
  }


  return res
    .status(
      collector.statusCode
    )
    .json({

      ...workerPayload,

      closeFinalize,

      groupFive,

      specialActive,

      advanced
    });
};
