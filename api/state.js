'use strict';

const C = require('../lib/config');
const DB = require('../lib/db');
const T = require('../lib/time');
const { groupTimingStats, blockReport, evaluateTracking } = require('../lib/analysis');
const { hitDistribution, fullHitProbability } = require('../lib/stats');

/** Did the projected next-appearance window actually contain a 5/5? */
function windowOutcome(analysis, rows) {
  if (!analysis?.expectedFromDrawId || !analysis?.expectedToDrawId) return 'not available';
  const hit = rows.find((r) => r.hit_count === C.GROUP_SIZE
    && r.draw_id >= analysis.expectedFromDrawId
    && r.draw_id <= analysis.expectedToDrawId);
  if (hit) return `matched at draw ${hit.draw_id}`;
  const last = rows[rows.length - 1]?.draw_id;
  if (!last || last < analysis.expectedFromDrawId) return 'window not reached yet';
  if (last > analysis.expectedToDrawId) return 'window passed without a 5/5';
  return 'inside the window now';
}

function compareStability(groups) {
  if (groups.length !== 2) return;
  const [a, b] = groups.map((g) => g.analysis?.coefficientVariation ?? Infinity);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return;
  if (Math.abs(a - b) < 0.03) {
    groups[0].analysis.stability = 'similar spacing';
    groups[1].analysis.stability = 'similar spacing';
  } else {
    groups[a < b ? 0 : 1].analysis.stability = 'more evenly spaced';
    groups[a < b ? 1 : 0].analysis.stability = 'more erratic';
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const now = T.californiaNowParts();
    const cycleKey = T.cycleDateKey(now);

    const controls = await DB.findGroups(C.CONTROL_PREFIX);
    let control = controls[controls.length - 1] || null;
    // A control row from a previous cycle must not be shown as if it were today's;
    // only the worker can actually reset it.
    const stale = Boolean(control && !String(control.name).endsWith(cycleKey));
    if (stale) control = null;

    let history = [];
    if (control) {
      const end = Number(control.start_draw_id) + C.COLLECTION_DRAWS - 1;
      history = await DB.getDrawRange(control.start_draw_id, end, C.COLLECTION_DRAWS);
    }

    const groupRows = await DB.findGroups(C.AUTO_PREFIX, { activeOnly: true });

    // Fetch every group's results, then resolve draw metadata in ONE query for
    // all of them instead of one query per group.
    const resultsByGroup = await Promise.all(groupRows.map((g) => DB.getResults(g.id)));
    const allIds = [...new Set(resultsByGroup.flat().map((r) => r.draw_id))];
    let meta = {};
    if (allIds.length) {
      const metaRows = await DB.db(
        `hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=in.(${allIds.join(',')})&limit=${allIds.length}`,
      );
      meta = Object.fromEntries((metaRows || []).map((d) => [d.draw_id, d]));
    }

    const groups = groupRows.map((group, i) => {
      const results = resultsByGroup[i].map((r) => ({
        ...r,
        date: meta[r.draw_id]?.draw_date || '',
        time: meta[r.draw_id]?.draw_time || '',
      }));

      const analysis = history.length >= C.COLLECTION_DRAWS
        ? groupTimingStats(history, group.numbers)
        : null;

      const completedBlocks = Math.floor(results.length / C.TRACKING_BLOCK_SIZE);
      const reports = [];
      for (let b = 1; b <= Math.min(completedBlocks, C.TRACKING_BLOCKS); b++) {
        const r = blockReport(results, b);
        if (r) reports.push(r);
      }

      if (analysis) analysis.windowOutcome = windowOutcome(analysis, results);

      return {
        id: group.id,
        name: group.name,
        numbers: group.numbers,
        analysis,
        performance: evaluateTracking(results),
        reports,
        currentBlock: {
          number: Math.min(C.TRACKING_BLOCKS, completedBlocks + 1),
          have: results.length % C.TRACKING_BLOCK_SIZE,
          need: C.TRACKING_BLOCK_SIZE,
          finished: results.length >= C.MAX_TRACKED_DRAWS,
        },
        results,
      };
    });

    compareStability(groups);

    const latestRows = await DB.getLatestStoredDraw();
    const have = Math.min(C.COLLECTION_DRAWS, history.length);

    // How often each of the 80 numbers came up during the collection window.
    // Drives the board on the dashboard, and is a useful reality check in its
    // own right: over 180 draws every number should land near 45.
    const boardFrequency = new Array(C.POOL_SIZE + 1).fill(0);
    for (const d of history) for (const n of d.numbers || []) boardFrequency[n]++;
    const expectedPerNumber = history.length
      ? +(history.length * C.DRAWN_PER_DRAW / C.POOL_SIZE).toFixed(1)
      : 0;

    res.status(200).json({
      ok: true,
      mode: T.scheduleMode(now.minutes, groups.length > 0),
      now: { minutes: now.minutes, cycle: cycleKey, timezone: T.TZ },
      schedule: {
        collection: '6:00 AM – 6:00 PM',
        selection: '6:00 PM',
        tracking: '6:00 PM – 2:00 AM',
        cleanup: '2:30 AM',
      },
      collection: {
        have,
        need: C.COLLECTION_DRAWS,
        remaining: Math.max(0, C.COLLECTION_DRAWS - have),
        startDrawId: control?.start_draw_id || null,
      },
      chanceModel: {
        poolSize: C.POOL_SIZE,
        drawnPerDraw: C.DRAWN_PER_DRAW,
        groupSize: C.GROUP_SIZE,
        hitProbabilities: hitDistribution(),
        expectedHitsPerDraw: 1.25,
        fullGroupOdds: Math.round(1 / fullHitProbability()),
      },
      workerStale: stale,
      workerMessage: stale
        ? 'No draws have been collected for the current cycle. This endpoint only reads data — schedule /api/worker to run every few minutes. See README.md.'
        : null,
      board: { frequency: boardFrequency, windowDraws: history.length, expectedPerNumber },
      selection: control?.notes || null,
      groups,
      latest: latestRows,
      blockSize: C.TRACKING_BLOCK_SIZE,
      totalBlocks: C.TRACKING_BLOCKS,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
};
