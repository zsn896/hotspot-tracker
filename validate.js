'use strict';

const { POOL_SIZE, GROUP_SIZE } = require('./config');

/**
 * Normalise user-supplied numbers into a valid group, or null.
 * Returns null rather than throwing so callers can filter cleanly.
 */
function uniqueSortedGroup(values, size = GROUP_SIZE) {
  const nums = [...new Set((values || []).map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= POOL_SIZE)
    .sort((a, b) => a - b);
  return nums.length === size ? nums : null;
}

module.exports = { uniqueSortedGroup };
