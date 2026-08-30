const {getDraw,getMany,score,db}=require('./lib');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store,max-age=0');
 try{
  if(process.env.WORKER_SECRET){const token=req.headers['x-worker-secret']||req.query.secret;if(token!==process.env.WORKER_SECRET)return res.status(401).json({ok:false,error:'unauthorized'});}
  const latest=await getDraw(null);
  await db('hotspot_draws?on_conflict=draw_id',{method:'POST',prefer:'resolution=merge-duplicates,return=minimal',body:{draw_id:latest.id,draw_date:latest.date,draw_time:latest.time,numbers:latest.numbers,bulls_eye:latest.bullsEye}});
  const groups=await db('tracker_groups?select=id,name,numbers,start_draw_id,last_seen_draw_id&active=eq.true&order=id.asc');
  let processed=0;const details=[];
  for(const g of groups||[]){
   const after=Number(g.last_seen_draw_id??g.start_draw_id??latest.id);if(after>=latest.id){details.push({group:g.name,processed:0,lastSeen:after});continue;}
   const first=after+1;const end=Math.min(latest.id,after+80);const ids=Array.from({length:end-first+1},(_,i)=>first+i);const draws=await getMany(ids);
   for(const d of draws){
    await db('hotspot_draws?on_conflict=draw_id',{method:'POST',prefer:'resolution=merge-duplicates,return=minimal',body:{draw_id:d.id,draw_date:d.date,draw_time:d.time,numbers:d.numbers,bulls_eye:d.bullsEye}});
    const s=score(d,g.numbers);
    await db('tracker_results?on_conflict=group_id,draw_id',{method:'POST',prefer:'resolution=merge-duplicates,return=minimal',body:{group_id:g.id,draw_id:d.id,hit_count:s.count,hit_numbers:s.hit,bulls_eye:s.bullsEye,bulls_eye_match:s.bullsEyeMatch}});
   }
   await db(`tracker_groups?id=eq.${g.id}`,{method:'PATCH',prefer:'return=minimal',body:{last_seen_draw_id:end}});processed+=draws.length;details.push({group:g.name,processed:draws.length,lastSeen:end,caughtUp:end>=latest.id});
  }
  res.status(200).json({ok:true,latest:{id:latest.id,time:latest.time},activeGroups:(groups||[]).length,processed,details,source:'California Lottery official'});
 }catch(e){res.status(500).json({ok:false,error:e.message||String(e)})}
};
