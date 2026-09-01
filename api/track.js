'use strict';

const C = require('../lib/config');
const { Deadline } = require('../lib/http');
const { getDraw, getDraws, score } = require('../lib/lottery');
const { uniqueSortedGroup } = require('../lib/validate');

/**
 * Ad-hoc lookup: score arbitrary groups against recent draws without touching
 * the database.
 *
 * This endpoint reaches out to the lottery site on every call, so unlike the
 * read-only /api/state it requires WORKER_SECRET when one is configured. Left
 * open, it is a free amplifier pointed at somebody else's servers.
 */
const MAX_DRAWS = 60;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (process.env.WORKER_SECRET && (req.headers['x-worker-secret'] || req.query?.secret) !== process.env.WORKER_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const deadline = new Deadline(C.WORKER_BUDGET_MS);

  try {
    const groups = String(req.query?.groups || '')
      .split(';')
      .map((part) => uniqueSortedGroup(part.split(',')))
      .filter(Boolean)
      .slice(0, 3);

    const latest = await getDraw(null, { deadline });
    const after = Math.max(0, Number(req.query?.after || latest.id));
    if (after >= latest.id) {
      return res.status(200).json({ ok: true, latest, draws: [], groups, source: C.SOURCE_LABEL });
    }

    const first = Math.max(after + 1, latest.id - MAX_DRAWS + 1);
    const ids = Array.from({ length: latest.id - first + 1 }, (_, i) => first + i);
    const { draws, failed } = await getDraws(ids, { deadline });

    return res.status(200).json({
      ok: true,
      latest,
      requestedAfter: after,
      firstReturned: first,
      truncated: first > after + 1,
      draws: draws.map((d) => ({ ...d, scores: groups.map((g) => score(d, g)) })),
      groups,
      failed,
      source: C.SOURCE_LABEL,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
};
