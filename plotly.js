(function(){
  const DATA_URL = './norrkoping_jonkoping_manad.json';
  const elChart = document.getElementById('chart');
  const selRange = document.getElementById('range');
  const cbDiff = document.getElementById('showDiff');

  const state = { rows: [], series: {}, months: [], viewIdx: [] };

  init();

  async function init(){
    try{
      const rows = await fetchJSON(DATA_URL);
      state.rows = rows;
      buildSeries();
      setRange(selRange.value);
      selRange.addEventListener('change', ()=>{ setRange(selRange.value); draw(); });
      cbDiff.addEventListener('change', draw);
      draw();
    }catch(err){
      console.error(err);
      elChart.innerHTML = '<div style="padding:8px;color:#f87171">Kunde inte läsa JSON. Kontrollera att filen finns och att sidan körs via http://</div>';
    }
  }

  async function fetchJSON(path){
    const r = await fetch(path, {cache:'no-store'});
    if(!r.ok) throw new Error('Fetch failed: '+path);
    return r.json();
  }

  function buildSeries(){
    // Expect rows: {region, month: 'YYYYMmm', population}
    const byRegion = {};
    const monthSet = new Set();
    for(const r of state.rows){
      monthSet.add(r.month);
      (byRegion[r.region] ||= []).push({m: r.month, y: +r.population});
    }
    const months = Array.from(monthSet).sort();
    // Align series by month order
    for(const k of Object.keys(byRegion)){
      byRegion[k].sort((a,b)=> a.m.localeCompare(b.m));
    }
    state.series = byRegion;
    state.months = months;
  }

  function setRange(val){
    const n = state.months.length;
    if(val === 'all'){ state.viewIdx = Array.from({length:n}, (_,i)=>i); return; }
    const span = Math.min(n, parseInt(val,10)||n);
    const start = Math.max(0, n - span);
    state.viewIdx = Array.from({length: span}, (_,i)=> start + i);
  }


  function draw(){
    const idx = state.viewIdx;
    const x = idx.map(i => toISODate(state.months[i]));

    const regions = Object.keys(state.series || {}).sort();
    const [norrKey, jonkKey] = guessRegionKeys(regions);

    const yN = idx.map(i => pick(state.series[norrKey], i));
    const yJ = idx.map(i => pick(state.series[jonkKey], i));

    const yNplot = yN;
    const yJplot = yJ;

    const norrName = prettyName(norrKey);
    const jonkName = prettyName(jonkKey);
    const cdN = Array(x.length).fill(norrName);
    const cdJ = Array(x.length).fill(jonkName);
    const htMain = '%{x|%b %Y} — %{customdata}: %{y:,.0f}<extra></extra>';

    const traces = [
      { x, y: yNplot, type:'scatter', mode:'lines+markers', name: norrName, customdata: cdN, hovertemplate: htMain, line:{color:getCss('--line-a'), width:2}, marker:{color:getCss('--line-a')} },
      { x, y: yJplot, type:'scatter', mode:'lines+markers', name: jonkName, customdata: cdJ, hovertemplate: htMain, line:{color:getCss('--line-b'), width:2}, marker:{color:getCss('--line-b')} },
    ];

    let diff = null, diffIdx = null;
    if(cbDiff.checked){
      diff = yJ.map((v,i)=> (v ?? null) - (yN[i] ?? null));
      diffIdx = diff;
      const htDiff = '%{x|%b %Y} — Skillnad (J−N): %{y:,.0f}<extra></extra>';
      traces.push({ x, y: diffIdx, type:'bar', name:'Skillnad', hovertemplate: htDiff, marker:{color:getCss('--diff'), opacity:0.85}, yaxis: 'y2' });
    }

    // Compute dynamic y ranges (avoid starting at 0 to see differences better)
    const mainRange = computeRange([yNplot, yJplot]);
    const diffRange = diffIdx ? computeRange([diffIdx]) : null;

    const layout = {
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: {color:getCss('--text')},
      grid: {rows:1, columns:1},
      margin: {t:10, r:20, b:40, l:56},
      xaxis: {title:'', type:'date', tickformat:'%b %Y', tickangle: 0, dtick:'M2', automargin:true, ticklabelmode:'period', ticklabelposition:'outside', rangeslider:{visible:false}, gridcolor:getCss('--grid'), color:getCss('--muted')},
      yaxis: {title: '', gridcolor:getCss('--grid'), color:getCss('--muted'), automargin:true, rangemode:'normal', range: mainRange, tickformat: ',.0f'},
      yaxis2: {overlaying:'y', side:'right', showgrid:false, color:getCss('--muted'), automargin:true, rangemode:'normal', range: diffRange || undefined, title: '', tickformat: ',.0f'},
      legend: {orientation:'h', x:0, y:1.1},
      hovermode:'x unified',
      hoverlabel: {bgcolor:getCss('--panel'), bordercolor:getCss('--beige'), font:{color:getCss('--text')}},
      locale: 'sv'
    };

    const config = {responsive:true, displaylogo:false, modeBarButtonsToRemove:['select2d','lasso2d'], locale:'sv'};

    Plotly.react(elChart, traces, layout, config);
  }

  function computeRange(arrays){
    // arrays: list of y arrays (may contain null)
    let lo = Infinity, hi = -Infinity;
    arrays.forEach(arr => {
      arr.forEach(v => { if(v != null && isFinite(v)){ if(v < lo) lo = v; if(v > hi) hi = v; } });
    });
    if(!isFinite(lo) || !isFinite(hi)) return undefined;
    if(lo === hi){
      const pad = lo === 0 ? 1 : Math.abs(lo)*0.02;
      return [lo - pad, hi + pad];
    }
    const span = hi - lo; const pad = span * 0.05;
    return [lo - pad, hi + pad];
  }

  function pick(series, globalIdx){
    if(!series) return null;
    // series is aligned to full months; find month at index
    const m = state.months[globalIdx];
    if(!m) return null;
    // simple scan ok for ~300 points
    const rec = series.find(p => p.m === m);
    return rec ? rec.y : null;
  }

  function guessRegionKeys(keys){
    // Try to pick Norrköping and Jönköping keys from available names or codes.
    const lc = (s)=> (s||'').toLowerCase();
    let n = keys.find(k => lc(k).includes('norrk')) || keys.find(k => k === '0581');
    let j = keys.find(k => lc(k).includes('jönk') || lc(k).includes('jonk')) || keys.find(k => k === '0680');
    if(!n || !j){
      // Fallback: if only two regions present, take them
      if(keys.length >= 2){
        n = n || keys[0];
        j = j || keys[1];
      }else if(keys.length === 1){
        n = keys[0]; j = keys[0];
      }else{
        n = 'Norrköping'; j = 'Jönköping';
      }
    }
    return [n, j];
  }

  function prettyName(key){
    if(!key) return '';
    if(key === '0581') return 'Norrköping';
    if(key === '0680') return 'Jönköping';
    // Capitalize first letter if code-like not detected
    return key;
  }

  function toISODate(m){
    // m like '2025M07' -> '2025-07-01'
    const [y, rest] = m.split('M');
    const mm = (rest||'01').padStart(2,'0');
    return `${y}-${mm}-01`;
  }
  function getCss(varName){
    try { return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || undefined; } catch(e) { return undefined; }
  }
})();
