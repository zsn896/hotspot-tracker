'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../index-core.html'),'utf8');
function reopen(storage,requests){
  const context={
    trackerLatest:100,renderTracker:()=>{},refreshGroupSixTracking:async()=>{},
    readJson:(key,fallback)=>storage.has(key)?JSON.parse(storage.get(key)):fallback,
    writeJson:(key,value)=>storage.set(key,JSON.stringify(value)),
    localStorage:{removeItem:key=>storage.delete(key)},
    fetch:async url=>{requests.push(url);return {ok:true,json:async()=>url.includes('tracking-start')?
      {ok:true,latestDrawId:108}:{ok:true,analysis:{numbers:[1,2,3,4,5],latestDrawId:100,have:50}}}}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('var GROUP_SIX_DRAFT_KEY'),source.indexOf('function sixDrawDate')),context);
  vm.runInContext(source.slice(source.indexOf('function resetGroupSixCycle'),source.indexOf('function ensurePanel')),context);
  vm.runInContext('restoreGroupSixSavedState()',context);
  return context;
}
const state=c=>JSON.parse(vm.runInContext('JSON.stringify({analysis:groupSixAnalysis,suggestion:groupSixSuggestion,cycle:groupSixCycle,tracking:groupSixTracking})',c));

test('analysis and generated numbers survive reopening without another selection request',async()=>{
  const storage=new Map(),requests=[];
  let page=reopen(storage,requests);
  await vm.runInContext('analyzeGroupSix()',page);
  page=reopen(storage,requests);
  assert.equal(state(page).analysis.latestDrawId,100);
  vm.runInContext('generateGroupSix()',page);
  page=reopen(storage,requests);
  assert.deepEqual(state(page).suggestion.numbers,[1,2,3,4,5]);
  await vm.runInContext('restoreGroupSixCycle();analyzeGroupSix()',page);
  vm.runInContext('generateGroupSix()',page);
  assert.equal(requests.length,1);
  assert.equal(state(page).tracking,false);
});

test('starting after newer draws preserves the saved five and a fixed 20-draw endpoint',async()=>{
  const storage=new Map(),requests=[];
  let page=reopen(storage,requests);
  await vm.runInContext('analyzeGroupSix()',page);
  vm.runInContext('generateGroupSix()',page);
  page=reopen(storage,requests);
  await vm.runInContext('startGroupSixTracking()',page);
  assert.deepEqual(state(page).cycle.numbers,[1,2,3,4,5]);
  assert.equal(state(page).cycle.startDrawId,108);
  assert.equal(state(page).cycle.endDrawId,128);
  assert.equal(storage.has('hotspot_group_six_draft_v1'),false);
  page=reopen(storage,requests);
  assert.equal(state(page).tracking,true);
  assert.equal(state(page).cycle.endDrawId,128);
  vm.runInContext('trackerLatest=140;generateGroupSix()',page);
  await vm.runInContext('restoreGroupSixCycle();analyzeGroupSix();startGroupSixTracking()',page);
  assert.deepEqual(state(page).suggestion.numbers,[1,2,3,4,5]);
  assert.equal(state(page).cycle.endDrawId,128);
  assert.equal(requests.length,2);
});
