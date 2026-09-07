'use strict';

const { db } = require('./lib');

const PAGE_SIZE = 1000;
const MAX_DRAWS = 8000;
const DEFAULT_LOOKBACK = 10;

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function parseTarget(raw) {
  return norm(String(raw || '').split(/[^0-9]+/).filter(Boolean));
}

function matched(draw, target) {
  const set = new Set(norm(draw?.numbers));
  return target.filter(n => set.has(n));
}

function combinations3(values) {
  const a = norm(values);
  const out = [];
  for (let i = 0; i < a.length - 2; i++) {
    for (let j = i + 1; j < a.length - 1; j++) {
      for (let k = j + 1; k < a.length; k++) out.push([a[i], a[j], a[k]]);
    }
  }
  return out;
}

async function loadRows(limit = MAX_DRAWS) {
  const out = [];
  let offset = 0;
  while (out.length < limit) {
    const take = Math.min(PAGE_SIZE, limit - out.length);
    const rows = (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers,bulls_eye&order=draw_id.desc&limit=${take}&offset=${offset}`
      )
    ) || [];
    if (!rows.length) break;
    out.push(...rows);
    if (rows.length < take) break;
    offset += rows.length;
  }
  return out
    .filter(d => Number.isFinite(Number(d?.draw_id)) && norm(d?.numbers).length === 20)
    .sort((a, b) => Number(a.draw_id) - Number(b.draw_id));
}

function buildFiveStudy(rows, target, lookback) {
  const exactFiveIndexes = [];
  rows.forEach((draw, index) => {
    if (matched(draw, target).length === 5) exactFiveIndexes.push(index);
  });

  const eventGaps = [];
  for (let i = 1; i < exactFiveIndexes.length; i++) {
    eventGaps.push(Number(rows[exactFiveIndexes[i]].draw_id) - Number(rows[exactFiveIndexes[i - 1]].draw_id));
  }

  const precursorTripleStats = new Map();
  const targetNumberPresence = Object.fromEntries(target.map(n => [n, 0]));
  const priorHitCountDistribution = { zero: 0, one: 0, two: 0, three: 0, four: 0, five: 0 };

  const events = exactFiveIndexes.map((eventIndex, eventOrder) => {
    const event = rows[eventIndex];
    const start = Math.max(0, eventIndex - lookback);
    const prior = rows.slice(start, eventIndex);

    const timeline = prior.map((draw, i) => {
      const hitNumbers = matched(draw, target);
      const count = hitNumbers.length;
      const key = count === 0 ? 'zero' : count === 1 ? 'one' : count === 2 ? 'two' : count === 3 ? 'three' : count === 4 ? 'four' : 'five';
      priorHitCountDistribution[key]++;
      hitNumbers.forEach(n => { targetNumberPresence[n] = (targetNumberPresence[n] || 0) + 1; });

      return {
        lead: eventIndex - (start + i),
        drawId: Number(draw.draw_id),
        date: draw.draw_date || '',
        time: draw.draw_time || '',
        hitCount: count,
        matchedTarget: hitNumbers,
        numbers: norm(draw.numbers)
      };
    });

    // Count non-target precursor triples that appear 1-5 draws before exact 5/5 events.
    prior.slice(Math.max(0, prior.length - 5)).forEach((draw, localIndex, arr) => {
      const lead = arr.length - localIndex;
      combinations3(draw.numbers).forEach(triple => {
        const key = triple.join('-');
        const old = precursorTripleStats.get(key) || {
          numbers: triple,
          appearances: 0,
          eventIds: new Set(),
          leadCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
        };
        old.appearances++;
        old.eventIds.add(Number(event.draw_id));
        old.leadCounts[lead] = (old.leadCounts[lead] || 0) + 1;
        precursorTripleStats.set(key, old);
      });
    });

    const threePlus = timeline.filter(x => x.hitCount >= 3);
    const threePlusGaps = [];
    for (let i = 1; i < threePlus.length; i++) threePlusGaps.push(threePlus[i].drawId - threePlus[i - 1].drawId);

    return {
      order: eventOrder + 1,
      drawId: Number(event.draw_id),
      date: event.draw_date || '',
      time: event.draw_time || '',
      bullsEye: Number.isInteger(Number(event.bulls_eye)) ? Number(event.bulls_eye) : null,
      gapFromPreviousFive: eventOrder === 0 ? null : Number(event.draw_id) - Number(rows[exactFiveIndexes[eventOrder - 1]].draw_id),
      priorWindow: timeline,
      priorSummary: {
        lookbackDraws: timeline.length,
        threePlusCount: threePlus.length,
        fourPlusCount: timeline.filter(x => x.hitCount >= 4).length,
        maxHitBeforeFive: timeline.length ? Math.max(...timeline.map(x => x.hitCount)) : 0,
        nearestThreePlusLead: threePlus.length ? threePlus.at(-1).lead : null,
        threePlusGaps
      }
    };
  });

  const precursorTriples = [...precursorTripleStats.values()]
    .map(x => ({
      numbers: x.numbers,
      appearances: x.appearances,
      eventsCovered: x.eventIds.size,
      eventCoverage: exactFiveIndexes.length ? Number((x.eventIds.size / exactFiveIndexes.length).toFixed(4)) : 0,
      leadCounts: x.leadCounts
    }))
    .filter(x => x.eventsCovered >= 2)
    .sort((a, b) => b.eventsCovered - a.eventsCovered || b.appearances - a.appearances)
    .slice(0, 50);

  const totalPriorDraws = events.reduce((s, e) => s + e.priorWindow.length, 0);
  const targetPresence = target.map(n => ({
    number: n,
    appearances: targetNumberPresence[n] || 0,
    rate: totalPriorDraws ? Number(((targetNumberPresence[n] || 0) / totalPriorDraws).toFixed(4)) : 0
  })).sort((a, b) => b.appearances - a.appearances || a.number - b.number);

  return {
    exactFiveCount: events.length,
    eventGaps,
    events,
    aggregate: {
      lookbackDraws: lookback,
      totalPriorDraws,
      priorHitCountDistribution,
      targetPresence,
      recurringPrecursorTriples1to5: precursorTriples
    }
  };
}

module.exports = async function handler(req, res) {
  try {
    const target = parseTarget(req.query?.numbers || req.query?.set || '');
    if (target.length !== 5) {
      return res.status(400).json({ ok: false, reason: 'send-exactly-5-target-numbers' });
    }

    const requested = Number(req.query?.lookback || DEFAULT_LOOKBACK);
    const lookback = Math.max(1, Math.min(20, Number.isFinite(requested) ? Math.round(requested) : DEFAULT_LOOKBACK));
    const rows = await loadRows(MAX_DRAWS);
    const study = buildFiveStudy(rows, target, lookback);

    return res.status(200).json({
      ok: true,
      model: 'EXACT_5_OF_5_EVENT_STUDY_V1',
      target,
      noFutureLeakage: true,
      analyzedDraws: rows.length,
      range: rows.length ? {
        firstDrawId: Number(rows[0].draw_id),
        firstDate: rows[0].draw_date || '',
        lastDrawId: Number(rows.at(-1).draw_id),
        lastDate: rows.at(-1).draw_date || '',
        lastTime: rows.at(-1).draw_time || ''
      } : null,
      study,
      note: 'Descriptive historical study only. It exposes exact 5/5 events and the draws that occurred before them; it does not by itself prove predictive power.'
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
};
