'use strict';

const { db } = require('./lib');

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

function summarize(rows) {
  const out = {
    exact3: 0,
    exact4: 0,
    exact5: 0,
    threePlus: 0,
    fourPlus: 0,
    bestHit: 0,
    lastStrongDrawId: null
  };

  for (const row of rows || []) {
    const hit = Number(row?.hit_count || 0);
    const drawId = Number(row?.draw_id || 0);

    if (hit >= 3) out.threePlus++;
    if (hit >= 4) out.fourPlus++;
    if (hit === 3) out.exact3++;
    if (hit === 4) out.exact4++;
    if (hit >= 5) out.exact5++;

    out.bestHit = Math.max(out.bestHit, hit);

    if (
      drawId > 0 &&
      (out.lastStrongDrawId == null || drawId > out.lastStrongDrawId)
    ) {
      out.lastStrongDrawId = drawId;
    }
  }

  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store,max-age=0');

  try {
    const latestRows = await db(
      'hotspot_draws?select=draw_id,draw_date,draw_time&order=draw_id.desc&limit=1'
    );
    const latestDrawId = Number(latestRows?.[0]?.draw_id || 0);

    const rows = (
      await db(
        'tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&order=id.desc&limit=300'
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

      /*
        A manual cycle records only 3/5+ rows. Pull a generous result window so
        the counters represent the active cycle rather than just the 100 rows
        shown in the expandable UI list.
      */
      const resultRows = (
        await db(
          `tracker_results?select=draw_id,hit_count&group_id=eq.${group.id}` +
          `${startDrawId > 0 ? `&draw_id=gt.${startDrawId}` : ''}` +
          '&hit_count=gte.3&order=draw_id.desc&limit=5000'
        )
      ) || [];

      const summary = summarize(resultRows);
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
