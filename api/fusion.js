'use strict';

const { getDraw, getMany, db, score } = require('./lib');

const SOURCE_NAMES = ['MANUAL Group', 'MANUAL Group 2'];
const GROUP_NAME = 'MANUAL Group 3';
const MAX_BACKFILL = 80;
const MAX_ANALYSIS_DRAWS = 500;

const nums = v => Array.isArray(v) ? v.map(Number) : [];

function sameNumbers(a, b) {
  const x = nums(a).sort((m,n)=>m-n);
  const y = nums(b).sort((m,n)=>m-n);

  return (
    x.length === 5 &&
    y.length === 5 &&
    x.every((n,i)=>n===y[i])
  );
}

async function storeDraw(d) {
  if (!d?.id) return;

  await db(
    'hotspot_draws?on_conflict=draw_id',
    {
      method: 'POST',
      prefer:
        'resolution=merge-duplicates,return=minimal',
      body: {
        draw_id: d.id,
        draw_date: d.date,
        draw_time: d.time,
        numbers: d.numbers,
        bulls_eye: d.bullsEye
      }
    }
  );
}

async function getByName(name) {
  const rows = await db(
    `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=eq.${encodeURIComponent(name)}&order=id.desc&limit=1`
  );

  return rows?.[0] || null;
}

const getFusion = () =>
  getByName(GROUP_NAME);

async function safeDraw(id, map) {
  if (map.has(Number(id))) {
    return map.get(Number(id));
  }

  try {
    const d = await getDraw(Number(id));

    return Number(d?.id) === Number(id)
      ? d
      : null;
  } catch {
    return null;
  }
}

async function backfill(
  group,
  suppliedLatest = null
) {
  if (!group?.active) {
    return {
      processed: 0,
      latest: suppliedLatest,
      stoppedAtMissing: null
    };
  }

  const latest =
    suppliedLatest ||
    await getDraw(null);

  await storeDraw(latest);

  const after = Number(
    group.last_seen_draw_id ??
    group.start_draw_id ??
    latest.id
  );

  if (
    !Number.isFinite(after) ||
    after >= Number(latest.id)
  ) {
    return {
      processed: 0,
      latest,
      stoppedAtMissing: null
    };
  }

  const end = Math.min(
    Number(latest.id),
    after + MAX_BACKFILL
  );

  const ids = Array.from(
    {
      length:
        end - after
    },
    (_,i) =>
      after + i + 1
  );

  let batch = [];

  try {
    batch =
      (await getMany(ids)) ||
      [];
  } catch {}

  const map = new Map(
    batch
      .filter(d => d?.id)
      .map(
        d => [
          Number(d.id),
          d
        ]
      )
  );

  let processed = 0;
  let last = after;
  let stoppedAtMissing = null;

  for (const id of ids) {
    const d =
      await safeDraw(
        id,
        map
      );

    if (!d) {
      stoppedAtMissing = id;
      break;
    }

    await storeDraw(d);

    const r =
      score(
        d,
        group.numbers
      );

    if (
      Number(
        r?.count || 0
      ) >= 3
    ) {
      await db(
        'tracker_results?on_conflict=group_id,draw_id',
        {
          method: 'POST',
          prefer:
            'resolution=merge-duplicates,return=minimal',
          body: {
            group_id:
              group.id,

            draw_id:
              d.id,

            hit_count:
              r.count,

            hit_numbers:
              r.hit,

            bulls_eye:
              r.bullsEye,

            bulls_eye_match:
              r.bullsEyeMatch
          }
        }
      );
    }

    last = Number(d.id);
    processed++;
  }

  if (last > after) {
    await db(
      `tracker_groups?id=eq.${group.id}`,
      {
        method: 'PATCH',
        prefer:
          'return=minimal',
        body: {
          last_seen_draw_id:
            last
        }
      }
    );

    group.last_seen_draw_id =
      last;
  }

  return {
    processed,
    latest,
    lastProcessed: last,
    stoppedAtMissing
  };
}

async function attachMeta(rows) {
  rows =
    Array.isArray(rows)
      ? rows
      : [];

  if (!rows.length) {
    return [];
  }

  const ids = [
    ...new Set(
      rows
        .map(
          r =>
            Number(r.draw_id)
        )
        .filter(
          Number.isFinite
        )
    )
  ];

  if (!ids.length) {
    return rows;
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
        d => [
          Number(d.draw_id),
          d
        ]
      )
    );

  return rows.map(
    r => ({
      ...r,

      date:
        meta[
          Number(r.draw_id)
        ]?.draw_date || '',

      time:
        meta[
          Number(r.draw_id)
        ]?.draw_time || ''
    })
  );
}

async function readFusion(group) {
  if (!group) {
    return null;
  }

  const rows =
    (
      await db(
        `tracker_results?select=draw_id,hit_count,hit_numbers,bulls_eye,bulls_eye_match,created_at&group_id=eq.${group.id}&hit_count=gte.3&order=draw_id.desc&limit=100`
      )
    ) || [];

  const withMeta =
    await attachMeta(rows);

  const last =
    withMeta[0] ||
    null;

  return {
    id:
      group.id,

    slot:
      3,

    name:
      group.name,

    generated:
      true,

    numbers:
      nums(group.numbers),

    active:
      Boolean(group.active),

    startDrawId:
      group.start_draw_id,

    trackingLastSeenDrawId:
      group.last_seen_draw_id,

    lastSeenDrawId:
      last?.draw_id ??
      null,

    lastSeenResult:
      last
        ? {
            drawId:
              last.draw_id,

            hitCount:
              Number(
                last.hit_count || 0
              ),

            hitNumbers:
              nums(
                last.hit_numbers
              ),

            date:
              last.date || '',

            time:
              last.time || '',

            bullsEye:
              last.bulls_eye,

            bullsEyeMatch:
              Boolean(
                last.bulls_eye_match
              )
          }
        : null,

    matches:
      withMeta,

    createdAt:
      group.created_at
  };
}

function combos5(v) {
  const out = [];

  for (
    let a = 0;
    a < v.length - 4;
    a++
  )
    for (
      let b = a + 1;
      b < v.length - 3;
      b++
    )
      for (
        let c = b + 1;
        c < v.length - 2;
        c++
      )
        for (
          let d = c + 1;
          d < v.length - 1;
          d++
        )
          for (
            let e = d + 1;
            e < v.length;
            e++
          )
            out.push([
              v[a],
              v[b],
              v[c],
              v[d],
              v[e]
            ]);

  return out;
}

function hitCount(
  drawNumbers,
  combo
) {
  const s =
    new Set(
      nums(drawNumbers)
    );

  return combo.reduce(
    (n,x) =>
      n +
      (
        s.has(Number(x))
          ? 1
          : 0
      ),
    0
  );
}

function coverage(
  combo,
  g1,
  g2
) {
  const a =
    new Set(nums(g1));

  const b =
    new Set(nums(g2));

  return {
    from1:
      combo.filter(
        n =>
          a.has(Number(n))
      ).length,

    from2:
      combo.filter(
        n =>
          b.has(Number(n))
      ).length
  };
}

function evaluate(
  combo,
  draws,
  g1,
  g2
) {
  let exact5 = 0;
  let fourPlus = 0;
  let threePlus = 0;
  let totalHits = 0;
  let recentStrong = 0;

  const recentStart =
    Math.max(
      0,
      draws.length - 40
    );

  draws.forEach(
    (d,i) => {
      const h =
        hitCount(
          d.numbers,
          combo
        );

      totalHits += h;

      if (h >= 3) {
        threePlus++;
      }

      if (h >= 4) {
        fourPlus++;
      }

      if (h >= 5) {
        exact5++;
      }

      if (
        i >= recentStart
      ) {
        if (h === 3) {
          recentStrong += 4;
        } else if (h === 4) {
          recentStrong += 20;
        } else if (h >= 5) {
          recentStrong += 100;
        }
      }
    }
  );

  const c =
    coverage(
      combo,
      g1,
      g2
    );

  const balance =
    Math.min(
      c.from1,
      c.from2
    );

  return {
    numbers:
      combo,

    exact5,

    fourPlus,

    threePlus,

    recentStrong,

    totalHits,

    fromGroup1:
      c.from1,

    fromGroup2:
      c.from2,

    balance
  };
}

function rank(a,b) {
  return (
    b.exact5 -
      a.exact5
    ||
    b.fourPlus -
      a.fourPlus
    ||
    b.threePlus -
      a.threePlus
    ||
    b.recentStrong -
      a.recentStrong
    ||
    b.balance -
      a.balance
    ||
    b.totalHits -
      a.totalHits
    ||
    a.numbers
      .join(',')
      .localeCompare(
        b.numbers.join(',')
      )
  );
}

async function selectFusion() {
  const [g1,g2] =
    await Promise.all(
      SOURCE_NAMES.map(
        getByName
      )
    );

  if (!g1 || !g2) {
    throw new Error(
      'Manual Group 1 and Manual Group 2 are required first.'
    );
  }

  const n1 =
    nums(g1.numbers);

  const n2 =
    nums(g2.numbers);

  if (
    n1.length !== 5 ||
    n2.length !== 5
  ) {
    throw new Error(
      'Groups 1 and 2 must each contain exactly 5 numbers.'
    );
  }

  const candidates = [
    ...new Set([
      ...n1,
      ...n2
    ])
  ].sort(
    (a,b) =>
      a - b
  );

  if (
    candidates.length < 5
  ) {
    throw new Error(
      'Not enough unique source numbers.'
    );
  }

  const latest =
    await getDraw(null);

  await storeDraw(latest);

  const start =
    Math.max(
      Number(
        g1.start_draw_id || 0
      ),
      Number(
        g2.start_draw_id || 0
      )
    );

  const end =
    Math.min(
      Number(
        g1.last_seen_draw_id ||
        latest.id
      ),
      Number(
        g2.last_seen_draw_id ||
        latest.id
      ),
      Number(latest.id)
    );

  if (
    !Number.isFinite(start)
    ||
    !Number.isFinite(end)
    ||
    end <= start
  ) {
    throw new Error(
      'Not enough shared tracked history yet.'
    );
  }

  const fromId =
    Math.max(
      start + 1,
      end -
      MAX_ANALYSIS_DRAWS +
      1
    );

  const rows =
    (
      await db(
        `hotspot_draws?select=draw_id,numbers,bulls_eye,draw_date,draw_time&draw_id=gte.${fromId}&draw_id=lte.${end}&order=draw_id.asc&limit=${MAX_ANALYSIS_DRAWS}`
      )
    ) || [];

  const draws =
    rows
      .filter(
        r =>
          Array.isArray(
            r.numbers
          )
      )
      .map(
        r => ({
          id:
            Number(
              r.draw_id
            ),

          numbers:
            nums(
              r.numbers
            )
        })
      );

  if (
    draws.length < 10
  ) {
    throw new Error(
      'Need at least 10 shared historical draws before generating Group 3.'
    );
  }

  let all =
    combos5(
      candidates
    );

  const balanced =
    all.filter(
      c => {
        const x =
          coverage(
            c,
            n1,
            n2
          );

        return (
          x.from1 >= 2
          &&
          x.from2 >= 2
        );
      }
    );

  if (
    balanced.length
  ) {
    all = balanced;
  }

  const ranked =
    all
      .map(
        c =>
          evaluate(
            c,
            draws,
            n1,
            n2
          )
      )
      .sort(rank);

  const best =
    ranked[0];

  if (!best) {
    throw new Error(
      'Unable to generate Group 3.'
    );
  }

  return {
    latest,

    best,

    combinationsTested:
      ranked.length,

    analyzedDraws:
      draws.length,

    analyzedFromDrawId:
      draws[0]?.id,

    analyzedToDrawId:
      draws[
        draws.length - 1
      ]?.id
  };
}

async function generate() {
  const s =
    await selectFusion();

  const selected =
    nums(
      s.best.numbers
    ).sort(
      (a,b) =>
        a - b
    );

  const old =
    await getFusion();

  if (
    old?.active
    &&
    sameNumbers(
      old.numbers,
      selected
    )
  ) {
    const sync =
      await backfill(
        old,
        s.latest
      );

    return {
      ok:
        true,

      unchanged:
        true,

      message:
        'The same Fusion numbers are still ranked first. Existing tracking was preserved.',

      selection: {
        ...s.best,

        combinationsTested:
          s.combinationsTested,

        analyzedDraws:
          s.analyzedDraws,

        analyzedFromDrawId:
          s.analyzedFromDrawId,

        analyzedToDrawId:
          s.analyzedToDrawId
      },

      manual:
        await readFusion(
          old
        ),

      processed:
        sync.processed,

      latest: {
        id:
          s.latest.id,

        date:
          s.latest.date,

        time:
          s.latest.time
      }
    };
  }

  if (old) {
    await db(
      `tracker_results?group_id=eq.${old.id}`,
      {
        method:
          'DELETE',

        prefer:
          'return=minimal'
      }
    );

    await db(
      `tracker_groups?id=eq.${old.id}`,
      {
        method:
          'PATCH',

        prefer:
          'return=minimal',

        body: {
          numbers:
            selected,

          active:
            true,

          start_draw_id:
            s.latest.id,

          last_seen_draw_id:
            s.latest.id
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
            GROUP_NAME,

          numbers:
            selected,

          active:
            true,

          start_draw_id:
            s.latest.id,

          last_seen_draw_id:
            s.latest.id
        }
      }
    );
  }

  const current =
    await getFusion();

  return {
    ok:
      true,

    unchanged:
      false,

    message:
      'Fusion Group 3 generated and tracking started from future draws only.',

    selection: {
      ...s.best,

      combinationsTested:
        s.combinationsTested,

      analyzedDraws:
        s.analyzedDraws,

      analyzedFromDrawId:
        s.analyzedFromDrawId,

      analyzedToDrawId:
        s.analyzedToDrawId
    },

    manual:
      await readFusion(
        current
      ),

    latest: {
      id:
        s.latest.id,

      date:
        s.latest.date,

      time:
        s.latest.time
    }
  };
}

async function stop() {
  const g =
    await getFusion();

  if (!g) {
    return {
      ok:
        true,

      message:
        'Manual Group 3 does not exist yet.',

      manual:
        null
    };
  }

  let latest =
    null;

  let processed =
    0;

  if (g.active) {
    latest =
      await getDraw(null);

    await storeDraw(
      latest
    );

    processed =
      (
        await backfill(
          g,
          latest
        )
      ).processed;

    await db(
      `tracker_groups?id=eq.${g.id}`,
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

  return {
    ok:
      true,

    message:
      'Manual Group 3 tracking stopped. Existing results were kept.',

    manual:
      await readFusion(
        await getFusion()
      ),

    processed,

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

async function clear() {
  const g =
    await getFusion();

  if (g) {
    await db(
      `tracker_results?group_id=eq.${g.id}`,
      {
        method:
          'DELETE',

        prefer:
          'return=minimal'
      }
    );

    await db(
      `tracker_groups?id=eq.${g.id}`,
      {
        method:
          'DELETE',

        prefer:
          'return=minimal'
      }
    );
  }

  return {
    ok:
      true,

    message:
      'Manual Group 3 cleared.',

    manual:
      null
  };
}

async function state() {
  const g =
    await getFusion();

  let latest =
    null;

  let processed =
    0;

  let stoppedAtMissing =
    null;

  if (g?.active) {
    latest =
      await getDraw(null);

    await storeDraw(
      latest
    );

    const sync =
      await backfill(
        g,
        latest
      );

    processed =
      sync.processed;

    stoppedAtMissing =
      sync.stoppedAtMissing;
  }

  return {
    ok:
      true,

    manual:
      await readFusion(
        await getFusion()
      ),

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
      req.method === 'GET'
    ) {
      return res
        .status(200)
        .json(
          await state()
        );
    }

    if (
      req.method === 'POST'
    ) {
      const action =
        String(
          req.body?.action ||
          'generate'
        )
          .trim()
          .toLowerCase();

      if (
        action === 'generate'
      ) {
        return res
          .status(200)
          .json(
            await generate()
          );
      }

      if (
        action === 'stop'
      ) {
        return res
          .status(200)
          .json(
            await stop()
          );
      }

      if (
        action === 'clear'
      ) {
        return res
          .status(200)
          .json(
            await clear()
          );
      }

      return res
        .status(400)
        .json({
          ok:
            false,

          error:
            'Unknown Fusion Group action.'
        });
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
      'Fusion Group API error:',
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
