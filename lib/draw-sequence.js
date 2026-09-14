'use strict';

// A tracking cursor may advance only through a complete, verified prefix.
function contiguousDraws(rows, after, end, idField = 'draw_id') {
  if (!Number.isSafeInteger(Number(after)) || !Number.isSafeInteger(Number(end))) return [];
  const byId = new Map();
  for (const row of rows || []) {
    const id = Number(row?.[idField]);
    const nums = row?.numbers;
    if (Number.isSafeInteger(id) && id > after && id <= end &&
        Array.isArray(nums) && nums.length === 20 && new Set(nums).size === 20 &&
        nums.every(n => Number.isInteger(n) && n >= 1 && n <= 80)) byId.set(id, row);
  }
  const out = [];
  for (let id = Number(after) + 1; id <= Number(end); id++) {
    if (!byId.has(id)) break;
    out.push(byId.get(id));
  }
  return out;
}

module.exports = { contiguousDraws };
