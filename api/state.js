const {db}=require('./lib');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store,max-age=0');
 try{
  const groups=await db('tracker_groups?select=id,name,numbers,active,start_draw_id,last_seen_draw_id,created_at&order=id.asc');
  const active=(groups||[]).filter(g=>g.active);
  const out=[];
  for(const g of active){
   const rows=await db(`tracker_results?select=draw_id,hit_count,hit_numbers,bulls_eye,bulls_eye_match,created_at&group_id=eq.${g.id}&order=draw_id.desc&limit=200`);
   const drawIds=(rows||[]).map(r=>r.draw_id); let meta={};
   if(drawIds.length){const ds=await db(`hotspot_draws?select=draw_id,draw_date,draw_time&draw_id=in.(${drawIds.join(',')})`);meta=Object.fromEntries((ds||[]).map(d=>[d.draw_id,d]));}
   out.push({...g,results:(rows||[]).map(r=>({...r,date:meta[r.draw_id]?.draw_date||'',time:meta[r.draw_id]?.draw_time||''}))});
  }
  const latest=await db('hotspot_draws?select=draw_id,draw_date,draw_time,bulls_eye&order=draw_id.desc&limit=1');
  res.status(200).json({ok:true,groups:out,latest:latest?.[0]||null,serverStored:true});
 }catch(e){res.status(500).json({ok:false,error:e.message||String(e)})}
};
