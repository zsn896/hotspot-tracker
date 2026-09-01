'use strict';

/**
 * End-to-end test of the two real endpoints.
 *
 * Nothing here is mocked at the module level: api/worker.js and api/state.js run
 * unmodified. Only two things are replaced — global fetch (routed to a fake
 * lottery page and an in-memory PostgREST emulator) and the clock. That means a
 * pass really does exercise scraping, parsing, batching, locking, selection,
 * scoring, block reporting and the JSON contract the dashboard consumes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://db.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.HOTSPOT_SOURCE_URL = 'https://lottery.test/results';
delete process.env.WORKER_SECRET;

// ---------------------------------------------------------------------------
// Clock control
// ---------------------------------------------------------------------------

const RealDate = Date;
function freezeClock(iso) {
  const fixed = new RealDate(iso).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
}
function restoreClock() { globalThis.Date = RealDate; }

// ---------------------------------------------------------------------------
// Fake lottery source
// ---------------------------------------------------------------------------

/** Deterministic 20-number draw derived from the draw id. */
function drawFor(id) {
  let seed = (id * 2654435761) >>> 0;
  const next = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  const pool = Array.from({ length: 80 }, (_, i) => i + 1);
  for (let i = 79; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const numbers = pool.slice(0, 20).sort((a, b) => a - b);
  return { numbers, bullsEye: numbers[Math.floor(next() * 20)] };
}

const LATEST_ID = 5001000;

function lotteryPage(url) {
  const requested = url.searchParams.get('query');
  const id = requested ? Number(requested) : LATEST_ID;
  const { numbers, bullsEye } = drawFor(id);
  // Draws run every 4 minutes; id LATEST_ID sits at 6:58 p.m.
  const minutes = ((18 * 60 + 58) - (LATEST_ID - id) * 4 + 1440) % 1440;
  const h12 = Math.floor(minutes / 60) % 12 || 12;
  const clock = `${h12}:${String(minutes % 60).padStart(2, '0')} ${minutes >= 720 ? 'p.m.' : 'a.m.'}`;
  return `<html><head><style>.b{width:20px}</style></head><body>
    <p>Draw Number: ${id}</p>
    <p>Draw Date: Wed, Jun 3, 2026 | Draw Time: ${clock}</p>
    <span>Match 12 of 20 to win</span>
    <ul>${numbers.map((n) => `<li>${n}</li>`).join('')}</ul>
    <p>The Bulls-eye number is ${bullsEye}.</p>
    <p>Overall odds 1 in 9.05</p></body></html>`;
}

// ---------------------------------------------------------------------------
// In-memory PostgREST emulator
// ---------------------------------------------------------------------------

const tables = { hotspot_draws: [], tracker_groups: [], tracker_results: [], tracker_locks: [] };
const sequences = { tracker_groups: 1, tracker_results: 1 };
const counters = { drawWrites: 0, sourceRequests: 0 };

const OPS = {
  eq: (a, b) => String(a) === b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => (Number.isNaN(Date.parse(b)) ? Number(a) < Number(b) : Date.parse(a) < Date.parse(b)),
  lte: (a, b) => Number(a) <= Number(b),
  like: (a, b) => new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '*' ? '.*' : `\\${m}`)).replace(/\\\*/g, '.*')}$`).test(String(a)),
  in: (a, b) => b.replace(/[()]/g, '').split(',').includes(String(a)),
};

function applyFilters(rows, params) {
  return rows.filter((row) => {
    for (const [key, raw] of params) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue;
      if (raw === 'not.is.null') { if (row[key] == null) return false; continue; }
      const [op, ...rest] = raw.split('.');
      const value = rest.join('.');
      if (!OPS[op]) throw new Error(`emulator: unsupported operator ${op}`);
      if (!OPS[op](row[key], value)) return false;
    }
    return true;
  });
}

function postgrest(url, init) {
  const table = url.pathname.replace('/rest/v1/', '');
  if (!tables[table]) throw new Error(`emulator: unknown table ${table}`);
  const params = [...url.searchParams.entries()];
  const method = (init.method || 'GET').toUpperCase();
  const prefer = init.headers?.prefer || '';
  const body = init.body ? JSON.parse(init.body) : null;

  if (method === 'GET') {
    let rows = applyFilters(tables[table], params);
    const order = url.searchParams.get('order');
    if (order) {
      const [col, dir] = order.split('.');
      rows = [...rows].sort((a, b) => (dir === 'desc' ? 1 : -1) * (Number(b[col]) - Number(a[col])));
    }
    const limit = url.searchParams.get('limit');
    if (limit) rows = rows.slice(0, Number(limit));
    return { status: 200, body: JSON.stringify(rows) };
  }

  if (method === 'POST') {
    const conflict = (url.searchParams.get('on_conflict') || '').split(',').filter(Boolean);
    const inserted = [];
    for (const record of Array.isArray(body) ? body : [body]) {
      const existing = conflict.length
        ? tables[table].find((r) => conflict.every((k) => String(r[k]) === String(record[k])))
        : null;
      if (existing) {
        if (prefer.includes('ignore-duplicates')) { inserted.push(existing); continue; }
        Object.assign(existing, record);
        inserted.push(existing);
        continue;
      }
      const row = { ...record };
      if (table in sequences) row.id = sequences[table]++;
      if (table === 'hotspot_draws') counters.drawWrites++;
      tables[table].push(row);
      inserted.push(row);
    }
    return { status: 201, body: prefer.includes('return=representation') ? JSON.stringify(inserted) : '' };
  }

  if (method === 'PATCH') {
    const matched = applyFilters(tables[table], params);
    for (const row of matched) Object.assign(row, body);
    return { status: 200, body: prefer.includes('return=representation') ? JSON.stringify(matched) : '' };
  }

  if (method === 'DELETE') {
    const doomed = new Set(applyFilters(tables[table], params));
    tables[table] = tables[table].filter((r) => !doomed.has(r));
    return { status: 204, body: '' };
  }

  throw new Error(`emulator: unsupported method ${method}`);
}

/** Route global fetch to the fake lottery page or the database emulator. */
function installFetchProperly() {
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.hostname === 'lottery.test') {
      counters.sourceRequests++;
      return new Response(lotteryPage(url), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    const result = postgrest(url, init);
    return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
  };
}

function fakeResponse() {
  const captured = { status: 0, payload: null, headers: {} };
  return {
    captured,
    setHeader(k, v) { captured.headers[k] = v; },
    status(code) { captured.status = code; return this; },
    json(payload) { captured.payload = payload; return this; },
  };
}

async function call(handler, query = {}) {
  const res = fakeResponse();
  await handler({ query, headers: {} }, res);
  return res.captured;
}

// ---------------------------------------------------------------------------

test('worker and state run a full cycle end to end', async (t) => {
  const originalFetch = globalThis.fetch;
  installFetchProperly();
  // 2026-06-03 19:00 America/Los_Angeles (PDT) — inside the tracking phase.
  freezeClock('2026-06-04T02:00:00.000Z');

  t.after(() => { globalThis.fetch = originalFetch; restoreClock(); });

  const worker = require('../api/worker');
  const state = require('../api/state');

  // --- first run: collect the window and select groups ---------------------
  const first = await call(worker);
  assert.equal(first.status, 200);
  assert.equal(first.payload.ok, true, JSON.stringify(first.payload));
  assert.equal(first.payload.mode, 'tracking', `expected tracking, got ${first.payload.mode}: ${first.payload.message || ''}`);
  assert.equal(first.payload.collection.have, 180, 'the full 12-hour window should be collected');
  assert.equal(first.payload.activeGroups, 2);
  assert.equal(first.payload.fetchFailures.length, 0);

  const diagnostics = first.payload.selection.diagnostics;
  assert.equal(diagnostics.mineWindowDraws, 90);
  assert.equal(diagnostics.testWindowDraws, 90);
  assert.ok(diagnostics.candidatesTested > 1000);

  // Groups must be genuine 5-number sets, and distinct from one another.
  const groups = tables.tracker_groups.filter((g) => g.active);
  assert.equal(groups.length, 2);
  for (const g of groups) {
    assert.equal(new Set(g.numbers).size, 5);
    assert.ok(g.numbers.every((n) => n >= 1 && n <= 80));
  }
  assert.notEqual(groups[0].numbers.join(), groups[1].numbers.join());

  // --- scoring must agree with the source data ----------------------------
  const results = tables.tracker_results.filter((r) => r.group_id === groups[0].id);
  assert.ok(results.length > 0, 'tracking should have scored at least one draw');
  for (const row of results.slice(0, 20)) {
    const truth = drawFor(row.draw_id);
    const expectedHits = groups[0].numbers.filter((n) => truth.numbers.includes(n));
    assert.equal(row.hit_count, expectedHits.length, `hit count wrong for draw ${row.draw_id}`);
    assert.deepEqual(row.hit_numbers, expectedHits);
    assert.equal(row.bulls_eye_match, groups[0].numbers.includes(truth.bullsEye));
  }

  // --- idempotence: a second run must not duplicate or re-fetch ------------
  const drawsBefore = tables.hotspot_draws.length;
  const resultsBefore = tables.tracker_results.length;
  const requestsBefore = counters.sourceRequests;

  const second = await call(worker);
  assert.equal(second.payload.ok, true);
  assert.equal(tables.hotspot_draws.length, drawsBefore, 'no duplicate draws');
  assert.equal(tables.tracker_results.length, resultsBefore, 'no duplicate results');
  assert.ok(counters.sourceRequests - requestsBefore <= 3, 'a caught-up worker should barely touch the source');
  assert.equal(new Set(tables.hotspot_draws.map((d) => d.draw_id)).size, tables.hotspot_draws.length);

  // --- the lock keeps concurrent runs out ----------------------------------
  const DB = require('../lib/db');
  await DB.acquireLock('hotspot-worker', 'someone-else');
  const blocked = await call(worker);
  assert.equal(blocked.payload.mode, 'busy', 'a held lock must stop a second worker');
  await DB.releaseLock('hotspot-worker', 'someone-else');

  // --- the dashboard contract ----------------------------------------------
  const view = await call(state);
  assert.equal(view.status, 200);
  assert.equal(view.payload.ok, true);
  assert.equal(view.payload.mode, 'tracking');
  assert.equal(view.payload.workerStale, false);
  assert.equal(view.payload.groups.length, 2);

  // Board frequencies must sum to 20 numbers x 180 draws.
  const board = view.payload.board;
  assert.equal(board.windowDraws, 180);
  assert.equal(board.frequency.reduce((a, b) => a + b, 0), 180 * 20);
  assert.equal(board.expectedPerNumber, 45);

  assert.equal(view.payload.chanceModel.fullGroupOdds, 1551);
  assert.equal(view.payload.chanceModel.expectedHitsPerDraw, 1.25);
  assert.ok(view.payload.selection.diagnostics.candidatesTested > 0);

  for (const group of view.payload.groups) {
    assert.ok(group.analysis, 'timing analysis should be present with a full window');
    assert.equal(group.analysis.numbers.length, 5);
    assert.ok(group.performance.ready);
    assert.equal(group.performance.draws, group.results.length);
    assert.equal(group.performance.observed.reduce((a, b) => a + b, 0), group.results.length);
    assert.ok(group.performance.observedMeanHits >= 0 && group.performance.observedMeanHits <= 5);
    assert.ok(['similar spacing', 'more evenly spaced', 'more erratic'].includes(group.analysis.stability));
  }
});

test('state reports a stale cycle instead of showing yesterday as today', async (t) => {
  const originalFetch = globalThis.fetch;
  installFetchProperly();
  // Same data, but the clock has moved to the next cycle.
  freezeClock('2026-06-05T02:00:00.000Z');
  t.after(() => { globalThis.fetch = originalFetch; restoreClock(); });

  const view = await call(require('../api/state'));
  assert.equal(view.payload.ok, true);
  assert.equal(view.payload.workerStale, true);
  assert.match(view.payload.workerMessage, /worker/i);
  assert.equal(view.payload.collection.have, 0, 'a previous cycle must not count as collected');
});

test('the worker refuses to run without database credentials', async (t) => {
  const originalFetch = globalThis.fetch;
  const url = process.env.SUPABASE_URL;
  installFetchProperly();
  delete process.env.SUPABASE_URL;
  t.after(() => { globalThis.fetch = originalFetch; process.env.SUPABASE_URL = url; restoreClock(); });
  freezeClock('2026-06-04T02:00:00.000Z');

  const result = await call(require('../api/worker'));
  assert.equal(result.status, 500);
  assert.match(result.payload.error, /SUPABASE_URL/);
});

test('the worker rejects a bad secret', async (t) => {
  process.env.WORKER_SECRET = 'topsecret';
  t.after(() => { delete process.env.WORKER_SECRET; });
  const denied = await call(require('../api/worker'), { secret: 'wrong' });
  assert.equal(denied.status, 401);
});
