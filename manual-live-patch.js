(function(){
  'use strict';

  var cache = null;
  var busy = false;
  var installed = false;

  function esc(v){
    return String(v == null ? '' : v)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function bySlot(slot){
    if(!cache || !Array.isArray(cache.groups)) return null;
    return cache.groups.find(function(g){ return Number(g.slot) === Number(slot); }) || null;
  }

  function renderSlot(slot){
    var g = bySlot(slot);
    var content = document.getElementById('manualContent'+slot);
    var state = document.getElementById('manualState'+slot);

    if(!g || !content) return;

    var summary = content.querySelector('.manualSummary');
    if(!summary) return;

    var metrics = summary.querySelectorAll('.manualMetric');

    /* Fix the existing Best card: the old UI used the latest hit, not the best. */
    if(metrics[0]){
      var label0 = metrics[0].querySelector('.manualMetricLabel');
      var value0 = metrics[0].querySelector('.manualMetricValue');
      if(label0) label0.textContent = 'Best';
      if(value0) value0.textContent = Number(g.bestHit || 0) + '/5';
    }

    /* Keep 3+ total accurate for the whole current cycle. */
    if(metrics[1]){
      var label1 = metrics[1].querySelector('.manualMetricLabel');
      var value1 = metrics[1].querySelector('.manualMetricValue');
      if(label1) label1.textContent = '3/5+';
      if(value1) value1.textContent = Number(g.threePlus || 0);
    }

    /* Distinguish last strong hit from the true tracking/update cursor. */
    if(metrics[2]){
      var label2 = metrics[2].querySelector('.manualMetricLabel');
      var value2 = metrics[2].querySelector('.manualMetricValue');
      if(label2) label2.textContent = 'Last 3+ Hit';
      if(value2) value2.textContent = g.lastStrongDrawId || '—';
    }

    var old = content.querySelector('.manualLiveSummary');
    if(old) old.remove();

    var box = document.createElement('div');
    box.className = 'manualLiveSummary';
    box.style.marginTop = '10px';
    box.style.padding = '10px 12px';
    box.style.border = '1px solid rgba(85,162,255,.30)';
    box.style.borderRadius = '11px';
    box.style.background = 'rgba(7,17,31,.34)';
    box.style.fontSize = '12px';
    box.style.lineHeight = '1.7';

    var status = g.current
      ? '<span style="color:#43ea82;font-weight:900">CURRENT</span>'
      : '<span style="color:#ffb14e;font-weight:900">BEHIND '+Number(g.lag || 0)+' DRAW'+(Number(g.lag||0)===1?'':'S')+'</span>';

    box.innerHTML =
      'Updated through draw <b>#'+esc(g.trackingLastSeenDrawId || '—')+'</b> · '+status+
      '<br><b>Exact hits this cycle:</b> '
      +'<span style="color:#55a2ff">3/5 × '+Number(g.exact3 || 0)+'</span>'
      +' · <span style="color:#ffb14e">4/5 × '+Number(g.exact4 || 0)+'</span>'
      +' · <span style="color:#43ea82">5/5 × '+Number(g.exact5 || 0)+'</span>'
      +' · <b>4/5+ × '+Number(g.fourPlus || 0)+'</b>';

    summary.insertAdjacentElement('afterend', box);

    if(state && g.active){
      state.className = g.current ? 'manualState ok' : 'manualState amber';
      state.textContent = g.current
        ? '● Tracking · Current #'+String(g.trackingLastSeenDrawId || '')
        : '● Tracking · Behind '+String(g.lag || 0)+' draw'+(Number(g.lag||0)===1?'':'s');
    }
  }

  function renderAll(){
    renderSlot(1);
    renderSlot(2);
    renderSlot(3);
  }

  async function refresh(){
    if(busy || document.visibilityState === 'hidden') return;
    busy = true;

    try{
      /* First align the stored draw and Manual Groups 1/2/3. This endpoint is
         intentionally lightweight now and never launches the heavy cron on GET. */
      try{
        await fetch('/api/sync?ts='+Date.now(), {cache:'no-store'});
      }catch(_){ }

      var r = await fetch('/api/manual-summary?ts='+Date.now(), {cache:'no-store'});
      if(!r.ok) return;

      var j = await r.json();
      if(!j || j.ok === false) return;

      cache = j;
      renderAll();
    }catch(_){
      /* Keep the normal page usable if this optional live summary cannot load. */
    }finally{
      busy = false;
    }
  }

  function installRenderHook(){
    if(installed) return;

    if(typeof window.renderManualSlot !== 'function'){
      setTimeout(installRenderHook, 250);
      return;
    }

    installed = true;
    var original = window.renderManualSlot;

    window.renderManualSlot = function(slot, manual){
      var out = original.apply(this, arguments);
      setTimeout(function(){ renderSlot(slot); }, 0);
      return out;
    };
  }

  installRenderHook();
  setTimeout(refresh, 1200);
  setInterval(refresh, 60000);

  window.addEventListener('focus', function(){ setTimeout(refresh, 300); });
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'visible') setTimeout(refresh, 300);
  });
})();
