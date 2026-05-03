// Temporary debug function to inspect Yahoo Finance field names
const https = require('https');
const zlib  = require('zlib');

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
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
      stream.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

exports.handler = async function (event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    // Get crumb
    const cookieRes = await httpsGet('https://finance.yahoo.com/', { 'Accept': 'text/html,*/*' });
    const setCookie = cookieRes.headers['set-cookie'] || [];
    const cookieStr = setCookie.map(c => c.split(';')[0]).join('; ');
    const crumbRes  = await httpsGet('https://query1.finance.yahoo.com/v1/test/getcrumb', { 'Cookie': cookieStr, 'Referer': 'https://finance.yahoo.com/' });
    const crumb = crumbRes.body.trim();

    // Fetch financials
    const modules = 'incomeStatementHistoryQuarterly,balanceSheetHistoryQuarterly,cashflowStatementHistoryQuarterly';
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/NVDA?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
    const res = await httpsGet(url, { 'Cookie': cookieStr, 'Referer': 'https://finance.yahoo.com/' });
    const data = JSON.parse(res.body);
    const result = data?.quoteSummary?.result?.[0];

    // Extract field keys from first income statement entry
    const incFields  = Object.keys(result?.incomeStatementHistoryQuarterly?.incomeStatementHistory?.[0] || {});
    const bsFields   = Object.keys(result?.balanceSheetHistoryQuarterly?.balanceSheetStatements?.[0] || {});
    const cfFields   = Object.keys(result?.cashflowStatementHistoryQuarterly?.cashflowStatements?.[0] || {});
    const firstInc   = result?.incomeStatementHistoryQuarterly?.incomeStatementHistory?.[0] || {};
    const firstBS    = result?.balanceSheetHistoryQuarterly?.balanceSheetStatements?.[0] || {};

    return { statusCode: 200, headers: cors, body: JSON.stringify({ crumb: crumb.slice(0,8), incFields, bsFields, cfFields, firstInc, firstBS }, null, 2) };
  } catch(e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
