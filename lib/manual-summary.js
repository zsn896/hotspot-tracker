'use strict';

const { readPages } = require('./db-pages');

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
      hit >= 3 && drawId > 0 &&
      (out.lastStrongDrawId == null || drawId > out.lastStrongDrawId)
    ) {
      out.lastStrongDrawId = drawId;
    }
  }

  return out;
}

async function loadManualSummary(db, group) {
  const start = Number(group.start_draw_id || 0);
  const limit = 5000;
  const rows = await readPages(db,
    `tracker_results?select=draw_id,hit_count&group_id=eq.${group.id}&draw_id=gt.${start}&hit_count=gte.3&order=draw_id.desc`,
    { limit });
  return { ...summarize(rows), summaryCapped: rows.length === limit };
}

module.exports = { summarize, loadManualSummary };
