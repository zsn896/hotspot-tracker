'use strict';
const { InputError } = require('../lib/input-error');

const {
  db,
  getDraw,
  getMany,
  uniqSorted,
  score
} = require('./lib');

const MANUAL_PREFIX = 'MANUAL Group';
const STRONG_MANUAL_PREFIX = 'STRONG_MANUAL Group';
const MAX_SERVER_MANUAL = 24;
const MAX_SERVER_STRONG_MANUAL = 24;

function normalizeGroup(values) {
  return uniqSorted((values || []).map(Number))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80);
}

function parseGroups(v) {
  if (!v) return [];
  return String(v)
    .split(';')
    .map(s => normalizeGroup(s.split(/[,-]/)))
    .filter(a => a.length >= 3 && a.length <= 5)
    .slice(0, 24);
}

function parseOneGroup(req) {
  const bodyNumbers = Array.isArray(req.body?.numbers)
    ? req.body.numbers
    : null;

  const raw = req.body?.numbers || req.query?.numbers || '';
  const values = (bodyNumbers || String(raw).split(/[,-]/)).map(Number);
  if (values.length < 3 || values.length > 5 || new Set(values).size !== values.length ||
      values.some(n => !Number.isInteger(n) || n < 1 || n > 80)) {
    throw new InputError('A group must contain 3 to 5 distinct integers from 1 to 80.');
  }
  return normalizeGroup(values);
}

function groupKey(numbers) {
  return normalizeGroup(numbers).join('-');
}

function serverName(numbers) {
  return `${MANUAL_PREFIX} ${groupKey(numbers)}`;
}

function strongServerName(numbers) {
  return `${STRONG_MANUAL_PREFIX} ${groupKey(numbers)}`;
}

async function listGroupsByPrefix(prefix, limit) {
  const rows = (
    await db(
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id&name=like.${encodeURIComponent(
        prefix + '*'
      )}&order=id.asc&limit=${limit}`
    )
  ) || [];

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    numbers: normalizeGroup(row.numbers),
    active: Boolean(row.active),
    startDrawId: Number(row.start_draw_id || 0) || null,
    lastSeenDrawId: Number(row.last_seen_draw_id || 0) || null
  }));
}

async function listServerManualGroups() {
  return listGroupsByPrefix(
    MANUAL_PREFIX,
    MAX_SERVER_MANUAL
  );
}

async function listServerStrongManualGroups() {
  return listGroupsByPrefix(
    STRONG_MANUAL_PREFIX,
    MAX_SERVER_STRONG_MANUAL
  );
}

async function registerGroup(req, options) {
  const numbers = parseOneGroup(req);
  const label = options.label;
  const limit = options.limit;
  const name = options.nameFor(numbers);
  const listCurrent = options.listCurrent;

  if (numbers.length < 3 || numbers.length > 5) {
    return {
      ok: false,
      status: 400,
      error: `${label} must contain 3 to 5 unique numbers from 1 to 80.`
    };
  }

  const latest = await getDraw(null);
  if (!latest?.id) {
    return {
      ok: false,
      status: 503,
      error: 'Could not resolve the latest draw.'
    };
  }

  const rows = (
    await db(
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id&name=eq.${encodeURIComponent(name)}&limit=1`
    )
  ) || [];

  const existing = rows[0] || null;

  if (existing?.id) {
    await db(
      `tracker_groups?id=eq.${existing.id}`,
      {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          numbers,
          active: true
        }
      }
    );

    return {
      ok: true,
      status: 200,
      created: false,
      group: {
        id: existing.id,
        name,
        numbers,
        active: true,
        startDrawId: Number(existing.start_draw_id || latest.id),
        lastSeenDrawId: Number(existing.last_seen_draw_id || latest.id)
      }
    };
  }

  const current = await listCurrent();
  if (current.length >= limit) {
    return {
      ok: false,
      status: 409,
      error: `${label} limit reached (${limit}).`
    };
  }

  const created = await db(
    'tracker_groups',
    {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        name,
        numbers,
        active: true,
        start_draw_id: Number(latest.id),
        last_seen_draw_id: Number(latest.id)
      }
    }
  );

  const row = Array.isArray(created) ? created[0] : created;

  return {
    ok: true,
    status: 201,
    created: true,
    group: {
      id: row?.id || null,
      name,
      numbers,
      active: true,
      startDrawId: Number(latest.id),
      lastSeenDrawId: Number(latest.id)
    }
  };
}

async function registerManualGroup(req) {
  return registerGroup(req, {
    label: 'Manual group',
    limit: MAX_SERVER_MANUAL,
    nameFor: serverName,
    listCurrent: listServerManualGroups
  });
}

async function registerStrongManualGroup(req) {
  return registerGroup(req, {
    label: 'Strong Manual group',
    limit: MAX_SERVER_STRONG_MANUAL,
    nameFor: strongServerName,
    listCurrent: listServerStrongManualGroups
  });
}

async function legacyTrack(req, res) {
  const latest = await getDraw(null);
  const after = Number(req.query?.after ?? latest.id);
  if (!Number.isSafeInteger(after) || after < 0) throw new InputError('after must be a non-negative integer');
  const groups = parseGroups(req.query.groups);

  if (after >= latest.id) {
    return res.status(200).json({
      ok: true,
      latest,
      draws: [],
      groups,
      source: 'California Lottery official'
    });
  }

  const max = 80;
  const first = Math.max(after + 1, latest.id - max + 1);
  const ids = Array.from(
    { length: latest.id - first + 1 },
    (_, i) => first + i
  );
  const draws = await getMany(ids);
  const rows = draws.map(d => ({
    ...d,
    scores: groups.map(g => score(d, g))
  }));

  return res.status(200).json({
    ok: true,
    latest,
    requestedAfter: after,
    firstReturned: first,
    draws: rows,
    groups,
    source: 'California Lottery official',
    truncated: first > after + 1
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store,max-age=0');

  try {
    const method = String(req.method || 'GET').toUpperCase();
    const action = String(req.query?.action || req.body?.action || '').toLowerCase();

    if (method === 'POST' && (action === 'register-manual' || action === 'register')) {
      const result = await registerManualGroup(req);
      return res.status(result.status || (result.ok ? 200 : 400)).json(result);
    }

    if (method === 'POST' && action === 'register-strong-manual') {
      const result = await registerStrongManualGroup(req);
      return res.status(result.status || (result.ok ? 200 : 400)).json(result);
    }

    if (method === 'GET' && action === 'manual-groups') {
      const groups = await listServerManualGroups();
      return res.status(200).json({
        ok: true,
        count: groups.length,
        groups
      });
    }

    if (method === 'GET' && action === 'strong-manual-groups') {
      const groups = await listServerStrongManualGroups();
      return res.status(200).json({
        ok: true,
        count: groups.length,
        groups
      });
    }

    if (method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
    if (action) return res.status(400).json({ ok: false, error: 'Unknown action' });
    return await legacyTrack(req, res);
  } catch (e) {
    return res.status(e instanceof InputError ? 400 : 500).json({
      ok: false,
      error: e.message || String(e)
    });
  }
};
