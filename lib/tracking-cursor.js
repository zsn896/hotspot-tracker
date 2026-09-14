'use strict';

function cursorUpdatePath(group, drawId) {
  if (!Number.isSafeInteger(Number(drawId)) || !Number.isSafeInteger(Number(group.start_draw_id))) {
    throw new RangeError('Invalid tracking cursor');
  }
  // A slower request must not rewind a newer cursor or update a reset cycle.
  return `tracker_groups?id=eq.${encodeURIComponent(group.id)}` +
    `&start_draw_id=eq.${Number(group.start_draw_id)}` +
    `&or=(last_seen_draw_id.is.null,last_seen_draw_id.lt.${Number(drawId)})`;
}

function trackingEnd(group, latestId) {
  const name = String(group.name || '');
  if (!name.startsWith('AUTO Group ')) return Number(latestId);
  const size = name === 'AUTO Group Five' || name === 'AUTO Group Six' ? 20 : 120;
  return Math.min(Number(latestId), Number(group.start_draw_id) + size);
}

module.exports = { cursorUpdatePath, trackingEnd };
