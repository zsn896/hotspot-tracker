async function startManual(){
  const msg = document.getElementById('manualMsg');
  const btn = document.getElementById('manualStart');

  try{
    const nums = [1,2,3,4,5].map(i=>
      Number(document.getElementById('m'+i).value)
    );

    if(nums.some(n=>!Number.isInteger(n) || n<1 || n>80)){
      throw Error('Enter 5 numbers from 1 to 80.');
    }

    if(new Set(nums).size !== 5){
      throw Error('All 5 numbers must be different.');
    }

    btn.disabled = true;
    msg.className = 'small mut';
    msg.textContent = 'Starting…';

    const j = await api('/api/group',{
      method:'POST',
      headers:{
        'content-type':'application/json'
      },
      body:JSON.stringify({
        numbers:nums
      })
    });

    msg.className = 'small ok';

    msg.textContent =
      `Tracking started after draw ${
        j?.latest?.id ??
        j?.manual?.startDrawId ??
        ''
      }.`;

    renderManual(j);

  }catch(e){

    msg.className = 'small bad';

    msg.textContent =
      String(
        e?.message ||
        e
      );

  }finally{

    btn.disabled = false;

  }
}
