const cheerio=require('cheerio');
const OFFICIAL='https://www.calottery.com/en/draw-games/hot-spot/past-winning-numbers';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function uniqSorted(nums){return [...new Set(nums.map(Number))].filter(n=>n>=1&&n<=80).sort((a,b)=>a-b)}
function parse(html){
 const $=cheerio.load(html); const t=$('body').text().replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
 const no=(t.match(/Draw Number:\s*(\d{7})/i)||[])[1];
 const dm=t.match(/Draw Date:\s*([^|]+?)\s*\|\s*Draw Time:\s*([0-9:]+\s*[ap]\.??m\.?)/i);
 if(!no||!dm)return null;
 let seg=t.slice(t.indexOf(dm[0])+dm[0].length); const stop=seg.search(/Check out the Hot Spot|Hot Spot Payouts|Overall odds/i); if(stop>0)seg=seg.slice(0,stop);
 const bull=(seg.match(/Bulls[-‑–—]?eye\s+number\s+is(?:\s*\{number\})?\s*(?:number\s*)?(\d{1,2})/i)||[])[1];
 const raw=seg.match(/\b(?:[1-9]|[1-7]\d|80)\b/g)||[]; const numbers=uniqSorted(raw.slice(0,20)); if(numbers.length!==20)return null;
 const bullsEye=bull?Number(bull):null;
 return {id:+no,date:dm[1].trim(),time:dm[2].trim(),numbers,bullsEye};
}
function valid(d){return d&&Number.isInteger(d.id)&&d.numbers?.length===20&&new Set(d.numbers).size===20&&d.numbers.every(n=>n>=1&&n<=80)&&(d.bullsEye===null||(Number.isInteger(d.bullsEye)&&d.bullsEye>=1&&d.bullsEye<=80&&d.numbers.includes(d.bullsEye)))}
async function getDraw(id){
 let last; for(let a=0;a<3;a++)try{
  const u=new URL(OFFICIAL); if(id)u.searchParams.set('query',id); u.searchParams.set('_v',Date.now().toString(36)+Math.random().toString(36).slice(2));
  const r=await fetch(u,{cache:'no-store',headers:{'user-agent':'Mozilla/5.0','cache-control':'no-cache','pragma':'no-cache','accept-language':'en-US,en;q=0.9'}});
  if(!r.ok)throw Error(`California Lottery HTTP ${r.status}`); const d=parse(await r.text()); if(!valid(d))throw Error('invalid parsed draw'); if(id&&d.id!==id)throw Error(`expected ${id}, got ${d.id}`); return d;
 }catch(e){last=e;await sleep(150*(a+1))}
 throw last||Error('fetch failed');
}
async function getMany(ids){const out=[];const C=8;for(let i=0;i<ids.length;i+=C){out.push(...await Promise.all(ids.slice(i,i+C).map(getDraw)))}return out.sort((a,b)=>a.id-b.id)}
function score(draw,group){const set=new Set(draw.numbers);const hit=group.filter(n=>set.has(n));const bullsEyeMatch=Number.isInteger(draw.bullsEye)&&group.includes(draw.bullsEye);return {count:hit.length,hit,bullsEye:draw.bullsEye,bullsEyeMatch};}
function sb(){const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw Error('Supabase environment variables are missing');return {url:url.replace(/\/$/,''),key}}
async function db(path,{method='GET',body,prefer}={}){const {url,key}=sb();const h={'apikey':key,'authorization':`Bearer ${key}`,'content-type':'application/json'};if(prefer)h['prefer']=prefer;const r=await fetch(`${url}/rest/v1/${path}`,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});const txt=await r.text();if(!r.ok)throw Error(`Supabase ${r.status}: ${txt.slice(0,300)}`);if(!txt)return null;try{return JSON.parse(txt)}catch{return txt}}
module.exports={uniqSorted,getDraw,getMany,score,db};
