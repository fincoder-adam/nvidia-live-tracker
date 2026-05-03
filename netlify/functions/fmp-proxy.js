// netlify/functions/fmp-proxy.js
// Multi-source financial proxy with Yahoo Finance crumb handling.
// Yahoo Finance v10 requires: (1) fetch crumb cookie, (2) use crumb in requests.

const https = require('https');
const zlib  = require('zlib');

// In-memory crumb cache (lives for the duration of the Lambda warm instance)
let crumbCache = { crumb: null, cookie: null, fetchedAt: 0 };
const CRUMB_TTL = 55 * 60 * 1000; // 55 minutes

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        ...headers
      }
    };
    const req = https.get(url, opts, (res) => {
      const chunks = [];
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      }
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString('utf8')
      }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function getYahooCrumb() {
  const now = Date.now();
  if (crumbCache.crumb && (now - crumbCache.fetchedAt) < CRUMB_TTL) {
    return crumbCache;
  }

  // Step 1: hit Yahoo Finance to get session cookies
  const cookieRes = await httpsGet('https://finance.yahoo.com/', {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });
  
  // Extract Set-Cookie headers
  const setCookie = cookieRes.headers['set-cookie'] || [];
  const cookieStr = setCookie.map(c => c.split(';')[0]).join('; ');

  // Step 2: fetch the crumb using the cookie
  const crumbRes = await httpsGet('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    'Cookie': cookieStr,
    'Referer': 'https://finance.yahoo.com/',
  });

  const crumb = crumbRes.body.trim();
  if (!crumb || crumb.includes('{') || crumb.length < 3) {
    throw new Error('Failed to get Yahoo crumb: ' + crumb.slice(0, 80));
  }

  crumbCache = { crumb, cookie: cookieStr, fetchedAt: now };
  console.log('Got fresh Yahoo crumb:', crumb.slice(0, 8) + '...');
  return crumbCache;
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
    let result;

    // ── YAHOO: real-time quote (v8 chart — no crumb needed) ──
    if (path.includes('/yahoo/quote')) {
      const symbol = qs.symbol || 'NVDA';
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d&includePrePost=false`;
      result = await httpsGet(url, { 'Referer': 'https://finance.yahoo.com/' });
    }

    // ── YAHOO: summary & financials (v10 — crumb required) ──
    else if (path.includes('/yahoo/summary') || path.includes('/yahoo/financials')) {
      const { crumb, cookie } = await getYahooCrumb();
      const symbol  = qs.symbol || 'NVDA';
      const modules = path.includes('/yahoo/summary')
        ? 'price,defaultKeyStatistics,financialData,summaryDetail'
        : 'incomeStatementHistoryQuarterly,balanceSheetHistoryQuarterly,cashflowStatementHistoryQuarterly';
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
      result = await httpsGet(url, {
        'Cookie':  cookie,
        'Referer': 'https://finance.yahoo.com/',
      });

      // If crumb expired mid-session, bust cache and retry once
      if (result.status === 401 || result.body.includes('Invalid Crumb')) {
        console.log('Crumb expired, refreshing…');
        crumbCache = { crumb: null, cookie: null, fetchedAt: 0 };
        const fresh = await getYahooCrumb();
        const url2  = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}&crumb=${encodeURIComponent(fresh.crumb)}`;
        result = await httpsGet(url2, {
          'Cookie':  fresh.cookie,
          'Referer': 'https://finance.yahoo.com/',
        });
      }
    }

    // ── ALPHA VANTAGE ──
    else if (path.includes('/alphavantage/')) {
      const params = new URLSearchParams(qs).toString();
      const url = `https://www.alphavantage.co/query?${params}`;
      result = await httpsGet(url);
    }

    // ── FINNHUB ──
    else if (path.includes('/finnhub/')) {
      const endpoint = path.split('/finnhub/')[1];
      const params   = new URLSearchParams(qs).toString();
      const url = `https://finnhub.io/api/v1/${endpoint}?${params}`;
      result = await httpsGet(url);
    }

    // ── POLYGON ──
    else if (path.includes('/polygon/')) {
      const polyPath = path.split('/polygon/')[1];
      const params   = new URLSearchParams(qs).toString();
      const url = `https://api.polygon.io/${polyPath}?${params}`;
      result = await httpsGet(url);
    }

    else {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Unknown route: ' + path }) };
    }

    return { statusCode: result.status, headers: corsHeaders, body: result.body };

  } catch (err) {
    console.error('Proxy error:', err.message, err.stack);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
