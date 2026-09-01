'use strict';

const crypto = require('node:crypto');
const C = require('../lib/config');
const { Deadline } = require('../lib/http');
const { getDraw, getDraws, score } = require('../lib/lottery');
const { selectGroups } = require('../lib/analysis');
const T = require('../lib/time');
const DB = require('../lib/db');

const LOCK = 'hotspot-worker';

/** Constant-time secret comparison so the endpoint cannot be probed by timing. */
function secretMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Work out which draw id opened the 06:00 collection window, using the latest
 * draw as an anchor and the fixed 4-minute cadence.
 *
 * The previous version trusted this blindly. If the source page was lagging and
 * returned last night's final draw, the inferred start id was hundreds of draws
 * off and the whole cycle collected the wrong window. Now an implausible anchor
 * is rejected rather than quietly poisoning the day's data.
 */
function inferCollectionStartId(latest, now) {
  const drawMinutes = T.parseDrawMinutes(latest.time);
  if (drawMinutes == null) return { error: 'Could not read the time of the latest draw' };

  const sinceSix = drawMinutes >= C.SCHEDULE.collectionStart
    ? drawMinutes - C.SCHEDULE.collectionStart
    : drawMinutes + (1440 - C.SCHEDULE.collectionStart);

  // Hot Spot runs 06:00 to 02:00 — 20 hours, 300 draws. Anything beyond that
  // means the anchor draw is not from the current cycle.
  const stepsSinceSix = Math.floor(sinceSix / C.DRAW_INTERVAL_MIN);
  if (stepsSinceSix > 300) {
    return { error: `Latest draw is timestamped ${latest.time}, outside the 6:00 AM - 2:00 AM draw window. Waiting for a fresh result.` };
  }

  const nowSinceSix = now.minutes >= C.SCHEDULE.collectionStart
    ? now.minutes - C.SCHEDULE.collectionStart
    : now.minutes + (1440 - C.SCHEDULE.collectionStart);
  const lagMinutes = nowSinceSix - sinceSix;

  return {
    startId: latest.id - stepsSinceSix,
    // A healthy source is at most a couple of draws behind the wall clock.
    warning: lagMinutes > 30 ? `Source appears ${Math.round(lagMinutes)} minutes behind the California clock.` : null,
  };
}

/**
 * Pull missing draws forward from `after` towards `latest`, in chunks, until the
 * window is complete or the time budget runs out. Progress is committed after
 * every chunk, so a run that is cut short still moves the cycle forward.
 */
async function backfill(control, latestId, deadline, cache) {
  let after = Number(control.last_seen_draw_id ?? control.start_draw_id - 1);
  const target = Math.min(latestId, Number(control.start_draw_id) + C.COLLECTION_DRAWS - 1);

  let stored = 0;
  const failures = [];

  while (after < target && !deadline.spent(6000)) {
    const chunk = Math.min(C.FETCH_CONCURRENCY * 4, target - after);
    const ids = Array.from({ length: chunk }, (_, i) => after + i + 1);

    const { draws, failed } = await getDraws(ids, { deadline, cache });
    failures.push(...failed);
    if (draws.length) stored += await DB.saveDraws(draws);

    // Only advance the cursor across a contiguous run of successes, otherwise a
    // transient failure would leave a permanent hole in the window.
    let cursor = after;
    const byId = new Map(draws.map((d) => [d.id, d]));
    while (byId.has(cursor + 1)) cursor++;
    if (cursor === after) break;

    after = cursor;
    await DB.updateGroup(control.id, { last_seen_draw_id: after });
    control.last_seen_draw_id = after;
  }

  return { stored, failures, cursor: after, complete: after >= target };
}

/** Score newly available draws against each active group. */
async function processTracking(groups, latestId, deadline, cache) {
  const details = [];
  let processed = 0;

  for (const group of groups) {
    const after = Number(group.last_seen_draw_id ?? group.start_draw_id);
    const cap = Number(group.start_draw_id) + C.MAX_TRACKED_DRAWS;
    if (after >= latestId || after >= cap) {
      details.push({ group: group.name, processed: 0, lastSeen: after, complete: after >= cap });
      continue;
    }
    if (deadline.spent(6000)) { details.push({ group: group.name, processed: 0, lastSeen: after, deferred: true }); continue; }

    const end = Math.min(latestId, cap, after + C.FETCH_CONCURRENCY * 6);
    let stored = await DB.getDrawRange(after + 1, end);

    // Fill any gaps from the source, then re-read so ordering is authoritative.
    if (stored.length < end - after) {
      const have = new Set(stored.map((d) => d.draw_id));
      const missing = [];
      for (let id = after + 1; id <= end; id++) if (!have.has(id)) missing.push(id);
      if (missing.length) {
        const { draws } = await getDraws(missing, { deadline, cache });
        if (draws.length) await DB.saveDraws(draws);
        stored = await DB.getDrawRange(after + 1, end);
      }
    }

    // Same contiguity rule as the backfill: never skip past a hole.
    const contiguous = [];
    let expected = after + 1;
    for (const d of stored) {
      if (d.draw_id !== expected) break;
      contiguous.push(d);
      expected++;
    }
    if (!contiguous.length) { details.push({ group: group.name, processed: 0, lastSeen: after }); continue; }

    const rows = contiguous.map((d) => {
      const s = score({ numbers: d.numbers, bullsEye: d.bulls_eye }, group.numbers);
      return {
        group_id: group.id,
        draw_id: d.draw_id,
        hit_count: s.count,
        hit_numbers: s.hit,
        bulls_eye: s.bullsEye,
        bulls_eye_match: s.bullsEyeMatch,
      };
    });

    await DB.saveResults(rows);
    const lastSeen = contiguous[contiguous.length - 1].draw_id;
    await DB.updateGroup(group.id, { last_seen_draw_id: lastSeen });
    processed += rows.length;
    details.push({ group: group.name, processed: rows.length, lastSeen });
  }

  return { processed, details };
}

async function replaceAutoGroup(slot, numbers, startDrawId) {
  const name = `${C.AUTO_PREFIX}${slot}`;
  const existing = await DB.db(`tracker_groups?select=id&name=eq.${encodeURIComponent(name)}&limit=1`);
  if (existing?.[0]) {
    await DB.db(`tracker_results?group_id=eq.${existing[0].id}`, { method: 'DELETE', prefer: 'return=minimal' });
    await DB.updateGroup(existing[0].id, {
      numbers, active: true, start_draw_id: startDrawId, last_seen_draw_id: startDrawId,
    });
    return existing[0].id;
  }
  const created = await DB.db('tracker_groups', {
    method: 'POST',
    prefer: 'return=representation',
    body: { name, numbers, active: true, start_draw_id: startDrawId, last_seen_draw_id: startDrawId },
  });
  return created?.[0]?.id;
}

// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (process.env.WORKER_SECRET) {
    const token = req.headers['x-worker-secret'] || req.query?.secret;
    if (!secretMatches(token, process.env.WORKER_SECRET)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  const deadline = new Deadline(C.WORKER_BUDGET_MS);
  const holder = crypto.randomUUID();
  const cache = new Map();
  let locked = false;

  try {
    const now = T.californiaNowParts();

    if (now.minutes >= C.SCHEDULE.cleanup && now.minutes < C.SCHEDULE.collectionStart) {
      locked = await DB.acquireLock(LOCK, holder);
      if (!locked) return res.status(200).json({ ok: true, mode: 'cleanup', message: 'Another run is already working.' });
      await DB.wipeCycle();
      return res.status(200).json({ ok: true, mode: 'cleanup', message: 'Cycle data cleared. Next collection starts at 6:00 AM.' });
    }

    if (now.minutes >= C.SCHEDULE.trackingEnd && now.minutes < C.SCHEDULE.cleanup) {
      return res.status(200).json({ ok: true, mode: 'idle', message: 'Tracking ended at 2:00 AM. Cleanup runs at 2:30 AM.' });
    }

    locked = await DB.acquireLock(LOCK, holder);
    if (!locked) {
      return res.status(200).json({ ok: true, mode: 'busy', message: 'Another worker run is in progress; skipping this tick.' });
    }

    const cycleKey = T.cycleDateKey(now);
    const controls = await DB.findGroups(C.CONTROL_PREFIX);
    let control = controls[controls.length - 1] || null;

    if (control && !String(control.name).endsWith(cycleKey)) {
      await DB.wipeCycle();
      control = null;
    }

    const latest = await getDraw(null, { deadline, cache });
    cache.set(latest.id, latest);

    let sourceWarning = null;
    if (!control) {
      const inferred = inferCollectionStartId(latest, now);
      if (inferred.error) return res.status(200).json({ ok: true, mode: 'waiting', message: inferred.error, latest: { id: latest.id, time: latest.time } });
      sourceWarning = inferred.warning;
      const created = await DB.db('tracker_groups', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          name: `${C.CONTROL_PREFIX}${cycleKey}`,
          numbers: [1, 2, 3, 4, 5],
          active: false,
          start_draw_id: inferred.startId,
          last_seen_draw_id: inferred.startId - 1,
        },
      });
      control = created?.[0];
      if (!control) throw new Error('Could not create the cycle control record');
    }

    const filled = await backfill(control, latest.id, deadline, cache);
    const collectionEndId = Number(control.start_draw_id) + C.COLLECTION_DRAWS - 1;
    const history = await DB.getDrawRange(control.start_draw_id, collectionEndId, C.COLLECTION_DRAWS);

    const base = {
      ok: true,
      cycle: cycleKey,
      latest: { id: latest.id, time: latest.time },
      collection: {
        have: history.length,
        need: C.COLLECTION_DRAWS,
        remaining: Math.max(0, C.COLLECTION_DRAWS - history.length),
        startDrawId: control.start_draw_id,
      },
      stored: filled.stored,
      fetchFailures: filled.failures.slice(0, 5),
      sourceWarning,
      budget: { usedMs: deadline.elapsed, remainingMs: deadline.remaining },
    };

    if (now.minutes >= C.SCHEDULE.collectionStart && now.minutes < C.SCHEDULE.selection) {
      return res.status(200).json({ ...base, mode: 'collecting' });
    }

    if (history.length < C.COLLECTION_DRAWS) {
      return res.status(200).json({
        ...base,
        mode: 'preparing',
        message: 'Finishing the 12-hour window before groups can be selected. Run the worker again to continue.',
      });
    }

    let groups = await DB.findGroups(C.AUTO_PREFIX, { activeOnly: true });
    let selection = null;

    if (groups.length === 0) {
      selection = selectGroups(history, { limit: 2 });
      if (selection.groups.length < 2) {
        return res.status(200).json({ ...base, mode: 'preparing', message: 'No 5-number group repeated out of sample in this window. Nothing will be tracked today.', selection });
      }
      // Persist the diagnostics on the control row. Re-running the search on
      // every dashboard load would be wasteful and could disagree with the
      // groups actually being tracked.
      await DB.updateGroup(control.id, {
        notes: {
          selectedAt: new Date().toISOString(),
          diagnostics: selection.diagnostics,
          groups: selection.groups.map((g) => ({
            numbers: g.numbers,
            outOfSampleCount: g.outOfSampleCount,
            pValue: g.pValue,
            passesBonferroni: g.passesBonferroni,
            passesFdr: g.passesFdr,
            verdict: g.verdict,
          })),
        },
      });

      await replaceAutoGroup(1, selection.groups[0].numbers, collectionEndId);
      await replaceAutoGroup(2, selection.groups[1].numbers, collectionEndId);
      groups = await DB.findGroups(C.AUTO_PREFIX, { activeOnly: true });
    }

    const tracking = await processTracking(groups, latest.id, deadline, cache);
    return res.status(200).json({
      ...base,
      mode: 'tracking',
      activeGroups: groups.length,
      selection,
      processed: tracking.processed,
      details: tracking.details,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  } finally {
    if (locked) await DB.releaseLock(LOCK, holder);
  }
};

module.exports.inferCollectionStartId = inferCollectionStartId;
module.exports.secretMatches = secretMatches;
