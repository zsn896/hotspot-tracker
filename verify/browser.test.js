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

test('forward panel distinguishes evidence, empty records, disabled recording and failed refresh',async t=>{
  const dom=new JSDOM(await expandedDocument(),{url:'https://hotspot.test/',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  const w=dom.window;
  const mount=w.document.createElement('section');
  mount.id='forwardLedger';
  w.document.body.appendChild(mount);
  w.setInterval=()=>0;
  w.AbortSignal=globalThis.AbortSignal;
  let fail=false;
  const report={ok:true,recording:{enabled:true},generatedAt:'2026-09-14T00:00:00Z',
    overall:{episodes:100,successes:8,failures:92,expectedByChance:6.21,observedRate:.08,confidenceInterval:[.04,.15],lift:1.29,significant:false},
    chanceModel:{windowRate:.062084},openEpisodes:2,sample:{},byTarget:[],
    recentEpisodes:[{target:'<img src=x onerror=alert(1)>',startDrawId:100,endDrawId:105,recordedAt:'2026-09-14T00:00:00Z',resolved:false,matchesWindow:true,success:null}]};
  w.fetch=async()=>({ok:!fail,json:async()=>fail?{ok:false}:report});
  w.eval(fs.readFileSync(path.join(root,'ledger-panel.js'),'utf8'));
  const flush=async()=>{for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));};
  await flush();
  const panel=w.document.getElementById('forwardLedger');
  assert.match(panel.textContent,/لم تثبت أفضلية/);
  assert.match(panel.textContent,/8.00٪/);
  assert.match(panel.textContent,/6.21٪/);
  assert.match(panel.textContent,/معلّقة/);
  assert.equal(panel.querySelectorAll('img').length,0);
  assert.equal(panel.querySelector('.ledger-bar.observed i').style.width,'8%');
  assert.match(panel.textContent,/لا يمثلان احتمال فوز/);
  report.overall.significant=true;
  panel.querySelector('button').click();await flush();
  assert.match(panel.textContent,/تفوق ظاهري/);
  report.overall.episodes=0;report.overall.successes=0;report.overall.failures=0;report.overall.expectedByChance=0;
  report.recording.enabled=false;
  panel.querySelector('button').click();await flush();
  assert.match(panel.textContent,/لا توجد نتائج محسومة/);
  assert.match(panel.textContent,/التسجيل غير مفعّل/);
  assert.equal(panel.querySelector('.ledger-comparison'),null);
  fail=true;panel.querySelector('button').click();await flush();
  assert.match(panel.textContent,/تعذّر قراءة السجل/);
  assert.equal(panel.querySelector('.ledger-grid'),null,'failed fetch must not retain an apparently current verdict');
  assert.equal(panel.querySelector('button').disabled,false);
  fail=false;panel.querySelector('button').click();await flush();
  assert.match(panel.textContent,/لا توجد نتائج محسومة/);
});
