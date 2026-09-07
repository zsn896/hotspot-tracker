'use strict';

const worker =
  require('./worker');

const {
  db,
  getDraw,
  getMany,
  score,
  parseDrawMinutes
} =
  require('./lib');

const {
  runActiveDensitySpecial
} =
  require('../lib/special-active');

const {
  runAdvanced
} =
  require('../lib/advanced');

const {
  runGroupFive
} =
  require('../lib/group-five');

const {
  analyzeGroupWave
} =
  require('../lib/wave-engine');

const {
  analyzePrecursors
} =
  require('../lib/precursor-engine');

const AUTO_PREFIX = 'AUTO Group ';
const MANUAL_PREFIX = 'MANUAL Group';
const CONTROL_PREFIX = 'AUTO_CONTROL_';

const CLOSE_START_MINUTES = 120;
const MAX_CLOSE_BACKFILL = 80;
const PRECURSOR_HISTORY_DAYS = 180;
const PRECURSOR_CRON_BACKFILL = 48;
const PRECURSOR_LIVE_PAGE_SIZE = 1000;
const PRECURSOR_LIVE_MAX_DRAWS = 50000;
const PRECURSOR_LIVE_GROUP_LIMIT = 6;


function normalizeFive(values) {

  return [
    ...new Set(
      (values || [])
        .map(Number)
        .filter(
          n =>
            Number.isInteger(n) &&
            n >= 1 &&
            n <= 80
        )
    )
  ]
    .sort(
      (a, b) =>
        a - b
    );
}


function createCollector() {

  return {

    statusCode:
      200,

    payload:
      null,

    headers:
      {},


    setHeader(
      name,
      value
    ) {

      this.headers[
        name
      ] =
        value;

      return this;
    },


    status(
      code
    ) {

      this.statusCode =
        code;

      return this;
    },


    json(
      value
    ) {

      this.payload =
        value;

      return value;
    }
  };
}


/* =========================================================
   GROUP FIVE WAVE / 12H LEARNER
========================================================= */

async function buildGroupFiveWave(groupFive) {

  const group =
    normalizeFive(
      groupFive?.numbers
    );

  if (
    !groupFive?.active ||
    group.length !== 5
  ) {

    return null;
  }


  const controls =
    (
      await db(
        `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id&name=like.${encodeURIComponent(
          CONTROL_PREFIX + '*'
        )}&order=id.desc&limit=20`
      )
    ) || [];


  const control =
    controls.find(
      row =>
        /^AUTO_CONTROL_\d{4}-\d{2}-\d{2}$/.test(
          String(
            row?.name || ''
          )
        )
    ) || null;


  if (!control?.start_draw_id) {

    return analyzeGroupWave(
      [],
      group
    );
  }


  const draws =
    (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gte.${Number(
          control.start_draw_id
        )}&order=draw_id.asc&limit=500`
      )
    ) || [];


  return analyzeGroupWave(
    draws,
    group
  );
}


function attachWaveToGroupFive(
  groupFive,
  wave
) {

  if (!groupFive) {
    return groupFive;
  }

  if (!wave) {
    return {
      ...groupFive,
      wave: null,
      waveState: null,
      waveStateAr: null,
      waveScore: null,
      waveAlert: false,
      waveAlertLevel: 'NONE',
      waveMessageAr: null
    };
  }

  return {
    ...groupFive,

    wave,

    waveState:
      wave.state ||
      null,

    waveStateAr:
      wave.stateAr ||
      null,

    waveScore:
      Number.isFinite(
        Number(wave.score)
      )
        ? Number(wave.score)
        : null,

    waveAlert:
      Boolean(
        wave.alert
      ),

    waveAlertLevel:
      wave.alertLevel ||
      'NONE',

    waveMessageAr:
      wave.messageAr ||
      null
  };
}


/* =========================================================
   STORE FINAL DRAW
========================================================= */

async function storeCloseDraw(draw) {

  if (!draw?.id) {
    return;
  }

  await db(
    'hotspot_draws?on_conflict=draw_id',
    {
      method:
        'POST',

      prefer:
        'resolution=merge-duplicates,return=minimal',

      body: {
        draw_id:
          draw.id,

        draw_date:
          draw.date,

        draw_time:
          draw.time,

        numbers:
          draw.numbers,

        bulls_eye:
          draw.bullsEye
      }
    }
  );
}


/* =========================================================
   PRECURSOR HISTORY BACKFILL
========================================================= */

function parsedDate(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : null;
}


async function precursorHistoryBackfill() {
  const edges =
    (
      await db(
        'hotspot_draws?select=draw_id,draw_date&order=draw_id.asc&limit=1'
      )
    ) || [];

  const oldest =
    edges[0] ||
    null;

  if (!oldest?.draw_id) {
    return {
      ok: false,
      stored: 0,
      completeSixMonths: false,
      reason: 'no-stored-draws'
    };
  }

  const oldestTime =
    parsedDate(
      oldest.draw_date
    );

  const now =
    Date.now();

  const coverageDays =
    oldestTime == null
      ? 0
      : Math.max(
          0,
          Math.floor(
            (now - oldestTime) /
            86400000
          )
        );

  if (
    coverageDays >=
    PRECURSOR_HISTORY_DAYS
  ) {
    return {
      ok: true,
      stored: 0,
      completeSixMonths: true,
      coverageDays,
      oldestDrawId: Number(oldest.draw_id),
      oldestDate: oldest.draw_date || '',
      reason: 'target-reached'
    };
  }

  const oldestId =
    Number(
      oldest.draw_id
    );

  const startId =
    Math.max(
      1,
      oldestId -
      PRECURSOR_CRON_BACKFILL
    );

  const ids =
    Array.from(
      {
        length:
          oldestId -
          startId
      },
      (_, index) =>
        startId +
        index
    );

  if (!ids.length) {
    return {
      ok: true,
      stored: 0,
      completeSixMonths: false,
      coverageDays,
      oldestDrawId: oldestId,
      reason: 'no-earlier-id'
    };
  }

  let batch = [];

  try {
    batch =
      (
        await getMany(
          ids
        )
      ) || [];
  } catch (_) {
    batch = [];
  }

  let stored = 0;

  for (
    const draw
    of batch
  ) {
    if (!draw?.id) {
      continue;
    }

    try {
      await storeCloseDraw(
        draw
      );
      stored++;
    } catch (_) {
      // One failed historical insert must not break the live cron.
    }
  }

  const newOldest =
    batch
      .filter(draw => draw?.id)
      .sort((a, b) => Number(a.id) - Number(b.id))[0]
    ||
    null;

  return {
    ok: stored > 0,
    stored,
    attempted: ids.length,
    completeSixMonths: false,
    coverageDays,
    previousOldestDrawId: oldestId,
    oldestDrawId: Number(newOldest?.id || oldestId),
    oldestDate: newOldest?.date || oldest.draw_date || '',
    reason: stored > 0
      ? 'background-backfill-added'
      : 'background-backfill-no-results'
  };
}


/* =========================================================
   PRECURSOR LIVE CONFIDENCE
========================================================= */

async function precursorLiveDraws() {
  const rows = [];

  for (
    let offset = 0;
    offset < PRECURSOR_LIVE_MAX_DRAWS;
    offset += PRECURSOR_LIVE_PAGE_SIZE
  ) {
    const page =
      (
        await db(
          `hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=${PRECURSOR_LIVE_PAGE_SIZE}&offset=${offset}`
        )
      ) || [];

    rows.push(
      ...page
    );

    if (
      page.length <
      PRECURSOR_LIVE_PAGE_SIZE
    ) {
      break;
    }
  }

  return rows
    .filter(
      draw =>
        Number.isFinite(
          Number(draw?.draw_id)
        ) &&
        normalizeFive(
          draw?.numbers
        ).length === 20
    )
    .slice(
      0,
      PRECURSOR_LIVE_MAX_DRAWS
    )
    .sort(
      (a, b) =>
        Number(a.draw_id) -
        Number(b.draw_id)
    );
}


async function precursorLiveUpdate() {
  const groups =
    (
      await db(
        `tracker_groups?select=id,name,numbers,active&active=eq.true&name=like.${encodeURIComponent(
          MANUAL_PREFIX + '*'
        )}&order=id.asc&limit=${PRECURSOR_LIVE_GROUP_LIMIT}`
      )
    ) || [];

  if (!groups.length) {
    return {
      ok: true,
      groups: [],
      reason: 'no-server-manual-groups'
    };
  }

  const draws =
    await precursorLiveDraws();

  if (
    draws.length < 80
  ) {
    return {
      ok: false,
      analyzedDraws: draws.length,
      groups: [],
      reason: 'not-enough-draws'
    };
  }

  const latest =
    draws.at(-1) ||
    null;

  const results = [];

  for (
    const group
    of groups
  ) {
    const numbers =
      normalizeFive(
        group?.numbers
      );

    if (
      numbers.length < 3 ||
      numbers.length > 5
    ) {
      continue;
    }

    try {
      const analysis =
        analyzePrecursors(
          draws,
          numbers
        );

      results.push({
        groupId: group.id,
        name: group.name,
        numbers,
        ok: Boolean(analysis?.ok),
        model: analysis?.model || null,
        confidence: analysis?.liveConfidence || null,
        activeSignals: Array.isArray(analysis?.activeSignals)
          ? analysis.activeSignals.slice(0, 5)
          : [],
        analyzedDraws: Number(analysis?.analyzedDraws || draws.length)
      });
    } catch (
      e
    ) {
      results.push({
        groupId: group.id,
        name: group.name,
        numbers,
        ok: false,
        error:
          e.message ||
          String(e)
      });
    }
  }

  return {
    ok: true,
    latestDrawId: Number(latest?.draw_id || 0) || null,
    latestTime: latest?.draw_time || '',
    analyzedDraws: draws.length,
    groupLimit: PRECURSOR_LIVE_GROUP_LIMIT,
    groups: results
  };
}


/* =========================================================
   SAFE DRAW FETCH
========================================================= */

async function safeCloseDraw(
  id,
  batchMap
) {

  const fromBatch =
    batchMap.get(
      Number(id)
    );

  if (
    Number(fromBatch?.id) ===
    Number(id)
  ) {

    return fromBatch;
  }

  try {

    const direct =
      await getDraw(
        Number(id)
      );

    if (
      Number(direct?.id) ===
      Number(id)
    ) {

      return direct;
    }

  } catch (_) {
    // Stop safely in caller.
  }

  return null;
}


/* =========================================================
   FIND FINAL OFFICIAL DRAW AT OR BEFORE 2:00 AM
========================================================= */

async function getFinalTrackingDraw() {

  const latest =
    await getDraw(
      null
    );

  if (!latest?.id) {
    return null;
  }

  const latestMinutes =
    parseDrawMinutes(
      latest.time
    );

  if (
    latestMinutes != null &&
    latestMinutes <=
      CLOSE_START_MINUTES
  ) {

    return latest;
  }


  for (
    let offset = 1;
    offset <= 20;
    offset++
  ) {

    try {

      const candidate =
        await getDraw(
          Number(latest.id) -
          offset
        );

      const minutes =
        parseDrawMinutes(
          candidate?.time
        );

      if (
        candidate?.id &&
        minutes != null &&
        minutes <=
          CLOSE_START_MINUTES
      ) {

        return candidate;
      }

    } catch (_) {
      // Keep searching backward.
    }
  }

  return null;
}


/* =========================================================
   ALL ACTIVE TRACKED GROUPS
========================================================= */

async function getCloseGroups() {

  const rows =
    (
      await db(
        'tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id&active=eq.true&order=id.asc'
      )
    ) || [];

  return rows.filter(
    g => {

      const name =
        String(
          g.name || ''
        );

      return (
        name.startsWith(
          AUTO_PREFIX
        ) ||
        name.startsWith(
          MANUAL_PREFIX
        )
      );
    }
  );
}


/* =========================================================
   FINALIZE ONE GROUP
========================================================= */

async function finalizeOneCloseGroup(
  group,
  finalDraw
) {

  const after =
    Number(
      group.last_seen_draw_id ??
      group.start_draw_id ??
      finalDraw.id
    );

  if (
    !Number.isFinite(after) ||
    after >=
      Number(finalDraw.id)
  ) {

    return {
      group:
        group.name,

      processed:
        0,

      lastSeen:
        after,

      stoppedAtMissing:
        null
    };
  }


  const end =
    Math.min(
      Number(finalDraw.id),
      after +
      MAX_CLOSE_BACKFILL
    );


  const ids =
    Array.from(
      {
        length:
          end - after
      },
      (_, i) =>
        after + i + 1
    );


  let batch = [];

  try {

    batch =
      (
        await getMany(
          ids
        )
      ) || [];

  } catch (_) {

    batch = [];
  }


  const batchMap =
    new Map(
      batch
        .filter(
          d => d?.id
        )
        .map(
          d => [
            Number(d.id),
            d
          ]
        )
    );


  const isManual =
    String(
      group.name || ''
    ).startsWith(
      MANUAL_PREFIX
    );


  let lastProcessed =
    after;

  let processed =
    0;

  let stoppedAtMissing =
    null;


  for (
    const expectedId
    of ids
  ) {

    const draw =
      await safeCloseDraw(
        expectedId,
        batchMap
      );


    if (
      !draw ||
      Number(draw.id) !==
      Number(expectedId)
    ) {

      stoppedAtMissing =
        Number(
          expectedId
        );

      break;
    }


    const drawMinutes =
      parseDrawMinutes(
        draw.time
      );


    if (
      drawMinutes == null ||
      drawMinutes >
        CLOSE_START_MINUTES
    ) {

      break;
    }


    await storeCloseDraw(
      draw
    );


    const result =
      score(
        draw,
        group.numbers
      );


    if (
      !isManual ||
      Number(
        result?.count || 0
      ) >= 3
    ) {

      await db(
        'tracker_results?on_conflict=group_id,draw_id',
        {
          method:
            'POST',

          prefer:
            'resolution=merge-duplicates,return=minimal',

          body: {
            group_id:
              group.id,

            draw_id:
              draw.id,

            hit_count:
              result.count,

            hit_numbers:
              result.hit,

            bulls_eye:
              result.bullsEye,

            bulls_eye_match:
              result.bullsEyeMatch
          }
        }
      );
    }


    lastProcessed =
      Number(
        draw.id
      );

    processed++;
  }


  if (
    lastProcessed >
    after
  ) {

    await db(
      `tracker_groups?id=eq.${group.id}`,
      {
        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {
          last_seen_draw_id:
            lastProcessed
        }
      }
    );
  }


  return {
    group:
      group.name,

    processed,

    lastSeen:
      lastProcessed,

    stoppedAtMissing
  };
}


/* =========================================================
   FINAL 2:00 AM CATCH-UP
========================================================= */

async function finalizeTrackingClose() {

  const finalDraw =
    await getFinalTrackingDraw();


  if (!finalDraw?.id) {

    return {
      ok:
        false,

      processed:
        0,

      finalDrawId:
        null,

      error:
        'Could not resolve the final official draw at or before 2:00 AM.'
    };
  }


  await storeCloseDraw(
    finalDraw
  );


  const groups =
    await getCloseGroups();


  const details = [];

  let processed =
    0;


  for (
    const group
    of groups
  ) {

    const result =
      await finalizeOneCloseGroup(
        group,
        finalDraw
      );


    details.push(
      result
    );


    processed +=
      Number(
        result.processed || 0
      );
  }


  return {
    ok:
      true,

    processed,

    finalDrawId:
      finalDraw.id,

    finalDrawTime:
      finalDraw.time,

    details
  };
}


/* =========================================================
   CRON HANDLER
========================================================= */

module.exports =
async (
  req,
  res
) => {

  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );


  const cronSecret =
    process.env
      .CRON_SECRET;


  const auth =
    String(
      req.headers
        .authorization
      ||
      ''
    );


  if (
    !cronSecret ||
    auth !==
      `Bearer ${cronSecret}`
  ) {

    return res
      .status(401)
      .json({

        ok:
          false,

        error:
          'Unauthorized'
      });
  }


  if (
    !process.env
      .WORKER_SECRET
  ) {

    return res
      .status(500)
      .json({

        ok:
          false,

        error:
          'WORKER_SECRET is not configured'
      });
  }


  req.headers[
    'x-worker-secret'
  ] =
    process.env
      .WORKER_SECRET;


  const collector =
    createCollector();


  await worker(
    req,
    collector
  );


  const workerPayload =
    collector.payload
    ||
    {

      ok:
        false,

      error:
        'Worker returned no JSON payload'
    };


  let groupFive =
    null;

  let specialActive =
    null;

  let advanced =
    null;

  let closeFinalize =
    null;

  let precursorArchive =
    null;

  let precursorLive =
    null;


  if (
    collector.statusCode < 400
    &&
    workerPayload?.ok !== false
  ) {
    try {
      precursorArchive =
        await precursorHistoryBackfill();
    } catch (
      e
    ) {
      precursorArchive = {
        ok: false,
        stored: 0,
        completeSixMonths: false,
        error:
          e.message ||
          String(e)
      };
    }

    try {
      precursorLive =
        await precursorLiveUpdate();
    } catch (
      e
    ) {
      precursorLive = {
        ok: false,
        groups: [],
        error:
          e.message ||
          String(e)
      };
    }
  }


  if (
    collector.statusCode < 400
    &&
    workerPayload?.ok !== false
    &&
    workerPayload?.mode ===
      'idle'
  ) {

    try {

      closeFinalize =
        await finalizeTrackingClose();

    } catch (
      e
    ) {

      closeFinalize = {

        ok:
          false,

        processed:
          0,

        error:
          e.message
          ||
          String(e)
      };
    }
  }


  if (
    collector.statusCode < 400
    &&
    workerPayload?.ok !== false
    &&
    (
      workerPayload?.mode ===
        'collecting'
      ||
      workerPayload?.mode ===
        'preparing'
      ||
      workerPayload?.mode ===
        'tracking'
    )
  ) {

    try {

      groupFive =
        await runGroupFive();


      if (
        groupFive?.ok !== false &&
        groupFive?.active
      ) {

        try {

          const wave =
            await buildGroupFiveWave(
              groupFive
            );

          groupFive =
            attachWaveToGroupFive(
              groupFive,
              wave
            );

        } catch (
          waveError
        ) {

          groupFive = {
            ...groupFive,

            wave: {
              ok:
                false,

              error:
                waveError.message
                ||
                String(waveError)
            },

            waveState:
              null,

            waveStateAr:
              null,

            waveScore:
              null,

            waveAlert:
              false,

            waveAlertLevel:
              'NONE',

            waveMessageAr:
              null
          };
        }
      }

    } catch (
      e
    ) {

      groupFive = {

        ok:
          false,

        active:
          false,

        error:
          e.message
          ||
          String(e)
      };
    }
  }


  if (
    collector.statusCode < 400
    &&
    workerPayload?.ok !== false
    &&
    workerPayload?.mode ===
      'tracking'
  ) {

    try {

      specialActive =
        await runActiveDensitySpecial();

    } catch (
      e
    ) {

      specialActive = {

        ok:
          false,

        replaced:
          false,

        error:
          e.message
          ||
          String(e)
      };
    }


    try {

      advanced =
        await runAdvanced();

    } catch (
      e
    ) {

      advanced = {

        ok:
          false,

        created:
          false,

        error:
          e.message
          ||
          String(e)
      };
    }
  }


  return res
    .status(
      collector.statusCode
    )
    .json({

      ...workerPayload,

      closeFinalize,

      precursorArchive,

      precursorLive,

      groupFive,

      specialActive,

      advanced
    });
};
