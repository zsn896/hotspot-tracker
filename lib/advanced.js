'use strict';

const { db, score, parseDrawMinutes } = require('../api/lib');

const CONTROL_PREFIX = 'AUTO_CONTROL_';
const AUTO_PREFIX = 'AUTO Group ';
const ADVANCED_NAME = 'AUTO Group Advanced';
const SPECIAL_NAME = 'AUTO Group Special';
const COLLECTION_DRAWS = 180;
const DEVELOPMENT_DRAWS = 120;
const VALIDATION_BLOCK_DRAWS = 30;
const TOP_TRIPLES = 30;
const TOP_PAIRS = 40;
const MAX_TRACKED_DRAWS = 120;

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function dateKey(text) {
  const d = new Date(String(text || '') + ' 12:00:00 UTC');

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return (
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getUTCDate()).padStart(2, '0')}`
  );
}

function inCollection(draw, key) {
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

function combos(values, size) {
  const a =
    norm(values);

  const out = [];

  function walk(start, picked) {
    if (picked.length === size) {
      out.push([...picked]);
      return;
    }

    for (
      let i = start;
      i <=
      a.length -
      (size - picked.length);
      i++
    ) {
      picked.push(a[i]);

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

function sameFive(a, b) {
  const x =
    norm(a);

  const y =
    norm(b);

  return (
    x.length === 5 &&
    y.length === 5 &&
    x.every(
      (n, i) =>
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
      const k =
        c.join(',');

      map.set(
        k,
        (map.get(k) || 0) + 1
      );
    }
  }

  return [...map.entries()]
    .map(
      ([k, count]) => ({
        numbers:
          k
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
            b.numbers.join(',')
          )
    );
}

function evaluate(
  draws,
  numbers
) {
  const dist =
    [0, 0, 0, 0, 0, 0];

  let total =
    0;

  for (
    const d
    of draws
  ) {
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

    dist[s.count]++;

    total +=
      s.count;
  }

  const avg =
    draws.length
      ? total /
        draws.length
      : 0;

  const exact3 =
    dist[3];

  const exact4 =
    dist[4];

  const exact5 =
    dist[5];

  const weighted =
    exact5 * 100 +
    exact4 * 25 +
    exact3 * 5 +
    dist[2] * 0.5 +
    avg;

  return {
    draws:
      draws.length,

    distribution:
      dist,

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
      +avg.toFixed(3),

    weightedScore:
      +weighted.toFixed(3)
  };
}

function buildAdvancedGroup(
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
            a.id
          ) -
          Number(
            b.draw_id ??
            b.id
          )
      )
      .slice(
        0,
        COLLECTION_DRAWS
      );

  const dev =
    complete.slice(
      0,
      DEVELOPMENT_DRAWS
    );

  const valA =
    complete.slice(
      DEVELOPMENT_DRAWS,
      DEVELOPMENT_DRAWS +
      VALIDATION_BLOCK_DRAWS
    );

  const valB =
    complete.slice(
      DEVELOPMENT_DRAWS +
      VALIDATION_BLOCK_DRAWS,
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

      const strength =
        t.count * 2 +
        p.count;

      const old =
        pool.get(
          key
        );

      if (
        !old ||
        strength >
        old.componentStrength
      ) {
        pool.set(
          key,
          {
            numbers,

            triple:
              t.numbers,

            tripleCount:
              t.count,

            pair:
              p.numbers,

            pairCount:
              p.count,

            componentStrength:
              strength
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

  const ranked =
    [...pool.values()]
      .map(
        c => {

          const development =
            evaluate(
              dev,
              c.numbers
            );

          const validationA =
            evaluate(
              valA,
              c.numbers
            );

          const validationB =
            evaluate(
              valB,
              c.numbers
            );

          const worstValidationScore =
            Math.min(
              validationA
                .weightedScore,
              validationB
                .weightedScore
            );

          const totalValidationScore =
            validationA
              .weightedScore +
            validationB
              .weightedScore;

          return {
            ...c,

            development,
            validationA,
            validationB,

            validationFourPlus:
              validationA
                .fourPlus +
              validationB
                .fourPlus,

            validationThreePlus:
              validationA
                .threePlus +
              validationB
                .threePlus,

            worstValidationScore:
              +worstValidationScore
                .toFixed(3),

            totalValidationScore:
              +totalValidationScore
                .toFixed(3)
          };
        }
      );

  ranked.sort(
    (a, b) =>
      b.validationFourPlus -
      a.validationFourPlus

      ||

      b.worstValidationScore -
      a.worstValidationScore

      ||

      b.totalValidationScore -
      a.totalValidationScore

      ||

      b.validationThreePlus -
      a.validationThreePlus

      ||

      b.componentStrength -
      a.componentStrength

      ||

      b.development
        .weightedScore -
      a.development
        .weightedScore
  );

  return {
    ...ranked[0],

    candidateCount:
      ranked.length,

    method:
      '120 development + 30 validation A + 30 validation B'
  };
}


/* =========================================================
   DATABASE HELPERS
========================================================= */

async function getControl() {

  /*
    IMPORTANT:
    There can be other rows beginning with AUTO_CONTROL_,
    for example:
    AUTO_CONTROL_SPECIAL_ACTIVE_...

    Only the real daily control is valid here:
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
      `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id&name=eq.${encodeURIComponent(
        name
      )}&order=id.desc&limit=1`
    );

  return (
    rows?.[0] ||
    null
  );
}


async function createGroup(
  numbers,
  endId
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
            ADVANCED_NAME,

          numbers,

          active:
            true,

          start_draw_id:
            endId,

          last_seen_draw_id:
            endId
        }
      }
    );

  return (
    rows?.[0] ||
    null
  );
}


/* =========================================================
   INITIAL FUTURE-DRAW BACKFILL
========================================================= */

async function initialBackfill(
  group
) {
  if (
    !group
  ) {
    return 0;
  }

  const start =
    Number(
      group.start_draw_id
    );

  const latest =
    await db(
      'hotspot_draws?select=draw_id&order=draw_id.desc&limit=1'
    );

  const end =
    Math.min(
      Number(
        latest?.[0]?.draw_id ||
        start
      ),

      start +
      MAX_TRACKED_DRAWS
    );

  if (
    end <= start
  ) {
    return 0;
  }

  const draws =
    (
      await db(
        `hotspot_draws?select=draw_id,numbers,bulls_eye&draw_id=gt.${start}&draw_id=lte.${end}&order=draw_id.asc`
      )
    ) || [];

  const rows =
    draws.map(
      d => {

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

        return {
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
        };
      }
    );

  if (
    rows.length
  ) {
    await db(
      'tracker_results?on_conflict=group_id,draw_id',
      {
        method:
          'POST',

        prefer:
          'resolution=merge-duplicates,return=minimal',

        body:
          rows
      }
    );
  }

  const last =
    draws.at(-1)
      ?.draw_id ??
    start;

  await db(
    `tracker_groups?id=eq.${group.id}`,
    {
      method:
        'PATCH',

      prefer:
        'return=minimal',

      body: {
        last_seen_draw_id:
          last
      }
    }
  );

  return (
    draws.length
  );
}


/* =========================================================
   MAIN ADVANCED ENGINE
========================================================= */

async function runAdvanced() {

  const existing =
    await getGroup(
      ADVANCED_NAME
    );

  if (
    existing?.active
  ) {
    return {
      ok:
        true,

      created:
        false,

      reason:
        'already-active',

      group:
        existing
    };
  }

  const control =
    await getControl();

  if (
    !control
  ) {
    return {
      ok:
        true,

      created:
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

      created:
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

      created:
        false,

      reason:
        'base-groups-not-ready'
    };
  }

  const special =
    await getGroup(
      SPECIAL_NAME
    );

  const excluded =
    [
      group1.numbers,
      group2.numbers
    ];

  if (
    special?.numbers
  ) {
    excluded.push(
      special.numbers
    );
  }

  const selected =
    buildAdvancedGroup(
      history,
      excluded
    );

  if (
    !selected
      ?.numbers
      ?.length
  ) {
    return {
      ok:
        false,

      created:
        false,

      reason:
        'no-advanced-candidate'
    };
  }

  const endId =
    Number(
      history.at(-1)
        .draw_id
    );

  const group =
    await createGroup(
      selected.numbers,
      endId
    );

  const backfilled =
    await initialBackfill(
      group
    );

  return {
    ok:
      true,

    created:
      true,

    group,

    backfilled,

    selected
  };
}


module.exports = {
  runAdvanced,
  buildAdvancedGroup,
  ADVANCED_NAME
};
