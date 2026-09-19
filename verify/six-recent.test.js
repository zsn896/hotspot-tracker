'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {selectRecentSix} = require('../lib/six-recent');
const groups = Array.from({length:6},()=>({numbers:[1,2,3,4,5]}));
function rows(pick) {return Array.from({length:50},(_,i)=>({draw_id:101+i,numbers:[...pick,...Array.from({length:15},(_,j)=>40+j)]}));}
test('only the exact latest 50 complete unique draws are accepted',()=>{
  assert.equal(selectRecentSix(groups,rows([1,2,3,4,5]),150).have,50);
  assert.throws(()=>selectRecentSix(groups,rows([1,2,3,4,5]),151));
  assert.throws(()=>selectRecentSix(groups,rows([1,2,3,4,5]).slice(1),150));
});
test('joint recent appearances beat group membership frequency; numbers stay in groups',()=>{
  const g=[...groups.slice(0,5),{numbers:[6,7,8,9,10]}];
  const d=rows([6,7,8,9,10]);
  assert.deepEqual(selectRecentSix(g,d,150).numbers,[6,7,8,9,10]);
  const shifted=d.map((r,i)=>i<25?{...r,numbers:[1,2,3,4,5,...r.numbers.slice(5)]}:r);
  assert.deepEqual(selectRecentSix(g,shifted,150).numbers,[6,7,8,9,10]);
});

function drawWith(id, pick) {
  return {draw_id:id, numbers:[...pick,...Array.from({length:20-pick.length},(_,j)=>40+j)]};
}

test('separate pair appearances do not outrank actual same-draw triples',()=>{
  const source=[...groups.slice(0,5),{numbers:[6,7,8,9,10]}];
  // 1..5 occur only in pairs, late in the window. 6,7,8 occur together
  // ten times early in the window: pair sums used to choose 1..5 instead.
  const pairs=[];
  for(let a=1;a<=5;a++)for(let b=a+1;b<=5;b++)pairs.push([a,b]);
  const draws=Array.from({length:50},(_,i)=>drawWith(101+i,i<10?[6,7,8]:pairs[(i-10)%10]));
  const selected=selectRecentSix(source,draws,150);
  assert.equal(selected.jointCounts.threePlus,10);
  assert.ok([6,7,8].every(n=>selected.numbers.includes(n)));
  assert.equal(selected.evidence.length,10);
  assert.equal(selected.selectionRule,'joint-3plus-count-v2');
});

test('exhaustive independent recount agrees with maximum 3+, then 4+, then 5',()=>{
  const source=[...groups.slice(0,3),...Array.from({length:3},()=>({numbers:[6,7,8,9,10]}))];
  let seed=17;
  const draws=Array.from({length:50},(_,i)=>{
    const pick=[];
    for(let n=1;n<=10;n++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;if(seed%100<35)pick.push(n);}
    return drawWith(101+i,pick);
  });
  const metrics=nums=>{
    const counts=draws.map(d=>nums.filter(n=>d.numbers.includes(n)).length);
    return [counts.filter(x=>x>=3).length,counts.filter(x=>x>=4).length,counts.filter(x=>x===5).length];
  };
  const scores=[];
  for(let a=1;a<=6;a++)for(let b=a+1;b<=7;b++)for(let c=b+1;c<=8;c++)for(let d=c+1;d<=9;d++)for(let e=d+1;e<=10;e++)scores.push(metrics([a,b,c,d,e]));
  scores.sort((a,b)=>b[0]-a[0]||b[1]-a[1]||b[2]-a[2]);
  const selected=selectRecentSix(source,draws,150);
  assert.deepEqual(metrics(selected.numbers),scores[0]);
  assert.deepEqual([selected.threePlus,selected.fourPlus,selected.five],scores[0]);
  assert.equal(selected.combinationsChecked,252);
  assert.equal(selected.jointCounts.three+selected.jointCounts.four+selected.jointCounts.five,selected.evidence.length);
  assert.ok(selected.evidence.every(e=>e.matched.length>=3 && e.matched.every(n=>selected.numbers.includes(n))));
});

test('refuses a window with only pair support and invalid draw numbers',()=>{
  assert.throws(()=>selectRecentSix(groups,Array.from({length:50},(_,i)=>drawWith(101+i,[1,2])),150),/لا توجد مجموعة مؤهلة/);
  const invalid=rows([1,2,3,4,5]);invalid[3].numbers[0]=81;
  assert.throws(()=>selectRecentSix(groups,invalid,150),/غير مكتملة/);
});
