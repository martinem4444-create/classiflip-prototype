/* ClassiFlip Recently Sold strip v2 (Nov 6, 2026) — homepage
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
   Reuses window.CFAuth.client (no keys of its own).

   v2 (Nov 6, 2026, Martin's call): read from the
   public_sold_cards view instead of listings directly. RLS
   hides sold rows from anonymous visitors, so v1 only ever
   rendered for signed-in members — the strip is a billboard
   and billboards face outward. The view exposes ONLY the
   fields a card displays (title, price, store name, first
   photo, dates) for store sales inside the 14-day window,
   which the view itself enforces. Created by
   ClassiFlip-Public-Sold-Cards-View.sql.
   (v1 also carried the Nov 2 storefront bug — ordering photos
   by the non-existent 'sort_order' column; fixed in v1.1
   earlier on Nov 6, then superseded by this rewrite.) */
(function () {
  'use strict';

  var sectionEl = document.getElementById('soldSection');
  var rowEl = document.getElementById('soldRow');
  if (!sectionEl || !rowEl) return;

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

  /* Thumbnails (Nov 13, 2026): small strip renders use the -t.jpg
     sibling when the photo lives in the listing-photos bucket; the
     shared capture-phase fallback (cf-listings.js) swaps any missing
     thumb back to the full-size original. */
  function thumbUrl(u) {
    try {
      var s = String(u || '');
      if (s.indexOf('/listing-photos/') === -1) return u;
      if (/-t\.(jpe?g|png)$/i.test(s)) return u;
      return s.replace(/\.(jpe?g|png)$/i, '-t.$1');
    } catch (e) { return u; }
  }

  function card(x) {
    var visual = x._photo
      ? '<img src="' + esc(thumbUrl(x._photo)) + '" alt="" loading="lazy">'
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
      res = await client.from('public_sold_cards')
        .select('id,title,price,seller_id,store_name,photo_url,sold_at,created_at')
        .order('sold_at', { ascending: false, nullsFirst: false })
        .limit(30);
      if (res && res.error) throw res.error;
    } catch (e) { return; }
    var rows = (res && res.data) ? res.data : [];

    rows = rows.filter(function (x) { return x && x.seller_id && x.store_name; });
    rows.sort(function (a, b) {
      var ta = new Date(a.sold_at || a.created_at || 0).getTime();
      var tb = new Date(b.sold_at || b.created_at || 0).getTime();
      return tb - ta;
    });
    rows = rows.slice(0, MAX_CARDS);
    if (!rows.length) return;

    rows.forEach(function (x) {
      x._store = x.store_name;
      x._photo = x.photo_url || null;
    });

    rowEl.innerHTML = rows.map(card).join('');
    sectionEl.hidden = false;
  }

  init();
})();
