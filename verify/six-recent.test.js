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
