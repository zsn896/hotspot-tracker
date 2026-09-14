'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');

// Load the real implementation with isolated dependencies; no production
// network, database, or credentials are used by these regression tests.
function load(file, dependencies = {}, internals = []) {
  const filename = path.join(root, file);
  const actualRequire = createRequire(filename);
  const localRequire = name => Object.hasOwn(dependencies, name)
    ? dependencies[name] : actualRequire(name);
  const module = { exports: {} };
  const source = fs.readFileSync(filename, 'utf8') +
    (internals.length ? `\nmodule.exports.__test = { ${internals.join(',')} };` : '');
  new Function('require', 'module', 'exports', '__filename', '__dirname', source)(
    localRequire, module, module.exports, filename, path.dirname(filename)
  );
  return module.exports;
}

function response() {
  return { statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
const draw = id => ({ draw_id: id, id, numbers, bullsEye: null, bulls_eye: null,
  date: 'September 13, 2026', draw_date: 'September 13, 2026', time: '6:00 p.m.', draw_time: '6:00 p.m.' });
const forecast = { status: 'STRONG', fourPlusScore: 80, expectedTier: '4_PLUS' };
const target = [1, 2, 3, 4, 5];
const forbidden = async () => { throw new Error('Unexpected external operation'); };

function setEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

for (const secret of [undefined, 'test-cron-secret']) {
  test(`POST sync rejects unauthenticated work before any I/O (${secret ? 'configured' : 'missing'} secret)`, async t => {
    setEnv(t, 'CRON_SECRET', secret || '');
    const handler = load('api/sync.js', { './lib': { getDraw: forbidden, db: forbidden }, './cron': forbidden });
    const res = response();
    await handler({ method: 'POST', headers: {}, query: {} }, res);
    assert.equal(res.statusCode, 401);
  });
}

test('worker fails closed when its secret is absent', async t => {
  setEnv(t, 'WORKER_SECRET', '');
  const handler = load('api/worker.js', { './lib': { californiaNowParts: () => ({minutes:180}), db: forbidden } });
  const res = response();
  await handler({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 401);
});

test('sync retains the newer official ID when the next stored draw is older', async () => {
  let storedId = 100;
  const db = async (url, init = {}) => {
    if (url.startsWith('hotspot_draws?on_conflict')) { storedId = init.body.draw_id; return null; }
    if (url.startsWith('hotspot_draws?')) return [{draw_id:storedId}];
    return [];
  };
  const handler = load('api/sync.js', { './lib': { db, getDraw: async id => draw(id || 110) }, './cron': forbidden });
  const res = response();
  await handler({ method:'GET', headers:{}, query:{} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.officialDrawId, 110);
  assert.equal(res.body.storedDrawId, 101);
  assert.equal(res.body.drawLag, 9);
  assert.equal(res.body.caughtUp, false);
});

test('live tracker includes the end of the daily cycle after draw 220', async () => {
  const all = Array.from({length:300}, (_, i) => draw(1000 + i));
  const db = async url => url.startsWith('tracker_groups?')
    ? [{ name:'AUTO_CONTROL_2026-09-13', start_draw_id:1000 }]
    : all.slice(0, Number(new URL('https://test/' + url).searchParams.get('limit')));
  const health = load('api/health.js', { './lib':{db}, './group-six':{}, '../lib/group-five':{} }, ['liveDrawContext', 'predictionFromStats']);
  const result = await health.__test.liveDrawContext();
  assert.equal(result.draws.at(-1).draw_id, 1299);
});

for (const gap of [3, 12]) {
  test(`cycle forecast does not create an inverted or invented window at gap ${gap}`, () => {
    const health = load('api/health.js', {}, ['predictionFromStats']);
    const result = health.__test.predictionFromStats({ gaps:[2,2,3,3,10,10,12,12], last:{drawId:100}, count:9, recent20:2, consistency:0.5 }, gap, 100);
    if (gap === 3) {
      assert.equal(result.regime.active, 'LONG');
      assert.ok(result.followUp.startDrawId <= result.followUp.endDrawId);
    } else {
      assert.equal(result.expectedDrawId, null);
      assert.equal(result.regime.active, 'OUTSIDE_HISTORY');
    }
  });
}

function ledger() {
  const fake = load('verify/fake-db.js');
  const value = load('lib/signal-ledger.js', {'../api/lib':fake});
  return { ...value, tables:fake.tables };
}

test('a continuously strong episode is not reopened after its outcome resolves', async () => {
  const L = ledger();
  for (let id=100; id<=112; id++) {
    await L.recordObservation(target, forecast, id);
    await L.resolveEpisodes(async (from,to) => Array.from({length:to-from+1},(_,i)=>draw(from+i)), id);
  }
  assert.equal(L.tables.signal_episodes.length, 1);
  assert.equal(L.tables.signal_episodes[0].last_draw_id, 112);
  assert.equal(L.tables.signal_episodes[0].window_end_draw_id, 105);
});

test('the fixed-five ledger rejects targets of a different size', async () => {
  const L=ledger();
  assert.equal((await L.recordObservation([1,2,3,4], forecast, 100)).action, 'ignored');
  assert.equal(L.tables.signal_episodes.length, 0);
});

for (const ids of [[101,101,103,104,105], [101,103,104,105,106]]) {
  test(`ledger refuses an incomplete window even when row count is five: ${ids}`, async () => {
    const L=ledger();
    await L.recordObservation(target, forecast, 100);
    assert.equal((await L.resolveEpisodes(async()=>ids.map(draw),105)).resolved,0);
  });
}

test('ledger sorts outcome draws before selecting the first successful draw', async () => {
  const L=ledger();
  await L.recordObservation(target, forecast, 100);
  await L.resolveEpisodes(async()=>[105,104,103,102,101].map(draw),105);
  assert.equal(L.tables.signal_episodes[0].outcome_draw_id,101);
});

test('ledger report compares only episodes with the requested window', async () => {
  const L=ledger();
  L.tables.signal_episodes.push(
    {id:1,target:'1-2-3-4-5',status:'STRONG',resolved:true,start_draw_id:100,window_end_draw_id:105,best_hit_count:5,success:true},
    {id:2,target:'1-2-3-4-5',status:'STRONG',resolved:true,start_draw_id:200,window_end_draw_id:202,best_hit_count:2,success:false}
  );
  const report=await L.ledgerReport({window:2});
  assert.equal(report.overall.episodes,1);
  assert.equal(report.overall.successes,0);
});

test('ledger report recalculates successes when the hit threshold changes', async () => {
  const L=ledger();
  L.tables.signal_episodes.push({id:1,target:'1-2-3-4-5',status:'STRONG',resolved:true,start_draw_id:100,window_end_draw_id:105,best_hit_count:4,success:true});
  const report=await L.ledgerReport({threshold:5});
  assert.equal(report.overall.successes,0);
  assert.equal(report.successLeadDraws,null);
});

test('binomial tails handle exact boundaries and very small probabilities', () => {
  const L=ledger();
  assert.equal(L.binomialTailAtLeast(1,10,0),0);
  assert.equal(L.binomialTailAtLeast(10,10,1),1);
  const p=L.binomialTailAtLeast(10,10,0.01);
  assert.ok(Math.abs(p/1e-20-1)<1e-10, `Expected 1e-20; got ${p}`);
});

test('unattainable statistical power plans terminate without a huge search', {timeout:1000}, () => {
  const L=ledger();
  assert.equal(L.requiredEpisodes(2,0.8),null);
});

test('manual number validation returns 400 instead of a server error', async () => {
  for (const file of ['api/group.js','api/fusion.js']) {
    const handler=load(file, {'./lib':{getDraw:forbidden,db:forbidden}});
    const res=response();
    await handler({method:'POST',headers:{},query:{},body:{action:'start',numbers:[1,2,3,4,4]}},res);
    assert.equal(res.statusCode,400,file);
  }
});

test('Fusion input never silently removes extra or duplicate numbers', () => {
  const fusion=load('api/fusion.js',{},['validateManualNumbers']);
  assert.throws(()=>fusion.__test.validateManualNumbers([1,2,3,4,5,5]));
  assert.throws(()=>fusion.__test.validateManualNumbers([1,2,3,4,5,'invalid']));
});

test('time parser rejects invalid hours and minutes', () => {
  const lib=require('../api/lib');
  assert.equal(lib.parseDrawMinutes('13:00 p.m.'),null);
  assert.equal(lib.parseDrawMinutes('6:75 a.m.'),null);
  assert.equal(lib.parseDrawMinutes('12:00 a.m.'),0);
  assert.equal(lib.parseDrawMinutes('12:00 p.m.'),720);
});

test('official draw validation rejects fractional numbers', () => {
  const lib=load('api/lib.js',{},['valid']);
  assert.equal(Boolean(lib.__test.valid({...draw(100),numbers:[1.5,...numbers.slice(1)]})),false);
});

test('the legacy root state entry resolves to the maintained API handler', () => {
  assert.equal(require('../state'),require('../api/state'));
});

const realScore = require('../api/lib').score;

test('manual sync reports remaining work beyond its 25-draw batch', async () => {
  const group={id:1,name:'MANUAL Group',numbers:target,active:true,start_draw_id:100,last_seen_draw_id:100};
  const db=async (url,init={})=>{
    if(init.method) return [];
    if(url.startsWith('tracker_groups?')) return url.includes('name=eq.') ? [] : [group];
    if(url.includes('draw_id=gt.')) return Array.from({length:25},(_,i)=>draw(101+i));
    return [{draw_id:150}];
  };
  const handler=load('api/sync.js',{'./lib':{db,getDraw:async id=>id?null:draw(150),score:realScore},'./cron':forbidden});
  const res=response();await handler({method:'GET',headers:{},query:{}},res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.manual.drawsProcessed,25);
  assert.equal(res.body.manual.remainingLag,25);
  assert.equal(res.body.caughtUp,false);
});

for (const file of ['lib/group-five.js','api/group-six.js']) {
  test(`${file} stops tracking before a missing draw`,async()=>{
    const writes=[];
    const db=async(url,init)=>{writes.push({url,init});return [];};
    const M=load(file,{'../api/lib':{db,score:realScore},'./lib':{db,score:realScore}},['trackGroup']);
    const result=await M.__test.trackGroup({id:7,start_draw_id:100,last_seen_draw_id:100,numbers:target},[draw(101),draw(103)],103);
    assert.equal(result.processed,1);assert.equal(result.lastSeen,101);assert.equal(result.capReached,false);
    assert.equal(writes.filter(x=>x.init?.method==='POST').length,1);
  });
}

test('worker repairs only a contiguous prefix and honours the 20-draw group limit',async()=>{
  const writes=[];
  const db=async(url,init)=>{
    if(init){writes.push({url,init});return [];}
    return Array.from({length:40},(_,i)=>draw(101+i));
  };
  const M=load('api/worker.js',{'./lib':{db,score:realScore,getMany:async()=>[]}},['processTracking']);
  const result=await M.__test.processTracking([{id:3,name:'AUTO Group Five',start_draw_id:100,last_seen_draw_id:100,numbers:target}],draw(140));
  assert.equal(result.processed,20);
  assert.equal(writes.filter(x=>x.init.method==='POST').length,20);
  assert.equal(writes.at(-1).init.body.last_seen_draw_id,120);
});

test('worker collection does not skip a missing draw or trust batch ordering',async()=>{
  let cursor;
  const M=load('api/worker.js',{'./lib':{getMany:async()=>[draw(102),draw(101),draw(104)],db:async(url,init)=>{
    if(init?.method==='PATCH') cursor=init.body.last_seen_draw_id;return [];
  }}},['backfill']);
  assert.equal(await M.__test.backfill({id:1,start_draw_id:101,last_seen_draw_id:100},draw(104)),2);
  assert.equal(cursor,102);
});

test('advanced group initial backfill never advances past a gap',async()=>{
  let cursor;
  const db=async(url,init)=>{
    if(init){if(init.method==='PATCH')cursor=init.body.last_seen_draw_id;return [];}
    return url.includes('order=draw_id.desc')?[{draw_id:103}]:[draw(101),draw(103)];
  };
  const M=load('lib/advanced.js',{'../api/lib':{db,score:realScore}},['initialBackfill']);
  assert.equal(await M.__test.initialBackfill({id:1,start_draw_id:100,numbers:target}),1);
  assert.equal(cursor,101);
});

test('pagination returns rows beyond Supabase’s default 1000-row cap',async()=>{
  const {readPages}=require('../lib/db-pages');
  const all=Array.from({length:1500},(_,id)=>({id}));
  const rows=await readPages(async url=>{
    const p=new URL('https://test/'+url).searchParams;
    return all.slice(Number(p.get('offset')),Number(p.get('offset'))+Math.min(1000,Number(p.get('limit'))));
  },'rows?order=id.asc');
  assert.equal(rows.length,1500);assert.equal(rows.at(-1).id,1499);
});

test('manual summary counts more than the recent history and marks capped results',async()=>{
  const {loadManualSummary}=require('../lib/manual-summary');
  const rows=Array.from({length:1500},(_,i)=>({draw_id:1600-i,hit_count:3}));
  rows[1400].hit_count=5;
  const result=await loadManualSummary(async url=>{
    const p=new URL('https://test/'+url).searchParams;
    return rows.slice(Number(p.get('offset')),Number(p.get('offset'))+Number(p.get('limit')));
  },{id:1,start_draw_id:100});
  assert.equal(result.threePlus,1500);assert.equal(result.bestHit,5);assert.equal(result.summaryCapped,false);
});

for(const file of ['api/five-study.js','api/five-cross-test.js']) {
  test(`${file} never includes outcomes beyond the validation cutoff`,()=>{
    const M=load(file,{},['baselineRate']);const hits=Array(50).fill(0);hits[31]=5;
    const result=M.__test.baselineRate(hits,20,30,5);
    assert.equal(typeof result==='number'?result:result.successes,0);
    if(typeof result!=='number')assert.equal(result.opportunities,6);
  });
  test(`${file} does not count an already-active signal again at the validation split`,()=>{
    const M=load(file,{},['collectEpisodes']);
    const rows=Array.from({length:50},(_,i)=>draw(100+i));
    const matches=rows.map((_,i)=>i%2?[1,2]:[3,4]);matches[25]=[1,2,5];
    const hits=matches.map(x=>x.length);
    const episodes=M.__test.collectEpisodes(rows,hits,matches,27,49,'singlePulse');
    assert.equal(episodes.length,0);
  });
}

test('cron records valid five-number forecasts before resolving and can resolve without active targets',async t=>{
  setEnv(t,'SIGNAL_LEDGER_ENABLED','true');const calls=[];
  const M=load('api/cron.js',{'./lib':{db:async()=>[{draw_id:105}],getDraw:async()=>draw(105)},'../lib/signal-ledger':{
    recordObservation:async(...args)=>{calls.push(['record',...args]);return {action:'opened'};},
    resolveEpisodes:async(fn,id)=>{calls.push(['resolve',id]);return {resolved:1,successes:0};}
  }},['updateSignalLedger']);
  const result=await M.__test.updateSignalLedger({latestDrawId:105,groups:[{ok:true,numbers:target,hitTierForecast:forecast}]});
  assert.equal(result.enabled,true);assert.deepEqual(calls.map(c=>c[0]),['record','resolve']);
  calls.length=0;await M.__test.updateSignalLedger({groups:[]});assert.deepEqual(calls,[['resolve',105]]);
});

test('ledger integration remains inactive until its schema has been configured',async t=>{
  setEnv(t,'SIGNAL_LEDGER_ENABLED','');
  const M=load('api/cron.js',{'./lib':{db:forbidden},'../lib/signal-ledger':{recordObservation:forbidden,resolveEpisodes:forbidden}},['updateSignalLedger']);
  assert.equal((await M.__test.updateSignalLedger(null)).enabled,false);
});

test('cron reports a failed subtask as failure instead of successful HTTP 200',async t=>{
  setEnv(t,'CRON_SECRET','cron');setEnv(t,'WORKER_SECRET','worker');setEnv(t,'SIGNAL_LEDGER_ENABLED','');
  const M=load('api/cron.js',{'./worker':async(req,res)=>res.json({ok:true,mode:'cleanup'}),'./lib':{db:async url=>{
    if(url.startsWith('hotspot_draws')) throw Error('database unavailable');return [];
  }}});
  const res=response();await M({headers:{authorization:'Bearer cron'},method:'GET'},res);
  assert.equal(res.statusCode,500);assert.equal(res.body.ok,false);
  assert.ok(res.body.partialFailures.some(x=>x.stage==='precursorArchive'));
});

test('archive age is not mistaken for six months of draw coverage',async()=>{
  const M=load('api/cron.js',{'./lib':{db:async url=>url.includes('order=draw_id.asc')?
    [{draw_id:100,draw_date:'2026-01-01'}]:[{draw_id:200,draw_date:'2026-01-10'}],getMany:async()=>[]}},['precursorHistoryBackfill']);
  const result=await M.__test.precursorHistoryBackfill();
  assert.equal(result.coverageDays,9);assert.equal(result.completeSixMonths,false);
});

test('Group Six rejects public mutation even if a secret exists in the query string',async t=>{
  setEnv(t,'WORKER_SECRET','secret');
  const M=load('api/group-six.js',{'./lib':{db:forbidden}});const res=response();
  await M({method:'GET',headers:{},query:{mode:'run',secret:'secret'}},res);assert.equal(res.statusCode,401);
});

test('track rejects duplicate/extra input and unsupported write actions',async()=>{
  const M=load('api/track.js',{'./lib':{db:forbidden,getDraw:forbidden}});
  for(const body of [{action:'register',numbers:[1,2,3,4,5,5]},{action:'unknown'}]){
    const res=response();await M({method:'POST',headers:{},query:{},body},res);
    assert.equal(res.statusCode,body.action==='unknown'?405:400);
  }
});

test('closing backfill includes previous-evening draws before crossing midnight',async()=>{
  const batch=[{...draw(101),time:'11:56 p.m.'},{...draw(102),time:'12:00 a.m.'}];
  const M=load('api/cron.js',{'./lib':{getMany:async()=>batch,getDraw:forbidden,db:async()=>[],score:realScore,parseDrawMinutes:require('../api/lib').parseDrawMinutes}},['finalizeOneCloseGroup']);
  const result=await M.__test.finalizeOneCloseGroup({id:1,name:'MANUAL Group',numbers:target,start_draw_id:100,last_seen_draw_id:100},batch[1]);
  assert.equal(result.processed,2);assert.equal(result.lastSeen,102);
});

test('ledger API exposes recording configuration without enabling it or leaking database errors',async t=>{
  setEnv(t,'SIGNAL_LEDGER_ENABLED','');
  const M=load('api/ledger.js',{'../lib/signal-ledger':{ledgerReport:async()=>({ok:true,overall:{episodes:0}})}});
  let res=response();await M({method:'GET',query:{}},res);
  assert.equal(res.statusCode,200);assert.equal(res.body.recording.enabled,false);
  assert.equal(res.body.recording.window,5);assert.equal(res.body.recording.threshold,4);
  assert.ok(Number.isFinite(Date.parse(res.body.generatedAt)));
  const broken=load('api/ledger.js',{'../lib/signal-ledger':{ledgerReport:async()=>{throw Error('private database diagnostics');}}});
  res=response();await broken({method:'GET',query:{}},res);
  assert.equal(res.statusCode,503);assert.equal(res.body.code,'LEDGER_UNAVAILABLE');
  assert.ok(!res.body.error.includes('private'));
});

test('recent forward records distinguish pending and resolved outcomes with their original windows',async()=>{
  const L=ledger();
  L.tables.signal_episodes.push(
    {id:1,target:'1-2-3-4-5',status:'STRONG',start_draw_id:100,last_draw_id:100,window_end_draw_id:105,resolved:false,created_at:'2026-09-14T00:00:00Z'},
    {id:2,target:'1-2-3-4-5',status:'STRONG',start_draw_id:200,last_draw_id:200,window_end_draw_id:205,resolved:true,best_hit_count:3}
  );
  const report=await L.ledgerReport();
  assert.equal(report.recentEpisodes.length,2);
  assert.equal(report.recentEpisodes[0].success,false);
  assert.equal(report.recentEpisodes[1].success,null);
  assert.equal(report.recentEpisodes[1].recordedAt,'2026-09-14T00:00:00Z');
  assert.equal(report.overall.episodes,1);
});

test('forward recording skips a forecast when a new official draw arrives during analysis',async t=>{
  setEnv(t,'SIGNAL_LEDGER_ENABLED','true');
  const M=load('api/cron.js',{'./lib':{getDraw:async()=>draw(106)},
    '../lib/signal-ledger':{recordObservation:forbidden,resolveEpisodes:async()=>({resolved:0,successes:0})}},['updateSignalLedger']);
  const result=await M.__test.updateSignalLedger({latestDrawId:105,groups:[{ok:true,numbers:target,hitTierForecast:forecast}]});
  assert.deepEqual(result.observations,[{action:'ignored',reason:'forecast-draw-is-not-current'}]);
});

for (const missingSchema of [true,false]) {
  test('cron isolates optional ledger setup while retaining real errors: '+missingSchema,async t=>{
    setEnv(t,'CRON_SECRET','cron');setEnv(t,'WORKER_SECRET','worker');setEnv(t,'SIGNAL_LEDGER_ENABLED','true');
    const M=load('api/cron.js',{
      './worker':async(req,res)=>res.json({ok:true,mode:'cleanup'}),
      './lib':{db:async url=>url.startsWith('tracker_groups')?[]:url.includes('order=draw_id.asc')?[{draw_id:100,draw_date:'2026-01-01'}]:[{draw_id:200,draw_date:'2026-09-01'}]},
      '../lib/signal-ledger':{resolveEpisodes:async()=>{throw Error(missingSchema?"Supabase 404: PGRST205 could not find public.signal_episodes":"connection lost");}}
    });
    const res=response();await M({headers:{authorization:'Bearer cron'},method:'GET'},res);
    assert.equal(res.statusCode,missingSchema?200:500);
    assert.equal(res.body.signalLedger.ready,false);
    assert.equal(res.body.signalLedger.requiresSetup,missingSchema?true:undefined);
    if(missingSchema)assert.equal(res.body.ok,true);
  });
}
