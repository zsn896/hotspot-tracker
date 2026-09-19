'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {summarizeCycle}=require('../lib/six-tracking');
const numbers=[1,2,3,4,5];
const draw=(id,hits)=>({draw_id:id,draw_time:'10:00',numbers:[...numbers.slice(0,hits),...Array.from({length:20-hits},(_,i)=>20+i)]});
test('cycle excludes historical and post-window hits, counts zeros, and caps at 20',()=>{
  const rows=[draw(100,5),...Array.from({length:20},(_,i)=>draw(101+i,i%6)),draw(121,5)];
  const t=summarizeCycle(numbers,100,103,rows);
  assert.equal(t.completed,3);assert.equal(t.remaining,17);assert.equal(t.hits,0);assert.equal(t.last.hitCount,2);
  const end=summarizeCycle(numbers,100,150,rows);
  assert.equal(end.completed,20);assert.equal(end.remaining,0);assert.equal(end.last.drawId,120);assert.equal(end.five,3);
  assert.equal(summarizeCycle(numbers,100,100,rows).last,null);
  assert.throws(()=>summarizeCycle(numbers,100,103,[draw(103,5)]));
});
test('actual tracking UI shows remaining, matches and draw result including zero',()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const source=fs.readFileSync(require('node:path').join(__dirname,'../index-core.html'),'utf8');
  const renderer=source.slice(source.indexOf('function groupSixResultsHtml()'),source.indexOf('async function refreshGroupSixTracking()'));
  const context={esc:String,groupSixTrack:summarizeCycle(numbers,100,101,[draw(101,0)])};
  vm.createContext(context);vm.runInContext(renderer,context);
  const html=vm.runInContext('groupSixResultsHtml()',context);
  assert.match(html,/السحبات المتبقية: 19 \/ 20/);assert.match(html,/آخر نتيجة: 0 \/ 5/);assert.match(html,/السحبة 101/);assert.match(html,/10:00/);
});
