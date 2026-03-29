/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  MarketPit — Live Price Engine  (drop-in replacement)           ║
 * ║  Works from ANY static host: GitHub Pages, Netlify, etc.        ║
 * ║  No backend / Vercel / Railway needed.                          ║
 * ║                                                                  ║
 * ║  HOW TO USE:                                                     ║
 * ║  Paste this entire block just before </body> in dashboard.html   ║
 * ║  It overrides all the broken /api/quote and /api/indices calls.  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Sources used (all free, no API key needed):
 *   • Yahoo Finance v7  — batch NSE stocks + commodities + indices
 *   • Yahoo Finance v8  — single-symbol chart (fallback)
 *   • CoinGecko          — crypto prices (already works, untouched)
 *   • CORS proxies       — allorigins → corsproxy.io → codetabs → thingproxy
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────
  // 1.  PROXY CHAIN  (tried in order until one works)
  // ─────────────────────────────────────────────────────────────────
  const _PROXIES = [
    url => 'https://api.allorigins.win/get?url=' + encodeURIComponent(url),
    url => 'https://corsproxy.io/?' + encodeURIComponent(url),
    url => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url),
    url => 'https://thingproxy.freeboard.io/fetch/' + url,
  ];

  /** Unwrap allorigins/codetabs envelope → raw text */
  function _unwrap(raw) {
    try { const j = JSON.parse(raw); return j.contents || raw; }
    catch (e) { return raw; }
  }

  /** Fetch a URL through the proxy chain, return response text */
  async function _proxyFetch(url, timeoutMs = 10000) {
    // Try direct first (works on some browsers / desktop apps)
    for (const base of ['query1', 'query2']) {
      if (url.includes('finance.yahoo.com')) {
        try {
          const r = await fetch(url.replace('query1', base), { signal: AbortSignal.timeout(6000) });
          if (r.ok) return await r.text();
        } catch (e) { /* next */ }
      }
    }
    // Proxy fallback chain
    for (const proxyFn of _PROXIES) {
      try {
        const r = await fetch(proxyFn(url), { signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) return _unwrap(await r.text());
      } catch (e) { /* next */ }
    }
    throw new Error('All proxies failed for: ' + url);
  }

  // ─────────────────────────────────────────────────────────────────
  // 2.  PARSE HELPERS
  // ─────────────────────────────────────────────────────────────────

  /** Parse Yahoo Finance v7 /quote response → Map<yfSymbol, {price,chg,up}> */
  function _parseV7(text) {
    const result = new Map();
    try {
      const parsed = JSON.parse(text);
      const quotes = parsed?.quoteResponse?.result || [];
      quotes.forEach(q => {
        if (!q?.regularMarketPrice) return;
        const price  = q.regularMarketPrice;
        const prev   = q.regularMarketPreviousClose || price;
        const chg    = q.regularMarketChangePercent != null
          ? q.regularMarketChangePercent
          : ((price - prev) / (prev || 1) * 100);
        result.set(q.symbol, { price, chg, up: chg >= 0 });
      });
    } catch (e) { /* bad JSON — return empty */ }
    return result;
  }

  /** Parse Yahoo Finance v8 /chart response → {price,chg,up} or null */
  function _parseV8(text) {
    try {
      const parsed = JSON.parse(text);
      const meta = parsed?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) return null;
      const price = meta.regularMarketPrice;
      const prev  = meta.previousClose || meta.chartPreviousClose
                  || meta.regularMarketPreviousClose || meta.regularMarketOpen || price;
      const chg   = prev ? ((price - prev) / prev * 100) : 0;
      return { price, chg, up: chg >= 0 };
    } catch (e) { return null; }
  }

  // ─────────────────────────────────────────────────────────────────
  // 3.  CORE FETCH FUNCTIONS
  // ─────────────────────────────────────────────────────────────────

  /**
   * Batch-fetch an array of Yahoo Finance symbols (e.g. ['RELIANCE.NS','GC=F'])
   * Returns Map<yfSymbol, {price, chg, up}>
   * Splits into chunks of 50 automatically.
   */
  async function yfBatchFetch(yfSyms) {
    if (!yfSyms || !yfSyms.length) return new Map();
    const CHUNK = 50;
    const combined = new Map();

    for (let i = 0; i < yfSyms.length; i += CHUNK) {
      const chunk  = yfSyms.slice(i, i + CHUNK);
      const symsQ  = encodeURIComponent(chunk.join(','));
      const v7url  = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symsQ}&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketChangePercent`;
      try {
        const text = await _proxyFetch(v7url, 12000);
        const map  = _parseV7(text);
        map.forEach((v, k) => combined.set(k, v));
        if (map.size > 0) continue; // chunk succeeded
      } catch (e) { /* fall through to one-by-one */ }

      // Per-symbol fallback for this chunk
      await Promise.allSettled(chunk.map(async sym => {
        try {
          const v8url  = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d`;
          const text   = await _proxyFetch(v8url, 9000);
          const parsed = _parseV8(text);
          if (parsed) combined.set(sym, parsed);
        } catch (e) { /* skip this symbol */ }
      }));
    }
    return combined;
  }

  /**
   * Fetch a single symbol (used by chart/TA code).
   * Returns {price, chg, up} or throws.
   */
  async function yfFetch(yfSym) {
    const v8url = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSym}?interval=1m&range=1d`;
    const text  = await _proxyFetch(v8url, 9000);
    const res   = _parseV8(text);
    if (res) return res;
    throw new Error('Could not parse YF response for ' + yfSym);
  }

  // ─────────────────────────────────────────────────────────────────
  // 4.  HELPER — write result into liveStocks + trigger UI updates
  // ─────────────────────────────────────────────────────────────────
  function _applyBatchToLiveStocks(map, yfToSym) {
    let updated = 0;
    map.forEach((data, yfSym) => {
      const sym = yfToSym(yfSym);
      if (!sym) return;
      const chgStr = (data.chg >= 0 ? '+' : '') + data.chg.toFixed(2) + '%';
      const s = liveStocks.find(x => x.sym === sym);
      if (s) {
        s.price = data.price; s.chg = chgStr; s.up = data.up; s._live = true;
      } else {
        const st = STATIC_STOCKS.find(x => x.sym === sym) || STATIC_COMMODITIES.find(x => x.sym === sym);
        liveStocks.push({ ...(st || { sym, name: sym }), price: data.price, chg: chgStr, up: data.up, _live: true });
      }
      updated++;
    });
    return updated;
  }

  function _fmtTs() {
    return new Date().toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
    }) + ' IST';
  }

  function _afterUpdate(count) {
    if (count <= 0) return;
    window._hasLiveData = true;
    setLiveStatus('live', '● LIVE · ' + _fmtTs());
    updateWhatsMoving();
    renderTrending(liveStocks);
    updateTickerFromLive();
    if (typeof buildGlobalTicker === 'function') buildGlobalTicker();
    onLiveDataUpdate();
    if (typeof updateHeroFromLiveStocks === 'function') updateHeroFromLiveStocks();
  }

  // ─────────────────────────────────────────────────────────────────
  // 5.  REPLACE: fetchPriorityStocks
  //     Called at startup — fetches the top 20 priority NSE stocks
  // ─────────────────────────────────────────────────────────────────
  window.fetchPriorityStocks = async function fetchPriorityStocks() {
    const PRIORITY_SYMS = [
      'RELIANCE','TCS','HDFCBANK','INFY','SBIN','ICICIBANK','TATAMOTORS',
      'WIPRO','AXISBANK','BAJFINANCE','TATASTEEL','TECHM','NTPC','JSWSTEEL',
      'ASIANPAINT','MARUTI','SUNPHARMA','KOTAKBANK','HCLTECH','LT'
    ];
    const yfSyms = PRIORITY_SYMS.map(s => YF_STOCK_MAP[s]).filter(Boolean);
    try {
      const map     = await yfBatchFetch(yfSyms);
      const yfToSym = yfSym => Object.keys(YF_STOCK_MAP).find(k => YF_STOCK_MAP[k] === yfSym);
      const n       = _applyBatchToLiveStocks(map, yfToSym);
      _afterUpdate(n);
    } catch (e) { /* silent — static data already showing */ }
  };

  // ─────────────────────────────────────────────────────────────────
  // 6.  REPLACE: _fastBootstrapStocks
  //     Fetches ALL NSE stocks in batches right after page load
  // ─────────────────────────────────────────────────────────────────
  let _bootstrapDone = false;
  window._fastBootstrapStocks = async function _fastBootstrapStocks() {
    if (_bootstrapDone) return;
    const allNseEntries = Object.entries(YF_STOCK_MAP).filter(([, v]) => v.endsWith('.NS'));
    const allNseYf      = allNseEntries.map(([, v]) => v);
    const yfToSym       = yfSym => {
      const e = allNseEntries.find(([, v]) => v === yfSym);
      return e ? e[0] : null;
    };

    const map = await yfBatchFetch(allNseYf);
    const n   = _applyBatchToLiveStocks(map, yfToSym);
    if (n > 0) {
      _bootstrapDone = true;
      _afterUpdate(n);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // 7.  REPLACE: _fetchAllMovers
  //     Periodic refresh of all NSE stocks for gainers/losers widget
  // ─────────────────────────────────────────────────────────────────
  window._fetchAllMovers = async function _fetchAllMovers() {
    const allNseEntries = Object.entries(YF_STOCK_MAP).filter(([, v]) => v.endsWith('.NS'));
    const allNseYf      = allNseEntries.map(([, v]) => v);
    const yfToSym       = yfSym => {
      const e = allNseEntries.find(([, v]) => v === yfSym);
      return e ? e[0] : null;
    };

    const CHUNK = 50;
    for (let i = 0; i < allNseYf.length; i += CHUNK) {
      const chunk = allNseYf.slice(i, i + CHUNK);
      try {
        const map = await yfBatchFetch(chunk);
        _applyBatchToLiveStocks(map, yfToSym);
        updateWhatsMoving();
        onLiveDataUpdate();
      } catch (e) { /* skip chunk */ }
      await new Promise(r => setTimeout(r, 150));
    }
    setLiveStatus('live', '● LIVE · ' + _fmtTs());
    updateWhatsMoving();
    onLiveDataUpdate();
  };

  // ─────────────────────────────────────────────────────────────────
  // 8.  REPLACE: _fetchIndicesVercel  (was hitting /api/indices)
  //     Fetches Nifty 50, Bank Nifty, Sensex directly from Yahoo
  // ─────────────────────────────────────────────────────────────────
  window._fetchIndicesVercel = async function _fetchIndicesVercel() {
    const IDX_MAP = {
      'NIFTY':     '^NSEI',
      'BANKNIFTY': '^NSEBANK',
      'SENSEX':    '^BSESN',
    };
    try {
      const yfSyms = Object.values(IDX_MAP);
      const map    = await yfBatchFetch(yfSyms);
      if (!window._liveIndices) window._liveIndices = {};

      const nifty  = map.get('^NSEI');
      const bank   = map.get('^NSEBANK');
      const sensex = map.get('^BSESN');

      if (nifty) {
        const chg = (nifty.chg >= 0 ? '+' : '') + nifty.chg.toFixed(2) + '%';
        window._liveIndices['NIFTY 50']   = { sym: 'NIFTY 50',   price: nifty.price,  chg, up: nifty.up };
        window._liveIndices['NIFTY']      = window._liveIndices['NIFTY 50'];
      }
      if (bank) {
        const chg = (bank.chg >= 0 ? '+' : '') + bank.chg.toFixed(2) + '%';
        window._liveIndices['NIFTY BANK'] = { sym: 'NIFTY BANK', price: bank.price,   chg, up: bank.up };
        window._liveIndices['BANKNIFTY']  = window._liveIndices['NIFTY BANK'];
      }
      if (sensex) {
        const chg = (sensex.chg >= 0 ? '+' : '') + sensex.chg.toFixed(2) + '%';
        window._liveIndices['SENSEX']     = { sym: 'SENSEX',     price: sensex.price, chg, up: sensex.up };
      }

      if (typeof updateHeroFromLiveStocks === 'function') updateHeroFromLiveStocks();
      updateTickerFromLive();
      if (typeof buildGlobalTicker === 'function') buildGlobalTicker();
    } catch (e) { /* silent */ }
  };

  // ─────────────────────────────────────────────────────────────────
  // 9.  REPLACE: fetchCommoditiesLive  (was hitting /api/quote)
  //     Fetches Gold, Silver, Crude, etc. via Yahoo Finance futures
  // ─────────────────────────────────────────────────────────────────
  const _COMM = [
    { sym: 'GOLD',       yf: 'GC=F'  },
    { sym: 'SILVER',     yf: 'SI=F'  },
    { sym: 'CRUDE',      yf: 'CL=F'  },
    { sym: 'BRENT',      yf: 'BZ=F'  },
    { sym: 'NATURALGAS', yf: 'NG=F'  },
    { sym: 'COPPER',     yf: 'HG=F'  },
    { sym: 'PLATINUM',   yf: 'PL=F'  },
    { sym: 'WHEAT',      yf: 'ZW=F'  },
    { sym: 'CORN',       yf: 'ZC=F'  },
  ];

  window.fetchCommoditiesLive = async function fetchCommoditiesLive() {
    try {
      const yfSyms = _COMM.map(c => c.yf);
      const map    = await yfBatchFetch(yfSyms);
      let updated  = 0;
      map.forEach((data, yfSym) => {
        const item = _COMM.find(c => c.yf === yfSym);
        if (!item) return;
        const chgStr = (data.chg >= 0 ? '+' : '') + data.chg.toFixed(2) + '%';
        const ex     = liveStocks.find(s => s.sym === item.sym);
        if (ex) {
          ex.price = data.price; ex.chg = chgStr; ex.up = data.up; ex._live = true;
        } else {
          const sc = STATIC_COMMODITIES.find(s => s.sym === item.sym);
          liveStocks.push({ ...(sc || { sym: item.sym, name: item.sym, currency: '$' }), price: data.price, chg: chgStr, up: data.up, _live: true });
        }
        updated++;
      });
      if (updated > 0) {
        updateTickerFromLive();
        if (typeof buildGlobalTicker === 'function') buildGlobalTicker();
        renderTrending(liveStocks);
      }
    } catch (e) { /* silent */ }
  };

  // ─────────────────────────────────────────────────────────────────
  // 10. REPLACE: _fetchMmiData  (Market Mood Index — was /api/quote)
  //     Fetches India VIX + indices for fear/greed calculation
  // ─────────────────────────────────────────────────────────────────
  window._fetchMmiData = async function _fetchMmiData() {
    try {
      const syms = ['^INDIAVIX', '^NSEI', '^NSEBANK', '^BSESN'];
      const map  = await yfBatchFetch(syms);

      const get = sym => {
        const d = map.get(sym);
        return d ? { price: d.price, chg: d.chg } : null;
      };

      window._mmiData = {
        vix:    get('^INDIAVIX'),
        nifty:  get('^NSEI'),
        bank:   get('^NSEBANK'),
        sensex: get('^BSESN'),
        fii:    (typeof _fiiData !== 'undefined' && _fiiData && _fiiData.length) ? _fiiData[0] : null,
        ts:     Date.now(),
      };
      window._mmiLastFetch = Date.now();

      // Also update _liveIndices with fresher data if we got it
      if (!window._liveIndices) window._liveIndices = {};
      const n50   = map.get('^NSEI');
      const nBank = map.get('^NSEBANK');
      const nSens = map.get('^BSESN');
      if (n50)   { const chg = (n50.chg >= 0 ? '+' : '') + n50.chg.toFixed(2) + '%';     window._liveIndices['NIFTY 50']   = { sym: 'NIFTY 50',   price: n50.price,   chg, up: n50.up };   window._liveIndices['NIFTY']      = window._liveIndices['NIFTY 50']; }
      if (nBank) { const chg = (nBank.chg >= 0 ? '+' : '') + nBank.chg.toFixed(2) + '%'; window._liveIndices['NIFTY BANK'] = { sym: 'NIFTY BANK', price: nBank.price,  chg, up: nBank.up }; window._liveIndices['BANKNIFTY']  = window._liveIndices['NIFTY BANK']; }
      if (nSens) { const chg = (nSens.chg >= 0 ? '+' : '') + nSens.chg.toFixed(2) + '%'; window._liveIndices['SENSEX']     = { sym: 'SENSEX',     price: nSens.price,  chg, up: nSens.up }; }

    } catch (e) {
      // Fallback: reuse _liveIndices if they exist
      const idx = window._liveIndices || {};
      window._mmiData = {
        nifty:  idx['NIFTY 50']   || idx['NIFTY']      || null,
        bank:   idx['NIFTY BANK'] || idx['BANKNIFTY']   || null,
        sensex: idx['SENSEX']     || null,
        vix:    null,
        fii:    (typeof _fiiData !== 'undefined' && _fiiData && _fiiData.length) ? _fiiData[0] : null,
        ts:     Date.now(),
      };
      window._mmiLastFetch = Date.now();
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // 11. REPLACE: _fetchYFDirectInner  (main fallback data engine)
  //     Fetches all stocks + commodities when Railway is offline
  // ─────────────────────────────────────────────────────────────────
  window._yfFetching = false;
  window.fetchYFDirect = async function fetchYFDirect() {
    if (window._yfFetching) return;
    window._yfFetching = true;
    try {
      let stocksUpdated = 0;

      // ── Stocks ──
      const allNseEntries = Object.entries(YF_STOCK_MAP).filter(([, v]) => v.endsWith('.NS'));
      const allNseYf      = allNseEntries.map(([, v]) => v);
      const yfToSym       = yfSym => { const e = allNseEntries.find(([, v]) => v === yfSym); return e ? e[0] : null; };
      const stockMap      = await yfBatchFetch(allNseYf);
      stocksUpdated       = _applyBatchToLiveStocks(stockMap, yfToSym);

      // ── Commodities ──
      const commYf  = _COMM.map(c => c.yf);
      const commMap = await yfBatchFetch(commYf);
      commMap.forEach((data, yfSym) => {
        const item   = _COMM.find(c => c.yf === yfSym);
        if (!item) return;
        const chgStr = (data.chg >= 0 ? '+' : '') + data.chg.toFixed(2) + '%';
        const ex     = liveStocks.find(s => s.sym === item.sym);
        if (ex) { ex.price = data.price; ex.chg = chgStr; ex.up = data.up; ex._live = true; }
        else { const sc = STATIC_COMMODITIES.find(s => s.sym === item.sym); liveStocks.push({ ...(sc || { sym: item.sym, name: item.sym, currency: '$' }), price: data.price, chg: chgStr, up: data.up, _live: true }); }
      });

      const total = stocksUpdated + commMap.size;
      if (total > 0) {
        renderTrending(liveStocks);
        updateTickerFromLive();
        if (typeof buildGlobalTicker === 'function') buildGlobalTicker();
        onLiveDataUpdate();
        setLiveStatus('live', '⚡ LIVE · ' + _fmtTs());
        if (typeof showApiBanner === 'function') showApiBanner('yfDirect');
      } else {
        setLiveStatus('static', '📊 Cached data');
        if (typeof showApiBanner === 'function') showApiBanner('static');
      }
    } catch (e) {
      setLiveStatus('static', '📊 Cached data');
    } finally {
      window._yfFetching = false;
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // 12. REPLACE: fetchLiveData  (main entry point)
  //     No Railway/Vercel — goes straight to direct fetches
  // ─────────────────────────────────────────────────────────────────
  window.fetchLiveData = async function fetchLiveData() {
    fetchCryptoLive();           // CoinGecko — already works fine
    fetchYFDirect();             // stocks + commodities — now backend-free
    _fetchIndicesVercel();       // indices — now backend-free despite the old name
  };

  // ─────────────────────────────────────────────────────────────────
  // 13. REPLACE: Stories price fetch  (was hitting /api/quote)
  //     Used by the story-bubbles at the top of the feed
  // ─────────────────────────────────────────────────────────────────
  //  We patch buildStories by wrapping the price-fetch section.
  //  The original buildStories calls /api/quote for story subject prices.
  //  We override it to use yfBatchFetch instead.
  const _origBuildStories = window.buildStories;
  window.buildStories = async function buildStories() {
    // Patch STORY_SUBJECTS price fetching before calling the original
    if (typeof STORY_SUBJECTS !== 'undefined' && Array.isArray(STORY_SUBJECTS)) {
      const yfSyms   = STORY_SUBJECTS.filter(s => s.yf).map(s => s.yf);
      if (yfSyms.length) {
        try {
          const map = await yfBatchFetch(yfSyms);
          map.forEach((data, yfSym) => {
            const subj = STORY_SUBJECTS.find(s => s.yf === yfSym);
            if (!subj) return;
            if (!window._stories) window._stories = {};
            window._stories[subj.id] = {
              price:  data.price,
              chgPct: data.chg,
              up:     data.up,
              ts:     Date.now(),
            };
          });
        } catch (e) { /* silent */ }
      }
    }
    // Call the original for everything else (news fetch, rendering, etc.)
    if (typeof _origBuildStories === 'function') return _origBuildStories();
  };

  // ─────────────────────────────────────────────────────────────────
  // 14. EXPOSE yfFetch + yfBatchFetch globally
  //     (chart / TA code calls yfFetch directly)
  // ─────────────────────────────────────────────────────────────────
  window.yfFetch      = yfFetch;
  window.yfBatchFetch = yfBatchFetch;

  // ─────────────────────────────────────────────────────────────────
  // 15. REFRESH SCHEDULE  (replaces old Railway-centric intervals)
  //     All intervals re-declared here — safe to load after the page
  // ─────────────────────────────────────────────────────────────────
  //  Clear any previously set intervals that reference the old functions
  //  (they would 404 on /api/quote and spam the console).
  //  We can't cancel them by id since the original code doesn't save the ids,
  //  so we just let them no-op (they call the overridden functions now).

  // Stocks: full refresh every 30 s
  setInterval(() => {
    window._bootstrapDone = false;  // allow re-fetch
    fetchLiveData();
  }, 30000);

  // Indices: every 20 s (tick-level for the ticker bar)
  setInterval(() => {
    _fetchIndicesVercel();
    updateTickerFromLive();
  }, 20000);

  // Commodities: every 5 min (futures don't change tick-by-tick)
  setInterval(fetchCommoditiesLive, 5 * 60 * 1000);

  // MMI: every 2 min
  setInterval(() => {
    if (typeof _fetchMmiData === 'function') _fetchMmiData();
  }, 2 * 60 * 1000);

  // Bootstrap retry: every 10 s until we have live data (max 2 min)
  let _bsRetries = 0;
  const _bsTimer = setInterval(() => {
    if (window._hasLiveData || _bsRetries++ > 12) { clearInterval(_bsTimer); return; }
    window._fastBootstrapStocks();
  }, 10000);

  // Visibility refresh: fetch immediately when tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      fetchLiveData();
      fetchCryptoLive();
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 16. KICK OFF immediately (DOM is already ready at this point)
  // ─────────────────────────────────────────────────────────────────
  console.log('[LiveEngine] Starting — no backend required');
  setTimeout(() => {
    fetchCryptoLive();
    _fetchIndicesVercel();
    fetchPriorityStocks();
    fetchCommoditiesLive();
    setTimeout(window._fastBootstrapStocks, 500);
    setTimeout(fetchYFDirect, 1000);
  }, 0);

})();
