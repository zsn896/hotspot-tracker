const {getDraw,getMany,uniqSorted,score}=require('./lib');

function parseGroups(v){
  if(!v)return [];
  return String(v)
    .split(';')
    .map(s=>uniqSorted(s.split(',').map(Number)))
    .filter(a=>a.length===5)
    .slice(0,3)
}

module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','no-store,max-age=0');
  try{
    const latest=await getDraw(null);
    const after=Math.max(0,Number(req.query.after||latest.id));
    const groups=parseGroups(req.query.groups);

    if(after>=latest.id)
      return res.status(200).json({
        ok:true,
        latest,
        draws:[],
        groups,
        source:'California Lottery official'
      });

    const max=80;
    const first=Math.max(after+1,latest.id-max+1);
    const ids=Array.from(
      {length:latest.id-first+1},
      (_,i)=>first+i
    );

    const draws=await getMany(ids);
    const rows=draws.map(d=>({
      ...d,
      scores:groups.map(g=>score(d,g))
    }));

    return res.status(200).json({
      ok:true,
      latest,
      requestedAfter:after,
      firstReturned:first,
      draws:rows,
      groups,
      source:'California Lottery official',
      truncated:first>after+1
    });

  }catch(e){
    return res.status(500).json({
      ok:false,
      error:e.message||String(e)
    });
  }
};
