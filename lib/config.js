'use strict';

/**
 * Single source of truth for every tunable in the project.
 * Anything that used to be a magic number duplicated across api/worker.js and
 * api/state.js lives here, so the two can never drift apart again.
 */

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// --- Game constants (fixed by the rules of California Hot Spot) ---
const POOL_SIZE = 80;       // numbers 1..80
const DRAWN_PER_DRAW = 20;  // 20 numbers drawn each draw
const GROUP_SIZE = 5;       // we track 5-number groups
const DRAW_INTERVAL_MIN = 4;

// --- Daily cycle, in minutes past midnight America/Los_Angeles ---
const SCHEDULE = {
  collectionStart: 6 * 60,   // 06:00 - start of the 12-hour collection window
  selection: 18 * 60,        // 18:00 - groups are chosen
  trackingEnd: 2 * 60,       // 02:00 (next day) - tracking stops
  cleanup: 2 * 60 + 30,      // 02:30 - daily wipe
};

const COLLECTION_DRAWS = int(process.env.COLLECTION_DRAWS, 180); // 12h / 4min

module.exports = {
  POOL_SIZE,
  DRAWN_PER_DRAW,
  GROUP_SIZE,
  DRAW_INTERVAL_MIN,
  SCHEDULE,
  COLLECTION_DRAWS,

  TRACKING_BLOCK_SIZE: 20,
  TRACKING_BLOCKS: 6,
  get MAX_TRACKED_DRAWS() { return this.TRACKING_BLOCK_SIZE * this.TRACKING_BLOCKS; },

  // Scraper
  SOURCE_URL: process.env.HOTSPOT_SOURCE_URL
    || 'https://www.calottery.com/en/draw-games/hot-spot/past-winning-numbers',
  SOURCE_LABEL: 'California Lottery (official results page)',
  FETCH_CONCURRENCY: int(process.env.FETCH_CONCURRENCY, 6),
  FETCH_TIMEOUT_MS: int(process.env.FETCH_TIMEOUT_MS, 12000),
  FETCH_ATTEMPTS: int(process.env.FETCH_ATTEMPTS, 3),

  // Worker execution budget. Vercel kills the function at maxDuration; we stop
  // cleanly a few seconds earlier so we can still commit progress and respond.
  WORKER_BUDGET_MS: int(process.env.WORKER_BUDGET_MS, 50000),
  WORKER_LOCK_TTL_MS: int(process.env.WORKER_LOCK_TTL_MS, 120000),

  // Analysis
  MAX_INTERSECTION_FOR_COMBOS: int(process.env.MAX_INTERSECTION_FOR_COMBOS, 12),
  ALPHA: 0.05,

  // Database naming
  CONTROL_PREFIX: 'AUTO_CONTROL_',
  AUTO_PREFIX: 'AUTO Group ',
  DB_BATCH_SIZE: int(process.env.DB_BATCH_SIZE, 100),
};
