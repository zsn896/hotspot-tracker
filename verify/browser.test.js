'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { wrap } = require('node:module');
const { execFileSync } = require('node:child_process');
const { JSDOM, VirtualConsole } = require('jsdom');
const { expandedDocument, inlineScripts } = require('./html-shell');
const root = path.resolve(__dirname, '..');

test('all project JavaScript and the real two-stage HTML shell parse', async () => {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {cwd:root,encoding:'utf8'}).trim().split('\n'))];
  let checked = 0;
  for (const file of files) {
    if (!/\.(js|html)$/.test(file)) continue;
    const source = fs.readFileSync(path.join(root,file),'utf8');
    const scripts = file.endsWith('.js') ? [wrap(source)] : inlineScripts(source);
    for (const script of scripts) { new vm.Script(script, {filename:file}); checked++; }
  }
  for (const source of inlineScripts(await expandedDocument())) new vm.Script(source);
  assert.ok(checked >= 35);
});

test('the real booted page renders correct manual metrics, sync lag and editing state', async t => {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(await expandedDocument(), {
    url: 'https://hotspot.test/', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(window) {
      window.setInterval = () => 0;
      window.setTimeout = () => 0;
      window.fetch = async () => ({ok:true,status:200,json:async()=>({
        ok:true,mode:'collecting',groups:[],manuals:[],manual:null,
        latest:{id:100,draw_id:100,numbers:Array.from({length:20},(_,i)=>i+1)},
        synced:false,caughtUp:true,officialDrawId:100,storedDrawId:100
      })});
    }
  });
  t.after(() => dom.window.close());
  for (let i=0;i<5;i++) await new Promise(resolve=>setImmediate(resolve));
  const w=dom.window, doc=w.document;
  assert.equal(typeof w.renderManualSlot, 'function');
  assert.equal(doc.getElementById('refresh').disabled, false, 'initial refresh should finish');
  const manual={active:true,numbers:[1,2,3,4,5],startDrawId:100,trackingLastSeenDrawId:300,
    threePlus:1500,bestHit:5,bestResult:{hitCount:5,drawId:120,time:'6:20 p.m.'},
    lastSeenResult:{hitCount:3,drawId:300,time:'7:00 p.m.'},
    matches:[{draw_id:300,hit_count:3,hit_numbers:[1,2,3],time:'7:00 p.m.'}]};
  w.renderManualSlot(1,manual);
  const metrics=doc.querySelectorAll('#manualContent1 .manualMetricValue');
  assert.equal(metrics[0].textContent.trim(),'5/5');
  assert.equal(metrics[1].textContent.trim(),'1500');
  assert.equal(metrics[2].textContent.trim(),'300');
  assert.equal(doc.querySelector('#manualContent1 .bestTime').textContent.trim(),'6:20 p.m.');
  w.renderSyncInfo({ok:true,synced:false,caughtUp:false,drawLag:9});
  assert.ok(doc.getElementById('syncInfo').classList.contains('warn'));
  assert.match(doc.getElementById('syncInfo').textContent,/9/);
  doc.getElementById('m1_1').focus();
  doc.getElementById('m1_2').value='79';
  w.renderManualSlot(1,manual);
  assert.equal(doc.getElementById('m1_2').value,'79');
  assert.deepEqual(errors,[]);
});
