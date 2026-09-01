'use strict';

const { DB_BATCH_SIZE, WORKER_LOCK_TTL_MS } = require('./config');

/**
 * Thin Supabase (PostgREST) client plus the handful of queries this app needs.
 *
 * The important change from the previous version is that writes are batched.
 * Backfilling 80 draws used to mean 80 sequential HTTP round-trips to Supabase
 * inside a 60-second function; a single 80-row upsert does the same work in one.
 */

function credentials() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before starting. See README.md.');
  }
  return { url: url.replace(/\/+$/, ''), key };
}

async function db(path, { method = 'GET', body, prefer, headers = {} } = {}) {
  const { url, key } = credentials();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Database request failed (${response.status}) on ${path.split('?')[0]}: ${text.slice(0, 240)}`);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** Split large writes so we never exceed request-size limits. */
async function insertBatched(path, rows, { prefer } = {}) {
  let written = 0;
  for (let i = 0; i < rows.length; i += DB_BATCH_SIZE) {
    const chunk = rows.slice(i, i + DB_BATCH_SIZE);
    await db(path, { method: 'POST', prefer, body: chunk });
    written += chunk.length;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Draws
// ---------------------------------------------------------------------------

const DRAW_COLUMNS = 'draw_id,draw_date,draw_time,numbers,bulls_eye';

const toRow = (d) => ({
  draw_id: d.id, draw_date: d.date, draw_time: d.time, numbers: d.numbers, bulls_eye: d.bullsEye,
});

async function saveDraws(draws) {
  if (!draws.length) return 0;
  return insertBatched('hotspot_draws?on_conflict=draw_id', draws.map(toRow), {
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

function getDrawRange(fromId, toId, limit) {
  const cap = limit ? `&limit=${limit}` : '';
  return db(`hotspot_draws?select=${DRAW_COLUMNS}&draw_id=gte.${fromId}&draw_id=lte.${toId}&order=draw_id.asc${cap}`)
    .then((r) => r || []);
}

async function getLatestStoredDraw() {
  const rows = await db(`hotspot_draws?select=${DRAW_COLUMNS}&order=draw_id.desc&limit=1`);
  return rows?.[0] || null;
}

// ---------------------------------------------------------------------------
// Groups and results
// ---------------------------------------------------------------------------

const GROUP_COLUMNS = 'id,name,numbers,active,start_draw_id,last_seen_draw_id,notes,created_at';

function findGroups(namePrefix, { activeOnly = false } = {}) {
  const active = activeOnly ? '&active=eq.true' : '';
  return db(`tracker_groups?select=${GROUP_COLUMNS}&name=like.${encodeURIComponent(`${namePrefix}*`)}${active}&order=id.asc`)
    .then((r) => r || []);
}

async function saveResults(rows) {
  if (!rows.length) return 0;
  return insertBatched('tracker_results?on_conflict=group_id,draw_id', rows, {
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

function getResults(groupId, limit = 500) {
  return db(`tracker_results?select=draw_id,hit_count,hit_numbers,bulls_eye,bulls_eye_match&group_id=eq.${groupId}&order=draw_id.asc&limit=${limit}`)
    .then((r) => r || []);
}

function updateGroup(id, patch) {
  return db(`tracker_groups?id=eq.${id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
}

async function wipeCycle() {
  await db('tracker_results?id=not.is.null', { method: 'DELETE', prefer: 'return=minimal' });
  await db('tracker_groups?id=not.is.null', { method: 'DELETE', prefer: 'return=minimal' });
  await db('hotspot_draws?draw_id=gt.0', { method: 'DELETE', prefer: 'return=minimal' });
}

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

/**
 * Prevents two worker invocations from scraping and writing at the same time.
 * A cron tick overlapping a manual "Refresh" used to double-fetch every draw and
 * race on last_seen_draw_id.
 *
 * Acquisition is a single conditional UPDATE, which Postgres executes atomically:
 * only the caller whose UPDATE actually matched a row gets the lock back.
 */
async function acquireLock(name, holder, ttlMs = WORKER_LOCK_TTL_MS) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  await db('tracker_locks?on_conflict=name', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=minimal',
    body: [{ name, holder, expires_at: new Date(0).toISOString() }],
  });

  const claimed = await db(
    `tracker_locks?name=eq.${encodeURIComponent(name)}&expires_at=lt.${encodeURIComponent(now.toISOString())}`,
    { method: 'PATCH', prefer: 'return=representation', body: { holder, expires_at: expiresAt } },
  );
  return Array.isArray(claimed) && claimed.length > 0;
}

function releaseLock(name, holder) {
  return db(
    `tracker_locks?name=eq.${encodeURIComponent(name)}&holder=eq.${encodeURIComponent(holder)}`,
    { method: 'PATCH', prefer: 'return=minimal', body: { expires_at: new Date(0).toISOString() } },
  ).catch(() => null); // releasing is best-effort; the TTL is the real safety net
}

module.exports = {
  db, insertBatched,
  DRAW_COLUMNS, GROUP_COLUMNS,
  saveDraws, getDrawRange, getLatestStoredDraw,
  findGroups, saveResults, getResults, updateGroup, wipeCycle,
  acquireLock, releaseLock,
};
