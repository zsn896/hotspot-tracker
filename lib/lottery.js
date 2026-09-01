'use strict';

const { SOURCE_URL, POOL_SIZE, DRAWN_PER_DRAW, FETCH_CONCURRENCY, FETCH_TIMEOUT_MS, FETCH_ATTEMPTS } = require('./config');
const { fetchWithRetry, mapLimit } = require('./http');

/**
 * The original build pulled in cheerio (a full HTML parser, ~1 MB installed) to
 * do exactly one thing: read the page as plain text. That is a heavy cold-start
 * cost on a serverless function for no benefit, so this module extracts text
 * directly and the project now has zero runtime dependencies.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...',
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
  });
}

/** HTML -> normalised visible text. */
function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a token stream into maximal strictly-ascending runs. */
function ascendingRuns(tokens) {
  const runs = [];
  let current = [];
  for (const value of tokens) {
    if (current.length && value <= current[current.length - 1]) {
      runs.push(current);
      current = [];
    }
    current.push(value);
  }
  if (current.length) runs.push(current);
  return runs;
}

/**
 * Pull the 20 drawn numbers out of a text segment.
 *
 * The original implementation took the first 20 integer tokens and de-duplicated
 * them, so any stray integer in the markup (a payout figure, a "12 of 20" label)
 * shifted the window, left fewer than 20 unique values, and caused the draw to be
 * rejected and retried — a silent, recurring data-loss path.
 *
 * The official page prints the numbers in ascending order, which is a much
 * stronger signal than position, so the search works over maximal ascending runs:
 *
 *   1. a run of exactly 20 is the clean case and wins outright;
 *   2. if a run is longer than 20, noise has fused with the list, and the
 *      Bulls-eye breaks the tie — it is guaranteed to be one of the 20 drawn
 *      numbers, so any window omitting it is wrong;
 *   3. failing all that, fall back to the first window of 20 distinct tokens.
 *
 * Whatever survives is still checked by validationError, so a wrong guess is
 * caught rather than stored.
 */
function findDrawNumbers(text, bullsEye = null) {
  const tokens = [];
  const re = /\b\d{1,2}\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = Number(m[0]);
    if (value >= 1 && value <= POOL_SIZE) tokens.push(value);
  }
  if (tokens.length < DRAWN_PER_DRAW) return null;

  const windows = [];
  for (const run of ascendingRuns(tokens)) {
    if (run.length < DRAWN_PER_DRAW) continue;
    const exact = run.length === DRAWN_PER_DRAW;
    for (let start = 0; start + DRAWN_PER_DRAW <= run.length; start++) {
      windows.push({ numbers: run.slice(start, start + DRAWN_PER_DRAW), exact });
    }
  }

  if (windows.length) {
    const withBullsEye = bullsEye == null
      ? windows
      : (windows.filter((w) => w.numbers.includes(bullsEye)).length
        ? windows.filter((w) => w.numbers.includes(bullsEye))
        : windows);
    const exact = withBullsEye.filter((w) => w.exact);
    const pool = exact.length ? exact : withBullsEye;
    // Prefer the last surviving window: stray digits almost always precede the
    // list (labels, counts) rather than follow it.
    return pool[pool.length - 1].numbers;
  }

  for (let start = 0; start + DRAWN_PER_DRAW <= tokens.length; start++) {
    const window = tokens.slice(start, start + DRAWN_PER_DRAW);
    if (new Set(window).size === DRAWN_PER_DRAW) return [...window].sort((a, b) => a - b);
  }
  return null;
}

/** Parse one Hot Spot results page into a draw record, or null if it isn't one. */
function parseDrawPage(html) {
  const text = htmlToText(html);

  const drawNumber = text.match(/Draw\s*Number:?\s*(\d{5,9})/i);
  const dateTime = text.match(/Draw\s*Date:?\s*([^|]+?)\s*\|\s*Draw\s*Time:?\s*(\d{1,2}:\d{2}\s*[ap]\.?\s*m\.?)/i);
  if (!drawNumber || !dateTime) return null;

  let segment = text.slice(text.indexOf(dateTime[0]) + dateTime[0].length);
  const stop = segment.search(/Check out the Hot Spot|Hot Spot Payouts|Overall odds|Prizes and Odds|Previous Draw|Next Draw/i);
  if (stop > 0) segment = segment.slice(0, stop);

  // Extract the Bulls-eye first, then delete its sentence so its digits cannot
  // contaminate the 20-number window.
  const bullsEyeMatch = segment.match(/Bulls[-\u2010-\u2015\s]?eye\s+number\s+is\b[^0-9]{0,24}(\d{1,2})/i);
  const bullsEye = bullsEyeMatch ? Number(bullsEyeMatch[1]) : null;
  if (bullsEyeMatch) segment = segment.replace(bullsEyeMatch[0], ' ');

  const numbers = findDrawNumbers(segment, bullsEye);
  if (!numbers) return null;

  return {
    id: Number(drawNumber[1]),
    date: dateTime[1].trim(),
    time: dateTime[2].replace(/\s+/g, ' ').trim(),
    numbers,
    bullsEye,
  };
}

/** Structural validation. Returns a reason string when invalid, otherwise null. */
function validationError(draw) {
  if (!draw) return 'no draw parsed';
  if (!Number.isInteger(draw.id) || draw.id <= 0) return 'draw id missing';
  if (!Array.isArray(draw.numbers) || draw.numbers.length !== DRAWN_PER_DRAW) return 'expected 20 numbers';
  if (new Set(draw.numbers).size !== DRAWN_PER_DRAW) return 'duplicate numbers';
  if (!draw.numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= POOL_SIZE)) return 'number out of range';
  if (draw.bullsEye !== null) {
    if (!Number.isInteger(draw.bullsEye)) return 'bulls-eye not an integer';
    // The Bulls-eye is always one of the 20 drawn numbers; if it is not, we
    // mis-parsed something and must not trust the record.
    if (!draw.numbers.includes(draw.bullsEye)) return 'bulls-eye not among drawn numbers';
  }
  return null;
}

const isValidDraw = (draw) => validationError(draw) === null;

function drawUrl(id) {
  const url = new URL(SOURCE_URL);
  if (id) url.searchParams.set('query', String(id));
  // Cache-buster: the source sits behind a CDN that will happily serve a stale
  // page for the "latest draw" request.
  url.searchParams.set('_v', Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  return url;
}

/**
 * Fetch a single draw. `id === null` returns the most recent draw.
 * `cache` is an optional Map shared across one invocation so repeated lookups
 * (backfill then tracking, in the same worker run) do not re-hit the source.
 */
async function getDraw(id, { deadline = null, cache = null } = {}) {
  if (id && cache?.has(id)) return cache.get(id);

  const response = await fetchWithRetry(drawUrl(id), {
    attempts: FETCH_ATTEMPTS,
    timeoutMs: FETCH_TIMEOUT_MS,
    deadline,
  });

  const draw = parseDrawPage(await response.text());
  const problem = validationError(draw);
  if (problem) throw new Error(`Could not read draw${id ? ` ${id}` : ''} from the source page (${problem})`);
  if (id && draw.id !== id) throw new Error(`Source returned draw ${draw.id} when ${id} was requested`);

  if (cache) cache.set(draw.id, draw);
  return draw;
}

/**
 * Fetch many draws concurrently. Unlike the original, a failure on one id no
 * longer aborts the batch: successes are returned and failures are reported, so
 * one bad page cannot wipe out an entire worker run.
 */
async function getDraws(ids, { deadline = null, cache = null, concurrency = FETCH_CONCURRENCY } = {}) {
  const settled = await mapLimit(ids, concurrency, async (id) => {
    if (deadline?.spent(1500)) return { id, skipped: true };
    try {
      return { id, draw: await getDraw(id, { deadline, cache }) };
    } catch (error) {
      return { id, error: error.message };
    }
  });

  return {
    draws: settled.filter((r) => r.draw).map((r) => r.draw).sort((a, b) => a.id - b.id),
    failed: settled.filter((r) => r.error).map(({ id, error }) => ({ id, error })),
    skipped: settled.filter((r) => r.skipped).map((r) => r.id),
  };
}

/** Score a draw against a chosen group. */
function score(draw, group) {
  const drawn = new Set(draw.numbers);
  const hit = group.filter((n) => drawn.has(n));
  const bullsEye = Number.isInteger(draw.bullsEye) ? draw.bullsEye : null;
  return {
    count: hit.length,
    hit,
    bullsEye,
    bullsEyeMatch: bullsEye !== null && group.includes(bullsEye),
  };
}

module.exports = {
  htmlToText, decodeEntities, ascendingRuns, findDrawNumbers, parseDrawPage,
  validationError, isValidDraw, drawUrl, getDraw, getDraws, score,
};
