'use strict';

const {
  score,
  parseDrawMinutes
} = require('./lib');

const CLOSE_START_MINUTES = 120;

function simulateClose(group, draws) {
  const rows = [];

  for (const draw of draws) {
    const minutes =
      parseDrawMinutes(draw.time);

    if (
      minutes == null ||
      minutes > CLOSE_START_MINUTES
    ) {
      continue;
    }

    const s =
      score(
        draw,
        group.numbers
      );

    rows.push({
      drawId: draw.id,
      time: draw.time,
      hitCount: Number(
        s.count || 0
      ),
      hitNumbers:
        Array.isArray(s.hit)
          ? s.hit.map(Number)
          : []
    });
  }

  const strong =
    rows
      .filter(
        r => r.hitCount >= 3
      )
      .sort(
        (a, b) =>
          Number(b.drawId) -
          Number(a.drawId)
      );

  return {
    processedDrawIds:
      rows.map(
        r => r.drawId
      ),

    trackingLastSeenDrawId:
      rows.at(-1)?.drawId
      ?? null,

    lastSeenDrawId:
      strong[0]?.drawId
      ?? null,

    lastSeenHitCount:
      strong[0]?.hitCount
      ?? null,

    results:
      rows
  };
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


  const group = {
    numbers:
      [10,20,30,40,50]
  };


  const draws = [

    {
      id: 9001,
      date: 'Sep 5, 2026',
      time: '1:52 a.m.',

      numbers: [
        10,20,31,41,51,
        61,62,63,64,65,
        66,67,68,69,70,
        71,72,73,74,75
      ],

      bullsEye: 31
    },


    {
      id: 9002,
      date: 'Sep 5, 2026',
      time: '1:56 a.m.',

      numbers: [
        10,20,30,41,51,
        61,62,63,64,65,
        66,67,68,69,70,
        71,72,73,74,75
      ],

      bullsEye: 30
    },


    {
      id: 9003,
      date: 'Sep 5, 2026',
      time: '2:00 a.m.',

      numbers: [
        10,20,31,40,51,
        61,62,63,64,65,
        66,67,68,69,70,
        71,72,73,74,75
      ],

      bullsEye: 40
    },


    {
      id: 9004,
      date: 'Sep 5, 2026',
      time: '2:04 a.m.',

      numbers: [
        10,20,30,40,50,
        61,62,63,64,65,
        66,67,68,69,70,
        71,72,73,74,75
      ],

      bullsEye: 50
    }

  ];


  const simulated =
    simulateClose(
      group,
      draws
    );


  const checks = {

    includes156:
      simulated
        .processedDrawIds
        .includes(9002),

    includes200:
      simulated
        .processedDrawIds
        .includes(9003),

    excludes204:
      !simulated
        .processedDrawIds
        .includes(9004),

    trackingEndsAt200:
      simulated
        .trackingLastSeenDrawId
      === 9003,

    lastSeenUsesLatest3Plus:
      simulated
        .lastSeenDrawId
      === 9003,

    lastSeenHitCountCorrect:
      simulated
        .lastSeenHitCount
      === 3
  };


  const passed =
    Object
      .values(checks)
      .every(Boolean);


  return res
    .status(
      passed
        ? 200
        : 500
    )
    .json({

      ok:
        passed,

      test:
        '2:00 AM close-window simulation',

      checks,

      expected: {

        processedDrawIds:
          [9001,9002,9003],

        trackingLastSeenDrawId:
          9003,

        lastSeenDrawId:
          9003,

        note:
          '2:04 AM must be excluded; Last Seen must be the newest 3/5+ result, including the 2:00 AM draw.'
      },

      actual:
        simulated
    });
};
