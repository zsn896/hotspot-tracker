'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {selectRecentSix}=require('../lib/six-recent');
const groups=Array.from({length:6},()=>({numbers:[1,2,3,4,5]}));
function draw(id,pick){return {draw_id:id,numbers:[...pick,...Array.from({length:20-pick.length},(_,i)=>40+i)]};}
function windowFor(fn){return Array.from({length:50},(_,i)=>draw(101+i,fn(i)));}

test('requires exactly 50 complete consecutive draws ending at the pinned latest',()=>{
 const rows=windowFor(()=>[1,2,3,4,5]);
 assert.equal(selectRecentSix(groups,rows,150).have,50);
 assert.throws(()=>selectRecentSix(groups,rows,151));
 assert.throws(()=>selectRecentSix(groups,rows.slice(1),150));
 rows[0].numbers[0]=81;assert.throws(()=>selectRecentSix(groups,rows,150));
});
test('frequent outsiders cannot replace companions actually seen with the complete core',()=>{
 const source=[...groups.slice(0,5),{numbers:[1,2,3,6,7]}];
 const rows=windowFor(i=>i<10?[1,2,3,i%2?4:5]:[6,7]);
 const r=selectRecentSix(source,rows,150);
 assert.deepEqual(r.core,[1,2,3]);assert.deepEqual(r.numbers,[1,2,3,4,5]);
 assert.equal(r.coreEvidence.count,10);assert.equal(r.coreEvidence.recent20,0);
 assert.equal(r.fullFiveWithCore,0);
 assert.deepEqual(r.companionEvidence.map(x=>x.count),[5,5]);
 assert.ok(r.companionEvidence.every(x=>x.drawIds.every(id=>{
  const d=rows.find(d=>d.draw_id===id);return [...r.core,x.number].every(n=>d.numbers.includes(n));
 })));
});
test('recent recurring core beats an equally frequent old core',()=>{
 const source=[...groups.slice(0,3),...Array.from({length:3},()=>({numbers:[6,7,8,9,10]}))];
 const rows=windowFor(i=>i<10?[1,2,3,4,5]:i>=40?[6,7,8,9,10]:[]);
 const r=selectRecentSix(source,rows,150);
 assert.deepEqual(r.core,[6,7,8]);assert.deepEqual(r.numbers,[6,7,8,9,10]);
 assert.equal(r.coreEvidence.recent10,10);assert.equal(r.coreEvidence.recent20,10);
 assert.deepEqual(r.coreEvidence.segments,[0,0,0,0,10]);
 assert.equal(r.fullFiveWithCore,10);
});
test('refuses isolated triples or filling missing companions using unrelated appearances',()=>{
 assert.throws(()=>selectRecentSix(groups,windowFor(i=>i===0?[1,2,3,4,5]:[1,2]),150),/لا توجد مجموعة مؤهلة/);
 assert.throws(()=>selectRecentSix(groups,windowFor(i=>i<10?[1,2,3]:[4,5]),150),/لا توجد مجموعة مؤهلة/);
});
test('core and companion evidence independently recounts exact same-draw membership',()=>{
 const source=[...groups.slice(0,3),...Array.from({length:3},()=>({numbers:[6,7,8,9,10]}))];
 let seed=17;
 const rows=windowFor(()=>{const pick=[];for(let n=1;n<=10;n++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;if(seed%100<35)pick.push(n)}return pick});
 const r=selectRecentSix(source,rows,150);
 const coreRows=rows.filter(d=>r.core.every(n=>d.numbers.includes(n)));
 assert.deepEqual(r.coreEvidence.drawIds,coreRows.map(d=>d.draw_id));
 assert.equal(r.coreEvidence.count,coreRows.length);
 assert.ok(r.coreEvidence.count>=2);
 for(const e of r.companionEvidence)assert.equal(e.count,coreRows.filter(d=>d.numbers.includes(e.number)).length);
 assert.equal(r.fullFiveWithCore,rows.filter(d=>r.numbers.every(n=>d.numbers.includes(n))).length);
 assert.equal(r.evidence.length,r.jointCounts.threePlus);
 assert.equal(r.selectionRule,'fixed-core-conditional-v3');
 assert.equal(new Set(r.numbers).size,5);
 assert.ok(r.numbers.every(n=>source.some(g=>g.numbers.includes(n))));
});
