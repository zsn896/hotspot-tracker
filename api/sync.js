'use strict';

const {
  getDraw,
  db
} = require('./lib');

const cron =
  require('./cron');


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
   MAIN SYNC ENDPOINT

   PURPOSE:

   Official draw:
       3298244

   Stored draw:
       3298243

   If official > stored:
       run full cron immediately.

   This updates:
       - stored draws
       - automatic groups
       - manual groups
       - GROUP FIVE
       - Special Group
       - Advanced Group

   No browser secret is exposed.
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
        req.method ||
        'GET'
      ).toUpperCase();


    if (
      method !== 'GET'
      &&
      method !== 'POST'
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


    /* =====================================================
       GET OFFICIAL LATEST DRAW DIRECTLY
    ===================================================== */

    const official =
      await getDraw(
        null
      );


    const officialId =
      Number(
        official?.id ||
        0
      );


    if (
      !officialId
    ) {

      return res
        .status(502)
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
      storedRows?.[0] ||
      null;


    const storedId =
      Number(
        stored?.draw_id ||
        0
      );


    const lag =
      Math.max(
        0,
        officialId -
        storedId
      );


    /* =====================================================
       ALREADY CURRENT

       Do not waste worker execution.
    ===================================================== */

    if (
      storedId >= officialId
    ) {

      return res
        .status(200)
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
            0
        });
    }


    /* =====================================================
       SAFETY CHECK

       Required server secrets must exist.
    ===================================================== */

    if (
      !process.env.CRON_SECRET
    ) {

      return res
        .status(500)
        .json({

          ok:
            false,

          error:
            'CRON_SECRET is not configured'
        });
    }


    if (
      !process.env.WORKER_SECRET
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


    /* =====================================================
       RUN FULL CRON INTERNALLY

       Important:
       Secret exists only on server.

       Browser never receives it.
    ===================================================== */

    const collector =
      createCollector();


    const internalReq = {

      ...req,

      headers: {

        ...(
          req.headers ||
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
      collector.statusCode >= 400
      ||
      collector.payload?.ok === false
    ) {

      return res
        .status(
          collector.statusCode ||
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

          lag
        });
    }


    /* =====================================================
       VERIFY AFTER SYNC
    ===================================================== */

    const afterRows =
      await db(
        'hotspot_draws?select=draw_id,draw_date,draw_time&order=draw_id.desc&limit=1'
      );


    const after =
      afterRows?.[0] ||
      null;


    const afterId =
      Number(
        after?.draw_id ||
        0
      );


    const remainingLag =
      Math.max(
        0,
        officialId -
        afterId
      );


    return res
      .status(200)
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
          lag,

        remainingLag,

        caughtUp:
          afterId >=
          officialId,

        worker:
          {

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
