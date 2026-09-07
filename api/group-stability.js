'use strict';

const { db } = require('./lib');

const PAGE_SIZE = 1000;
const DRAWS_PER_DAY = 300;
const MAX_DAYS = 180;

function norm(values) {
  return [...new Set((values || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function parseGroup(raw) {
  const group = norm(String(raw || '').split(/[^0-9]+/).filter(Boolean));
  return group.length === 5 ? group : null;
}

async function loadRows(limit) {
  const out = [];
  for (let offset = 0; offset < limit; offset += PAGE_SIZE) {
    const take = Math.min(PAGE_SIZE, limit - offset);
    const page = (
      await db(
        `hotspot_draws?select=draw_id,draw_date,draw_time,numbers&order=draw_id.desc&limit=${take}&offset=${offset}`
      )
    ) || [];
    if (!page.length) break;
    out.push(...page);
    if (page.length < take) break;
  }
  return out.filter(row => Number.isFinite(Number(row?.draw_id)) && norm(row?.numbers).length === 20);
}

function rankMap(map, total) {
  return [...map.entries()]
    .map(([number, count]) => ({
      number: Number(number),
      count: Number(count),
      rate: total ? Number((count / total).toFixed(6)) : 0
    }))
    .sort((a, b) => b.count - a.count || a.number - b.number);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store,max-age=0');

  try {
    const group = parseGroup(req.query?.numbers);
    if (!group) {
      return res.status(400).json({ ok: false, error: 'numbers must contain exactly five unique values 1-80' });
    }

    const requestedDays = Number(req.query?.days || MAX_DAYS);
    const days = Math.max(1, Math.min(MAX_DAYS, Number.isFinite(requestedDays) ? Math.floor(requestedDays) : MAX_DAYS));
    const wanted = days * DRAWS_PER_DAY;
    const rows = await loadRows(wanted);
    const groupSet = new Set(group);

    const distribution = { zero: 0, one: 0, two: 0, three: 0, four: 0, five: 0 };
    const memberStrong = new Map(group.map(n => [n, 0]));
    const memberFourPlus = new Map(group.map(n => [n, 0]));
    const companionStrong = new Map();
    const companionExact5 = new Map();
    const strongEvents = [];
    const exact5Events = [];

    for (const row of rows) {
      const nums = norm(row.numbers);
      const set = new Set(nums);
      const hit = group.filter(n => set.has(n));
      const hits = hit.length;
      if (hits === 0) distribution.zero++;
      else if (hits === 1) distribution.one++;
      else if (hits === 2) distribution.two++;
      else if (hits === 3) distribution.three++;
      else if (hits === 4) distribution.four++;
      else distribution.five++;

      if (hits >= 3) {
        hit.forEach(n => memberStrong.set(n, (memberStrong.get(n) || 0) + 1));
        for (const n of nums) {
          if (!groupSet.has(n)) companionStrong.set(n, (companionStrong.get(n) || 0) + 1);
        }
        strongEvents.push({ drawId: Number(row.draw_id), date: row.draw_date || '', time: row.draw_time || '', hits, hitNumbers: hit });
      }

      if (hits >= 4) {
        hit.forEach(n => memberFourPlus.set(n, (memberFourPlus.get(n) || 0) + 1));
      }

      if (hits === 5) {
        const companions = nums.filter(n => !groupSet.has(n));
        companions.forEach(n => companionExact5.set(n, (companionExact5.get(n) || 0) + 1));
        exact5Events.push({ drawId: Number(row.draw_id), date: row.draw_date || '', time: row.draw_time || '', companions });
      }
    }

    const threePlus = distribution.three + distribution.four + distribution.five;
    const fourPlus = distribution.four + distribution.five;
    const exact5 = distribution.five;

    return res.status(200).json({
      ok: true,
      days,
      requestedDraws: wanted,
      analyzedDraws: rows.length,
      newestDrawId: rows[0] ? Number(rows[0].draw_id) : null,
      oldestDrawId: rows.at(-1) ? Number(rows.at(-1).draw_id) : null,
      group,
      distribution,
      threePlus,
      fourPlus,
      exact5,
      memberStabilityThreePlus: rankMap(memberStrong, threePlus),
      memberStabilityFourPlus: rankMap(memberFourPlus, fourPlus),
      topCompanionsThreePlus: rankMap(companionStrong, threePlus).slice(0, 20),
      topCompanionsExact5: rankMap(companionExact5, exact5).slice(0, 20),
      strongEvents: strongEvents.slice(0, 100),
      exact5Events: exact5Events.slice(0, 100)
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
