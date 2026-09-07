// In-memory stand-in for api/lib.js, used only by the verify scripts.
// in-memory stand-in for the project's PostgREST helper
const tables = { signal_episodes: [] };
let seq = 1;
const OPS = {
  eq:(a,b)=>String(a)===b, lte:(a,b)=>Number(a)<=Number(b), gte:(a,b)=>Number(a)>=Number(b),
  lt:(a,b)=>Number(a)<Number(b), gt:(a,b)=>Number(a)>Number(b),
};
function filter(rows, params){
  return rows.filter(r=>{
    for(const [k,raw] of params){
      if(['select','order','limit','offset','on_conflict'].includes(k)) continue;
      const [op,...rest]=raw.split('.'); const v=rest.join('.');
      if(k==='resolved'||k==='success'){ if(String(r[k])!==v) return false; continue }
      if(!OPS[op]) throw new Error('op '+op);
      if(!OPS[op](r[k],v)) return false;
    }
    return true;
  });
}
async function db(path, init={}){
  const u=new URL('http://x/'+path);
  const t=u.pathname.slice(1); const params=[...u.searchParams.entries()];
  const m=(init.method||'GET').toUpperCase(); const body=init.body;
  if(m==='GET'){
    let rows=filter(tables[t],params);
    const order=u.searchParams.get('order');
    if(order){const [c,d]=order.split('.');rows=[...rows].sort((a,b)=>(d==='desc'?-1:1)*(Number(a[c])-Number(b[c])))}
    const lim=u.searchParams.get('limit'); if(lim) rows=rows.slice(0,Number(lim));
    return rows;
  }
  if(m==='POST'){
    const conflict=(u.searchParams.get('on_conflict')||'').split(',').filter(Boolean);
    const out=[];
    for(const rec of (Array.isArray(body)?body:[body])){
      const dup=conflict.length?tables[t].find(r=>conflict.every(k=>String(r[k])===String(rec[k]))):null;
      if(dup){out.push(dup);continue}
      const row={id:seq++,...rec}; tables[t].push(row); out.push(row);
    }
    return out;
  }
  if(m==='PATCH'){ const rows=filter(tables[t],params); rows.forEach(r=>Object.assign(r,body)); return rows }
  throw new Error('method '+m);
}
module.exports={db,tables,reset:()=>{tables.signal_episodes=[];seq=1}};
