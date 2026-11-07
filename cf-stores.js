/* ClassiFlip stores directory v1 (Oct 31, 2026) — public page
   (stores.html). Martin's catch: a business whose ONLY listing
   sold had an unreachable storefront, because the only road in
   was a live ad. This directory lists EVERY storefront from
   business_profiles (public-read by policy), with each store's
   live-ad count and sold-in-the-last-14-days count, so a store
   is findable even with zero live ads.

   Reads ONLY business_profiles + light listing columns
   (seller_id, status, sold_at, expires_at) for the counts. No
   profiles, no emails, no totals for the whole site are printed
   anywhere — each store's numbers are its own and already
   public on its storefront. No login needed. Fails soft: any
   error lands on a plain explanatory state, never a blank page.
   Reuses window.CFAuth.client (no keys of its own).

   v1.1 (Nov 6, 2026) — category chips. A store belongs to a
   category when it has a LIVE ad there, or SOLD one there in
   the last 14 days (the same window as the sold counts), so a
   dealer keeps its Cars chip through the gap between listings.
   Chips are built only for categories that hold at least one
   store, in marketplace order, and combine with the name
   search. Deliberately NOT package-based: orders are private,
   and categories derived from package labels could credit
   stores for reserved or expired packages. What a store
   demonstrably sells is public, truthful, and needs no new
   SQL. (Martin delegated the call Nov 6, 2026.) */
(function () {
  'use strict';

  var stateEl = document.getElementById('storesState');
  var gridEl = document.getElementById('storesGrid');
  var emptyEl = document.getElementById('storesEmpty');
  var noneEl = document.getElementById('storesNone');
  var searchEl = document.getElementById('storeSearch');
  var catsEl = document.getElementById('storeCats');

  var SOLD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  var stores = [];
  var activeCat = 'All';
  /* v1.2 (Nov 7, 2026, Martin's call): chips ONLY for the paid
     package categories — Cars, Homes, Rentals, Services — in
     that order. Free-category chips (Computers, Electronics,
     Sports, …) came up live and Martin cut them: the directory
     filter mirrors the business side of the marketplace. A
     store whose ads live only in free categories appears under
     All Stores, same as a store with no current ads. */
  var CAT_ORDER = ['Cars', 'Homes', 'Rentals', 'Services'];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fail(msg) {
    if (stateEl) { stateEl.hidden = false; stateEl.textContent = msg; }
    if (gridEl) gridEl.hidden = true;
    if (emptyEl) emptyEl.hidden = true;
    if (noneEl) noneEl.hidden = true;
    if (catsEl) catsEl.hidden = true;
  }

  function getClient() {
    try {
      if (window.CFAuth && window.CFAuth.client) return window.CFAuth.client;
    } catch (e) {}
    return null;
  }

  function storeCard(s) {
    var stats;
    if (s.live > 0 && s.sold > 0) {
      stats = s.live + (s.live === 1 ? ' live ad' : ' live ads') +
        ' · <span class="sold">' + s.sold + ' sold in the last 14 days</span>';
    } else if (s.live > 0) {
      stats = s.live + (s.live === 1 ? ' live ad' : ' live ads');
    } else if (s.sold > 0) {
      stats = 'No live ads right now · <span class="sold">' + s.sold +
        ' sold in the last 14 days</span>';
    } else {
      stats = 'No live ads right now';
    }
    var logo = s.logo_url
      ? '<span class="store-logo"><img src="' + esc(s.logo_url) + '" alt="" loading="lazy"></span>'
      : '<span class="store-logo">🏬</span>';
    return '<a class="store" href="seller.html?id=' + encodeURIComponent(s.id) + '">' +
      logo +
      '<span class="store-body">' +
        '<h2>' + esc(s.display_name) + '</h2>' +
        (s.tagline ? '<p class="store-tag">' + esc(s.tagline) + '</p>' : '') +
        (s.address ? '<div class="store-meta">' + esc(s.address) + '</div>' : '') +
        '<div class="store-stats">' + stats + '</div>' +
      '</span></a>';
  }

  function renderCats() {
    if (!catsEl) return;
    if (!stores.length) { catsEl.hidden = true; return; }
    /* v1.3 (Nov 7, 2026, Martin's call): the four paid-category
       chips are ALWAYS shown, even with no store in them yet —
       the row is the directory's fixed business taxonomy, not a
       data-driven subset. An empty category lands on a "no
       stores yet" state for that category. */
    var html = '<button type="button" class="cat-chip' + (activeCat === 'All' ? ' on' : '') +
      '" data-cat="All">All stores</button>';
    CAT_ORDER.forEach(function (c) {
      html += '<button type="button" class="cat-chip' + (activeCat === c ? ' on' : '') +
        '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
    });
    catsEl.innerHTML = html;
    catsEl.hidden = false;
  }

  function render() {
    var q = (searchEl && searchEl.value ? searchEl.value : '').trim().toLowerCase();
    var rows = stores.filter(function (s) {
      if (activeCat !== 'All' && (s.cats || []).indexOf(activeCat) === -1) return false;
      if (!q) return true;
      return (String(s.display_name || '').toLowerCase().indexOf(q) !== -1) ||
             (String(s.tagline || '').toLowerCase().indexOf(q) !== -1);
    });
    if (stateEl) stateEl.hidden = true;
    if (!stores.length) {
      if (gridEl) gridEl.hidden = true;
      if (emptyEl) emptyEl.hidden = true;
      if (noneEl) noneEl.hidden = false;
      return;
    }
    if (noneEl) noneEl.hidden = true;
    if (!rows.length) {
      if (gridEl) gridEl.hidden = true;
      if (emptyEl) {
        emptyEl.textContent = (!q && activeCat !== 'All')
          ? 'No ' + activeCat + ' stores yet — the first ones are getting set up.'
          : 'No stores match that — try a different name or category.';
        emptyEl.hidden = false;
      }
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (gridEl) {
      gridEl.hidden = false;
      gridEl.innerHTML = rows.map(storeCard).join('');
    }
  }

  async function init() {
    var client = getClient();
    if (!client) { fail('This page needs the site\'s connection to load. Check your connection and refresh.'); return; }

    var profs;
    try {
      profs = await client.from('business_profiles')
        .select('id,display_name,tagline,logo_url,address')
        .order('display_name', { ascending: true });
      if (profs && profs.error) throw profs.error;
    } catch (e) { profs = null; }
    if (!profs || !profs.data) { fail('Stores could not be loaded right now. Please refresh in a moment.'); return; }

    /* Light counts query — degrades to zeroes rather than
       failing the page if it ever errors. Also gathers each
       store's categories (live ads + sold inside the window)
       for the v1.1 chips. */
    var counts = {};
    try {
      var lr = await client.from('listings')
        .select('seller_id,status,sold_at,expires_at,category')
        .in('status', ['active', 'sold']);
      if (lr && !lr.error && lr.data) {
        var now = Date.now();
        lr.data.forEach(function (r) {
          if (!r || !r.seller_id) return;
          var c = counts[r.seller_id] || (counts[r.seller_id] = { live: 0, sold: 0, cats: {} });
          if (r.status === 'active') {
            if (!r.expires_at || new Date(r.expires_at).getTime() > now) {
              c.live += 1;
              if (r.category) c.cats[r.category] = true;
            }
          } else if (r.status === 'sold') {
            if (!r.sold_at || (now - new Date(r.sold_at).getTime()) <= SOLD_WINDOW_MS) {
              c.sold += 1;
              if (r.category) c.cats[r.category] = true;
            }
          }
        });
      }
    } catch (e) {}

    stores = profs.data.map(function (p) {
      var c = counts[p.id] || { live: 0, sold: 0, cats: {} };
      p.live = c.live; p.sold = c.sold;
      p.cats = Object.keys(c.cats || {});
      return p;
    });
    stores.sort(function (a, b) {
      if (b.live !== a.live) return b.live - a.live;
      if (b.sold !== a.sold) return b.sold - a.sold;
      return String(a.display_name || '').localeCompare(String(b.display_name || ''));
    });

    if (searchEl) searchEl.addEventListener('input', render);
    if (catsEl) catsEl.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-cat]') : null;
      if (!b) return;
      activeCat = b.getAttribute('data-cat') || 'All';
      renderCats();
      render();
    });
    renderCats();
    render();
  }

  init();
})();
