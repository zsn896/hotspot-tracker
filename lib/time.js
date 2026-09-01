'use strict';

const { SCHEDULE, DRAW_INTERVAL_MIN } = require('./config');

const TZ = 'America/Los_Angeles';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

/** Current wall-clock in California, decomposed. */
function californiaNowParts(date = new Date()) {
  const out = {};
  for (const p of partsFormatter.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  const hour = Number(out.hour);
  const minute = Number(out.minute);
  return {
    dateKey: `${out.year}-${out.month}-${out.day}`,
    hour,
    minute,
    second: Number(out.second),
    minutes: hour * 60 + minute,
    iso: date.toISOString(),
  };
}

function previousDateKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d) - 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

/**
 * A "cycle" runs 06:00 -> 05:59 the next morning. Anything before 06:00 still
 * belongs to yesterday's cycle.
 */
function cycleDateKey(now) {
  return now.minutes < SCHEDULE.collectionStart ? previousDateKey(now.dateKey) : now.dateKey;
}

/**
 * Which phase of the daily cycle are we in?
 *   02:00-02:30 idle     (tracking finished, waiting for the wipe)
 *   02:30-06:00 cleanup  (data deleted, waiting for the next cycle)
 *   06:00-18:00 collecting
 *   18:00-02:00 preparing -> tracking (once groups exist)
 */
function scheduleMode(minutes, hasGroups = false) {
  const { cleanup, collectionStart, trackingEnd } = SCHEDULE;
  if (minutes >= cleanup && minutes < collectionStart) return 'cleanup';
  if (minutes >= trackingEnd && minutes < cleanup) return 'idle';
  if (minutes >= collectionStart && minutes < SCHEDULE.selection) return 'collecting';
  return hasGroups ? 'tracking' : 'preparing';
}

/** "6:04 p.m." / "6:04 PM" -> minutes past midnight. */
function parseDrawMinutes(timeText) {
  const m = String(timeText || '').toLowerCase().match(/(\d{1,2}):(\d{2})\s*([ap])/);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3] === 'p') h += 12;
  return h * 60 + Number(m[2]);
}

function formatMinutes(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const ap = Math.floor(m / 60) >= 12 ? 'PM' : 'AM';
  const h = Math.floor(m / 60) % 12 || 12;
  return `${h}:${String(m % 60).padStart(2, '0')} ${ap}`;
}

/**
 * Project a clock time for a draw id, anchored on a known (id, time) pair.
 * Assumes the 4-minute cadence, which holds inside a single 06:00-02:00 session.
 */
function projectDrawTime(targetId, anchorId, anchorMinutes) {
  if (!Number.isFinite(targetId) || !Number.isFinite(anchorId) || anchorMinutes == null) return null;
  return formatMinutes(anchorMinutes + (targetId - anchorId) * DRAW_INTERVAL_MIN);
}

module.exports = {
  TZ,
  californiaNowParts,
  previousDateKey,
  cycleDateKey,
  scheduleMode,
  parseDrawMinutes,
  formatMinutes,
  projectDrawTime,
};
