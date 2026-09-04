'use strict';

const { db, score, parseDrawMinutes } = require('../api/lib');

const CONTROL_PREFIX = 'AUTO_CONTROL_';
const AUTO_PREFIX = 'AUTO Group ';
const SPECIAL_NAME = 'AUTO Group Special';
const MARKER_PREFIX = 'AUTO_CONTROL_SPECIAL_ACTIVE_';

const COLLECTION_DRAWS = 180;
const DEV_DRAWS = 120;
const VAL_A_DRAWS = 30;
const VAL_B_DRAWS = 30;
const TOP_TRIPLES = 40;
const TOP_PAIRS = 60;
const TOP_AFTER_A = 50;

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

function dateKey(text) {
  const d =
    new Date(
      String(text || '') +
      ' 12:00:00 UTC'
    );

  if (
    Number.isNaN(
      d.getTime()
    )
  ) {
    return null;
  }

  return (
    `${d.getUTCFullYear()}-` +
    `${String(
      d.getUTCMonth() + 1
    ).padStart(2, '0')}-` +
    `${String(
      d.getUTCDate()
    ).padStart(2, '0')}`
  );
}

function inCollection(
  draw,
  key
) {
  const m =
    parseDrawMinutes(
      draw.draw_time ??
      draw.time
    );

  return (
    dateKey(
      draw.draw_date ??
      draw.date
    ) === key &&
    m != null &&
    m >= 360 &&
    m <= 1080
  );
}

function combos(
  values,
  size
) {
  const a =
    norm(values);

  const out = [];

  function walk(
    start,
    picked
  ) {
    if (
      picked.length === size
    ) {
      out.push(
        [...picked]
      );

      return;
    }

    for (
      let i = start;
      i <=
      a.length -
      (
        size -
        picked.length
      );
      i++
    ) {
      picked.push(
        a[i]
      );

      walk(
        i + 1,
        picked
      );

      picked.pop();
    }
  }

  walk(
    0,
    []
  );

  return out;
}

function sameFive(
  a,
  b
) {
  const x =
    norm(a);

  const y =
    norm(b);

  return (
    x.length === 5 &&
    y.length === 5 &&
    x.every(
      (
        n,
        i
      ) =>
        n === y[i]
    )
  );
}

function componentCounts(
  draws,
  size
) {
  const map =
    new Map();

  for (
    const d
    of draws
  ) {
    for (
      const c
      of combos(
        d.numbers,
        size
      )
    ) {
      const key =
        c.join(',');

      map.set(
        key,
        (
          map.get(key) ||
          0
        ) + 1
      );
    }
  }

  return [...map.entries()]
    .map(
      ([key, count]) => ({
        numbers:
          key
            .split(',')
            .map(Number),

        count
      })
    )
    .sort(
      (a, b) =>
        b.count -
        a.count ||

        a.numbers
          .join(',')
          .localeCompare(
            b.numbers
              .join(',')
          )
    );
}

function evaluateDensity(
  draws,
  numbers
) {
  const distribution =
    [0, 0, 0, 0, 0, 0];

  const events = [];

  let totalHits = 0;

  for (
    let i = 0;
    i < draws.length;
    i++
  ) {
    const d =
      draws[i];

    const s =
      score(
        {
          numbers:
            d.numbers,

          bullsEye:
            d.bulls_eye ??
            d.bullsEye ??
            null
        },

        numbers
      );

    distribution[
      s.count
    ]++;

    totalHits +=
      s.count;

    if (
      s.count >= 3
    ) {
      events.push({
        index:
          i,

        drawId:
          Number(
            d.draw_id ??
            d.id ??
            0
          ),

        count:
          s.count
      });
    }
  }

  const gaps = [];

  for (
    let i = 1;
    i < events.length;
    i++
  ) {
    gaps.push(
      events[i].index -
      events[i - 1].index
    );
  }

  const meanGap =
    gaps.length
      ? gaps.reduce(
          (a, b) =>
            a + b,
          0
        ) / gaps.length
      : null;

  let maxGap =
    draws.length;

  if (
    events.length
  ) {
    const startGap =
      events[0].index;

    const endGap =
      draws.length -
      1 -
      events.at(-1).index;

    maxGap =
      Math.max(
        startGap,
        endGap,
        ...(
          gaps.length
            ? gaps
            : [0]
        )
      );
  }

  const exact3 =
    distribution[3];

  const exact4 =
    distribution[4];

  const exact5 =
    distribution[5];

  return {
    draws:
      draws.length,

    distribution,

    exact3,

    exact4,

    exact5,

    threePlus:
      exact3 +
      exact4 +
      exact5,

    fourPlus:
      exact4 +
      exact5,

    averageHits:
      +(
        draws.length
          ? totalHits /
            draws.length
          : 0
      ).toFixed(3),

    meanGap:
      meanGap == null
        ? null
        : +meanGap
            .toFixed(3),

    maxGap,

    hitDrawIds:
      events.map(
        x =>
          x.drawId
      )
  };
}

function rankA(
  a,
  b
) {
  return (
    b.validationA.fourPlus -
    a.validationA.fourPlus

    ||

    b.validationA.threePlus -
    a.validationA.threePlus

    ||

    a.validationA.maxGap -
    b.validationA.maxGap

    ||

    (
      a.validationA.meanGap ??
      999
    ) -
    (
      b.validationA.meanGap ??
      999
    )

    ||

    b.validationA.averageHits -
    a.validationA.averageHits

    ||

    b.componentStrength -
    a.componentStrength
  );
}

function rankFinal(
  a,
  b
) {
  const amin3 =
    Math.min(
      a.validationA.threePlus,
      a.validationB.threePlus
    );

  const bmin3 =
    Math.min(
      b.validationA.threePlus,
      b.validationB.threePlus
    );

  const amin4 =
    Math.min(
      a.validationA.fourPlus,
      a.validationB.fourPlus
    );

  const bmin4 =
    Math.min(
      b.validationA.fourPlus,
      b.validationB.fourPlus
    );

  const at4 =
    a.validationA.fourPlus +
    a.validationB.fourPlus;

  const bt4 =
    b.validationA.fourPlus +
    b.validationB.fourPlus;

  const at3 =
    a.validationA.threePlus +
    a.validationB.threePlus;

  const bt3 =
    b.validationA.threePlus +
    b.validationB.threePlus;

  const aworst =
    Math.max(
      a.validationA.maxGap,
      a.validationB.maxGap
    );

  const bworst =
    Math.max(
      b.validationA.maxGap,
      b.validationB.maxGap
    );

  return (
    bmin4 -
    amin4

    ||

    bmin3 -
    amin3

    ||

    bt4 -
    at4

    ||

    bt3 -
    at3

    ||

    aworst -
    bworst

    ||

    (
      a.validationB.meanGap ??
      999
    ) -
    (
      b.validationB.meanGap ??
      999
    )

    ||

    b.validationB.averageHits -
    a.validationB.averageHits

    ||

    b.componentStrength -
    a.componentStrength
  );
}

function buildActiveDensitySpecial(
  history,
  excludedGroups = []
) {
  if (
    !Array.isArray(history) ||
    history.length <
    COLLECTION_DRAWS
  ) {
    return null;
  }

  const complete =
    [...history]
      .sort(
        (a, b) =>
          Number(
            a.draw_id ??
            a.id ??
            0
          ) -
          Number(
            b.draw_id ??
            b.id ??
            0
          )
      )
      .slice(
        0,
        COLLECTION_DRAWS
      );

  const dev =
    complete.slice(
      0,
      DEV_DRAWS
    );

  const valA =
    complete.slice(
      DEV_DRAWS,
      DEV_DRAWS +
      VAL_A_DRAWS
    );

  const valB =
    complete.slice(
      DEV_DRAWS +
      VAL_A_DRAWS,
      COLLECTION_DRAWS
    );

  const triples =
    componentCounts(
      dev,
      3
    ).slice(
      0,
      TOP_TRIPLES
    );

  const pairs =
    componentCounts(
      dev,
      2
    ).slice(
      0,
      TOP_PAIRS
    );

  const excluded =
    excludedGroups
      .map(norm)
      .filter(
        x =>
          x.length === 5
      );

  const pool =
    new Map();

  for (
    const t
    of triples
  ) {
    for (
      const p
      of pairs
    ) {
      const numbers =
        norm([
          ...t.numbers,
          ...p.numbers
        ]);

      if (
        numbers.length !== 5
      ) {
        continue;
      }

      if (
        excluded.some(
          g =>
            sameFive(
              numbers,
              g
            )
        )
      ) {
        continue;
      }

      const key =
        numbers.join(',');

      const componentStrength =
        t.count * 2 +
        p.count;

      const old =
        pool.get(
          key
        );

      if (
        !old ||
        componentStrength >
        old.componentStrength
      ) {
        pool.set(
          key,
          {
            numbers,

            triple:
              [...t.numbers],

            tripleCount:
              t.count,

            pair:
              [...p.numbers],

            pairCount:
              p.count,

            componentStrength
          }
        );
      }
    }
  }

  if (
    !pool.size
  ) {
    return null;
  }

  const afterA =
    [...pool.values()]
      .map(
        c => ({
          ...c,

          development:
            evaluateDensity(
              dev,
              c.numbers
            ),

          validationA:
            evaluateDensity(
              valA,
              c.numbers
            )
        })
      )
      .sort(
        rankA
      )
      .slice(
        0,
        TOP_AFTER_A
      );

  const finalists =
    afterA
      .map(
        c => ({
          ...c,

          validationB:
            evaluateDensity(
              valB,
              c.numbers
            )
        })
      )
      .sort(
        rankFinal
      );

  const best =
    finalists[0];

  if (
    !best
  ) {
    return null;
  }

  const validation60 =
    evaluateDensity(
      [
        ...valA,
        ...valB
      ],

      best.numbers
    );

  return {
    ...best,

    generatedCandidates:
      pool.size,

    shortlistedCandidates:
      finalists.length,

    validationTotalThreePlus:
      validation60
        .threePlus,

    validationTotalFourPlus:
      validation60
        .fourPlus,

    validationMeanGap:
      validation60
        .meanGap,

    validationMaxGap:
      validation60
        .maxGap,

    method:
      'Active Density: 120 development + 30 validation A + 30 validation B'
  };
}


/* =========================================================
   DATABASE
========================================================= */

async function getControl() {

  /*
    IMPORTANT:

    There are marker rows such as:
    AUTO_CONTROL_SPECIAL_ACTIVE_2026-09-04

    They must NEVER be treated as the daily control.

    Valid daily control only:
    AUTO_CONTROL_YYYY-MM-DD
  */

  const rows =
    await db(
      `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id&name=like.${encodeURIComponent(
        CONTROL_PREFIX + '*'
      )}&order=id.desc&limit=20`
    );

  return (
    (rows || []).find(
      row =>
        /^AUTO_CONTROL_\d{4}-\d{2}-\d{2}$/.test(
          String(
            row.name || ''
          )
        )
    )
    ||
    null
  );
}

async function getGroup(
  name
) {
  const rows =
    await db(
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=eq.${encodeURIComponent(
        name
      )}&order=id.desc&limit=1`
    );

  return (
    rows?.[0] ||
    null
  );
}

async function getMarker(
  cycleDate
) {
  const name =
    `${MARKER_PREFIX}${cycleDate}`;

  const rows =
    await db(
      `tracker_groups?select=id,name&name=eq.${encodeURIComponent(
        name
      )}&order=id.desc&limit=1`
    );

  return (
    rows?.[0] ||
    null
  );
}

async function createMarker(
  cycleDate,
  startId
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
            `${MARKER_PREFIX}${cycleDate}`,

          numbers:
            [1, 2, 3, 4, 5],

          active:
            false,

          start_draw_id:
            startId,

          last_seen_draw_id:
            startId
        }
      }
    );

  return (
    rows?.[0] ||
    null
  );
}

async function replaceSpecial(
  numbers,
  collectionEndId
) {
  const existing =
    await getGroup(
      SPECIAL_NAME
    );

  if (
    existing
  ) {
    await db(
      `tracker_results?group_id=eq.${existing.id}`,
      {
        method:
          'DELETE',

        prefer:
          'return=minimal'
      }
    );

    await db(
      `tracker_groups?id=eq.${existing.id}`,
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
            collectionEndId,

          last_seen_draw_id:
            collectionEndId
        }
      }
    );

    return {
      ...existing,

      numbers,

      active:
        true,

      start_draw_id:
        collectionEndId,

      last_seen_draw_id:
        collectionEndId
    };
  }

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
            SPECIAL_NAME,

          numbers,

          active:
            true,

          start_draw_id:
            collectionEndId,

          last_seen_draw_id:
            collectionEndId
        }
      }
    );

  return (
    rows?.[0] ||
    null
  );
}


/* =========================================================
   RUN ONCE PER AUTOMATIC CYCLE
========================================================= */

async function runActiveDensitySpecial() {
  const control =
    await getControl();

  if (
    !control
  ) {
    return {
      ok:
        true,

      replaced:
        false,

      reason:
        'no-active-cycle'
    };
  }

  const cycleDate =
    String(
      control.name ||
      ''
    ).replace(
      CONTROL_PREFIX,
      ''
    );

  const marker =
    await getMarker(
      cycleDate
    );

  if (
    marker
  ) {
    return {
      ok:
        true,

      replaced:
        false,

      reason:
        'already-active-density',

      group:
        await getGroup(
          SPECIAL_NAME
        )
    };
  }

  const raw =
    (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gte.${control.start_draw_id}&order=draw_id.asc&limit=220`
      )
    ) || [];

  const history =
    raw
      .filter(
        d =>
          inCollection(
            d,
            cycleDate
          )
      )
      .sort(
        (a, b) =>
          Number(
            a.draw_id
          ) -
          Number(
            b.draw_id
          )
      )
      .slice(
        0,
        COLLECTION_DRAWS
      );

  if (
    history.length <
    COLLECTION_DRAWS
  ) {
    return {
      ok:
        true,

      replaced:
        false,

      reason:
        'collection-incomplete',

      have:
        history.length,

      need:
        COLLECTION_DRAWS
    };
  }

  const group1 =
    await getGroup(
      `${AUTO_PREFIX}1`
    );

  const group2 =
    await getGroup(
      `${AUTO_PREFIX}2`
    );

  if (
    !group1?.active ||
    !group2?.active
  ) {
    return {
      ok:
        true,

      replaced:
        false,

      reason:
        'base-groups-not-ready'
    };
  }

  const selected =
    buildActiveDensitySpecial(
      history,

      [
        group1.numbers,
        group2.numbers
      ]
    );

  if (
    !selected
      ?.numbers
      ?.length
  ) {
    return {
      ok:
        false,

      replaced:
        false,

      reason:
        'no-active-density-candidate'
    };
  }

  const collectionEndId =
    Number(
      history.at(-1)
        .draw_id
    );

  const group =
    await replaceSpecial(
      selected.numbers,
      collectionEndId
    );

  await createMarker(
    cycleDate,
    collectionEndId
  );

  return {
    ok:
      true,

    replaced:
      true,

    group,

    selected
  };
}

module.exports = {
  runActiveDensitySpecial,
  buildActiveDensitySpecial,
  SPECIAL_NAME
};
