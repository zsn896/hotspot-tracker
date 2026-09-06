const { db, getDraw, getMany, parseDrawMinutes } = require('./lib');

const COLLECTION_DRAWS = 180;
const CONTROL_PREFIX = 'AUTO_CONTROL_';

const HOT_SPOT_DRAWS_PER_DAY = 300;
const HISTORY_DEFAULT_DAYS = 30;
const HISTORY_MAX_DAYS = 180;
const HISTORY_DEFAULT_CHUNK = 300;
const HISTORY_MAX_CHUNK = 400;

function drawDateKey(dateText) {
  const d = new Date(String(dateText || '') + ' 12:00:00 UTC');

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return (
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getUTCDate()).padStart(2, '0')}`
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
    m <= 1080
  );
}

function normalizeGroup(value) {
  const numbers =
    [
      ...new Set(
        String(value || '')
          .split(',')
          .map(
            x =>
              Number(
                String(x).trim()
              )
          )
      )
    ]
      .filter(
        n =>
          Number.isInteger(n) &&
          n >= 1 &&
          n <= 80
      )
      .sort(
        (a, b) =>
          a - b
      );

  return (
    numbers.length === 5
      ?
      numbers
      :
      null
  );
}

function scoreGroup(
  draw,
  group
) {
  const set =
    new Set(
      draw?.numbers || []
    );

  const hitNumbers =
    group.filter(
      n =>
        set.has(n)
    );

  return {
    hits:
      hitNumbers.length,

    hitNumbers
  };
}

function drawTimestamp(draw) {
  const dateText =
    String(
      draw?.date ||
      draw?.draw_date ||
      ''
    ).trim();

  const mins =
    parseDrawMinutes(
      draw?.time ??
      draw?.draw_time
    );

  if (
    !dateText ||
    mins == null
  ) {
    return null;
  }

  const base =
    new Date(
      `${dateText} 12:00:00 UTC`
    );

  if (
    Number.isNaN(
      base.getTime()
    )
  ) {
    return null;
  }

  return Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    0,
    mins,
    0,
    0
  );
}

function analyzeHistoryDraws(
  draws,
  group
) {
  const distribution = {
    zero: 0,
    one: 0,
    two: 0,
    three: 0,
    four: 0,
    five: 0
  };

  const strongEvents = [];

  const core3Counts =
    new Map();

  const numberStrongCounts =
    new Map(
      group.map(
        n => [
          n,
          0
        ]
      )
    );

  let totalHits = 0;

  for (
    const draw
    of draws
  ) {
    const result =
      scoreGroup(
        draw,
        group
      );

    totalHits +=
      result.hits;

    if (
      result.hits === 0
    ) {
      distribution.zero++;
    }

    else if (
      result.hits === 1
    ) {
      distribution.one++;
    }

    else if (
      result.hits === 2
    ) {
      distribution.two++;
    }

    else if (
      result.hits === 3
    ) {
      distribution.three++;
    }

    else if (
      result.hits === 4
    ) {
      distribution.four++;
    }

    else if (
      result.hits === 5
    ) {
      distribution.five++;
    }

    if (
      result.hits >= 3
    ) {
      for (
        const n
        of result.hitNumbers
      ) {
        numberStrongCounts.set(
          n,
          Number(
            numberStrongCounts.get(n) ||
            0
          ) + 1
        );
      }

      for (
        let i = 0;
        i <
        result.hitNumbers.length - 2;
        i++
      ) {
        for (
          let j = i + 1;
          j <
          result.hitNumbers.length - 1;
          j++
        ) {
          for (
            let k = j + 1;
            k <
            result.hitNumbers.length;
            k++
          ) {
            const key =
              [
                result.hitNumbers[i],
                result.hitNumbers[j],
                result.hitNumbers[k]
              ]
                .sort(
                  (a, b) =>
                    a - b
                )
                .join(',');

            core3Counts.set(
              key,
              Number(
                core3Counts.get(key) ||
                0
              ) + 1
            );
          }
        }
      }

      strongEvents.push({
        drawId:
          Number(draw.id),

        date:
          draw.date,

        time:
          draw.time,

        timestamp:
          drawTimestamp(draw),

        hits:
          result.hits,

        hitNumbers:
          result.hitNumbers
      });
    }
  }

  const gaps = [];

  for (
    let i = 1;
    i <
    strongEvents.length;
    i++
  ) {
    const previous =
      strongEvents[i - 1];

    const current =
      strongEvents[i];

    const drawGap =
      current.drawId -
      previous.drawId;

    const minutes =
      previous.timestamp != null &&
      current.timestamp != null
        ?
        Math.round(
          (
            current.timestamp -
            previous.timestamp
          ) /
          60000
        )
        :
        null;

    gaps.push({
      fromDrawId:
        previous.drawId,

      toDrawId:
        current.drawId,

      drawGap,

      minutes,

      hours:
        minutes == null
          ?
          null
          :
          Number(
            (
              minutes / 60
            ).toFixed(3)
          )
    });
  }

  const validMinutes =
    gaps
      .map(
        x =>
          x.minutes
      )
      .filter(
        x =>
          Number.isFinite(x) &&
          x >= 0
      )
      .sort(
        (a, b) =>
          a - b
      );

  const averageMinutes =
    validMinutes.length
      ?
      validMinutes.reduce(
        (a, b) =>
          a + b,
        0
      ) /
      validMinutes.length
      :
      null;

  const medianMinutes =
    validMinutes.length
      ?
      (
        validMinutes.length % 2
          ?
          validMinutes[
            (
              validMinutes.length -
              1
            ) /
            2
          ]
          :
          (
            validMinutes[
              validMinutes.length /
              2 -
              1
            ] +
            validMinutes[
              validMinutes.length /
              2
            ]
          ) /
          2
      )
      :
      null;

  const gapBuckets = {
    '0-4h': 0,
    '4-8h': 0,
    '8-12h': 0,
    '12-16h': 0,
    '16-24h': 0,
    '24h+': 0
  };

  for (
    const minutes
    of validMinutes
  ) {
    if (
      minutes < 240
    ) {
      gapBuckets['0-4h']++;
    }

    else if (
      minutes < 480
    ) {
      gapBuckets['4-8h']++;
    }

    else if (
      minutes < 720
    ) {
      gapBuckets['8-12h']++;
    }

    else if (
      minutes < 960
    ) {
      gapBuckets['12-16h']++;
    }

    else if (
      minutes < 1440
    ) {
      gapBuckets['16-24h']++;
    }

    else {
      gapBuckets['24h+']++;
    }
  }

  const topCore3 =
    [
      ...core3Counts.entries()
    ]
      .map(
        (
          [
            key,
            count
          ]
        ) => ({
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
              b.numbers.join(',')
            )
      )
      .slice(
        0,
        10
      );

  const strongNumberRanking =
    [
      ...numberStrongCounts.entries()
    ]
      .map(
        (
          [
            number,
            count
          ]
        ) => ({
          number,
          count
        })
      )
      .sort(
        (a, b) =>
          b.count -
          a.count ||
          a.number -
          b.number
      );

  return {
    draws:
      draws.length,

    group,

    threePlus:
      distribution.three +
      distribution.four +
      distribution.five,

    fourPlus:
      distribution.four +
      distribution.five,

    exact5:
      distribution.five,

    bestHit:
      distribution.five
        ?
        5
        :
        distribution.four
          ?
          4
          :
          distribution.three
            ?
            3
            :
            distribution.two
              ?
              2
              :
              distribution.one
                ?
                1
                :
                0,

    averageHits:
      draws.length
        ?
        Number(
          (
            totalHits /
            draws.length
          ).toFixed(4)
        )
        :
        0,

    distribution,

    strongEvents,

    gaps,

    gapStats: {
      count:
        validMinutes.length,

      averageMinutes:
        averageMinutes == null
          ?
          null
          :
          Number(
            averageMinutes.toFixed(2)
          ),

      averageHours:
        averageMinutes == null
          ?
          null
          :
          Number(
            (
              averageMinutes /
              60
            ).toFixed(3)
          ),

      medianMinutes:
        medianMinutes == null
          ?
          null
          :
          Number(
            medianMinutes.toFixed(2)
          ),

      medianHours:
        medianMinutes == null
          ?
          null
          :
          Number(
            (
              medianMinutes /
              60
            ).toFixed(3)
          ),

      shortestMinutes:
        validMinutes.length
          ?
          validMinutes[0]
          :
          null,

      longestMinutes:
        validMinutes.length
          ?
          validMinutes[
            validMinutes.length -
            1
          ]
          :
          null,

      buckets:
        gapBuckets
    },

    topCore3,

    strongNumberRanking
  };
}

async function historicalGroupMode(
  req,
  res
) {
  const group =
    normalizeGroup(
      req.query?.numbers
    );

  if (
    !group
  ) {
    return res
      .status(400)
      .json({
        ok:
          false,

        error:
          'numbers must contain exactly five unique values from 1 to 80, for example 11,17,47,51,72'
      });
  }

  const requestedDays =
    Number(
      req.query?.days ||
      HISTORY_DEFAULT_DAYS
    );

  const days =
    Math.max(
      1,
      Math.min(
        HISTORY_MAX_DAYS,
        Number.isFinite(
          requestedDays
        )
          ?
          Math.floor(
            requestedDays
          )
          :
          HISTORY_DEFAULT_DAYS
      )
    );

  const requestedChunkSize =
    Number(
      req.query?.chunkSize ||
      HISTORY_DEFAULT_CHUNK
    );

  const chunkSize =
    Math.max(
      50,
      Math.min(
        HISTORY_MAX_CHUNK,
        Number.isFinite(
          requestedChunkSize
        )
          ?
          Math.floor(
            requestedChunkSize
          )
          :
          HISTORY_DEFAULT_CHUNK
      )
    );

  const requestedChunk =
    Number(
      req.query?.chunk ||
      0
    );

  const chunk =
    Math.max(
      0,
      Number.isFinite(
        requestedChunk
      )
        ?
        Math.floor(
          requestedChunk
        )
        :
        0
    );

  const latest =
    await getDraw(
      null
    );

  const requestedEndDrawId =
    Number(
      req.query?.endDrawId ||
      req.query?.end ||
      0
    );

  const analysisEndDrawId =
    Number.isInteger(
      requestedEndDrawId
    ) &&
    requestedEndDrawId > 0
      ?
      Math.min(
        requestedEndDrawId,
        latest.id
      )
      :
      latest.id;

  const totalDraws =
    days *
    HOT_SPOT_DRAWS_PER_DAY;

  const firstDrawId =
    analysisEndDrawId -
    totalDraws +
    1;

  const chunkStartId =
    firstDrawId +
    chunk *
    chunkSize;

  const chunkEndId =
    Math.min(
      analysisEndDrawId,
      chunkStartId +
      chunkSize -
      1
    );

  const chunkCount =
    Math.ceil(
      totalDraws /
      chunkSize
    );

  if (
    chunkStartId >
    analysisEndDrawId
  ) {
    return res
      .status(200)
      .json({
        ok:
          true,

        mode:
          'historical-group',

        complete:
          true,

        group,

        days,

        totalDraws,

        firstDrawId,

        analysisEndDrawId,

        latestDrawId:
          latest.id,

        chunk,

        chunkSize,

        chunkCount,

        draws:
          0,

        analysis:
          analyzeHistoryDraws(
            [],
            group
          )
      });
  }

  const ids =
    Array.from(
      {
        length:
          chunkEndId -
          chunkStartId +
          1
      },
      (
        _,
        i
      ) =>
        chunkStartId +
        i
    );

  const draws =
    await getMany(
      ids
    );

  const analysis =
    analyzeHistoryDraws(
      draws,
      group
    );

  return res
    .status(200)
    .json({
      ok:
        true,

      mode:
        'historical-group',

      complete:
        chunk >=
        chunkCount -
        1,

      group,

      days,

      assumedDrawsPerDay:
        HOT_SPOT_DRAWS_PER_DAY,

      totalDraws,

      firstDrawId,

      analysisEndDrawId,

      latestDrawId:
        latest.id,

      latestDate:
        latest.date,

      latestTime:
        latest.time,

      fixedWindow:
        Boolean(
          Number.isInteger(
            requestedEndDrawId
          ) &&
          requestedEndDrawId > 0
        ),

      chunk,

      chunkSize,

      chunkCount,

      nextChunk:
        chunk <
        chunkCount -
        1
          ?
          chunk + 1
          :
          null,

      chunkFromDrawId:
        chunkStartId,

      chunkToDrawId:
        chunkEndId,

      analysis
    });
}

async function getDailyControl() {
  const controls =
    (
      await db(
        `tracker_groups?select=id,name,start_draw_id,last_seen_draw_id&name=like.${encodeURIComponent(
          CONTROL_PREFIX + '*'
        )}&order=id.desc&limit=20`
      )
    ) ||
    [];

  return (
    controls.find(
      row =>
        /^AUTO_CONTROL_\d{4}-\d{2}-\d{2}$/.test(
          String(
            row.name ||
            ''
          )
        )
    ) ||
    null
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
    const mode =
      String(
        req.query?.mode ||
        ''
      )
        .trim()
        .toLowerCase();

    if (
      mode ===
      'historical-group' ||
      mode ===
      'history-group' ||
      mode ===
      'history'
    ) {
      return historicalGroupMode(
        req,
        res
      );
    }

    const control =
      await getDailyControl();

    if (
      !control
    ) {
      return res
        .status(200)
        .json({
          ok:
            true,

          control:
            null,

          missingDrawIds:
            []
        });
    }

    const collectionDateKey =
      String(
        control.name ||
        ''
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
      (
        await db(
          `hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=gte.${startId}&draw_id=lte.${endId}&order=draw_id.asc`
        )
      ) ||
      [];

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
        (
          _,
          i
        ) =>
          startId +
          i
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
        ok:
          true,

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
  }

  catch (e) {
    return res
      .status(500)
      .json({
        ok:
          false,

        error:
          e.message ||
          String(e)
      });
  }
};
