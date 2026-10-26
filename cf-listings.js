/* ClassiFlip real listings v1.6 — Supabase (marketplace-dev). Preview restored + photo upload (cover photo) + post lands on View All + real rows marked LIVE LISTING + demo filler merged below real ads.
 * Step 4: new posts insert as status='pending' (approval gate — hidden from the public fetch until an admin approves) + admin email notification via the notify-admin-pending-ad Edge Function (no key in site code).
 *
 * WHAT IT DOES:
 * - On page load, fetches listings with status 'active' (newest first)
 *   from Supabase and renders them through the page's EXISTING card
 *   markup: the page's own listings array is replaced in place and its
 *   own render() / renderFeatured() / renderHeroCarousel() run, so the
 *   grid, featured row and hero carousel all show the same rows.
 * - Preview restored (v1.2): the post form's submit is no longer
 *   intercepted, so every user gets the page's own preview modal
 *   first. For a logged-in user, clicking Post in the preview inserts
 *   one row into public.listings and refreshes the list. On failure
 *   the real error message is shown in the post modal's notice and
 *   the form is reopened with its values intact for retry — errors
 *   are never swallowed (a missing profile row, for example,
 *   surfaces as the database's foreign-key error, verbatim).
 * - Photo upload (v1.1): when a logged-in user posts with a picked
 *   cover photo, the photo is uploaded to the listing-photos bucket
 *   and its public URL is stored as the listing's photo_url, so the
 *   card shows the real photo instead of the category icon. If the
 *   upload fails, the post stops and the real error is shown — the
 *   ad is never posted photo-less by accident. No photo picked means
 *   the post works exactly as before. Requires the cf-photo-migration
 *   SQL (photo_url column) to have been run first.
 *
 * SAFETY / FALLBACK RULES:
 * - This file contains NO API key or secret. It only reuses
 *   window.CFAuth.client, which cf-auth.js already created. If that
 *   client is absent (key never pasted, library failed to load), this
 *   module does nothing at all and the page keeps its demo behaviour.
 * - If the listings fetch fails, or the table is empty, the existing
 *   demo listings are left exactly as they are (silent fallback).
 * - Logged-out users are untouched: their preview Post click keeps
 *   the page's original demo flow (local unshift). Only the preview
 *   Post click of a logged-in user is intercepted. The
 *   business-posting redirect (advertise.html) still happens in the
 *   page's own submit handler before any preview opens, with a
 *   defensive copy of the check in the interceptor.
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

  /* Step 4 admin email (fire-and-forget): after a successful pending
     insert, ping the notify-admin-pending-ad Edge Function, which
     verifies the caller's Supabase JWT server-side and emails ONLY the
     fixed admin address (mm905media@gmail.com) via Resend. No key lives
     in this file, and the browser never calls api.resend.com directly
     (Resend blocks browser calls; the repo is public). Email failure
     is silent by design — the ad is pending regardless. */
  function notifyAdminPendingAd(listing) {
    try {
      var client = getClient();
      if (!client) return;
      client.auth.getSession().then(function (s) {
        var token = s && s.data && s.data.session && s.data.session.access_token;
        if (!token) return;
        fetch('https://dbgmyvjaavpmernaxnav.functions.supabase.co/notify-admin-pending-ad', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ listing_id: listing.id, title: listing.title, category: listing.category, price: listing.price })
        }).catch(function () {});
      }).catch(function () {});
    } catch (e) {}
  }

  /* Data URL (canvas JPEG from the picker's pendingPhotos) -> Blob.
     Manual decode: no fetch dependency, works in every webview. */
  function dataUrlToBlob(dataUrl) {
    try {
      var parts = String(dataUrl).split(',');
      if (parts.length < 2) return null;
      var header = parts[0];
      var mime = 'image/jpeg';
      var mimeMatch = header.match(/data:([^;]+)/);
      if (mimeMatch) mime = mimeMatch[1];
      var binary;
      if (header.indexOf('base64') !== -1) {
        binary = atob(parts[1]);
      } else {
        binary = decodeURIComponent(parts[1]);
      }
      var len = binary.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    } catch (e) {
      return null;
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

  /* Database row -> the page's listing-item shape. A row's photo_url
     becomes the item's photo, so the page's own card markup (which
     shows x.photo when set, else the category icon) shows the real
     photo. Rows without photo_url keep photo '' and render exactly
     as before. */
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
      photo: r.photo_url || '',
      verified: false,
      live: true
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
        .select('id,title,description,price,category,condition,location,status,boosted,photo_url,created_at')
        .eq('status', 'active')
        .order('created_at', { ascending: false });
      if (res.error || !res.data || !res.data.length) return false;
      var rows = res.data.map(mapRow);
      // v1.5 merge: keep the page's demo filler BELOW the real ads.
      // Snapshot the demo rows once, before the first replace, so later
      // refreshes never duplicate them.
      if (!window.__cfDemoRows) {
        var looksDemo = listings.length && listings.every(function (x) { return !x.live; });
        if (looksDemo) window.__cfDemoRows = listings.slice();
      }
      var demo = window.__cfDemoRows || [];
      listings.length = 0;
      rows.forEach(function (r) { listings.push(r); });
      demo.forEach(function (r) { listings.push(r); });
      if (typeof render === 'function') render();
      if (typeof renderFeatured === 'function') renderFeatured();
      if (typeof renderHeroCarousel === 'function') renderHeroCarousel();
      var rn = document.getElementById('resultsNote');
      if (rn) rn.textContent = rows.length + (rows.length === 1 ? ' live listing' : ' live listings') + (demo.length ? ' + ' + demo.length + ' samples' : '');
      return true;
    } catch (e) {
      return false;
    }
  }

  /* Real post: insert one row, then refresh. On failure the real
     error is shown and the user is returned to the post form with
     their values intact for retry: the preview modal closes, the
     post modal reopens, and the message lands in the post modal's
     notice. Nothing is reset and no row is inserted on failure. */
  async function postAd() {
    var noticeEl = document.getElementById('postNotice');
    function fail(msg) {
      if (noticeEl) noticeEl.textContent = msg;
      /* Return the user to the form they just previewed, values
         intact (this function never resets on failure). If the modal
         helpers are missing, pin the message to the top of the
         preview instead so it is still visible. */
      var reopened = false;
      try {
        if (typeof closeModals === 'function' && typeof openModal === 'function') {
          closeModals();
          openModal('postModal');
          reopened = true;
        }
      } catch (e) {}
      if (!reopened) {
        try {
          var db = document.getElementById('detailBody');
          if (db) {
            var warn = document.createElement('div');
            warn.className = 'notice';
            warn.textContent = msg;
            db.insertBefore(warn, db.firstChild);
          }
        } catch (e2) {}
      }
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
      /* Cover photo (v1.1): pendingPhotos[0] is the cover photo — the
         picker moves a starred photo to index 0. Upload it FIRST so a
         failed upload stops the post (real error shown, modal stays
         open, form kept) instead of posting photo-less by accident. */
      var photoUrl = null;
      var coverPhoto = null;
      try {
        if (typeof pendingPhotos !== 'undefined' && pendingPhotos.length) coverPhoto = pendingPhotos[0];
      } catch (e) {}
      if (coverPhoto) {
        var blob = dataUrlToBlob(coverPhoto);
        if (!blob) throw new Error('Could not read the picked photo. Please pick it again.');
        var photoPath = user.id + '/' + Date.now() + '.jpg';
        var up = await client.storage.from('listing-photos').upload(photoPath, blob, { contentType: 'image/jpeg', upsert: false });
        if (up.error) throw up.error;
        var pub = client.storage.from('listing-photos').getPublicUrl(photoPath);
        photoUrl = pub && pub.data && pub.data.publicUrl ? pub.data.publicUrl : null;
        if (!photoUrl) throw new Error('Could not get a public link for the uploaded photo.');
      }
      var newRow = {
        seller_id: user.id,
        title: title,
        description: document.getElementById('adDescription').value.trim(),
        price: price,
        category: document.getElementById('adCategory').value,
        condition: document.getElementById('adCondition').value,
        location: document.getElementById('adLocation').value.trim() || 'Mississauga, ON',
        /* Step 4 approval gate: pending, NOT active. The public fetch
           reads only status='active' rows (and the seller's own rows),
           so a pending ad stays hidden until an admin approves it. */
        status: 'pending'
      };
      if (photoUrl) newRow.photo_url = photoUrl;
      var ins = await client.from('listings').insert([newRow]).select().single();
      if (ins.error) throw ins.error;
      /* Admin email: fire-and-forget, never blocks the post flow. */
      try {
        if (ins.data && ins.data.id) {
          notifyAdminPendingAd({ id: ins.data.id, title: title, category: newRow.category, price: price });
        }
      } catch (e) {}
      /* Consume the preview ad, mirroring the page's own preview-post
         handler (which nulls window._pendingAd before unshifting). */
      try { window._pendingAd = null; } catch (e) {}

      var form = document.getElementById('postForm');
      if (form) form.reset();
      try {
        if (typeof pendingPhotos !== 'undefined') pendingPhotos = [];
        if (typeof renderPhotoStrip === 'function') renderPhotoStrip();
      } catch (e) {}
      if (typeof closeModals === 'function') closeModals();

      var refreshed = await refreshListings();
      /* No local fallback unshift for pending ads: a pending ad is not
         public, so it must not appear in the grid even locally. If the
         re-fetch failed, the ad is still safely pending in the database
         and the dashboard shows it under the seller's own listings. */
      /* Land on View All (v1.3): the real post never reset the filter
         (the page's demo post did), so a stale category could leave
         the grid empty after posting. Clicking the page's own All chip
         resets category, search and Saved through its own handler.
         Note: the new ad itself will NOT appear here until an admin
         approves it — that is the approval gate working as intended. */
      try {
        var allChip = document.querySelector('[data-category="All"]');
        if (allChip) allChip.click();
      } catch (e) {}
      var mp = document.getElementById('marketplace');
      if (mp) mp.scrollIntoView({ behavior: 'smooth' });
      var rn = document.getElementById('resultsNote');
      if (rn) rn.textContent = 'Your ad is pending approval — it will appear once Martin approves it.';
      if (noticeEl) noticeEl.textContent = 'Your ad was posted and is awaiting approval.';
    } catch (err) {
      fail('Could not post your ad: ' + (err && err.message ? err.message : 'Something went wrong. Please try again.'));
    }
  }

  /* Real post on the preview's Post click (v1.2), but only for
     logged-in users with a live client. The form's submit is no
     longer intercepted, so the page's own submit handler always runs
     first: business users are redirected to advertise.html there,
     and everyone else gets the preview modal. This capture-phase
     document click listener runs before the page's own bubble-phase
     click handler, so stopping the event here keeps the page's demo
     preview-post (local unshift) from running for real posts.
     Logged-out Post clicks pass through untouched: preview -> demo
     unshift, exactly as today. */
  var posting = false;
  document.addEventListener('click', function (e) {
    var pp = e.target && e.target.closest ? e.target.closest('[data-preview-post]') : null;
    if (!pp) return;
    if (!getClient() || !isLoggedIn()) return;
    /* Defensive business check: the page's submit handler normally
       redirects business users before any preview opens, so this
       should never trigger — but if one ever reaches this button,
       redirect instead of inserting (the page's demo handler would
       otherwise post a demo ad for them). */
    var bizField = document.getElementById('bizTypeField');
    var bizType = document.getElementById('bizType');
    if (bizField && bizField.classList.contains('show') &&
        bizType && bizType.value === 'business') {
      e.preventDefault();
      e.stopPropagation();
      location.href = 'advertise.html';
      return;
    }
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
