const {
  db,
  statsForGroup,
  californiaNowParts,
  scheduleMode,
  parseDrawMinutes
} = require('./lib');

const COLLECTION_DRAWS = 180;
const CONTROL_PREFIX = 'AUTO_CONTROL_';
const AUTO_PREFIX = 'AUTO Group ';


/* =========================================================
   DATE
========================================================= */

function drawDateKey(dateText) {

  const d =
    new Date(
      String(
        dateText || ''
      ) +
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


/* =========================================================
   REPORT BLOCK
========================================================= */

function reportBlock(
  rows,
  block
) {

  const part =
    rows.slice(
      (block - 1) * 20,
      block * 20
    );

  if (
    part.length < 20
  ) {
    return null;
  }

  const hist =
    [0, 0, 0, 0, 0, 0];

  for (
    const r of part
  ) {
    hist[r.hit_count]++;
  }

  const best =
    Math.max(
      ...part.map(
        r =>
          r.hit_count
      )
    );

  return {

    block,

    fromDrawId:
      part[0].draw_id,

    toDrawId:
      part.at(-1).draw_id,

    fromTime:
      part[0].time,

    toTime:
      part.at(-1).time,

    bestHit:
      best,

    exact5:
      hist[5],

    fourPlus:
      hist[4] +
      hist[5],

    threePlus:
      hist[3] +
      hist[4] +
      hist[5],

    averageHits:
      +(
        part.reduce(
          (
            s,
            r
          ) =>
            s +
            r.hit_count,
          0
        ) / 20
      ).toFixed(2),

    bullsEyeMatches:
      part.filter(
        r =>
          r.bulls_eye_match
      ).length,

    distribution: {

      zero:
        hist[0],

      one:
        hist[1],

      two:
        hist[2],

      three:
        hist[3],

      four:
        hist[4],

      five:
        hist[5]
    }
  };
}


/* =========================================================
   FORECAST CHECK
========================================================= */

function addTimingCheck(
  analysis,
  rows
) {

  if (
    !analysis
      ?.expectedFromDrawId
    ||
    !analysis
      ?.expectedToDrawId
  ) {
    return 'Not available';
  }

  const exact =
    rows.find(
      r =>
        r.hit_count === 5
        &&
        r.draw_id >=
          analysis
            .expectedFromDrawId
        &&
        r.draw_id <=
          analysis
            .expectedToDrawId
    );

  if (
    exact
  ) {

    return (
      `Hit at draw ` +
      `${exact.draw_id}`
    );
  }

  const last =
    rows.at(-1)
      ?.draw_id;

  if (
    !last
    ||
    last <
      analysis
        .expectedFromDrawId
  ) {

    return 'Pending';
  }

  if (
    last >
      analysis
        .expectedToDrawId
  ) {

    return (
      'Window passed ' +
      'without 5/5'
    );
  }

  return (
    'Inside expected window'
  );
}


/* =========================================================
   STATE
========================================================= */

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

    const now =
      californiaNowParts();


    /* =====================================================
       DAILY CONTROL

       IMPORTANT FIX:

       We read recent AUTO_CONTROL_* rows,
       but accept ONLY the real daily control:

       AUTO_CONTROL_YYYY-MM-DD

       We ignore markers such as:

       AUTO_CONTROL_SPECIAL_ACTIVE_...
       AUTO_CONTROL_SPECIAL_ACTIVE_V2_...
       and any future AUTO_CONTROL marker.
    ===================================================== */

    const ctr =
      await db(
        `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id,created_at&name=like.${encodeURIComponent(
          CONTROL_PREFIX + '*'
        )}&order=id.desc&limit=20`
      );


    const control =
      (
        ctr || []
      ).find(
        r =>
          /^AUTO_CONTROL_\d{4}-\d{2}-\d{2}$/.test(
            String(
              r.name || ''
            )
          )
      )
      ||
      null;


    /* =====================================================
       COLLECTION HISTORY
    ===================================================== */

    let history =
      [];


    if (
      control
    ) {

      const rawHistory =
        (
          await db(
            `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&draw_id=gte.${control.start_draw_id}&order=draw_id.asc&limit=220`
          )
        )
        ||
        [];


      /*
        Keep the original
        collection date even
        after midnight.
      */

      let cycleDateKey =
        now.dateKey;


      const firstCollectionDraw =
        rawHistory.find(
          d => {

            const m =
              parseDrawMinutes(
                d.draw_time ??
                d.time
              );

            return (
              m != null
              &&
              m >= 360
              &&
              m <= 1080
            );
          }
        );


      if (
        firstCollectionDraw
      ) {

        cycleDateKey =
          drawDateKey(
            firstCollectionDraw
              .draw_date
            ??
            firstCollectionDraw
              .date
          )
          ||
          cycleDateKey;
      }


      history =
        rawHistory.filter(
          d => {

            const m =
              parseDrawMinutes(
                d.draw_time ??
                d.time
              );


            const dKey =
              drawDateKey(
                d.draw_date ??
                d.date
              );


            /*
              Collection:
              6:00 AM through
              6:00 PM inclusive.
            */

            return (
              dKey ===
                cycleDateKey
              &&
              m != null
              &&
              m >= 360
              &&
              m <= 1080
            );
          }
        );
    }


    /* =====================================================
       ACTIVE AUTOMATIC GROUPS
    ===================================================== */

    const groups =
      (
        await db(
          `tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&active=eq.true&name=like.${encodeURIComponent(
            AUTO_PREFIX + '*'
          )}&order=id.asc`
        )
      )
      ||
      [];


    const raw =
      [];


    /* =====================================================
       GROUP RESULTS
    ===================================================== */

    for (
      const g of groups
    ) {

      let rows =
        (
          await db(
            `tracker_results?select=draw_id,hit_count,hit_numbers,bulls_eye,bulls_eye_match,created_at&group_id=eq.${g.id}&order=draw_id.asc&limit=200`
          )
        )
        ||
        [];


      const ids =
        rows.map(
          r =>
            r.draw_id
        );


      let meta =
        {};


      if (
        ids.length
      ) {

        const ds =
          await db(
            `hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=in.(${ids.join(
              ','
            )})`
          );


        meta =
          Object.fromEntries(
            (
              ds || []
            ).map(
              d => [
                d.draw_id,
                d
              ]
            )
          );
      }


      rows =
        rows.map(
          r => ({

            ...r,

            date:
              meta[
                r.draw_id
              ]?.draw_date
              ||
              '',

            time:
              meta[
                r.draw_id
              ]?.draw_time
              ||
              ''
          })
        );


      const analysis =
        history.length
          ?
          statsForGroup(
            history,
            g.numbers
          )
          :
          null;


      raw.push({

        ...g,

        analysis,

        results:
          rows
      });
    }


    /* =====================================================
       STABILITY COMPARISON

       Original behavior preserved.
    ===================================================== */

    if (
      raw.length === 2
      &&
      raw[0].analysis
      &&
      raw[1].analysis
    ) {

      const a =
        raw[0]
          .analysis
          .coefficientVariation
        ??
        999;


      const b =
        raw[1]
          .analysis
          .coefficientVariation
        ??
        999;


      if (
        Math.abs(
          a - b
        ) < 0.03
      ) {

        raw[0]
          .analysis
          .stability =
          'Similar Stability';


        raw[1]
          .analysis
          .stability =
          'Similar Stability';

      } else if (
        a < b
      ) {

        raw[0]
          .analysis
          .stability =
          'More Stable';


        raw[1]
          .analysis
          .stability =
          'Less Stable';

      } else {

        raw[0]
          .analysis
          .stability =
          'Less Stable';


        raw[1]
          .analysis
          .stability =
          'More Stable';
      }
    }


    /* =====================================================
       BLOCK REPORTS
    ===================================================== */

    for (
      const g of raw
    ) {

      const completed =
        Math.floor(
          g.results.length /
          20
        );


      g.reports =
        [];


      for (
        let b = 1;
        b <= completed;
        b++
      ) {

        const r =
          reportBlock(
            g.results,
            b
          );


        if (
          r
        ) {

          g.reports.push(
            r
          );
        }
      }


      g.currentBlock = {

        number:
          Math.min(
            6,
            completed + 1
          ),

        have:
          g.results.length %
          20,

        need:
          20,

        remaining:
          g.results.length >=
          120
            ?
            0
            :
            20 -
            (
              g.results.length %
              20
            )
      };


      if (
        g.analysis
      ) {

        g.analysis
          .forecastCheck =
          addTimingCheck(
            g.analysis,
            g.results
          );
      }
    }


    /* =====================================================
       LATEST STORED DRAW
    ===================================================== */

    const latest =
      await db(
        'hotspot_draws?select=draw_id,draw_date,draw_time,bulls_eye&order=draw_id.desc&limit=1'
      );


    /* =====================================================
       MODE
    ===================================================== */

    const mode =
      scheduleMode(
        now.minutes,
        raw.length > 0
      );


    /* =====================================================
       COLLECTION COUNT
    ===================================================== */

    const have =
      Math.min(
        COLLECTION_DRAWS,
        history.length
      );


    /* =====================================================
       RESPONSE
    ===================================================== */

    res
      .status(200)
      .json({

        ok:
          true,

        mode,

        schedule: {

          collection:
            '6:00 AM – 6:00 PM',

          selection:
            '6:05 PM',

          tracking:
            '6:05 PM – 2:00 AM',

          cleanup:
            '2:30 AM'
        },


        collection: {

          have,

          need:
            COLLECTION_DRAWS,

          remaining:
            Math.max(
              0,
              COLLECTION_DRAWS -
              have
            ),

          startDrawId:
            control
              ?.start_draw_id
            ||
            null
        },


        groups:
          raw,


        latest:
          latest?.[0]
          ||
          null,


        serverStored:
          true
      });


  } catch (
    e
  ) {

    res
      .status(500)
      .json({

        ok:
          false,

        error:
          e.message
          ||
          String(e)
      });
  }
};
