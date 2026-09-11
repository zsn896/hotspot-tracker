'use strict';

const { getDraw, db, score } = require('./lib');
const cron = require('./cron');

const GROUP_FIVE_NAME = 'AUTO Group Five';
const GROUP_FIVE_TRACK_DRAWS = 20;
const MANUAL_GROUP_NAMES = new Set([
  'MANUAL Group',
  'MANUAL Group 2',
  'MANUAL Group 3'
]);
const MANUAL_FAST_CATCHUP_LIMIT = 25;

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

async function getActiveGroupFive() {
  const rows = await db(
    `tracker_groups?select=id,name,numbers,start_draw_id,last_seen_draw_id,active&name=eq.${encodeURIComponent(
      GROUP_FIVE_NAME
    )}&active=eq.true&order=id.desc&limit=1`
  );
  return rows?.[0] || null;
}

async function getActiveManualGroups() {
  const rows = await db(
    'tracker_groups?select=id,name,numbers,start_draw_id,last_seen_draw_id,active&active=eq.true&order=id.asc&limit=200'
  );

  return (rows || []).filter(
    group =>
      MANUAL_GROUP_NAMES.has(String(group?.name || '')) &&
      Array.isArray(group?.numbers) &&
      group.numbers.length === 5
  );
}

function groupFiveStatus(group, officialId) {
  if (!group) {
    return {
      active: false,
      startId: 0,
      lastSeenId: 0,
      cutoffId: 0,
      targetId: 0,
      trackingLag: 0,
      rotationDue: false,
      needsWork: false
    };
  }

  const startId = Number(group.start_draw_id || 0);
  const lastSeenId = Number(group.last_seen_draw_id ?? startId ?? 0);
  const cutoffId = startId + GROUP_FIVE_TRACK_DRAWS;
  const targetId = Math.min(Number(officialId || 0), cutoffId);
  const trackingLag = Math.max(0, targetId - lastSeenId);
  const rotationDue =
    startId > 0 &&
    Number(officialId || 0) >= cutoffId &&
    lastSeenId >= cutoffId;

  return {
    active: true,
    startId,
    lastSeenId,
    cutoffId,
    targetId,
    trackingLag,
    rotationDue,
    needsWork: trackingLag > 0 || rotationDue
  };
}

function groupFivePayload(status) {
  return {
    active: status.active,
    startDrawId: status.startId || null,
    lastSeenDrawId: status.lastSeenId || null,
    targetDrawId: status.targetId || null,
    cutoffDrawId: status.cutoffId || null,
    lag: status.trackingLag,
    rotationDue: status.rotationDue
  };
}

async function storeDraw(draw) {
  await db('hotspot_draws?on_conflict=draw_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: {
      draw_id: draw.id,
      draw_date: draw.date,
      draw_time: draw.time,
      numbers: draw.numbers,
      bulls_eye: draw.bullsEye
    }
  });
}

/*
  Lightweight Group Five alignment for browser reads.

  This intentionally processes at most one already-stored draw and never rotates
  or selects a new group. Rotation/selection stays in the scheduled cron. The
  purpose is only to keep the active group's visible result on the same draw as
  the latest stored official draw without invoking the heavy cron pipeline.
*/
async function catchUpGroupFiveOne(group, officialId) {
  if (!group || !Array.isArray(group.numbers) || group.numbers.length !== 5) {
    return false;
  }

  const status = groupFiveStatus(group, officialId);
  if (status.trackingLag <= 0) {
    return false;
  }

  const nextId = status.lastSeenId + 1;
  if (nextId > status.targetId || nextId > status.cutoffId) {
    return false;
  }

  const rows = await db(
    `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=eq.${nextId}&limit=1`
  );
  const d = rows?.[0];
  if (!d || Number(d.draw_id || 0) !== nextId) {
    return false;
  }

  const result = score(
    {
      id: Number(d.draw_id),
      date: d.draw_date,
      time: d.draw_time,
      numbers: d.numbers,
      bullsEye: d.bulls_eye
    },
    group.numbers
  );

  await db('tracker_results?on_conflict=group_id,draw_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: {
      group_id: group.id,
      draw_id: nextId,
      hit_count: result.count,
      hit_numbers: result.hit,
      bulls_eye: result.bullsEye,
      bulls_eye_match: result.bullsEyeMatch
    }
  });

  await db(`tracker_groups?id=eq.${group.id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: {
      last_seen_draw_id: nextId
    }
  });

  return true;
}

/*
  Manual Groups 1/2/3 must advance their tracking cursor on every verified draw,
  even when the draw is only a 0/5, 1/5 or 2/5. Only 3/5+ rows belong in the
  visible result history. This mirrors api/group.js and api/fusion.js, but uses
  already-stored draws only so a browser refresh remains lightweight.
*/
async function catchUpManualGroups(targetDrawId) {
  const groups = await getActiveManualGroups();
  let groupsUpdated = 0;
  let drawsProcessed = 0;
  let strongHitsRecorded = 0;

  for (const group of groups) {
    const startId = Number(group.start_draw_id || 0);
    const after = Number(group.last_seen_draw_id ?? startId ?? 0);
    const target = Number(targetDrawId || 0);

    if (!Number.isFinite(after) || !target || after >= target) {
      continue;
    }

    const end = Math.min(target, after + MANUAL_FAST_CATCHUP_LIMIT);
    const rows = (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gt.${after}&draw_id=lte.${end}&order=draw_id.asc&limit=${MANUAL_FAST_CATCHUP_LIMIT}`
      )
    ) || [];

    let expected = after + 1;
    let lastProcessed = after;
    let processedForGroup = 0;

    for (const d of rows) {
      const drawId = Number(d?.draw_id || 0);

      /* Never jump over a missing draw; the scheduled cron can repair gaps. */
      if (drawId !== expected) {
        break;
      }

      const result = score(
        {
          id: drawId,
          date: d.draw_date,
          time: d.draw_time,
          numbers: d.numbers,
          bullsEye: d.bulls_eye
        },
        group.numbers
      );

      if (Number(result?.count || 0) >= 3) {
        await db('tracker_results?on_conflict=group_id,draw_id', {
          method: 'POST',
          prefer: 'resolution=merge-duplicates,return=minimal',
          body: {
            group_id: group.id,
            draw_id: drawId,
            hit_count: result.count,
            hit_numbers: result.hit,
            bulls_eye: result.bullsEye,
            bulls_eye_match: result.bullsEyeMatch
          }
        });
        strongHitsRecorded++;
      }

      lastProcessed = drawId;
      processedForGroup++;
      drawsProcessed++;
      expected++;
    }

    if (lastProcessed > after) {
      await db(`tracker_groups?id=eq.${group.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          last_seen_draw_id: lastProcessed
        }
      });
      groupsUpdated++;
    }
  }

  return {
    groupsUpdated,
    drawsProcessed,
    strongHitsRecorded,
    updated: groupsUpdated > 0
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store,max-age=0');

  try {
    const method = String(req.method || 'GET').toUpperCase();

    if (method !== 'GET' && method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    let official = await getDraw(null);

    if (!Number(official?.id || 0)) {
      return res.status(502).json({
        ok: false,
        error: 'Unable to read official latest draw'
      });
    }

    const storedRows = await db(
      'hotspot_draws?select=draw_id,draw_date,draw_time&order=draw_id.desc&limit=1'
    );
    let storedId = Number(storedRows?.[0]?.draw_id || 0);

    /*
      The public Hot Spot page can briefly serve server-side HTML one draw behind
      the live browser view. Probe ONLY the exact next draw on the official Past
      Winning Numbers page. getDraw(id) rejects the response unless the official
      page returns that exact draw ID, so this never invents or predicts a draw.

      On browser GET requests, store that one verified draw immediately. This is
      intentionally lightweight: the scheduled cron still performs all heavy
      tracking/analysis work in the background.
    */
    let fastForwarded = false;
    if (storedId > 0) {
      const nextId = storedId + 1;
      try {
        const next = await getDraw(nextId);
        if (Number(next?.id || 0) === nextId) {
          official = next;
          if (method === 'GET') {
            await storeDraw(next);
            storedId = nextId;
            fastForwarded = true;
          }
        }
      } catch (_) {
        // Exact next draw is not published on the official historical page yet.
      }
    }

    const officialId = Number(official?.id || 0);
    const drawLag = Math.max(0, officialId - storedId);

    let groupFiveBefore = await getActiveGroupFive();
    let gfBefore = groupFiveStatus(groupFiveBefore, officialId);
    let groupFiveFastForwarded = false;
    let manualFastSync = {
      groupsUpdated: 0,
      drawsProcessed: 0,
      strongHitsRecorded: 0,
      updated: false
    };

    if (method === 'GET') {
      if (gfBefore.trackingLag > 0) {
        groupFiveFastForwarded = await catchUpGroupFiveOne(
          groupFiveBefore,
          officialId
        );

        if (groupFiveFastForwarded) {
          groupFiveBefore = await getActiveGroupFive();
          gfBefore = groupFiveStatus(groupFiveBefore, officialId);
        }
      }

      /* Align Manual Group 1, 2 and 3 to the latest stored official draw too. */
      manualFastSync = await catchUpManualGroups(storedId);
    }

    /*
      Browser/UI reads stay fast. GET may write one exact verified official draw,
      align one active Group Five result, and advance manual group cursors using
      stored draws only. It never launches the expensive cron pipeline.
    */
    if (method === 'GET') {
      const current = storedId >= officialId && !gfBefore.needsWork;
      return res.status(200).json({
        ok: true,
        synced:
          fastForwarded ||
          groupFiveFastForwarded ||
          manualFastSync.updated,
        reason: fastForwarded
          ? 'fast-forwarded-one-official-draw'
          : groupFiveFastForwarded
            ? 'aligned-group-five-one-draw'
            : manualFastSync.updated
              ? 'aligned-manual-groups'
              : current
                ? 'already-current'
                : 'background-sync-pending',
        officialDrawId: officialId,
        storedDrawId: storedId,
        lag: Math.max(0, officialId - storedId),
        drawLag: Math.max(0, officialId - storedId),
        groupFive: groupFivePayload(gfBefore),
        manual: manualFastSync,
        caughtUp: current,
        backgroundSync: !current,
        fastForwarded,
        groupFiveFastForwarded
      });
    }

    if (!process.env.CRON_SECRET) {
      return res.status(500).json({
        ok: false,
        error: 'CRON_SECRET is not configured'
      });
    }

    if (!process.env.WORKER_SECRET) {
      return res.status(500).json({
        ok: false,
        error: 'WORKER_SECRET is not configured'
      });
    }

    const collector = createCollector();
    const internalReq = {
      ...req,
      headers: {
        ...(req.headers || {}),
        authorization: `Bearer ${process.env.CRON_SECRET}`
      }
    };

    await cron(internalReq, collector);

    if (collector.statusCode >= 400 || collector.payload?.ok === false) {
      return res.status(collector.statusCode || 500).json({
        ok: false,
        error: collector.payload?.error || 'Internal sync failed',
        officialDrawId: officialId,
        storedDrawId: storedId,
        drawLag,
        groupFiveLag: gfBefore.trackingLag,
        groupFiveRotationDue: gfBefore.rotationDue
      });
    }

    const afterRows = await db(
      'hotspot_draws?select=draw_id,draw_date,draw_time&order=draw_id.desc&limit=1'
    );
    const afterId = Number(afterRows?.[0]?.draw_id || 0);
    const remainingDrawLag = Math.max(0, officialId - afterId);

    const groupFiveAfter = await getActiveGroupFive();
    const gfAfter = groupFiveStatus(groupFiveAfter, officialId);
    const fullyCaughtUp = afterId >= officialId && !gfAfter.needsWork;

    return res.status(200).json({
      ok: true,
      synced: true,
      officialDrawId: officialId,
      beforeStoredDrawId: storedId,
      storedDrawId: afterId,
      previousLag: drawLag,
      remainingLag: remainingDrawLag,
      drawLagBefore: drawLag,
      drawLagAfter: remainingDrawLag,
      groupFive: {
        active: gfAfter.active,
        startDrawId: gfAfter.startId || null,
        lastSeenBefore: gfBefore.lastSeenId || null,
        lastSeenDrawId: gfAfter.lastSeenId || null,
        targetDrawId: gfAfter.targetId || null,
        cutoffDrawId: gfAfter.cutoffId || null,
        lagBefore: gfBefore.trackingLag,
        lagAfter: gfAfter.trackingLag,
        rotationDueBefore: gfBefore.rotationDue,
        rotationDueAfter: gfAfter.rotationDue
      },
      caughtUp: fullyCaughtUp,
      worker: {
        mode: collector.payload?.mode || null,
        groupFive: collector.payload?.groupFive || null
      }
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message || String(e)
    });
  }
};
