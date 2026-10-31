/* ClassiFlip Recently Sold strip v1 (Oct 31, 2026) — homepage
   only (index.html, #soldSection right under Boosted listings).
   Martin's social-proof call: sold business ads stay OUT of
   live search results (his Oct 30 rule stands), but they get
   their own stage on the homepage. Only stores qualify — a
   listing appears here only if its seller has a storefront
   (business_profiles row), the sale is inside the same 14-day
   window as the storefront badge, and each card links to the
   STORE, never to the dead ad. No site-wide totals are printed.
   Fail-soft by design: no qualifying sales (or any error) and
   the section simply stays hidden — never an empty strip.
   Reuses window.CFAuth.client (no keys of its own). */
(function () {
  'use strict';

  var sectionEl = document.getElementById('soldSection');
  var rowEl = document.getElementById('soldRow');
  if (!sectionEl || !rowEl) return;

  var SOLD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  var MAX_CARDS = 6;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function priceOf(x) {
    if (x.price == null || x.price === '') return '';
    var n = Number(x.price);
    if (isNaN(n)) return esc(x.price);
    return '$' + n.toLocaleString('en-CA', { maximumFractionDigits: 0 });
  }

  function getClient() {
    try {
      if (window.CFAuth && window.CFAuth.client) return window.CFAuth.client;
    } catch (e) {}
    return null;
  }

  function waitForClient(tries) {
    return new Promise(function (resolve) {
      (function attempt(n) {
        var c = getClient();
        if (c) { resolve(c); return; }
        if (n <= 0) { resolve(null); return; }
        setTimeout(function () { attempt(n - 1); }, 250);
      })(tries);
    });
  }

  function card(x) {
    var visual = x._photo
      ? '<img src="' + esc(x._photo) + '" alt="" loading="lazy">'
      : '<span style="font-size:42px" aria-hidden="true">🏷️</span>';
    return '<a class="featured-card" href="seller.html?id=' + encodeURIComponent(x.seller_id) +
      '" style="text-decoration:none;color:inherit">' +
      '<div class="featured-visual"><span class="featured-label">✓ SOLD</span>' + visual + '</div>' +
      '<div class="featured-copy">' +
        '<div class="prototype-tag">' + esc(x._store || 'Local store') + '</div>' +
        '<h3>' + esc(x.title) + '</h3>' +
        '<div class="price">' + priceOf(x) + '</div>' +
        '<span class="view">Visit store →</span>' +
      '</div></a>';
  }

  async function init() {
    var client = await waitForClient(20);
    if (!client) return;

    var res;
    try {
      res = await client.from('listings')
        .select('id,title,price,seller_id,sold_at,created_at')
        .eq('status', 'sold')
        .order('sold_at', { ascending: false, nullsFirst: false })
        .limit(30);
      if (res && res.error) throw res.error;
    } catch (e) { return; }
    var rows = (res && res.data) ? res.data : [];

    var now = Date.now();
    rows = rows.filter(function (x) {
      if (!x || !x.seller_id) return false;
      if (!x.sold_at) return true; /* same rule as the storefront: no stamp = still in window */
      return (now - new Date(x.sold_at).getTime()) <= SOLD_WINDOW_MS;
    });
    if (!rows.length) return;

    /* Stores only: keep listings whose seller has a storefront,
       and learn the store's name for the card. */
    var sellerIds = [];
    rows.forEach(function (x) { if (sellerIds.indexOf(x.seller_id) === -1) sellerIds.push(x.seller_id); });
    var storeNames = {};
    try {
      var bp = await client.from('business_profiles').select('id,display_name').in('id', sellerIds);
      if (bp && !bp.error && bp.data) {
        bp.data.forEach(function (b) { storeNames[b.id] = b.display_name; });
      }
    } catch (e) { return; }
    rows = rows.filter(function (x) {
      if (!storeNames[x.seller_id]) return false;
      x._store = storeNames[x.seller_id];
      return true;
    });
    rows.sort(function (a, b) {
      var ta = new Date(a.sold_at || a.created_at || 0).getTime();
      var tb = new Date(b.sold_at || b.created_at || 0).getTime();
      return tb - ta;
    });
    rows = rows.slice(0, MAX_CARDS);
    if (!rows.length) return;

    /* First photo per listing, same shape as the storefront. */
    try {
      var ids = rows.map(function (x) { return x.id; });
      var ph = await client.from('listing_photos')
        .select('listing_id,photo_url').in('listing_id', ids)
        .order('sort_order', { ascending: true });
      if (ph && !ph.error && ph.data) {
        var first = {};
        ph.data.forEach(function (p) {
          if (p && p.listing_id && !first[p.listing_id]) first[p.listing_id] = p.photo_url;
        });
        rows.forEach(function (x) { x._photo = first[x.id] || null; });
      }
    } catch (e) {}

    rowEl.innerHTML = rows.map(card).join('');
    sectionEl.hidden = false;
  }

  init();
})();
