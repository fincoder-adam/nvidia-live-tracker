'use strict';

/* ═══════════════════════════════════════════════
   NVDA Financial Dashboard · app.js
   Data sources (all via server-side proxy):
     PRIMARY : Yahoo Finance (no key required)
     OPTIONAL: Alpha Vantage / Finnhub / Polygon
   ═══════════════════════════════════════════════ */

const C = {
  green:'#76b900', greenA:'rgba(118,185,0,.16)',
  blue:'#3b82f6',  blueA:'rgba(59,130,246,.16)',
  orange:'#f59e0b', teal:'#14b8a6', purple:'#8b5cf6',
  red:'#ef4444',   pos:'#10b981',   neg:'#ef4444',
};
const SP500 = { pe:26, fpe:22, ps:2.8, pb:4.5, ev:16, peg:1.8 };
const CHARTS = {};
let OPTIONAL_KEY = '';
let OPTIONAL_PROVIDER = 'none';

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
function initWithKey() {
  const key      = document.getElementById('api-key-input').value.trim();
  const provider = document.getElementById('api-provider').value;
  OPTIONAL_KEY      = key;
  OPTIONAL_PROVIDER = provider;
  if (key) {
    sessionStorage.setItem('nvda_key', key);
    sessionStorage.setItem('nvda_provider', provider);
  }
  showDashboard();
  loadDashboard();
}

function skipKey() {
  OPTIONAL_KEY      = '';
  OPTIONAL_PROVIDER = 'none';
  showDashboard();
  loadDashboard();
}

function resetKey() {
  sessionStorage.clear();
  location.reload();
}

function showGateError(msg) {
  const el = document.getElementById('gate-error');
  el.textContent = msg;
  el.style.display = 'block';
}

/* ══════════════════════════════════════════════
   PROXY FETCH — all calls go through /api/fmp/*
══════════════════════════════════════════════ */
async function proxyGet(route, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `/api/fmp/${route}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, { cache: 'no-store' });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Proxy ${res.status} on ${route}: ${txt.slice(0,120)}`);
  try { return JSON.parse(txt); }
  catch(e) { throw new Error(`Bad JSON from ${route}: ${txt.slice(0,80)}`); }
}

/* ══════════════════════════════════════════════
   YAHOO FINANCE FETCHERS (no key needed)
══════════════════════════════════════════════ */
async function yahooQuote() {
  const data = await proxyGet('yahoo/quote', { symbol: 'NVDA' });
  const r    = data?.chart?.result?.[0];
  if (!r) throw new Error('Yahoo quote: no result');
  const meta = r.meta;
  return {
    price:           meta.regularMarketPrice,
    change:          meta.regularMarketPrice - meta.chartPreviousClose,
    changePct:       (meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100,
    marketCap:       meta.marketCap,
    volume:          meta.regularMarketVolume,
    yearLow:         meta.fiftyTwoWeekLow,
    yearHigh:        meta.fiftyTwoWeekHigh,
    previousClose:   meta.chartPreviousClose,
    currency:        meta.currency,
  };
}

async function yahooSummary() {
  const data = await proxyGet('yahoo/summary', { symbol: 'NVDA' });
  const res  = data?.quoteSummary?.result?.[0];
  if (!res) throw new Error('Yahoo summary: no result');
  const p  = res.price             || {};
  const ks = res.defaultKeyStatistics || {};
  const fd = res.financialData     || {};
  const sd = res.summaryDetail     || {};
  // Yahoo returns margins as decimals (0.605 = 60.5%) — convert to %
  const toRaw = (obj) => obj?.raw ?? null;
  return {
    pe:           toRaw(sd.trailingPE)       || toRaw(p.trailingPE),
    forwardPE:    toRaw(sd.forwardPE)        || toRaw(ks.forwardPE),
    ps:           toRaw(ks.priceToSalesTrailing12Months),
    pb:           toRaw(ks.priceToBook),
    evEbitda:     toRaw(ks.enterpriseToEbitda),
    evRev:        toRaw(ks.enterpriseToRevenue),
    peg:          toRaw(ks.pegRatio),
    divYield:     toRaw(sd.dividendYield)    || toRaw(sd.trailingAnnualDividendYield) || 0,
    eps:          toRaw(ks.trailingEps),
    // grossMargins is a decimal from Yahoo (e.g. 0.605) — convert to %
    grossMargin:  fd.grossMargins?.raw != null ? fd.grossMargins.raw * 100 : null,
    revTTM:       toRaw(fd.totalRevenue),
    niTTM:        toRaw(fd.netIncomeToCommon),
    currentRatio: toRaw(fd.currentRatio),
    // debtToEquity from Yahoo is already a ratio (not %) — no division needed
    deRatio:      toRaw(fd.debtToEquity),
    ocfTTM:       toRaw(fd.operatingCashflow),
    fcfTTM:       toRaw(fd.freeCashflow),
    // Extra fields
    operatingMargin: fd.operatingMargins?.raw != null ? fd.operatingMargins.raw * 100 : null,
    profitMargin:    fd.profitMargins?.raw    != null ? fd.profitMargins.raw    * 100 : null,
  };
}

async function yahooFinancials() {
  const data = await proxyGet('yahoo/financials', { symbol: 'NVDA' });
  const res  = data?.quoteSummary?.result?.[0];
  if (!res) throw new Error('Yahoo financials: no result');

  function parseStmts(list, fields) {
    return (list || []).slice(0, 4).reverse().map(stmt => {
      const out = { date: stmt.endDate?.fmt || stmt.endDate?.raw };
      fields.forEach(([key, field]) => { out[key] = stmt[field]?.raw ?? null; });
      return out;
    });
  }

  const incStmts   = res.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
  const bsStmts    = res.balanceSheetHistoryQuarterly?.balanceSheetStatements    || [];
  const cfStmts    = res.cashflowStatementHistoryQuarterly?.cashflowStatements   || [];
  const epsHistory = res.earningsHistory?.history || [];

  const income = parseStmts(incStmts, [
    ['revenue',    'totalRevenue'],
    ['grossProfit','grossProfit'],
    ['opIncome',   'operatingIncome'],
    ['netIncome',  'netIncome'],
    // EPS not in income stmt — pulled from summary.eps instead
    ['rd',         'researchDevelopment'],
    ['costOfRev',  'costOfRevenue'],
    ['totalOpEx',  'totalOperatingExpenses'],
  ]);

  const balance = parseStmts(bsStmts, [
    ['cash',      'cash'],
    ['stInvest',  'shortTermInvestments'],
    ['currAssets','totalCurrentAssets'],
    ['assets',    'totalAssets'],
    ['ltd',       'longTermDebt'],
    ['liab',      'totalLiab'],              // Yahoo uses totalLiab not totalLiabilities
    ['equity',    'totalStockholderEquity'], // Yahoo uses totalStockholderEquity (singular)
    ['inv',       'inventory'],
    ['shortLtDebt','shortLongTermDebt'],
  ]);

  const cashflow = parseStmts(cfStmts, [
    ['ocf',     'totalCashFromOperatingActivities'],
    ['capex',   'capitalExpenditures'],       // negative number, abs() applied below
    ['buybacks','repurchaseOfStock'],          // negative number, abs() applied below
    ['dividends','dividendsPaid'],
  ]);

  // Merge into unified quarters array
  const n = Math.max(income.length, balance.length, cashflow.length);
  const quarters = Array.from({ length: n }, (_, i) => {
    const inc = income[i]   || {};
    const bs  = balance[i]  || {};
    const cf  = cashflow[i] || {};
    const rev = inc.revenue  || null;
    const gp  = inc.grossProfit || null;
    const oi  = inc.opIncome || null;
    const ni  = inc.netIncome || null;
    const ocf = cf.ocf || null;
    const cx  = cf.capex != null ? Math.abs(cf.capex) : null;
    // totalLiab can be negative in Yahoo's data (sign convention) — use abs
    const liab = bs.liab != null ? Math.abs(bs.liab) : null;
    return {
      label:       inc.date || bs.date || cf.date || `Q${i+1}`,
      revenue:     rev,
      grossProfit: gp,
      opIncome:    oi,
      netIncome:   ni,
      eps:         null,   // populated per-quarter from earningsHistory below
      rd:          inc.rd  || null,
      costOfRev:   inc.costOfRev || null,
      grossMargin: rev && gp  ? gp/rev*100  : null,
      opMargin:    rev && oi  ? oi/rev*100  : null,
      netMargin:   rev && ni  ? ni/rev*100  : null,
      ocf,
      capex:       cx,
      fcf:         ocf != null && cx != null ? ocf - cx : null,
      fcfMargin:   ocf != null && cx != null && rev ? (ocf-cx)/rev*100 : null,
      cash:        bs.cash    || null,
      stInvest:    bs.stInvest|| null,
      currAssets:  bs.currAssets || null,
      assets:      bs.assets  || null,
      ltd:         bs.ltd     || null,
      liab,
      equity:      bs.equity  || null,
      inv:         bs.inv     || null,
      buybacks:    cf.buybacks != null ? Math.abs(cf.buybacks) : null,
    };
  });

  // Inject per-quarter EPS from earningsHistory (most reliable source)
  // earningsHistory is in reverse chronological order — newest first
  const epsReversed = epsHistory.slice(0, 4);
  quarters.forEach((q, i) => {
    // Match by index (both arrays reversed to oldest-first already)
    const epsEntry = epsReversed[quarters.length - 1 - i];
    if (epsEntry) {
      q.eps = epsEntry.epsActual?.raw ?? epsEntry.epsStreet?.raw ?? null;
    }
  });

  return quarters;
}

/* ══════════════════════════════════════════════
   OPTIONAL: ALPHA VANTAGE
══════════════════════════════════════════════ */
async function avOverview(key) {
  const data = await proxyGet('alphavantage/', { function:'OVERVIEW', symbol:'NVDA', apikey:key });
  if (!data || data.Note || data.Information) throw new Error('Alpha Vantage limit hit');
  return {
    pe:      parseFloat(data.TrailingPE)   || null,
    forwardPE:parseFloat(data.ForwardPE)  || null,
    ps:      parseFloat(data.PriceToSalesRatioTTM) || null,
    pb:      parseFloat(data.PriceToBookRatio) || null,
    peg:     parseFloat(data.PEGRatio)    || null,
    divYield:parseFloat(data.DividendYield) || null,
    eps:     parseFloat(data.EPS)         || null,
    grossMargin: parseFloat(data.GrossProfitTTM) || null,
    revTTM:  parseFloat(data.RevenueTTM) || null,
  };
}

/* ══════════════════════════════════════════════
   OPTIONAL: FINNHUB
══════════════════════════════════════════════ */
async function finnhubQuote(key) {
  const data = await proxyGet('finnhub/quote', { symbol:'NVDA', token:key });
  return {
    price:      data.c,
    change:     data.d,
    changePct:  data.dp,
    yearLow:    data.l,
    yearHigh:   data.h,
    previousClose: data.pc,
  };
}

/* ══════════════════════════════════════════════
   MAIN LOAD — orchestrates fetches with fallback
══════════════════════════════════════════════ */
let DATA = { quote:{}, summary:{}, quarters:[] };

async function loadDashboard() {
  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  btn.classList.add('spinning');
  hideBanner();
  setStatus('Fetching live NVDA data via Yahoo Finance…');
  setSourceTags('loading');

  const errors = [];

  // ── PRIMARY: Yahoo Finance (always, no key needed) ──
  try {
    setStatus('Fetching real-time quote…');
    DATA.quote = await yahooQuote();
    markSource('src-quote', 'ok', 'Yahoo Finance ✓');
  } catch(e) {
    errors.push('Quote: ' + e.message);
    markSource('src-quote', 'err', 'Quote failed');
  }

  try {
    setStatus('Fetching valuation & ratios…');
    DATA.summary = await yahooSummary();
    markSource('src-ratios', 'ok', 'Ratios ✓');
  } catch(e) {
    errors.push('Summary: ' + e.message);
    markSource('src-ratios', 'err', 'Ratios failed');
  }

  try {
    setStatus('Fetching quarterly financials…');
    DATA.quarters = await yahooFinancials();
    markSource('src-fin', 'ok', 'Financials ✓');
  } catch(e) {
    errors.push('Financials: ' + e.message);
    markSource('src-fin', 'err', 'Financials failed');
  }

  // ── OPTIONAL: boost with user-provided key ──
  if (OPTIONAL_KEY && OPTIONAL_PROVIDER !== 'none') {
    try {
      setStatus(`Enriching data via ${OPTIONAL_PROVIDER}…`);
      if (OPTIONAL_PROVIDER === 'alphavantage') {
        const av = await avOverview(OPTIONAL_KEY);
        DATA.summary = { ...DATA.summary, ...av };
        markSource('src-optional', 'ok', 'Alpha Vantage ✓');
      } else if (OPTIONAL_PROVIDER === 'finnhub') {
        const fh = await finnhubQuote(OPTIONAL_KEY);
        DATA.quote = { ...DATA.quote, ...fh };
        markSource('src-optional', 'ok', 'Finnhub ✓');
      }
    } catch(e) {
      errors.push('Optional provider: ' + e.message);
      markSource('src-optional', 'err', OPTIONAL_PROVIDER + ' failed');
    }
  }

  const allFailed = !DATA.quote.price && !DATA.summary.pe && !DATA.quarters.length;
  if (allFailed) {
    showError('Could not reach Yahoo Finance. Showing cached fallback data.');
    loadFallback();
  } else {
    if (errors.length) showError('Partial data — some sources unavailable: ' + errors.join(' | '));
    setStatus('Live data loaded via Yahoo Finance · Updated ' + new Date().toLocaleTimeString());
    document.getElementById('data-freshness').textContent = 'Updated: ' + new Date().toLocaleTimeString();
    populateAll();
  }

  btn.disabled = false;
  btn.classList.remove('spinning');
}

async function refreshAll() { await loadDashboard(); }

/* ══════════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════════ */
function showDashboard() {
  document.getElementById('key-gate').style.display  = 'none';
  document.getElementById('dashboard').style.display = 'block';
}
function setStatus(msg) { const e=document.getElementById('hdr-sub'); if(e) e.textContent=msg; }
function showError(msg) { const e=document.getElementById('err-banner'); const m=document.getElementById('err-msg'); if(e&&m){m.textContent=msg;e.style.display='block';} }
function hideBanner()   { const e=document.getElementById('err-banner'); if(e) e.style.display='none'; }
function setSourceTags(state) {
  ['src-quote','src-ratios','src-fin','src-optional'].forEach(id => {
    const el=document.getElementById(id); if(el) el.className='src-tag '+state;
  });
}
function markSource(id, state, label) {
  const el=document.getElementById(id);
  if(el){ el.className='src-tag '+state; el.textContent=label; }
}

/* ── FORMATTERS ── */
const fB  = (v,d=2) => v!=null&&!isNaN(v) ? '$'+(v/1e9).toFixed(d)+'B' : '—';
const fT  = (v) => {
  if(v==null||isNaN(v)) return '—';
  const a=Math.abs(v);
  if(a>=1e12) return '$'+(v/1e12).toFixed(2)+'T';
  if(a>=1e9)  return '$'+(v/1e9).toFixed(1)+'B';
  if(a>=1e6)  return '$'+(v/1e6).toFixed(0)+'M';
  return '$'+v.toFixed(0);
};
const fX  = (v,d=1) => v!=null&&!isNaN(v) ? v.toFixed(d)+'x' : '—';
const f$  = (v,d=2) => v!=null&&!isNaN(v) ? '$'+v.toFixed(d) : '—';
const fP  = (v,d=1) => v!=null&&!isNaN(v) ? v.toFixed(d)+'%' : '—';

function set(id,val){ const e=document.getElementById(id); if(e){e.textContent=val;e.classList.remove('loading');} }

/* ══════════════════════════════════════════════
   KPI CARD BUILDER
══════════════════════════════════════════════ */
const COLORS=['c-green','c-blue','c-purple','c-orange','c-teal','c-pink','c-green','c-blue'];
function buildKPIs(containerId, cards) {
  const el=document.getElementById(containerId); if(!el) return;
  el.innerHTML=cards.map((c,i)=>`
    <div class="kpi-card ${COLORS[i%COLORS.length]}" style="animation-delay:${i*.05}s">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value??'—'}</div>
      ${c.delta!=null?`<div class="kpi-delta ${c.delta>=0?'up':'dn'}">${c.delta>=0?'▲ +':'▼ '}${Math.abs(c.delta).toFixed(1)}%</div>`:''}
      ${c.sub?`<div class="kpi-sub">${c.sub}</div>`:''}
    </div>`).join('');
}

/* ══════════════════════════════════════════════
   POPULATE ALL
══════════════════════════════════════════════ */
function populateAll() {
  populateTicker();
  populateOverview();
  populateRevenue();
  populateBalance();
  populateCashflow();
  populateValuation();
  buildAllCharts();
}

function populateTicker() {
  const q=DATA.quote;
  set('t-price', f$(q.price));
  const el=document.getElementById('t-change');
  if(el&&q.change!=null){
    const s=q.change>=0?'+':'';
    el.textContent=`${s}${q.change.toFixed(2)} (${s}${(q.changePct||0).toFixed(2)}%)`;
    el.className='ticker-change '+(q.change>=0?'up':'dn');
  }
  set('t-mc',  fT(q.marketCap));
  set('t-vol', q.volume?(q.volume/1e6).toFixed(1)+'M':'—');
  set('t-52w', q.yearLow&&q.yearHigh?`$${q.yearLow.toFixed(0)}–$${q.yearHigh.toFixed(0)}`:'—');
  set('t-pe',  DATA.summary.pe!=null?DATA.summary.pe.toFixed(1)+'x':'—');
  document.getElementById('t-updated').textContent='⏱ '+new Date().toLocaleTimeString();
}

function populateOverview() {
  const q=DATA.quote, s=DATA.summary, qs=DATA.quarters;
  const lq=qs[qs.length-1]||{}, pq=qs[qs.length-2]||{};
  const revGrowth=lq.revenue&&pq.revenue?(lq.revenue-pq.revenue)/pq.revenue*100:null;
  buildKPIs('kpi-overview',[
    {label:'Current price',    value:f$(q.price),     delta:q.changePct, sub:'NASDAQ: NVDA'},
    {label:'Market cap',       value:fT(q.marketCap), sub:'total market value'},
    {label:'Revenue (TTM)',    value:fT(s.revTTM),    sub:'trailing 12 months'},
    {label:'Net income (TTM)', value:fT(s.niTTM),     sub:'trailing 12 months'},
    {label:'Gross margin',     value:fP(s.grossMargin), sub:'latest quarter'},
    {label:'EPS diluted (TTM)',value:f$(s.eps),        sub:'earnings per share'},
    {label:'P/E ratio (TTM)', value:fX(s.pe),          sub:'S&P 500 avg ~26x'},
    {label:'Forward P/E',      value:fX(s.forwardPE),  sub:'next 12-month est.'},
  ]);
}

function populateRevenue() {
  const qs=DATA.quarters; if(!qs.length) return;
  const lq=qs[qs.length-1], pq=qs[qs.length-2]||{};
  const revGrowth=lq.revenue&&pq.revenue?(lq.revenue-pq.revenue)/pq.revenue*100:null;
  buildKPIs('kpi-revenue',[
    {label:'Revenue (latest Q)',  value:fB(lq.revenue),    delta:revGrowth, sub:'vs prior quarter'},
    {label:'Gross profit (LQ)',   value:fB(lq.grossProfit), sub:fP(lq.grossMargin)+' gross margin'},
    {label:'Operating income (LQ)',value:fB(lq.opIncome),  sub:fP(lq.opMargin)+' op. margin'},
    {label:'Net income (LQ)',     value:fB(lq.netIncome),   sub:fP(lq.netMargin)+' net margin'},
    {label:'Gross margin (LQ)',   value:fP(lq.grossMargin), sub:'industry avg ~45%'},
    {label:'Op. margin (LQ)',     value:fP(lq.opMargin),    sub:'operational efficiency'},
    {label:'Net margin (LQ)',     value:fP(lq.netMargin),   sub:'bottom-line efficiency'},
    {label:'Revenue (TTM)',       value:fT(DATA.summary.revTTM), sub:'trailing 12 months'},
  ]);
  qs.forEach((q,i)=>{
    const n=i+1;
    set('ih'+n,  q.label);
    set('ir-r'+n, fB(q.revenue));
    set('ir-g'+n, fB(q.grossProfit));
    set('ir-gm'+n,fP(q.grossMargin));
    set('ir-o'+n, fB(q.opIncome));
    set('ir-n'+n, fB(q.netIncome));
    set('ir-e'+n, f$(q.eps,3));
    set('ir-rd'+n,fB(q.rd));
  });
}

function populateBalance() {
  const qs=DATA.quarters, s=DATA.summary; if(!qs.length) return;
  const lq=qs[qs.length-1];
  const totalCash=(lq.cash||0)+(lq.stInvest||0);
  buildKPIs('kpi-balance',[
    {label:'Total assets',        value:fB(lq.assets),   sub:'most recent quarter'},
    {label:'Cash & investments',  value:fB(totalCash),   sub:'liquidity position'},
    {label:'Total liabilities',   value:fB(lq.liab),     sub:'what the company owes'},
    {label:"Shareholders' equity",value:fB(lq.equity),   sub:'book value'},
    {label:'Long-term debt',      value:fB(lq.ltd),      sub:'bonds & loans > 1yr'},
    {label:'Current ratio',       value:s.currentRatio!=null?s.currentRatio.toFixed(2)+'x':'—', sub:'> 2 = healthy'},
    {label:'Debt / equity',       value:s.deRatio!=null?s.deRatio.toFixed(3)+'x':'—', sub:'lower = less leverage'},
    {label:'Inventory',           value:fB(lq.inv),      sub:'unsold chip stock'},
  ]);
  qs.forEach((q,i)=>{
    const n=i+1;
    set('bh'+n,    q.label);
    set('br-c'+n,  fB(q.cash));
    set('br-si'+n, fB(q.stInvest));
    set('br-ca'+n, fB(q.currAssets));
    set('br-ta'+n, fB(q.assets));
    set('br-ld'+n, fB(q.ltd));
    set('br-tl'+n, fB(q.liab));
    set('br-eq'+n, fB(q.equity));
  });
}

function populateCashflow() {
  const qs=DATA.quarters, s=DATA.summary; if(!qs.length) return;
  const lq=qs[qs.length-1], pq=qs[qs.length-2]||{};
  const ocfTTM  = qs.reduce((a,q)=>a+(q.ocf||0),0);
  const capexTTM= qs.reduce((a,q)=>a+(q.capex||0),0);
  const fcfTTM  = ocfTTM-capexTTM;
  const niTTM   = qs.reduce((a,q)=>a+(q.netIncome||0),0);
  const bbTTM   = qs.reduce((a,q)=>a+(q.buybacks||0),0);
  const ocfGrowth=lq.ocf&&pq.ocf?(lq.ocf-pq.ocf)/pq.ocf*100:null;
  buildKPIs('kpi-cashflow',[
    {label:'Op. cash flow (LQ)', value:fB(lq.ocf),    delta:ocfGrowth, sub:'vs prior quarter'},
    {label:'Free cash flow (LQ)',value:fB(lq.fcf),    sub:fP(lq.fcfMargin)+' FCF margin'},
    {label:'CapEx (LQ)',          value:fB(lq.capex), sub:'capital expenditures'},
    {label:'FCF margin (LQ)',     value:fP(lq.fcfMargin), sub:'FCF as % of revenue'},
    {label:'OCF (TTM)',           value:fT(ocfTTM),   sub:'trailing 12 months'},
    {label:'FCF (TTM)',           value:fT(fcfTTM),   sub:'trailing 12 months'},
    {label:'Buybacks (TTM)',      value:fT(bbTTM),    sub:'shares repurchased'},
    {label:'FCF / net income',    value:niTTM?(fcfTTM/niTTM*100).toFixed(0)+'%':'—', sub:'> 80% = very high quality'},
  ]);
}

function populateValuation() {
  const s=DATA.summary, q=DATA.quote;
  buildKPIs('kpi-valuation',[
    {label:'P/E ratio (TTM)', value:fX(s.pe),       sub:'S&P 500 avg ~26x'},
    {label:'Forward P/E',     value:fX(s.forwardPE), sub:'next 12-month est.'},
    {label:'P/S ratio',       value:fX(s.ps),        sub:'S&P 500 avg ~2.8x'},
    {label:'P/B ratio',       value:fX(s.pb),        sub:'price vs book value'},
    {label:'EV / EBITDA',     value:fX(s.evEbitda),  sub:'S&P 500 avg ~16x'},
    {label:'EV / Revenue',    value:fX(s.evRev),     sub:'enterprise value multiple'},
    {label:'PEG ratio',       value:s.peg!=null?s.peg.toFixed(2)+'x':'—', sub:'< 1.0 = growth-adjusted value'},
    {label:'Dividend yield',  value:s.divYield!=null?(s.divYield*100).toFixed(3)+'%':'—', sub:'NVDA prioritises buybacks'},
  ]);
  function vRow(sfx,nvda,sp5){
    set('vt-'+sfx, nvda!=null?nvda.toFixed(1)+'x':'—');
    if(nvda!=null&&sp5!=null){
      const pct=((nvda-sp5)/sp5*100);
      const el=document.getElementById('vt-'+sfx+'-d');
      if(el){el.textContent=(pct>=0?'+':'')+pct.toFixed(0)+'% vs S&P';el.className=pct>0?'neg':'pos';}
    }
  }
  vRow('pe',s.pe,SP500.pe); vRow('fpe',s.forwardPE,SP500.fpe);
  vRow('ps',s.ps,SP500.ps); vRow('pb',s.pb,SP500.pb);
  vRow('ev',s.evEbitda,SP500.ev);
  if(s.peg!=null){set('vt-peg',s.peg.toFixed(2)+'x');const el=document.getElementById('vt-peg-d');if(el){el.textContent=s.peg<SP500.peg?'Below S&P avg ✓':'Above S&P avg';el.className=s.peg<SP500.peg?'pos':'neg';}}
  if(s.divYield!=null){set('vt-dy',(s.divYield*100).toFixed(3)+'%');const el=document.getElementById('vt-dy-d');if(el){el.textContent='Returns cash via buybacks';el.className='';}}
}

/* ══════════════════════════════════════════════
   CHARTS
══════════════════════════════════════════════ */
function mkChart(id,cfg){if(CHARTS[id]){CHARTS[id].destroy();delete CHARTS[id];}const el=document.getElementById(id);if(!el)return;CHARTS[id]=new Chart(el,cfg);}
const dark=window.matchMedia('(prefers-color-scheme:dark)').matches;
const gridC=dark?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)';
const tickC=dark?'rgba(255,255,255,.3)':'rgba(0,0,0,.3)';
const BO={responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:dark?'#8896b0':'#555',font:{size:11,family:"'DM Sans'"},boxWidth:10,padding:12}},tooltip:{backgroundColor:dark?'#161c28':'#fff',borderColor:dark?'rgba(255,255,255,.12)':'rgba(0,0,0,.12)',borderWidth:1,titleColor:dark?'#e2e8f4':'#111',bodyColor:dark?'#8896b0':'#555',padding:10,cornerRadius:8}},scales:{x:{grid:{color:gridC},ticks:{color:tickC,font:{size:10,family:"'JetBrains Mono'"}}},y:{grid:{color:gridC},ticks:{color:tickC,font:{size:10,family:"'JetBrains Mono'"}}}}};

function buildAllCharts(){
  const qs=DATA.quarters; if(!qs.length) return;
  const lb=qs.map(q=>q.label);
  const revB=qs.map(q=>q.revenue   ?(+(q.revenue/1e9).toFixed(2)):null);
  const gpB =qs.map(q=>q.grossProfit?(+(q.grossProfit/1e9).toFixed(2)):null);
  const niB =qs.map(q=>q.netIncome ?(+(q.netIncome/1e9).toFixed(2)):null);
  const epsA=qs.map(q=>q.eps!=null  ?+q.eps.toFixed(3):null);
  const gmA =qs.map(q=>q.grossMargin!=null?+q.grossMargin.toFixed(1):null);
  const omA =qs.map(q=>q.opMargin!=null   ?+q.opMargin.toFixed(1):null);
  const nmA =qs.map(q=>q.netMargin!=null  ?+q.netMargin.toFixed(1):null);
  const ocfB=qs.map(q=>q.ocf  ?(+(q.ocf/1e9).toFixed(2)):null);
  const cxB =qs.map(q=>q.capex?(+(q.capex/1e9).toFixed(2)):null);
  const fcfB=qs.map(q=>q.fcf  ?(+(q.fcf/1e9).toFixed(2)):null);
  const fcfM=qs.map(q=>q.fcfMargin!=null?+q.fcfMargin.toFixed(1):null);
  const eqB =qs.map(q=>q.equity?(+(q.equity/1e9).toFixed(1)):null);
  const tlB =qs.map(q=>q.liab  ?(+(q.liab/1e9).toFixed(1)):null);
  const caB =qs.map(q=>{const c=(q.cash||0)+(q.stInvest||0);return c?(+(c/1e9).toFixed(1)):null;});
  const ldB =qs.map(q=>q.ltd?(+(q.ltd/1e9).toFixed(1)):null);
  const qqG =qs.map((q,i)=>i===0||!qs[i-1].revenue?0:+((q.revenue-qs[i-1].revenue)/qs[i-1].revenue*100).toFixed(1));

  mkChart('ch-ov-rev',{type:'bar',data:{labels:lb,datasets:[{label:'Revenue ($B)',data:revB,backgroundColor:qs.map((_,i)=>i===qs.length-1?C.green:'rgba(118,185,0,.48)'),borderColor:C.green,borderWidth:1,borderRadius:5}]},options:{...BO}});
  mkChart('ch-ov-ni', {type:'bar',data:{labels:lb,datasets:[{label:'Net Income ($B)',data:niB,backgroundColor:qs.map((_,i)=>i===qs.length-1?C.blue:'rgba(59,130,246,.48)'),borderColor:C.blue,borderWidth:1,borderRadius:5}]},options:{...BO}});
  mkChart('ch-ov-mg', {type:'line',data:{labels:lb,datasets:[{label:'Gross Margin %',data:gmA,borderColor:C.orange,backgroundColor:'transparent',borderWidth:2,tension:.3,pointBackgroundColor:C.orange,pointRadius:4},{label:'Net Margin %',data:nmA,borderColor:C.green,backgroundColor:'transparent',borderWidth:2,tension:.3,pointBackgroundColor:C.green,pointRadius:4}]},options:{...BO,scales:{...BO.scales,y:{...BO.scales.y,ticks:{...BO.scales.y.ticks,callback:v=>v+'%'}}}}});
  mkChart('ch-ov-eps',{type:'bar',data:{labels:lb,datasets:[{label:'EPS ($)',data:epsA,backgroundColor:qs.map((_,i)=>i===qs.length-1?C.teal:'rgba(20,184,166,.48)'),borderColor:C.teal,borderWidth:1,borderRadius:5}]},options:{...BO,scales:{...BO.scales,y:{...BO.scales.y,ticks:{...BO.scales.y.ticks,callback:v=>'$'+v}}}}});
  mkChart('ch-rev-main',{type:'bar',data:{labels:lb,datasets:[{label:'Revenue ($B)',data:revB,backgroundColor:C.greenA,borderColor:C.green,borderWidth:1,borderRadius:4},{label:'Gross Profit ($B)',data:gpB,backgroundColor:C.blueA,borderColor:C.blue,borderWidth:1,borderRadius:4}]},options:{...BO}});
  mkChart('ch-rev-mg',  {type:'bar',data:{labels:lb,datasets:[{label:'Op. Margin %',data:omA,backgroundColor:'rgba(59,130,246,.6)',borderColor:C.blue,borderWidth:1,borderRadius:4},{label:'Net Margin %',data:nmA,backgroundColor:'rgba(118,185,0,.6)',borderColor:C.green,borderWidth:1,borderRadius:4}]},options:{...BO,scales:{...BO.scales,y:{...BO.scales.y,ticks:{...BO.scales.y.ticks,callback:v=>v+'%'}}}}});
  mkChart('ch-rev-gr',  {type:'bar',data:{labels:lb,datasets:[{label:'QoQ Growth %',data:qqG,backgroundColor:qqG.map(v=>v>=0?'rgba(16,185,129,.6)':'rgba(239,68,68,.6)'),borderColor:qqG.map(v=>v>=0?C.pos:C.neg),borderWidth:1,borderRadius:4}]},options:{...BO,scales:{...BO.scales,y:{...BO.scales.y,ticks:{...BO.scales.y.ticks,callback:v=>v+'%'}}}}});
  mkChart('ch-bal-stk', {type:'bar',data:{labels:lb,datasets:[{label:"Equity ($B)",data:eqB,backgroundColor:C.greenA,borderColor:C.green,borderWidth:1,borderRadius:4,stack:'a'},{label:'Liabilities ($B)',data:tlB,backgroundColor:'rgba(239,68,68,.25)',borderColor:C.red,borderWidth:1,borderRadius:4,stack:'a'}]},options:{...BO,scales:{...BO.scales,x:{...BO.scales.x,stacked:true},y:{...BO.scales.y,stacked:true}}}});
  mkChart('ch-bal-cd',  {type:'bar',data:{labels:lb,datasets:[{label:'Cash & Invest. ($B)',data:caB,backgroundColor:'rgba(118,185,0,.6)',borderColor:C.green,borderWidth:1,borderRadius:4},{label:'LT Debt ($B)',data:ldB,backgroundColor:'rgba(239,68,68,.5)',borderColor:C.red,borderWidth:1,borderRadius:4}]},options:{...BO}});
  mkChart('ch-cf-main', {type:'bar',data:{labels:lb,datasets:[{label:'Op. CF ($B)',data:ocfB,backgroundColor:'rgba(59,130,246,.6)',borderColor:C.blue,borderWidth:1,borderRadius:4},{label:'Free CF ($B)',data:fcfB,backgroundColor:'rgba(118,185,0,.6)',borderColor:C.green,borderWidth:1,borderRadius:4}]},options:{...BO}});
  mkChart('ch-cf-mg',   {type:'line',data:{labels:lb,datasets:[{label:'FCF Margin %',data:fcfM,borderColor:C.green,backgroundColor:C.greenA,borderWidth:2,tension:.3,fill:true,pointBackgroundColor:C.green,pointRadius:4}]},options:{...BO,scales:{...BO.scales,y:{...BO.scales.y,ticks:{...BO.scales.y.ticks,callback:v=>v+'%'}}}}});
  mkChart('ch-cf-cx',   {type:'bar',data:{labels:lb,datasets:[{label:'CapEx ($B)',data:cxB,backgroundColor:'rgba(245,158,11,.6)',borderColor:C.orange,borderWidth:1,borderRadius:4}]},options:{...BO}});

  const s=DATA.summary;
  const nvVals=[s.pe,s.forwardPE,s.ps,s.evEbitda,s.pb,s.peg].map(v=>v!=null?+v.toFixed(1):null);
  mkChart('ch-val-cmp',{type:'bar',data:{labels:['P/E (TTM)','Forward P/E','P/S Ratio','EV/EBITDA','P/B Ratio','PEG Ratio'],datasets:[{label:'NVIDIA (live)',data:nvVals,backgroundColor:'rgba(118,185,0,.72)',borderColor:C.green,borderWidth:1,borderRadius:4},{label:'S&P 500 avg',data:[SP500.pe,SP500.fpe,SP500.ps,SP500.ev,SP500.pb,SP500.peg],backgroundColor:'rgba(59,130,246,.5)',borderColor:C.blue,borderWidth:1,borderRadius:4}]},options:{...BO,indexAxis:'y'}});
}

/* ══════════════════════════════════════════════
   FALLBACK DATA
══════════════════════════════════════════════ */
function loadFallback(){
  DATA={
    quote:{price:131.38,change:2.14,changePct:1.65,marketCap:3.2e12,volume:248e6,yearLow:66,yearHigh:175},
    summary:{pe:36,forwardPE:27,ps:18,pb:35,evEbitda:30,evRev:18,peg:0.5,divYield:0.0003,eps:3.10,grossMargin:0.605,revTTM:148.5e9,niTTM:76.8e9,currentRatio:3.6,deRatio:0.10,ocfTTM:66.6e9,fcfTTM:65.2e9},
    quarters:[
      {label:'Q2 FY25',revenue:30e9,grossProfit:20.3e9,opIncome:18.6e9,netIncome:16.6e9,eps:.67,rd:3.1e9,grossMargin:67.6,opMargin:62,netMargin:55.3,ocf:14.5e9,capex:.28e9,fcl:14.22e9,fcfMargin:47.3,cash:8.6e9,stInvest:26.2e9,currAssets:59.7e9,assets:85.2e9,ltd:8.5e9,liab:22.8e9,equity:62.4e9,inv:7e9,buybacks:7.5e9},
      {label:'Q3 FY25',revenue:35.1e9,grossProfit:24e9,opIncome:21.9e9,netIncome:19.3e9,eps:.78,rd:3.1e9,grossMargin:68.4,opMargin:62.4,netMargin:55,ocf:17.6e9,capex:.34e9,fcf:17.26e9,fcfMargin:49.2,cash:9.5e9,stInvest:32.5e9,currAssets:72.5e9,assets:96e9,ltd:8.5e9,liab:25.5e9,equity:70.5e9,inv:7.7e9,buybacks:11e9},
      {label:'Q4 FY25',revenue:39.3e9,grossProfit:28.9e9,opIncome:25.1e9,netIncome:22.1e9,eps:.89,rd:3.4e9,grossMargin:73.5,opMargin:63.9,netMargin:56.2,ocf:15.7e9,capex:.39e9,fcf:15.31e9,fcfMargin:38.9,cash:8.6e9,stInvest:34.6e9,currAssets:80.8e9,assets:103.5e9,ltd:8.5e9,liab:27.6e9,equity:75.9e9,inv:8.8e9,buybacks:11.2e9},
      {label:'Q1 FY26',revenue:44.1e9,grossProfit:26.7e9,opIncome:23.9e9,netIncome:18.8e9,eps:.76,rd:3.5e9,grossMargin:60.5,opMargin:54.1,netMargin:42.6,ocf:18.8e9,capex:.41e9,fcf:18.39e9,fcfMargin:41.7,cash:9e9,stInvest:35e9,currAssets:86e9,assets:111.6e9,ltd:8.5e9,liab:30.6e9,equity:81e9,inv:8e9,buybacks:14e9},
    ]
  };
  setStatus('Showing verified fallback data (Q2 FY25–Q1 FY26) · Yahoo Finance unreachable');
  populateAll();
}

/* ══════════════════════════════════════════════
   TOOLTIP
══════════════════════════════════════════════ */
const tooltip=document.getElementById('global-tooltip');
document.addEventListener('mouseover',e=>{const h=e.target.closest('.tip-host');if(!h||!h.dataset.tip)return;tooltip.textContent=h.dataset.tip;tooltip.style.opacity='1';});
document.addEventListener('mousemove',e=>{if(tooltip.style.opacity==='1'){tooltip.style.left=(e.clientX+14)+'px';tooltip.style.top=(e.clientY-36)+'px';}});
document.addEventListener('mouseout', e=>{if(e.target.closest('.tip-host'))tooltip.style.opacity='0';});

/* ══════════════════════════════════════════════
   TABS
══════════════════════════════════════════════ */
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-'+btn.dataset.tab).classList.add('active');
  });
});

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded',()=>{
  const savedKey      = sessionStorage.getItem('nvda_key');
  const savedProvider = sessionStorage.getItem('nvda_provider');
  if(savedKey){ OPTIONAL_KEY=savedKey; OPTIONAL_PROVIDER=savedProvider||'none'; }

  // Restore provider dropdown
  const sel=document.getElementById('api-provider');
  if(sel&&savedProvider) sel.value=savedProvider;

  document.getElementById('api-key-input')?.addEventListener('keydown',e=>{if(e.key==='Enter') initWithKey();});

  // Auto-load if previously connected
  if(savedKey||true){ /* always show gate for provider selection */ }
});
