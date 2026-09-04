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

  const startId =
    Number(
      group.start_draw_id || 0
    );

  const lastSeenId =
    Number(
      group.last_seen_draw_id ??
      startId ??
      0
    );

  const cutoffId =
    startId +
    GROUP_FIVE_TRACK_DRAWS;

  const targetId =
    Math.min(
      Number(officialId || 0),
      cutoffId
    );

  const trackingLag =
    Math.max(
      0,
      targetId - lastSeenId
    );

  /*
    IMPORTANT:

    At exactly 20/20 Group Five must rotate.

    Old behavior:
    lastSeen == cutoff
    trackingLag == 0

    Smart Sync incorrectly thought everything
    was current.

    New behavior:
    reaching cutoff itself means the old group
    must be rotated immediately.
  */

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

    needsWork:
      trackingLag > 0 ||
      rotationDue
  };
}

module.exports =
async (
  req,
  res
) => {

  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );

  try {

    const method =
      String(
        req.method || 'GET'
      ).toUpperCase();

    if (
      method !== 'GET' &&
      method !== 'POST'
    ) {

      return res
        .status(405)
        .json({
          ok: false,
          error:
            'Method not allowed'
        });
    }


    /* =====================================================
       OFFICIAL DRAW
    ===================================================== */

    const official =
      await getDraw(null);

    const officialId =
      Number(
        official?.id || 0
      );

    if (!officialId) {

      return res
        .status(502)
        .json({
          ok: false,
          error:
            'Unable to read official latest draw'
        });
    }


    /* =====================================================
       STORED DRAW
    ===================================================== */

    const storedRows =
      await db(
        'hotspot_draws?select=draw_id,draw_date,draw_time&order=draw_id.desc&limit=1'
      );

    const storedId =
      Number(
        storedRows?.[0]
          ?.draw_id || 0
      );

    const drawLag =
      Math.max(
        0,
        officialId -
        storedId
      );


    /* =====================================================
       GROUP FIVE STATUS
    ===================================================== */

    const groupFiveBefore =
      await getActiveGroupFive();

    const gfBefore =
      groupFiveStatus(
        groupFiveBefore,
        officialId
      );


    /* =====================================================
       REALLY CURRENT?
    ===================================================== */

    if (
      storedId >= officialId &&
      !gfBefore.needsWork
    ) {

      return res
        .status(200)
        .json({
          ok: true,

          synced: false,

          reason:
            'already-current',

          officialDrawId:
            officialId,

          storedDrawId:
            storedId,

          lag: 0,

          drawLag: 0,

          groupFive: {
            active:
              gfBefore.active,

            startDrawId:
              gfBefore.startId ||
              null,

            lastSeenDrawId:
              gfBefore.lastSeenId ||
              null,

            targetDrawId:
              gfBefore.targetId ||
              null,

            cutoffDrawId:
              gfBefore.cutoffId ||
              null,

            lag:
              gfBefore.trackingLag,

            rotationDue:
              gfBefore.rotationDue
          }
        });
    }


    /* =====================================================
       SECRETS
    ===================================================== */

    if (
      !process.env
        .CRON_SECRET
    ) {

      return res
        .status(500)
        .json({
          ok: false,

          error:
            'CRON_SECRET is not configured'
        });
    }


    if (
      !process.env
        .WORKER_SECRET
    ) {

      return res
        .status(500)
        .json({
          ok: false,

          error:
            'WORKER_SECRET is not configured'
        });
    }


    /* =====================================================
       RUN CRON
    ===================================================== */

    const collector =
      createCollector();


    const internalReq = {

      ...req,

      headers: {

        ...(
          req.headers || {}
        ),

        authorization:
          `Bearer ${process.env.CRON_SECRET}`
      }
    };


    await cron(
      internalReq,
      collector
    );


    if (
      collector.statusCode >= 400 ||
      collector.payload?.ok === false
    ) {

      return res
        .status(
          collector.statusCode ||
          500
        )
        .json({
          ok: false,

          error:
            collector.payload
              ?.error ||
            'Internal sync failed',

          officialDrawId:
            officialId,

          storedDrawId:
            storedId,

          drawLag,

          groupFiveLag:
            gfBefore.trackingLag,

          groupFiveRotationDue:
            gfBefore.rotationDue
        });
    }


    /* =====================================================
       VERIFY STORED DRAW
    ===================================================== */

    const afterRows =
      await db(
        'hotspot_draws?select=draw_id,draw_date,draw_time&order=draw_id.desc&limit=1'
      );

    const afterId =
      Number(
        afterRows?.[0]
          ?.draw_id || 0
      );

    const remainingDrawLag =
      Math.max(
        0,
        officialId -
        afterId
      );


    /* =====================================================
       VERIFY GROUP FIVE
    ===================================================== */

    const groupFiveAfter =
      await getActiveGroupFive();

    const gfAfter =
      groupFiveStatus(
        groupFiveAfter,
        officialId
      );


    const fullyCaughtUp =
      afterId >= officialId &&
      !gfAfter.needsWork;


    return res
      .status(200)
      .json({

        ok: true,

        synced: true,

        officialDrawId:
          officialId,

        beforeStoredDrawId:
          storedId,

        storedDrawId:
          afterId,

        previousLag:
          drawLag,

        remainingLag:
          remainingDrawLag,

        drawLagBefore:
          drawLag,

        drawLagAfter:
          remainingDrawLag,

        groupFive: {

          active:
            gfAfter.active,

          startDrawId:
            gfAfter.startId ||
            null,

          lastSeenBefore:
            gfBefore.lastSeenId ||
            null,

          lastSeenDrawId:
            gfAfter.lastSeenId ||
            null,

          targetDrawId:
            gfAfter.targetId ||
            null,

          cutoffDrawId:
            gfAfter.cutoffId ||
            null,

          lagBefore:
            gfBefore.trackingLag,

          lagAfter:
            gfAfter.trackingLag,

          rotationDueBefore:
            gfBefore.rotationDue,

          rotationDueAfter:
            gfAfter.rotationDue
        },

        caughtUp:
          fullyCaughtUp,

        worker: {

          mode:
            collector.payload
              ?.mode ||
            null,

          groupFive:
            collector.payload
              ?.groupFive ||
            null
        }
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
