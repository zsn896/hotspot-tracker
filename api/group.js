'use strict';

/**
 * Kept as an explicit, documented 409 so older clients get a clear answer rather
 * than a 404 that looks like a deployment fault.
 */
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(409).json({
    ok: false,
    error: 'Groups cannot be set by hand. This build selects them automatically at 6:00 PM from the 12-hour window.',
  });
};
