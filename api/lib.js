const cheerio = require('cheerio');

const OFFICIAL_LIVE =
  'https://www.calottery.com/en/draw-games/hot-spot';

const OFFICIAL_PAST =
  'https://www.calottery.com/en/draw-games/hot-spot/past-winning-numbers';

const sleep = ms =>
  new Promise(r => setTimeout(r, ms));

function uniqSorted(nums) {
  return [
    ...new Set(
      (nums || []).map(Number)
    )
  ]
    .filter(
      n =>
        n >= 1 &&
        n <= 80
    )
    .sort(
      (a, b) => a - b
    );
}


/*
  Parse California Lottery Hot Spot page.

  Works with:
  1. Main/live Hot Spot page.
  2. Past Winning Numbers page.

  IMPORTANT:
  On the main page there are unrelated numbers
  before the actual results, such as:
  "DRAWINGS EVERY 4 MINUTES".

  Therefore we try to begin number parsing
  specifically after "Draw Results".
*/
function parse(html) {
  const $ =
    cheerio.load(html);

  const t =
    $('body')
      .text()
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const no =
    (
      t.match(
        /Draw Number:\s*(\d{7})/i
      ) || []
    )[1];

  const dm =
    t.match(
      /Draw Date:\s*([^|]+?)\s*\|\s*Draw Time:\s*([0-9:]+\s*[ap]\.??m\.?)/i
    );

  if (
    !no ||
    !dm
  ) {
    return null;
  }

  /*
    Start parsing after the date/time area.
  */
  let seg =
    t.slice(
      t.indexOf(dm[0]) +
      dm[0].length
    );

  /*
    LIVE PAGE FIX:
    If "Draw Results" exists,
    ignore everything before it.

    This prevents unrelated page numbers
    from entering the 20-number result.
  */
  const resultsMatch =
    seg.match(
      /Draw Results\s*:?\s*/i
    );

  if (resultsMatch) {
    const pos =
      seg.search(
        /Draw Results\s*:?\s*/i
      );

    if (pos >= 0) {
      seg =
        seg.slice(
          pos +
          resultsMatch[0].length
        );
    }
  }

  /*
    Stop before unrelated page content.
  */
  const stop =
    seg.search(
      /Check out the Hot Spot|Hot Spot Payouts|Overall odds|Prize Payouts|Winning Tickets/i
    );

  if (stop > 0) {
    seg =
      seg.slice(
        0,
        stop
      );
  }

  const bull =
    (
      seg.match(
        /Bulls[--–—]?eye\s+number\s+is(?:\s*\{number\})?\s*(?:number\s*)?(\d{1,2})/i
      ) || []
    )[1];

  /*
    Extract valid Hot Spot numbers only.
  */
  const raw =
    seg.match(
      /\b(?:[1-9]|[1-7]\d|80)\b/g
    ) || [];

  /*
    First 20 valid numbers after Draw Results.
  */
  const numbers =
    uniqSorted(
      raw.slice(
        0,
        20
      )
    );

  if (
    numbers.length !== 20
  ) {
    return null;
  }

  return {
    id: +no,
    date:
      dm[1].trim(),
    time:
      dm[2].trim(),
    numbers,
    bullsEye:
      bull
        ? Number(bull)
        : null
  };
}


function valid(d) {
  return (
    d &&
    Number.isInteger(
      d.id
    ) &&
    d.numbers?.length === 20 &&
    new Set(
      d.numbers
    ).size === 20 &&
    d.numbers.every(
      n =>
        n >= 1 &&
        n <= 80
    ) &&
    (
      d.bullsEye === null ||
      (
        Number.isInteger(
          d.bullsEye
        ) &&
        d.bullsEye >= 1 &&
        d.bullsEye <= 80 &&
        d.numbers.includes(
          d.bullsEye
        )
      )
    )
  );
}


/*
  IMPORTANT CHANGE:

  getDraw(null)
  = newest/current draw
  = MAIN Hot Spot page.

  getDraw(3297753)
  = specific historical draw
  = Past Winning Numbers page.
*/
async function getDraw(id) {
  let last;

  for (
    let a = 0;
    a < 3;
    a++
  ) {
    try {

      const source =
        id
          ? OFFICIAL_PAST
          : OFFICIAL_LIVE;

      const u =
        new URL(source);

      if (id) {
        u.searchParams.set(
          'query',
          id
        );
      }

      /*
        Cache buster.
      */
      u.searchParams.set(
        '_v',
        Date.now().toString(36) +
        Math.random()
          .toString(36)
          .slice(2)
      );

      const r =
        await fetch(
          u,
          {
            cache:
              'no-store',

            headers: {
              'user-agent':
                'Mozilla/5.0',

              'cache-control':
                'no-cache',

              pragma:
                'no-cache',

              'accept-language':
                'en-US,en;q=0.9'
            }
          }
        );

      if (!r.ok) {
        throw Error(
          `California Lottery HTTP ${r.status}`
        );
      }

      const d =
        parse(
          await r.text()
        );

      if (!valid(d)) {
        throw Error(
          'Invalid parsed draw'
        );
      }

      /*
        Historical request must return
        EXACTLY the requested draw.
      */
      if (
        id &&
        d.id !== id
      ) {
        throw Error(
          `Expected ${id}, got ${d.id}`
        );
      }

      return d;

    } catch (e) {

      last = e;

      await sleep(
        150 * (a + 1)
      );
    }
  }

  throw (
    last ||
    Error('Fetch failed')
  );
}


async function getMany(ids) {
  const out = [];

  const C = 8;

  for (
    let i = 0;
    i < ids.length;
    i += C
  ) {
    out.push(
      ...await Promise.all(
        ids
          .slice(
            i,
            i + C
          )
          .map(
            getDraw
          )
      )
    );
  }

  return out.sort(
    (a, b) =>
      a.id - b.id
  );
}


function score(
  draw,
  group
) {
  const set =
    new Set(
      draw.numbers
    );

  const hit =
    group.filter(
      n =>
        set.has(n)
    );

  const bullsEyeMatch =
    Number.isInteger(
      draw.bullsEye
    ) &&
    group.includes(
      draw.bullsEye
    );

  return {
    count:
      hit.length,

    hit,

    bullsEye:
      draw.bullsEye,

    bullsEyeMatch
  };
}


function sb() {
  const url =
    process.env
      .SUPABASE_URL;

  const key =
    process.env
      .SUPABASE_SERVICE_ROLE_KEY;

  if (
    !url ||
    !key
  ) {
    throw Error(
      'Supabase environment variables are missing'
    );
  }

  return {
    url:
      url.replace(
        /\/$/,
        ''
      ),

    key
  };
}


async function db(
  path,
  {
    method = 'GET',
    body,
    prefer
  } = {}
) {

  const {
    url,
    key
  } = sb();

  const h = {
    apikey:
      key,

    authorization:
      `Bearer ${key}`,

    'content-type':
      'application/json'
  };

  if (prefer) {
    h.prefer =
      prefer;
  }

  const r =
    await fetch(
      `${url}/rest/v1/${path}`,
      {
        method,
        headers: h,

        body:
          body === undefined
            ? undefined
            : JSON.stringify(
                body
              ),

        cache:
          'no-store'
      }
    );

  const txt =
    await r.text();

  if (!r.ok) {
    throw Error(
      `Supabase ${r.status}: ${txt.slice(0, 300)}`
    );
  }

  if (!txt) {
    return null;
  }

  try {
    return JSON.parse(
      txt
    );
  } catch {
    return txt;
  }
}


/*
  Guarded candidate generation.
*/
const MAX_INTERSECTION_FOR_COMBOS =
  12;


function combos5(
  a,
  fn
) {
  const n =
    a.length;

  if (
    n >
    MAX_INTERSECTION_FOR_COMBOS
  ) {
    return;
  }

  for (
    let i = 0;
    i < n - 4;
    i++
  )
    for (
      let j = i + 1;
      j < n - 3;
      j++
    )
      for (
        let k = j + 1;
        k < n - 2;
        k++
      )
        for (
          let l = k + 1;
          l < n - 1;
          l++
        )
          for (
            let m = l + 1;
            m < n;
            m++
          )
            fn([
              a[i],
              a[j],
              a[k],
              a[l],
              a[m]
            ]);
}


function logChoose(
  n,
  k
) {
  if (
    k < 0 ||
    k > n
  ) {
    return -Infinity;
  }

  let s = 0;

  for (
    let i = 0;
    i < k;
    i++
  ) {
    s +=
      Math.log(
        n - i
      ) -
      Math.log(
        i + 1
      );
  }

  return s;
}


const SINGLE_DRAW_HIT_PROB =
  Math.exp(
    logChoose(
      20,
      5
    ) -
    logChoose(
      80,
      5
    )
  );


function pValueAtLeast(
  k,
  n
) {
  if (k <= 0) {
    return 1;
  }

  const lambda =
    n *
    SINGLE_DRAW_HIT_PROB;

  let cdf = 0;

  let p =
    Math.exp(
      -lambda
    );

  for (
    let i = 0;
    i < k;
    i++
  ) {
    cdf += p;

    p *=
      lambda /
      (i + 1);
  }

  return Math.max(
    0,
    Math.min(
      1,
      1 - cdf
    )
  );
}


function bonferroniThreshold(
  candidateCount,
  alpha = 0.05
) {
  return candidateCount > 0
    ? alpha /
        candidateCount
    : alpha;
}


function mean(a) {
  return a.length
    ? a.reduce(
        (
          s,
          x
        ) =>
          s + x,
        0
      ) /
        a.length
    : 0;
}


function median(a) {
  if (!a.length) {
    return 0;
  }

  const b =
    [...a].sort(
      (
        x,
        y
      ) =>
        x - y
    );

  const m =
    Math.floor(
      b.length / 2
    );

  return b.length % 2
    ? b[m]
    : (
        b[m - 1] +
        b[m]
      ) / 2;
}


function parseDrawMinutes(
  timeText
) {
  const t =
    String(
      timeText || ''
    )
      .toLowerCase()
      .match(
        /(\d{1,2}):(\d{2})\s*([ap])/
      );

  if (!t) {
    return null;
  }

  let h =
    +t[1] % 12;

  if (
    t[3] === 'p'
  ) {
    h += 12;
  }

  return (
    h * 60 +
    +t[2]
  );
}


function formatMinutes(m) {
  if (
    m == null
  ) {
    return null;
  }

  m =
    (
      (
        Math.round(m) %
        1440
      ) +
      1440
    ) %
    1440;

  let h =
    Math.floor(
      m / 60
    );

  const min =
    m % 60;

  const ap =
    h >= 12
      ? 'PM'
      : 'AM';

  h =
    h % 12 ||
    12;

  return (
    `${h}:` +
    `${String(min).padStart(2, '0')} ` +
    ap
  );
}


function drawTimeMap(
  draws
) {
  const x =
    new Map();

  for (
    const d of draws
  ) {
    x.set(
      Number(
        d.draw_id ??
        d.id
      ),

      parseDrawMinutes(
        d.draw_time ??
        d.time
      )
    );
  }

  return x;
}


function statsForGroup(
  draws,
  numbers
) {

  const occ = [];

  for (
    const d of draws
  ) {
    const set =
      new Set(
        d.numbers || []
      );

    if (
      numbers.every(
        n =>
          set.has(n)
      )
    ) {
      occ.push(
        Number(
          d.draw_id ??
          d.id
        )
      );
    }
  }

  const gaps = [];

  for (
    let i = 1;
    i < occ.length;
    i++
  ) {
    gaps.push(
      occ[i] -
      occ[i - 1]
    );
  }

  const avg =
    mean(gaps);

  const med =
    median(gaps);

  const sd =
    gaps.length
      ? Math.sqrt(
          mean(
            gaps.map(
              x =>
                (
                  x - avg
                ) ** 2
            )
          )
        )
      : 0;

  const cv =
    avg > 0
      ? sd / avg
      : 999;

  const expectedGap =
    gaps.length
      ? Math.max(
          1,
          Math.round(
            (
              avg +
              med
            ) / 2
          )
        )
      : null;

  const latest =
    Number(
      draws.at(-1)
        ?.draw_id ??
      draws.at(-1)
        ?.id ??
      0
    );

  const last =
    occ.at(-1) ||
    null;

  let center =
    last &&
    expectedGap
      ? last +
        expectedGap
      : null;

  if (center) {
    while (
      center <= latest
    ) {
      center +=
        expectedGap;
    }
  }

  const half =
    gaps.length
      ? Math.max(
          2,
          Math.round(
            sd / 2
          )
        )
      : null;

  const from =
    center
      ? Math.max(
          latest + 1,
          center - half
        )
      : null;

  const to =
    center
      ? center + half
      : null;

  const times =
    drawTimeMap(
      draws
    );

  const latestMinutes =
    parseDrawMinutes(
      draws.at(-1)
        ?.draw_time ??
      draws.at(-1)
        ?.time
    );

  const toClock =
    id =>
      id &&
      latestMinutes != null
        ? formatMinutes(
            latestMinutes +
            (
              id -
              latest
            ) *
              4
          )
        : null;

  return {
    numbers,

    count:
      occ.length,

    occurrences:
      occ,

    gaps,

    meanGap:
      +avg.toFixed(2),

    medianGap:
      +med.toFixed(2),

    minGap:
      gaps.length
        ? Math.min(
            ...gaps
          )
        : 0,

    maxGap:
      gaps.length
        ? Math.max(
            ...gaps
          )
        : 0,

    standardDeviation:
      +sd.toFixed(2),

    coefficientVariation:
      cv === 999
        ? null
        : +cv.toFixed(3),

    lastDrawId:
      last,

    lastAppearanceTime:
      last
        ? formatMinutes(
            times.get(last)
          )
        : null,

    sinceLastDraws:
      last
        ? latest -
          last
        : null,

    sinceLastMinutes:
      last
        ? (
            latest -
            last
          ) * 4
        : null,

    expectedGapDraws:
      expectedGap,

    expectedCenterDrawId:
      center,

    expectedFromDrawId:
      from,

    expectedToDrawId:
      to,

    expectedCenterTime:
      toClock(
        center
      ),

    expectedFromTime:
      toClock(
        from
      ),

    expectedToTime:
      toClock(
        to
      )
  };
}


function mineCandidates(
  sourceDraws
) {

  const sourceSets =
    sourceDraws.map(
      d =>
        new Set(
          d.numbers || []
        )
    );

  const candidates =
    new Set();

  for (
    let i = 0;
    i <
    sourceDraws.length - 1;
    i++
  ) {

    const A =
      sourceSets[i];

    for (
      let j = i + 1;
      j <
      sourceDraws.length;
      j++
    ) {

      const inter =
        (
          sourceDraws[j]
            .numbers || []
        ).filter(
          n =>
            A.has(n)
        );

      if (
        inter.length < 5
      ) {
        continue;
      }

      combos5(
        inter,
        c =>
          candidates.add(
            c.join(',')
          )
      );
    }
  }

  return candidates;
}


function countInDraws(
  nums,
  drawSets
) {
  let count = 0;

  for (
    const s of drawSets
  ) {
    if (
      nums.every(
        n =>
          s.has(n)
      )
    ) {
      count++;
    }
  }

  return count;
}


/*
  Core-3 strategy.
*/
const CORE_WINDOW_DRAWS =
  40;

const MIN_CORE_OCCURRENCES =
  3;


function combos3(
  a,
  fn
) {
  const n =
    a.length;

  for (
    let i = 0;
    i < n - 2;
    i++
  )
    for (
      let j = i + 1;
      j < n - 1;
      j++
    )
      for (
        let k = j + 1;
        k < n;
        k++
      )
        fn([
          a[i],
          a[j],
          a[k]
        ]);
}


function lastContainingDrawId(
  draws,
  nums
) {
  for (
    let i =
      draws.length - 1;
    i >= 0;
    i--
  ) {

    const s =
      new Set(
        draws[i]
          .numbers || []
      );

    if (
      nums.every(
        n =>
          s.has(n)
      )
    ) {
      return Number(
        draws[i]
          .draw_id ??
        draws[i]
          .id ??
        0
      );
    }
  }

  return 0;
}


function analyzeTopGroups(
  draws,
  limit = 2
) {

  if (
    !Array.isArray(
      draws
    ) ||
    draws.length <
      CORE_WINDOW_DRAWS
  ) {
    return [];
  }

  const window =
    draws.slice(
      -CORE_WINDOW_DRAWS
    );

  const sets =
    window.map(
      d =>
        new Set(
          d.numbers || []
        )
    );

  const coreCounts =
    new Map();

  for (
    const d of window
  ) {

    const nums =
      uniqSorted(
        d.numbers || []
      );

    combos3(
      nums,
      c => {
        const k =
          c.join(',');

        coreCounts.set(
          k,
          (
            coreCounts.get(k) ||
            0
          ) + 1
        );
      }
    );
  }

  const cores = [];

  for (
    const [
      key,
      count
    ] of coreCounts
  ) {

    if (
      count <
      MIN_CORE_OCCURRENCES
    ) {
      continue;
    }

    const core =
      key
        .split(',')
        .map(Number);

    const coreDrawIdx =
      [];

    for (
      let i = 0;
      i < sets.length;
      i++
    ) {
      if (
        core.every(
          n =>
            sets[i].has(n)
        )
      ) {
        coreDrawIdx.push(i);
      }
    }

    const companionCounts =
      new Map();

    const pairCounts =
      new Map();

    for (
      const i of coreDrawIdx
    ) {

      const extras =
        (
          window[i]
            .numbers || []
        ).filter(
          n =>
            !core.includes(n)
        );

      for (
        const n of extras
      ) {
        companionCounts.set(
          n,
          (
            companionCounts.get(
              n
            ) ||
            0
          ) + 1
        );
      }

      for (
        let a = 0;
        a <
        extras.length - 1;
        a++
      ) {
        for (
          let b =
            a + 1;
          b <
          extras.length;
          b++
        ) {

          const x =
            Math.min(
              extras[a],
              extras[b]
            );

          const y =
            Math.max(
              extras[a],
              extras[b]
            );

          const k =
            `${x},${y}`;

          pairCounts.set(
            k,
            (
              pairCounts.get(
                k
              ) ||
              0
            ) + 1
          );
        }
      }
    }

    let best = null;

    for (
      const [
        pairKey,
        fullCount
      ] of pairCounts
    ) {

      const [
        a,
        b
      ] =
        pairKey
          .split(',')
          .map(Number);

      const aWithCore =
        companionCounts.get(
          a
        ) || 0;

      const bWithCore =
        companionCounts.get(
          b
        ) || 0;

      const nums =
        uniqSorted([
          ...core,
          a,
          b
        ]);

      if (
        nums.length !== 5
      ) {
        continue;
      }

      const lastFull =
        lastContainingDrawId(
          window,
          nums
        );

      const candidate = {
        numbers:
          nums,

        core,

        coreCount:
          count,

        fullCount,

        aWithCore,

        bWithCore,

        minCompanion:
          Math.min(
            aWithCore,
            bWithCore
          ),

        sumCompanion:
          aWithCore +
          bWithCore,

        lastFull
      };

      if (
        !best ||

        candidate.fullCount >
          best.fullCount ||

        (
          candidate.fullCount ===
            best.fullCount &&
          candidate.minCompanion >
            best.minCompanion
        ) ||

        (
          candidate.fullCount ===
            best.fullCount &&
          candidate.minCompanion ===
            best.minCompanion &&
          candidate.sumCompanion >
            best.sumCompanion
        ) ||

        (
          candidate.fullCount ===
            best.fullCount &&
          candidate.minCompanion ===
            best.minCompanion &&
          candidate.sumCompanion ===
            best.sumCompanion &&
          candidate.lastFull >
            best.lastFull
        )
      ) {
        best =
          candidate;
      }
    }

    if (best) {
      cores.push(
        best
      );
    }
  }


  cores.sort(
    (
      a,
      b
    ) =>
      b.coreCount -
        a.coreCount ||

      b.fullCount -
        a.fullCount ||

      b.minCompanion -
        a.minCompanion ||

      b.sumCompanion -
        a.sumCompanion ||

      b.lastFull -
        a.lastFull ||

      a.numbers
        .join(',')
        .localeCompare(
          b.numbers.join(',')
        )
  );


  const chosen = [];

  const seen =
    new Set();


  for (
    const c of cores
  ) {

    const key =
      c.numbers.join(',');

    if (
      seen.has(key)
    ) {
      continue;
    }

    const s =
      statsForGroup(
        window,
        c.numbers
      );

    s.method =
      'core3_recent40';

    s.analysisWindow =
      CORE_WINDOW_DRAWS;

    s.core3 =
      c.core;

    s.core3Occurrences =
      c.coreCount;

    s.fourthWithCore =
      c.aWithCore;

    s.fifthWithCore =
      c.bWithCore;

    s.fullGroupOccurrences =
      c.fullCount;

    chosen.push(s);

    seen.add(key);

    if (
      chosen.length >=
      limit
    ) {
      break;
    }
  }

  return chosen;
}


function californiaNowParts(
  date = new Date()
) {

  const parts =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone:
          'America/Los_Angeles',

        year:
          'numeric',

        month:
          '2-digit',

        day:
          '2-digit',

        hour:
          '2-digit',

        minute:
          '2-digit',

        hourCycle:
          'h23'
      }
    ).formatToParts(
      date
    );

  const o = {};

  for (
    const p of parts
  ) {
    if (
      p.type !==
      'literal'
    ) {
      o[p.type] =
        p.value;
    }
  }

  const hour =
    +o.hour;

  const minute =
    +o.minute;

  return {
    dateKey:
      `${o.year}-${o.month}-${o.day}`,

    hour,

    minute,

    minutes:
      hour * 60 +
      minute
  };
}


function previousDateKey(
  dateKey
) {

  const [
    y,
    m,
    d
  ] =
    String(
      dateKey
    )
      .split('-')
      .map(Number);

  const x =
    new Date(
      Date.UTC(
        y,
        m - 1,
        d
      ) -
      86400000
    );

  return (
    `${x.getUTCFullYear()}-` +
    `${String(
      x.getUTCMonth() + 1
    ).padStart(2, '0')}-` +
    `${String(
      x.getUTCDate()
    ).padStart(2, '0')}`
  );
}


function cycleDateKey(
  now
) {
  return now.minutes < 360
    ? previousDateKey(
        now.dateKey
      )
    : now.dateKey;
}


function scheduleMode(
  minutes,
  hasGroups = false
) {

  if (
    minutes >= 150 &&
    minutes < 360
  ) {
    return 'cleanup';
  }

  if (
    minutes >= 120 &&
    minutes < 150
  ) {
    return 'idle';
  }

  if (
    minutes >= 360 &&
    minutes < 1080
  ) {
    return 'collecting';
  }

  return hasGroups
    ? 'tracking'
    : 'preparing';
}


module.exports = {
  uniqSorted,
  getDraw,
  getMany,
  score,
  db,
  statsForGroup,
  analyzeTopGroups,
  parseDrawMinutes,
  formatMinutes,
  californiaNowParts,
  previousDateKey,
  cycleDateKey,
  scheduleMode
};
