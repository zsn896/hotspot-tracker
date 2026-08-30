const {uniqSorted,getDraw,db}=require('./lib');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store,max-age=0');
 try{
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST only'});
  const b=typeof req.body==='string'?JSON.parse(req.body):req.body||{}; const slot=Math.max(1,Math.min(3,Number(b.slot)||1));const name=`المجموعة ${slot}`;const action=b.action;
  const existing=await db(`tracker_groups?select=*&name=eq.${encodeURIComponent(name)}&order=id.desc&limit=1`);const old=existing?.[0];
  if(action==='start'){
   const nums=uniqSorted(b.numbers||[]);if(nums.length!==5)throw Error('أدخل خمسة أرقام مختلفة من 1 إلى 80');
   let startId=Number(b.startDrawId||0); if(!startId){const latest=await getDraw(null);startId=latest.id;await db('hotspot_draws?on_conflict=draw_id',{method:'POST',prefer:'resolution=merge-duplicates,return=minimal',body:{draw_id:latest.id,draw_date:latest.date,draw_time:latest.time,numbers:latest.numbers,bulls_eye:latest.bullsEye}})}
   if(old){await db(`tracker_groups?id=eq.${old.id}`,{method:'PATCH',prefer:'return=minimal',body:{numbers:nums,active:true,start_draw_id:startId,last_seen_draw_id:startId}});await db(`tracker_results?group_id=eq.${old.id}`,{method:'DELETE',prefer:'return=minimal'});return res.json({ok:true,id:old.id,startDrawId:startId,numbers:nums});}
   const created=await db('tracker_groups',{method:'POST',prefer:'return=representation',body:{name,numbers:nums,active:true,start_draw_id:startId,last_seen_draw_id:startId}});return res.json({ok:true,id:created?.[0]?.id,startDrawId:startId,numbers:nums});
  }
  if(!old)return res.json({ok:true});
  if(action==='stop'){await db(`tracker_groups?id=eq.${old.id}`,{method:'PATCH',prefer:'return=minimal',body:{active:false}});return res.json({ok:true});}
  if(action==='reset'){await db(`tracker_groups?id=eq.${old.id}`,{method:'DELETE',prefer:'return=minimal'});return res.json({ok:true});}
  throw Error('unknown action');
 }catch(e){res.status(500).json({ok:false,error:e.message||String(e)})}
};
