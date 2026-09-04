'use strict';

const worker =
  require('./worker');

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
    !cronSecret
    ||
    auth !==
      `Bearer ${cronSecret}`
  ) {

    return res
      .status(
        401
      )
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


  req.headers[
    'x-worker-secret'
  ] =
    process.env
      .WORKER_SECRET;


  /* =======================================================
     ORIGINAL SYSTEM FIRST

     DO NOT CHANGE ORIGINAL WORKER.

     It continues to handle:

     - Official California data
     - Collection
     - Group 1
     - Group 2
     - Manual Groups
     - Tracking
     - Cleanup
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


  /* =======================================================
     GROUP FIVE

     Independent rolling engine.

     It runs DURING collection as well.

     First:
     30 draws analysis.

     Then:
     20 future draws tracking.

     Then:
     latest 30 analysis.

     Repeat continuously.
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
          String(
            e
          )
      };
    }
  }


  /* =======================================================
     SPECIAL + ADVANCED

     Preserve current successful behavior.

     They run only after the
     normal 180-draw collection is complete
     and original worker enters Tracking.
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
          String(
            e
          )
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
          String(
            e
          )
      };
    }
  }


  return res
    .status(
      collector.statusCode
    )
    .json({

      ...workerPayload,

      groupFive,

      specialActive,

      advanced
    });
};
