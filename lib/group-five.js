'use strict';

const { db, score } = require('../api/lib');

const CONTROL_PREFIX = 'AUTO_CONTROL_';
const GROUP_NAME = 'AUTO Group Five';
const ARCHIVE_PREFIX = 'AUTO Group Five Archive ';

const MIN_ANALYSIS_DRAWS = 50;
const TRACK_DRAWS = 20;

/*
  Persistent Core 3

  The selector no longer asks:
  "Which five numbers best explain the old draws?"

  It asks:
  1. Which 3-number core has persisted through different parts of the
     cumulative same-day history?
  2. Which two individual companions have supported that core most
     consistently?

  The 20-draw tracking rhythm is unchanged:
  50 -> track 20 -> 70 -> track 20 -> 90 -> ...
*/
const TOP_PERSISTENT_CORES = 40;
const MIN_CORE_OCCURRENCES = 2;
const MAX_COMPANIONS_PER_CORE = 16;
const PERSISTENCE_SEGMENTS = 4;
const RECENT_CORE_MAX = 60;
const RECENT_COMPANION_MAX = 40;

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

function combos(values, size, fn) {
  const a = norm(values);

  function walk(start, picked) {
    if (picked.length === size) {
      fn([...picked]);
      return;
    }

    for (
      let i = start;
      i <= a.length - (size - picked.length);
      i++
    ) {
      picked.push(a[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  }

  walk(0, []);
}

function combos3(values, fn) {
  combos(values, 3, fn);
}

function mean(values) {
  return values.length
    ? values.reduce((sum, n) => sum + n, 0) / values.length
    : 0;
}

function stdDev(values) {
  if (values.length < 2) {
    return 0;
  }

  const avg = mean(values);

  return Math.sqrt(
    mean(
      values.map(
        n =>
          (n - avg) ** 2
      )
    )
  );
}

function recencyWeight(index, total) {
  if (total <= 1) {
    return 1;
  }

  return 1 + index / (total - 1);
}

function segmentForIndex(index, total) {
  if (total <= 1) {
    return 0;
  }

  return Math.min(
    PERSISTENCE_SEGMENTS - 1,
    Math.floor(
      index * PERSISTENCE_SEGMENTS / total
    )
  );
}

function gapStats(indexes) {
  if (!indexes.length) {
    return {
      meanGap: 0,
      cv: null,
      consistency: 0
    };
  }

  if (indexes.length < 3) {
    return {
      meanGap: 0,
      cv: null,
      consistency: 0.35
    };
  }

  const gaps = [];

  for (let i = 1; i < indexes.length; i++) {
    gaps.push(indexes[i] - indexes[i - 1]);
  }

  const avg = mean(gaps);
  const sd = stdDev(gaps);
  const cv = avg > 0 ? sd / avg : null;

  return {
    meanGap: avg,
    cv,
    consistency:
      cv == null
        ? 0
        : 1 / (1 + cv)
  };
}


/* =========================================================
   DAILY CONTROL
========================================================= */

async function getControl() {
  const rows =
    await db(
      `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id&name=like.${encodeURIComponent(
        CONTROL_PREFIX + '*'
      )}&order=id.desc&limit=20`
    );

  return (
    (rows || []).find(
      r =>
        /^AUTO_CONTROL_\d{4}-\d{2}-\d{2}$/.test(
          String(r.name || '')
        )
    ) || null
  );
}


/* =========================================================
   ACTIVE GROUP FIVE
========================================================= */

async function getCurrentGroup() {
  const rows =
    await db(
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=eq.${encodeURIComponent(
        GROUP_NAME
      )}&active=eq.true&order=id.desc&limit=1`
    );

  return rows?.[0] || null;
}


/* =========================================================
   DAILY DRAWS
========================================================= */

async function getCycleDraws(control) {
  if (!control) {
    return [];
  }

  return (
    (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gte.${Number(
          control.start_draw_id
        )}&order=draw_id.asc&limit=500`
      )
    ) || []
  );
}


/* =========================================================
   CUMULATIVE WINDOW
========================================================= */

function cumulativeWindow(inputDraws) {
  const rows = Array.isArray(inputDraws)
    ? [...inputDraws]
    : [];

  if (rows.length < MIN_ANALYSIS_DRAWS) {
    return [];
  }

  return rows;
}

function getWindowEndingAt(draws, endId) {
  return cumulativeWindow(
    (draws || []).filter(
      d =>
        Number(d.draw_id) <= Number(endId)
    )
  );
}


/* =========================================================
   PERSISTENT CORE MAP
========================================================= */

function buildPersistentCoreMap(window) {
  const map = new Map();
  const recentSize = Math.min(RECENT_CORE_MAX, window.length);
  const recentStart = window.length - recentSize;

  for (let i = 0; i < window.length; i++) {
    const nums = norm(window[i]?.numbers);
    const weight = recencyWeight(i, window.length);
    const segment = segmentForIndex(i, window.length);

    combos3(nums, core => {
      const key = core.join(',');
      const old =
        map.get(key) || {
          core,
          count: 0,
          weightedCount: 0,
          recentCount: 0,
          firstIndex: i,
          lastIndex: i,
          indexes: [],
          segments: new Set()
        };

      old.count++;
      old.weightedCount += weight;
      old.firstIndex = Math.min(old.firstIndex, i);
      old.lastIndex = Math.max(old.lastIndex, i);
      old.indexes.push(i);
      old.segments.add(segment);

      if (i >= recentStart) {
        old.recentCount++;
      }

      map.set(key, old);
    });
  }

  return map;
}

function evaluateCorePersistence(coreInfo, windowLength) {
  const latestIndex = windowLength - 1;
  const span = coreInfo.lastIndex - coreInfo.firstIndex;

  const spanRatio =
    windowLength > 1
      ? span / (windowLength - 1)
      : 0;

  const age = latestIndex - coreInfo.lastIndex;
  const recency = 1 / (1 + age);

  const segmentCount = coreInfo.segments.size;

  const segmentRatio =
    segmentCount / PERSISTENCE_SEGMENTS;

  const gap =
    gapStats(coreInfo.indexes);

  /*
    Count alone is NOT enough.

    A strong core must:
    - repeat,
    - survive across different periods,
    - have reasonable spacing,
    - and still have some recent support.
  */
  const persistenceScore =
    coreInfo.count * 12
    +
    coreInfo.weightedCount * 5
    +
    coreInfo.recentCount * 9
    +
    segmentCount * 14
    +
    spanRatio * 18
    +
    recency * 20
    +
    gap.consistency * 12;

  return {
    ...coreInfo,
    segmentCount,
    segmentRatio,
    span,
    spanRatio,
    age,
    recency,
    meanGap: gap.meanGap,
    gapCV: gap.cv,
    consistency: gap.consistency,
    persistenceScore
  };
}

function topPersistentCores(window) {
  return [
    ...buildPersistentCoreMap(window).values()
  ]
    .filter(
      core =>
        core.count >= MIN_CORE_OCCURRENCES
    )
    .map(
      core =>
        evaluateCorePersistence(
          core,
          window.length
        )
    )
    .filter(
      core =>
        core.segmentCount >= 2 ||
        core.count >= 4
    )
    .sort(
      (a, b) =>
        b.persistenceScore -
        a.persistenceScore

        ||

        b.segmentCount -
        a.segmentCount

        ||

        b.recentCount -
        a.recentCount

        ||

        b.count -
        a.count

        ||

        b.lastIndex -
        a.lastIndex

        ||

        a.core
          .join(',')
          .localeCompare(
            b.core.join(',')
          )
    )
    .slice(
      0,
      TOP_PERSISTENT_CORES
    );
}


/* =========================================================
   COMPANION SUPPORT
========================================================= */

function companionSupport(
  window,
  coreInfo
) {
  const map = new Map();

  const recentStart =
    window.length -
    Math.min(
      RECENT_COMPANION_MAX,
      window.length
    );

  for (
    const drawIndex
    of coreInfo.indexes
  ) {
    const nums =
      norm(
        window[drawIndex]?.numbers
      );

    const weight =
      recencyWeight(
        drawIndex,
        window.length
      );

    const segment =
      segmentForIndex(
        drawIndex,
        window.length
      );

    for (const n of nums) {
      if (
        coreInfo.core.includes(n)
      ) {
        continue;
      }

      const old =
        map.get(n) || {
          number: n,
          count: 0,
          weightedCount: 0,
          recentCount: 0,
          lastIndex: -1,
          segments: new Set()
        };

      old.count++;

      old.weightedCount +=
        weight;

      old.lastIndex =
        Math.max(
          old.lastIndex,
          drawIndex
        );

      old.segments.add(
        segment
      );

      if (
        drawIndex >=
        recentStart
      ) {
        old.recentCount++;
      }

      map.set(
        n,
        old
      );
    }
  }

  return [
    ...map.values()
  ]
    .map(
      item => {
        const segmentCount =
          item.segments.size;

        const age =
          window.length -
          1 -
          item.lastIndex;

        const recency =
          1 /
          (
            1 +
            Math.max(
              0,
              age
            )
          );

        /*
          Each companion is judged individually.

          We do NOT search thousands of 5-number
          combinations for the best historical fit.

          This is intentional to reduce overfitting.
        */
        const supportScore =
          item.count * 10
          +
          item.weightedCount * 4
          +
          item.recentCount * 8
          +
          segmentCount * 9
          +
          recency * 12;

        return {
          ...item,
          segmentCount,
          age,
          recency,
          supportScore
        };
      }
    )
    .sort(
      (a, b) =>
        b.supportScore -
        a.supportScore

        ||

        b.segmentCount -
        a.segmentCount

        ||

        b.recentCount -
        a.recentCount

        ||

        b.count -
        a.count

        ||

        b.lastIndex -
        a.lastIndex

        ||

        a.number -
        b.number
    )
    .slice(
      0,
      MAX_COMPANIONS_PER_CORE
    );
}

function chooseTwoCompanions(
  companions
) {
  const picked = [];

  for (
    const item
    of companions
  ) {
    if (
      !picked.includes(
        item.number
      )
    ) {
      picked.push(
        item.number
      );
    }

    if (
      picked.length === 2
    ) {
      break;
    }
  }

  return picked;
}


/* =========================================================
   PERSISTENT CORE ANALYSIS

   Name kept as deepAnalyze50 for compatibility.
========================================================= */

function deepAnalyze50(
  inputDraws
) {
  const window =
    cumulativeWindow(
      inputDraws
    );

  if (
    window.length <
    MIN_ANALYSIS_DRAWS
  ) {
    return [];
  }

  const cores =
    topPersistentCores(
      window
    );

  const candidates = [];

  for (
    const coreInfo
    of cores
  ) {
    const companions =
      companionSupport(
        window,
        coreInfo
      );

    const two =
      chooseTwoCompanions(
        companions
      );

    const numbers =
      norm([
        ...coreInfo.core,
        ...two
      ]);

    if (
      numbers.length !== 5
    ) {
      continue;
    }

    const selectedCompanions =
      companions.filter(
        x =>
          two.includes(
            x.number
          )
      );

    const companionScore =
      selectedCompanions.reduce(
        (sum, x) =>
          sum +
          x.supportScore,
        0
      );

    /*
      Core dominates the final score.

      The two companions assist the core;
      they do not overpower it.
    */
    const scoreValue =
      coreInfo.persistenceScore * 3
      +
      companionScore;

    candidates.push({
      numbers,

      score:
        scoreValue,

      core:
        coreInfo.core,

      coreCount:
        coreInfo.count,

      coreWeighted:
        coreInfo.weightedCount,

      coreRecentCount:
        coreInfo.recentCount,

      coreSegmentCount:
        coreInfo.segmentCount,

      coreSpan:
        coreInfo.span,

      coreSpanRatio:
        coreInfo.spanRatio,

      coreAge:
        coreInfo.age,

      coreConsistency:
        coreInfo.consistency,

      coreMeanGap:
        coreInfo.meanGap,

      coreGapCV:
        coreInfo.gapCV,

      companions:
        selectedCompanions.map(
          x => ({
            number:
              x.number,

            count:
              x.count,

            recentCount:
              x.recentCount,

            segmentCount:
              x.segmentCount,

            supportScore:
              Number(
                x
                  .supportScore
                  .toFixed(3)
              )
          })
        )
    });
  }

  candidates.sort(
    (a, b) =>
      b.score -
      a.score

      ||

      b.coreSegmentCount -
      a.coreSegmentCount

      ||

      b.coreRecentCount -
      a.coreRecentCount

      ||

      b.coreCount -
      a.coreCount

      ||

      b.coreSpan -
      a.coreSpan

      ||

      a.numbers
        .join(',')
        .localeCompare(
          b.numbers.join(',')
        )
  );

  return candidates;
}


/* =========================================================
   FALLBACK
========================================================= */

function fallbackFive(
  inputDraws
) {
  const window =
    cumulativeWindow(
      inputDraws
    );

  if (
    window.length <
    MIN_ANALYSIS_DRAWS
  ) {
    return [];
  }

  const stats =
    new Map();

  const recentStart =
    window.length -
    Math.min(
      RECENT_CORE_MAX,
      window.length
    );

  for (
    let i = 0;
    i < window.length;
    i++
  ) {
    const weight =
      recencyWeight(
        i,
        window.length
      );

    const segment =
      segmentForIndex(
        i,
        window.length
      );

    for (
      const n
      of norm(
        window[i]?.numbers
      )
    ) {
      const old =
        stats.get(n) || {
          number: n,
          count: 0,
          weighted: 0,
          recentCount: 0,
          lastIndex: -1,
          segments:
            new Set()
        };

      old.count++;

      old.weighted +=
        weight;

      old.lastIndex =
        Math.max(
          old.lastIndex,
          i
        );

      old.segments.add(
        segment
      );

      if (
        i >= recentStart
      ) {
        old.recentCount++;
      }

      stats.set(
        n,
        old
      );
    }
  }

  return [
    ...stats.values()
  ]
    .map(
      x => ({
        ...x,

        fallbackScore:
          x.count * 4
          +
          x.weighted * 3
          +
          x.recentCount * 4
          +
          x.segments.size * 5
          +
          10 /
          (
            1 +
            Math.max(
              0,
              window.length -
              1 -
              x.lastIndex
            )
          )
      })
    )
    .sort(
      (a, b) =>
        b.fallbackScore -
        a.fallbackScore

        ||

        b.recentCount -
        a.recentCount

        ||

        b.count -
        a.count

        ||

        a.number -
        b.number
    )
    .slice(
      0,
      5
    )
    .map(
      x =>
        x.number
    )
    .sort(
      (a, b) =>
        a - b
    );
}


/* =========================================================
   SELECT FIVE
========================================================= */

function selectFive(
  inputDraws
) {
  const window =
    cumulativeWindow(
      inputDraws
    );

  if (
    window.length <
    MIN_ANALYSIS_DRAWS
  ) {
    return null;
  }

  const ranked =
    deepAnalyze50(
      window
    );

  const winner =
    ranked?.[0];

  const numbers =
    norm(
      winner?.numbers ||
      []
    );

  if (
    numbers.length === 5
  ) {
    return {
      numbers,

      method:
        'persistent-core3-temporal-spread-plus-two-supporters',

      analysis: {
        window:
          window.length,

        candidateCount:
          ranked.length,

        score:
          Number(
            winner
              .score
              .toFixed(3)
          ),

        core:
          winner.core,

        coreCount:
          winner.coreCount,

        coreRecentCount:
          winner.coreRecentCount,

        coreSegmentCount:
          winner.coreSegmentCount,

        coreSpan:
          winner.coreSpan,

        coreSpanRatio:
          Number(
            winner
              .coreSpanRatio
              .toFixed(3)
          ),

        coreAge:
          winner.coreAge,

        coreConsistency:
          Number(
            winner
              .coreConsistency
              .toFixed(3)
          ),

        coreMeanGap:
          Number(
            winner
              .coreMeanGap
              .toFixed(2)
          ),

        coreGapCV:
          winner
            .coreGapCV == null
              ? null
              : Number(
                  winner
                    .coreGapCV
                    .toFixed(3)
                ),

        companions:
          winner.companions
      }
    };
  }

  const fallback =
    fallbackFive(
      window
    );

  if (
    fallback.length !== 5
  ) {
    return null;
  }

  return {
    numbers:
      fallback,

    method:
      'persistent-frequency-recency-fallback',

    analysis: {
      window:
        window.length,

      fallback:
        true
    }
  };
}


/* =========================================================
   CREATE GROUP
========================================================= */

async function createGroup(
  numbers,
  startDrawId
) {
  const rows =
    await db(
      'tracker_groups',
      {
        method:
          'POST',

        prefer:
          'return=representation',

        body: {
          name:
            GROUP_NAME,

          numbers:
            norm(numbers),

          active:
            true,

          start_draw_id:
            Number(
              startDrawId
            ),

          last_seen_draw_id:
            Number(
              startDrawId
            )
        }
      }
    );

  return (
    rows?.[0] ||
    null
  );
}


/* =========================================================
   DISCARD INVALID GROUP
========================================================= */

async function discardGroup(
  group
) {
  if (
    !group?.id
  ) {
    return;
  }

  await db(
    `tracker_results?group_id=eq.${group.id}`,
    {
      method:
        'DELETE',

      prefer:
        'return=minimal'
    }
  );

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


/* =========================================================
   ARCHIVE FINISHED CYCLE
========================================================= */

async function archiveGroupAndClearResults(
  group
) {
  await db(
    `tracker_results?group_id=eq.${group.id}`,
    {
      method:
        'DELETE',

      prefer:
        'return=minimal'
    }
  );

  await db(
    `tracker_groups?id=eq.${group.id}`,
    {
      method:
        'PATCH',

      prefer:
        'return=minimal',

      body: {
        name:
          `${ARCHIVE_PREFIX}${group.start_draw_id}`,

        active:
          false,

        last_seen_draw_id:
          Number(
            group.start_draw_id
          )
          +
          TRACK_DRAWS
      }
    }
  );
}


/* =========================================================
   TRACK NEXT 20
========================================================= */

async function trackGroup(
  group,
  draws,
  latestId
) {
  const after =
    Number(
      group.last_seen_draw_id
      ??
      group.start_draw_id
    );

  const cutoff =
    Number(
      group.start_draw_id
    )
    +
    TRACK_DRAWS;

  const target =
    Math.min(
      Number(
        latestId
      ),
      cutoff
    );

  if (
    target <= after
  ) {
    return {
      processed:
        0,

      lastSeen:
        after,

      capReached:
        after >= cutoff
    };
  }

  const pending =
    draws.filter(
      d =>
        Number(
          d.draw_id
        ) > after

        &&

        Number(
          d.draw_id
        ) <= target
    );

  for (
    const d
    of pending
  ) {
    const s =
      score(
        {
          numbers:
            d.numbers,

          bullsEye:
            d.bulls_eye
        },

        group.numbers
      );

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
            d.draw_id,

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
    pending.at(-1)
      ?.draw_id
    ??
    after;

  await db(
    `tracker_groups?id=eq.${group.id}`,
    {
      method:
        'PATCH',

      prefer:
        'return=minimal',

      body: {
        last_seen_draw_id:
          Number(
            lastSeen
          )
      }
    }
  );

  group.last_seen_draw_id =
    Number(
      lastSeen
    );

  return {
    processed:
      pending.length,

    lastSeen:
      Number(
        lastSeen
      ),

    capReached:
      Number(
        lastSeen
      ) >= cutoff
  };
}


/* =========================================================
   ALIGNMENT
========================================================= */

function isAlignedGroupStart(
  groupStartId,
  firstSelectionEndId
) {
  const start =
    Number(
      groupStartId
    );

  const first =
    Number(
      firstSelectionEndId
    );

  if (
    !start ||
    !first ||
    start < first
  ) {
    return false;
  }

  return (
    (
      start -
      first
    )
    %
    TRACK_DRAWS
    ===
    0
  );
}

function analysisSizeForGroupStart(
  controlStartId,
  groupStartId
) {
  return (
    Number(
      groupStartId
    )
    -
    Number(
      controlStartId
    )
    +
    1
  );
}


/* =========================================================
   GROUP FIVE ENGINE
========================================================= */

async function runGroupFive() {
  const control =
    await getControl();

  if (
    !control
  ) {
    return {
      ok:
        true,

      active:
        false,

      reason:
        'no-daily-control'
    };
  }

  const draws =
    await getCycleDraws(
      control
    );

  if (
    draws.length <
    MIN_ANALYSIS_DRAWS
  ) {
    return {
      ok:
        true,

      active:
        false,

      waitingFor:
        MIN_ANALYSIS_DRAWS,

      have:
        draws.length,

      remaining:
        MIN_ANALYSIS_DRAWS -
        draws.length,

      rule:
        'First cycle waits for the first 50 daily draws.'
    };
  }

  const firstSelectionEndId =
    Number(
      control.start_draw_id
    )
    +
    MIN_ANALYSIS_DRAWS
    -
    1;

  const firstWindow =
    getWindowEndingAt(
      draws,
      firstSelectionEndId
    );

  if (
    firstWindow.length !==
    MIN_ANALYSIS_DRAWS
  ) {
    return {
      ok:
        true,

      active:
        false,

      waitingFor:
        MIN_ANALYSIS_DRAWS,

      have:
        Math.min(
          draws.length,
          MIN_ANALYSIS_DRAWS
        ),

      remaining:
        Math.max(
          0,
          MIN_ANALYSIS_DRAWS -
          draws.length
        ),

      error:
        'First exact 50-draw cumulative window is not complete.'
    };
  }

  let group =
    await getCurrentGroup();

  let created =
    false;

  let rotated =
    0;

  let processed =
    0;

  let repairedAlignment =
    false;

  let method =
    null;

  let selectionAnalysis =
    null;


  /*
    Repair only if an old group is
    outside the fixed 20-draw rhythm.
  */
  if (
    group
    &&
    !isAlignedGroupStart(
      group.start_draw_id,
      firstSelectionEndId
    )
  ) {
    await discardGroup(
      group
    );

    group =
      null;

    repairedAlignment =
      true;
  }


  /*
    First 50 only when no active
    Group Five exists.
  */
  if (
    !group
  ) {
    const pick =
      selectFive(
        firstWindow
      );

    if (
      !pick
    ) {
      return {
        ok:
          false,

        active:
          false,

        error:
          'Unable to select Group Five from first 50 cumulative draws.'
      };
    }

    group =
      await createGroup(
        pick.numbers,
        firstSelectionEndId
      );

    if (
      !group
    ) {
      return {
        ok:
          false,

        active:
          false,

        error:
          'Unable to create Group Five.'
      };
    }

    created =
      true;

    method =
      pick.method;

    selectionAnalysis =
      pick.analysis ||
      null;
  }

  const latestId =
    Number(
      draws.at(-1)
        .draw_id
    );


  /*
    CUMULATIVE CATCH-UP LOOP

    50  -> track next 20
    70  -> track next 20
    90  -> track next 20
    110 -> track next 20
    ...

    Old same-day draws are never removed.
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

    const cutoff =
      startId +
      TRACK_DRAWS;

    const trackedNow =
      await trackGroup(
        group,
        draws,
        latestId
      );

    processed +=
      trackedNow.processed;

    /*
      Keep current five until
      exactly 20 future draws finish.
    */
    if (
      latestId < cutoff
    ) {
      break;
    }

    const window =
      getWindowEndingAt(
        draws,
        cutoff
      );

    const expectedWindowSize =
      analysisSizeForGroupStart(
        control.start_draw_id,
        cutoff
      );

    /*
      Never rotate from an incomplete
      cumulative window.
    */
    if (
      window.length <
      MIN_ANALYSIS_DRAWS

      ||

      window.length !==
      expectedWindowSize
    ) {
      break;
    }

    /*
      This is the ONLY place where the
      next five are chosen after a cycle.

      New method:
      Persistent Core 3 + two supporters.
    */
    const pick =
      selectFive(
        window
      );

    if (
      !pick
    ) {
      break;
    }

    await archiveGroupAndClearResults(
      group
    );

    group =
      await createGroup(
        pick.numbers,
        cutoff
      );

    if (
      !group
    ) {
      break;
    }

    rotated++;

    method =
      pick.method;

    selectionAnalysis =
      pick.analysis ||
      null;
  }


  const startId =
    Number(
      group?.start_draw_id ||
      0
    );

  const lastSeen =
    Number(
      group?.last_seen_draw_id
      ??
      startId
    );

  const tracked =
    Math.max(
      0,
      Math.min(
        TRACK_DRAWS,
        lastSeen -
        startId
      )
    );

  const analysisWindow =
    analysisSizeForGroupStart(
      control.start_draw_id,
      startId
    );

  return {
    ok:
      true,

    active:
      true,

    created,

    rotated,

    processed,

    repairedAlignment,

    groupId:
      group?.id ||
      null,

    numbers:
      norm(
        group?.numbers ||
        []
      ),

    startDrawId:
      startId,

    lastSeenDrawId:
      lastSeen,

    tracked,

    remaining:
      Math.max(
        0,
        TRACK_DRAWS -
        tracked
      ),

    nextSelectionAfterDrawId:
      startId +
      TRACK_DRAWS,

    firstSelectionEndId,

    analysisWindow,

    trackingWindow:
      TRACK_DRAWS,

    method:
      method ||
      'existing-active-group',

    selectionAnalysis,

    rule:
      'Persistent Core 3 on cumulative daily history: 50 -> track 20 -> 70 -> track 20 -> 90 -> repeat.',

    bestRule:
      'Every future draw counts toward 20. Selection prioritizes a persistent 3-number core plus two individually supported companions.'
  };
}


module.exports = {
  runGroupFive,
  deepAnalyze50,
  selectFive
};
