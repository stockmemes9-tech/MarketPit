// /api/news.js — Vercel Serverless Function
// Fetches Google News RSS server-side → no CORS, no proxies needed

const https = require('https');
const zlib  = require('zlib');

const RSS_URLS = {
  markets:     'https://news.google.com/rss/search?q=indian+stock+market+nifty+sensex&hl=en-IN&gl=IN&ceid=IN:en',
  stocks:      'https://news.google.com/rss/search?q=NSE+BSE+india+stocks+today&hl=en-IN&gl=IN&ceid=IN:en',
  economy:     'https://news.google.com/rss/search?q=india+economy+RBI+inflation+2026&hl=en-IN&gl=IN&ceid=IN:en',
  crypto:      'https://news.google.com/rss/search?q=bitcoin+crypto+cryptocurrency+today&hl=en-IN&gl=IN&ceid=IN:en',
  commodities: 'https://news.google.com/rss/search?q=gold+price+crude+oil+india+today&hl=en-IN&gl=IN&ceid=IN:en',
  RELIANCE: 'https://news.google.com/rss/search?q=Reliance+Industries+RIL+NSE+stock+today&hl=en-IN&gl=IN&ceid=IN:en',
  TCS:      'https://news.google.com/rss/search?q=TCS+Tata+Consultancy+Services+stock+NSE+today&hl=en-IN&gl=IN&ceid=IN:en',
  HDFCBANK: 'https://news.google.com/rss/search?q=HDFC+Bank+stock+NSE+India+today&hl=en-IN&gl=IN&ceid=IN:en',
  INFY:     'https://news.google.com/rss/search?q=Infosys+INFY+stock+NSE+today&hl=en-IN&gl=IN&ceid=IN:en',
  SBIN:     'https://news.google.com/rss/search?q=SBI+State+Bank+India+stock+NSE+today&hl=en-IN&gl=IN&ceid=IN:en',
  TATAMOTORS: 'https://news.google.com/rss/search?q=Tata+Motors+stock+EV+NSE+India+today&hl=en-IN&gl=IN&ceid=IN:en',
  ADANIENT:   'https://news.google.com/rss/search?q=Adani+Enterprises+stock+NSE+India+today&hl=en-IN&gl=IN&ceid=IN:en',
  ZOMATO:     'https://news.google.com/rss/search?q=Zomato+stock+NSE+India+today&hl=en-IN&gl=IN&ceid=IN:en',
  BTC:  'https://news.google.com/rss/search?q=Bitcoin+BTC+price+news+today&hl=en-IN&gl=IN&ceid=IN:en',
  ETH:  'https://news.google.com/rss/search?q=Ethereum+ETH+price+news+today&hl=en-IN&gl=IN&ceid=IN:en',
  SOL:  'https://news.google.com/rss/search?q=Solana+SOL+crypto+price+today&hl=en-IN&gl=IN&ceid=IN:en',
  GOLD:  'https://news.google.com/rss/search?q=gold+price+MCX+India+today&hl=en-IN&gl=IN&ceid=IN:en',
  CRUDE: 'https://news.google.com/rss/search?q=crude+oil+WTI+price+today&hl=en-IN&gl=IN&ceid=IN:en',
  SILVER:'https://news.google.com/rss/search?q=silver+price+MCX+India+today&hl=en-IN&gl=IN&ceid=IN:en',
};

function fetchUrl(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: 443,
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept':          'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control':   'no-cache',
      },
      timeout: timeoutMs || 8000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        if (enc === 'gzip') {
          zlib.gunzip(buf, (err, dec) => {
            if (err) reject(err);
            else resolve({ status: res.statusCode, body: dec.toString('utf8') });
          });
        } else if (enc === 'deflate') {
          zlib.inflate(buf, (err, dec) => {
            if (err) reject(err);
            else resolve({ status: res.statusCode, body: dec.toString('utf8') });
          });
        } else {
          resolve({ status: res.statusCode, body: buf.toString('utf8') });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseRSS(xml, count) {
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null && items.length < (count || 16)) {
    const block = m[1];
    const get = tag => {
      const r = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return r ? r[1].trim().replace(/<[^>]+>/g, '').trim() : '';
    };
    const title   = get('title');
    const pubDate = get('pubDate');
    const source  = get('source');
    let link = get('link');
    if (!link) {
      const gl = block.match(/<link\s*\/>\s*(https?:[^\s<]+)/i);
      if (gl) link = gl[1];
    }
    if (!link) link = get('guid');
    if (title && title.length > 8) {
      items.push({ title, link: (link || '').trim(), date: pubDate, source: source || 'Google News' });
    }
  }
  return items;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch(e) { return ''; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');

  const cat   = (req.query.cat || 'markets').replace(/[^a-zA-Z0-9_]/g, '');
  const count = Math.min(parseInt(req.query.count) || 16, 16);
  const rssUrl = RSS_URLS[cat] || RSS_URLS.markets;

  try {
    const { status, body } = await fetchUrl(rssUrl, 8000);
    if (status === 200 && body.includes('<item>')) {
      const items = parseRSS(body, count).map(item => ({ ...item, ago: timeAgo(item.date) }));
      if (items.length) {
        return res.status(200).json({ items, cat, source: 'rss', ts: new Date().toISOString() });
      }
    }

    const etUrls = {
      markets:     'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
      stocks:      'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms',
      economy:     'https://economictimes.indiatimes.com/economy/rssfeeds/1373380680.cms',
      crypto:      'https://economictimes.indiatimes.com/tech/technology/rssfeeds/13357270.cms',
      commodities: 'https://economictimes.indiatimes.com/markets/commodities/rssfeeds/1368154900.cms',
    };
    const etUrl = etUrls[cat] || etUrls.markets;
    const { status: s2, body: b2 } = await fetchUrl(etUrl, 6000);
    if (s2 === 200 && b2.includes('<item>')) {
      const items = parseRSS(b2, count).map(item => ({ ...item, source: item.source || 'Economic Times', ago: timeAgo(item.date) }));
      if (items.length) {
        return res.status(200).json({ items, cat, source: 'et', ts: new Date().toISOString() });
      }
    }

    return res.status(502).json({ error: 'No news items found', cat });
  } catch(e) {
    return res.status(500).json({ error: e.message, cat });
  }
};
