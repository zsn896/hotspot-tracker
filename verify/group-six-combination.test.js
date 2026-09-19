'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { combineSixManualGroups } = require('../api/group-six');

test('six-group combiner keeps shared core and adds two frequency leaders', () => {
  const groups = [
    { numbers: [1, 2, 3, 10, 11] },
    { numbers: [1, 2, 3, 12, 13] },
    { numbers: [1, 2, 3, 14, 15] },
    { numbers: [1, 2, 4, 10, 16] },
    { numbers: [1, 2, 5, 10, 17] },
    { numbers: [1, 2, 6, 10, 18] }
  ];
  const result = combineSixManualGroups(groups);
  assert.equal(result.ok, true);
  assert.deepEqual(result.core, [1, 2, 10]);
  assert.equal(result.numbers.length, 5);
  assert.deepEqual(result.additions, [3, 4]);
});

test('six-group combiner refuses fewer than six source groups', () => {
  const result = combineSixManualGroups([{ numbers: [1, 2, 3, 4, 5] }]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'six-active-strong-manual-groups-required');
});
