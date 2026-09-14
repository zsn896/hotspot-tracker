/* Historical pattern scores are not forward win probabilities. */
(function () {
  'use strict';
  const root = document.getElementById('forwardLedger');
  if (!root) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('ar');
  const pct = value => value == null || !Number.isFinite(Number(value)) ? '—' : (Number(value)*100).toFixed(2)+'٪';
  root.innerHTML = '<div class="ledger-head"><div><h2>هل تتفوق التوقعات على الصدفة؟</h2><p>سجل الإشارات قبل السحب ونتائجها اللاحقة.</p></div><button type="button" id="ledgerRefresh">تحديث السجل</button></div>'+
    '<p>الاختبار: مجموعة من ٥ أرقام. النجاح هو إصابة ٤ أو أكثر في سحب واحد ضمن السحوبات الخمسة التالية. نافذة الإشارة ثابتة.</p>'+
    '<div id="ledgerStatus" class="ledger-status" role="status" aria-live="polite">جارٍ قراءة السجل…</div><div id="ledgerEvidence"></div>';
  const status = root.querySelector('#ledgerStatus');
  const body = root.querySelector('#ledgerEvidence');
  const button = root.querySelector('#ledgerRefresh');
  let busy = false;
  function metric(label, value) {
    return '<div class="ledger-metric"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong></div>';
  }
  function bar(label,value,kind) {
    const width=Math.max(0,Math.min(100,Number(value||0)*100));
    return '<div>'+esc(label)+': <b>'+pct(value)+'</b><div class="ledger-bar '+kind+'"><i style="width:'+width+'%"></i></div></div>';
  }
  function render(data) {
    if (!data || data.ok !== true || !data.overall || !data.chanceModel || !data.recording ||
        !Number.isInteger(data.overall.episodes) || data.overall.episodes < 0) throw Error('Invalid report');
    const o=data.overall, n=o.episodes, sample=data.sample||{};
    status.className='ledger-status'+(data.recording.enabled?'':' ledger-warning');
    status.textContent=data.recording.enabled
      ? 'التسجيل مفعّل في الإعدادات. يجمعه التشغيل الدوري؛ هذا المؤشر وحده لا يؤكد نجاح آخر تشغيل.'
      : 'التسجيل غير مفعّل حاليًا. أي نتائج أدناه محفوظة سابقًا؛ لا تُجمع توقعات جديدة حتى تفعيله.';
    const verdict=!n?'لا توجد نتائج محسومة للحكم بعد.'
      :o.significant?'تفوق ظاهري في هذه العينة؛ يحتاج اختبارًا مستقلًا.':'لم تثبت أفضلية تنبؤية على الصدفة.';
    let html='<p class="ledger-verdict">'+esc(verdict)+'</p>';
    if(sample.capped||sample.openCountCapped) html+='<p class="ledger-status ledger-warning">هذه عينة محدودة وليست كل السجل. عدد الإشارات المعلقة قد يكون حدًا أدنى.</p>';
    html+='<div class="ledger-grid">'+metric('إشارات محسومة',fmt(n))+
      metric('نجاحات / إخفاقات',fmt(o.successes)+' / '+fmt(o.failures))+
      metric('بانتظار النافذة والبيانات',(sample.openCountCapped?'≥ ':'')+fmt(data.openEpisodes))+
      metric('نجاحات متوقعة بالصدفة',fmt(o.expectedByChance))+'</div>';
    if(n) {
      html+='<div class="ledger-comparison">'+bar('النجاح الفعلي',o.observedRate,'observed')+
        bar('المتوقع بالصدفة',data.chanceModel.windowRate,'chance')+
        '<div class="ledger-scale">المقياس لكلا الشريطين: ٠–١٠٠٪. المقارنة للنافذة نفسها.</div></div>';
      const ci=o.confidenceInterval;
      html+='<p>نطاق الثقة الاسمي ٩٥٪: <b>'+(Array.isArray(ci)?pct(ci[0])+' – '+pct(ci[1]):'—')+
        '</b>. نسبة النجاح إلى الصدفة: <b>'+(o.lift==null?'—':esc(o.lift)+'×')+'</b>.</p>';
    } else {
      html+='<p>خط المقارنة بالصدفة: <b>'+pct(data.chanceModel.windowRate)+'</b>. العينة الفارغة لا تعني نسبة نجاح ٠٪. أضف مجموعة خماسية إلى Strong Manual لتصبح مؤهلة للرصد عند صدور STRONG.</p>';
    }
    html+='<p>الحلقات المتداخلة والأهداف المشتركة قد لا تكون مستقلة. النطاق والمقارنة استكشافيان؛ لا يمثلان احتمال فوز التوقع التالي أو إثباتًا للربح.</p>';
    const targets=Array.isArray(data.byTarget)?data.byTarget:[];
    if(targets.length) html+='<h3>النتائج بحسب المجموعة</h3><div class="ledger-table-scroll"><table><thead><tr><th scope="col">الأرقام</th><th scope="col">المحسوم</th><th scope="col">النجاحات</th><th scope="col">النسبة</th><th scope="col">بالصدفة</th></tr></thead><tbody>'+
      targets.map(t=>'<tr><td dir="ltr">'+esc(t.label)+'</td><td>'+fmt(t.episodes)+'</td><td>'+fmt(t.successes)+'</td><td>'+pct(t.observedRate)+'</td><td>'+pct(t.chanceRate)+'</td></tr>').join('')+'</tbody></table></div>';
    const recent=Array.isArray(data.recentEpisodes)?data.recentEpisodes:[];
    html+='<details><summary>سجل آخر ٥٠ إشارة وتوقيت تسجيلها</summary><p>يبدأ الاختبار من السحب التالي لإصدار الإشارة. المعلّق لا يُحسب إخفاقًا؛ قد ينتظر بيانات ناقصة.</p>';
    if(recent.length) html+='<div class="ledger-table-scroll"><table><thead><tr><th scope="col">الأرقام</th><th scope="col">التسجيل UTC</th><th scope="col">صدرت بعد سحب</th><th scope="col">نهاية النافذة</th><th scope="col">النتيجة</th></tr></thead><tbody>'+recent.map(r=>{
      const result=!r.matchesWindow?'نافذة مختلفة؛ خارج المقارنة':!r.resolved?'معلّقة':r.success===true?'نجاح · '+r.bestHitCount+'/5':r.success===false?'إخفاق · '+r.bestHitCount+'/5':'نتيجة غير صالحة؛ لا تُفسّر';
      return '<tr><td dir="ltr">'+esc(r.target)+'</td><td dir="ltr">'+esc(r.recordedAt||'غير متاح')+'</td><td>'+fmt(r.startDrawId)+'</td><td>'+fmt(r.endDrawId)+'</td><td>'+esc(result)+'</td></tr>';
    }).join('')+'</tbody></table></div>'; else html+='<p>لا توجد إشارات محفوظة بعد. لن تُنشأ توقعات بأثر رجعي.</p>';
    html+='</details><details><summary>كيف يعمل التسجيل والمقارنة؟</summary><p>يسجّل التشغيل الدوري إشارات STRONG للأهداف الخماسية ضمن أول ٦ مجموعات Strong Manual نشطة. استمرار الإشارة حلقة واحدة، ولا تمتد نافذة النجاح مع استمرارها. الاحتمال المرجعي لنموذج سحب عادل ومستقل.</p>'+
      '<p>ثبّت نسخة النموذج وقواعد الاختبار قبل تقييم فترة مستقبلية جديدة. لا توقف الاختبار عند أول نتيجة إيجابية؛ انتقاء أفضل قواعد كثيرة قد ينتج تفوقًا مصادفًا.</p>'+
      '<p>للمشرف: يلزم تجهيز جدول السجل ثم تفعيل إعداد التسجيل على الخادم. <a href="https://github.com/zsn896/hotspot-tracker/blob/fix/full-audit-2026-09-13/WIRING.md" target="_blank" rel="noopener noreferrer">تعليمات الإعداد</a>.</p></details>'+
      '<p class="ledger-stamp">وقت جلب التقرير UTC: '+esc(data.generatedAt||'غير متاح')+' · لا يضمن السجل اكتمال جميع تشغيلات الرصد.</p>';
    body.innerHTML=html;
  }
  async function refresh() {
    if(busy)return;
    busy=true;button.disabled=true;status.textContent='جارٍ تحديث السجل…';
    try {
      const response=await fetch('/api/ledger?window=5&threshold=4',{cache:'no-store',signal:AbortSignal.timeout(20000)});
      const data=await response.json();
      if(!response.ok||data.ok!==true)throw Error('Unavailable ledger');
      render(data);
    } catch(_) {
      status.className='ledger-status ledger-warning';
      status.textContent='تعذّر قراءة السجل. لا يمكن عرض حكم على التوقعات الآن.';
      body.innerHTML='<p>تحقق من اتصال الخدمة وتجهيز جدول السجل وإعداداته ثم أعد المحاولة. تعذّر القراءة لا يعني عدم وجود توقعات أو نسبة نجاح صفر.</p>';
    } finally {busy=false;button.disabled=false;}
  }
  button.addEventListener('click',refresh);
  refresh();
  setInterval(()=>{if(document.visibilityState!=='hidden')refresh();},60000);
})();
