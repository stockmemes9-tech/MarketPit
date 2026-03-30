// /api/prices.js — Vercel Serverless Function
// Fetches live prices: NSE stocks (Yahoo Finance), Crypto (CoinGecko), Commodities (Yahoo Finance)
// No API key needed. Drop this file into your /api/ folder.

const https = require('https');

// NSE Stock → Yahoo Finance symbol map
const YF_STOCK_MAP = {
  HDFCBANK:'HDFCBANK.NS', ICICIBANK:'ICICIBANK.NS', SBIN:'SBIN.NS',
  AXISBANK:'AXISBANK.NS', KOTAKBANK:'KOTAKBANK.NS', INDUSINDBK:'INDUSINDBK.NS',
  TCS:'TCS.NS', INFY:'INFY.NS', WIPRO:'WIPRO.NS', HCLTECH:'HCLTECH.NS',
  TECHM:'TECHM.NS', LTIM:'LTIM.NS', TATAMOTORS:'TATAMOTORS.NS',
  MARUTI:'MARUTI.NS', 'M&M':'M%26M.NS', HEROMOTOCO:'HEROMOTOCO.NS',
  EICHERMOT:'EICHERMOT.NS', 'BAJAJ-AUTO':'BAJAJ-AUTO.NS',
  SUNPHARMA:'SUNPHARMA.NS', DRREDDY:'DRREDDY.NS', CIPLA:'CIPLA.NS',
  DIVISLAB:'DIVISLAB.NS', APOLLOHOSP:'APOLLOHOSP.NS', RELIANCE:'RELIANCE.NS',
  ONGC:'ONGC.NS', BPCL:'BPCL.NS', IOC:'IOC.NS', NTPC:'NTPC.NS',
  POWERGRID:'POWERGRID.NS', TATASTEEL:'TATASTEEL.NS', JSWSTEEL:'JSWSTEEL.NS',
  HINDALCO:'HINDALCO.NS', COALINDIA:'COALINDIA.NS', NESTLEIND:'NESTLEIND.NS',
  BRITANNIA:'BRITANNIA.NS', ITC:'ITC.NS', HINDUNILVR:'HINDUNILVR.NS',
  TATACONSUM:'TATACONSUM.NS', BAJFINANCE:'BAJFINANCE.NS', BAJAJFINSV:'BAJAJFINSV.NS',
  TITAN:'TITAN.NS', ASIANPAINT:'ASIANPAINT.NS', DMART:'DMART.NS',
  LT:'LT.NS', ADANIENT:'ADANIENT.NS', ULTRACEMCO:'ULTRACEMCO.NS',
  GRASIM:'GRASIM.NS', BHARTIARTL:'BHARTIARTL.NS', JUBLFOOD:'JUBLFOOD.NS',
  SHRIRAMFIN:'SHRIRAMFIN.NS', ADANIPORTS:'ADANIPORTS.NS', ZOMATO:'ZOMATO.NS',
  HAL:'HAL.NS', BEL:'BEL.NS', DLF:'DLF.NS', IRCTC:'IRCTC.NS',
  TRENT:'TRENT.NS', DIXON:'DIXON.NS',
  NAUKRI:'NAUKRI.NS', PERSISTENT:'PERSISTENT.NS',
  COFORGE:'COFORGE.NS', MUTHOOTFIN:'MUTHOOTFIN.NS', CHOLAFIN:'CHOLAFIN.NS',
  TVSMOTOR:'TVSMOTOR.NS', GODREJPROP:'GODREJPROP.NS', INDHOTEL:'INDHOTEL.NS',
};

// Commodity Yahoo Finance futures symbols
const COMMODITY_MAP = {
  GOLD:'GC=F', SILVER:'SI=F', CRUDE:'CL=F', NATGAS:'NG=F', COPPER:'HG=F',
};

// Crypto → CoinGecko IDs
const CRYPTO_MAP = {
  BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin',
  XRP:'ripple', ADA:'cardano', DOGE:'dogecoin', DOT:'polkadot',
  MATIC:'matic-network', AVAX:'avalanche-2',
};

function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: 443,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Origin': 'https://finance.yahoo.com',
        'Referer': 'https://finance.yahoo.com/',
      },
      timeout: timeoutMs || 12000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchYahooQuotes(yfSymbols) {
  const result = new Map();
  if (!yfSymbols.length) return result;

  const CHUNK = 30;
  for (let i = 0; i < yfSymbols.length; i += CHUNK) {
    const chunk = yfSymbols.slice(i, i + CHUNK);
    const symsQ = encodeURIComponent(chunk.join(','));
    const fields = 'regularMarketPrice,regularMarketPreviousClose,regularMarketChangePercent';

    for (const host of ['query1', 'query2']) {
      try {
        const url = `https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${symsQ}&fields=${fields}&formatted=false&lang=en-US&region=US`;
        const { status, body } = await httpsGet(url);
        if (status === 200) {
          const parsed = JSON.parse(body);
          const quotes = parsed?.quoteResponse?.result || [];
          if (quotes.length > 0) {
            for (const q of quotes) {
              if (q.regularMarketPrice != null) {
                result.set(q.symbol, { price: q.regularMarketPrice, chg: q.regularMarketChangePercent || 0 });
              }
            }
            break;
          }
        }
      } catch (_e) {}
    }

    const missing = chunk.filter(s => !result.has(s));
    await Promise.allSettled(missing.map(async sym => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
        const { status, body } = await httpsGet(url);
        if (status === 200) {
          const meta = JSON.parse(body)?.chart?.result?.[0]?.meta;
          if (meta?.regularMarketPrice) {
            const price = meta.regularMarketPrice;
            const prev = meta.previousClose || meta.chartPreviousClose || price;
            result.set(sym, { price, chg: prev ? ((price - prev) / prev * 100) : 0 });
          }
        }
      } catch (_e) {}
    }));
  }
  return result;
}

async function fetchCryptoPrices(ids) {
  const result = new Map();
  if (!ids.length) return result;
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`;
    const { status, body } = await httpsGet(url);
    if (status === 200) {
      const data = JSON.parse(body);
      for (const [id, v] of Object.entries(data)) {
        if (v.usd) result.set(id, { price: v.usd, chg: v.usd_24h_change || 0 });
      }
    }
  } catch (_e) {}
  return result;
}

function fmtChg(chg) {
  return (chg >= 0 ? '+' : '') + Number(chg).toFixed(2) + '%';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store');

  const type = (req.query.type || 'all').replace(/[^a-z]/g, '');
  const symbolsParam = req.query.symbols;
  const requestedSyms = symbolsParam ? symbolsParam.split(',').map(s => s.trim().toUpperCase()) : null;

  const prices = [];

  try {
    if (type === 'stocks' || type === 'all') {
      const symsToFetch = requestedSyms ? requestedSyms.filter(s => s in YF_STOCK_MAP) : Object.keys(YF_STOCK_MAP);
      const yfSyms = symsToFetch.map(s => YF_STOCK_MAP[s]).filter(Boolean);
      const map = await fetchYahooQuotes(yfSyms);
      for (const sym of symsToFetch) {
        const yfSym = YF_STOCK_MAP[sym];
        const data = yfSym && map.get(yfSym);
        if (data) prices.push({ sym, price: data.price, chg: fmtChg(data.chg), up: data.chg >= 0, type: 'stock' });
      }
    }

    if (type === 'commodities' || type === 'all') {
      const symsToFetch = requestedSyms ? requestedSyms.filter(s => s in COMMODITY_MAP) : Object.keys(COMMODITY_MAP);
      const yfSyms = symsToFetch.map(s => COMMODITY_MAP[s]).filter(Boolean);
      const map = await fetchYahooQuotes(yfSyms);
      for (const sym of symsToFetch) {
        const yfSym = COMMODITY_MAP[sym];
        const data = yfSym && map.get(yfSym);
        if (data) prices.push({ sym, price: data.price, chg: fmtChg(data.chg), up: data.chg >= 0, type: 'commodity' });
      }
    }

    if (type === 'crypto' || type === 'all') {
      const symsToFetch = requestedSyms ? requestedSyms.filter(s => s in CRYPTO_MAP) : Object.keys(CRYPTO_MAP);
      const cgIds = symsToFetch.map(s => CRYPTO_MAP[s]).filter(Boolean);
      const map = await fetchCryptoPrices(cgIds);
      for (const sym of symsToFetch) {
        const cgId = CRYPTO_MAP[sym];
        const data = cgId && map.get(cgId);
        if (data) prices.push({ sym, price: data.price, chg: fmtChg(data.chg), up: data.chg >= 0, type: 'crypto' });
      }
    }

    return res.status(200).json({ prices, ts: new Date().toISOString(), count: prices.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
