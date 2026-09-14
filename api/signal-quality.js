'use strict';
const {db}=require('./lib');
const {analyzePrecursors}=require('../lib/precursor-engine');
const {research,prepare}=require('../lib/signal-research');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store,max-age=0');
 if(req.method!=='GET')return res.status(405).json({ok:false,error:'GET required'});
 const raw=String(req.query?.numbers||'').trim();
 if(!/^\d+(?:[ ,]+\d+){4}$/.test(raw))return res.status(400).json({ok:false,error:'Send five distinct numbers, separated by commas'});
 const target=raw.split(/[ ,]+/).map(Number);
 if(new Set(target).size!==5||target.some(n=>n<1||n>80))return res.status(400).json({ok:false,error:'Numbers must be distinct and between 1 and 80'});
 try{
   const rows=[];
   for(let offset=0;offset<20000;offset+=1000){
     const page=await db('hotspot_draws?select=draw_id,numbers&order=draw_id.desc&limit=1000&offset='+offset)||[];
     rows.push(...page);if(page.length<1000)break;
   }
   rows.sort((a,b)=>Number(a.draw_id)-Number(b.draw_id));
   const clean=prepare(rows,target).map(d=>({draw_id:d.id,numbers:d.numbers}));
   const training=clean.slice(0,Math.floor(clean.length*.6));
   const legacy=training.length>=80?analyzePrecursors(training,target):null;
   const result=research(clean,target,legacy?.precursors?.map(p=>p.numbers)||[]);
   return res.status(200).json({...result,generatedAt:new Date().toISOString(),archiveCap:20000,
     archiveCapped:rows.length===20000,productionModelChanged:false});
 }catch(e){
   console.error('Signal research failed:',e.message);
   return res.status(503).json({ok:false,error:'تعذر إكمال التحليل. أعد المحاولة لاحقًا.'});
 }
};
