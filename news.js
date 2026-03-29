// /api/news.js — Vercel Serverless Function
// Primary: GNews API (free, fast, structured JSON — https://gnews.io)
// Fallback: Google News RSS server-side fetch (no CORS, no proxy needed)
// Auto-updates on every call

const https = require('https');
const zlib  = require('zlib');

// ── GNews API config ──
// Free tier: 100 req/day. Get your key at https://gnews.io
// Set GNEWS_API_KEY in Vercel environment variables for best results.
const GNEWS_API_KEY = process.env.GNEWS_API_KEY || 'pub_66e7e0e0c7094f5293f9b90df4c5b2c3';

const GNEWS_QUERIES = {
  markets:     'nifty OR sensex OR "stock market" india',
  stocks:      'NSE OR BSE OR "india stocks"',
  economy:     'india economy OR RBI OR inflation',
  crypto:      'bitcoin OR ethereum OR cryptocurrency',
  commodities: 'gold price india OR crude oil',
  // ── Story subjects ──
  RELIANCE:    'Reliance Industries RIL stock',
  TCS:         'TCS Tata Consultancy Services stock',
  HDFCBANK:    'HDFC Bank stock NSE',
  INFY:        'Infosys INFY stock',
  SBIN:        'SBI State Bank India stock',
  TATAMOTORS:  'Tata Motors stock EV',
  ADANIENT:    'Adani Enterprises stock',
  ZOMATO:      'Zomato stock NSE',
  BTC:         'Bitcoin BTC price',
  ETH:         'Ethereum ETH price',
  SOL:         'Solana SOL crypto',
  GOLD:        'gold price MCX India',
  CRUDE:       'crude oil WTI price',
  SILVER:      'silver price MCX India',
};

const RSS_URLS = {
  // ── News tab categories ──
  markets:     'https://news.google.com/rss/search?q=indian+stock+market+nifty+sensex&hl=en-IN&gl=IN&ceid=IN:en',
  stocks:      'https://news.google.com/rss/search?q=NSE+BSE+india+stocks+today&hl=en-IN&gl=IN&ceid=IN:en',
  economy:     'https://news.google.com/rss/search?q=india+economy+RBI+inflation+2026&hl=en-IN&gl=IN&ceid=IN:en',
  crypto:      'https://news.google.com/rss/search?q=bitcoin+crypto+cryptocurrency+today&hl=en-IN&gl=IN&ceid=IN:en',
  commodities: 'https://news.google.com/rss/search?q=gold+price+crude+oil+india+today&hl=en-IN&gl=IN&ceid=IN:en',
  // ── Story subjects ──
  RELIANCE:    'https://news.google.com/rss/search?q=Reliance+Industries+RIL+NSE+stock+today&hl=en-IN&gl=IN&ceid=IN:en',
  TCS:         'https://news.google.com/rss/search?q=TCS+Tata+Consultancy+Services+stock+NSE+today&hl=en-IN&gl=IN&ceid=IN:en',
  HDFCBANK:    'https://news.google.com/rss/search?q=HDFC+Bank+stock+NSE+India+today&hl=en-IN&gl=IN&ceid=IN:en',
  INFY:        'https://news.google.com/rss/search?q=Infosys+INFY+stock+NSE+today&hl=en-IN&gl=IN&ceid=IN:en',
  SBIN:        'https://news.google.com/rss/search?q=SBI+State+Bank+India+stock+NSE+today&hl=en-IN&gl=IN&ceid=IN:en',
  TATAMOTORS:  'https://news.google.com/rss/search?q=Tata+Motors+stock+EV+NSE+India+today&hl=en-IN&gl=IN&ceid=IN:en',
  ADANIENT:    'https://news.google.com/rss/search?q=Adani+Enterprises+stock+NSE+India+today&hl=en-IN&gl=IN&ceid=IN:en',
  ZOMATO:      'https://news.google.com/rss/search?q=Zomato+stock+NSE+India+today&hl=en-IN&gl=IN&ceid=IN:en',
  BTC:         'https://news.google.com/rss/search?q=Bitcoin+BTC+price+news+today&hl=en-IN&gl=IN&ceid=IN:en',
  ETH:         'https://news.google.com/rss/search?q=Ethereum+ETH+price+news+today&hl=en-IN&gl=IN&ceid=IN:en',
  SOL:         'https://news.google.com/rss/search?q=Solana+SOL+crypto+price+today&hl=en-IN&gl=IN&ceid=IN:en',
  GOLD:        'https://news.google.com/rss/search?q=gold+price+MCX+India+today&hl=en-IN&gl=IN&ceid=IN:en',
  CRUDE:       'https://news.google.com/rss/search?q=crude+oil+WTI+price+today&hl=en-IN&gl=IN&ceid=IN:en',
  SILVER:      'https://news.google.com/rss/search?q=silver+price+MCX+India+today&hl=en-IN&gl=IN&ceid=IN:en',
};

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: 443,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000,
    };
    const req = https.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') {
          zlib.gunzip(buf, (err, dec) => {
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

// Simple XML parser — extracts <item> blocks without a library
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return m ? m[1].trim().replace(/<[^>]+>/g, '') : '';
    };
    const title   = get('title');
    const link    = get('link') || block.match(/<link\/>(.*?)<\//)?.[1] || '';
    const pubDate = get('pubDate');
    const source  = get('source');
    if (title && title.length > 8) {
      items.push({ title, link: link.trim(), date: pubDate, source: source || 'Google News' });
    }
  }
  return items;
}

// Format time ago
function timeAgo(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch(e) { return ''; }
}

// Fetch from GNews API (server-side, no CORS issues)
async function fetchGNews(cat, count) {
  const q = GNEWS_QUERIES[cat] || GNEWS_QUERIES.markets;
  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&country=in&max=${count}&token=${GNEWS_API_KEY}`;
  const { status, body } = await fetchUrl(url);
  if (status !== 200) throw new Error('GNews status ' + status);
  const j = JSON.parse(body);
  if (!j.articles || !j.articles.length) throw new Error('GNews: no articles');
  return j.articles.map(a => ({
    title:  (a.title || '').replace(/ - .*$/, '').trim(),
    link:   a.url || '#',
    date:   a.publishedAt || '',
    source: a.source?.name || 'GNews',
    ago:    timeAgo(a.publishedAt || ''),
  })).filter(i => i.title.length > 8);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300'); // 30min cache

  const cat   = (req.query.cat || 'markets').replace(/[^a-zA-Z0-9_]/g, '');
  const count = Math.min(parseInt(req.query.count) || 16, 16);

  // ── Strategy 1: GNews API — fastest, structured JSON, no parsing ──
  try {
    const items = await fetchGNews(cat, count);
    return res.status(200).json({ items, cat, source: 'gnews', ts: new Date().toISOString() });
  } catch(e) {
    // fall through to RSS
  }

  // ── Strategy 2: Google News RSS (server-side — no CORS) ──
  const rssUrl = RSS_URLS[cat] || RSS_URLS.markets;
  try {
    const { status, body } = await fetchUrl(rssUrl);
    if (status !== 200 || !body.includes('<item>')) {
      return res.status(502).json({ error: 'RSS fetch failed', status });
    }
    const items = parseRSS(body).slice(0, count).map(item => ({
      ...item,
      ago: timeAgo(item.date),
    }));
    return res.status(200).json({ items, cat, source: 'rss', ts: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
