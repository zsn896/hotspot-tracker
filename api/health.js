'use strict';

const C = require('../lib/config');
const T = require('../lib/time');

/**
 * Liveness and configuration check. Deliberately reports whether secrets are
 * *set*, never their values, so it is safe to leave public.
 */
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const now = T.californiaNowParts();
  res.status(200).json({
    ok: true,
    version: require('../package.json').version,
    californiaTime: `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`,
    cycle: T.cycleDateKey(now),
    mode: T.scheduleMode(now.minutes),
    configured: {
      supabaseUrl: Boolean(process.env.SUPABASE_URL),
      supabaseKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      workerSecret: Boolean(process.env.WORKER_SECRET),
    },
    collectionDraws: C.COLLECTION_DRAWS,
  });
};
