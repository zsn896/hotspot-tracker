'use strict';
const {db}=require('./lib');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store,max-age=0');
 if(!process.env.CRON_SECRET || req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`)
   return res.status(401).json({ok:false,error:'Unauthorized'});
 if(req.method!=='GET')return res.status(405).json({ok:false,error:'GET required'});
 try{
   const latest=(await db('hotspot_draws?select=draw_id&order=draw_id.desc&limit=1'))?.[0]?.draw_id;
   if(!Number.isSafeInteger(Number(latest)))throw Error('No archive');
   const draws=[];let before=Number(latest)+1;
   // Keyset pagination plus a fixed upper watermark prevents live inserts
   // from duplicating or shifting rows while exporting the training snapshot.
   for(let page=0;page<20;page++){
     const rows=await db(`hotspot_draws?select=draw_id,numbers&draw_id=lt.${before}&order=draw_id.desc&limit=1000`)||[];
     draws.push(...rows);if(!rows.length)break;
     const next=Number(rows.at(-1).draw_id);if(!Number.isSafeInteger(next)||next>=before)throw Error('Invalid pagination');
     before=next;if(rows.length<1000)break;
   }
   const groups=await db('tracker_groups?select=numbers&active=eq.true&name=like.STRONG_MANUAL%20Group*&order=id.asc&limit=6')||[];
   const targets=groups.map(g=>g.numbers).filter(a=>Array.isArray(a)&&a.length===5&&new Set(a).size===5&&a.every(n=>Number.isInteger(n)&&n>=1&&n<=80));
   return res.status(200).json({ok:true,draws:draws.reverse(),targets,watermark:Number(latest),exportedAt:new Date().toISOString()});
 }catch(e){console.error('ML export failed:',e.message);return res.status(503).json({ok:false,error:'Training archive unavailable'});}
};
