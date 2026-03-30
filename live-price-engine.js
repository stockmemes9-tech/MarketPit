/**
 * MarketPit — Live Price Engine (drop-in replacement)
 *
 * Replace your existing live-price-engine.js with this file.
 * Requires: /api/prices.js and /api/news.js deployed on Vercel
 */
(function () {
  'use strict';

  const REFRESH_MS    = 30000;   // price refresh every 30 seconds
  const NEWS_REFRESH  = 300000;  // news refresh every 5 minutes

  async function fetchLivePrices(type) {
    const url = '/api/prices?type=' + (type || 'all');
    try {
      const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      console.warn('[LivePrice] fetch failed:', e.message);
      return null;
    }
  }

  async function fetchLiveNews(cat) {
    const url = '/api/news?cat=' + (cat || 'markets') + '&count=12';
    try {
      const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      console.warn('[LiveNews] fetch failed:', e.message);
      return null;
    }
  }

  function applyPrices(data) {
    if (!data || !data.prices || !data.prices.length) return 0;
    let updated = 0;

    data.prices.forEach(function (item) {
      const sym = item.sym;

      if (typeof liveStocks !== 'undefined' && Array.isArray(liveStocks)) {
        const existing = liveStocks.find(s => s.sym === sym);
        if (existing) {
          existing.price = item.price;
          existing.chg   = item.chg;
          existing.up    = item.up;
          existing._live = true;
        } else {
          const staticEntry =
            (typeof STATIC_STOCKS      !== 'undefined' ? STATIC_STOCKS.find(s => s.sym === sym)      : null) ||
            (typeof STATIC_COMMODITIES !== 'undefined' ? STATIC_COMMODITIES.find(s => s.sym === sym) : null) ||
            (typeof STATIC_CRYPTO      !== 'undefined' ? STATIC_CRYPTO.find(s => s.sym === sym)      : null);

          liveStocks.push(Object.assign({}, staticEntry || { sym: sym, name: sym }, {
            price: item.price, chg: item.chg, up: item.up, _live: true,
          }));
        }
        updated++;
      }

      document.querySelectorAll('[data-sym="' + sym + '"]').forEach(function (el) {
        const priceEl = el.querySelector('.stock-price, .price-val, .sym-price') || el;
        const chgEl   = el.querySelector('.stock-chg, .chg-val, .sym-chg');
        if (priceEl) priceEl.textContent = formatPrice(item.price, item.type);
        if (chgEl) {
          chgEl.textContent = item.chg;
          chgEl.className   = chgEl.className.replace(/\b(up|down|green|red)\b/g, '');
          chgEl.classList.add(item.up ? 'up' : 'down');
        }
        updated++;
      });
    });

    return updated;
  }

  function formatPrice(price, type) {
    if (price == null) return '—';
    const n = Number(price);
    if (isNaN(n)) return price;
    if (type === 'crypto') return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 });
    if (n >= 1000) return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
    return '₹' + n.toFixed(2);
  }

  function setLiveIndicator(ts) {
    const timeStr = ts
      ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) + ' IST'
      : new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) + ' IST';

    if (typeof setLiveStatus === 'function') setLiveStatus('live', '● LIVE · ' + timeStr);

    document.querySelectorAll('#live-status, .live-status, #liveStatusText').forEach(function (el) {
      el.textContent = '● LIVE · ' + timeStr;
    });
  }

  function renderNewsItems(data) {
    if (!data || !data.items || !data.items.length) return;

    const containers = [
      document.getElementById('newsContainer'),
      document.getElementById('news-list'),
      document.querySelector('.news-list'),
      document.querySelector('.news-container'),
      document.querySelector('[data-section="news"]'),
    ].filter(Boolean);

    if (!containers.length) {
      if (typeof renderNews === 'function') renderNews(data.items);
      if (typeof displayNews === 'function') displayNews(data.items);
      return;
    }

    const html = data.items.slice(0, 10).map(function (item) {
      const safeTitle  = item.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeSource = (item.source || '').replace(/</g, '&lt;');
      return (
        '<div class="bn-item news-item">' +
          '<a href="' + (item.link || '#') + '" target="_blank" rel="noopener noreferrer" class="news-link">' +
            '<div class="news-title">' + safeTitle + '</div>' +
            '<div class="news-meta">' +
              '<span class="news-source">' + safeSource + '</span>' +
              (item.ago ? ' · <span class="news-ago">' + item.ago + '</span>' : '') +
            '</div>' +
          '</a>' +
        '</div>'
      );
    }).join('');

    containers.forEach(function (c) { c.innerHTML = html; });
  }

  function updateTicker(prices) {
    if (!prices || !prices.length) return;

    const ticker =
      document.getElementById('live-ticker') ||
      document.getElementById('ticker') ||
      document.querySelector('.ticker-track') ||
      document.querySelector('.animate-marquee') ||
      document.querySelector('[class*="marquee"]') ||
      document.querySelector('[class*="ticker"]');

    if (!ticker) return;

    const items = prices.slice(0, 30).map(function (s) {
      const up  = s.up !== false;
      const clr = up ? 'var(--green,#00a854)' : 'var(--red,#e53935)';
      const arrow = up ? '▲' : '▼';
      return (
        '<span style="display:inline-flex;align-items:center;gap:8px;padding:0 20px;border-right:1px solid rgba(255,255,255,.1)">' +
          '<b style="font-size:11px;letter-spacing:.05em">' + s.sym + '</b>' +
          '<span style="font-size:13px;font-weight:700">' + formatPrice(s.price, s.type) + '</span>' +
          '<span style="font-size:11px;color:' + clr + '">' + arrow + ' ' + s.chg + '</span>' +
        '</span>'
      );
    }).join('');

    ticker.innerHTML = items + items;
    ticker.style.animation = 'none';
    ticker.offsetHeight;
    ticker.style.animation = '';
  }

  function triggerDashboardCallbacks() {
    if (typeof updateWhatsMoving        === 'function') updateWhatsMoving();
    if (typeof renderTrending           === 'function') renderTrending(typeof liveStocks !== 'undefined' ? liveStocks : []);
    if (typeof updateTickerFromLive     === 'function') updateTickerFromLive();
    if (typeof buildGlobalTicker        === 'function') buildGlobalTicker();
    if (typeof onLiveDataUpdate         === 'function') onLiveDataUpdate();
    if (typeof updateHeroFromLiveStocks === 'function') updateHeroFromLiveStocks();
    window._hasLiveData = true;
  }

  async function refreshPrices() {
    const data = await fetchLivePrices('all');
    if (!data) return;
    applyPrices(data);
    updateTicker(data.prices);
    setLiveIndicator(data.ts);
    triggerDashboardCallbacks();
  }

  async function refreshNews() {
    let cat = 'markets';
    const activeTab = document.querySelector('.filter-btn.active, .news-tab.active, [data-news-cat].active');
    if (activeTab) cat = activeTab.dataset.newsCat || activeTab.dataset.cat || activeTab.textContent.trim().toLowerCase() || 'markets';
    const data = await fetchLiveNews(cat);
    renderNewsItems(data);
  }

  function init() {
    refreshPrices();
    refreshNews();
    setInterval(refreshPrices, REFRESH_MS);
    setInterval(refreshNews, NEWS_REFRESH);
    document.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-news-cat], [data-cat]');
      if (btn) setTimeout(refreshNews, 100);
    });
    console.log('[MarketPit] Live price engine started. Refreshing every ' + (REFRESH_MS / 1000) + 's.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
