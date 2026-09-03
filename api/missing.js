const {
  db,
  parseDrawMinutes
} = require('./lib');

const COLLECTION_DRAWS = 180;
const CONTROL_PREFIX = 'AUTO_CONTROL_';

function drawDateKey(dateText) {
  const d =
    new Date(
      String(dateText || '') +
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

function inCollectionWindow(
  d,
  collectionDateKey
) {
  const m =
    parseDrawMinutes(
      d.draw_time ??
      d.time
    );

  return (
    drawDateKey(
      d.draw_date ??
      d.date
    ) === collectionDateKey &&
    m != null &&
    m >= 360 &&
    m < 1080
  );
}

module.exports =
async (
  req,
  res
) => {

  res.setHeader(
    'Cache-Control',
    'no-store,max-age=0'
  );

  try {

    const controls =
      (await db(
        `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id&name=like.${encodeURIComponent(
          CONTROL_PREFIX + '*'
        )}&order=id.desc&limit=1`
      )) || [];

    const control =
      controls[0] ||
      null;

    if (!control) {

      return res
        .status(200)
        .json({
          ok: true,
          control: null,
          missingDrawIds: []
        });
    }

    const collectionDateKey =
      String(
        control.name || ''
      ).replace(
        CONTROL_PREFIX,
        ''
      );

    const startId =
      Number(
        control.start_draw_id
      );

    const endId =
      startId +
      COLLECTION_DRAWS -
      1;

    const rows =
      (await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=gte.${startId}&draw_id=lte.${endId}&order=draw_id.asc`
      )) || [];

    const validRows =
      rows.filter(
        d =>
          inCollectionWindow(
            d,
            collectionDateKey
          )
      );

    const have =
      new Set(
        validRows.map(
          d =>
            Number(
              d.draw_id
            )
        )
      );

    const expected =
      Array.from(
        {
          length:
            COLLECTION_DRAWS
        },
        (_, i) =>
          startId + i
      );

    const missingDrawIds =
      expected.filter(
        id =>
          !have.has(id)
      );

    const invalidRows =
      rows
        .filter(
          d =>
            !inCollectionWindow(
              d,
              collectionDateKey
            )
        )
        .map(
          d => ({
            draw_id:
              d.draw_id,

            draw_date:
              d.draw_date,

            draw_time:
              d.draw_time
          })
        );

    return res
      .status(200)
      .json({

        ok: true,

        control: {
          name:
            control.name,

          startDrawId:
            startId,

          endDrawId:
            endId,

          lastSeenDrawId:
            control.last_seen_draw_id
        },

        collectionDateKey,

        storedInExpectedRange:
          rows.length,

        validCollectionRows:
          validRows.length,

        missingDrawIds,

        invalidRows
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
