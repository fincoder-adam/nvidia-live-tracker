// netlify/functions/fmp-proxy.js
// Multi-source financial data proxy.
// Runs on Netlify's AWS Lambda servers — full outbound HTTP, no CORS restrictions.
// Routes:
//   /api/fmp/yahoo/quote        → Yahoo Finance real-time quote (no key needed)
//   /api/fmp/yahoo/summary      → Yahoo Finance quoteSummary (fundamentals, no key needed)
//   /api/fmp/yahoo/financials   → Yahoo Finance quarterly financials (no key needed)
//   /api/fmp/alphavantage/*     → Alpha Vantage (free key: 25 req/day)
//   /api/fmp/finnhub/*          → Finnhub (free key: 60 req/min)
//   /api/fmp/polygon/*          → Polygon.io (free key: 5 req/min)

const https = require('https');

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        ...headers
      }
    };
    const req = https.get(url, options, (res) => {
      const chunks = [];
      // Handle gzip
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createGunzip());
      }
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

exports.handler = async function (event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  const path = event.path;
  const qs   = event.queryStringParameters || {};

  try {
    let url, result;

    // ── YAHOO FINANCE (no key needed) ──────────────────────────────
    if (path.includes('/yahoo/quote')) {
      const symbol = qs.symbol || 'NVDA';
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d&includePrePost=false`;
      result = await httpsGet(url, { 'Referer': 'https://finance.yahoo.com' });
    }

    else if (path.includes('/yahoo/summary')) {
      const symbol = qs.symbol || 'NVDA';
      const modules = 'price,defaultKeyStatistics,financialData,summaryDetail';
      url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}`;
      result = await httpsGet(url, { 'Referer': 'https://finance.yahoo.com' });
    }

    else if (path.includes('/yahoo/financials')) {
      const symbol = qs.symbol || 'NVDA';
      const modules = 'incomeStatementHistoryQuarterly,balanceSheetHistoryQuarterly,cashflowStatementHistoryQuarterly,earningsTrend';
      url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}`;
      result = await httpsGet(url, { 'Referer': 'https://finance.yahoo.com' });
    }

    // ── ALPHA VANTAGE ──────────────────────────────────────────────
    else if (path.includes('/alphavantage/')) {
      const avPath = path.split('/alphavantage/')[1];
      const params = new URLSearchParams(qs).toString();
      url = `https://www.alphavantage.co/query?${params}`;
      result = await httpsGet(url);
    }

    // ── FINNHUB ───────────────────────────────────────────────────
    else if (path.includes('/finnhub/')) {
      const params = new URLSearchParams(qs).toString();
      url = `https://finnhub.io/api/v1/${path.split('/finnhub/')[1]}?${params}`;
      result = await httpsGet(url);
    }

    // ── POLYGON ───────────────────────────────────────────────────
    else if (path.includes('/polygon/')) {
      const polyPath = path.split('/polygon/')[1];
      const params = new URLSearchParams(qs).toString();
      url = `https://api.polygon.io/${polyPath}?${params}`;
      result = await httpsGet(url);
    }

    else {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Unknown route: ' + path }) };
    }

    return {
      statusCode: result.status,
      headers: corsHeaders,
      body: result.body,
    };

  } catch (err) {
    console.error('Proxy error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message, path }),
    };
  }
};
