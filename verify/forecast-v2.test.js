'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync('forecast-v2.html','utf8');
async function page(report,status=200){
 const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://example.test/forecast-v2.html',beforeParse(w){
  w.AbortSignal.timeout=()=>undefined;
  w.fetch=async()=>({ok:status===200,status,json:async()=>report});
 }});
 await new Promise(resolve=>setTimeout(resolve,10));
 return dom;
}
test('V2 report does not present baseline fallback as a learned advantage',async()=>{
 const score={episodes:150,brier:.06};
 const dom=await page({model:'CATBOOST_4PLUS_V2',drawCount:20000,lastDrawId:3302302,testStartDrawId:3301381,generatedAt:'2026-09-17T00:00:00Z',workflowRunId:123,
  dataQuality:{checkedDraws:4,correctedDrawIds:[3300669,3300900]},results:[{status:'evaluated',target:[1,2,3,4,5],threshold:null,calibration:{weight:0},metrics:{v2:score,legacy:score,empirical:score,chance:score},assessment:{eligibleForProspectiveTrial:false,episodes:0,successes:0,failures:0}}]});
 const d=dom.window.document;
 assert.equal(d.getElementById('report').hidden,false);
 assert.match(d.getElementById('summary').textContent,/لم يثبت/);
 assert.match(d.getElementById('details').textContent,/لا يُنسب تحسن إلى CatBoost/);
 assert.match(d.getElementById('details').textContent,/لم تتأهل عتبة/);
 assert.equal(d.querySelectorAll('#rows tr').length,1);
 assert.equal(d.getElementById('run').href,'https://github.com/zsn896/hotspot-tracker/actions/runs/123');
 dom.window.close();
});
test('unavailable or invalid V2 report cannot display prediction results',async()=>{
 for(const [data,status] of [[{},200],[{},404]]){
  const dom=await page(data,status);
  assert.equal(dom.window.document.getElementById('report').hidden,true);
  assert.equal(dom.window.document.getElementById('refresh').disabled,false);
  dom.window.close();
 }
});
