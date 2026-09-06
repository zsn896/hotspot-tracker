'use strict';

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function hitNumbers(draw, group) {
  const set = new Set(norm(draw?.numbers));
  return group.filter(n => set.has(n));
}

function choose3(values) {
  const out = [];

  for (let i = 0; i < values.length - 2; i++) {
    for (let j = i + 1; j < values.length - 1; j++) {
      for (let k = j + 1; k < values.length; k++) {
        out.push([
          values[i],
          values[j],
          values[k]
        ]);
      }
    }
  }

  return out;
}

function windowStats(rows, group) {
  let twoPlus = 0;
  let threePlus = 0;
  let fourPlus = 0;
  let exact5 = 0;
  let totalHits = 0;

  const core3 = new Map();

  const numberHits =
    new Map(
      group.map(n => [n, 0])
    );

  for (const draw of rows) {
    const hits =
      hitNumbers(
        draw,
        group
      );

    totalHits +=
      hits.length;

    if (hits.length >= 2) {
      twoPlus++;
    }

    if (hits.length >= 3) {
      threePlus++;

      for (
        const core
        of choose3(hits)
      ) {
        const key =
          core.join(',');

        core3.set(
          key,
          Number(
            core3.get(key) || 0
          ) + 1
        );
      }
    }

    if (hits.length >= 4) {
      fourPlus++;
    }

    if (hits.length === 5) {
      exact5++;
    }

    for (const n of hits) {
      numberHits.set(
        n,
        Number(
          numberHits.get(n) || 0
        ) + 1
      );
    }
  }

  return {
    draws:
      rows.length,

    averageHits:
      rows.length
        ? totalHits / rows.length
        : 0,

    twoPlus,
    threePlus,
    fourPlus,
    exact5,

    uniqueCore3:
      core3.size,

    core3:
      [...core3.entries()]
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
                b.numbers.join(',')
              )
        ),

    numberHits:
      [...numberHits.entries()]
        .map(
          ([number, count]) => ({
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
        )
  };
}

function ratio(
  current,
  baseline,
  floor = 0.01
) {
  return (
    current /
    Math.max(
      floor,
      baseline
    )
  );
}

function clamp(
  value,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}

function analyzeGroupWave(
  inputDraws,
  inputGroup
) {
  const group =
    norm(
      inputGroup
    );

  const draws =
    Array.isArray(inputDraws)
      ? [...inputDraws]
          .filter(
            d =>
              norm(
                d?.numbers
              ).length === 20
          )
          .sort(
            (a, b) =>
              Number(
                a.draw_id ||
                a.id ||
                0
              )
              -
              Number(
                b.draw_id ||
                b.id ||
                0
              )
          )
      : [];

  if (
    group.length !== 5
  ) {
    return {
      ok:
        false,

      reason:
        'group-must-have-five-unique-numbers'
    };
  }

  if (
    draws.length < 20
  ) {
    return {
      ok:
        true,

      group,

      state:
        'DORMANT',

      stateAr:
        'جمود / بيانات غير كافية',

      score:
        0,

      alert:
        false,

      reason:
        'need-at-least-20-draws'
    };
  }

  const w10 =
    windowStats(
      draws.slice(-10),
      group
    );

  const w20 =
    windowStats(
      draws.slice(-20),
      group
    );

  const w40 =
    windowStats(
      draws.slice(
        -Math.min(
          40,
          draws.length
        )
      ),
      group
    );

  const baselineRows =
    draws.slice(
      0,
      Math.max(
        0,
        draws.length - 20
      )
    );

  const baseline =
    windowStats(
      baselineRows.length >= 20
        ? baselineRows
        : draws,
      group
    );

  const bDraws =
    Math.max(
      1,
      baseline.draws
    );

  const rDraws =
    Math.max(
      1,
      w20.draws
    );

  const baseTwo =
    baseline.twoPlus /
    bDraws;

  const baseThree =
    baseline.threePlus /
    bDraws;

  const baseFour =
    baseline.fourPlus /
    bDraws;

  const recentTwo =
    w20.twoPlus /
    rDraws;

  const recentThree =
    w20.threePlus /
    rDraws;

  const recentFour =
    w20.fourPlus /
    rDraws;

  const twoLift =
    ratio(
      recentTwo,
      baseTwo,
      0.02
    );

  const threeLift =
    ratio(
      recentThree,
      baseThree,
      0.005
    );

  const fourLift =
    ratio(
      recentFour,
      baseFour,
      0.0025
    );

  const coreSpread =
    w20.uniqueCore3;

  const shortAcceleration =
    w10.threePlus * 2 -
    w20.threePlus;

  const averageLift =
    ratio(
      w20.averageHits,
      baseline.averageHits,
      0.2
    );

  const previous20 =
    draws.length >= 40
      ? windowStats(
          draws.slice(
            -40,
            -20
          ),
          group
        )
      : null;

  const prevThree =
    previous20
      ? previous20.threePlus
      : 0;

  const cooledBefore =
    previous20
      ? prevThree <=
        Math.max(
          1,
          Math.floor(
            w40.threePlus *
            0.2
          )
        )
      : false;

  const rebound =
    cooledBefore &&
    w20.threePlus >= 2 &&
    (
      threeLift >= 1.15 ||
      coreSpread >= 2
    );

  let score = 0;

  score +=
    clamp(
      (twoLift - 0.9) * 18,
      0,
      18
    );

  score +=
    clamp(
      (threeLift - 0.8) * 28,
      0,
      32
    );

  score +=
    clamp(
      (fourLift - 0.8) * 12,
      0,
      16
    );

  score +=
    clamp(
      coreSpread * 5,
      0,
      20
    );

  score +=
    clamp(
      shortAcceleration * 5,
      0,
      10
    );

  score +=
    clamp(
      (averageLift - 0.9) * 18,
      0,
      12
    );

  if (rebound) {
    score += 10;
  }

  if (w20.fourPlus > 0) {
    score += 8;
  }

  if (w20.exact5 > 0) {
    score += 10;
  }

  score =
    Math.round(
      clamp(
        score,
        0,
        100
      )
    );

  let state =
    'DORMANT';

  let stateAr =
    'جمود';

  let alert =
    false;

  let alertLevel =
    'NONE';

  if (
    rebound &&
    score >= 45
  ) {
    state =
      'REBOUND_WATCH';

    stateAr =
      'مراقبة عودة النشاط';

    alert =
      true;

    alertLevel =
      score >= 70
        ? 'HIGH'
        : 'MEDIUM';
  }

  else if (
    w20.fourPlus >= 1 ||
    (
      w20.threePlus >= 4 &&
      coreSpread >= 3 &&
      score >= 70
    )
  ) {
    state =
      'STRONG';

    stateAr =
      'نشاط قوي';

    alert =
      true;

    alertLevel =
      'HIGH';
  }

  else if (
    score >= 55 &&
    w20.threePlus >= 2 &&
    coreSpread >= 2
  ) {
    state =
      'RISING';

    stateAr =
      'النشاط يصعد';

    alert =
      true;

    alertLevel =
      'MEDIUM';
  }

  else if (
    score >= 35 &&
    (
      w20.twoPlus >= 5 ||
      w20.threePlus >= 1
    )
  ) {
    state =
      'EARLY_SIGNAL';

    stateAr =
      'إشارات مبكرة';

    alert =
      true;

    alertLevel =
      'LOW';
  }

  else if (
    previous20 &&
    prevThree >
      w20.threePlus &&
    prevThree >= 2
  ) {
    state =
      'COOLING';

    stateAr =
      'دخول فترة تبريد';
  }

  const leaders =
    w20
      .numberHits
      .slice(
        0,
        3
      );

  const activeCores =
    w20
      .core3
      .slice(
        0,
        5
      );

  return {
    ok:
      true,

    group,

    state,

    stateAr,

    score,

    alert,

    alertLevel,

    metrics: {
      last10:
        w10,

      last20:
        w20,

      last40:
        w40,

      baseline: {
        draws:
          baseline.draws,

        averageHits:
          Number(
            baseline
              .averageHits
              .toFixed(3)
          ),

        twoPlusRate:
          Number(
            baseTwo
              .toFixed(4)
          ),

        threePlusRate:
          Number(
            baseThree
              .toFixed(4)
          ),

        fourPlusRate:
          Number(
            baseFour
              .toFixed(4)
          )
      },

      lifts: {
        twoPlus:
          Number(
            twoLift
              .toFixed(3)
          ),

        threePlus:
          Number(
            threeLift
              .toFixed(3)
          ),

        fourPlus:
          Number(
            fourLift
              .toFixed(3)
          ),

        averageHits:
          Number(
            averageLift
              .toFixed(3)
          )
      },

      shortAcceleration,

      rebound
    },

    leaders,

    activeCores,

    messageAr:
      state === 'STRONG'
        ? 'المجموعة داخل موجة نشاط قوية الآن.'
        :
      state === 'REBOUND_WATCH'
        ? 'بدأت علامات عودة النشاط بعد فترة هدوء.'
        :
      state === 'RISING'
        ? 'توجد عدة إشارات متزامنة أن النشاط يصعد.'
        :
      state === 'EARLY_SIGNAL'
        ? 'ظهرت إشارات أولية تستحق المراقبة قبل تأكيد الموجة.'
        :
      state === 'COOLING'
        ? 'نشاط المجموعة يتراجع مقارنة بالفترة السابقة.'
        :
        'لا توجد إشارة نشاط واضحة حاليًا.'
  };
}

module.exports = {
  analyzeGroupWave,
  windowStats
};
