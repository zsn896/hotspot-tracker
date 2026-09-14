'use strict';

// Supabase caps individual responses; a large limit alone is not pagination.
async function readPages(db, path, { limit = 5000, pageSize = 1000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError('Pagination limits must be positive integers');
  }
  const [table, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  const initialOffset = Number(params.get('offset') || 0);
  if (!Number.isSafeInteger(initialOffset) || initialOffset < 0) throw new RangeError('Invalid page offset');
  const rows = [];
  while (rows.length < limit) {
    const take = Math.min(pageSize, 1000, limit - rows.length);
    params.set('limit', String(take));
    params.set('offset', String(initialOffset + rows.length));
    const page = await db(`${table}?${params}`) || [];
    if (!Array.isArray(page)) throw new Error('Expected an array of database rows');
    rows.push(...page.slice(0, take));
    if (page.length < take) break;
  }
  return rows;
}

module.exports = { readPages };
