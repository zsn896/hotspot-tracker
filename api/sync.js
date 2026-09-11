'use strict';

const { getDraw, db } = require('./lib');
const cron = require('./cron');

const GROUP_FIVE_NAME = 'AUTO Group Five';
const GROUP_FIVE_TRACK_DRAWS = 20;

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
    `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id,active&name=eq.${encodeURIComponent(
      GROUP_FIVE_NAME
    )}&active=eq.true&order=id.desc&limit=1`
  );
  return rows?.[0] || null;
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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store,max-age=0');

  try {
    const method = String(req.method || 'GET').toUpperCase();

    if (method !== 'GET' && method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const official = await getDraw(null);
    const officialId = Number(official?.id || 0);

    if (!officialId) {
      return res.status(502).json({
        ok: false,
        error: 'Unable to read official latest draw'
      });
    }

    const storedRows = await db(
      'hotspot_draws?select=draw_id,draw_date,draw_time&order=draw_id.desc&limit=1'
    );
    const storedId = Number(storedRows?.[0]?.draw_id || 0);
    const drawLag = Math.max(0, officialId - storedId);

    const groupFiveBefore = await getActiveGroupFive();
    const gfBefore = groupFiveStatus(groupFiveBefore, officialId);

    /*
      Browser/UI reads must stay fast. GET now reports sync state only and never
      launches the expensive cron pipeline. The scheduled GitHub cron performs
      catch-up in the background. POST remains available for an explicit sync.
    */
    if (method === 'GET') {
      const current = storedId >= officialId && !gfBefore.needsWork;
      return res.status(200).json({
        ok: true,
        synced: false,
        reason: current ? 'already-current' : 'background-sync-pending',
        officialDrawId: officialId,
        storedDrawId: storedId,
        lag: drawLag,
        drawLag,
        groupFive: groupFivePayload(gfBefore),
        caughtUp: current,
        backgroundSync: !current
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
