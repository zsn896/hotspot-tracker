'use strict';

const { db, score } = require('../api/lib');
const { deepAnalyze50 } = require('./group-five');

const CONTROL_PREFIX = 'AUTO_CONTROL_';
const GROUP_NAME = 'AUTO Group Six';
const ARCHIVE_PREFIX = 'AUTO Group Six Archive ';

const MIN_ANALYSIS_DRAWS = 50;
const TRACK_DRAWS = 20;
const PERSISTENCE_SEGMENTS = 4;
const RECENT_WINDOW = 40;
const TOP_COMPANIONS = 18;

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

function recencyWeight(index, total) {
  if (total <= 1) return 1;
  return 1 + index / (total - 1);
}

function segmentForIndex(index, total) {
  if (total <= 1) return 0;

  return Math.min(
    PERSISTENCE_SEGMENTS - 1,
    Math.floor(
      index *
      PERSISTENCE_SEGMENTS /
      total
    )
  );
}

function hitCount(draw, numbers) {
  const set =
    new Set(
      norm(
        draw?.numbers
      )
    );

  let count = 0;

  for (const n of numbers) {
    if (set.has(Number(n))) {
      count++;
    }
  }

  return count;
}

function cumulativeWindow(inputDraws) {
  const rows =
    Array.isArray(inputDraws)
      ? [...inputDraws]
      : [];

  return rows.length >=
    MIN_ANALYSIS_DRAWS
      ? rows
      : [];
}

function getWindowEndingAt(
  draws,
  endId
) {
  return cumulativeWindow(
    (draws || []).filter(
      d =>
        Number(d.draw_id) <=
        Number(endId)
    )
  );
}

function analysisSizeForGroupStart(
  controlStartId,
  groupStartId
) {
  return (
    Number(groupStartId) -
    Number(controlStartId) +
    1
  );
}

function isAlignedGroupStart(
  groupStartId,
  firstSelectionEndId
) {
  const start =
    Number(groupStartId);

  const first =
    Number(firstSelectionEndId);

  if (
    !start ||
    !first ||
    start < first
  ) {
    return false;
  }

  return (
    (start - first) %
    TRACK_DRAWS
    === 0
  );
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
          String(
            r.name || ''
          )
        )
    )
    ||
    null
  );
}


/* =========================================================
   CURRENT GROUP SIX
========================================================= */

async function getCurrentGroup() {
  const rows =
    await db(
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=eq.${encodeURIComponent(
        GROUP_NAME
      )}&active=eq.true&order=id.desc&limit=1`
    );

  return (
    rows?.[0] ||
    null
  );
}


/* =========================================================
   DAILY DRAWS
========================================================= */

async function getCycleDraws(
  control
) {
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
    )
    ||
    []
  );
}


/* =========================================================
   CORE 3

   We reuse the proven Persistent Core 3 from Group Five,
   but ONLY take its 3-number core.
========================================================= */

function selectPersistentCore3(
  window
) {
  const ranked =
    deepAnalyze50(
      window
    );

  const core =
    norm(
      ranked?.[0]?.core ||
      []
    );

  if (
    core.length !== 3
  ) {
    return null;
  }

  return {
    core,

    sourceScore:
      Number(
        ranked?.[0]?.score ||
        0
      ),

    coreCount:
      Number(
        ranked?.[0]?.coreCount ||
        0
      ),

    coreRecentCount:
      Number(
        ranked?.[0]?.coreRecentCount ||
        0
      ),

    coreSegmentCount:
      Number(
        ranked?.[0]?.coreSegmentCount ||
        0
      ),

    coreConsistency:
      Number(
        ranked?.[0]?.coreConsistency ||
        0
      )
  };
}


/* =========================================================
   FULL-WINDOW COMPANIONS

   Group Six differs from Group Five here.

   Group Five:
   companions are mostly judged from draws where the Core appeared.

   Group Six:
   companions are judged using EVERY draw in the full
   50 / 70 / 90 / 110 ... cumulative window.
========================================================= */

function fullWindowCompanionStats(
  window,
  core
) {
  const map =
    new Map();

  const recentStart =
    Math.max(
      0,
      window.length -
      RECENT_WINDOW
    );

  for (
    let i = 0;
    i < window.length;
    i++
  ) {
    const nums =
      norm(
        window[i]?.numbers
      );

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

    const coreHits =
      hitCount(
        window[i],
        core
      );

    for (
      const n
      of nums
    ) {
      if (
        core.includes(n)
      ) {
        continue;
      }

      const old =
        map.get(n)
        ||
        {
          number: n,
          count: 0,
          weightedCount: 0,
          recentCount: 0,
          lastIndex: -1,
          segments:
            new Set(),
          coreOverlapHits: 0,
          weightedCoreOverlap: 0
        };

      old.count++;

      old.weightedCount +=
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

      if (
        coreHits > 0
      ) {
        old.coreOverlapHits +=
          coreHits;

        old.weightedCoreOverlap +=
          coreHits *
          weight;
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

        const supportScore =
          item.count * 4
          +
          item.weightedCount * 5
          +
          item.recentCount * 7
          +
          segmentCount * 8
          +
          item.coreOverlapHits * 3
          +
          item.weightedCoreOverlap * 4
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

        b.recentCount -
        a.recentCount

        ||

        b.segmentCount -
        a.segmentCount

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
      TOP_COMPANIONS
    );
}


/* =========================================================
   PAIR ANALYSIS

   Core remains fixed.
   Only the final two numbers compete.
========================================================= */

function evaluatePair(
  window,
  core,
  a,
  b
) {
  const numbers =
    norm([
      ...core,
      a.number,
      b.number
    ]);

  if (
    numbers.length !== 5
  ) {
    return null;
  }

  let exact5 = 0;
  let fourPlus = 0;
  let threePlus = 0;
  let weightedStrong = 0;
  let recentStrong = 0;
  let pairTogether = 0;
  let weightedPairTogether = 0;

  const recentStart =
    Math.max(
      0,
      window.length -
      RECENT_WINDOW
    );

  for (
    let i = 0;
    i < window.length;
    i++
  ) {
    const drawNums =
      new Set(
        norm(
          window[i]?.numbers
        )
      );

    const hits =
      hitCount(
        window[i],
        numbers
      );

    const weight =
      recencyWeight(
        i,
        window.length
      );

    if (
      hits === 5
    ) {
      exact5++;
    }

    if (
      hits >= 4
    ) {
      fourPlus++;
    }

    if (
      hits >= 3
    ) {
      threePlus++;

      weightedStrong +=
        (
          hits === 5
            ? 10
            : hits === 4
              ? 5
              : 2
        )
        *
        weight;

      if (
        i >= recentStart
      ) {
        recentStrong +=
          hits === 5
            ? 10
            : hits === 4
              ? 5
              : 2;
      }
    }

    if (
      drawNums.has(
        a.number
      )
      &&
      drawNums.has(
        b.number
      )
    ) {
      pairTogether++;

      weightedPairTogether +=
        weight;
    }
  }

  const balance =
    1 /
    (
      1 +
      Math.abs(
        a.supportScore -
        b.supportScore
      )
    );

  const scoreValue =
    a.supportScore
    +
    b.supportScore
    +
    pairTogether * 5
    +
    weightedPairTogether * 5
    +
    threePlus * 3
    +
    fourPlus * 16
    +
    exact5 * 45
    +
    weightedStrong * 2
    +
    recentStrong * 4
    +
    balance * 10;

  return {
    numbers,

    pair: [
      a.number,
      b.number
    ],

    score:
      scoreValue,

    exact5,

    fourPlus,

    threePlus,

    pairTogether,

    weightedPairTogether,

    companionA:
      a,

    companionB:
      b
  };
}


/* =========================================================
   GROUP SIX SELECTOR
========================================================= */

function selectGroupSix(
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

  const coreInfo =
    selectPersistentCore3(
      window
    );

  if (
    !coreInfo
  ) {
    return null;
  }

  const companions =
    fullWindowCompanionStats(
      window,
      coreInfo.core
    );

  const pairs = [];

  for (
    let i = 0;
    i < companions.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < companions.length;
      j++
    ) {
      const evaluated =
        evaluatePair(
          window,
          coreInfo.core,
          companions[i],
          companions[j]
        );

      if (
        evaluated
      ) {
        pairs.push(
          evaluated
        );
      }
    }
  }

  pairs.sort(
    (a, b) =>
      b.score -
      a.score

      ||

      b.exact5 -
      a.exact5

      ||

      b.fourPlus -
      a.fourPlus

      ||

      b.threePlus -
      a.threePlus

      ||

      b.pairTogether -
      a.pairTogether

      ||

      a.numbers
        .join(',')
        .localeCompare(
          b.numbers.join(',')
        )
  );

  const winner =
    pairs[0];

  if (
    !winner ||
    winner.numbers.length !== 5
  ) {
    return null;
  }

  return {
    numbers:
      winner.numbers,

    method:
      'group-six-core3-plus-full-window-companion-pair',

    analysis: {
      window:
        window.length,

      core:
        coreInfo.core,

      coreCount:
        coreInfo.coreCount,

      coreRecentCount:
        coreInfo.coreRecentCount,

      coreSegmentCount:
        coreInfo.coreSegmentCount,

      coreConsistency:
        Number(
          coreInfo
            .coreConsistency
            .toFixed(3)
        ),

      companionPool:
        companions.length,

      pairCandidates:
        pairs.length,

      selectedPair:
        winner.pair,

      score:
        Number(
          winner
            .score
            .toFixed(3)
        ),

      historicalThreePlus:
        winner.threePlus,

      historicalFourPlus:
        winner.fourPlus,

      historicalExact5:
        winner.exact5,

      pairTogether:
        winner.pairTogether,

      companions: [
        winner.companionA,
        winner.companionB
      ].map(
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
    }
  };
}


/* =========================================================
   DATABASE GROUP
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
   GROUP SIX ENGINE

   50 -> track 20
   70 -> track 20
   90 -> track 20
   110 -> track 20
   ...
========================================================= */

async function runGroupSix() {
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
        'Group Six waits for the first 50 daily draws.'
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

  if (
    !group
  ) {
    const pick =
      selectGroupSix(
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
          'Unable to select Group Six from first 50 cumulative draws.'
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
          'Unable to create Group Six.'
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

    if (
      window.length <
      MIN_ANALYSIS_DRAWS

      ||

      window.length !==
      expectedWindowSize
    ) {
      break;
    }

    const pick =
      selectGroupSix(
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

    name:
      GROUP_NAME,

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
      'existing-active-group-six',

    selectionAnalysis,

    rule:
      'Group Six: Persistent Core 3 chooses the fixed three-number core, then two companions are selected from the full cumulative 50/70/90/... window. The five numbers are fixed for exactly 20 future draws.',

    bestRule:
      'Every future draw counts toward 20. Group Six is independent from Group Five.'
  };
}

module.exports = {
  runGroupSix,
  selectGroupSix,
  fullWindowCompanionStats
};
