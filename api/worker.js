const {
  getDraw,
  getMany,
  score,
  db,
  analyzeTopGroups,
  parseDrawMinutes,
  californiaNowParts,
  cycleDateKey
} = require('./lib');

const COLLECTION_DRAWS = 180;
const CONTROL_PREFIX = 'AUTO_CONTROL_';
const AUTO_PREFIX = 'AUTO Group ';
const MAX_BACKFILL = 80;
const TRACKING_BLOCKS = 6;
const MAX_TRACKED_DRAWS = TRACKING_BLOCKS * 20; // 120 draws = 6 PM through 1:56 AM

async function store(d) {
  await db('hotspot_draws?on_conflict=draw_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: {
      draw_id: d.id,
      draw_date: d.date,
      draw_time: d.time,
      numbers: d.numbers,
      bulls_eye: d.bullsEye
    }
  });
}

async function cleanupAll() {
  await db('tracker_results?id=not.is.null', {
    method: 'DELETE',
    prefer: 'return=minimal'
  });

  await db('tracker_groups?id=not.is.null', {
    method: 'DELETE',
    prefer: 'return=minimal'
  });

  await db('hotspot_draws?draw_id=gt.0', {
    method: 'DELETE',
    prefer: 'return=minimal'
  });
}

async function getControl() {
  const rows = await db(
    `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id,created_at&name=like.${encodeURIComponent(
      CONTROL_PREFIX + '*'
    )}&order=id.desc&limit=1`
  );

  return rows?.[0] || null;
}

async function createControl(dateKey, startId) {
  const rows = await db('tracker_groups', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      name: `${CONTROL_PREFIX}${dateKey}`,
      numbers: [1, 2, 3, 4, 5],
      active: false,
      start_draw_id: startId,
      last_seen_draw_id: startId - 1
    }
  });

  return rows?.[0] || null;
}

async function getAutoGroups() {
  return (
    (await db(
      `tracker_groups?select=id,name,numbers,start_draw_id,last_seen_draw_id&active=eq.true&name=like.${encodeURIComponent(
        AUTO_PREFIX + '*'
      )}&order=id.asc`
    )) || []
  );
}

async function upsertAuto(slot, numbers, collectionEndId) {
  const name = `${AUTO_PREFIX}${slot}`;

  const old = await db(
    `tracker_groups?select=id&name=eq.${encodeURIComponent(
      name
    )}&order=id.desc&limit=1`
  );

  if (old?.[0]) {
    await db(`tracker_results?group_id=eq.${old[0].id}`, {
      method: 'DELETE',
      prefer: 'return=minimal'
    });

    await db(`tracker_groups?id=eq.${old[0].id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        numbers,
        active: true,
        start_draw_id: collectionEndId,
        last_seen_draw_id: collectionEndId
      }
    });

    return old[0].id;
  }

  const x = await db('tracker_groups', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      name,
      numbers,
      active: true,
      start_draw_id: collectionEndId,
      last_seen_draw_id: collectionEndId
    }
  });

  return x?.[0]?.id;
}

function drawDateKey(dateText) {
  const d = new Date(String(dateText || '') + ' 12:00:00 UTC');

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return `${d.getUTCFullYear()}-${String(
    d.getUTCMonth() + 1
  ).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/*
  FIX #1
  Find the true 6:00 AM draw.

  Prefer an exact 6:00 AM draw instead of simply taking
  the first draw returned by the official source.
*/
async function findCycleStart(latest, now) {
  const mins = parseDrawMinutes(latest.time);

  if (mins == null || mins < 360) {
    return null;
  }

  const estimate =
    latest.id - Math.floor((mins - 360) / 4);

  const from = Math.max(1, estimate - 20);
  const to = estimate + 20;

  const ids = Array.from(
    { length: to - from + 1 },
    (_, i) => from + i
  );

  const ds = await getMany(ids);

  const candidates = ds.filter(d => {
    const m = parseDrawMinutes(d.time);

    return (
      drawDateKey(d.date) === now.dateKey &&
      m != null &&
      m >= 360 &&
      m < 1080
    );
  });

  // First choice: EXACTLY 6:00 AM
  const exactSix = candidates.find(
    d => parseDrawMinutes(d.time) === 360
  );

  if (exactSix) {
    return exactSix;
  }

  // Fallback only if official source has not exposed 6:00 yet
  return candidates.sort((a, b) => {
    const ma = parseDrawMinutes(a.time);
    const mb = parseDrawMinutes(b.time);

    if (ma !== mb) {
      return ma - mb;
    }

    return a.id - b.id;
  })[0] || null;
}

/*
  IMPORTANT:
  Use the collection day's date, NOT today's date.

  This is what allows tracking to continue correctly
  after midnight.
*/
function inCollectionWindow(d, collectionDateKey) {
  const m = parseDrawMinutes(
    d.draw_time ?? d.time
  );

  return (
    drawDateKey(d.draw_date ?? d.date) === collectionDateKey &&
    m != null &&
    m >= 360 &&
    m < 1080
  );
}

async function backfill(control, latest) {
  let after = Number(
    control.last_seen_draw_id ??
      (control.start_draw_id - 1)
  );

  if (after >= latest.id) {
    await store(latest);
    return 0;
  }

  const end = Math.min(
    latest.id,
    after + MAX_BACKFILL
  );

  const ids = Array.from(
    { length: end - after },
    (_, i) => after + i + 1
  );

  const ds = await getMany(ids);

  for (const d of ds) {
    await store(d);
  }

  const last =
    ds.at(-1)?.id ?? after;

  await db(
    `tracker_groups?id=eq.${control.id}`,
    {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        last_seen_draw_id: last
      }
    }
  );

  control.last_seen_draw_id = last;

  return ds.length;
}

/*
  FIX #2
  Repair any missing draws inside the expected
  180-draw collection sequence.

  If one official draw was temporarily missed,
  this function asks for it again.
*/
async function repairCollection(
  control,
  collectionDateKey
) {
  const startId = Number(
    control.start_draw_id
  );

  const expectedIds = Array.from(
    { length: COLLECTION_DRAWS },
    (_, i) => startId + i
  );

  const existing =
    (await db(
      `hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=gte.${startId}&draw_id=lte.${
        startId + COLLECTION_DRAWS - 1
      }&order=draw_id.asc`
    )) || [];

  const validExisting = existing.filter(
    d =>
      inCollectionWindow(
        d,
        collectionDateKey
      )
  );

  const have = new Set(
    validExisting.map(d => Number(d.draw_id))
  );

  const missing = expectedIds.filter(
    id => !have.has(id)
  );

  if (!missing.length) {
    return 0;
  }

  const ds = await getMany(missing);

  let repaired = 0;

  for (const d of ds) {
    if (
      inCollectionWindow(
        d,
        collectionDateKey
      )
    ) {
      await store(d);
      repaired++;
    }
  }

  return repaired;
}

async function processTracking(
  groups,
  latest
) {
  let processed = 0;
  const details = [];

  for (const g of groups) {
    const after = Number(
      g.last_seen_draw_id ??
        g.start_draw_id
    );

    const trackingCap =
      Number(g.start_draw_id) +
      MAX_TRACKED_DRAWS;

    if (
      after >= latest.id ||
      after >= trackingCap
    ) {
      details.push({
        group: g.name,
        processed: 0,
        lastSeen: after,
        capReached:
          after >= trackingCap
      });

      continue;
    }

    const end = Math.min(
      latest.id,
      after + MAX_BACKFILL,
      trackingCap
    );

    let cached =
      (await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gt.${after}&draw_id=lte.${end}&order=draw_id.asc`
      )) || [];

    if (
      cached.length <
      end - after
    ) {
      const have = new Set(
        cached.map(d => d.draw_id)
      );

      const missing = [];

      for (
        let id = after + 1;
        id <= end;
        id++
      ) {
        if (!have.has(id)) {
          missing.push(id);
        }
      }

      if (missing.length) {
        const ds =
          await getMany(missing);

        for (const d of ds) {
          await store(d);
        }

        cached =
          (await db(
            `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gt.${after}&draw_id=lte.${end}&order=draw_id.asc`
          )) || [];
      }
    }

    for (const d of cached) {
      const s = score(
        {
          numbers: d.numbers,
          bullsEye: d.bulls_eye
        },
        g.numbers
      );

      await db(
        'tracker_results?on_conflict=group_id,draw_id',
        {
          method: 'POST',
          prefer:
            'resolution=merge-duplicates,return=minimal',
          body: {
            group_id: g.id,
            draw_id: d.draw_id,
            hit_count: s.count,
            hit_numbers: s.hit,
            bulls_eye: s.bullsEye,
            bulls_eye_match:
              s.bullsEyeMatch
          }
        }
      );
    }

    const last =
      cached.at(-1)?.draw_id ??
      after;

    await db(
      `tracker_groups?id=eq.${g.id}`,
      {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          last_seen_draw_id: last
        }
      }
    );

    processed += cached.length;

    details.push({
      group: g.name,
      processed: cached.length,
      lastSeen: last
    });
  }

  return {
    processed,
    details
  };
}

module.exports = async (
  req,
  res
) => {
  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );

  try {
    if (process.env.WORKER_SECRET) {
      const token =
        req.headers[
          'x-worker-secret'
        ] ||
        req.query.secret;

      if (
        token !==
        process.env.WORKER_SECRET
      ) {
        return res
          .status(401)
          .json({
            ok: false,
            error: 'Unauthorized'
          });
      }
    }

    const now =
      californiaNowParts();

    /*
      2:30 AM – 6:00 AM
      Clean previous cycle.
    */
    if (
      now.minutes >= 150 &&
      now.minutes < 360
    ) {
      await cleanupAll();

      return res
        .status(200)
        .json({
          ok: true,
          mode: 'cleanup',
          message:
            'Daily cycle data deleted. Waiting for 6:00 AM.',
          source:
            'California Lottery official'
        });
    }

    /*
      2:00 AM – 2:30 AM
      Tracking is finished.
    */
    if (
      now.minutes >= 120 &&
      now.minutes < 150
    ) {
      return res
        .status(200)
        .json({
          ok: true,
          mode: 'idle',
          message:
            'Tracking cycle ended at 2:00 AM. Cleanup is scheduled for 2:30 AM.',
          source:
            'California Lottery official'
        });
    }

    let control =
      await getControl();

    const cycleKey =
      cycleDateKey(now);

    /*
      Do NOT delete the previous day's control
      during the midnight tracking period.
    */
    if (
      control &&
      !String(control.name).endsWith(
        cycleKey
      )
    ) {
      await cleanupAll();
      control = null;
    }

    const latest =
      await getDraw(null);

    /*
      Create today's control using
      the real 6:00 AM draw.
    */
    if (!control) {
      const first =
        await findCycleStart(
          latest,
          now
        );

      if (!first) {
        return res
          .status(200)
          .json({
            ok: true,
            mode: 'collecting',
            collection: {
              have: 0,
              need:
                COLLECTION_DRAWS,
              remaining:
                COLLECTION_DRAWS
            },
            latest: {
              id: latest.id,
              time: latest.time
            },
            stored: 0,
            activeGroups: 0,
            processed: 0,
            message:
              'Waiting for the official 6:00 AM draw.',
            source:
              'California Lottery official'
          });
      }

      control =
        await createControl(
          cycleKey,
          first.id
        );

      // Save 6:00 AM immediately
      await store(first);
    }

    /*
      Verify start draw while we are
      still inside today's collection day.
    */
    if (
      now.minutes >= 360 &&
      now.minutes < 1080
    ) {
      const controlDateKey =
        String(
          control.name
        ).replace(
          CONTROL_PREFIX,
          ''
        );

      const startDraw =
        await getDraw(
          Number(
            control.start_draw_id
          )
        );

      const startMinutes =
        parseDrawMinutes(
          startDraw.time
        );

      /*
        If control was accidentally created
        from 6:04 or later, rebuild it.
      */
      if (
        !inCollectionWindow(
          startDraw,
          controlDateKey
        ) ||
        startMinutes !== 360
      ) {
        await cleanupAll();

        const first =
          await findCycleStart(
            latest,
            now
          );

        if (!first) {
          return res
            .status(200)
            .json({
              ok: true,
              mode:
                'collecting',
              collection: {
                have: 0,
                need:
                  COLLECTION_DRAWS,
                remaining:
                  COLLECTION_DRAWS
              },
              latest: {
                id: latest.id,
                time:
                  latest.time
              },
              stored: 0,
              activeGroups: 0,
              processed: 0,
              message:
                'Waiting for the exact official 6:00 AM draw.',
              source:
                'California Lottery official'
            });
        }

        control =
          await createControl(
            cycleKey,
            first.id
          );

        await store(first);
      }
    }

    const stored =
      await backfill(
        control,
        latest
      );

    /*
      Collection date comes from the control,
      so midnight does NOT change it.
    */
    const collectionDateKey =
      String(control.name).replace(
        CONTROL_PREFIX,
        ''
      );

    /*
      After 6 PM, retry any missing
      collection draw before analysis.
    */
    let repaired = 0;

    if (now.minutes >= 1080) {
      repaired =
        await repairCollection(
          control,
          collectionDateKey
        );
    }

    const rawHistory =
      (await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gte.${control.start_draw_id}&order=draw_id.asc&limit=220`
      )) || [];

    const history =
      rawHistory.filter(d =>
        inCollectionWindow(
          d,
          collectionDateKey
        )
      );

    const collectionEndId =
      history.at(-1)?.draw_id ??
      Number(
        control.start_draw_id
      );

    /*
      COLLECTION PERIOD
      6 AM – 6 PM
    */
    if (
      now.minutes >= 360 &&
      now.minutes < 1080
    ) {
      return res
        .status(200)
        .json({
          ok: true,
          mode: 'collecting',
          collection: {
            have:
              history.length,
            need:
              COLLECTION_DRAWS,
            remaining:
              Math.max(
                0,
                COLLECTION_DRAWS -
                  history.length
              )
          },
          latest: {
            id: latest.id,
            time: latest.time
          },
          stored,
          repaired,
          activeGroups: 0,
          processed: 0,
          source:
            'California Lottery official'
        });
    }

    /*
      FIX #3

      NEVER create groups from 179 draws.

      Wait until all 180 collection draws
      are actually present.
    */
    if (
      history.length <
      COLLECTION_DRAWS
    ) {
      return res
        .status(200)
        .json({
          ok: true,
          mode: 'preparing',
          collection: {
            have:
              history.length,
            need:
              COLLECTION_DRAWS,
            remaining:
              COLLECTION_DRAWS -
              history.length
          },
          latest: {
            id: latest.id,
            time: latest.time
          },
          stored,
          repaired,
          activeGroups: 0,
          processed: 0,
          message:
            `Waiting for complete collection: ${history.length}/${COLLECTION_DRAWS}. No groups will be selected until all 180 official draws are present.`,
          source:
            'California Lottery official'
        });
    }

    /*
      Safety:
      only use the first exact 180
      collection draws.
    */
    const completeHistory =
      history
        .sort(
          (a, b) =>
            a.draw_id -
            b.draw_id
        )
        .slice(
          0,
          COLLECTION_DRAWS
        );

    const finalCollectionEndId =
      completeHistory.at(-1)
        ?.draw_id ??
      collectionEndId;

    let groups =
      await getAutoGroups();

    let selected = null;

    /*
      Select groups ONLY after 180/180.
    */
    if (groups.length === 0) {
      selected =
        analyzeTopGroups(
          completeHistory,
          2
        );

      if (
        selected.length !== 2
      ) {
        throw Error(
          'Could not identify two repeated 5-number groups from the complete 180-draw collection.'
        );
      }

      await upsertAuto(
        1,
        selected[0].numbers,
        finalCollectionEndId
      );

      await upsertAuto(
        2,
        selected[1].numbers,
        finalCollectionEndId
      );

      groups =
        await getAutoGroups();
    }

    /*
      Tracking continues after midnight
      because completeHistory still uses
      the original collectionDateKey.
    */
    const tracking =
      await processTracking(
        groups,
        latest
      );

    return res
      .status(200)
      .json({
        ok: true,
        mode: 'tracking',
        collection: {
          have:
            completeHistory.length,
          need:
            COLLECTION_DRAWS,
          remaining: 0
        },
        latest: {
          id: latest.id,
          time: latest.time
        },
        stored,
        repaired,
        activeGroups:
          groups.length,
        selected,
        processed:
          tracking.processed,
        details:
          tracking.details,
        source:
          'California Lottery official'
      });

  } catch (e) {
    res
      .status(500)
      .json({
        ok: false,
        error:
          e.message ||
          String(e)
      });
  }
};
