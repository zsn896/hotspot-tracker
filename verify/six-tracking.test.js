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
test('tracking UI preserves counters and lists only 3+ matches in a closed disclosure',()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const source=fs.readFileSync(require('node:path').join(__dirname,'../index-core.html'),'utf8');
  const renderer=source.slice(source.indexOf('function sixDrawDate('),source.indexOf('async function refreshGroupSixTracking()'));
  const context={esc:String,groupSixTrack:summarizeCycle(numbers,100,101,[draw(101,0)])};
  vm.createContext(context);vm.runInContext(renderer,context);
  const html=vm.runInContext('groupSixResultsHtml()',context);
  assert.match(html,/المتبقي<b>19<\/b>/);assert.match(html,/مطابقة آخر سحبة<b>0<\/b>/);
  assert.ok(!html.includes('أرقام السحبة:'));assert.ok(!html.includes('<table'));assert.ok(!html.includes('المطابق من مجموعتك:'));
  const rows=Array.from({length:6},(_,i)=>draw(101+i,i));
  context.groupSixTrack=summarizeCycle(numbers,100,106,rows);
  const {JSDOM}=require('jsdom');
  const dom=new JSDOM(vm.runInContext('groupSixResultsHtml()',context));
  const detail=dom.window.document.querySelector('details');
  assert.equal(detail.open,false);
  const entries=Array.from(detail.querySelectorAll('tbody tr'));
  assert.equal(entries.length,3);
  assert.deepEqual(entries.map(row=>row.querySelector('bdi').textContent),['106','105','104']);
  assert.ok(entries.every(row=>row.textContent.includes('10:00')));
  assert.ok(entries[2].textContent.includes('1 · 2 · 3'));
  assert.match(dom.window.document.querySelector('.sixStats').textContent,/تمت متابعتها6/);
  dom.window.close();
});

test('completed saved cycle is explicitly historical and collapsed',()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const source=fs.readFileSync(require('node:path').join(__dirname,'../index-core.html'),'utf8');
 const context={esc:String,groupSixAnalysis:{},groupSixSuggestion:{numbers},groupSixTrack:{finished:true,last:{date:'Sep 18, 2026'}},groupSixTracking:true,groupSixCycle:{},groupSixResultsHtml:()=>'<span>ARCHIVE RESULTS</span>',sixDrawDate:x=>x};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function sixGeneratorHtml()'),source.indexOf('function resetGroupSixCycle()')),context);
 const html=vm.runInContext('sixGeneratorHtml()',context);
 assert.match(html,/لا توجد متابعة نشطة/);assert.match(html,/<details[^>]*><summary>عرض الدورة السابقة/);assert.ok(html.indexOf('تحليل جديد')<html.indexOf('ARCHIVE RESULTS'));assert.ok(!html.includes('<details open'));
});
