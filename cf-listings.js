/* ClassiFlip real listings v1 — Supabase (marketplace-dev).
 *
 * WHAT IT DOES:
 * - On page load, fetches listings with status 'active' (newest first)
 *   from Supabase and renders them through the page's EXISTING card
 *   markup: the page's own listings array is replaced in place and its
 *   own render() / renderFeatured() / renderHeroCarousel() run, so the
 *   grid, featured row and hero carousel all show the same rows.
 * - When a logged-in user submits the post-an-ad form, inserts one row
 *   into public.listings and refreshes the list. On failure the real
 *   error message is shown in the post modal's notice — errors are
 *   never swallowed (a missing profile row, for example, surfaces as
 *   the database's foreign-key error, verbatim).
 *
 * SAFETY / FALLBACK RULES:
 * - This file contains NO API key or secret. It only reuses
 *   window.CFAuth.client, which cf-auth.js already created. If that
 *   client is absent (key never pasted, library failed to load), this
 *   module does nothing at all and the page keeps its demo behaviour.
 * - If the listings fetch fails, or the table is empty, the existing
 *   demo listings are left exactly as they are (silent fallback).
 * - Logged-out users are untouched: their post-an-ad submit keeps the
 *   page's original preview flow. Only logged-in submits are
 *   intercepted, and the business-posting redirect (advertise.html)
 *   is preserved.
 *
 * KNOWN LIMITS (forced by the page's existing code, not this module):
 * - The page's card template hardcodes a SAMPLE tag and render()
 *   labels the count "prototype listings", so real rows rendered
 *   through it still carry that wording until index.html's template
 *   is edited in a later pass. After a fresh load this module
 *   relabels the count to "N live listings"; the next filter/search
 *   render reverts it to the page's wording.
 * - The page's click handlers coerce listing ids with Number(), so
 *   Save / Share / Boost / map-pin clicks on real rows (whose ids are
 *   UUID strings) are no-ops, and View-details would throw. This
 *   module therefore intercepts View-details clicks on non-numeric
 *   ids (capture phase, before the page's handler) and renders the
 *   detail view with the page's own galleryMarkup / safe /
 *   displayPrice / listingContactMarkup helpers instead of crashing.
 *   Save on real rows still cannot work from outside: render() reads
 *   the page's own saved Set, which only ever holds numbers.
 */

(function () {
  'use strict';

  /* The page's own Supabase client, or null. Never a key of our own. */
  function getClient() {
    try {
      if (window.CFAuth && window.CFAuth.client) return window.CFAuth.client;
    } catch (e) {}
    return null;
  }

  /* The page's own logged-in flag (set by cf-auth.js on sign-in). */
  function isLoggedIn() {
    try {
      return typeof loggedIn !== 'undefined' && !!loggedIn;
    } catch (e) {
      return false;
    }
  }

  /* Same category -> icon mapping the page's own collectAdForm uses,
     so a real row renders through the card template without a photo. */
  var ICON_MAP = {
    Cars: 'monitor', Clothes: 'chair', Computers: 'laptop',
    Electronics: 'phone', Home: 'chair', Rentals: 'apartment',
    Homes: 'house', Free: 'chair', Services: 'drill',
    Tools: 'drill', Sports: 'bike'
  };

  /* Database row -> the page's listing-item shape. */
  function mapRow(r) {
    var price = Number(r.price);
    if (isNaN(price)) price = 0;
    return {
      id: r.id,
      title: r.title || '',
      price: price,
      category: r.category || 'General',
      condition: r.condition || 'Good',
      location: r.location || 'Mississauga, ON',
      desc: r.description || '',
      icon: ICON_MAP[r.category] || 'laptop',
      photo: '',
      verified: false
    };
  }

  /* Fetch active listings, newest first. Returns true only when the
     page was actually switched to database rows; false means "leave
     the demo listings exactly as they are". */
  async function refreshListings() {
    var client = getClient();
    if (!client) return false;
    try {
      var res = await client
        .from('listings')
        .select('id,title,description,price,category,condition,location,status,boosted,created_at')
        .eq('status', 'active')
        .order('created_at', { ascending: false });
      if (res.error || !res.data || !res.data.length) return false;
      var rows = res.data.map(mapRow);
      listings.length = 0;
      rows.forEach(function (r) { listings.push(r); });
      if (typeof render === 'function') render();
      if (typeof renderFeatured === 'function') renderFeatured();
      if (typeof renderHeroCarousel === 'function') renderHeroCarousel();
      var rn = document.getElementById('resultsNote');
      if (rn) rn.textContent = rows.length + (rows.length === 1 ? ' live listing' : ' live listings');
      return true;
    } catch (e) {
      return false;
    }
  }

  /* Real post: insert one row, then refresh. Errors stay visible in
     the post modal's notice and the form is left untouched for retry. */
  async function postAd() {
    var noticeEl = document.getElementById('postNotice');
    function fail(msg) {
      if (noticeEl) noticeEl.textContent = msg;
    }
    try {
      var client = getClient();
      if (!client) {
        fail('Could not post your ad: not connected. Please reload the page and try again.');
        return;
      }
      var userRes = await client.auth.getUser();
      var user = userRes && userRes.data && userRes.data.user;
      if (!user) {
        fail('Could not post your ad: you are not signed in. Please log in again.');
        return;
      }
      var title = document.getElementById('adTitle').value.trim();
      var price = Number(document.getElementById('adPrice').value);
      if (!title) {
        fail('Enter a title for your ad.');
        return;
      }
      if (isNaN(price)) price = 0;
      var ins = await client.from('listings').insert([{
        seller_id: user.id,
        title: title,
        description: document.getElementById('adDescription').value.trim(),
        price: price,
        category: document.getElementById('adCategory').value,
        condition: document.getElementById('adCondition').value,
        location: document.getElementById('adLocation').value.trim() || 'Mississauga, ON',
        status: 'active'
      }]).select().single();
      if (ins.error) throw ins.error;

      var form = document.getElementById('postForm');
      if (form) form.reset();
      try {
        if (typeof pendingPhotos !== 'undefined') pendingPhotos = [];
        if (typeof renderPhotoStrip === 'function') renderPhotoStrip();
      } catch (e) {}
      if (typeof closeModals === 'function') closeModals();

      var refreshed = await refreshListings();
      if (!refreshed && ins.data) {
        /* Insert worked but the re-fetch did not: show the new row
           locally rather than pretending nothing happened. */
        try {
          listings.unshift(mapRow(ins.data));
          if (typeof render === 'function') render();
          if (typeof renderFeatured === 'function') renderFeatured();
          if (typeof renderHeroCarousel === 'function') renderHeroCarousel();
        } catch (e) {}
      }
      var mp = document.getElementById('marketplace');
      if (mp) mp.scrollIntoView({ behavior: 'smooth' });
      var rn = document.getElementById('resultsNote');
      if (rn) rn.textContent = 'Your ad is live — it appears at the top of the list.';
      if (noticeEl) noticeEl.textContent = 'Your ad was posted.';
    } catch (err) {
      fail('Could not post your ad: ' + (err && err.message ? err.message : 'Something went wrong. Please try again.'));
    }
  }

  /* Intercept the post-an-ad submit, but only for logged-in users
     with a live client. Capture phase on document runs before the
     page's own submit listener on the form, so stopping the event
     here keeps the demo preview flow from running for real posts.
     Logged-out submits and the business redirect pass through
     untouched. */
  var posting = false;
  document.addEventListener('submit', function (e) {
    if (!e.target || e.target.id !== 'postForm') return;
    if (!getClient() || !isLoggedIn()) return;
    var bizField = document.getElementById('bizTypeField');
    var bizType = document.getElementById('bizType');
    if (bizField && bizField.classList.contains('show') &&
        bizType && bizType.value === 'business') return;
    e.preventDefault();
    e.stopPropagation();
    if (posting) return;
    posting = true;
    postAd().then(function () { posting = false; }, function () { posting = false; });
  }, true);

  /* View-details guard for real rows. The page's own handler does
     listings.find(y => y.id === Number(dataset.view)) with no
     not-found check, which throws for UUID ids. Non-numeric ids are
     ours: render the detail with the page's own helpers instead. */
  document.addEventListener('click', function (e) {
    var v = e.target && e.target.closest ? e.target.closest('[data-view]') : null;
    if (!v) return;
    var raw = v.dataset.view;
    if (!raw || !isNaN(Number(raw))) return;
    var x = null;
    try {
      x = listings.find(function (y) { return String(y.id) === raw; });
    } catch (err) {
      x = null;
    }
    if (!x) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      activeListingId = x.id;
      document.getElementById('detailTitle').textContent = 'Listing details';
      document.getElementById('detailBody').innerHTML =
        '<div class="detail">' + galleryMarkup(x) + '<div>' +
        '<div class="prototype-tag">LIVE LISTING · ' + safe(x.category).toUpperCase() + '</div>' +
        '<h3>' + safe(x.title) + '</h3>' +
        '<div class="detail-price">' + displayPrice(x) + '</div>' +
        '<div class="meta"><span>' + safe(x.condition) + '</span><span>•</span><span>' + safe(x.location) + '</span></div>' +
        '<p>' + safe(x.desc) + '</p>' +
        '<div class="notice">This is a live listing posted on ClassiFlip.</div>' +
        ((x.category === 'Homes' || x.category === 'Rentals') ? locationCardMarkup(x) : '') +
        listingContactMarkup() +
        '</div></div>';
      if (typeof closeModals === 'function') closeModals();
      if (typeof openModal === 'function') openModal('detailModal');
    } catch (err) {
      /* Never crash the page from this guard. */
    }
  }, true);

  /* Page load: switch to database rows when possible, demo otherwise. */
  refreshListings();
})();
