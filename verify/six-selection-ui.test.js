'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { expandedDocument, inlineScripts } = require('./html-shell');
const { selectRecentSix } = require('../lib/six-recent');
const { summarizeCycle } = require('../lib/six-tracking');
const numbers = [1, 2, 3, 4, 5];
const groups = Array.from({ length: 6 }, () => ({ numbers }));
const draws = Array.from({ length: 50 }, (_, i) => ({
  draw_id: 101 + i, draw_date: '2026-09-20', draw_time: '10:00 a.m.',
  numbers: [...numbers, ...Array.from({ length: 15 }, (_, n) => 40 + n)]
}));
const analysis = selectRecentSix(groups, draws, 150);
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('real expanded shell shows separate historical phases in a closed explanation', async t => {
  const scripts = inlineScripts(await expandedDocument());
  const script = scripts.find(s => s.includes('function sixSelectionEvidenceHtml'));
  const context = { esc: String, analysis };
  vm.createContext(context);
  vm.runInContext(script.slice(script.indexOf('function sixSelectionEvidenceHtml'), script.indexOf('function sixGeneratorHtml')), context);
  const dom = new JSDOM(vm.runInContext('sixSelectionEvidenceHtml(analysis)', context));
  t.after(() => dom.window.close());
  const detail = dom.window.document.querySelector('details');
  assert.equal(detail.open, false);
  assert.match(detail.querySelector('summary').textContent, /ترشيح 30 \/ مفاضلة 20/);
  assert.match(detail.textContent, /101 – 130/); assert.match(detail.textContent, /131 – 150/);
  assert.match(detail.textContent, /هذه أرقام تاريخية وليست نسبة دقة أو إصابات مستقبلية/);
  assert.match(detail.textContent, /قورنت جميع الخماسيات المؤهلة/);
  assert.match(detail.textContent, /دون حد أقصى لعدد المرشحين/);
  assert.equal(dom.window.document.querySelectorAll('button,table,.sixGeneratorBall').length, 0);
  context.analysis = { selectionRule: 'fixed-core-conditional-v3', core: [1, 2, 3], coreEvidence: { count: 4 }, companionEvidence: [] };
  assert.match(vm.runInContext('sixSelectionEvidenceHtml(analysis)', context), /الثلاثية الثابتة/);
  context.analysis = { selectionRule: 'whole-five-temporal-30-20-v4', shortlistSize: 20, shortlistLimit: 20 };
  const legacy = vm.runInContext('sixSelectionEvidenceHtml(analysis)', context);
  assert.match(legacy, /خماسية كحد أقصى 20/);
  assert.doesNotMatch(legacy, /قورنت جميع الخماسيات المؤهلة/);
});

test('booted page keeps manual analyze/generate/start flow and freezes v5 selections across reloads', async t => {
  const html = await expandedDocument(), requests = [], errors = [], pages = [];
  let storage = {}, latest = 158, selected = analysis;
  t.after(() => pages.forEach(dom => dom.window.close()));
  async function reopen() {
    const vc = new VirtualConsole();
    vc.on('jsdomError', error => errors.push(error.message));
    const dom = new JSDOM(html, {
      url: 'https://hotspot.test/', runScripts: 'dangerously', virtualConsole: vc,
      beforeParse(w) {
        w.setInterval = () => 0; w.setTimeout = () => 0;
        for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
        w.fetch = async url => {
          requests.push(String(url));
          let response;
          if (url.includes('mode=six-manual-groups')) response = { ok: true, analysis: selected };
          else if (url.includes('mode=tracking-start')) response = { ok: true, latestDrawId: latest };
          else if (url.includes('mode=tracking&')) {
            const cycle = JSON.parse(w.localStorage.getItem('hotspot_group_six_cycle_v1'));
            const rows = Array.from({ length: latest - cycle.startDrawId }, (_, i) => ({
              draw_id: cycle.startDrawId + i + 1, draw_date: '2026-09-20', draw_time: '11:00 a.m.',
              numbers: [1, 2, 3, ...Array.from({ length: 17 }, (_, n) => 40 + n)]
            }));
            response = { ok: true, ...summarizeCycle(cycle.numbers, cycle.startDrawId, latest, rows) };
          } else response = {
            ok: true, mode: 'collecting', groups: [], manuals: [], manual: null,
            groupFive: { numbers, wave: { state: 'DORMANT' } }, latestDrawId: latest, analysisWindow: 50,
            latest: { id: latest, draw_id: latest, numbers: draws[0].numbers },
            synced: false, caughtUp: true, officialDrawId: latest, storedDrawId: latest
          };
          return { ok: true, status: 200, json: async () => response };
        };
      }
    });
    pages.push(dom);
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await flush();
    return dom.window;
  }
  function close(w) {
    storage = Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => {
      const key = w.localStorage.key(i); return [key, w.localStorage.getItem(key)];
    }));
    w.close();
  }
  const picked = w => Array.from(w.document.querySelectorAll('.sixGeneratorBall'), e => Number(e.textContent));
  const selectionCalls = () => requests.filter(url => url.includes('mode=six-manual-groups')).length;

  let w = await reopen();
  assert.equal(selectionCalls(), 0, 'opening the page must not analyze automatically');
  w.document.getElementById('groupSixAnalyze').click(); await flush();
  assert.equal(selectionCalls(), 1);
  assert.deepEqual(picked(w), [], 'analysis must wait for the generate button');
  assert.match(w.document.querySelector('.sixGenerator').textContent, /ترشيح 30 \/ مفاضلة 20/);
  w.document.getElementById('groupSixGenerate').click(); await flush();
  assert.deepEqual(picked(w), numbers);
  assert.equal(w.document.getElementById('groupSixCounters'), null, 'historical evidence is not tracking');
  close(w);

  selected = { ...analysis, numbers: [6, 7, 8, 9, 10] };
  w = await reopen();
  assert.deepEqual(picked(w), numbers);
  assert.equal(selectionCalls(), 1);
  w.document.getElementById('groupSixStart').click(); await flush();
  const cycle = JSON.parse(w.localStorage.getItem('hotspot_group_six_cycle_v1'));
  assert.equal(cycle.startDrawId, 158); assert.equal(cycle.endDrawId, 178);
  assert.equal(cycle.analysis.selectionRule, 'whole-five-all-eligible-30-20-v5');
  assert.match(w.document.getElementById('groupSixCounters').textContent, /المتبقي20/);
  close(w);

  latest = 159;
  w = await reopen();
  assert.deepEqual(picked(w), numbers);
  assert.equal(selectionCalls(), 1);
  assert.match(w.document.getElementById('groupSixCounters').textContent, /المتبقي19/);
  assert.match(w.document.getElementById('groupSixCounters').textContent, /مطابقة آخر سحبة3/);
  assert.equal(JSON.parse(w.localStorage.getItem('hotspot_group_six_cycle_v1')).endDrawId, 178);
  const rows = w.document.querySelectorAll('#groupSixCounters tbody tr');
  assert.equal(rows.length, 1); assert.match(rows[0].textContent, /159/);
  assert.equal(rows[0].closest('details').open, false);
  assert.deepEqual(errors, []);
});
