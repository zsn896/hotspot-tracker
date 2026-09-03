const { getDraw, getMany, db, score } = require('./lib');

const MANUAL_NAME = 'MANUAL Group';
const MAX_BACKFILL = 80;

async function store(d) {
  await db(
    'hotspot_draws?on_conflict=draw_id',
    {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
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

async function getManual() {
  const rows = await db(
    `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=eq.${encodeURIComponent(
      MANUAL_NAME
    )}&order=id.desc&limit=1`
  );

  return rows?.[0] || null;
}

function validateNumbers(input) {
  const nums = (Array.isArray(input) ? input : []).map(Number);

  if (nums.length !== 5) {
    throw Error('Enter exactly 5 numbers.');
  }

  if (
    nums.some(
      n =>
        !Number.isInteger(n) ||
        n < 1 ||
        n > 80
    )
  ) {
    throw Error('Each number must be from 1 to 80.');
  }

  if (new Set(nums).size !== 5) {
    throw Error('The 5 numbers must be different.');
  }

  return [...nums].sort((a, b) => a - b);
}

async function backfillManual(g) {
  const latest = await getDraw(null);

  await store(latest);

  const after = Number(
    g.last_seen_draw_id ??
    g.start_draw_id
  );

  if (after >= latest.id) {
    return {
      latest,
      processed: 0
    };
  }

  const end = Math.min(
    latest.id,
    after + MAX_BACKFILL
  );

  const ids = Array.from(
    { length: end - after },
    (_, i) => after + i + 1
  );

  const draws = await getMany(ids);

  for (const d of draws) {
    await store(d);

    const s = score(
      d,
      g.numbers
    );

    if (s.count >= 3) {
      await db(
        'tracker_results?on_conflict=group_id,draw_id',
        {
          method: 'POST',
          prefer: 'resolution=merge-duplicates,return=minimal',
          body: {
            group_id: g.id,
            draw_id: d.id,
            hit_count: s.count,
            hit_numbers: s.hit,
            bulls_eye: s.bullsEye,
            bulls_eye_match: s.bullsEyeMatch
          }
        }
      );
    }
  }

  const last =
    draws.at(-1)?.id ??
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

  g.last_seen_draw_id = last;

  return {
    latest,
    processed: draws.length
  };
}

async function readManual(g) {
  let rows =
    (await db(
      `tracker_results?select=draw_id,hit_count,hit_numbers,bulls_eye,bulls_eye_match,created_at&group_id=eq.${g.id}&hit_count=gte.3&order=draw_id.desc&limit=100`
    )) || [];

  const ids = rows.map(
    r => r.draw_id
  );

  let meta = {};

  if (ids.length) {
    const ds =
      (await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=in.(${ids.join(',')})`
      )) || [];

    meta =
      Object.fromEntries(
        ds.map(
          d => [
            d.draw_id,
            d
          ]
        )
      );
  }

  rows = rows.map(
    r => ({
      ...r,

      date:
        meta[r.draw_id]
          ?.draw_date ||
        '',

      time:
        meta[r.draw_id]
          ?.draw_time ||
        ''
    })
  );

  return {
    id: g.id,
    numbers: g.numbers,
    startDrawId: g.start_draw_id,
    lastSeenDrawId: g.last_seen_draw_id,
    createdAt: g.created_at,
    matches: rows
  };
}

module.exports = async (req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );

  try {
    if (req.method === 'POST') {
      const numbers = validateNumbers(
        req.body?.numbers
      );

      const latest = await getDraw(null);

      await store(latest);

      const old = await getManual();

      let group;

      if (old) {
        await db(
          `tracker_results?group_id=eq.${old.id}`,
          {
            method: 'DELETE',
            prefer: 'return=minimal'
          }
        );

        await db(
          `tracker_groups?id=eq.${old.id}`,
          {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: {
              numbers,
              active: true,
              start_draw_id: latest.id,
              last_seen_draw_id: latest.id
            }
          }
        );

        group = {
          ...old,
          numbers,
          active: true,
          start_draw_id: latest.id,
          last_seen_draw_id: latest.id
        };

      } else {
        const created = await db(
          'tracker_groups',
          {
            method: 'POST',
            prefer: 'return=representation',
            body: {
              name: MANUAL_NAME,
              numbers,
              active: true,
              start_draw_id: latest.id,
              last_seen_draw_id: latest.id
            }
          }
        );

        group = created?.[0];
      }

      return res
        .status(200)
        .json({
          ok: true,
          message:
            'Manual tracking started. Only future draws will be counted.',
          manual: await readManual(group),
          latest: {
            id: latest.id,
            date: latest.date,
            time: latest.time
          }
        });
    }

    if (req.method !== 'GET') {
      return res
        .status(405)
        .json({
          ok: false,
          error: 'Method not allowed'
        });
    }

    const group = await getManual();

    if (
      !group ||
      !group.active
    ) {
      return res
        .status(200)
        .json({
          ok: true,
          manual: null
        });
    }

    const sync = await backfillManual(group);

    return res
      .status(200)
      .json({
        ok: true,
        manual: await readManual(group),
        processed: sync.processed,
        latest: {
          id: sync.latest.id,
          date: sync.latest.date,
          time: sync.latest.time
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
