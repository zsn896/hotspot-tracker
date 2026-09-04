'use strict';

const worker = require('./worker');

const {
  runActiveDensitySpecial
} = require('../lib/special-active');

const {
  runAdvanced
} = require('../lib/advanced');


function createCollector() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},

    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(value) {
      this.payload = value;
      return value;
    }
  };
}


module.exports = async (req, res) => {

  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );

  const cronSecret =
    process.env.CRON_SECRET;

  const auth =
    String(
      req.headers.authorization ||
      ''
    );

  if (
    !cronSecret ||
    auth !== `Bearer ${cronSecret}`
  ) {
    return res
      .status(401)
      .json({
        ok: false,
        error: 'Unauthorized'
      });
  }

  if (
    !process.env.WORKER_SECRET
  ) {
    return res
      .status(500)
      .json({
        ok: false,
        error:
          'WORKER_SECRET is not configured'
      });
  }

  req.headers[
    'x-worker-secret'
  ] =
    process.env.WORKER_SECRET;


  /*
    تشغيل النظام الأصلي أولاً.

    worker.js يبقى بدون أي تعديل:
    - Collection
    - Group 1
    - Group 2
    - Manual Groups
    - Tracking
    - Cleanup
  */

  const collector =
    createCollector();

  await worker(
    req,
    collector
  );

  const workerPayload =
    collector.payload || {
      ok: false,
      error:
        'Worker returned no JSON payload'
    };


  let specialActive = null;
  let advanced = null;


  /*
    بعد اكتمال Collection
    ودخول النظام إلى Tracking:

    1. نشغّل Special Active Density
    2. نشغّل Advanced
  */

  if (
    collector.statusCode < 400 &&
    workerPayload?.ok !== false &&
    workerPayload?.mode === 'tracking'
  ) {

    try {

      specialActive =
        await runActiveDensitySpecial();

    } catch (e) {

      specialActive = {
        ok: false,
        replaced: false,
        error:
          e.message ||
          String(e)
      };
    }


    try {

      advanced =
        await runAdvanced();

    } catch (e) {

      advanced = {
        ok: false,
        created: false,
        error:
          e.message ||
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

      specialActive,

      advanced
    });
};
