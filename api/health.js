'use strict';

const {
  californiaNowParts,
  cycleDateKey,
  scheduleMode
} = require('./lib');

module.exports = async (req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );

  try {
    const now = californiaNowParts();

    return res.status(200).json({
      ok: true,

      version:
        require('../package.json')
          .version,

      californiaTime:
        `${String(now.hour).padStart(2, '0')}:` +
        `${String(now.minute).padStart(2, '0')}`,

      cycle:
        cycleDateKey(now),

      mode:
        scheduleMode(
          now.minutes
        ),

      configured: {
        supabaseUrl:
          Boolean(
            process.env.SUPABASE_URL
          ),

        supabaseKey:
          Boolean(
            process.env
              .SUPABASE_SERVICE_ROLE_KEY
          ),

        workerSecret:
          Boolean(
            process.env.WORKER_SECRET
          )
      },

      collectionDraws: 180,

      source:
        'California Lottery official'
    });

  } catch (e) {

    return res
      .status(500)
      .json({
        ok: false,
        error:
          e.message ||
          String(e)
      });
  }
};
