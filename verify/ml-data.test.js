'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
function handler(db){const module={exports:{}};new Function('require','module',fs.readFileSync(require.resolve('../api/ml-data'),'utf8'))(()=>({db}),module);return module.exports;}
function response(){return {setHeader(){},status(n){this.code=n;return this;},json(data){this.body=data;return this;}};}
test('ML archive refuses unauthenticated access before any database operation',async t=>{
 const old=process.env.CRON_SECRET;process.env.CRON_SECRET='test-secret';
 t.after(()=>{if(old===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;});
 const res=response();await handler(()=>{throw Error('Unexpected I/O');})({method:'GET',headers:{}},res);
 assert.equal(res.code,401);
});
test('ML archive fixes its watermark and paginates without offset',async t=>{
 const old=process.env.CRON_SECRET;process.env.CRON_SECRET='test-secret';
 t.after(()=>{if(old===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;});
 const urls=[];
 const res=response();await handler(async url=>{
  urls.push(url);
  if(url.includes('select=draw_id&'))return [{draw_id:2000}];
  if(url.startsWith('tracker_groups'))return [{numbers:[1,2,3,4,5]}];
  if(url.includes('draw_id=lt.2001'))return Array.from({length:1000},(_,i)=>({draw_id:2000-i,numbers:[]}));
  if(url.includes('draw_id=lt.1001'))return [{draw_id:1000,numbers:[]}];
  throw Error('Unexpected page');
 })({method:'GET',headers:{authorization:'Bearer test-secret'}},res);
 assert.equal(res.code,200);assert.equal(res.body.watermark,2000);
 assert.equal(res.body.draws.length,1001);assert.equal(res.body.draws[0].draw_id,1000);
 assert.ok(urls.every(url=>!url.includes('offset=')));
});
