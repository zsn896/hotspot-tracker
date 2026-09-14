'use strict';

const { db } = require('./lib');
const { loadManualSummary } = require('../lib/manual-summary');

const MANUAL_NAMES = [
  'MANUAL Group',
  'MANUAL Group 2',
  'MANUAL Group 3'
];

function slotForName(name) {
  if (name === 'MANUAL Group') return 1;
  if (name === 'MANUAL Group 2') return 2;
  if (name === 'MANUAL Group 3') return 3;
  return 0;
}


module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store,max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const latestRows = await db(
      'hotspot_draws?select=draw_id,draw_date,draw_time&order=draw_id.desc&limit=1'
    );
    const latestDrawId = Number(latestRows?.[0]?.draw_id || 0);

    const rows = (
      await db(
        'tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&name=in.(MANUAL%20Group,MANUAL%20Group%202,MANUAL%20Group%203)&order=id.desc&limit=300'
      )
    ) || [];

    const selected = [];
    const seen = new Set();

    for (const group of rows) {
      const name = String(group?.name || '');

      if (!MANUAL_NAMES.includes(name) || seen.has(name)) {
        continue;
      }

      seen.add(name);
      selected.push(group);
    }

    const groups = [];

    for (const group of selected) {
      const startDrawId = Number(group.start_draw_id || 0);
      const trackingLastSeenDrawId = Number(
        group.last_seen_draw_id ?? startDrawId ?? 0
      );

      const summary = await loadManualSummary(db, group);
      const lag = Math.max(0, latestDrawId - trackingLastSeenDrawId);

      groups.push({
        id: group.id,
        slot: slotForName(String(group.name || '')),
        name: group.name,
        numbers: Array.isArray(group.numbers)
          ? group.numbers.map(Number)
          : [],
        active: Boolean(group.active),
        startDrawId,
        trackingLastSeenDrawId,
        latestDrawId,
        lag,
        current: latestDrawId > 0 && lag === 0,
        ...summary
      });
    }

    groups.sort((a, b) => a.slot - b.slot);

    return res.status(200).json({
      ok: true,
      latestDrawId,
      groups
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
};
