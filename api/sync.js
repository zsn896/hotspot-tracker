'use strict';

const {
  getDraw,
  db
} = require('./lib');

const cron =
  require('./cron');

const GROUP_FIVE_NAME =
  'AUTO Group Five';


/* =========================================================
   RESPONSE COLLECTOR

   Allows us to run the protected cron internally
   without exposing CRON_SECRET to the browser.
========================================================= */

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

      this.headers[name] =
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
   GET ACTIVE GROUP FIVE

   Important:
   Smart Sync must verify not only that the draw
   itself is stored, but also that Group Five has
   processed that draw.
========================================================= */

async function getActiveGroupFive() {

  const rows =
    await db(
      `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id,active&name=eq.${encodeURIComponent(
        GROUP_FIVE_NAME
      )}&active=eq.true&order=id.desc&limit=1`
    );

  return (
    rows?.[0]
    ||
    null
  );
}


/* =========================================================
   GROUP FIVE TARGET

   Group Five tracks only the next 20 future draws.

   Example:
   start_draw_id = 3298310
   valid tracking draws:
   3298311 ... 3298330

   If official draw is already beyond the cutoff,
   Group Five only needs to process through the cutoff.
========================================================= */

function groupFiveTargetId(
  group,
  officialId
) {

  if (
    !group
  ) {

    return 0;
  }

  const startId =
    Number(
      group.start_draw_id
      ||
      0
    );

  if (
    !startId
  ) {

    return 0;
  }

  const cutoff =
    startId + 20;

  return Math.min(
    Number(
      officialId
      ||
      0
    ),
    cutoff
  );
}


/* =========================================================
   MAIN SYNC ENDPOINT

   FIXED LOGIC:

   Before:
   If latest stored draw == official latest draw,
   Smart Sync stopped immediately.

   Problem:
   Group Five could still be behind even though the draw
   was already stored.

   Now:
   Smart Sync checks BOTH:

   1. Draw storage lag
   2. Group Five tracking lag

   If either is behind, run the full cron.

   This updates:
   - stored draws
   - automatic groups
   - manual groups
   - GROUP FIVE
   - Special Group
   - Advanced Group
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

    /* =====================================================
       ONLY ALLOW GET / POST
    ===================================================== */

    const method =
      String(
        req.method
        ||
        'GET'
      ).toUpperCase();


    if (
      method !== 'GET'
      &&
      method !== 'POST'
    ) {

      return res
        .status(
          405
        )
        .json({

          ok:
            false,

          error:
            'Method not allowed'
        });
    }


    /* =====================================================
       GET OFFICIAL LATEST DRAW DIRECTLY
    ===================================================== */

    const official =
      await getDraw(
        null
      );


    const officialId =
      Number(
        official?.id
        ||
        0
      );


    if (
      !officialId
    ) {

      return res
        .status(
          502
        )
        .json({

          ok:
            false,

          error:
            'Unable to read official latest draw'
        });
    }


    /* =====================================================
       GET OUR LATEST STORED DRAW
    ===================================================== */

    const storedRows =
      await db(
        'hotspot_draws?select=draw_id,draw_date,draw_time&order=draw_id.desc&limit=1'
      );


    const stored =
      storedRows?.[0]
      ||
      null;


    const storedId =
      Number(
        stored?.draw_id
        ||
        0
      );


    const drawLag =
      Math.max(
        0,
        officialId
        -
        storedId
      );


    /* =====================================================
       CHECK GROUP FIVE LAG
    ===================================================== */

    const groupFiveBefore =
      await getActiveGroupFive();


    const groupFiveStartBefore =
      Number(
        groupFiveBefore?.start_draw_id
        ||
        0
      );


    const groupFiveLastSeenBefore =
      Number(
        groupFiveBefore?.last_seen_draw_id
        ??
        groupFiveStartBefore
        ??
        0
      );


    const groupFiveTargetBefore =
      groupFiveTargetId(
        groupFiveBefore,
        officialId
      );


    const groupFiveLagBefore =
      groupFiveBefore
      &&
      groupFiveTargetBefore >
        groupFiveLastSeenBefore

        ?

        (
          groupFiveTargetBefore
          -
          groupFiveLastSeenBefore
        )

        :

        0;


    /* =====================================================
       TRULY ALREADY CURRENT

       We may return early ONLY when:

       1. Stored draw is current
       2. Group Five is also current

       This fixes the previous bug.
    ===================================================== */

    if (
      storedId >=
        officialId
      &&
      groupFiveLagBefore ===
        0
    ) {

      return res
        .status(
          200
        )
        .json({

          ok:
            true,

          synced:
            false,

          reason:
            'already-current',

          officialDrawId:
            officialId,

          storedDrawId:
            storedId,

          lag:
            0,

          drawLag:
            0,

          groupFive: {

            active:
              Boolean(
                groupFiveBefore
              ),

            startDrawId:
              groupFiveStartBefore
              ||
              null,

            lastSeenDrawId:
              groupFiveLastSeenBefore
              ||
              null,

            targetDrawId:
              groupFiveTargetBefore
              ||
              null,

            lag:
              0
          }
        });
    }


    /* =====================================================
       SAFETY CHECK

       Required server secrets must exist.
    ===================================================== */

    if (
      !process.env
        .CRON_SECRET
    ) {

      return res
        .status(
          500
        )
        .json({

          ok:
            false,

          error:
            'CRON_SECRET is not configured'
        });
    }


    if (
      !process.env
        .WORKER_SECRET
    ) {

      return res
        .status(
          500
        )
        .json({

          ok:
            false,

          error:
            'WORKER_SECRET is not configured'
        });
    }


    /* =====================================================
       RUN FULL CRON INTERNALLY

       This runs if:

       - draw storage is behind
       OR
       - Group Five tracking is behind
    ===================================================== */

    const collector =
      createCollector();


    const internalReq = {

      ...req,

      headers: {

        ...(
          req.headers
          ||
          {}
        ),

        authorization:
          `Bearer ${process.env.CRON_SECRET}`
      }
    };


    await cron(
      internalReq,
      collector
    );


    if (
      collector.statusCode >=
        400
      ||
      collector.payload?.ok ===
        false
    ) {

      return res
        .status(
          collector.statusCode
          ||
          500
        )
        .json({

          ok:
            false,

          error:
            collector.payload?.error
            ||
            'Internal sync failed',

          officialDrawId:
            officialId,

          storedDrawId:
            storedId,

          drawLag,

          groupFiveLag:
            groupFiveLagBefore
        });
    }


    /* =====================================================
       VERIFY STORED DRAW AFTER SYNC
    ===================================================== */

    const afterRows =
      await db(
        'hotspot_draws?select=draw_id,draw_date,draw_time&order=draw_id.desc&limit=1'
      );


    const after =
      afterRows?.[0]
      ||
      null;


    const afterId =
      Number(
        after?.draw_id
        ||
        0
      );


    const remainingDrawLag =
      Math.max(
        0,
        officialId
        -
        afterId
      );


    /* =====================================================
       VERIFY GROUP FIVE AFTER SYNC
    ===================================================== */

    const groupFiveAfter =
      await getActiveGroupFive();


    const groupFiveStartAfter =
      Number(
        groupFiveAfter?.start_draw_id
        ||
        0
      );


    const groupFiveLastSeenAfter =
      Number(
        groupFiveAfter?.last_seen_draw_id
        ??
        groupFiveStartAfter
        ??
        0
      );


    const groupFiveTargetAfter =
      groupFiveTargetId(
        groupFiveAfter,
        officialId
      );


    const remainingGroupFiveLag =
      groupFiveAfter
      &&
      groupFiveTargetAfter >
        groupFiveLastSeenAfter

        ?

        (
          groupFiveTargetAfter
          -
          groupFiveLastSeenAfter
        )

        :

        0;


    const fullyCaughtUp =
      afterId >=
        officialId
      &&
      remainingGroupFiveLag ===
        0;


    /* =====================================================
       FINAL RESPONSE
    ===================================================== */

    return res
      .status(
        200
      )
      .json({

        ok:
          true,

        synced:
          true,

        officialDrawId:
          officialId,

        beforeStoredDrawId:
          storedId,

        storedDrawId:
          afterId,

        previousLag:
          drawLag,

        remainingLag:
          remainingDrawLag,

        drawLagBefore:
          drawLag,

        drawLagAfter:
          remainingDrawLag,

        groupFive: {

          active:
            Boolean(
              groupFiveAfter
            ),

          startDrawId:
            groupFiveStartAfter
            ||
            null,

          lastSeenBefore:
            groupFiveLastSeenBefore
            ||
            null,

          lastSeenDrawId:
            groupFiveLastSeenAfter
            ||
            null,

          targetDrawId:
            groupFiveTargetAfter
            ||
            null,

          lagBefore:
            groupFiveLagBefore,

          lagAfter:
            remainingGroupFiveLag
        },

        caughtUp:
          fullyCaughtUp,

        worker: {

          mode:
            collector.payload?.mode
            ||
            null,

          groupFive:
            collector.payload?.groupFive
            ||
            null
        }
      });


  } catch (
    e
  ) {

    return res
      .status(
        500
      )
      .json({

        ok:
          false,

        error:
          e.message
          ||
          String(
            e
          )
      });
  }
};
