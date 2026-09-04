'use strict';

const worker =
  require('./worker');

const {
  runAdvanced
} =
  require('../lib/advanced');


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
        .authorization ||
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


  /*
    Worker remains protected exactly
    as before.
  */

  req.headers[
    'x-worker-secret'
  ] =
    process.env
      .WORKER_SECRET;


  /*
    Run the EXISTING worker first.

    We capture its response internally
    so worker.js itself does NOT need
    any modification.

    Therefore we preserve:

    - collection
    - 180 draws
    - 6:05 selection
    - Group 1
    - Group 2
    - Special Group
    - Manual Group 1
    - Manual Group 2
    - tracking
    - cleanup
  */

  const collector =
    createCollector();


  await worker(
    req,
    collector
  );


  const workerPayload =
    collector.payload ||
    {
      ok:
        false,

      error:
        'Worker returned no JSON payload'
    };


  let advanced =
    null;


  /*
    Advanced selection runs only
    AFTER the original worker says
    we are officially in tracking mode.

    This means the normal two groups
    and completed 180-draw collection
    already exist.
  */

  if (
    collector.statusCode <
      400
    &&
    workerPayload?.ok !==
      false
    &&
    workerPayload?.mode ===
      'tracking'
  ) {
    try {

      advanced =
        await runAdvanced();

    } catch (
      e
    ) {

      /*
        Advanced failure must NOT
        stop the original system.

        Group 1, Group 2, Special
        and manual groups continue
        working normally.
      */

      advanced = {
        ok:
          false,

        created:
          false,

        error:
          e.message ||
          String(e)
      };
    }
  }


  return res
    .status(
      collector
        .statusCode
    )
    .json({
      ...workerPayload,

      advanced
    });
};
