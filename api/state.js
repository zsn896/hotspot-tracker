'use strict';

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

const GROUP_FIVE_NAME = 'AUTO Group Five';
const GROUP_FIVE_ARCHIVE_PREFIX = 'AUTO Group Five Archive ';

const GROUP_FIVE_ANALYSIS_DRAWS = 30;
const GROUP_FIVE_TRACK_DRAWS = 30;


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

   Default groups = 20 draws.
   Group Five = 30 draws.
========================================================= */

function reportBlock(
  rows,
  block,
  blockSize = 20
) {

  const part =
    rows.slice(
      (block - 1) * blockSize,
      block * blockSize
    );

  if (
    part.length < blockSize
  ) {
    return null;
  }

  const hist =
    [0, 0, 0, 0, 0, 0];

  for (
    const r of part
  ) {

    const hit =
      Number(
        r.hit_count || 0
      );

    if (
      hit >= 0 &&
      hit <= 5
    ) {
      hist[hit]++;
    }
  }

  const best =
    Math.max(
      ...part.map(
        r =>
          Number(
            r.hit_count || 0
          )
      )
    );

  return {

    block,

    blockSize,

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
            Number(
              r.hit_count || 0
            ),
          0
        ) /
        blockSize
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


    /* =====================================================
       GROUP FIVE ARCHIVES
    ===================================================== */

    const groupFiveArchives =
      (
        await db(
          `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id,created_at&name=like.${encodeURIComponent(
            GROUP_FIVE_ARCHIVE_PREFIX + '*'
          )}&order=id.asc&limit=100`
        )
      )
      ||
      [];


    const groupFiveCycle =
      groupFiveArchives.length + 1;


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

      /* ===================================================
         GROUP FIVE = 30 DRAWS
      =================================================== */

      if (
        g.name ===
        GROUP_FIVE_NAME
      ) {

        const haveFive =
          Math.min(
            GROUP_FIVE_TRACK_DRAWS,
            g.results.length
          );


        g.reports =
          [];


        /*
          Group Five report is now
          based on exactly 30 results.
        */

        if (
          g.results.length >=
          GROUP_FIVE_TRACK_DRAWS
        ) {

          const r =
            reportBlock(
              g.results,
              1,
              GROUP_FIVE_TRACK_DRAWS
            );


          if (
            r
          ) {

            r.block =
              groupFiveCycle;

            g.reports.push(
              r
            );
          }
        }


        g.currentBlock = {

          number:
            groupFiveCycle,

          have:
            haveFive,

          need:
            GROUP_FIVE_TRACK_DRAWS,

          remaining:
            Math.max(
              0,
              GROUP_FIVE_TRACK_DRAWS -
              haveFive
            )
        };


        g.groupFive = {

          cycle:
            groupFiveCycle,

          analysisWindow:
            GROUP_FIVE_ANALYSIS_DRAWS,

          trackingWindow:
            GROUP_FIVE_TRACK_DRAWS,

          startDrawId:
            Number(
              g.start_draw_id
            ),

          lastSeenDrawId:
            Number(
              g.last_seen_draw_id
            ),

          tracked:
            haveFive,

          remaining:
            Math.max(
              0,
              GROUP_FIVE_TRACK_DRAWS -
              haveFive
            ),

          nextSelectionAfterDrawId:
            Number(
              g.start_draw_id
            ) +
            GROUP_FIVE_TRACK_DRAWS,

          rule:
            'Analyze latest 30 draws, track next 30 future draws, clear old results, then rotate using latest 30.'
        };


        continue;
      }


      /* ===================================================
         ORIGINAL AUTOMATIC GROUPS = 20 DRAWS
      =================================================== */

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
            b,
            20
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
       GROUP FIVE TOP-LEVEL STATUS
    ===================================================== */

    const activeGroupFive =
      raw.find(
        g =>
          g.name ===
          GROUP_FIVE_NAME
      )
      ||
      null;


    const collectionHave =
      Math.min(
        COLLECTION_DRAWS,
        history.length
      );


    const groupFive =
      activeGroupFive
        ? {

            active:
              true,

            cycle:
              groupFiveCycle,

            numbers:
              activeGroupFive.numbers,

            analysisWindow:
              GROUP_FIVE_ANALYSIS_DRAWS,

            trackingWindow:
              GROUP_FIVE_TRACK_DRAWS,

            tracked:
              activeGroupFive
                .currentBlock
                ?.have
              ||
              0,

            remaining:
              activeGroupFive
                .currentBlock
                ?.remaining
              ??
              GROUP_FIVE_TRACK_DRAWS,

            startDrawId:
              activeGroupFive
                .start_draw_id,

            lastSeenDrawId:
              activeGroupFive
                .last_seen_draw_id,

            nextSelectionAfterDrawId:
              Number(
                activeGroupFive
                  .start_draw_id
              ) +
              GROUP_FIVE_TRACK_DRAWS,

            completedCycles:
              groupFiveArchives.length,

            rule:
              'Analyze 30 → Track 30 → Clear old results → Select new five.'
          }
        : {

            active:
              false,

            cycle:
              groupFiveCycle,

            numbers:
              null,

            analysisWindow:
              GROUP_FIVE_ANALYSIS_DRAWS,

            trackingWindow:
              GROUP_FIVE_TRACK_DRAWS,

            waitingForFirstSelection:
              collectionHave <
              GROUP_FIVE_ANALYSIS_DRAWS,

            analysisHave:
              Math.min(
                GROUP_FIVE_ANALYSIS_DRAWS,
                collectionHave
              ),

            analysisRemaining:
              Math.max(
                0,
                GROUP_FIVE_ANALYSIS_DRAWS -
                collectionHave
              ),

            completedCycles:
              groupFiveArchives.length,

            rule:
              'Analyze 30 → Track 30 → Clear old results → Select new five.'
          };


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

    const hasMainAutoGroups =
      raw.some(
        g =>
          g.name !==
          GROUP_FIVE_NAME
      );


    const mode =
      scheduleMode(
        now.minutes,
        hasMainAutoGroups
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
            '2:30 AM',

          groupFive:
            'Analyze latest 30 draws, track next 30 future draws, clear old results, then rotate using latest 30.'
        },


        collection: {

          have:
            collectionHave,

          need:
            COLLECTION_DRAWS,

          remaining:
            Math.max(
              0,
              COLLECTION_DRAWS -
              collectionHave
            ),

          startDrawId:
            control
              ?.start_draw_id
            ||
            null
        },


        groupFive,


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
