'use strict';

const worker = require('./worker');

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
    auth !==
      `Bearer ${cronSecret}`
  ) {

    return res
      .status(401)
      .json({
        ok: false,
        error: 'Unauthorized'
      });
  }

  /*
    Vercel Cron authenticates
    this endpoint using CRON_SECRET.

    worker.js remains protected
    separately by WORKER_SECRET.
  */

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

  /*
    Pass the WORKER_SECRET
    internally to worker.js.
    It never appears in the URL
    or public frontend.
  */

  req.headers[
    'x-worker-secret'
  ] =
    process.env.WORKER_SECRET;

  return worker(
    req,
    res
  );
};
