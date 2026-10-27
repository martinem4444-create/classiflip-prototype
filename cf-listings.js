/* ClassiFlip real listings v1.10 — Supabase (marketplace-dev). Preview restored + multi-photo upload + post lands on View All + real rows marked LIVE LISTING + demo filler merged below real ads + step 5 Boost pinning + FCFS boost ordering (v1.9) + marketplace real boost button (v1.9) + package-default (v1.10).
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
 * - Multi-photo upload (v1.7): when a logged-in user posts with picked
 *   photos, EVERY photo uploads to the listing-photos bucket and gets
 *   one row in listing_photos (position 0 = cover = the starred photo
 *   the picker moved to index 0). listings.photo_url still gets the
 *   cover URL, so cards and old queries keep working. Cap: 8 photos
 *   (the picker already caps at 8; the post flow enforces it with a
 *   clear message as a backstop). All-or-nothing: uploads happen
 *   before the listing insert, and any failure rolls back what was
 *   already created (uploaded objects removed, listing row deleted),
 *   so a failed post never leaves partial photos or orphaned rows.
 *   Requires the cf-multiphoto-migration.sql to have been run first;
 *   until then, photo fetches fail silently and ads render via
 *   photo_url exactly as before.
 *
 * - Step 5 Boost (v1.8): alongside the listings fetch, the public
 *   cf_effective_boosts() RPC returns listing_id + expires_at for
 *   Active boosts (no buyer, no payment data — privacy-safe for
 *   logged-out visitors). A row counts as boosted-effective ONLY
 *   when its boost is Active AND expires_at is in the future, so a
 *   stale listings.boosted flag alone can never pin an ad. The flag
 *   travels on each mapped row (boostedEffective) for the page's
 *   render() (pin-first sort) and renderFeatured() (boosted rows
 *   fill featured slots first), and for the detail view badge.
 *   If the RPC fails (step-5 SQL not run yet), the set is empty
 *   and the page renders exactly as before — no pins, no badges.
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
 *   defensive copy of the check in the interceptor. The one
 *   exception is package-default (v1.10): when
 *   window.__cfPkgDefault carries an orderId, both the page's
 *   submit handler and the interceptor let the post through instead
 *   of redirecting, because the poster already owns a package.
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
     as before. photos is the full ordered photo list from
     listing_photos when available, else [photo_url] as a fallback —
     so single-photo ads (and ads posted before the multi-photo
     migration) render exactly as before. */
  /* boostedEffective travels on the mapped row for the page's
     render() / renderFeatured() / detail view (step 5, v1.8).
     boostedIds maps listing_id -> latest future expires_at ms.
     FCFS (v1.9): boostSort maps listing_id -> the listing's
     EARLIEST live boost { ms: activated_at ms, bst: BST number },
     which the page's render() / renderFeatured() sort the boosted
     block by (activation ASC, BST ASC). */
  function parseBstNum(ref) {
    if (!ref) return Number.MAX_SAFE_INTEGER;
    var m = String(ref).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  }
  function mapRow(r, photosById, boostedIds, boostSort) {
    var price = Number(r.price);
    if (isNaN(price)) price = 0;
    var photos = (photosById && photosById[r.id]) || (r.photo_url ? [r.photo_url] : []);
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
      photos: photos,
      verified: false,
      live: true,
      seller_id: r.seller_id || null,
      boostedEffective: !!(boostedIds && boostedIds[r.id]),
      boostExpires: (boostedIds && boostedIds[r.id]) || null,
      boostActivatedMs: (boostSort && boostSort[r.id]) ? boostSort[r.id].ms : null,
      bstNum: (boostSort && boostSort[r.id]) ? boostSort[r.id].bst : null
    };
  }

  /* Fetch active listings, newest first. Returns true only when the
     page was actually switched to database rows; false means "leave
     the demo listings exactly as they are". */
  async function refreshListings() {
    var client = getClient();
    if (!client) return false;
    /* Marketplace real boost button (v1.9): the signed-in owner id,
       so the page's render() can gate the real Boost button on own
       listings. getUser() resolves the stored session even when the
       page's loggedIn flag has not flipped yet. */
    try {
      var uRes = await client.auth.getUser();
      window.__cfMyId = (uRes && uRes.data && uRes.data.user) ? uRes.data.user.id : null;
    } catch (e) { window.__cfMyId = null; }
    try {
      var res = await client
        .from('listings')
        .select('id,title,description,price,category,condition,location,status,boosted,photo_url,created_at,seller_id')
        .eq('status', 'active')
        .order('created_at', { ascending: false });
      if (res.error || !res.data || !res.data.length) return false;
      /* Multi-photo (v1.7): one extra read for every fetched ad's
         photos, ordered by position. If it fails (migration not run
         yet, table missing), photosById stays null and mapRow falls
         back to photo_url — the page keeps working exactly as
         before, just single-photo. */
      var photosById = null;
      try {
        var ids = res.data.map(function (r) { return r.id; });
        var ph = await client.from('listing_photos')
          .select('listing_id,photo_url,position')
          .in('listing_id', ids).order('position', { ascending: true });
        if (ph && !ph.error && ph.data) {
          photosById = {};
          ph.data.forEach(function (p) {
            if (!photosById[p.listing_id]) photosById[p.listing_id] = [];
            if (p.photo_url) photosById[p.listing_id].push(p.photo_url);
          });
        }
      } catch (e) { photosById = null; }
      /* Step 5 Boost (v1.8): effective-boost set from the public RPC.
         Render-time enforcement lives here: only Active rows with
         expires_at in the future count, and the latest expiry wins
         per listing (re-boost extends). If the RPC fails (step-5
         SQL not run yet), boostedIds stays empty and nothing pins
         — the page works exactly as before. */
      var boostedIds = {};
      var boostSort = {};
      try {
        var br = await client.rpc('cf_effective_boosts');
        if (br && !br.error && br.data) {
          var nowMs = Date.now();
          br.data.forEach(function (b) {
            if (!b.listing_id || !b.expires_at) return;
            var ms = new Date(b.expires_at).getTime();
            if (!(ms > nowMs)) return;
            if (!boostedIds[b.listing_id] || ms > boostedIds[b.listing_id]) boostedIds[b.listing_id] = ms;
            /* FCFS (v1.9): this listing's queue position is its
               EARLIEST live boost — activation ASC, BST number
               breaking same-timestamp ties. A listing with several
               live boosts keeps its first place (re-boost extends,
               it never jumps the queue). Pre-FCFS-SQL rows carry no
               activated_at/payment_ref and tie at (0, MAX): stable
               order, pins and badges still work until the FCFS
               migration runs. */
            var actMs = b.activated_at ? new Date(b.activated_at).getTime() : 0;
            if (isNaN(actMs)) actMs = 0;
            var bstNum = parseBstNum(b.payment_ref);
            var prev = boostSort[b.listing_id];
            if (!prev || actMs < prev.ms || (actMs === prev.ms && bstNum < prev.bst)) {
              boostSort[b.listing_id] = { ms: actMs, bst: bstNum };
            }
          });
        }
      } catch (e) { boostedIds = {}; boostSort = {}; }
      var rows = res.data.map(function (r) { return mapRow(r, photosById, boostedIds, boostSort); });
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
      /* Multi-photo (v1.7): pendingPhotos[0] is the cover photo — the
         picker moves a starred photo to index 0. EVERY picked photo
         uploads to the listing-photos bucket, in picker order, BEFORE
         the listing insert, so a failed upload stops the post (real
         error shown, form kept) instead of posting photo-less or
         partial by accident. Cap: 8 photos — the picker already caps
         at 8, this is the backstop with a clear message. */
      var MAX_PHOTOS = 8;
      var picked = [];
      try {
        if (typeof pendingPhotos !== 'undefined' && pendingPhotos.length) picked = pendingPhotos.slice();
      } catch (e) {}
      if (picked.length > MAX_PHOTOS) {
        fail('You can add up to ' + MAX_PHOTOS + ' photos per ad — please remove ' + (picked.length - MAX_PHOTOS) + ' and try again.');
        return;
      }
      var uploaded = []; /* [{ path, url }] in picker order (0 = cover) */
      try {
        for (var pi = 0; pi < picked.length; pi++) {
          var blob = dataUrlToBlob(picked[pi]);
          if (!blob) throw new Error('Could not read photo ' + (pi + 1) + '. Please pick it again.');
          var photoPath = user.id + '/' + Date.now() + '-' + pi + '.jpg';
          var up = await client.storage.from('listing-photos').upload(photoPath, blob, { contentType: 'image/jpeg', upsert: false });
          if (up.error) throw up.error;
          var pub = client.storage.from('listing-photos').getPublicUrl(photoPath);
          var purl = pub && pub.data && pub.data.publicUrl ? pub.data.publicUrl : null;
          if (!purl) throw new Error('Could not get a public link for photo ' + (pi + 1) + '.');
          uploaded.push({ path: photoPath, url: purl });
        }
      } catch (upErr) {
        /* Roll back any objects already uploaded, then surface the
           real error through the outer catch (form kept for retry). */
        try {
          if (uploaded.length) await client.storage.from('listing-photos').remove(uploaded.map(function (u) { return u.path; }));
        } catch (e) {}
        throw upErr;
      }
      /* Cover URL for backward compat: cards and old queries read
         photo_url, so it still gets the cover even though every
         photo also gets a listing_photos row below. */
      var photoUrl = uploaded.length ? uploaded[0].url : null;
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
      /* Package-default (v1.10): attach the defaulted order when one
         is active for this category (the form refresh validated it —
         the quota read proving the order_id column exists). A stale
         or absent state posts exactly as before, without order_id. */
      try {
        var pd = window.__cfPkgDefault;
        if (pd && pd.orderId && pd.category === newRow.category) newRow.order_id = pd.orderId;
      } catch (e) {}
      var ins = await client.from('listings').insert([newRow]).select().single();
      if (ins.error || !ins.data || !ins.data.id) {
        /* Listing insert failed after uploads: remove the objects so
           no orphaned storage is left behind. */
        try {
          if (uploaded.length) await client.storage.from('listing-photos').remove(uploaded.map(function (u) { return u.path; }));
        } catch (e) {}
        if (ins.error) throw ins.error;
        throw new Error('Could not create your ad. Please try again.');
      }
      /* Photo rows (one per picked photo, position = picker order).
         If this fails, roll the whole post back: delete the listing
         (CASCADE removes any photo rows already written) + remove
         the uploaded objects — no partial post ever survives. */
      if (uploaded.length) {
        var photoRows = uploaded.map(function (u, idx) {
          return { listing_id: ins.data.id, photo_url: u.url, position: idx };
        });
        var phIns = await client.from('listing_photos').insert(photoRows);
        if (phIns.error) {
          try { await client.from('listings').delete().eq('id', ins.data.id); } catch (e) {}
          try { await client.storage.from('listing-photos').remove(uploaded.map(function (u) { return u.path; })); } catch (e) {}
          throw phIns.error;
        }
      }
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

  /* Package-default (v1.10): when a signed-in user has a bought
     Active package for the form's category, the form shows it as a
     label line (no dropdown) and the post attaches
     listings.order_id. Only status='Active' with a future
     expires_at counts; Pending reserves and expired orders NEVER
     default. Newest Active wins (latest expires_at, then latest
     created_at). At quota the form falls back to today's behaviour
     WITH a notice — never a hard block. The quota read doubles as
     the migration probe: if listings.order_id does not exist yet,
     the read fails and the feature stays silent (posts work
     exactly as before) until
     supabase/cf-package-default-migration.sql runs. Jobs is in
     the family map, but the Jobs flow lives in the job modal
     (follow-up), so no jobs default is wired in v1. Founding
     packages match no family in v1 (spec families only) — a
     flagged open question for Martin, not a silent decision. */
  var PKG_FAMILY = {
    Cars: 'dealer', Homes: 'agent', Rentals: 'agent',
    Services: 'services', Jobs: 'jobs'
  };
  function pkgFamilyOf(pkgLabel) {
    if (!pkgLabel) return null;
    var l = String(pkgLabel);
    if (l.indexOf('Dealer') === 0) return 'dealer';
    if (l.indexOf('Agent') === 0) return 'agent';
    if (l.indexOf('Services') === 0) return 'services';
    if (l.indexOf('Jobs') === 0) return 'jobs';
    return null; /* Founding + anything else: no family in v1 */
  }
  function pkgQuotaOf(pkgLabel) {
    var l = String(pkgLabel || '');
    if (l.indexOf('Unlimited') !== -1) return Infinity;
    if (l.indexOf('5-Pack') !== -1) return 5;
    if (l.indexOf('Lot Pack') !== -1) return 25;
    return 1; /* every Single tier */
  }
  function pkgMoney(n) {
    try {
      return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n);
    } catch (e) { return '$' + n; }
  }
  function pkgDate(s) {
    try {
      return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return ''; }
  }
  /* Shared state the page's submit handler reads: orderId is set
     ONLY when a default is active and quota allows (null = today's
     form, including the business -> Advertise redirect). */
  function pkgClearState() {
    window.__cfPkgDefault = { orderId: null, category: null };
    var f = document.getElementById('pkgDefaultField');
    if (f) f.hidden = true;
  }
  function pkgShowLine(text) {
    var f = document.getElementById('pkgDefaultField');
    var l = document.getElementById('pkgDefaultLine');
    if (!f || !l) return;
    l.textContent = text;
    f.hidden = false;
  }
  var pkgFetch = null; /* in-flight orders fetch, deduped */
  var pkgCache = null; /* { userId, orders } */
  async function pkgFetchOrders(client, userId) {
    if (pkgCache && pkgCache.userId === userId) return pkgCache.orders;
    if (!pkgFetch) {
      pkgFetch = (async function () {
        var nowIso = new Date().toISOString();
        var res = await client.from('orders')
          .select('id,package,amount,status,expires_at,created_at')
          .eq('buyer_id', userId).eq('status', 'Active')
          .gt('expires_at', nowIso)
          .order('expires_at', { ascending: false })
          .order('created_at', { ascending: false });
        if (res.error) throw res.error;
        return res.data || [];
      })().then(function (orders) {
        pkgCache = { userId: userId, orders: orders };
        pkgFetch = null;
        return orders;
      }, function (err) {
        pkgFetch = null;
        throw err;
      });
    }
    return pkgFetch;
  }
  async function pkgRefresh() {
    /* Runs after every updateCarPostingFields() (wrapped below), so
       it always sees the form's current category. Any failure is
       silent by design: the form keeps today's behaviour and the
       post still goes through. */
    try {
      var catEl = document.getElementById('adCategory');
      var cat = catEl ? catEl.value : '';
      var fam = PKG_FAMILY[cat];
      if (!fam) { pkgClearState(); return; }
      var client = getClient();
      if (!client || !isLoggedIn()) { pkgClearState(); return; }
      var userRes = await client.auth.getUser();
      var user = userRes && userRes.data && userRes.data.user;
      if (!user) { pkgClearState(); return; }
      var orders = await pkgFetchOrders(client, user.id);
      var match = null;
      for (var i = 0; i < orders.length; i++) {
        if (pkgFamilyOf(orders[i].package) === fam) { match = orders[i]; break; }
      }
      if (!match) { pkgClearState(); return; }
      /* Quota read — also the migration probe. If order_id does
         not exist yet this errors and the feature stays off. */
      var cnt = await client.from('listings')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', match.id);
      if (cnt.error) throw cnt.error;
      var used = (typeof cnt.count === 'number') ? cnt.count : 0;
      var limit = pkgQuotaOf(match.package);
      if (limit !== Infinity && used >= limit) {
        /* At quota: fallback to today's form WITH a notice. The
           state keeps orderId null, so the business redirect and
           the page's own button text both behave as before. */
        window.__cfPkgDefault = { orderId: null, category: cat };
        pkgShowLine('Your ' + match.package + ' has used ' + used + '/' + limit + ' posts — renew or upgrade on Advertise.');
        return;
      }
      window.__cfPkgDefault = { orderId: match.id, category: cat };
      pkgShowLine('Posting under your ' + match.package + ' — ' + pkgMoney(match.amount) + '/mo, active until ' + pkgDate(match.expires_at) + '.');
      /* The package owner already bought: hide the business pitch
         and keep the submit button on 'Preview listing' (the page's
         own updateCarPostingFields just set it to 'See business
         packages' for business posters — that text + redirect no
         longer apply once a package defaults). */
      try {
        var pitch = document.getElementById('bizPitchField');
        if (pitch) pitch.classList.remove('show');
        var sb = document.querySelector('#postForm .form-actions .primary');
        if (sb) sb.textContent = 'Preview listing';
      } catch (e) {}
    } catch (e) {
      pkgClearState();
    }
  }
  /* Wrap the page's own field updater: every path that touches the
     post form (modal open, category change, seller-type change,
     business-type change, quick-post buttons) flows through it, so
     the package lookup refreshes with the form's current category.
     The wrap installs after the page script defined it (this file
     loads after the page's inline script). */
  try {
    if (typeof updateCarPostingFields === 'function' && !updateCarPostingFields.__cfPkgWrapped) {
      var _ucpf = updateCarPostingFields;
      var _ucpfWrapped = function () {
        _ucpf();
        pkgRefresh();
      };
      _ucpfWrapped.__cfPkgWrapped = true;
      updateCarPostingFields = _ucpfWrapped;
    }
  } catch (e) {}

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
        bizType && bizType.value === 'business' &&
        !(window.__cfPkgDefault && window.__cfPkgDefault.orderId)) {
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

  /* Detail gallery (v1.7): multi-photo ads render every real photo
     as a thumb. The page's own gallery-thumb handler swaps the main
     image — it reads data-gallery-image / data-gallery-photo off the
     clicked thumb — so no new click wiring is needed; the thumbs
     below carry exactly the attributes it expects. Single-photo (or
     no-photo) ads use the page's galleryMarkup exactly as before:
     byte-identical output, no behaviour change. Note: the page's
     handler labels the main image "Image N of 5" regardless of the
     real photo count — a cosmetic label only, the images are right. */
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function detailGalleryMarkup(x) {
    var photos = (x.photos && x.photos.length) ? x.photos : [];
    if (photos.length <= 1) return galleryMarkup(x);
    var thumbs = photos.map(function (p, i) {
      return '<button class="gallery-thumb gallery-tone-' + ((i % 5) + 1) + (i === 0 ? ' active' : '') + '" data-gallery-image="' + (i + 1) + '" data-gallery-icon="' + escAttr(x.icon) + '" data-gallery-photo="' + escAttr(p) + '" aria-label="Show image ' + (i + 1) + ' of ' + photos.length + '"><img src="' + escAttr(p) + '" alt="" loading="lazy"></button>';
    }).join('');
    return '<div class="detail-gallery"><div class="detail-visual gallery-tone-1" id="galleryMain" aria-label="Image 1 of ' + photos.length + '"><img src="' + escAttr(photos[0]) + '" alt="" loading="lazy"></div><div class="gallery-thumbs" aria-label="Listing image gallery">' + thumbs + '</div></div>';
  }

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
        '<div class="detail">' + detailGalleryMarkup(x) + '<div>' +
        '<div class="prototype-tag">LIVE LISTING · ' + safe(x.category).toUpperCase() + '</div>' +
        (x.boostedEffective ? '<div class="prototype-tag">🚀 BOOSTED</div>' : '') +
        '<h3>' + safe(x.title) + '</h3>' +
        '<div class="detail-price">' + displayPrice(x) + '</div>' +
        (canRealBoost(x) ? '<div style="margin-top:12px"><button class="primary" data-cf-real-boost="' + x.id + '">Boost · $2.99</button></div>' : '') +
        /* Messages move-up (Oct 26, 2026): contact (Message seller + Share) sits under the price, mirroring the v1.10 Boost move — the bottom of a tall modal hides behind the mobile tab bar. */
        listingContactMarkup() +
        '<div class="meta"><span>' + safe(x.condition) + '</span><span>•</span><span>' + safe(x.location) + '</span></div>' +
        '<p>' + safe(x.desc) + '</p>' +
        '<div class="notice">This is a live listing posted on ClassiFlip.</div>' +
        ((x.category === 'Homes' || x.category === 'Rentals') ? locationCardMarkup(x) : '') +
        '</div></div>';
      if (typeof closeModals === 'function') closeModals();
      if (typeof openModal === 'function') openModal('detailModal');
    } catch (err) {
      /* Never crash the page from this guard. */
    }
  }, true);

  /* Marketplace real boost button (v1.9): signed-in owners see a
     REAL "Boost · $2.99" on their own marketplace cards / detail
     view (rendered by the page's render() and the detail guard
     below). It opens the REAL Interac reserve flow — a Pending
     boosts row with a DB-generated BST code — mirroring the
     dashboard real flow's copy and behaviour. Logged-out viewers
     never see this button: they keep the page's EXISTING demo
     boost modal (fake Apple Pay/card, fanfare, fake boosted
     state), untouched. Gate, enforced at render AND at click
     time: signed-in + own listing + active listing. The boosts
     table's own-listing-only insert policy is the server-side
     backstop. cf-dashboard.js is never touched from here. */
  function canRealBoost(x) {
    try {
      if (!x || !x.live) return false;
      if (!window.__cfMyId) return false;
      if (typeof loggedIn !== 'undefined' && !loggedIn) return false;
      return String(x.seller_id || '') !== '' && String(x.seller_id) === String(window.__cfMyId);
    } catch (e) {
      return false;
    }
  }
  function openRealBoostModal(x) {
    try {
      document.getElementById('detailTitle').textContent = 'Boost your ad';
      document.getElementById('detailBody').innerHTML =
        '<div style="max-width:440px;margin:0 auto">' +
        '<p>Boost <b>' + safe(x.title) + '</b> for <b>$2.99</b> — it jumps to the top of search and category pages for <b>7 days</b>, wearing a BOOSTED badge buyers cannot miss.</p>' +
        '<div class="notice" id="cfRealBoostErr" style="display:none"></div>' +
        '<button class="primary" id="cfRealBoostPay" style="width:100%">Reserve with Interac e-Transfer · $2.99</button>' +
        '<p style="color:#7a8499;font-size:13px;margin:12px 0 2px">Interac e-Transfer only in this build · card checkout comes at launch</p>' +
        '</div>';
      if (typeof closeModals === 'function') closeModals();
      if (typeof openModal === 'function') openModal('detailModal');
      var payBtn = document.getElementById('cfRealBoostPay');
      if (payBtn) payBtn.addEventListener('click', function () { reserveRealBoost(x, payBtn); });
    } catch (err) {}
  }
  async function reserveRealBoost(x, btn) {
    var orig = btn.textContent;
    var errEl = document.getElementById('cfRealBoostErr');
    function showErr(msg) {
      if (errEl) { errEl.textContent = msg; errEl.style.display = ''; }
    }
    try {
      /* Re-check the gate at click time: the button only renders
         for own active ads, but never trust render-time state for
         a money-adjacent insert. */
      if (!canRealBoost(x)) {
        showErr('This boost option is only available for your own active ads. Please reload the page and try again.');
        return;
      }
      var client = getClient();
      if (!client) {
        showErr('Could not reserve the boost: not connected. Please reload the page and try again.');
        return;
      }
      var userRes = await client.auth.getUser();
      var user = userRes && userRes.data && userRes.data.user;
      if (!user) {
        showErr('Please log in again to reserve a boost.');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Reserving…';
      /* Mirror of the dashboard real reserve: the database
         generates the BST code (step-5 SQL default); the row is
         read back, and a code-less row is rolled back — Martin
         could never match its payment. No Stripe path exists here
         by design (Interac only in this build). */
      var ins = await client.from('boosts').insert([{
        listing_id: x.id, buyer_id: user.id,
        amount: 2.99, payment_method: 'etransfer', status: 'Pending'
      }]).select('id').single();
      if (ins.error || !ins.data || !ins.data.id) throw ins.error || new Error('Could not reserve the boost.');
      var codeRes = await client.from('boosts').select('payment_ref').eq('id', ins.data.id).maybeSingle();
      var bst = codeRes && codeRes.data && codeRes.data.payment_ref;
      if (codeRes.error || !bst) {
        try { await client.from('boosts').delete().eq('id', ins.data.id); } catch (e2) {}
        throw new Error('The step-5 SQL has not been run yet — boosts need it first (BST codes). Run supabase/cf-boost-migration.sql, then try again.');
      }
      document.getElementById('detailBody').innerHTML =
        '<div style="max-width:440px;margin:0 auto;text-align:center">' +
        '<div style="font-size:44px;line-height:1">🚀</div>' +
        '<h3 style="margin:10px 0 6px">Payment sent — Martin activates your boost</h3>' +
        '<p>Send <b>$2.99</b> by Interac e-Transfer to <b>mm905media@gmail.com</b> with <b>' + safe(bst) + '</b> in the message.<br>' +
        'Martin activates your boost, usually the same day — it then runs 7 days, pinned first in its category.</p>' +
        '<p>Boost ref: <b>' + safe(bst) + '</b> · Ad: ' + safe(x.title) + '</p>' +
        '<button class="primary" id="cfRealBoostDone">Done</button>' +
        '</div>';
      var doneBtn = document.getElementById('cfRealBoostDone');
      if (doneBtn && typeof closeModals === 'function') doneBtn.addEventListener('click', function () { closeModals(); });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = orig;
      showErr('Could not reserve the boost: ' + (err && err.message ? err.message : 'Something went wrong.'));
    }
  }
  document.addEventListener('click', function (e) {
    var rb = e.target && e.target.closest ? e.target.closest('[data-cf-real-boost]') : null;
    if (!rb) return;
    var raw = rb.dataset.cfRealBoost;
    if (!raw) return;
    var x = null;
    try {
      x = listings.find(function (y) { return String(y.id) === raw; });
    } catch (err) {
      x = null;
    }
    if (!x) return;
    e.preventDefault();
    e.stopPropagation();
    openRealBoostModal(x);
  }, true);

  /* Keep the owner id fresh across sign-in/sign-out without a
     reload, so the real Boost button appears/disappears exactly
     with the session. Demo-preview sign-in (page flag only, no
     Supabase session) yields no id, so no real button — correctly,
     since no insert could succeed. Re-renders only when the id
     actually changes (INITIAL_SESSION fires once here). */
  try {
    var _authSubClient = getClient();
    if (_authSubClient && _authSubClient.auth && typeof _authSubClient.auth.onAuthStateChange === 'function') {
      _authSubClient.auth.onAuthStateChange(function (event, session) {
        var newId = (session && session.user) ? session.user.id : null;
        if (newId !== window.__cfMyId) {
          window.__cfMyId = newId;
          try { if (typeof render === 'function') render(); } catch (e) {}
          try { if (typeof renderFeatured === 'function') renderFeatured(); } catch (e) {}
        }
      });
    }
  } catch (e) {}

  /* Page load: switch to database rows when possible, demo otherwise. */
  refreshListings();
})();
