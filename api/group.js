'use strict';

const {
  getDraw,
  getMany,
  db,
  score
} = require('./lib');

const MANUAL_NAMES = {
  1: 'MANUAL Group',
  2: 'MANUAL Group 2'
};

const MAX_BACKFILL = 80;


/* =========================================================
   HELPERS
========================================================= */

function normalizeSlot(value) {
  const slot = Number(value ?? 1);

  if (slot !== 1 && slot !== 2) {
    throw new Error(
      'Manual slot must be 1 or 2.'
    );
  }

  return slot;
}


function getManualName(slot) {
  return MANUAL_NAMES[
    normalizeSlot(slot)
  ];
}


function validateNumbers(input) {
  const numbers =
    Array.isArray(input)
      ? input.map(Number)
      : [];

  if (numbers.length !== 5) {
    throw new Error(
      'Enter exactly 5 numbers.'
    );
  }

  if (
    numbers.some(
      n =>
        !Number.isInteger(n) ||
        n < 1 ||
        n > 80
    )
  ) {
    throw new Error(
      'Each number must be from 1 to 80.'
    );
  }

  if (
    new Set(numbers).size !== 5
  ) {
    throw new Error(
      'The 5 numbers must be different.'
    );
  }

  return [...numbers].sort(
    (a, b) => a - b
  );
}


/* =========================================================
   DRAW STORAGE
========================================================= */

async function storeDraw(draw) {
  if (!draw?.id) {
    return;
  }

  await db(
    'hotspot_draws?on_conflict=draw_id',
    {
      method: 'POST',

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
   MANUAL GROUP DATABASE
========================================================= */

async function getManual(slot) {
  const name =
    getManualName(slot);

  const rows =
    await db(
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=eq.${encodeURIComponent(
        name
      )}&order=id.desc&limit=1`
    );

  return rows?.[0] || null;
}


/* =========================================================
   SAFE DRAW FETCH
========================================================= */

async function getSafeDraw(
  id,
  batchMap
) {
  const fromBatch =
    batchMap.get(
      Number(id)
    );

  if (fromBatch?.id) {
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
    // stop safely
  }

  return null;
}


/* =========================================================
   TRACKING / BACKFILL
========================================================= */

async function backfillManual(
  group,
  suppliedLatest = null
) {
  if (
    !group ||
    !group.active
  ) {
    return {
      latest:
        suppliedLatest,

      processed:
        0,

      stoppedAtMissing:
        null
    };
  }

  const latest =
    suppliedLatest ||
    await getDraw(null);

  await storeDraw(
    latest
  );

  const after =
    Number(
      group.last_seen_draw_id
      ??
      group.start_draw_id
      ??
      latest.id
    );

  if (
    !Number.isFinite(after) ||
    after >= Number(latest.id)
  ) {
    return {
      latest,
      processed: 0,
      stoppedAtMissing: null
    };
  }

  const end =
    Math.min(
      Number(latest.id),
      after + MAX_BACKFILL
    );

  const count =
    end - after;

  if (
    count <= 0
  ) {
    return {
      latest,
      processed: 0,
      stoppedAtMissing: null
    };
  }

  const ids =
    Array.from(
      {
        length:
          count
      },

      (_, i) =>
        after + i + 1
    );

  let batchDraws =
    [];

  try {
    batchDraws =
      (
        await getMany(ids)
      ) || [];

  } catch (_) {
    batchDraws =
      [];
  }

  const batchMap =
    new Map(
      batchDraws
        .filter(
          draw =>
            draw?.id
        )
        .map(
          draw => [
            Number(draw.id),
            draw
          ]
        )
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
      await getSafeDraw(
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

    await storeDraw(
      draw
    );

    const result =
      score(
        draw,
        group.numbers
      );

    if (
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

    group.last_seen_draw_id =
      lastProcessed;
  }

  return {
    latest,
    processed,
    lastProcessed,
    stoppedAtMissing
  };
}


/* =========================================================
   DRAW META
========================================================= */

async function attachDrawMeta(rows) {
  const safeRows =
    Array.isArray(rows)
      ? rows
      : [];

  if (
    !safeRows.length
  ) {
    return [];
  }

  const ids = [
    ...new Set(
      safeRows
        .map(
          row =>
            Number(
              row.draw_id
            )
        )
        .filter(
          Number.isFinite
        )
    )
  ];

  if (
    !ids.length
  ) {
    return safeRows;
  }

  const draws =
    (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=in.(${ids.join(',')})`
      )
    ) || [];

  const meta =
    Object.fromEntries(
      draws.map(
        draw => [
          Number(
            draw.draw_id
          ),
          draw
        ]
      )
    );

  return safeRows.map(
    row => ({
      ...row,

      date:
        meta[
          Number(
            row.draw_id
          )
        ]?.draw_date || '',

      time:
        meta[
          Number(
            row.draw_id
          )
        ]?.draw_time || ''
    })
  );
}


/* =========================================================
   READ MANUAL RESULTS
========================================================= */

async function readManual(
  group,
  slot
) {
  if (!group) {
    return null;
  }

  let recentRows =
    (
      await db(
        `tracker_results?select=draw_id,hit_count,hit_numbers,bulls_eye,bulls_eye_match,created_at&group_id=eq.${group.id}&hit_count=gte.3&order=draw_id.desc&limit=100`
      )
    ) || [];

  const bestRows =
    (
      await db(
        `tracker_results?select=draw_id,hit_count,hit_numbers,bulls_eye,bulls_eye_match,created_at&group_id=eq.${group.id}&hit_count=gte.3&order=hit_count.desc,draw_id.desc&limit=1`
      )
    ) || [];

  const bestRaw =
    bestRows[0] ||
    null;

  const lastStrongRaw =
    recentRows[0] ||
    null;

  if (
    bestRaw &&
    !recentRows.some(
      row =>
        Number(row.draw_id) ===
        Number(bestRaw.draw_id)
    )
  ) {
    recentRows = [
      ...recentRows,
      bestRaw
    ];
  }

  recentRows.sort(
    (a, b) =>
      Number(b.draw_id) -
      Number(a.draw_id)
  );

  const rowsWithMeta =
    await attachDrawMeta(
      recentRows
    );

  const strongMetaRows =
    await attachDrawMeta([
      ...(
        lastStrongRaw
          ? [lastStrongRaw]
          : []
      ),

      ...(
        bestRaw &&
        (
          !lastStrongRaw ||
          Number(bestRaw.draw_id) !==
          Number(lastStrongRaw.draw_id)
        )
          ? [bestRaw]
          : []
      )
    ]);

  const metaById =
    Object.fromEntries(
      strongMetaRows.map(
        row => [
          Number(row.draw_id),
          row
        ]
      )
    );

  const lastStrong =
    lastStrongRaw
      ? (
          metaById[
            Number(
              lastStrongRaw.draw_id
            )
          ] ||
          lastStrongRaw
        )
      : null;

  const best =
    bestRaw
      ? (
          metaById[
            Number(
              bestRaw.draw_id
            )
          ] ||
          bestRaw
        )
      : null;

  return {
    id:
      group.id,

    slot,

    name:
      group.name,

    numbers:
      Array.isArray(
        group.numbers
      )
        ? group.numbers.map(Number)
        : [],

    active:
      Boolean(
        group.active
      ),

    startDrawId:
      group.start_draw_id,

    trackingLastSeenDrawId:
      group.last_seen_draw_id,

    lastSeenDrawId:
      lastStrong?.draw_id
      ??
      null,

    lastSeenResult:
      lastStrong
        ? {
            drawId:
              lastStrong.draw_id,

            hitCount:
              Number(
                lastStrong.hit_count || 0
              ),

            hitNumbers:
              Array.isArray(
                lastStrong.hit_numbers
              )
                ? lastStrong.hit_numbers.map(Number)
                : [],

            date:
              lastStrong.date || '',

            time:
              lastStrong.time || '',

            bullsEye:
              lastStrong.bulls_eye,

            bullsEyeMatch:
              Boolean(
                lastStrong.bulls_eye_match
              )
          }
        : null,

    bestHit:
      best
        ? Number(
            best.hit_count || 0
          )
        : 0,

    bestDrawId:
      best?.draw_id
      ??
      null,

    bestResult:
      best
        ? {
            drawId:
              best.draw_id,

            hitCount:
              Number(
                best.hit_count || 0
              ),

            hitNumbers:
              Array.isArray(
                best.hit_numbers
              )
                ? best.hit_numbers.map(Number)
                : [],

            date:
              best.date || '',

            time:
              best.time || '',

            bullsEye:
              best.bulls_eye,

            bullsEyeMatch:
              Boolean(
                best.bulls_eye_match
              )
          }
        : null,

    createdAt:
      group.created_at,

    matches:
      rowsWithMeta
  };
}


async function readAllManuals() {
  const group1 =
    await getManual(1);

  const group2 =
    await getManual(2);

  return [
    await readManual(
      group1,
      1
    ),

    await readManual(
      group2,
      2
    )
  ];
}


/* =========================================================
   START = NEW DAILY CYCLE
========================================================= */

/*
  IMPORTANT:

  Every time Start is pressed:

  - The numbers currently entered are kept/used.
  - Previous cycle results are deleted.
  - Best becomes 0/5.
  - 3/5+ count becomes 0.
  - Last Seen becomes empty.
  - start_draw_id becomes the latest draw at that moment.
  - last_seen_draw_id becomes the same latest draw.
  - Only future draws are counted.

  The numbers remain stored in tracker_groups so they
  appear again in the boxes, but the boxes remain editable.
*/

async function startManual(
  slot,
  numbers
) {
  const latest =
    await getDraw(null);

  await storeDraw(
    latest
  );

  const old =
    await getManual(
      slot
    );

  if (old) {

    /*
      Remove ONLY previous-cycle results.
      The group itself stays, so its numbers
      remain stored and can be shown again.
    */
    await db(
      `tracker_results?group_id=eq.${old.id}`,
      {
        method:
          'DELETE',

        prefer:
          'return=minimal'
      }
    );

    /*
      Start a completely fresh cycle,
      whether the numbers are the same
      or were edited.
    */
    await db(
      `tracker_groups?id=eq.${old.id}`,
      {
        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {
          numbers,

          active:
            true,

          start_draw_id:
            latest.id,

          last_seen_draw_id:
            latest.id
        }
      }
    );

  } else {

    await db(
      'tracker_groups',
      {
        method:
          'POST',

        prefer:
          'return=representation',

        body: {
          name:
            getManualName(
              slot
            ),

          numbers,

          active:
            true,

          start_draw_id:
            latest.id,

          last_seen_draw_id:
            latest.id
        }
      }
    );
  }

  const manuals =
    await readAllManuals();

  return {
    ok:
      true,

    newCycle:
      true,

    unchanged:
      false,

    resumed:
      false,

    message:
      'New manual cycle started. Previous cycle results were reset. Only future draws will be counted.',

    manuals,

    manual:
      manuals[
        slot - 1
      ],

    processed:
      0,

    stoppedAtMissing:
      null,

    latest: {
      id:
        latest.id,

      date:
        latest.date,

      time:
        latest.time
    }
  };
}


/* =========================================================
   STOP
========================================================= */

async function stopManual(slot) {
  const group =
    await getManual(
      slot
    );

  if (!group) {
    const manuals =
      await readAllManuals();

    return {
      ok:
        true,

      message:
        'No manual group exists in this slot.',

      manuals,

      manual:
        manuals[
          slot - 1
        ]
    };
  }

  let latest =
    null;

  let processed =
    0;

  let stoppedAtMissing =
    null;

  if (
    group.active
  ) {
    latest =
      await getDraw(null);

    await storeDraw(
      latest
    );

    const sync =
      await backfillManual(
        group,
        latest
      );

    processed =
      sync.processed;

    stoppedAtMissing =
      sync.stoppedAtMissing;

    await db(
      `tracker_groups?id=eq.${group.id}`,
      {
        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {
          active:
            false
        }
      }
    );
  }

  const manuals =
    await readAllManuals();

  return {
    ok:
      true,

    message:
      'Manual tracking stopped. Existing results were kept.',

    manuals,

    manual:
      manuals[
        slot - 1
      ],

    processed,

    stoppedAtMissing,

    latest:
      latest
        ? {
            id:
              latest.id,

            date:
              latest.date,

            time:
              latest.time
          }
        : null
  };
}


/* =========================================================
   CLEAR
========================================================= */

async function clearManual(slot) {
  const group =
    await getManual(
      slot
    );

  if (group) {

    await db(
      `tracker_results?group_id=eq.${group.id}`,
      {
        method:
          'DELETE',

        prefer:
          'return=minimal'
      }
    );

    /*
      Clear removes everything,
      including the saved numbers.
    */
    await db(
      `tracker_groups?id=eq.${group.id}`,
      {
        method:
          'DELETE',

        prefer:
          'return=minimal'
      }
    );
  }

  const manuals =
    await readAllManuals();

  return {
    ok:
      true,

    message:
      'Manual group cleared.',

    manuals,

    manual:
      manuals[
        slot - 1
      ]
  };
}


/* =========================================================
   GET / SYNC
========================================================= */

async function getManualState() {
  const group1 =
    await getManual(1);

  const group2 =
    await getManual(2);

  const groups = [
    group1,
    group2
  ];

  const activeGroups =
    groups.filter(
      group =>
        group &&
        group.active
    );

  let latest =
    null;

  let processed =
    0;

  const missing =
    [];

  if (
    activeGroups.length
  ) {
    latest =
      await getDraw(null);

    await storeDraw(
      latest
    );

    for (
      const group
      of activeGroups
    ) {
      const sync =
        await backfillManual(
          group,
          latest
        );

      processed +=
        Number(
          sync.processed || 0
        );

      if (
        sync.stoppedAtMissing
      ) {
        missing.push({
          groupId:
            group.id,

          drawId:
            sync.stoppedAtMissing
        });
      }
    }
  }

  const manuals =
    await readAllManuals();

  return {
    ok:
      true,

    manuals,

    manual:
      manuals[0] ||
      null,

    processed,

    missing,

    latest:
      latest
        ? {
            id:
              latest.id,

            date:
              latest.date,

            time:
              latest.time
          }
        : null
  };
}


/* =========================================================
   API HANDLER
========================================================= */

module.exports =
async function handler(
  req,
  res
) {
  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );

  try {

    if (
      req.method ===
      'POST'
    ) {
      const action =
        String(
          req.body?.action ||
          'start'
        )
          .trim()
          .toLowerCase();

      const slot =
        normalizeSlot(
          req.body?.slot ??
          1
        );

      if (
        action ===
        'start'
      ) {
        const numbers =
          validateNumbers(
            req.body?.numbers
          );

        const result =
          await startManual(
            slot,
            numbers
          );

        return res
          .status(200)
          .json(
            result
          );
      }

      if (
        action ===
        'stop'
      ) {
        const result =
          await stopManual(
            slot
          );

        return res
          .status(200)
          .json(
            result
          );
      }

      if (
        action ===
        'clear'
      ) {
        const result =
          await clearManual(
            slot
          );

        return res
          .status(200)
          .json(
            result
          );
      }

      return res
        .status(400)
        .json({
          ok:
            false,

          error:
            'Unknown manual action.'
        });
    }

    if (
      req.method ===
      'GET'
    ) {
      const state =
        await getManualState();

      return res
        .status(200)
        .json(
          state
        );
    }

    return res
      .status(405)
      .json({
        ok:
          false,

        error:
          'Method not allowed'
      });

  } catch (error) {

    console.error(
      'Manual group API error:',
      error
    );

    return res
      .status(500)
      .json({
        ok:
          false,

        error:
          error?.message ||
          String(error)
      });
  }
};
