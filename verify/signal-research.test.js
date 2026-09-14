'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {research,prepare,discover,fit,evaluate,BASELINE}=require('../lib/signal-research');
function draws(n,seed,edge=false) {
  let state=seed>>>0;
  const rand=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  return Array.from({length:n},(_,i)=>{
    const pool=Array.from({length:80},(_,k)=>k+1);
    for(let j=79;j>0;j--){const k=Math.floor(rand()*(j+1));[pool[j],pool[k]]=[pool[k],pool[j]];}
    const forced=edge?(i%20===0?[70,71,72]:i%20===1?[1,2,3,4]:[]):[];
    return {draw_id:i+1,numbers:[...forced,...pool.filter(n=>!forced.includes(n))].slice(0,20)};
  });
}
test('research refuses insufficient data and malformed targets',()=>{
 assert.equal(research(draws(200,3),[1,2,3,4,5]).ok,false);
 assert.throws(()=>research([], [1,1,2,3,4]));
});
test('complete windows only, no duplicated IDs, and no overlapping outcomes',()=>{
 const input=draws(2000,5,true),rows=prepare(input,[1,2,3,4,5]);
 const r=evaluate(rows,[[70,71,72]],0,rows.length);
 assert.ok(r.episodes>10);
 for(let i=1;i<r.outcomes.length;i++)assert.ok(r.outcomes[i].issuedAfter>r.outcomes[i-1].end);
 const gapRows=prepare(input.filter(d=>d.draw_id!==1002),[1,2,3,4,5]);
 const g=evaluate(gapRows,[[70,71,72]],0,gapRows.length);
 assert.ok(g.outcomes.every(o=>!(o.issuedAfter<1002&&o.end>=1002)));
 assert.throws(()=>prepare([...input,input[0]],[1,2,3,4,5]),/Duplicate/);
 assert.ok(r.outcomes.every(o=>o.end<=input.at(-1).draw_id));
});
test('changing untouched outcomes cannot change fitted policy or probability',()=>{
 const input=draws(6000,17,true),a=prepare(input,[1,2,3,4,5]);
 const changed=input.map((d,i)=>i>=4800?{...d,numbers:Array.from({length:20},(_,k)=>k+1)}:d);
 const b=prepare(changed,[1,2,3,4,5]);
 const ca=discover(a,3600),cb=discover(b,3600);
 assert.deepEqual(ca,cb);
 assert.deepEqual(fit(a,ca,3600,4800),fit(b,cb,3600,4800));
});
test('seeded fair draws do not pass the research gate',()=>{
 for(const seed of [11,23,37]){
   const r=research(draws(8000,seed),[1,2,3,4,5]);
   assert.equal(r.eligibleForProspectiveTrial,false,'fair seed '+seed);
   assert.ok(r.estimatedProbability>=0&&r.estimatedProbability<=1);
 }
 assert.ok(BASELINE>.062&&BASELINE<.063);
});
test('planted forward relationship is detectable without using test outcomes for fitting',()=>{
 const r=research(draws(10000,97,true),[1,2,3,4,5]);
 assert.equal(r.eligibleForProspectiveTrial,true);
 assert.ok(r.test.brier<r.test.baselineBrier);
});

test('research page shows results and clears stale evidence after a failed refresh',async()=>{
 const {JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
 const sample=research(draws(2000,9),[1,2,3,4,5]);
 sample.generatedAt='2026-09-14T00:00:00Z';
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../signal-lab.html'),'utf8'),{
   runScripts:'dangerously',url:'https://test.invalid/',
   beforeParse(w){w.AbortSignal.timeout=()=>undefined;w.fetch=async()=>({ok:true,json:async()=>sample});}
 });
 try {
 const d=dom.window.document;[...d.querySelectorAll('.number-entry')].forEach((e,i)=>e.value=String(i+1));
 d.getElementById('run').click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(d.getElementById('results').hidden,false);
 assert.ok(d.getElementById('metrics').children.length>=8);
 dom.window.fetch=async()=>{throw Error('Service unavailable');};
 d.getElementById('run').click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(d.getElementById('results').hidden,true);
 assert.equal(d.getElementById('run').disabled,false);
 } finally {dom.window.close();}
});

test('five-number input accepts Arabic digits and paste, rejecting invalid groups before network I/O',async()=>{
 const {JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
 const calls=[];
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../signal-lab.html'),'utf8'),{
  runScripts:'dangerously',url:'https://test.invalid/',
  beforeParse(w){w.AbortSignal.timeout=()=>undefined;w.fetch=async url=>{calls.push(url);throw Error('test response');};}
 });
 try {
  const w=dom.window,d=w.document,fields=[...d.querySelectorAll('.number-entry')];
  assert.equal(fields.length,5);
  d.getElementById('run').click();assert.equal(calls.length,0);
  ['٩','١٧','٣٧','٥١','٥٦'].forEach((v,i)=>{fields[i].value=v;fields[i].dispatchEvent(new w.Event('input'));});
  d.getElementById('run').click();await new Promise(r=>setImmediate(r));
  assert.ok(calls[0].endsWith('9%2C17%2C37%2C51%2C56'));
  fields[4].value='9';d.getElementById('run').click();assert.equal(calls.length,1);
  fields[4].value='81';d.getElementById('run').click();assert.equal(calls.length,1);
  const paste=new w.Event('paste',{bubbles:true,cancelable:true});
  Object.defineProperty(paste,'clipboardData',{value:{getData:()=> '۳، ۱۳، ۱۷، ۲۸، ۵۰'}});
  fields[2].dispatchEvent(paste);
  assert.deepEqual(fields.map(e=>e.value),['3','13','17','28','50']);
  d.getElementById('run').click();await new Promise(r=>setImmediate(r));assert.equal(calls.length,2);
  d.getElementById('clear').click();assert.ok(fields.every(e=>!e.value));
  assert.equal(d.activeElement,fields[0]);
 } finally{dom.window.close();}
});
