'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreCandidate } = require('../lib/production-signal');

function draw(id, includeTarget = false) {
  const target = [1, 2, 3, 4, 5];
  const numbers = includeTarget ? target.slice() : [];
  for (let n = 6 + ((id * 7) % 75); numbers.length < 20; n += 1) {
    const value = ((n - 1) % 80) + 1;
    if (!target.includes(value) && !numbers.includes(value)) numbers.push(value);
  }
  return { draw_id: id, numbers };
}

test('production selector abstains on a one-window spike', () => {
  const draws = Array.from({ length: 80 }, (_, index) => draw(index + 1, index === 79));
  const result = scoreCandidate(draws, [1, 2, 3, 4, 5]);
  assert.equal(result.status, 'ABSTAIN');
  assert.ok(result.stableWindows < 2);
});

test('production selector recognizes repeated multi-window evidence', () => {
  const draws = Array.from({ length: 80 }, (_, index) => draw(index + 1, (index + 1) % 8 === 0));
  const result = scoreCandidate(draws, [1, 2, 3, 4, 5]);
  assert.ok(['MEDIUM', 'STRONG'].includes(result.status));
  assert.equal(result.stableWindows, 3);
  assert.ok(result.evidenceScore >= 60);
});

test('production selector rejects a gapped archive', () => {
  const draws = Array.from({ length: 80 }, (_, index) => draw(index + 1));
  draws[40].draw_id = 400;
  const result = scoreCandidate(draws, [1, 2, 3, 4, 5]);
  assert.equal(result.status, 'ABSTAIN');
  assert.equal(result.reason, 'non-contiguous-draw-ids');
});
