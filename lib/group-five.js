'use strict';

const { db, score, analyzeTopGroups } = require('../api/lib');

const CONTROL_PREFIX = 'AUTO_CONTROL_';
const GROUP_NAME = 'AUTO Group Five';
const ARCHIVE_PREFIX = 'AUTO Group Five Archive ';

const ANALYSIS_DRAWS = 30;
const TRACK_DRAWS = 30;

/* =========================================================
   NORMALIZE NUMBERS
========================================================= */

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(
      n =>
        Number.isInteger(n) &&
        n >= 1 &&
        n <= 80
    )
    .sort((a, b) => a - b);
}

/* =========================================================
   GET REAL DAILY CONTROL
========================================================= */

async function getControl() {
  const rows = await db(
    `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id&name=like.${encodeURIComponent(
      CONTROL_PREFIX + '*'
    )}&order=id.desc&limit=20`
  );

  return (
    (rows || []).find(r =>
      /^AUTO_CONTROL_\d{4}-\d{2}-\d{2}$/.test(
        String(r.name || '')
      )
    ) || null
  );
}

/* =========================================================
   GET CURRENT ACTIVE GROUP FIVE
========================================================= */

async function getCurrentGroup() {
  const rows = await db(
    `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=eq.${encodeURIComponent(
      GROUP_NAME
    )}&active=eq.true&order=id.desc&limit=1`
  );

  return rows?.[0] || null;
}

/* =========================================================
   LOAD CURRENT DAY DRAWS
========================================================= */

async function getCycleDraws(control) {
  if (!control) {
    return [];
  }

  return (
    (await db(
      `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gte.${Number(
        control.start_draw_id
      )}&order=draw_id.asc&limit=500`
    )) || []
  );
}

/* =========================================================
   FALLBACK SELECTION
========================================================= */

function fallbackFive(draws) {
  const counts = new Map();

  for (const d of draws) {
    for (const n of norm(d.numbers)) {
      counts.set(
        n,
        (counts.get(n) || 0) + 1
      );
    }
  }

  return [...counts.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        a[0] - b[0]
    )
    .slice(0, 5)
    .map(([n]) => n)
    .sort((a, b) => a - b);
}

/* =========================================================
   SELECT FIVE FROM EXACTLY 30 DRAWS
========================================================= */

function selectFive(windowDraws) {
  const selected = analyzeTopGroups(
    windowDraws,
    1
  );

  const numbers = norm(
    selected?.[0]?.numbers || []
  );

  if (numbers.length === 5) {
    return {
      numbers,
      method: '30-draw rolling analyzeTopGroups'
    };
  }

  const fallback = fallbackFive(
    windowDraws
  );

  if (fallback.length !== 5) {
    return null;
  }

  return {
    numbers: fallback,
    method: '30-draw rolling frequency fallback'
  };
}

/* =========================================================
   GET LAST 30 DRAWS ENDING AT DRAW
========================================================= */

function getWindowEndingAt(draws, endId) {
  return draws
    .filter(
      d =>
        Number(d.draw_id) <=
        Number(endId)
    )
    .slice(-ANALYSIS_DRAWS);
}

/* =========================================================
   CREATE NEW GROUP FIVE
========================================================= */

async function createGroup(
  numbers,
  startDrawId
) {
  const rows = await db(
    'tracker_groups',
    {
      method: 'POST',
      prefer: 'return=representation',

      body: {
        name: GROUP_NAME,
        numbers,
        active: true,

        start_draw_id:
          Number(startDrawId),

        last_seen_draw_id:
          Number(startDrawId)
      }
    }
  );

  return rows?.[0] || null;
}

/* =========================================================
   DELETE OLD RESULTS AND ARCHIVE OLD GROUP
========================================================= */

async function archiveGroupAndClearResults(
  group
) {
  /*
    مهم:
    عند انتهاء دورة 30 سحبة
    نحذف نتائج الأرقام القديمة بالكامل.
  */

  await db(
    `tracker_results?group_id=eq.${group.id}`,
    {
      method: 'DELETE',
      prefer: 'return=minimal'
    }
  );

  /*
    نحتفظ فقط بسجل المجموعة القديمة
    لمعرفة عدد الدورات السابقة.
    النتائج نفسها تكون محذوفة.
  */

  await db(
    `tracker_groups?id=eq.${group.id}`,
    {
      method: 'PATCH',
      prefer: 'return=minimal',

      body: {
        name:
          `${ARCHIVE_PREFIX}${group.start_draw_id}`,

        active: false,

        last_seen_draw_id:
          Number(group.start_draw_id) +
          TRACK_DRAWS
      }
    }
  );
}

/* =========================================================
   REMOVE ACCIDENTAL OVERFLOW
========================================================= */

async function deleteOverflowResults(
  groupId,
  cutoffId
) {
  await db(
    `tracker_results?group_id=eq.${groupId}&draw_id=gt.${Number(
      cutoffId
    )}`,
    {
      method: 'DELETE',
      prefer: 'return=minimal'
    }
  );
}

/* =========================================================
   TRACK CURRENT GROUP
========================================================= */

async function trackGroup(
  group,
  draws,
  endId
) {
  const after = Number(
    group.last_seen_draw_id ??
    group.start_draw_id
  );

  const cap =
    Number(group.start_draw_id) +
    TRACK_DRAWS;

  const target = Math.min(
    Number(endId),
    cap
  );

  if (target <= after) {
    return {
      processed: 0,
      lastSeen: after,
      capReached: after >= cap
    };
  }

  const pending = draws.filter(
    d =>
      Number(d.draw_id) > after &&
      Number(d.draw_id) <= target
  );

  for (const d of pending) {
    const s = score(
      {
        numbers: d.numbers,
        bullsEye: d.bulls_eye
      },
      group.numbers
    );

    await db(
      'tracker_results?on_conflict=group_id,draw_id',
      {
        method: 'POST',

        prefer:
          'resolution=merge-duplicates,return=minimal',

        body: {
          group_id: group.id,
          draw_id: d.draw_id,

          hit_count:
            s.count,

          hit_numbers:
            s.hit,

          bulls_eye:
            s.bullsEye,

          bulls_eye_match:
            s.bullsEyeMatch
        }
      }
    );
  }

  const lastSeen =
    pending.at(-1)?.draw_id ??
    after;

  await db(
    `tracker_groups?id=eq.${group.id}`,
    {
      method: 'PATCH',
      prefer: 'return=minimal',

      body: {
        last_seen_draw_id:
          Number(lastSeen)
      }
    }
  );

  group.last_seen_draw_id =
    Number(lastSeen);

  return {
    processed:
      pending.length,

    lastSeen:
      Number(lastSeen),

    capReached:
      Number(lastSeen) >= cap
  };
}

/* =========================================================
   GROUP FIVE ENGINE

   RULE:

   1. Analyze latest 30 draws.
   2. Select five numbers.
   3. Track NEXT 30 future draws.
   4. After exactly 30:
      - delete old results
      - archive old group marker
      - analyze latest 30 draws
      - create new five numbers
   5. Repeat.
========================================================= */

async function runGroupFive() {
  const control =
    await getControl();

  if (!control) {
    return {
      ok: true,
      active: false,
      reason: 'no-daily-control'
    };
  }

  const draws =
    await getCycleDraws(
      control
    );

  /*
    يجب توفر 30 سحبة
    قبل أول اختيار.
  */

  if (
    draws.length <
    ANALYSIS_DRAWS
  ) {
    return {
      ok: true,
      active: false,

      waitingFor:
        ANALYSIS_DRAWS,

      have:
        draws.length,

      remaining:
        ANALYSIS_DRAWS -
        draws.length
    };
  }

  let group =
    await getCurrentGroup();

  let created = false;
  let rotated = 0;
  let processed = 0;
  let method = null;

  /* =======================================================
     FIRST SELECTION
  ======================================================= */

  if (!group) {
    const firstWindow =
      draws.slice(
        -ANALYSIS_DRAWS
      );

    const pick =
      selectFive(
        firstWindow
      );

    if (!pick) {
      return {
        ok: false,
        active: false,
        error:
          'Unable to select five numbers from 30 draws'
      };
    }

    const startId =
      Number(
        firstWindow
          .at(-1)
          .draw_id
      );

    group =
      await createGroup(
        pick.numbers,
        startId
      );

    created = true;
    method = pick.method;
  }

  if (!group) {
    return {
      ok: false,
      active: false,
      error:
        'Unable to create Group Five'
    };
  }

  const latestId =
    Number(
      draws
        .at(-1)
        .draw_id
    );

  /*
    هذا الـ loop يسمح للنظام
    بتعويض التأخير إذا تأخر Cron
    أكثر من سحبة.
  */

  for (
    let guard = 0;
    guard < 20;
    guard++
  ) {
    const startId =
      Number(
        group.start_draw_id
      );

    const cap =
      startId +
      TRACK_DRAWS;

    const tracked =
      await trackGroup(
        group,
        draws,
        latestId
      );

    processed +=
      tracked.processed;

    /*
      لم نصل إلى 30 سحبة مستقبلية بعد.
    */

    if (
      latestId <
      cap
    ) {
      break;
    }

    /*
      ضمان عدم وجود نتائج
      بعد السحبة رقم 30.
    */

    await deleteOverflowResults(
      group.id,
      cap
    );

    /*
      تحليل آخر 30 سحبة
      تنتهي عند نهاية الدورة.
    */

    const window =
      getWindowEndingAt(
        draws,
        cap
      );

    if (
      window.length <
      ANALYSIS_DRAWS
    ) {
      break;
    }

    const pick =
      selectFive(
        window
      );

    if (!pick) {
      break;
    }

    /*
      نحذف نتائج الدورة القديمة
      قبل إنشاء الأرقام الجديدة.
    */

    await archiveGroupAndClearResults(
      group
    );

    /*
      تبدأ الأرقام الجديدة
      بعد آخر سحبة من الدورة السابقة.
    */

    group =
      await createGroup(
        pick.numbers,
        cap
      );

    rotated++;
    method = pick.method;

    if (!group) {
      break;
    }
  }

  return {
    ok: true,
    active: true,

    created,
    rotated,
    processed,

    groupId:
      group?.id || null,

    numbers:
      group?.numbers || null,

    analysisWindow:
      ANALYSIS_DRAWS,

    trackingWindow:
      TRACK_DRAWS,

    startDrawId:
      group?.start_draw_id || null,

    lastSeenDrawId:
      group?.last_seen_draw_id || null,

    nextSelectionAfterDrawId:
      group
        ? Number(group.start_draw_id) +
          TRACK_DRAWS
        : null,

    method,

    rule:
      'Analyze latest 30 draws, track next 30 future draws, clear old cycle results, then select new five numbers from latest 30.'
  };
}

module.exports = {
  runGroupFive
};
