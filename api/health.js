'use strict';

const {
  db,
  californiaNowParts,
  cycleDateKey,
  scheduleMode
} = require('./lib');

const {
  runDailyPatternLearner
} = require('./group-six');

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

function drawHas(draw, number) {
  return norm(draw?.numbers)
    .includes(Number(number));
}

async function learnerWaveDetail() {
  const learner =
    await runDailyPatternLearner();

  const numbers =
    norm(
      learner?.suggestion?.numbers || []
    );

  if (
    !learner?.ok ||
    !learner?.active ||
    numbers.length !== 5 ||
    !Number(
      learner?.controlStartDrawId
    )
  ) {
    return {
      ok: true,
      active: false,
      numbers,
      have:
        Number(learner?.have || 0),
      state:
        learner?.wave?.state || null,
      message:
        'Learner wave details are not ready yet.'
    };
  }

  const rows =
    (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers&draw_id=gte.${Number(
          learner.controlStartDrawId
        )}&order=draw_id.asc&limit=500`
      )
    ) || [];

  const draws = rows
    .filter(
      d =>
        Number.isFinite(
          Number(d?.draw_id)
        ) &&
        norm(d?.numbers).length === 20
    )
    .slice(
      0,
      Number(learner.have || 0)
    );

  const latest =
    draws.at(-1) || null;

  const recent40 =
    draws.slice(-40);

  const numberStats =
    numbers.map(number => {
      const appearances =
        draws.filter(
          d =>
            drawHas(d, number)
        );

      const recentAppearances =
        recent40.filter(
          d =>
            drawHas(d, number)
        );

      const last =
        appearances.at(-1) || null;

      const lastIndex =
        last
          ? draws.findLastIndex(
              d =>
                Number(d.draw_id) ===
                Number(last.draw_id)
            )
          : -1;

      return {
        number,
        count:
          appearances.length,
        recent40:
          recentAppearances.length,
        lastDrawId:
          last
            ? Number(last.draw_id)
            : null,
        lastTime:
          last?.draw_time || '',
        lastDate:
          last?.draw_date || '',
        drawsSinceLast:
          lastIndex >= 0
            ? Math.max(
                0,
                draws.length -
                1 -
                lastIndex
              )
            : null
      };
    });

  const last20 =
    learner?.wave?.metrics?.last20 || {};

  const last10 =
    learner?.wave?.metrics?.last10 || {};

  return {
    ok: true,
    active: true,
    have:
      Number(
        learner.have ||
        draws.length
      ),
    latestDrawId:
      latest
        ? Number(latest.draw_id)
        : null,
    latestTime:
      latest?.draw_time || '',
    numbers,
    wave: {
      state:
        learner?.wave?.state ||
        'DORMANT',
      stateAr:
        learner?.wave?.stateAr || '',
      score:
        Number(
          learner?.wave?.score || 0
        ),
      alertLevel:
        learner?.wave?.alertLevel ||
        'NONE'
    },
    numberStats,
    comparison: {
      last10: {
        draws:
          Number(last10.draws || 0),
        threePlus:
          Number(last10.threePlus || 0),
        fourPlus:
          Number(last10.fourPlus || 0),
        exact5:
          Number(last10.exact5 || 0)
      },
      last20: {
        draws:
          Number(last20.draws || 0),
        threePlus:
          Number(last20.threePlus || 0),
        fourPlus:
          Number(last20.fourPlus || 0),
        exact5:
          Number(last20.exact5 || 0)
      }
    },
    compact: true
  };
}

module.exports = async (req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );

  try {
    const mode =
      String(
        req.query?.mode || ''
      )
        .trim()
        .toLowerCase();

    if (
      mode ===
      'learner-wave-detail'
    ) {
      const detail =
        await learnerWaveDetail();

      return res
        .status(200)
        .json(detail);
    }

    const now =
      californiaNowParts();

    return res.status(200).json({
      ok: true,

      version:
        require('../package.json')
          .version,

      californiaTime:
        `${String(now.hour).padStart(2, '0')}:` +
        `${String(now.minute).padStart(2, '0')}`,

      cycle:
        cycleDateKey(now),

      mode:
        scheduleMode(
          now.minutes
        ),

      configured: {
        supabaseUrl:
          Boolean(
            process.env.SUPABASE_URL
          ),

        supabaseKey:
          Boolean(
            process.env
              .SUPABASE_SERVICE_ROLE_KEY
          ),

        workerSecret:
          Boolean(
            process.env.WORKER_SECRET
          )
      },

      collectionDraws: 180,

      source:
        'California Lottery official'
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
