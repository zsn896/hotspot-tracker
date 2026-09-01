'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/lottery');

const NUMBERS = [3, 7, 11, 14, 18, 22, 26, 29, 33, 38, 41, 45, 50, 54, 58, 61, 66, 70, 74, 79];

function page({ id = 1234567, numbers = NUMBERS, bullsEye = 41, extra = '' } = {}) {
  return `<!doctype html><html><head><style>.a{width:20px}</style>
    <script>var config={retries:20,pool:80};</script></head><body>
    <h1>Hot Spot</h1>
    <p>Draw Number: ${id}</p>
    <p>Draw Date: Mon, Jun 3, 2026 | Draw Time: 6:04 p.m.</p>
    ${extra}
    <ul>${numbers.map((n) => `<li class="ball">${n}</li>`).join('')}</ul>
    <p>The Bulls-eye number is ${bullsEye}.</p>
    <p>Check out the Hot Spot payouts: 1 in 9.05 overall odds, $2 wager.</p>
    </body></html>`;
}

test('parses a well-formed results page', () => {
  const draw = L.parseDrawPage(page());
  assert.equal(draw.id, 1234567);
  assert.equal(draw.time, '6:04 p.m.');
  assert.deepEqual(draw.numbers, NUMBERS);
  assert.equal(draw.bullsEye, 41);
  assert.equal(L.validationError(draw), null);
});

test('ignores numbers hidden in script and style blocks', () => {
  // "retries:20" and "width:20px" would both be picked up by a naive scan.
  const draw = L.parseDrawPage(page());
  assert.deepEqual(draw.numbers, NUMBERS);
});

test('survives stray numbers between the header and the balls', () => {
  // This is the regression: the old parser took the first 20 integers, so a
  // leading "12" shifted the window and the draw was silently dropped.
  const draw = L.parseDrawPage(page({ extra: '<span class="tag">Match 12 of 20 to win</span>' }));
  assert.ok(draw, 'draw should still parse');
  assert.deepEqual(draw.numbers, NUMBERS);
});

test('keeps the Bulls-eye out of the 20-number window', () => {
  const draw = L.parseDrawPage(page({ extra: '<p>The Bulls-eye number is 41.</p>' }));
  assert.deepEqual(draw.numbers, NUMBERS);
  assert.equal(draw.bullsEye, 41);
});

test('decodes HTML entities in the text layer', () => {
  assert.equal(L.htmlToText('a&nbsp;&amp;&nbsp;b'), 'a & b');
  assert.equal(L.decodeEntities('&#65;&#x42;'), 'AB');
});

test('accepts a page with no Bulls-eye announced', () => {
  const html = page().replace(/<p>The Bulls-eye number is \d+\.<\/p>/, '');
  const draw = L.parseDrawPage(html);
  assert.equal(draw.bullsEye, null);
  assert.equal(L.validationError(draw), null);
});

test('rejects a Bulls-eye that is not one of the drawn numbers', () => {
  const draw = L.parseDrawPage(page({ bullsEye: 2 }));
  assert.equal(L.validationError(draw), 'bulls-eye not among drawn numbers');
});

test('rejects pages that are not draw results', () => {
  assert.equal(L.parseDrawPage('<html><body>Service unavailable</body></html>'), null);
  assert.equal(L.parseDrawPage('<html><body>Draw Number: 1234567</body></html>'), null);
  assert.equal(L.validationError(null), 'no draw parsed');
});

test('rejects a short number list instead of guessing', () => {
  assert.equal(L.parseDrawPage(page({ numbers: NUMBERS.slice(0, 12) })), null);
});

test('findDrawNumbers prefers the ascending run', () => {
  const text = `99 ${NUMBERS.join(' ')} 4 4 4`;
  assert.deepEqual(L.findDrawNumbers(text), NUMBERS);
});

test('scoring counts hits and Bulls-eye matches', () => {
  const draw = { numbers: NUMBERS, bullsEye: 41 };
  const s = L.score(draw, [3, 41, 60, 62, 79]);
  assert.equal(s.count, 3);
  assert.deepEqual(s.hit, [3, 41, 79]);
  assert.equal(s.bullsEyeMatch, true);

  const miss = L.score(draw, [2, 4, 60, 62, 63]);
  assert.equal(miss.count, 0);
  assert.equal(miss.bullsEyeMatch, false);
});

test('drawUrl targets the requested draw and busts the CDN cache', () => {
  const url = L.drawUrl(1234567);
  assert.equal(url.searchParams.get('query'), '1234567');
  assert.ok(url.searchParams.get('_v'));
  assert.equal(L.drawUrl(null).searchParams.has('query'), false);
});
