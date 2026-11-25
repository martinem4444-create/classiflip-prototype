/* ClassiFlip dashboard wiring v1.6 (step 4 + multi-photo + step 5 Boost + ad manager + business stats + package-holder auto-approve, Nov 25, 2026) — Supabase (marketplace-dev).
 *
 * WHAT IT DOES (signed-in users only; logged-out visitors keep the demo):
 * - Replaces the demo listing cards with the signed-in user's REAL listings
 *   (all statuses: active / pending / rejected / sold / expired / hidden),
 *   with a real Delete action on each.
 * - Replaces the demo message rows with the user's REAL threads (via
 *   window.CFMessages.listThreads, the same module index.html uses).
 * - Replaces the demo stats with REAL counts (active, pending, unread, orders).
 * - Adds a "My orders" section: the user's own orders with status + expiry.
 * - Step 5 Boost (v1.2, Interac-first): a "Boost · $2.99" button on each
 *   ACTIVE own listing (never on pending / rejected / sold / expired);
 *   the mBoost modal reserves a Pending boosts row with a DB-generated
 *   BST code and shows honest "Payment sent — Martin activates your
 *   boost" copy + Interac instructions (no fake "Ad boosted!" state
 *   for real rows). A "My boosts" section shows the seller's own
 *   boosts; the Admin section gains pending-boosts (Activate · 7
 *   days), active-boosts (Expire) and expiring-within-3-days lists,
 *   mirroring the orders queue. Re-boost extends: activating a boost
 *   while another live boost exists for the same ad adds 7 days onto
 *   the latest expiry instead of restarting the clock.
 * - Adds an "Admin" section, visible ONLY when the user's profiles row has
 *   is_admin = true: the pending-ads queue (Approve -> active, Reject ->
 *   rejected) and the orders queue (Activate -> Active + 30-day expiry,
 *   Expiring soon, Expired), plus a computed "expiring within 3 days" list.
 * - Multi-photo (v1.1): pending queue cards show ALL of an ad's photos
 *   as thumbnails (from listing_photos), not just the cover — moderation
 *   sees every image before approving. Single-photo ads render exactly
 *   as before. Deleting an ad also best-effort removes its storage
 *   objects (paths derived from the photo URLs); the row delete itself
 *   never waits on storage, so a storage failure can't block a delete.
 * - Ad manager (v1.3): My listings gains a List/Grid toggle; real ads
 *   gain a working Edit (title/price/description/location/photos) that
 *   sends the ad back to pending approval, with category locked so the
 *   package linkage can't drift. Admin gains a "Find a business" search
 *   (business name, email, or phone) listing the account's ads with
 *   Delete for phone-requested takedowns; deleting an ad never touches
 *   its order, so no refund moves automatically.
 *
 * SECURITY NOTES:
 * - This file contains NO keys. It reuses window.CFAuth.client (no keys of
 *   its own), exactly like cf-listings.js and cf-messages.js.
 * - The admin section is UI gating only. Real enforcement is server-side:
 *   the admin approve/reject/update calls succeed only after the step-4
 *   SQL (supabase/cf-step4-admin-rls.sql) is run in Supabase, which adds
 *   admin-only read/update policies backed by the is_admin() helper.
 *   Until that SQL runs, admin buttons fail with an RLS error and the
 *   section shows a hint saying so — nothing is silently faked.
 * - Demo fallback: when there is no signed-in session (or no Supabase
 *   client, e.g. the local placeholder-key copy of cf-auth.js), this module
 *   does nothing and the page keeps its original demo content.
 */
(function () {
  'use strict';

  function getClient() {
    try {
      if (window.CFAuth && window.CFAuth.client) return window.CFAuth.client;
    } catch (e) {}
    return null;
  }

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function money(n) {
    try {
      return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n);
    } catch (e) { return '$' + n; }
  }

  /* Buyer approval emails (Oct 28, 2026, automatic + fire-and-forget):
     after a successful Approve or order Activate, ping the matching
     Edge Function, which verifies the admin caller server-side and
     emails the buyer from the database row — never from a request
     field. Email failure is silent by design: the approval/activation
     still stands. Buyer delivery itself only lands once Resend's
     sender switches to @classiflip.com after domain day (sandbox
     sender only reaches the account owner until then). */
  function notifyBuyer(fn, body) {
    try {
      var client = getClient();
      if (!client) return;
      client.auth.getSession().then(function (s) {
        var token = s && s.data && s.data.session && s.data.session.access_token;
        if (!token) return;
        fetch('https://dbgmyvjaavpmernaxnav.functions.supabase.co/' + fn, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify(body)
        }).catch(function () {});
      }).catch(function () {});
    } catch (e) {}
  }

  function shortDate(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  function fullDate(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return ''; }
  }

  function say(t) {
    try { if (typeof toast === 'function') toast(t); } catch (e) {}
  }

  var STATUS_PILL = {
    active: ['live', 'Live'],
    pending: ['pend', 'Pending approval'],
    rejected: ['rej', 'Rejected'],
    sold: ['pause', 'Sold'],
    expired: ['pause', 'Expired'],
    hidden: ['pause', 'Hidden']
  };

  function pillFor(status) {
    var p = STATUS_PILL[status] || ['pause', status || 'Unknown'];
    return '<span class="pill ' + p[0] + '">' + esc(p[1]) + '</span>';
  }

  /* Ad manager v1.3 state: list/grid view for My ads, plus the ad
     currently being really edited (null when the editor is in demo
     mode, so demo Save keeps working untouched). */
  var dashView = 'list';
  var realEdit = null;

  var renderedReal = false;
  var inFlight = false;

  /* Launch gate (Oct 31, 2026, Martin's call): the Dashboard is
     members-only. With a live auth client and NO session, bounce to
     the homepage instead of serving the demo content. No client yet
     (script still loading) never bounces — the boot check polls until
     the client appears, and a SIGNED_OUT event bounces too. */
  var gateDone = false;
  function gateBounce() {
    if (gateDone) return;
    gateDone = true;
    try { location.replace('index.html'); } catch (e) {}
  }
  function gateCheck() {
    var client = getClient();
    if (!client) return false;
    try {
      if (!gateCheck.subscribed && client.auth.onAuthStateChange) {
        gateCheck.subscribed = true;
        client.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT') gateBounce(); });
      }
    } catch (e) {}
    client.auth.getSession().then(function (s) {
      if (!(s && s.data && s.data.session)) gateBounce();
    }).catch(function () {});
    return true;
  }
  (function gateBoot() {
    if (gateCheck()) return;
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (gateCheck() || tries > 20) clearInterval(iv);
    }, 250);
  })();

  /* ---- Step 5 Boost (v1.2) ---- */
  var BOOST_PRICE = 2.99;
  var BOOST_DAYS = 7;
  var BOOST_ADMIN_EMAIL = 'mm905media@gmail.com';
  /* Stripe Payment Link placeholder. STAYS a placeholder in this
     build: the Stripe option is GATED — no button, link, or code
     path in this file ever opens BOOST_PAYMENT_LINK while it
     contains 'REPLACE_WITH', so no buyer can ever click through to
     Stripe's "link doesn't exist" error page. Interac is the only
     live payment path in this build. When the real $2.99 Payment
     Link exists, paste it here (one line) and add the card button
     behind a stripeLinkReady() check — never before. */
  var BOOST_PAYMENT_LINK = 'https://buy.stripe.com/REPLACE_WITH_BOOST_LINK';
  function stripeLinkReady() {
    return BOOST_PAYMENT_LINK.indexOf('REPLACE_WITH') === -1;
  }
  /* The listing a real Boost-button click is currently targeting
     (set by the data-cf-boost handler, cleared after a successful
     reserve). The page's demo openBoost(name) flow never sets this,
     so demo boosts always take the page's original fake path. */
  var boostListing = null;
  function playBoostSound() {
    try {
      var C = window._cfBoostAc;
      if (!C || C.state === 'closed') C = window._cfBoostAc = new (window.AudioContext || window.webkitAudioContext)();
      var run = function () {
        try {
          var t0 = C.currentTime;
          function ping(at, fq, peak, dur) {
            var o = C.createOscillator(), o2 = C.createOscillator(), g = C.createGain();
            o.type = 'square'; o.frequency.value = fq; o2.type = 'square'; o2.frequency.value = fq * 1.007;
            g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
            o.connect(g); o2.connect(g); g.connect(C.destination); o.start(at); o.stop(at + dur + 0.02); o2.start(at); o2.stop(at + dur + 0.02);
          }
          var gaps = [0.055, 0.065, 0.075, 0.085, 0.1, 0.115, 0.13], tt = t0;
          gaps.forEach(function (gp, i) { tt += gp; ping(tt, i % 2 ? 2093 : 1568, 0.05, 0.05); });
          ping(t0 + 0.80, 2637, 0.16, 0.5); ping(t0 + 0.80, 3520, 0.07, 0.4); ping(t0 + 0.80, 1046.5, 0.06, 0.5);
        } catch (e) {}
      };
      /* Repeat-play fix: on phones the audio context can go
         suspended between boosts, and notes scheduled while
         suspended never sound — so resume first, then play. */
      if (C.state === 'suspended') { try { C.resume().then(run).catch(run); } catch (e) { run(); } }
      else run();
    } catch (e) {}
  }


  /* Restore the mBoost modal to its demo state (fake Pay button
     visible, real Interac button hidden). Used only for the stale
     edge where the modal is reopened without a real target — the
     demo flow then works exactly as the page defines it. */
  function restoreBoostModalDemo() {
    boostListing = null;
    var fakePay = el('boostFakePay'); if (fakePay) fakePay.style.display = '';
    var rp = el('boostRealPay'); if (rp) rp.style.display = 'none';
    var rd = el('boostRealDone'); if (rd) rd.classList.add('hidden');
    var note = el('boostPayNote'); if (note) note.textContent = 'Secure checkout · Interac, Visa, Mastercard';
    var form = el('boostForm'); if (form) form.classList.remove('hidden');
    var bd = el('boostDone'); if (bd) bd.classList.add('hidden');
  }

  async function getUser(client) {
    try {
      var res = await client.auth.getUser();
      return res && res.data && res.data.user ? res.data.user : null;
    } catch (e) { return null; }
  }

  async function refresh() {
    if (inFlight) return;
    var client = getClient();
    if (!client) return; /* No live client: keep the demo. */
    var user = await getUser(client);
    if (!user) {
      /* Signed out: the launch gate owns this now — bounce home
         instead of restoring the demo. */
      gateBounce();
      return;
    }
    inFlight = true;
    try { await renderReal(client, user); renderedReal = true; }
    catch (e) { /* Keep demo content on any fetch failure. */ }
    inFlight = false;
  }

  /* ============================================================
     Dealer pages (v1.11): real business-profile storage.
     - The dashboard's "Business profile" section (profileBiz) is
       wired to the public.business_profiles table: Save upserts the
       signed-in advertiser's row (display name required), the logo
       file uploads to the existing public 'listing-photos' bucket
       at business-logos/<uid>/logo.<ext> on Save, and Preview
       navigates to the real seller.html page when a saved row
       exists — otherwise it renders a live preview modal from the
       form's current unsaved values (no database write).
     - The section is only un-hidden for advertisers (see renderReal
       below); private sellers never see it and can never create a
       row — the migration's trigger enforces advertiser-only.
     - Fails soft everywhere: if the migration hasn't run yet, or
       the user isn't signed in, Save/Preview toast and nothing
       breaks. No demo data is ever written.
     ============================================================ */
  var __cfBizLoaded = false;
  window.__cfBizUserId = null;

  function cfBizClient() {
    try {
      if (window.CFAuth && window.CFAuth.client) return window.CFAuth.client;
    } catch (e) {}
    return null;
  }

  function cfBizUid() {
    try {
      var c = cfBizClient();
      if (c && c.auth && typeof c.auth.getUser === 'function') {
        return c.auth.getUser().then(function (r) {
          return (r && r.data && r.data.user) ? r.data.user.id : null;
        });
      }
    } catch (e) {}
    return Promise.resolve(null);
  }

  function cfBizLoad() {
    /* Load the signed-in advertiser's row once per session, into
       the form — but never clobber a form the user is mid-edit on
       (a refresh re-render would wipe their typing). */
    if (__cfBizLoaded) return Promise.resolve();
    __cfBizLoaded = true;
    var client = cfBizClient();
    if (!client) return Promise.resolve();
    return cfBizUid().then(function (uid) {
      if (!uid) return;
      window.__cfBizUserId = uid;
      return client.from('business_profiles').select('*').eq('id', uid).maybeSingle()
        .then(function (res) {
          if (res.error || !res.data) return;
          var b = res.data;
          var set = function (id, v) {
            var el = document.getElementById(id);
            if (el && !el.value) el.value = v || '';
          };
          set('bpName', b.display_name);
          set('bpTag', b.tagline);
          set('bpWeb', b.website);
          set('bpPhone', b.business_phone);
          set('bpAddr', b.address);
          set('bpHours', b.hours);
          set('bpAbout', b.about);
          var img = document.getElementById('logoImg');
          var empty = document.getElementById('lzEmpty');
          if (b.logo_url && img) {
            img.src = b.logo_url;
            img.classList.remove('hidden');
            if (empty) empty.classList.add('hidden');
          }
        });
    }).catch(function () { /* fail soft: form stays blank, Save still works */ });
  }

  function cfBizSave() {
    var nameEl = document.getElementById('bpName');
    var name = nameEl ? nameEl.value.trim() : '';
    if (!name) {
      if (typeof toast === 'function') toast('Add a display name first');
      if (nameEl) nameEl.focus();
      return;
    }
    var client = cfBizClient();
    if (!client) {
      if (typeof toast === 'function') toast('Sign in as a business to save a profile');
      return;
    }
    var btn = document.getElementById('bpSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    var done = function (msg) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save profile'; }
      if (typeof toast === 'function') toast(msg);
    };
    cfBizUid().then(function (uid) {
      if (!uid) { done('Sign in as a business to save a profile'); return; }
      window.__cfBizUserId = uid;
      var web = (document.getElementById('bpWeb') || {}).value || '';
      web = web.trim();
      /* Bare domains get https:// — the migration's CHECK requires
         a scheme, and buyers expect a clickable link. */
      if (web && !/^https?:\/\//i.test(web)) web = 'https://' + web;
      var row = {
        id: uid,
        display_name: name,
        tagline: ((document.getElementById('bpTag') || {}).value || '').trim() || null,
        website: web || null,
        business_phone: ((document.getElementById('bpPhone') || {}).value || '').trim() || null,
        address: ((document.getElementById('bpAddr') || {}).value || '').trim() || null,
        hours: ((document.getElementById('bpHours') || {}).value || '').trim() || null,
        about: ((document.getElementById('bpAbout') || {}).value || '').trim() || null
      };
      var fileInput = document.getElementById('logoInput');
      var file = fileInput && fileInput.files ? fileInput.files[0] : null;
      var uploadLogo = Promise.resolve(null);
      if (file) {
        var ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
        var path = 'business-logos/' + uid + '/logo.' + ext;
        uploadLogo = client.storage.from('listing-photos').upload(path, file, { upsert: true })
          .then(function (up) {
            if (up.error) throw up.error;
            return client.storage.from('listing-photos').getPublicUrl(path).data.publicUrl;
          });
      }
      return uploadLogo.then(function (logoUrl) {
        if (logoUrl) row.logo_url = logoUrl;
        return client.from('business_profiles').upsert(row, { onConflict: 'id' });
      }).then(function (res) {
        if (res.error) throw res.error;
        done('Business profile saved');
      }).catch(function (err) {
        done('Could not save profile: ' + (err && err.message ? err.message : 'unknown error'));
      });
    }).catch(function () { done('Could not save profile — try again'); });
  }

  function cfBizEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Same bare-domain rule as Save: trim, prefix https:// when no
     scheme is present. The result always starts with http(s), so
     it is safe to render as a link; anything else yields null. */
  function cfBizWebLink() {
    var el = document.getElementById('bpWeb');
    var web = el ? el.value.trim() : '';
    if (!web) return null;
    if (!/^https?:\/\//i.test(web)) web = 'https://' + web;
    return web;
  }

  function cfBizLivePreview() {
    /* Unsaved-form preview: renders ONLY what the seller typed
       (plus the picked logo — the logo-pick preview image, data URL
       or saved URL) into the dashboard modal. Writes NOTHING to
       the database, so it works before the first Save. */
    var val = function (id) {
      var el = document.getElementById(id);
      return el ? el.value.trim() : '';
    };
    var name = val('bpName') || 'Your business';
    var tag = val('bpTag');
    var web = cfBizWebLink();
    var phone = val('bpPhone'), addr = val('bpAddr'), hours = val('bpHours');
    var about = val('bpAbout');
    var logoHtml = '&#127978;';
    try {
      var img = document.getElementById('logoImg');
      if (img && !img.classList.contains('hidden') && img.src &&
          /^(data:image\/|https?:\/\/)/i.test(img.src)) {
        logoHtml = '<img src="' + cfBizEsc(img.src) + '" alt="">';
      }
    } catch (e) {}
    var info = [];
    if (web) info.push('<b>Web:</b> <a href="' + cfBizEsc(web) + '" target="_blank" rel="noopener">' + cfBizEsc(web) + '</a>');
    if (phone) info.push('<b>Phone:</b> ' + cfBizEsc(phone));
    if (addr) info.push('<b>Address:</b> ' + cfBizEsc(addr));
    if (hours) info.push('<b>Hours:</b> ' + cfBizEsc(hours));
    var body = document.getElementById('bpvBody');
    if (!body) return;
    body.innerHTML =
      '<div class="pvbanner">Preview &mdash; this is how buyers will see it. Hit Save to publish.</div>' +
      '<div class="pvhead"><div class="plogo">' + logoHtml + '</div><div><div class="pn">' + cfBizEsc(name) + '</div>' +
      (tag ? '<div class="pt">' + cfBizEsc(tag) + '</div>' : '') + '</div></div>' +
      (info.length ? '<div class="pvinfo">' + info.join('<br>') + '</div>' : '') +
      (about ? '<p style="font-size:14px;line-height:1.65;white-space:pre-line">' + cfBizEsc(about) + '</p>' : '') +
      '<p style="font-size:13.5px;color:var(--mu)">Your live listings will appear here on the real page.</p>';
    try {
      if (typeof openM === 'function') openM('mBizPreview');
      else document.getElementById('mBizPreview').classList.add('on');
    } catch (e) {}
  }

  function cfBizPreview() {
    /* Saved row? Navigate to the real public page. No row yet?
       Render the live preview from the form's unsaved values
       instead of the "doesn't exist yet" page. Never writes. */
    var client = cfBizClient();
    var check = function (uid) {
      if (!uid) {
        if (typeof toast === 'function') toast('Sign in as a business to preview your page');
        return;
      }
      window.__cfBizUserId = uid;
      if (!client) { cfBizLivePreview(); return; }
      client.from('business_profiles').select('id').eq('id', uid).maybeSingle()
        .then(function (res) {
          if (res && res.data) location.href = 'seller.html?id=' + encodeURIComponent(uid);
          else cfBizLivePreview();
        })
        .catch(function () { cfBizLivePreview(); });
    };
    /* The cached id alone doesn't prove a row exists (a seller can
       be signed in without ever saving), so always check the row. */
    if (window.__cfBizUserId) { check(window.__cfBizUserId); return; }
    cfBizUid().then(check);
  }

  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'bpSaveBtn') { e.preventDefault(); cfBizSave(); }
    if (e.target && e.target.id === 'bpPreviewBtn') { e.preventDefault(); cfBizPreview(); }
    if (e.target && e.target.id === 'bpvSaveBtn') {
      e.preventDefault();
      try {
        if (typeof closeM === 'function') closeM('mBizPreview');
        else document.getElementById('mBizPreview').classList.remove('on');
      } catch (err) {}
      cfBizSave();
    }
  });

  async function renderReal(client, user) {
    /* Profile (may be missing: the sign-in upsert bug means brand-new
       users can lack a row until Martin adds one manually). */
    var profile = null;
    try {
      var pr = await client.from('profiles').select('display_name,role,is_admin').eq('id', user.id).maybeSingle();
      if (pr && pr.data) profile = pr.data;
    } catch (e) {}
    var displayName = (profile && profile.display_name) || (user.email || '').split('@')[0] || 'Seller';
    var role = (profile && profile.role === 'advertiser') ? 'advertiser' : 'private';
    var isAdmin = !!(profile && profile.is_admin);

    /* Own listings, own orders, own boosts, real threads — four
       independent reads. */
    var listings = [], orders = [], threads = [], myBoosts = [];
    try {
      var lr = await client.from('listings')
        .select('id,title,price,category,condition,location,status,created_at,photo_url,rejection_reason,specs')
        .eq('seller_id', user.id).order('created_at', { ascending: false }).limit(100);
      /* Fail-soft: if the reject-reason SQL has not run yet, the
         column does not exist and this select errors — retry
         without it so My ads still loads, just without reasons. */
      if (lr && lr.error) {
        lr = await client.from('listings')
          .select('id,title,price,category,condition,location,status,created_at,photo_url')
          .eq('seller_id', user.id).order('created_at', { ascending: false }).limit(100);
      }
      if (lr && lr.data) listings = lr.data;
    } catch (e) {}
    try {
      var orr = await client.from('orders')
        .select('id,order_number,business_name,package,amount,buyer_name,buyer_email,status,expires_at,created_at,term')
        .eq('buyer_id', user.id).order('created_at', { ascending: false }).limit(50);
      if (orr && orr.data) orders = orr.data;
    } catch (e) {}
    /* Step 5 Boost: own boosts (RLS: buyer_id = auth.uid()). If the
       step-5 SQL has not run yet this returns [] and the boosts
       section says so — same fail-soft pattern as the other reads. */
    try {
      var br = await client.from('boosts')
        .select('id,listing_id,amount,payment_method,status,payment_ref,expires_at,activated_at,created_at')
        .eq('buyer_id', user.id).order('created_at', { ascending: false }).limit(50);
      if (br && br.data) myBoosts = br.data;
    } catch (e) {}
    /* Cars fields v1: history-report requests on MY ads (seller
       read via RLS). Fail-soft: the table exists only after the
       Cars migration is pasted — an error just means no block. */
    var rrByListing = {};
    try {
      var rrq = await client.from('report_requests')
        .select('id,listing_id,buyer_name,buyer_email,note,status,created_at')
        .eq('seller_id', user.id).order('created_at', { ascending: false }).limit(100);
      if (rrq && !rrq.error && rrq.data) rrq.data.forEach(function (q) {
        (rrByListing[q.listing_id] = rrByListing[q.listing_id] || []).push(q);
      });
    } catch (e) {}
    /* Homes v1: viewing requests on MY ads (seller read via RLS).
       Fail-soft: the table exists only after the Homes migration. */
    var vwByListing = {};
    try {
      var vwq = await client.from('viewing_requests')
        .select('id,listing_id,buyer_name,buyer_email,buyer_phone,preferred_date,preferred_time,note,status,created_at')
        .eq('seller_id', user.id).order('created_at', { ascending: false }).limit(100);
      if (vwq && !vwq.error && vwq.data) vwq.data.forEach(function (q) {
        (vwByListing[q.listing_id] = vwByListing[q.listing_id] || []).push(q);
      });
    } catch (e) {}
    try {
      if (window.CFMessages && window.CFMessages.listThreads) {
        var th = await window.CFMessages.listThreads();
        if (th) threads = th;
      }
    } catch (e) {}

    /* Business stats (v1.4): per-ad views/clicks via the
       get_my_listing_stats RPC (ownership enforced inside the
       function) + message counts from the messages table (RLS
       already limits rows to threads this seller is party to).
       Best-effort throughout: a failed fetch leaves zeroes and
       never blocks the dashboard. Stats start at this deploy —
       older traffic was never recorded, so early counts are low
       by design, not by error. */
    var statsByListing = {};
    var msgCountByListing = {};
    try {
      var st = await client.rpc('get_my_listing_stats');
      (st.data || []).forEach(function (r) { statsByListing[r.listing_id] = r; });
    } catch (e) {}
    try {
      var ids = listings.map(function (l) { return l.id; });
      if (ids.length) {
        var mq = await client.from('messages').select('listing_id').in('listing_id', ids);
        (mq.data || []).forEach(function (m) { msgCountByListing[m.listing_id] = (msgCountByListing[m.listing_id] || 0) + 1; });
      }
    } catch (e2) {}
    function statsLine(id) {
      var s = statsByListing[id] || {};
      var v = s.impressions || 0, c = s.clicks || 0, m = msgCountByListing[id] || 0;
      return v + ' views · ' + c + ' clicks · ' + m + ' messages';
    }

    var nActive = listings.filter(function (x) { return x.status === 'active'; }).length;
    var nPending = listings.filter(function (x) { return x.status === 'pending'; }).length;
    var nUnread = threads.filter(function (t) { return t.unread; }).length;

    /* Header + demo banner become the signed-in identity. */
    var who = el('whoName'); if (who) who.textContent = displayName + (role === 'advertiser' ? ' · Advertiser' : ' · Seller');
    var demobar = document.querySelector('.demobar');
    if (demobar) demobar.innerHTML = 'Signed in as <b>' + esc(user.email || displayName) + '</b>' + (isAdmin ? ' · <b>Admin</b>' : '');
    var dashTitle = el('dashTitle'); if (dashTitle) dashTitle.textContent = role === 'advertiser' ? 'Advertiser dashboard' : 'My listings';
    var dashSub = el('dashSub');
    if (dashSub) dashSub.textContent = nActive + ' active · ' + nPending + ' pending approval · Mississauga, ON';
    /* Admins get the founder view (Oct 31, Martin): the top of the
       dashboard becomes a Site overview — live site totals and the
       queues waiting on him — instead of his personal numbers.
       His own ads/orders/boosts still live in the tabs below. */
    if (isAdmin) {
      if (dashTitle) dashTitle.textContent = 'Site overview';
      if (dashSub) dashSub.textContent = 'Live ClassiFlip totals — admin only, never shown to the public.';
    }

    /* Demo-only sections go away for signed-in users (their content is
       hardcoded demo data — showing it for a real account would be fake). */
    ['statsBiz', 'planBiz', 'upgradeSeller', 'listBiz', 'profileBiz'].forEach(function (id) {
      var n = el(id); if (n) n.classList.add('hidden');
    });
    /* Dealer pages (v1.11): the Business profile section is real
       now (wired to business_profiles), so advertisers get it back
       — with their saved row loaded. Private sellers never see it:
       the section stays hidden for them, and the migration's
       trigger would refuse their row anyway. */
    if (role === 'advertiser') {
      var pb = el('profileBiz');
      if (pb) pb.classList.remove('hidden');
      var dtb = el('dtabBiz');
      if (dtb) dtb.hidden = false;
      window.__cfBizUserId = user.id;
      cfBizLoad();
    }
    var statsSeller = el('statsSeller');
    if (statsSeller) {
      statsSeller.classList.remove('hidden');
      if (isAdmin) {
        /* Site overview strip (admin only): total users, total ads,
           pending ads, pending packages. renderAdmin fills the
           numbers with exact count queries. The two pending cards
           are buttons — tap one and it opens the matching Admin
           tab below, so a waiting queue is one tap from handled. */
        statsSeller.innerHTML =
          '<div class="stat"><div class="n" id="ovUsers">…</div><div class="l">Total users</div></div>' +
          '<div class="stat"><div class="n" id="ovAds">…</div><div class="l">Total ads</div></div>' +
          '<div class="stat" data-cf-ovgo="approvals" style="cursor:pointer"><div class="n" id="ovPendingAds">…</div><div class="l">Pending ads · tap to review</div></div>' +
          '<div class="stat" data-cf-ovgo="orders" style="cursor:pointer"><div class="n" id="ovPendingOrders">…</div><div class="l">Pending packages · tap to activate</div></div>' +
          '<div class="stat"><div class="n" id="ovWaitlist">…</div><div class="l" id="ovWaitlistLabel">Waitlist signups</div></div>' +
          '<div class="stat" data-cf-ovgo="reports" style="cursor:pointer"><div class="n" id="ovReported">…</div><div class="l">Reported ads · tap to view</div></div>' +
          '<div class=\"stat\" data-cf-ovgo=\"boosts\" style=\"cursor:pointer\"><div class=\"n\" id=\"ovPendingBoosts\">…</div><div class=\"l\">Pending boosts · tap to activate</div></div>';
      } else {
        statsSeller.innerHTML =
          '<div class="stat"><div class="n">' + nActive + '</div><div class="l">Active listings</div></div>' +
          '<div class="stat"><div class="n">' + nPending + '</div><div class="l">Pending approval</div></div>' +
          '<div class="stat' + (nUnread ? ' hot' : '') + '"><div class="n">' + nUnread + '</div><div class="l">Unread messages</div></div>' +
          '<div class="stat"><div class="n">' + orders.length + '</div><div class="l">My orders</div></div>';
      }
    }

    /* Personal tab badges: ads total, unread messages, orders
       total, live boosts — the at-a-glance counts on the tab bar. */
    setTabBadge('dtabNAds', listings.length, false);
    setTabBadge('dtabNMsg', nUnread, false);
    setTabBadge('dtabNOrders', orders.length, false);
    setTabBadge('dtabNBoosts', myBoosts.filter(function (b) { return b.status === 'Active'; }).length, false);

    /* Real listing cards (ad manager v1.3): List/Grid toggle above the
       list; Edit is real (title/price/description/location/photos,
       back to pending on save); Delete is real; View links to the
       marketplace.
       Step 5 Boost: a Boost button on ACTIVE rows only, plus a
       "Boosted until" pill when the ad has a live boost (an Active
       boosts row with expires_at in the future — the latest expiry
       wins, because re-boost extends). Nov 5 (Martin's catch): while
       a boost is live the Boost button is NOT rendered at all — a
       boosted ad wearing a live "Boost · $2.99" button invites an
       accidental second purchase. The pill carries the state; the
       button returns on its own once the boost expires. */
    var liveBoostByListing = {};
    (function () {
      var nowMs = Date.now();
      myBoosts.forEach(function (b) {
        if (b.status !== 'Active' || !b.expires_at) return;
        var ms = new Date(b.expires_at).getTime();
        if (ms > nowMs && (!liveBoostByListing[b.listing_id] || ms > liveBoostByListing[b.listing_id])) liveBoostByListing[b.listing_id] = ms;
      });
    })();
    var listSeller = el('listSeller');
    if (listSeller) {
      listSeller.classList.remove('hidden');
      if (!listings.length) {
        listSeller.innerHTML = '<div class="notice">No ads yet — post one with the Post button above and it will show up here once approved.</div>';
      } else {
        var viewBar = '<div class="adviewbar"><span class="lbl">My ads</span>' +
          '<button class="btn gho' + (dashView === 'list' ? ' on' : '') + '" data-cf-view="list">List</button>' +
          '<button class="btn gho' + (dashView === 'grid' ? ' on' : '') + '" data-cf-view="grid">Grid</button></div>';
        var cardsHtml = listings.map(function (x) {
          var viewBtn = x.status === 'active'
            ? '<a class="btn gho" href="index.html?ad=' + esc(x.id) + '">View</a>'
            : '<span class="btn gho" style="opacity:.55">' + (x.status === 'pending' ? 'Awaiting approval' : esc(x.status)) + '</span>';
          var boostPill = liveBoostByListing[x.id]
            ? ' <span class="pill boost"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:1em;height:1em;vertical-align:-0.15em"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg> Boosted until ' + fullDate(new Date(liveBoostByListing[x.id]).toISOString()) + '</span>' : '';
          var boostBtn = (x.status === 'active' && !liveBoostByListing[x.id])
            ? '<button class="btn pri" data-cf-boost="' + esc(x.id) + '" data-cf-boost-title="' + esc(x.title) + '">Boost · $2.99</button>' : '';
          var editBtn = (x.status === 'active' || x.status === 'pending' || x.status === 'rejected')
            ? '<button class="btn gho" data-cf-edit="' + esc(x.id) + '">Edit</button>' : '';
          var delBtn = '<button class="btn gho danger" data-cf-del="' + esc(x.id) + '">Delete</button>';
          /* Mark sold (Oct 29, Martin): a dealer/agent sells a car or
             a home, they tap Mark sold — status -> 'sold', ad leaves
             the public grid (public fetch is active-only), the card
             wears the existing Sold pill, and the slot frees up for
             a replacement (quota counts active+pending only, see
             cf-listings.js). No admin approval needed: owners may
             mark sold/hidden under the step-4 RLS policy, and the
             self-approve trigger only blocks transitions INTO
             'active'. Two-tap, same pattern as Delete, so a stray
             tap can't sell a live ad. Active ads only — sold ads
             already lost Edit/Boost/View by the existing gates. */
          var soldBtn = x.status === 'active'
            ? '<button class="btn gho" data-cf-sold="' + esc(x.id) + '">Mark sold</button>' : '';
          /* Rejected red-box alert (Oct 29, Martin's call): a rejected
             ad must be impossible to miss, so the seller sees what
             to fix. Same box in list + grid — rejNote is shared.
             Package guidance (Oct 29, best-solution build): a
             wrong-category rejection into a PAID family must tell
             the seller to get the package first, then post new —
             category stays locked in the editor, so no reclassify
             dodge around the package gate. */
          var rejReason = x.rejection_reason || '';
          var rejPkgLine = /Services/.test(rejReason)
            ? '<br>Posting as a business? <a href="advertise.html" style="color:#7f1d1d;font-weight:700;text-decoration:underline">Get a services package</a>, then post a new ad under Services.' : '';
          var rejNote = (x.status === 'rejected')
            ? '<div style="margin:8px 0;padding:10px 12px;border:1px solid #e5484d;border-radius:10px;background:#fdecea;color:#7f1d1d;font-size:14px;line-height:1.4"><strong>Rejected — fix this:</strong> ' + esc(rejReason || 'Rejected by admin.') + rejPkgLine + '</div>' : '';
          var rrList = rrByListing[x.id] || [];
          var rrOpen = rrList.filter(function (q) { return q.status === 'open'; });
          var rrNote = rrOpen.length
            ? '<div style="margin:8px 0;padding:10px 12px;border:1px solid #f5d67a;border-radius:10px;background:#fef7e0;font-size:13.5px;line-height:1.5"><strong>\uD83D\uDCC4 History report requests (' + rrOpen.length + '):</strong>' + rrOpen.map(function (q) {
                return '<br>' + esc(q.buyer_name || '') + ' \u2014 <a href="mailto:' + esc(q.buyer_email || '') + '">' + esc(q.buyer_email || '') + '</a>' + (q.note ? ' \u00b7 \u201c' + esc(q.note) + '\u201d' : '');
              }).join('') + '<br><span style="color:var(--mu)">Email the buyer the report from your own email app.</span></div>' : '';
          var vwList = vwByListing[x.id] || [];
          var vwOpen = vwList.filter(function (q) { return q.status === 'open'; });
          var vwNote = vwOpen.length
            ? '<div style="margin:8px 0;padding:10px 12px;border:1px solid #a7d7a7;border-radius:10px;background:#edf7ed;font-size:13.5px;line-height:1.5"><strong>\uD83C\uDFE0 Viewing requests (' + vwOpen.length + '):</strong>' + vwOpen.map(function (q) {
                return '<br>' + esc(q.buyer_name || '') + ' \u2014 <a href="mailto:' + esc(q.buyer_email || '') + '">' + esc(q.buyer_email || '') + '</a>' + (q.buyer_phone ? ' \u00b7 ' + esc(q.buyer_phone) : '') + (q.preferred_date ? ' \u00b7 prefers ' + esc(q.preferred_date) + (q.preferred_time ? ' (' + esc(q.preferred_time) + ')' : '') : '') + (q.note ? ' \u00b7 \u201c' + esc(q.note) + '\u201d' : '');
              }).join('') + '<br><span style="color:var(--mu)">Email the buyer to arrange the viewing.</span></div>' : '';
          if (dashView === 'grid') {
            return '<div class="gtile"><div class="gph">' +
              (x.photo_url ? '<img src="' + esc(x.photo_url) + '" alt="">' : '<svg width="34" height="34" style="width:34px;height:34px" viewBox="0 0 24 24" fill="none" stroke="#16365f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>') + '</div>' +
              '<div class="gb"><div class="t">' + esc(x.title) + ' ' + pillFor(x.status) + boostPill + '</div>' +
              '<div class="p">' + money(x.price) + '</div>' +
              '<div class="s">' + esc(x.category || '') + ' · ' + esc(x.location || '') + ' · ' + shortDate(x.created_at) + '</div>' +
              rejNote +
              rrNote + vwNote +
              '<div class="s">' + statsLine(x.id) + '</div>' +
              '<div class="acts">' + viewBtn + boostBtn + editBtn + soldBtn + delBtn + '</div></div></div>';
          }
          return '<div class="lcard">' +
            (x.photo_url ? '<img src="' + esc(x.photo_url) + '" alt="">' : '<div class="ph"><svg width="34" height="34" style="width:34px;height:34px" viewBox="0 0 24 24" fill="none" stroke="#16365f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg></div>') +
            '<div class="inf"><div class="t">' + esc(x.title) + ' ' + pillFor(x.status) + boostPill + '</div>' +
            '<div class="p">' + money(x.price) + '</div>' +
            '<div class="s">' + esc(x.category || '') + ' · ' + esc(x.condition || '') + ' · ' + esc(x.location || '') + ' · posted ' + shortDate(x.created_at) + '</div>' +
            rejNote +
            rrNote + vwNote +
            '<div class="s">' + statsLine(x.id) + '</div></div>' +
            '<div class="acts">' + viewBtn + boostBtn + editBtn + soldBtn + delBtn + '</div>' +
            '</div>';
        }).join('');
        listSeller.innerHTML = viewBar + (dashView === 'grid' ? '<div class="adgrid">' + cardsHtml + '</div>' : cardsHtml);
      }
    }

    /* Real message threads. */
    var msgSect = el('msgSect');
    if (msgSect) {
      var rows = '';
      if (!threads.length) {
        rows = '<div class="notice">No messages yet — when a buyer messages you about an ad, the thread shows up here.</div>';
      } else {
        rows = threads.map(function (t) {
          var initial = (t.name || 'S').charAt(0).toUpperCase();
          return '<div class="msgrow" onclick="location.href=\'messaging.html?thread=\'+encodeURIComponent(\'' + esc(t.id) + '\')" style="cursor:pointer"><div class="av">' + esc(initial) + '</div>' +
            '<div class="b"><div class="u">' + esc(t.name || 'Seller') + '</div>' +
            '<div class="x">' + esc(t.ad || '') + (t.lastBody ? ' — ' + esc(t.lastBody) : '') + '</div></div>' +
            '<div class="t">' + esc(t.time || '') + '</div>' + (t.unread ? '<div class="unread"></div>' : '') + '</div>';
        }).join('');
      }
      msgSect.innerHTML = '<h2>Messages</h2>' + rows +
        '<button class="btn gho" style="width:100%;margin-top:8px" onclick="location.href=\'messaging.html\'">Open all messages</button>';
    }

    /* My orders (own rows only — RLS guarantees this). */
    var ordersSect = el('ordersSect');
    if (ordersSect) {
      ordersSect.classList.remove('hidden');
      var ol = el('ordersList');
      if (ol) {
        if (!orders.length) {
          ol.innerHTML = '<div class="notice">No orders yet — pick a package on the Advertise page and reserve it with Interac e-Transfer.</div>';
        } else {
          ol.innerHTML = orders.map(function (o) {
            var oDel = o.status === 'Pending'
              ? '<div class="acts"><button class="btn gho danger" data-cf-order-del="' + esc(o.id) + '">Delete</button></div>'
              : '';
            return '<div class="lcard"><div class="inf"><div class="t">' + esc(o.order_number) + ' · ' + esc(o.package || '') + ' ' + pillForOrder(o.status) + '</div>' +
              '<div class="p">' + money(o.amount) + '</div>' +
              '<div class="s">' + esc(o.business_name || '') + ' · ordered ' + fullDate(o.created_at) +
              (o.expires_at ? ' · expires ' + fullDate(o.expires_at) : '') + orderTermSuffix(o) + '</div></div>' + oDel + '</div>';
          }).join('');
        }
      }
    }

    /* My boosts (own rows only — RLS guarantees this). Boost amounts
       are NOT run through money(): it rounds to whole dollars and a
       boost is $2.99, so the exact $2.99 is formatted directly. */
    var boostsSect = el('boostsSect');
    if (boostsSect) {
      boostsSect.classList.remove('hidden');
      var bl = el('boostsList');
      if (bl) {
        if (!myBoosts.length) {
          bl.innerHTML = '<div class="notice">No boosts yet — boost a live ad from My listings and it shows up here.</div>';
        } else {
          var titlesById = {};
          listings.forEach(function (x) { titlesById[x.id] = x.title; });
          bl.innerHTML = myBoosts.map(function (b) {
            var bDel = b.status === 'Pending'
              ? '<div class="acts"><button class="btn gho danger" data-cf-boost-del="' + esc(b.id) + '">Delete</button></div>'
              : '';
            return '<div class="lcard"><div class="inf"><div class="t">' + esc(b.payment_ref || 'Boost') + ' · ' + esc(titlesById[b.listing_id] || 'Ad') + ' ' + pillForOrder(b.status) + '</div>' +
              '<div class="p">$' + Number(b.amount).toFixed(2) + ' · ' + (b.payment_method === 'etransfer' ? 'Interac e-Transfer' : 'Card') + '</div>' +
              '<div class="s">reserved ' + fullDate(b.created_at) +
              (b.activated_at ? ' · activated ' + fullDate(b.activated_at) : '') +
              (b.expires_at ? ' · expires ' + fullDate(b.expires_at) : '') + '</div></div>' + bDel + '</div>';
          }).join('');
        }
      }
    }

    /* Post button goes straight into the marketplace post form
       (Nov 14, 2026 — Steve's catch: the old link landed sellers on
       the marketplace home and made them hunt for Post an ad; the
       ?post=1 deep link makes index open the form on arrival). */
    var postBtn = el('postBtn');
    if (postBtn) postBtn.onclick = function () { try { openRealPost(); } catch (e) { location.href = 'index.html?post=1'; } };

    /* Admin queue — only for is_admin users. */
    var adminSect = el('adminSect');
    if (adminSect && isAdmin) {
      adminSect.classList.remove('hidden');
      await renderAdmin(client);
    }
  }

  function pillForOrder(status) {
    var map = { Pending: 'pend', Active: 'live', 'Expiring soon': 'pend', Expired: 'pause' };
    return '<span class="pill ' + (map[status] || 'pause') + '">' + esc(status || '') + '</span>';
  }

  /* Founding lock-in (Nov 3, 2026): orders.term carries the buyer's
     chosen terms — founding reserves store 'founding-lock-12-monthly'.
     Anything else (or the column not migrated yet) renders nothing. */
  function orderTermSuffix(o) {
    return (o && o.term === 'founding-lock-12-monthly')
      ? ' · Founding Member: price locked 12 months · billed monthly · first month free'
      : '';
  }

  /* Admin -> Users roster (Oct 31, 2026): every account with its ad
     counts and current package, plus a permanent Delete that calls
     the cf-admin-delete-user Edge Function (admin is verified there
     and the service key never reaches the browser). Own account and
     other admins render WITHOUT a Delete button; the function
     refuses those deletes server-side too. Fails soft: any fetch
     error shows a hint in place of the roster. */
  async function renderAdminUsers(client) {
    var box = el('adminUsersList');
    if (!box) return;
    box.innerHTML = '<div class="notice">Loading users…</div>';
    var me = await getUser(client);
    var profiles = null;
    try {
      var pr = await client.from('profiles').select('id,display_name,email,role,is_admin,created_at').order('created_at', { ascending: false }).limit(500);
      if (pr.error) throw pr.error;
      profiles = pr.data || [];
    } catch (e1) {
      try {
        var pr2 = await client.from('profiles').select('id,display_name,email,role,is_admin').limit(500);
        profiles = (pr2 && pr2.data) || null;
      } catch (e2) { profiles = null; }
    }
    if (!profiles) { box.innerHTML = '<div class="notice">Users unavailable right now.</div>'; return; }
    if (!profiles.length) { box.innerHTML = '<div class="notice">No user accounts yet.</div>'; return; }

    /* Ad counts per seller, all statuses, one light query. */
    var counts = {};
    try {
      var lr = await client.from('listings').select('seller_id,status').limit(5000);
      (lr.data || []).forEach(function (r) {
        if (!r.seller_id) return;
        var c = counts[r.seller_id] || (counts[r.seller_id] = { total: 0, live: 0, pending: 0, sold: 0 });
        c.total++;
        if (r.status === 'active') c.live++;
        else if (r.status === 'pending') c.pending++;
        else if (r.status === 'sold') c.sold++;
      });
    } catch (e) {}

    /* Current package per buyer: best status wins (Active >
       Expiring soon > Pending > Expired); latest date breaks ties. */
    var rank = { Active: 0, 'Expiring soon': 1, Pending: 2, Expired: 3 };
    var pkgBy = {}, pkgCount = {};
    try {
      var or2 = await client.from('orders').select('buyer_id,package,status,expires_at,created_at').not('buyer_id', 'is', null).limit(1000);
      (or2.data || []).forEach(function (o) {
        if (!o.buyer_id) return;
        pkgCount[o.buyer_id] = (pkgCount[o.buyer_id] || 0) + 1;
        var cur = pkgBy[o.buyer_id];
        if (!cur) { pkgBy[o.buyer_id] = o; return; }
        var ro = (rank[o.status] != null ? rank[o.status] : 9), rc = (rank[cur.status] != null ? rank[cur.status] : 9);
        if (ro < rc || (ro === rc && String(o.expires_at || o.created_at || '') > String(cur.expires_at || cur.created_at || ''))) pkgBy[o.buyer_id] = o;
      });
    } catch (e) {}

    box.innerHTML = profiles.map(function (p) {
      var c = counts[p.id] || { total: 0, live: 0, pending: 0, sold: 0 };
      var pk = pkgBy[p.id];
      var pkgLine = pk
        ? esc(pk.package || 'Package') + ' ' + pillForOrder(pk.status) + (pk.expires_at ? ' · expires ' + fullDate(pk.expires_at) : '') + ((pkgCount[p.id] || 0) > 1 ? ' · +' + (pkgCount[p.id] - 1) + ' more' : '')
        : 'No package';
      var isSelf = !!(me && me.id === p.id);
      var delBtn = (isSelf || p.is_admin)
        ? ''
        : '<div class="acts"><button class="btn gho danger" data-cf-user-del="' + esc(p.id) + '">Delete</button></div>';
      return '<div class="lcard"><div class="inf"><div class="t">' + esc(p.display_name || p.email || p.id) +
        ' <span class="pill ' + (p.role === 'advertiser' ? 'live' : 'pause') + '">' + esc(p.role === 'advertiser' ? 'Advertiser' : 'Private') + '</span>' +
        (p.is_admin ? ' <span class="pill pend">Admin</span>' : '') + (isSelf ? ' <span class="pill pend">You</span>' : '') + '</div>' +
        '<div class="s">' + esc(p.email || '') + (p.created_at ? ' · joined ' + fullDate(p.created_at) : '') + '</div>' +
        '<div class="s">Ads: <b>' + c.total + '</b> posted · ' + c.live + ' live · ' + c.pending + ' pending · ' + c.sold + ' sold</div>' +
        '<div class="s">Package: ' + pkgLine + '</div></div>' + delBtn + '</div>';
    }).join('');
  }

  /* Reported ads (Oct 31, 2026): open reports grouped by ad, with
     who reported it, why, and when. Martin's ruling: a report only
     flags; at 3 open reports from different users the database
     trigger auto-pauses the ad (status 'hidden'). From here the
     admin restores (ad live again + reports closed as actioned),
     dismisses (reports closed, ad untouched), or deletes the ad
     (the existing two-tap handler; its reports cascade away).
     Needs supabase/cf-reports-migration.sql — until it runs, this
     reads as unavailable and the tab badge stays empty. */
  async function renderAdminReports(client) {
    var box = el('adminReportsList');
    if (!box) return;
    box.innerHTML = '<div class="notice">Loading reports…</div>';
    var reps = [];
    try {
      var rr = await client.from('listing_reports')
        .select('id,listing_id,reporter_id,reason,details,created_at')
        .eq('status', 'open').order('created_at', { ascending: false }).limit(200);
      if (rr && rr.data) reps = rr.data;
      if (rr && rr.error) throw rr.error;
    } catch (e) {
      box.innerHTML = '<div class="notice">Reports unavailable — run supabase/cf-reports-migration.sql in the SQL Editor first.</div>';
      setTabBadge('atabNReports', 0, false);
      return;
    }
    if (!reps.length) {
      box.innerHTML = '<div class="notice">No open reports. Clean streets.</div>';
      setTabBadge('atabNReports', 0, false);
      return;
    }
    var byListing = {}, order = [];
    reps.forEach(function (r) {
      if (!byListing[r.listing_id]) { byListing[r.listing_id] = []; order.push(r.listing_id); }
      byListing[r.listing_id].push(r);
    });
    setTabBadge('atabNReports', order.length, false);
    var adsById = {}, usersById = {};
    try {
      var ar = await client.from('listings').select('id,title,price,status,seller_id').in('id', order);
      (ar.data || []).forEach(function (a) { adsById[a.id] = a; });
      var uids = reps.map(function (r) { return r.reporter_id; }).filter(Boolean);
      if (uids.length) {
        var ur = await client.from('profiles').select('id,display_name,email').in('id', uids);
        (ur.data || []).forEach(function (u) { usersById[u.id] = u; });
      }
    } catch (e) {}
    box.innerHTML = order.map(function (lid) {
      var a = adsById[lid] || {};
      var list = byListing[lid];
      var lines = list.map(function (r) {
        var u = usersById[r.reporter_id] || {};
        return '<div class="s">' + esc(r.reason || 'Other') + ' — ' + esc(u.display_name || u.email || 'user') + ' · ' + shortDate(r.created_at) +
          (r.details ? '<br>' + esc(r.details) : '') + '</div>';
      }).join('');
      var paused = a.status === 'hidden';
      return '<div class="lcard"><div class="inf"><div class="t">' + esc(a.title || 'Ad') + ' ' + (a.status ? pillFor(a.status) : '') +
        ' <span class="pill rej">' + list.length + ' report' + (list.length === 1 ? '' : 's') + '</span></div>' +
        '<div class="p">' + (typeof a.price === 'number' ? money(a.price) : '') + (paused ? ' · auto-paused at 3 reports' : '') + '</div>' + lines + '</div>' +
        '<div class="acts">' +
        (paused ? '<button class="btn pri" data-cf-report-restore="' + esc(lid) + '">Restore ad</button>' : '') +
        '<button class="btn gho" data-cf-report-dismiss="' + esc(lid) + '">Dismiss reports</button>' +
        '<button class="btn gho danger" data-cf-del="' + esc(lid) + '">Delete ad</button></div></div>';
    }).join('');
  }

  /* Report actions: restore (ad back live + reports closed as
     actioned) and dismiss (reports closed, ad untouched). Delete
     reuses the existing two-tap data-cf-del handler. */
  document.addEventListener('click', async function (e) {
    var rs = e.target && e.target.closest ? e.target.closest('[data-cf-report-restore]') : null;
    var ds = e.target && e.target.closest ? e.target.closest('[data-cf-report-dismiss]') : null;
    if (!rs && !ds) return;
    var client = getClient();
    if (!client) return;
    var lid = (rs || ds).dataset.cfReportRestore || (rs || ds).dataset.cfReportDismiss;
    try {
      if (rs) {
        var up = await client.from('listings').update({ status: 'active' }).eq('id', lid);
        if (up.error) throw up.error;
        var cl = await client.from('listing_reports').update({ status: 'actioned' }).eq('listing_id', lid).eq('status', 'open');
        if (cl.error) throw cl.error;
        try { if (typeof toast === 'function') toast('Ad restored — live again, reports closed'); } catch (e2) {}
      } else {
        var cl2 = await client.from('listing_reports').update({ status: 'dismissed' }).eq('listing_id', lid).eq('status', 'open');
        if (cl2.error) throw cl2.error;
        try { if (typeof toast === 'function') toast('Reports dismissed — ad left as-is'); } catch (e3) {}
      }
      refresh();
    } catch (err) {
      try { if (typeof toast === 'function') toast('Report action failed: ' + (err.message || err)); } catch (e4) {}
    }
  });


  /* ================================================================
     CARS FIELDS v1 (Nov 11, 2026) — dashboard side. Spec:
     ClassiFlip_Cars_Fields_Spec.md. The admin approval queue shows
     the spec groups READ-ONLY (the admin MAY see the VIN — spec
     1.4: owner + admin only). The editor (dashboard.html modal)
     gets an injected Car details block for Cars ads: prefilled,
     re-validated, saved into listings.specs with the same
     omit-and-warn fallback as the post path. Report requests are
     visible to the seller on their own ads (renderReal) and to the
     admin below; v1 has NO email notification (the Resend notify
     functions are not deployed yet) — in-app visibility only.
     ================================================================ */
  var CAR_LABELS_D = {
    body_type: { sedan: 'Sedan', coupe: 'Coupe', hatchback: 'Hatchback', wagon: 'Wagon', suv: 'SUV', crossover: 'Crossover', truck: 'Pickup truck', van: 'Van', minivan: 'Minivan', convertible: 'Convertible', other: 'Other' },
    vehicle_type: { used: 'Used', new: 'New', certified: 'Certified pre-owned' },
    transmission: { automatic: 'Automatic', manual: 'Manual', cvt: 'CVT', single: 'Single-speed (EV)', unknown: 'Don\'t know' },
    drivetrain: { fwd: 'FWD', rwd: 'RWD', awd: 'AWD', '4x4': '4x4', unknown: 'Don\'t know' },
    fuel: { gas: 'Gasoline', diesel: 'Diesel', hybrid: 'Hybrid', phev: 'Plug-in hybrid', ev: 'Electric', other: 'Other' },
    accidents: { none: 'None reported', reported: 'Reported - ask the seller', unsure: 'Not sure' },
    warranty: { factory: 'Factory warranty remaining', dealer: 'Dealer warranty', none: 'No warranty / as-is' },
    availability: { now: 'Available now', soon: 'Arriving soon', ordered: 'On order' }
  };
  var CAR_KEYS_D = ['year', 'make', 'model', 'trim', 'body_type', 'km', 'vehicle_type', 'colour', 'seats', 'doors', 'availability', 'transmission', 'drivetrain', 'fuel', 'engine_l', 'cylinders', 'accidents', 'safety_certified', 'warranty', 'report_url', 'report_available', 'stock_number', 'vin'];
  function parseCarSpecs(v) {
    var o = null;
    if (v && typeof v === 'object') o = v;
    else if (typeof v === 'string' && v) { try { o = JSON.parse(v); } catch (e) { o = null; } }
    if (!o || typeof o !== 'object') return {};
    var out = {};
    CAR_KEYS_D.forEach(function (k) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = o[k]; });
    return out;
  }
  function carLabelD(group, slug) {
    var m = CAR_LABELS_D[group] || {};
    return m[slug] || String(slug == null ? '' : slug);
  }
  function validateCarSpecsD(sp) {
    if (!sp) return 'Car details are missing.';
    var maxYear = new Date().getFullYear() + 1;
    if (!sp.year || sp.year < 1930 || sp.year > maxYear) return 'Add the car\'s year (1930-' + maxYear + ') - required for Cars.';
    if (!sp.make) return 'Add the make - required for Cars.';
    if (!sp.model) return 'Add the model - required for Cars.';
    if (!sp.body_type) return 'Pick a body type - required for Cars.';
    if (sp.km == null || sp.km < 0 || sp.km > 2000000) return 'Add the kilometres (0-2,000,000) - required for Cars.';
    if (sp.engine_l != null && (sp.engine_l < 0.5 || sp.engine_l > 10)) return 'Engine size must be between 0.5 and 10.0 litres.';
    if (sp.seats != null && (sp.seats < 1 || sp.seats > 12)) return 'Seats must be between 1 and 12.';
    if (sp.doors != null && (sp.doors < 2 || sp.doors > 6)) return 'Doors must be between 2 and 6.';
    if (sp.vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(sp.vin)) return 'The VIN must be exactly 17 characters (I, O and Q are never used in a VIN).';
    if (sp.report_url && !/^https?:\/\//i.test(sp.report_url)) return 'The history report link must start with http:// or https://.';
    return '';
  }
  /* Read-only spec groups for the admin approval queue. VIN shows
     here (admin) — it is never rendered on public surfaces. */
  /* Compact one-line spec summaries for the pending queue (Nov 15,
     2026): the full spec sections made every Cars/Homes pending card
     a full screen tall — a scroll fest at 100 pending ads. The card
     now shows this summary; the admin opens the ad itself (View ad,
     ?listing= deep link) to review it exactly as users will see it. */
  function carSummaryLine(x) {
    var sp = parseCarSpecs(x && x.specs);
    if (!Object.keys(sp).length) return '';
    var parts = [];
    if (sp.year) parts.push(String(sp.year));
    var mm = [sp.make, sp.model].filter(Boolean).join(' ');
    if (mm) parts.push(mm + (sp.trim ? ' ' + sp.trim : ''));
    if (sp.body_type) parts.push(carLabelD('body_type', sp.body_type));
    if (sp.km != null && sp.km !== '') { var kv = Number(String(sp.km).replace(/[,\s]/g, '')); if (!isNaN(kv)) parts.push(kv.toLocaleString('en-CA') + ' km'); }
    if (sp.transmission) parts.push(carLabelD('transmission', sp.transmission));
    if (sp.fuel) parts.push(carLabelD('fuel', sp.fuel));
    if (!parts.length) return '';
    return '<div style="margin-top:6px;font-size:13px">' + esc(parts.join(' \u00b7 ')) + '</div>';
  }
  function homeSummaryLine(x) {
    var sp = parseHomeSpecs(x && x.specs);
    if (!Object.keys(sp).length) return '';
    var parts = [];
    if (sp.property_type) parts.push(homeLabelD('property_type', sp.property_type));
    if (sp.bedrooms != null && sp.bedrooms !== '') parts.push(sp.bedrooms + ' bd');
    if (sp.bathrooms != null && sp.bathrooms !== '') parts.push(sp.bathrooms + ' ba');
    if (sp.sqft) { var sv = Number(sp.sqft); if (!isNaN(sv)) parts.push(sv.toLocaleString('en-CA') + ' sq ft'); }
    if (sp.parking) parts.push(homeLabelD('parking', sp.parking));
    if (sp.available_date) parts.push('Avail. ' + sp.available_date);
    if (!parts.length) return '';
    return '<div style="margin-top:6px;font-size:13px">' + esc(parts.join(' \u00b7 ')) + '</div>';
  }
  function carSpecsAdminHtml(x) {
    var sp = parseCarSpecs(x && x.specs);
    if (!Object.keys(sp).length) return '';
    function grp(title, pairs) {
      var rows = pairs.filter(function (p) { return p; }).map(function (p) {
        return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:2px 0;border-bottom:1px dashed var(--line)"><span style="color:var(--mu)">' + esc(p[0]) + '</span><span style="font-weight:600;text-align:right">' + esc(p[1]) + '</span></div>';
      }).join('');
      if (!rows) return '';
      return '<div style="margin-top:8px"><div style="font-size:11.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--mu);margin-bottom:2px">' + esc(title) + '</div>' + rows + '</div>';
    }
    function kmFmt(n) { var v = Number(n); return isNaN(v) ? '' : v.toLocaleString('en-CA') + ' km'; }
    var mm = [sp.make, sp.model].filter(Boolean).join(' ');
    return '<div style="margin-top:8px;border:1px solid var(--line);border-radius:10px;padding:8px 10px">' +
      grp('The Basics', [
        sp.year ? ['Year', String(sp.year)] : null,
        mm ? ['Make & model', mm + (sp.trim ? ' ' + sp.trim : '')] : null,
        sp.body_type ? ['Body type', carLabelD('body_type', sp.body_type)] : null,
        (sp.km != null && sp.km !== '') ? ['Kilometres', kmFmt(sp.km)] : null,
        sp.vehicle_type ? ['Vehicle type', carLabelD('vehicle_type', sp.vehicle_type)] : null,
        sp.colour ? ['Colour', String(sp.colour)] : null,
        sp.seats ? ['Seats', String(sp.seats)] : null,
        sp.doors ? ['Doors', String(sp.doors)] : null,
        sp.availability ? ['Availability', carLabelD('availability', sp.availability)] : null
      ]) +
      grp('Running Gear', [
        sp.transmission ? ['Transmission', carLabelD('transmission', sp.transmission)] : null,
        sp.drivetrain ? ['Drivetrain', carLabelD('drivetrain', sp.drivetrain)] : null,
        sp.fuel ? ['Fuel', carLabelD('fuel', sp.fuel)] : null,
        sp.engine_l ? ['Engine', sp.engine_l + ' L'] : null,
        sp.cylinders ? ['Cylinders', sp.cylinders === 'none' ? 'None (electric)' : String(sp.cylinders)] : null
      ]) +
      grp('History & Honesty', [
        sp.accidents ? ['Accident history', carLabelD('accidents', sp.accidents)] : null,
        sp.safety_certified ? ['Safety certified', '\u2713 Certified (Ontario)'] : null,
        sp.warranty ? ['Warranty', carLabelD('warranty', sp.warranty)] : null,
        sp.report_url ? ['Report link', String(sp.report_url)] : null,
        sp.report_available ? ['Report on request', 'Yes'] : null
      ]) +
      grp('Dealer Desk (admin only)', [
        sp.stock_number ? ['Stock #', String(sp.stock_number)] : null,
        sp.vin ? ['VIN', String(sp.vin)] : null
      ]) +
      '</div>';
  }

  /* Admin: history report requests across all ads (newest first),
     with a Mark done action (admin UPDATE policy). Injected as a
     sibling panel under the approvals list — dashboard.html itself
     is unchanged. Fails soft to nothing before the migration. */
    /* ---- Homes & Rentals on the dashboard (Nov 11, 2026) ----
     Approval-queue fact groups (homeSpecsAdminHtml), the admin
     viewing-requests panel, and the seller's per-ad viewing box
     (loader + note live in renderReal, beside the report twins). */
  var HOME_KEYS_D = ['property_type', 'bedrooms', 'bathrooms', 'sqft', 'parking', 'laundry', 'lot_sqft', 'year_built', 'basement', 'heating', 'cooling', 'tour_url', 'taxes_annual', 'condo_fee_monthly', 'mls_number', 'available_date', 'lease_term', 'furnished', 'utilities_included', 'pets', 'viewings_ok'];
  function parseHomeSpecs(v) {
    var o = null;
    if (v && typeof v === 'object') o = v;
    else if (typeof v === 'string' && v) { try { o = JSON.parse(v); } catch (e) { o = null; } }
    if (!o || typeof o !== 'object') return {};
    var out = {};
    HOME_KEYS_D.forEach(function (k) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = o[k]; });
    return out;
  }
  var HOME_LABELS_D = {
    property_type: { detached: 'Detached house', semi: 'Semi-detached', townhouse: 'Townhouse', condo: 'Condo / Apartment', duplex: 'Duplex / Multi-unit', other: 'Other' },
    parking: { garage: 'Garage', driveway: 'Driveway', underground: 'Underground', street: 'Street', none: 'None' },
    laundry: { in_unit: 'In-unit', in_building: 'In building', none: 'None' },
    basement: { finished: 'Finished', partial: 'Partly finished', unfinished: 'Unfinished', none: 'None' },
    heating: { forced_air_gas: 'Forced air (natural gas)', electric: 'Electric / baseboard', radiant: 'Radiant / hot water', heat_pump: 'Heat pump', oil: 'Oil', other: 'Other' },
    cooling: { central: 'Central air', window: 'Window unit(s)', none: 'No A/C' },
    lease_term: { '12_plus': '12 months or longer', short: 'Short term (under 12 months)', month_to_month: 'Month-to-month', flexible: 'Flexible' },
    furnished: { unfurnished: 'Unfurnished', partly: 'Partly furnished', furnished: 'Furnished' },
    pets: { welcome: 'Pets welcome', cats: 'Cats only', dogs: 'Dogs only', no: 'No pets', ask: 'Ask the landlord' },
    utilities: { heat: 'Heat', water: 'Water', hydro: 'Hydro', internet: 'Internet', parking: 'Parking' }
  };
  function homeLabelD(group, slug) {
    if (!slug) return '';
    var m = HOME_LABELS_D[group];
    return (m && m[slug]) || String(slug);
  }
  function homeSpecsAdminHtml(x) {
    var sp = parseHomeSpecs(x && x.specs);
    if (!Object.keys(sp).length) return '';
    function grp(title, pairs) {
      var rows = pairs.filter(function (p) { return p; }).map(function (p) {
        return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:2px 0;border-bottom:1px dashed var(--line)"><span style="color:var(--mu)">' + esc(p[0]) + '</span><span style="font-weight:600;text-align:right">' + esc(p[1]) + '</span></div>';
      }).join('');
      if (!rows) return '';
      return '<div style="margin-top:8px"><div style="font-size:11.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--mu);margin-bottom:2px">' + esc(title) + '</div>' + rows + '</div>';
    }
    function numFmt(n) { var v = Number(n); return isNaN(v) ? '' : v.toLocaleString('en-CA'); }
    return '<div style="margin-top:8px;border:1px solid var(--line);border-radius:10px;padding:8px 10px">' +
      grp('The Basics', [
        sp.property_type ? ['Property type', homeLabelD('property_type', sp.property_type)] : null,
        (sp.bedrooms != null && sp.bedrooms !== '') ? ['Bedrooms', Number(sp.bedrooms) === 0 ? 'Bachelor / studio' : String(sp.bedrooms)] : null,
        (sp.bathrooms != null && sp.bathrooms !== '') ? ['Bathrooms', String(sp.bathrooms)] : null,
        sp.sqft ? ['Interior size', numFmt(sp.sqft) + ' sq ft'] : null,
        sp.parking ? ['Parking', homeLabelD('parking', sp.parking)] : null,
        sp.laundry ? ['Laundry', homeLabelD('laundry', sp.laundry)] : null
      ]) +
      grp('The Property', [
        sp.lot_sqft ? ['Lot size', numFmt(sp.lot_sqft) + ' sq ft'] : null,
        sp.year_built ? ['Year built', String(sp.year_built)] : null,
        sp.basement ? ['Basement', homeLabelD('basement', sp.basement)] : null,
        sp.heating ? ['Heating', homeLabelD('heating', sp.heating)] : null,
        sp.cooling ? ['Cooling', homeLabelD('cooling', sp.cooling)] : null,
        sp.tour_url ? ['Virtual tour', String(sp.tour_url)] : null
      ]) +
      grp('Costs & Paperwork', [
        (sp.taxes_annual != null && sp.taxes_annual !== '') ? ['Property taxes', '$' + numFmt(sp.taxes_annual) + ' / year'] : null,
        (sp.condo_fee_monthly != null && sp.condo_fee_monthly !== '') ? ['Condo fee', '$' + numFmt(sp.condo_fee_monthly) + ' / month'] : null
      ]) +
      grp('Agent Desk', [
        sp.mls_number ? ['MLS #', String(sp.mls_number)] : null
      ]) +
      grp('The Lease', [
        sp.available_date ? ['Available', String(sp.available_date)] : null,
        sp.lease_term ? ['Lease term', homeLabelD('lease_term', sp.lease_term)] : null,
        sp.furnished ? ['Furnished', homeLabelD('furnished', sp.furnished)] : null,
        (sp.utilities_included && sp.utilities_included.length) ? ['Utilities included', sp.utilities_included.map(function (u) { return homeLabelD('utilities', u); }).join(', ')] : null,
        sp.pets ? ['Pets', homeLabelD('pets', sp.pets)] : null
      ]) +
      grp('Listing Options', [
        sp.viewings_ok != null ? ['Viewing requests', sp.viewings_ok ? 'On' : 'Off'] : null
      ]) +
      '</div>';
  }
  /* Admin: every viewing request across the site (the report
     panel's twin), with Mark done. Fails soft pre-migration. */
  async function renderAdminViewingRequests(client) {
    var host = el('adminAdsList');
    if (!host || !host.parentNode) return;
    var box = el('cfAdminVW');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cfAdminVW';
      var anchorEl = el('cfAdminRR') || host;
      anchorEl.parentNode.insertBefore(box, anchorEl.nextSibling);
    }
    var vw = [];
    try {
      var r = await client.from('viewing_requests')
        .select('id,listing_id,buyer_name,buyer_email,buyer_phone,preferred_date,preferred_time,note,status,created_at')
        .order('created_at', { ascending: false }).limit(100);
      if (r && !r.error && r.data) vw = r.data;
    } catch (e) {}
    if (!vw.length) { box.innerHTML = ''; return; }
    var titles = {};
    try {
      var ids = vw.map(function (q) { return q.listing_id; }).filter(Boolean);
      if (ids.length) {
        var tr = await client.from('listings').select('id,title').in('id', ids);
        (tr.data || []).forEach(function (t) { titles[t.id] = t.title; });
      }
    } catch (e) {}
    var openCount = vw.filter(function (q) { return q.status === 'open'; }).length;
    box.innerHTML = '<h3 style="margin:24px 0 8px">\uD83C\uDFE0 Viewing requests (' + openCount + ' open)</h3>' +
      vw.map(function (q) {
        return '<div class="lcard"><div class="inf"><div class="t">' + esc(q.buyer_name || '') + ' ' + (q.status === 'open' ? pillFor('pending') : pillFor('active')) + '</div>' +
          '<div class="s">' + esc(q.buyer_email || '') + (q.buyer_phone ? ' \u00b7 ' + esc(q.buyer_phone) : '') + ' \u00b7 ad: ' + esc(titles[q.listing_id] || '(ad removed)') + ' \u00b7 ' + shortDate(q.created_at) + '</div>' +
          (q.preferred_date || q.preferred_time ? '<div style="margin-top:6px;font-size:13.5px">Prefers: ' + esc([q.preferred_date, q.preferred_time].filter(Boolean).join(' \u00b7 ')) + '</div>' : '') +
          (q.note ? '<div style="margin-top:6px;font-size:13.5px">' + esc(q.note) + '</div>' : '') + '</div>' +
          (q.status === 'open' ? '<div class="acts"><button class="btn gho" data-cf-vw-done="' + esc(q.id) + '">Mark done</button></div>' : '') +
          '</div>';
      }).join('');
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-cf-vw-done]') : null;
    if (!b) return;
    var client = getClient();
    if (!client) return;
    b.disabled = true;
    client.from('viewing_requests').update({ status: 'done' }).eq('id', b.getAttribute('data-cf-vw-done')).then(function (res) {
      if (res && res.error) { b.disabled = false; say('Could not update the request: ' + res.error.message); return; }
      try { renderAdminViewingRequests(client); } catch (e2) {}
    });
  });

  async function renderAdminCarRequests(client) {
    var host = el('adminAdsList');
    if (!host || !host.parentNode) return;
    var box = el('cfAdminRR');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cfAdminRR';
      host.parentNode.insertBefore(box, host.nextSibling);
    }
    var rr = [];
    try {
      var r = await client.from('report_requests')
        .select('id,listing_id,buyer_name,buyer_email,note,status,created_at')
        .order('created_at', { ascending: false }).limit(100);
      if (r && !r.error && r.data) rr = r.data;
    } catch (e) {}
    if (!rr.length) { box.innerHTML = ''; return; }
    var titles = {};
    try {
      var ids = rr.map(function (q) { return q.listing_id; }).filter(Boolean);
      if (ids.length) {
        var tr = await client.from('listings').select('id,title').in('id', ids);
        (tr.data || []).forEach(function (t) { titles[t.id] = t.title; });
      }
    } catch (e) {}
    var openCount = rr.filter(function (q) { return q.status === 'open'; }).length;
    box.innerHTML = '<h3 style="margin:24px 0 8px">\uD83D\uDCC4 History report requests (' + openCount + ' open)</h3>' +
      rr.map(function (q) {
        return '<div class="lcard"><div class="inf"><div class="t">' + esc(q.buyer_name || '') + ' ' + (q.status === 'open' ? pillFor('pending') : pillFor('active')) + '</div>' +
          '<div class="s">' + esc(q.buyer_email || '') + ' \u00b7 ad: ' + esc(titles[q.listing_id] || '(ad removed)') + ' \u00b7 ' + shortDate(q.created_at) + '</div>' +
          (q.note ? '<div style="margin-top:6px;font-size:13.5px">' + esc(q.note) + '</div>' : '') + '</div>' +
          (q.status === 'open' ? '<div class="acts"><button class="btn gho" data-cf-rr-done="' + esc(q.id) + '">Mark done</button></div>' : '') +
          '</div>';
      }).join('');
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-cf-rr-done]') : null;
    if (!b) return;
    var client = getClient();
    if (!client) return;
    b.disabled = true;
    client.from('report_requests').update({ status: 'done' }).eq('id', b.getAttribute('data-cf-rr-done')).then(function (res) {
      if (res && res.error) { b.disabled = false; say('Could not update the request: ' + res.error.message); return; }
      refresh();
    });
  });

  /* ---- Editor Car details block (injected into #mEditor) ---- */
  function _ef(id, label, inner) {
    return '<div class="fld"><label>' + label + '</label>' + inner + '</div>';
  }
  function _es(id, pairs, blankLabel) {
    var o = '<select id="' + id + '">';
    if (blankLabel != null) o += '<option value="">' + blankLabel + '</option>';
    pairs.forEach(function (p) { o += '<option value="' + p[0] + '">' + p[1] + '</option>'; });
    return o + '</select>';
  }
  function editorCarBox() {
    var box = el('cfEdCarBox');
    if (box) return box;
    var descEl = el('edDesc');
    if (!descEl || !descEl.closest) return null;
    var fld = descEl.closest('.fld');
    if (!fld || !fld.parentNode) return null;
    box = document.createElement('div');
    box.id = 'cfEdCarBox';
    var L = CAR_LABELS_D;
    function opts(map, order) { return order.map(function (k) { return [k, map[k]]; }); }
    box.innerHTML =
      '<div style="font-weight:800;margin:16px 0 4px">\uD83D\uDE97 Car details</div>' +
      '<div class="f2">' + _ef('cfEd_year', 'Year *', '<input id="cfEd_year" inputmode="numeric">') + _ef('cfEd_km', 'Kilometres *', '<input id="cfEd_km" inputmode="numeric">') + '</div>' +
      '<div class="f2">' + _ef('cfEd_make', 'Make *', '<input id="cfEd_make">') + _ef('cfEd_model', 'Model *', '<input id="cfEd_model">') + '</div>' +
      '<div class="f2">' + _ef('cfEd_body_type', 'Body type *', _es('cfEd_body_type', opts(L.body_type, ['sedan', 'coupe', 'hatchback', 'wagon', 'suv', 'crossover', 'truck', 'van', 'minivan', 'convertible', 'other']), 'Select\u2026')) + _ef('cfEd_vehicle_type', 'Vehicle type', _es('cfEd_vehicle_type', opts(L.vehicle_type, ['used', 'new', 'certified']), null)) + '</div>' +
      '<div class="f2">' + _ef('cfEd_trim', 'Trim', '<input id="cfEd_trim" maxlength="30">') + _ef('cfEd_colour', 'Colour', '<input id="cfEd_colour">') + '</div>' +
      '<div class="f2">' + _ef('cfEd_seats', 'Seats', '<input id="cfEd_seats" type="number" min="1" max="12">') + _ef('cfEd_doors', 'Doors', '<input id="cfEd_doors" type="number" min="2" max="6">') + '</div>' +
      '<div class="f2">' + _ef('cfEd_availability', 'Availability', _es('cfEd_availability', opts(L.availability, ['now', 'soon', 'ordered']), null)) + _ef('cfEd_transmission', 'Transmission', _es('cfEd_transmission', opts(L.transmission, ['automatic', 'manual', 'cvt', 'single', 'unknown']), 'Select\u2026')) + '</div>' +
      '<div class="f2">' + _ef('cfEd_drivetrain', 'Drivetrain', _es('cfEd_drivetrain', opts(L.drivetrain, ['fwd', 'rwd', 'awd', '4x4', 'unknown']), 'Select\u2026')) + _ef('cfEd_fuel', 'Fuel', _es('cfEd_fuel', opts(L.fuel, ['gas', 'diesel', 'hybrid', 'phev', 'ev', 'other']), 'Select\u2026')) + '</div>' +
      '<div class="f2">' + _ef('cfEd_engine_l', 'Engine (litres)', '<input id="cfEd_engine_l" inputmode="decimal">') + _ef('cfEd_cylinders', 'Cylinders', _es('cfEd_cylinders', [['3', '3'], ['4', '4'], ['5', '5'], ['6', '6'], ['8', '8'], ['10', '10'], ['12', '12'], ['none', 'None (electric)']], 'Select\u2026')) + '</div>' +
      '<div class="f2">' + _ef('cfEd_accidents', 'Accident history', _es('cfEd_accidents', opts(L.accidents, ['none', 'reported', 'unsure']), 'Select\u2026')) + _ef('cfEd_warranty', 'Warranty', _es('cfEd_warranty', opts(L.warranty, ['factory', 'dealer', 'none']), 'Select\u2026')) + '</div>' +
      '<div class="f2">' +
        '<div class="fld"><label><input type="checkbox" id="cfEd_safety" style="width:auto"> Safety certified (Ontario)</label></div>' +
        '<div class="fld"><label><input type="checkbox" id="cfEd_report_available" style="width:auto"> History report available on request</label></div>' +
      '</div>' +
      _ef('cfEd_report_url', 'History report link', '<input id="cfEd_report_url" placeholder="https://\u2026">') +
      '<div id="cfEd_dealerWrap"><div style="font-weight:800;margin:10px 0 4px">\uD83C\uDFE2 Dealer desk</div>' +
      '<div class="f2">' + _ef('cfEd_stock_number', 'Stock #', '<input id="cfEd_stock_number" maxlength="20">') + _ef('cfEd_vin', 'VIN (17 characters)', '<input id="cfEd_vin" maxlength="17" style="text-transform:uppercase">') + '</div>' +
      '<div style="font-size:12px;color:var(--mu)">Buyers never see the VIN. Only you and the ClassiFlip admin can view it.</div></div>';
    fld.parentNode.insertBefore(box, fld.nextSibling);
    return box;
  }
    /* ---- Homes & Rentals editor (Nov 11, 2026) ----
     The Cars editor's twin: a dynamically built Property details
     block in the dashboard editor - prefilled from specs,
     re-collected and re-validated on save. */
  function editorHomeBox() {
    var box = el('cfEdHomeBox');
    if (box) return box;
    var descEl = el('edDesc');
    if (!descEl || !descEl.closest) return null;
    var fld = descEl.closest('.fld');
    if (!fld || !fld.parentNode) return null;
    box = document.createElement('div');
    box.id = 'cfEdHomeBox';
    var L = HOME_LABELS_D;
    function opts(map, order) { return order.map(function (k) { return [k, map[k]]; }); }
    var bedPairs = [['0', '0 - Bachelor / studio']];
    for (var bi = 1; bi <= 10; bi++) bedPairs.push([String(bi), String(bi)]);
    var bathPairs = ['1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '8', '10'].map(function (v) { return [v, v]; });
    box.innerHTML =
      '<div style="font-weight:800;margin:16px 0 4px">\uD83C\uDFE0 Property details</div>' +
      '<div class="f2">' + _ef('cfEdH_property_type', 'Property type', _es('cfEdH_property_type', opts(L.property_type, ['detached', 'semi', 'townhouse', 'condo', 'duplex', 'other']), 'Select\u2026')) + _ef('cfEdH_sqft', 'Interior size (sq ft)', '<input id="cfEdH_sqft" inputmode="numeric">') + '</div>' +
      '<div class="f2">' + _ef('cfEdH_bedrooms', 'Bedrooms *', _es('cfEdH_bedrooms', bedPairs, 'Select\u2026')) + _ef('cfEdH_bathrooms', 'Bathrooms *', _es('cfEdH_bathrooms', bathPairs, 'Select\u2026')) + '</div>' +
      '<div class="f2">' + _ef('cfEdH_parking', 'Parking', _es('cfEdH_parking', opts(L.parking, ['garage', 'driveway', 'underground', 'street', 'none']), 'Not stated')) + _ef('cfEdH_laundry', 'Laundry', _es('cfEdH_laundry', opts(L.laundry, ['in_unit', 'in_building', 'none']), 'Not stated')) + '</div>' +
      '<div id="cfEdH_saleWrap">' +
      '<div class="f2">' + _ef('cfEdH_lot_sqft', 'Lot size (sq ft)', '<input id="cfEdH_lot_sqft" inputmode="numeric">') + _ef('cfEdH_year_built', 'Year built', '<input id="cfEdH_year_built" inputmode="numeric">') + '</div>' +
      '<div class="f2">' + _ef('cfEdH_basement', 'Basement', _es('cfEdH_basement', opts(L.basement, ['finished', 'partial', 'unfinished', 'none']), 'Not stated')) + _ef('cfEdH_heating', 'Heating', _es('cfEdH_heating', opts(L.heating, ['forced_air_gas', 'electric', 'radiant', 'heat_pump', 'oil', 'other']), 'Not stated')) + '</div>' +
      '<div class="f2">' + _ef('cfEdH_cooling', 'Cooling', _es('cfEdH_cooling', opts(L.cooling, ['central', 'window', 'none']), 'Not stated')) + _ef('cfEdH_taxes_annual', 'Property taxes ($/year)', '<input id="cfEdH_taxes_annual" inputmode="numeric">') + '</div>' +
      '<div class="f2">' + _ef('cfEdH_condo_fee_monthly', 'Condo fee ($/month)', '<input id="cfEdH_condo_fee_monthly" inputmode="numeric">') + _ef('cfEdH_tour_url', 'Virtual tour link', '<input id="cfEdH_tour_url">') + '</div>' +
      '<div id="cfEdH_agentWrap"><div class="f2">' + _ef('cfEdH_mls_number', 'MLS #', '<input id="cfEdH_mls_number" maxlength="12">') + '<div></div></div></div>' +
      '</div>' +
      '<div id="cfEdH_leaseWrap">' +
      '<div class="f2">' + _ef('cfEdH_available_date', 'Available date *', '<input id="cfEdH_available_date" type="date">') + _ef('cfEdH_lease_term', 'Lease term', _es('cfEdH_lease_term', opts(L.lease_term, ['12_plus', 'short', 'month_to_month', 'flexible']), null)) + '</div>' +
      '<div class="f2">' + _ef('cfEdH_furnished', 'Furnished', _es('cfEdH_furnished', opts(L.furnished, ['unfurnished', 'partly', 'furnished']), null)) + _ef('cfEdH_pets', 'Pets', _es('cfEdH_pets', opts(L.pets, ['welcome', 'cats', 'dogs', 'no', 'ask']), 'Not stated')) + '</div>' +
      '<div class="fld"><label>Utilities included</label><div>' + ['heat', 'water', 'hydro', 'internet', 'parking'].map(function (u) { return '<label style="display:inline-flex;gap:6px;align-items:center;margin:0 10px 6px 0;font-weight:400"><input type="checkbox" name="cfEdH_util" value="' + u + '"> ' + L.utilities[u] + '</label>'; }).join('') + '</div></div>' +
      '</div>' +
      '<div class="fld"><label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;font-weight:400"><input type="checkbox" id="cfEdH_viewings_ok" style="margin-top:3px"><span>Let buyers request a viewing with their name + email</span></label></div>' +
      '<div class="fld"><label>Street address (for the map pin)</label><div style="position:relative"><input id="cfEdAddr" type="text" placeholder="Start typing the address\u2026" autocomplete="off"><div id="cfEdAddrSuggest" hidden style="position:absolute;left:0;right:0;top:100%;z-index:60;background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.15);overflow:hidden"></div></div><div style="font-size:12px;color:var(--mu);margin-top:4px">Pick the address from the list so the pin lands on the house.</div></div>' +
      '<div class="fld"><label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;font-weight:400"><input type="checkbox" id="cfEdAreaOnly" style="margin-top:3px"><span>Show area only \u2014 hide my exact address (map shows a circle, not a pin)</span></label></div>';
    fld.parentNode.insertBefore(box, fld.nextSibling);
    return box;
  }
  function fillEditorHomeFields(ad) {
    var box = editorHomeBox();
    if (!box) return;
    if (!ad || (ad.category !== 'Homes' && ad.category !== 'Rentals')) { box.style.display = 'none'; return; }
    box.style.display = '';
    var sp = parseHomeSpecs(ad.specs);
    function set(id, v) { var n = el(id); if (n) n.value = (v == null ? '' : String(v)); }
    set('cfEdH_property_type', sp.property_type); set('cfEdH_bedrooms', sp.bedrooms);
    set('cfEdH_bathrooms', sp.bathrooms); set('cfEdH_sqft', sp.sqft);
    set('cfEdH_parking', sp.parking); set('cfEdH_laundry', sp.laundry);
    set('cfEdH_lot_sqft', sp.lot_sqft); set('cfEdH_year_built', sp.year_built);
    set('cfEdH_basement', sp.basement); set('cfEdH_heating', sp.heating);
    set('cfEdH_cooling', sp.cooling); set('cfEdH_tour_url', sp.tour_url);
    set('cfEdH_taxes_annual', sp.taxes_annual); set('cfEdH_condo_fee_monthly', sp.condo_fee_monthly);
    set('cfEdH_mls_number', sp.mls_number);
    set('cfEdH_available_date', sp.available_date); set('cfEdH_lease_term', sp.lease_term || '12_plus');
    set('cfEdH_furnished', sp.furnished || 'unfurnished'); set('cfEdH_pets', sp.pets);
    var utils = sp.utilities_included || [];
    var boxes = box.querySelectorAll('input[name="cfEdH_util"]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = utils.indexOf(boxes[i].value) >= 0;
    var vok = el('cfEdH_viewings_ok'); if (vok) vok.checked = sp.viewings_ok == null ? true : !!sp.viewings_ok;
    /* Photon address (edit fix, Nov 23, 2026): prefill the saved
       address + area-only flag, and restore the verified pick so
       an untouched address keeps its coordinates on save. */
    var addrInp = el('cfEdAddr'); if (addrInp) addrInp.value = ad.address_text || '';
    var aoChk = el('cfEdAreaOnly'); if (aoChk) aoChk.checked = !!ad.show_area_only;
    window.__cfEdAddrPick = (ad.address_text && ad.latitude != null && ad.longitude != null)
      ? { text: ad.address_text, lat: Number(ad.latitude), lng: Number(ad.longitude) } : null;
    wireEditorPhoton();
    var sw = el('cfEdH_saleWrap'); if (sw) sw.style.display = ad.category === 'Homes' ? '' : 'none';
    var lw = el('cfEdH_leaseWrap'); if (lw) lw.style.display = ad.category === 'Rentals' ? '' : 'none';
    var aw = el('cfEdH_agentWrap');
    if (aw) aw.style.display = ((realEdit && realEdit.isAdvertiser) || sp.mls_number) ? '' : 'none';
  }
  /* Photon autocomplete for the EDITOR address field (Nov 23,
     2026) — same rules as the post form: picking a suggestion
     stores window.__cfEdAddrPick {text, lat, lng}; typing over a
     pick clears it, so a hand-typed address never inherits stale
     coordinates. Wired once; the input is JS-built above. */
  function wireEditorPhoton() {
    var inp = document.getElementById('cfEdAddr');
    var box = document.getElementById('cfEdAddrSuggest');
    if (!inp || !box || inp.__cfEdPhotonWired) return;
    inp.__cfEdPhotonWired = true;
    var timer = null;
    function hide() { box.hidden = true; box.innerHTML = ''; }
    function labelOf(pr) {
      var line1 = ((pr.housenumber ? pr.housenumber + ' ' : '') + (pr.street || pr.name || '')).trim();
      var parts = [line1, pr.city || pr.county || '', pr.postcode || ''].filter(Boolean);
      return parts.join(', ');
    }
    inp.addEventListener('input', function () {
      if (window.__cfEdAddrPick && inp.value.trim() !== window.__cfEdAddrPick.text) window.__cfEdAddrPick = null;
      clearTimeout(timer);
      var v = inp.value.trim();
      if (v.length < 3) { hide(); return; }
      timer = setTimeout(function () {
        fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(v) + '&lat=43.5890&lon=-79.6441&limit=5&lang=en')
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var feats = (j && j.features) || [];
            if (!feats.length) { hide(); return; }
            box.innerHTML = '';
            feats.forEach(function (f) {
              var pr = f.properties || {};
              var co = (f.geometry && f.geometry.coordinates) || [];
              if (co.length < 2) return;
              var lab = labelOf(pr);
              if (!lab) return;
              var b = document.createElement('button');
              b.type = 'button';
              b.textContent = lab;
              b.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 12px;background:#fff;border:0;border-bottom:1px solid #eee;cursor:pointer;font:inherit;color:#222';
              b.addEventListener('mousedown', function (ev) {
                ev.preventDefault();
                inp.value = lab;
                window.__cfEdAddrPick = { text: lab, lat: co[1], lng: co[0] };
                hide();
              });
              box.appendChild(b);
            });
            box.hidden = !box.children.length;
          })
          .catch(function () { hide(); });
      }, 300);
    });
    inp.addEventListener('blur', function () { setTimeout(hide, 150); });
    document.addEventListener('click', function (e) { if (e.target !== inp && !box.contains(e.target)) hide(); });
  }
  function collectEditorHomeSpecs(cat) {
    function v(id) { var n = el(id); return n ? String(n.value).trim() : ''; }
    function num(id) { var t = v(id).replace(/[,\s]/g, ''); if (t === '') return null; var n = Number(t); return isNaN(n) ? null : n; }
    var sp = {};
    var pt = v('cfEdH_property_type'); if (pt) sp.property_type = pt;
    var bd = num('cfEdH_bedrooms'); if (bd != null) sp.bedrooms = Math.round(bd);
    var ba = num('cfEdH_bathrooms'); if (ba != null) sp.bathrooms = ba;
    var sq = num('cfEdH_sqft'); if (sq != null) sp.sqft = Math.round(sq);
    var pk = v('cfEdH_parking'); if (pk) sp.parking = pk;
    var ld = v('cfEdH_laundry'); if (ld) sp.laundry = ld;
    if (cat === 'Homes') {
      var lot = num('cfEdH_lot_sqft'); if (lot != null) sp.lot_sqft = Math.round(lot);
      var yb = num('cfEdH_year_built'); if (yb != null) sp.year_built = Math.round(yb);
      var bs = v('cfEdH_basement'); if (bs) sp.basement = bs;
      var ht = v('cfEdH_heating'); if (ht) sp.heating = ht;
      var cl = v('cfEdH_cooling'); if (cl) sp.cooling = cl;
      var tu = v('cfEdH_tour_url'); if (tu) sp.tour_url = tu.slice(0, 300);
      var tx = num('cfEdH_taxes_annual'); if (tx != null) sp.taxes_annual = Math.round(tx);
      var cf = num('cfEdH_condo_fee_monthly'); if (cf != null) sp.condo_fee_monthly = Math.round(cf);
      var mls = v('cfEdH_mls_number').toUpperCase(); if (mls) sp.mls_number = mls.slice(0, 12);
    }
    if (cat === 'Rentals') {
      var ad8 = v('cfEdH_available_date'); if (ad8) sp.available_date = ad8;
      sp.lease_term = v('cfEdH_lease_term') || '12_plus';
      sp.furnished = v('cfEdH_furnished') || 'unfurnished';
      var utils = [];
      var boxes = document.querySelectorAll('input[name="cfEdH_util"]:checked');
      for (var i = 0; i < boxes.length; i++) { if (HOME_LABELS_D.utilities[boxes[i].value]) utils.push(boxes[i].value); }
      if (utils.length) sp.utilities_included = utils;
      var pets = v('cfEdH_pets'); if (pets) sp.pets = pets;
    }
    var vok = el('cfEdH_viewings_ok');
    sp.viewings_ok = vok ? !!vok.checked : true;
    return sp;
  }
  function validateHomeSpecsD(sp, cat) {
    if (!sp) return 'Property details are missing.';
    if (cat === 'Homes' && !sp.property_type) return 'Pick a property type - required for Homes.';
    if (sp.bedrooms == null) return 'Add the bedrooms - required.';
    if (sp.bedrooms < 0 || sp.bedrooms > 10) return 'Bedrooms must be between 0 (bachelor) and 10.';
    if (sp.bathrooms == null) return 'Add the bathrooms - required.';
    if (sp.bathrooms < 1 || sp.bathrooms > 10 || (sp.bathrooms * 2) % 1 !== 0) return 'Bathrooms must be 1 to 10, in half steps.';
    if (cat === 'Homes') {
      if (sp.sqft == null) return 'Add the interior size in square feet - required for Homes.';
      if (sp.sqft < 100 || sp.sqft > 50000) return 'Interior size must be between 100 and 50,000 sq ft.';
      if (sp.lot_sqft != null && (sp.lot_sqft < 200 || sp.lot_sqft > 1000000)) return 'Lot size must be between 200 and 1,000,000 sq ft.';
      var maxYB = new Date().getFullYear() + 1;
      if (sp.year_built != null && (sp.year_built < 1800 || sp.year_built > maxYB)) return 'Year built must be between 1800 and ' + maxYB + '.';
      if (sp.taxes_annual != null && (sp.taxes_annual < 0 || sp.taxes_annual > 250000)) return 'Property taxes must be between $0 and $250,000 per year.';
      if (sp.condo_fee_monthly != null && (sp.condo_fee_monthly < 0 || sp.condo_fee_monthly > 10000)) return 'Condo fee must be between $0 and $10,000 per month.';
      if (sp.mls_number && !/^[A-Z0-9-]{1,12}$/.test(sp.mls_number)) return 'The MLS # should be letters, numbers or dashes, up to 12 characters - or leave it blank.';
      if (sp.tour_url && !/^https?:\/\//i.test(sp.tour_url)) return 'The virtual tour link must start with http:// or https:// - or leave it blank.';
    }
    if (cat === 'Rentals') {
      if (sp.sqft != null && (sp.sqft < 100 || sp.sqft > 50000)) return 'Interior size must be between 100 and 50,000 sq ft.';
      if (!sp.available_date) return 'Add the available date - required for Rentals.';
      var d = new Date(sp.available_date + 'T00:00:00');
      if (isNaN(d.getTime())) return 'The available date does not look right.';
      var maxD = new Date(); maxD.setMonth(maxD.getMonth() + 18);
      if (d > maxD) return 'The available date is more than 18 months out.';
    }
    return null;
  }

  /* ---- Services Pro Unlimited editor (Nov 14, 2026) ----
     The Cars/Homes editor pattern, for the Services extras: a
     dynamically built block in #mEditor, shown only for Services
     ads while the seller holds an Active Pro Unlimited package,
     prefilled from specs and re-collected on save. */
  var svcOrdersD = null;
  function svcProHeldD() {
    try {
      var ords = (realEdit && realEdit.orders) || svcOrdersD || [];
      var now = new Date();
      return ords.some(function (o) {
        return o && o.status === 'Active' && (!o.expires_at || new Date(o.expires_at) > now) &&
          categoryOfPackageD(o.package) === 'Services' && String(o.package).indexOf('Pro Unlimited') !== -1;
      });
    } catch (e) { return false; }
  }
  function parseSvcSpecs(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }
  function editorSvcBox() {
    var box = el('cfEdSvcBox');
    if (box) return box;
    var descEl = el('edDesc');
    if (!descEl || !descEl.closest) return null;
    var fld = descEl.closest('.fld');
    if (!fld || !fld.parentNode) return null;
    box = document.createElement('div');
    box.id = 'cfEdSvcBox';
    var pays = ['Cash', 'Interac e-Transfer', 'Credit card', 'Debit', 'Cheque'];
    box.innerHTML =
      '<div style="font-weight:800;margin:16px 0 4px">\uD83D\uDEE0\uFE0F Pro Unlimited extras</div>' +
      '<div class="fld"><label>Services &amp; prices (up to 8)</label><div id="cfEdS_priceRows"></div><button type="button" id="cfEdS_addRow" style="margin-top:6px">+ Add a service</button></div>' +
      '<div class="f2">' +
      '<div class="fld"><label style="display:flex;gap:8px;align-items:center;cursor:pointer;font-weight:400"><input type="checkbox" id="cfEdS_licensed"> Licensed</label></div>' +
      '<div class="fld"><label style="display:flex;gap:8px;align-items:center;cursor:pointer;font-weight:400"><input type="checkbox" id="cfEdS_insured"> Insured</label></div>' +
      '</div>' +
      '<div class="f2">' + _ef('cfEdS_years', 'Years in business', '<input id="cfEdS_years" type="number" min="0" max="99">') + _ef('cfEdS_certs', 'Certifications', '<input id="cfEdS_certs" maxlength="80">') + '</div>' +
      _ef('cfEdS_areas', 'Service areas (up to 6, comma-separated)', '<input id="cfEdS_areas" maxlength="160">') +
      '<div class="f2">' +
      '<div class="fld"><label style="display:flex;gap:8px;align-items:center;cursor:pointer;font-weight:400"><input type="checkbox" id="cfEdS_emergency"> Emergency / 24-7 service</label></div>' +
      _ef('cfEdS_note', 'Availability note', '<input id="cfEdS_note" maxlength="60">') +
      '</div>' +
      _ef('cfEdS_booking', 'Booking / quote link', '<input id="cfEdS_booking">') +
      '<div class="fld"><label>Payment methods accepted</label><div>' + pays.map(function (u) { return '<label style="display:inline-flex;gap:6px;align-items:center;margin:0 10px 6px 0;font-weight:400"><input type="checkbox" name="cfEdS_pay" value="' + u + '"> ' + u + '</label>'; }).join('') + '</div></div>';
    fld.parentNode.insertBefore(box, fld.nextSibling);
    var add = el('cfEdS_addRow');
    if (add) add.addEventListener('click', function () {
      var wrap = el('cfEdS_priceRows');
      if (!wrap || wrap.children.length >= 8) return;
      wrap.appendChild(svcEdRow('', ''));
      if (wrap.children.length >= 8) add.style.display = 'none';
    });
    return box;
  }
  function svcEdRow(name, price) {
    var d = document.createElement('div');
    d.className = 'svc-ed-row';
    d.style.cssText = 'display:flex;gap:8px;margin-bottom:6px';
    var n = document.createElement('input');
    n.className = 'svc-ed-name'; n.maxLength = 60; n.placeholder = 'Service'; n.value = name || '';
    n.style.cssText = 'flex:1.4;min-width:0';
    var pr = document.createElement('input');
    pr.className = 'svc-ed-price'; pr.maxLength = 24; pr.placeholder = 'Price'; pr.value = price || '';
    pr.style.cssText = 'flex:1;min-width:0';
    d.appendChild(n); d.appendChild(pr);
    return d;
  }
  function fillEditorSvcFields(ad) {
    var box = editorSvcBox();
    if (!box) return;
    if (!ad || ad.category !== 'Services' || !svcProHeldD()) { box.style.display = 'none'; return; }
    box.style.display = '';
    var sp = parseSvcSpecs(ad.specs);
    function set(id, v) { var n = el(id); if (n) n.value = (v == null ? '' : String(v)); }
    function chk(id, v) { var n = el(id); if (n) n.checked = !!v; }
    set('cfEdS_years', sp.svc_years); set('cfEdS_certs', sp.svc_certs);
    set('cfEdS_areas', Array.isArray(sp.svc_areas) ? sp.svc_areas.join(', ') : '');
    set('cfEdS_note', sp.svc_avail_note); set('cfEdS_booking', sp.svc_booking_url);
    chk('cfEdS_licensed', sp.svc_licensed); chk('cfEdS_insured', sp.svc_insured);
    chk('cfEdS_emergency', sp.svc_emergency);
    var pays = Array.isArray(sp.svc_payments) ? sp.svc_payments : [];
    var boxes = box.querySelectorAll('input[name="cfEdS_pay"]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = pays.indexOf(boxes[i].value) >= 0;
    var wrap = el('cfEdS_priceRows');
    if (wrap) {
      wrap.innerHTML = '';
      var list = Array.isArray(sp.svc_price_list) ? sp.svc_price_list : [];
      if (list.length) list.slice(0, 8).forEach(function (r) { wrap.appendChild(svcEdRow(r.service, r.price)); });
      else { wrap.appendChild(svcEdRow('', '')); wrap.appendChild(svcEdRow('', '')); }
      var add = el('cfEdS_addRow'); if (add) add.style.display = wrap.children.length >= 8 ? 'none' : '';
    }
  }
  function collectEditorSvcSpecs() {
    var box = el('cfEdSvcBox');
    if (!box || box.style.display === 'none') return null;
    function v(id) { var n = el(id); return n ? String(n.value).trim() : ''; }
    function ck(id) { var n = el(id); return !!(n && n.checked); }
    var sp = {};
    var rows = [];
    box.querySelectorAll('.svc-ed-row').forEach(function (r) {
      var n = r.querySelector('.svc-ed-name'), pr = r.querySelector('.svc-ed-price');
      var name = n ? n.value.trim() : '', price = pr ? pr.value.trim() : '';
      if (name) rows.push({ service: name.slice(0, 60), price: price.slice(0, 24) });
    });
    if (rows.length) sp.svc_price_list = rows.slice(0, 8);
    if (ck('cfEdS_licensed')) sp.svc_licensed = true;
    if (ck('cfEdS_insured')) sp.svc_insured = true;
    var yrs = v('cfEdS_years').replace(/[,\s]/g, '');
    if (yrs !== '') { var yn = Number(yrs); if (!isNaN(yn) && yn >= 0) sp.svc_years = yn; }
    var certs = v('cfEdS_certs'); if (certs) sp.svc_certs = certs.slice(0, 80);
    var areas = v('cfEdS_areas').split(',').map(function (a) { return a.trim(); }).filter(Boolean).slice(0, 6);
    if (areas.length) sp.svc_areas = areas;
    if (ck('cfEdS_emergency')) sp.svc_emergency = true;
    var note = v('cfEdS_note'); if (note) sp.svc_avail_note = note.slice(0, 60);
    var url = v('cfEdS_booking');
    if (url) { if (!/^https?:\/\//i.test(url)) url = 'https://' + url; sp.svc_booking_url = url; }
    var pays = [];
    box.querySelectorAll('input[name="cfEdS_pay"]:checked').forEach(function (c) { pays.push(c.value); });
    if (pays.length) sp.svc_payments = pays;
    return Object.keys(sp).length ? sp : null;
  }
  function fillEditorCarFields(ad) {
    var box = editorCarBox();
    if (!box) return;
    if (!ad || ad.category !== 'Cars') { box.style.display = 'none'; return; }
    box.style.display = '';
    var sp = parseCarSpecs(ad.specs);
    function set(id, v) { var n = el(id); if (n) n.value = (v == null ? '' : String(v)); }
    set('cfEd_year', sp.year); set('cfEd_make', sp.make); set('cfEd_model', sp.model);
    set('cfEd_trim', sp.trim); set('cfEd_body_type', sp.body_type); set('cfEd_km', sp.km);
    set('cfEd_vehicle_type', sp.vehicle_type || 'used'); set('cfEd_colour', sp.colour);
    set('cfEd_seats', sp.seats); set('cfEd_doors', sp.doors);
    set('cfEd_availability', sp.availability || 'now'); set('cfEd_transmission', sp.transmission);
    set('cfEd_drivetrain', sp.drivetrain); set('cfEd_fuel', sp.fuel);
    set('cfEd_engine_l', sp.engine_l); set('cfEd_cylinders', sp.cylinders);
    set('cfEd_accidents', sp.accidents); set('cfEd_warranty', sp.warranty);
    set('cfEd_report_url', sp.report_url);
    var sf = el('cfEd_safety'); if (sf) sf.checked = !!sp.safety_certified;
    var ra = el('cfEd_report_available'); if (ra) ra.checked = !!sp.report_available;
    set('cfEd_stock_number', sp.stock_number); set('cfEd_vin', sp.vin);
    var dw = el('cfEd_dealerWrap');
    if (dw) dw.style.display = ((realEdit && realEdit.isAdvertiser) || sp.stock_number || sp.vin) ? '' : 'none';
  }
  function collectEditorCarSpecs() {
    function v(id) { var n = el(id); return n ? String(n.value).trim() : ''; }
    function num(id) { var t = v(id).replace(/[,\s]/g, ''); if (t === '') return null; var n = Number(t); return isNaN(n) ? null : n; }
    var sp = {};
    var year = num('cfEd_year'); if (year != null) sp.year = Math.round(year);
    var make = v('cfEd_make'); if (make) sp.make = make.slice(0, 40);
    var model = v('cfEd_model'); if (model) sp.model = model.slice(0, 40);
    var trim = v('cfEd_trim'); if (trim) sp.trim = trim.slice(0, 30);
    var bt = v('cfEd_body_type'); if (bt) sp.body_type = bt;
    var km = num('cfEd_km'); if (km != null) sp.km = Math.round(km);
    sp.vehicle_type = v('cfEd_vehicle_type') || 'used';
    sp.availability = v('cfEd_availability') || 'now';
    var colour = v('cfEd_colour'); if (colour) sp.colour = colour.slice(0, 30);
    var seats = num('cfEd_seats'); if (seats != null) sp.seats = Math.round(seats);
    var doors = num('cfEd_doors'); if (doors != null) sp.doors = Math.round(doors);
    var tr = v('cfEd_transmission'); if (tr) sp.transmission = tr;
    var dr = v('cfEd_drivetrain'); if (dr) sp.drivetrain = dr;
    var fu = v('cfEd_fuel'); if (fu) sp.fuel = fu;
    var eng = v('cfEd_engine_l'); if (eng !== '') { var en = Number(eng); if (!isNaN(en)) sp.engine_l = en; }
    var cyl = v('cfEd_cylinders'); if (cyl) sp.cylinders = (cyl === 'none') ? 'none' : (parseInt(cyl, 10) || cyl);
    var acc = v('cfEd_accidents'); if (acc) sp.accidents = acc;
    var sf = el('cfEd_safety'); if (sf && sf.checked) sp.safety_certified = true;
    var war = v('cfEd_warranty'); if (war) sp.warranty = war;
    var rurl = v('cfEd_report_url'); if (rurl) sp.report_url = rurl;
    var ra = el('cfEd_report_available'); if (ra && ra.checked) sp.report_available = true;
    var stock = v('cfEd_stock_number'); if (stock) sp.stock_number = stock.slice(0, 20);
    var vin = v('cfEd_vin').toUpperCase(); if (vin) sp.vin = vin;
    return sp;
  }

  async function renderAdmin(client) {
    /* Site pause switch (admin only): read the single site_settings
       row, show its state, and let the admin flip it. Until the
       pause SQL runs, the read fails and the box says so — the
       rest of Admin still works. */
    try {
      var ps = await client.from('site_settings').select('paused,paused_note').eq('id', 1).maybeSingle();
      var paused = !!(ps && ps.data && ps.data.paused);
      var st = el('sitePauseStatus'), tg = document.querySelector('[data-cf-pause-toggle]');
      if (st) st.textContent = paused ? 'PAUSED — new ads, boosts, and packages are off for non-admins. Browsing is still open.' : 'Live — site is not paused.';
      if (tg) { tg.textContent = paused ? 'Unpause site' : 'Pause site'; tg.dataset.cfPauseNext = paused ? 'false' : 'true'; }
    } catch (e) {
      var st2 = el('sitePauseStatus');
      if (st2) st2.textContent = 'Pause status unavailable — run supabase/cf-site-pause-migration.sql first.';
    }
    /* Total users count — ADMIN ONLY. Runs inside renderAdmin, which
       only runs for admins, and the box lives in the admin section
       (hidden for everyone else). Profiles are auto-created on
       signup, so the profiles count = total users. */
    try {
      var cnt = await client.from('profiles').select('id', { count: 'exact', head: true });
      var uc = el('adminUserCount');
      if (uc) uc.textContent = (cnt && !cnt.error && typeof cnt.count === 'number') ? String(cnt.count) : 'Unavailable';
      if (cnt && !cnt.error && typeof cnt.count === 'number') setTabBadge('atabNUsers', cnt.count, true);
      var ovu = el('ovUsers');
      if (ovu) ovu.textContent = (cnt && !cnt.error && typeof cnt.count === 'number') ? String(cnt.count) : '—';
    } catch (e3) {
      var uc2 = el('adminUserCount');
      if (uc2) uc2.textContent = 'Unavailable';
    }

    /* Live-ads count for the All Ads tab chip (Nov 12, 2026, Martin's
       ask): same exact-count pattern as Users above, filtered to
       status 'active' so the chip shows total LIVE ads. Always shown
       (even 0) so the number is there at a glance. */
    try {
      var lac = await client.from('listings').select('id', { count: 'exact', head: true }).eq('status', 'active');
      if (lac && !lac.error && typeof lac.count === 'number') setTabBadge('atabNAllAds', lac.count, true);
    } catch (e) {}

    /* Site overview counts (admin only): exact totals for the top
       strip — total ads, pending ads, pending packages (orders in
       'Pending'). Count-only queries, so the numbers stay exact
       even where the lists below cap their rows. */
    try {
      setOv('ovAds', await client.from('listings').select('id', { count: 'exact', head: true }), false);
      setOv('ovPendingAds', await client.from('listings').select('id', { count: 'exact', head: true }).eq('status', 'pending'), true);
      setOv('ovPendingOrders', await client.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'Pending'), true);
      /* Pending boosts count (Nov 16, 2026, Martin's ask): same chip
         pattern as Reported ads — head-count of boosts rows still
         'Pending'; the Boosts admin tab badge carries the same
         number from the full read below. */
      setOv('ovPendingBoosts', await client.from('boosts').select('id', { count: 'exact', head: true }).eq('status', 'Pending'), true);
    } catch (e) {}

    /* Reported ads count (Nov 16, 2026, Martin's ask): distinct ads
       carrying at least one OPEN report — the same number the
       Reports tab badge shows. Rows are fetched, not head-counted,
       because the chip counts ads, not reports. Fails soft to a
       dash if the reports table is unavailable. */
    try {
      var rrp = await client.from('listing_reports').select('listing_id').eq('status', 'open').limit(500);
      var ovr = el('ovReported');
      if (ovr) {
        if (rrp && !rrp.error && rrp.data) {
          var seenRep = {};
          rrp.data.forEach(function (r) { if (r.listing_id) seenRep[r.listing_id] = 1; });
          var nRep = Object.keys(seenRep).length;
          ovr.textContent = String(nRep);
          var repCard = ovr.closest ? ovr.closest('.stat') : null;
          if (repCard) repCard.classList.toggle('hot', nRep > 0);
        } else {
          ovr.textContent = '—';
        }
      }
    } catch (e) {}

    /* Waitlist counter (Nov 3, 2026): today / this week / total from
       waitlist_signups, Toronto day boundaries (week starts Monday).
       Admin-only end to end: this runs inside renderAdmin and the
       table's SELECT policy is is_admin — the numbers never appear
       anywhere public (standing stats-privacy rule). Fails soft to
       dashes if the cf-waitlist-signups migration has not run. */
    try {
      var wlTotal = await client.from('waitlist_signups').select('id', { count: 'exact', head: true });
      setOv('ovWaitlist', wlTotal, false);
      var wlT = await client.from('waitlist_signups').select('id', { count: 'exact', head: true }).gte('created_at', torontoTodayStart());
      var wlW = await client.from('waitlist_signups').select('id', { count: 'exact', head: true }).gte('created_at', torontoWeekStart());
      var wlLbl = el('ovWaitlistLabel');
      if (wlLbl) wlLbl.textContent = 'Waitlist signups · ' + ((wlT && !wlT.error && typeof wlT.count === 'number') ? wlT.count : '—') + ' today · ' + ((wlW && !wlW.error && typeof wlW.count === 'number') ? wlW.count : '—') + ' this week';
    } catch (e) {}

    try { await renderAdminWaitlist(client); } catch (e) {}
    try { await renderAdminUsers(client); } catch (e) {}
    try { await renderAdminReports(client); } catch (e) {}
    try { await renderAdminCarRequests(client); } catch (e) {}
    try { await renderAdminViewingRequests(client); } catch (e) {}
    try { await renderAdminRevenue(client); } catch (e) {}

    var adsList = el('adminAdsList'), ordersList = el('adminOrdersList'), expList = el('adminExpiringList');
    if (adsList) adsList.innerHTML = '<div class="notice">Loading pending ads…</div>';
    if (ordersList) ordersList.innerHTML = '<div class="notice">Loading orders…</div>';

    /* Pending ads (needs the step-4 admin read policy; without it this
       returns [] and the hint below explains why). */
    var pending = [];
    try {
      var pr = await client.from('listings')
        .select('id,title,description,price,category,location,status,photo_url,created_at,seller_id,tags,specs')
        .eq('status', 'pending').order('created_at', { ascending: true }).limit(100);
      if (pr && pr.error) {
        /* Specs column missing (Cars migration not pasted yet). */
        pr = await client.from('listings')
          .select('id,title,description,price,category,location,status,photo_url,created_at,seller_id,tags')
          .eq('status', 'pending').order('created_at', { ascending: true }).limit(100);
      }
      if (pr && pr.data) pending = pr.data;
    } catch (e) {}
    /* Multi-photo (v1.1): every pending ad's photos, ordered by
       position, so moderation sees ALL images, not just the cover.
       Falls back to the cover alone for ads posted before the
       multi-photo migration (no listing_photos rows). */
    var photosByListing = {};
    try {
      var pids = pending.map(function (x) { return x.id; }).filter(Boolean);
      if (pids.length) {
        var phr = await client.from('listing_photos')
          .select('listing_id,photo_url,position')
          .in('listing_id', pids).order('position', { ascending: true });
        (phr.data || []).forEach(function (p) {
          if (!photosByListing[p.listing_id]) photosByListing[p.listing_id] = [];
          if (p.photo_url) photosByListing[p.listing_id].push(p.photo_url);
        });
      }
    } catch (e) {}
    if (pending.length) {
      var sellerIds = pending.map(function (x) { return x.seller_id; }).filter(Boolean);
      var sellersById = {};
      try {
        var sr = await client.from('profiles').select('id,display_name,email').in('id', sellerIds);
        (sr.data || []).forEach(function (r) { sellersById[r.id] = r; });
      } catch (e) {}
      adsList.innerHTML = pending.map(function (x) {
        var s = sellersById[x.seller_id] || {};
        var desc = (x.description || '').trim();
        var photos = photosByListing[x.id] || (x.photo_url ? [x.photo_url] : []);
        var strip = photos.length > 1
          ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' + photos.map(function (p) {
              return '<img src="' + esc(p) + '" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px">';
            }).join('') + '</div>'
          : '';
        var fullSpecs = carSpecsAdminHtml(x) + homeSpecsAdminHtml(x);
        var bigStrip = photos.length > 1
          ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">' + photos.map(function (p) {
              return '<img src="' + esc(p) + '" alt="" loading="lazy" style="width:150px;height:113px;object-fit:cover;border-radius:10px">';
            }).join('') + '</div>'
          : '';
        var fullDetail = (fullSpecs || bigStrip)
          ? '<div data-cf-adetail="' + esc(x.id) + '" hidden>' + bigStrip + fullSpecs + '</div>'
          : '';
        return '<div class="lcard">' +
          (x.photo_url ? '<img src="' + esc(x.photo_url) + '" alt="">' : '<div class="ph"><svg width="34" height="34" style="width:34px;height:34px" viewBox="0 0 24 24" fill="none" stroke="#16365f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg></div>') +
          '<div class="inf"><div class="t">' + esc(x.title) + ' ' + pillFor('pending') + '</div>' +
          '<div class="p">' + money(x.price) + '</div>' +
          '<div class="s">' + esc(x.category || '') + ' · ' + esc(x.location || '') + ' · seller ' + esc(s.display_name || s.email || x.seller_id || '') + ' · ' + shortDate(x.created_at) + '</div>' +
          ((x.tags && x.tags.length) ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' + x.tags.map(function (tg) {
            return '<span style="border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:12px">#' + esc(tg) + ' <button type="button" data-cf-tag-remove="' + esc(x.id) + '|' + esc(tg) + '" title="Remove this tag" style="border:0;background:none;cursor:pointer;color:var(--mu)">×</button></span>';
          }).join('') + '</div>' : '') +
          strip +
          (desc ? '<div style="margin-top:8px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word">' + esc(desc) + '</div>'
                : '<div style="margin-top:8px;font-size:13px;color:var(--mu)">No description provided.</div>') + carSummaryLine(x) + homeSummaryLine(x) + fullDetail + '</div>' +
          '<div class="acts" style="width:300px;flex:none"><div style="margin-bottom:6px"><select data-cf-reject-reason="' + esc(x.id) + '" aria-label="Reject reason" style="width:100%;margin-bottom:4px;padding:6px;border:1px solid var(--line);border-radius:8px">' +
          '<option value="Wrong category — please post a new ad under Services">Wrong category — post a new ad under Services</option>' +
          '<option value="Wrong category — please post a new ad in the correct category">Wrong category — correct category</option>' +
          '<option value="Photos or description missing or unclear">Photos / description unclear</option>' +
          '<option value="Prohibited item">Prohibited item</option>' +
          '<option value="Duplicate ad">Duplicate ad</option></select>' +
          '<input data-cf-reject-custom="' + esc(x.id) + '" placeholder="Or type a custom reason…" style="width:100%;padding:6px;border:1px solid var(--line);border-radius:8px"></div>' +
          (fullDetail ? '<button class="btn gho" data-cf-viewad="' + esc(x.id) + '">View ad</button>' : '') +
          '<button class="btn pri" data-cf-approve="' + esc(x.id) + '">Approve</button>' +
          '<button class="btn gho danger" data-cf-reject="' + esc(x.id) + '">Reject</button></div></div>';
      }).join('');
    } else {
      adsList.innerHTML = '<div class="notice">No ads awaiting approval. If you know a pending ad exists and this stays empty, the step-4 SQL has not been run yet (see the note below).</div>';
    }

    setTabBadge('atabNApprovals', pending.length, false);

    /* All ads (admin takedowns): every seller's ads, all
       statuses, newest first — not just pending, not just own.
       Uses the step-4 admin read policy; Delete reuses the
       existing two-tap data-cf-del handler (admin delete
       policy), which refreshes the dashboard after. */
    var allAdsList = el('adminAllAdsList');
    if (allAdsList) {
      allAdsList.innerHTML = '<div class="notice">Loading all ads…</div>';
      try {
        var ar2 = await client.from('listings')
          .select('id,title,price,category,location,status,created_at,seller_id')
          .order('created_at', { ascending: false }).limit(100);
        var allAds = (ar2 && ar2.data) || [];
        if (!allAds.length) {
          allAdsList.innerHTML = '<div class="notice">No ads on file.</div>';
        } else {
          var aIds = allAds.map(function (x) { return x.seller_id; }).filter(Boolean);
          var aSellers = {};
          try {
            var asr = await client.from('profiles').select('id,display_name,email').in('id', aIds);
            (asr.data || []).forEach(function (r) { aSellers[r.id] = r; });
          } catch (e) {}
          allAdsList.innerHTML = allAds.map(function (x) {
            var s2 = aSellers[x.seller_id] || {};
            /* Admin All Ads (Nov 13, 2026, Martin's ask): always show the
               seller's email next to the display name, so an ad is easy to
               spot when its owner calls. Admin-only surface; public ads
               still show no seller email. */
            var sellerLabel = s2.display_name || '';
            if (s2.email) sellerLabel += (sellerLabel ? ' · ' : '') + s2.email;
            if (!sellerLabel) sellerLabel = x.seller_id || '';
            return '<div class="lcard"><div class="inf"><div class="t">' + esc(x.title) + ' ' + pillFor(x.status) + '</div>' +
              '<div class="p">' + money(x.price) + '</div>' +
              '<div class="s">' + esc(sellerLabel) + ' · ' + esc(x.category || '') + ' · ' + esc(x.location || '') + ' · ' + shortDate(x.created_at) + '</div></div>' +
              '<div class="acts"><button class="btn gho danger" data-cf-del="' + esc(x.id) + '">Delete</button></div></div>';
          }).join('');
        }
      } catch (e) {
        allAdsList.innerHTML = '<div class="notice">Could not load all ads.</div>';
      }
    }

    /* All orders, newest first. */
    var allOrders = [];
    try {
      var orr = await client.from('orders')
        .select('id,order_number,business_name,package,amount,buyer_name,buyer_email,buyer_phone,status,expires_at,created_at,term')
        .order('created_at', { ascending: false }).limit(100);
      if (orr && orr.data) allOrders = orr.data;
    } catch (e) {}
    if (!allOrders.length) {
      if (ordersList) ordersList.innerHTML = '<div class="notice">No orders yet.</div>';
    } else {
      if (ordersList) {
        ordersList.innerHTML = allOrders.map(function (o) {
          return '<div class="lcard"><div class="inf"><div class="t">' + esc(o.order_number) + ' · ' + esc(o.business_name || '') + ' ' + pillForOrder(o.status) + '</div>' +
            '<div class="p">' + money(o.amount) + ' · ' + esc(o.package || '') + '</div>' +
            '<div class="s">' + esc(o.buyer_name || '') + (o.buyer_email ? ' · ' + esc(o.buyer_email) : '') + (o.buyer_phone ? ' · ' + esc(o.buyer_phone) : '') +
            ' · ordered ' + fullDate(o.created_at) + (o.expires_at ? ' · expires ' + fullDate(o.expires_at) : '') + orderTermSuffix(o) + '</div></div>' +
            '<div class="acts"><button class="btn pri" data-cf-order-activate="' + esc(o.id) + '">Activate · 30 days</button>' +
            '<button class="btn gho" data-cf-order-soon="' + esc(o.id) + '">Expiring soon</button>' +
            '<button class="btn gho danger" data-cf-order-expire="' + esc(o.id) + '">Expire</button></div></div>';
        }).join('');
      }
    }

    /* Expiring soon, computed: Active orders expiring within 3 days. */
    if (expList) {
      var soon = allOrders.filter(function (o) {
        if (o.status !== 'Active' || !o.expires_at) return false;
        var ms = new Date(o.expires_at).getTime() - Date.now();
        return ms > 0 && ms <= 3 * 24 * 3600 * 1000;
      });
      expList.innerHTML = soon.length
        ? soon.map(function (o) {
            return '<div class="lcard"><div class="inf"><div class="t">' + esc(o.order_number) + ' · ' + esc(o.business_name || '') + ' ' + pillForOrder(o.status) + '</div>' +
              '<div class="s">Expires ' + fullDate(o.expires_at) + ' · ' + esc(o.package || '') + ' · ' + money(o.amount) + '</div></div></div>';
          }).join('')
        : '<div class="notice">Nothing expiring within 3 days.</div>';
    }

    setTabBadge('atabNOrders', allOrders.filter(function (o) { return o.status === 'Pending'; }).length, false);

    /* Step 5 Boost admin lists — mirrors the orders queue exactly.
       Pending boosts (Activate · 7 days), active boosts (Expire),
       and boosts expiring within 3 days. Titles + buyer names are
       resolved the same way as the pending-ads queue. Without the
       step-5 SQL these read [] and the lists say so. */
    var bList = el('adminBoostsList'), bActiveList = el('adminBoostsActiveList'), bExpList = el('adminBoostsExpiringList');
    if (bList) bList.innerHTML = '<div class="notice">Loading boosts…</div>';
    var allBoosts = [];
    try {
      var br2 = await client.from('boosts')
        .select('id,listing_id,buyer_id,amount,payment_method,status,payment_ref,expires_at,activated_at,created_at')
        .order('created_at', { ascending: false }).limit(100);
      if (br2 && br2.data) allBoosts = br2.data;
    } catch (e) {}
    var boostTitles = {}, boostBuyers = {};
    try {
      var blids = allBoosts.map(function (b) { return b.listing_id; }).filter(Boolean);
      if (blids.length) {
        var tr = await client.from('listings').select('id,title').in('id', blids);
        (tr.data || []).forEach(function (r) { boostTitles[r.id] = r.title; });
      }
      var bbids = allBoosts.map(function (b) { return b.buyer_id; }).filter(Boolean);
      if (bbids.length) {
        var bur = await client.from('profiles').select('id,display_name,email').in('id', bbids);
        (bur.data || []).forEach(function (r) { boostBuyers[r.id] = r; });
      }
    } catch (e) {}
    function boostCard(b, acts) {
      var buyer = boostBuyers[b.buyer_id] || {};
      return '<div class="lcard"><div class="inf"><div class="t">' + esc(b.payment_ref || 'Boost') + ' · ' + esc(boostTitles[b.listing_id] || 'Ad') + ' ' + pillForOrder(b.status) + '</div>' +
        '<div class="p">$' + Number(b.amount).toFixed(2) + ' · ' + (b.payment_method === 'etransfer' ? 'Interac e-Transfer' : 'Card') + '</div>' +
        '<div class="s">' + esc(buyer.display_name || buyer.email || '') +
        ' · reserved ' + fullDate(b.created_at) +
        (b.activated_at ? ' · activated ' + fullDate(b.activated_at) : '') +
        (b.expires_at ? ' · expires ' + fullDate(b.expires_at) : '') + '</div></div>' +
        (acts || '') + '</div>';
    }
    var pendBoosts = allBoosts.filter(function (b) { return b.status === 'Pending'; });
    if (bList) {
      bList.innerHTML = pendBoosts.length
        ? pendBoosts.map(function (b) {
            return boostCard(b, '<div class="acts"><button class="btn pri" data-cf-boost-activate="' + esc(b.id) + '" data-cf-boost-listing="' + esc(b.listing_id) + '">Activate · 7 days</button></div>');
          }).join('')
        : '<div class="notice">No boosts awaiting activation.</div>';
    }
    setTabBadge('atabNBoosts', pendBoosts.length, false);
    var actBoosts = allBoosts.filter(function (b) { return b.status === 'Active'; });
    if (bActiveList) {
      bActiveList.innerHTML = actBoosts.length
        ? actBoosts.map(function (b) {
            var expMs = b.expires_at ? new Date(b.expires_at).getTime() - Date.now() : 0;
            var flag = (b.expires_at && expMs > 0 && expMs <= 3 * 24 * 3600 * 1000) ? ' <span class="pill pend">Expiring soon</span>' : '';
            /* Truth-in-labelling (Nov 12, 2026): a boost past its
               expires_at has no effect on the marketplace (the
               effective-boosts RPC already ignores it), so the card
               must not wear the green Active pill — show Expired.
               The stored row stays Active until the admin closes it
               with the Expire button; this only fixes the display. */
            var shown = (b.expires_at && expMs <= 0) ? Object.assign({}, b, { status: 'Expired' }) : b;
            return boostCard(shown, '<div class="acts">' + flag + '<button class="btn gho danger" data-cf-boost-expire="' + esc(b.id) + '" data-cf-boost-listing="' + esc(b.listing_id) + '">Expire</button></div>');
          }).join('')
        : '<div class="notice">No active boosts.</div>';
    }
    if (bExpList) {
      var soonBoosts = actBoosts.filter(function (b) {
        if (!b.expires_at) return false;
        var ms = new Date(b.expires_at).getTime() - Date.now();
        return ms > 0 && ms <= 3 * 24 * 3600 * 1000;
      });
      bExpList.innerHTML = soonBoosts.length
        ? soonBoosts.map(function (b) {
            return '<div class="lcard"><div class="inf"><div class="t">' + esc(b.payment_ref || 'Boost') + ' · ' + esc(boostTitles[b.listing_id] || 'Ad') + ' ' + pillForOrder(b.status) + '</div>' +
              '<div class="s">Expires ' + fullDate(b.expires_at) + ' · $' + Number(b.amount).toFixed(2) + '</div></div></div>';
          }).join('')
        : '<div class="notice">Nothing expiring within 3 days.</div>';
    }
  }

  /* Delegated actions: own-listing delete + all admin actions. */
  document.addEventListener('click', async function (e) {
    var pauseBtn = e.target.closest ? e.target.closest('[data-cf-pause-toggle]') : null;
    if (pauseBtn) {
      var next = pauseBtn.dataset.cfPauseNext === 'true';
      try {
        var upd = await getClient().from('site_settings').update({ paused: next, updated_at: new Date().toISOString() }).eq('id', 1);
        if (upd.error) throw upd.error;
        var st3 = el('sitePauseStatus');
        if (st3) st3.textContent = next ? 'PAUSED — new ads, boosts, and packages are off for non-admins. Browsing is still open.' : 'Live — site is not paused.';
        pauseBtn.textContent = next ? 'Unpause site' : 'Pause site';
        pauseBtn.dataset.cfPauseNext = next ? 'false' : 'true';
      } catch (err2) { alert('Could not flip the pause switch: ' + (err2 && err2.message ? err2.message : 'unknown error') + ' — run supabase/cf-site-pause-migration.sql first.'); }
      return;
    }
    var client = getClient();
    if (!client) return;
    /* Tags (Oct 29): admin strips a bad tag from a pending ad — the
       × on a tag chip. Uses the admin UPDATE policy; the row stays
       pending, only that one tag is removed. Dashboard refreshes. */
    var tagRm = e.target.closest ? e.target.closest('[data-cf-tag-remove]') : null;
    if (tagRm) {
      var parts = String(tagRm.dataset.cfTagRemove || '').split('|');
      var tagId = parts[0], tagVal = parts.slice(1).join('|');
      try {
        var cur = await client.from('listings').select('tags').eq('id', tagId).maybeSingle();
        var kept = ((cur && cur.data && cur.data.tags) || []).filter(function (tg) { return tg !== tagVal; });
        var updT = await client.from('listings').update({ tags: kept }).eq('id', tagId);
        if (updT.error) { say('Could not remove tag: ' + updT.error.message); return; }
        say('Tag removed'); refresh();
      } catch (errT) { say('Could not remove tag.'); }
      return;
    }
    var sold = e.target.closest ? e.target.closest('[data-cf-sold]') : null;
    if (sold) {
      if (!sold.dataset.armed) {
        sold.dataset.armed = '1'; sold.textContent = 'Sold? Confirm';
        setTimeout(function () { if (sold.isConnected) { delete sold.dataset.armed; sold.textContent = 'Mark sold'; } }, 3000);
        return;
      }
      /* Sold badge (Oct 29, Martin: 14 days, dealers show off):
         stamp sold_at so seller.html can expire the public badge
         after 14 days. If cf-sold-at-migration.sql has not run
         yet, the column is missing and this update errors — fall
         back to status-only so Mark sold never breaks, and
         seller.html treats a sold row with no sold_at as still
         in-window. Dashboard forever: the row stays in My ads
         with the Sold pill, whatever the public window does. */
      client.from('listings').update({ status: 'sold', sold_at: new Date().toISOString() }).eq('id', sold.dataset.cfSold).then(function (res) {
        if (res.error && /sold_at/i.test(res.error.message || '')) {
          return client.from('listings').update({ status: 'sold' }).eq('id', sold.dataset.cfSold);
        }
        return res;
      }).then(function (res) {
        if (res && res.error) { say('Could not mark sold: ' + res.error.message); return; }
        say('Marked as sold'); refresh();
      });
      return;
    }
    var del = e.target.closest ? e.target.closest('[data-cf-del]') : null;
    if (del) {
      if (!del.dataset.armed) {
        del.dataset.armed = '1'; del.textContent = 'Confirm?';
        setTimeout(function () { if (del.isConnected) { delete del.dataset.armed; del.textContent = 'Delete'; } }, 3000);
        return;
      }
      var id = del.dataset.cfDel;
      /* Best-effort storage cleanup: collect this ad's photo objects
         BEFORE deleting the row (CASCADE removes the photo rows, so
         their URLs would be gone after). Paths are derived from the
         public URLs (everything after '/listing-photos/'). If this
         collection fails, the row delete still proceeds — orphaned
         objects are cosmetic, the ad itself is gone. Note: storage
         deletes only succeed for objects the deleter owns
         (photos_owner_delete policy), so an admin deleting someone
         else's ad leaves its objects behind — a known gap. */
      var cleanupPaths = [];
      try {
        var lr = await client.from('listings').select('photo_url').eq('id', id).maybeSingle();
        var pr2 = await client.from('listing_photos').select('photo_url').eq('listing_id', id);
        var urls = [];
        if (lr && lr.data && lr.data.photo_url) urls.push(lr.data.photo_url);
        (pr2.data || []).forEach(function (r) { if (r.photo_url) urls.push(r.photo_url); });
        urls.forEach(function (u) {
          var marker = '/listing-photos/';
          var idx = String(u).indexOf(marker);
          if (idx !== -1) {
            var p = String(u).slice(idx + marker.length).split('?')[0];
            try { p = decodeURIComponent(p); } catch (e2) {}
            if (p && cleanupPaths.indexOf(p) === -1) cleanupPaths.push(p);
          }
        });
      } catch (e) {}
      /* Thumbnails: take each photo's -t sibling with it. */
      var tExtraDel = [];
      cleanupPaths.forEach(function (p) {
        var tp = thumbPathFor(p);
        if (tp !== p && cleanupPaths.indexOf(tp) === -1 && tExtraDel.indexOf(tp) === -1) tExtraDel.push(tp);
      });
      cleanupPaths = cleanupPaths.concat(tExtraDel);
      client.from('listings').delete().eq('id', id).then(function (res) {
        if (res.error) { say('Could not delete: ' + res.error.message); return; }
        if (cleanupPaths.length) {
          client.storage.from('listing-photos').remove(cleanupPaths).catch(function () {});
        }
        say('Ad deleted'); refresh();
      });
      return;
    }
    /* Admin -> Users: permanent account delete. Two-tap Confirm,
       same arming pattern as the ad delete. The real deletion runs
       in the cf-admin-delete-user Edge Function — it verifies the
       caller is an admin server-side and holds the service key;
       this handler only passes the target id + session token. */
    var uDel = e.target.closest ? e.target.closest('[data-cf-user-del]') : null;
    if (uDel) {
      if (!uDel.dataset.armed) {
        uDel.dataset.armed = '1'; uDel.textContent = 'Confirm?';
        setTimeout(function () { if (uDel.isConnected) { delete uDel.dataset.armed; uDel.textContent = 'Delete'; } }, 3000);
        return;
      }
      var uid = uDel.dataset.cfUserDel;
      uDel.disabled = true; uDel.textContent = 'Deleting…';
      try {
        var sess = await client.auth.getSession();
        var tok = sess && sess.data && sess.data.session && sess.data.session.access_token;
        if (!tok) throw new Error('no session');
        var resp = await fetch('https://dbgmyvjaavpmernaxnav.functions.supabase.co/cf-admin-delete-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
          body: JSON.stringify({ user_id: uid })
        });
        var out = await resp.json().catch(function () { return {}; });
        if (!resp.ok || !out.ok) throw new Error(out.error || ('HTTP ' + resp.status));
        say('Account deleted'); refresh();
      } catch (err) {
        say('Could not delete account: ' + (err && err.message ? err.message : 'unknown error'));
        uDel.disabled = false; uDel.textContent = 'Delete'; delete uDel.dataset.armed;
      }
      return;
    }
    /* My orders / My boosts — Pending-only delete, own rows only.
       Two-tap confirm, same pattern as the ad delete. The .eq('status',
       'Pending') guard + the SQL policy (own row + Pending only) mean
       an Active order or boost can never be deleted this way — paid
       rows stay as the payment record. Pending orders have no live
       package yet, and Pending boosts have no pin yet, so deleting
       them orphans nothing (listings.order_id is ON DELETE SET NULL
       as a backstop). */
    var oDel = e.target.closest ? e.target.closest('[data-cf-order-del]') : null;
    var bDel = e.target.closest ? e.target.closest('[data-cf-boost-del]') : null;
    if (oDel || bDel) {
      var btn = oDel || bDel;
      if (!btn.dataset.armed) {
        btn.dataset.armed = '1'; btn.textContent = 'Confirm?';
        setTimeout(function () { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'Delete'; } }, 3000);
        return;
      }
      if (oDel) {
        client.from('orders').delete().eq('id', oDel.dataset.cfOrderDel).eq('status', 'Pending').then(function (res) {
          if (res.error) { say('Could not delete order: ' + res.error.message); return; }
          say('Order deleted'); refresh();
        });
      } else {
        client.from('boosts').delete().eq('id', bDel.dataset.cfBoostDel).eq('status', 'Pending').then(function (res) {
          if (res.error) { say('Could not delete boost: ' + res.error.message); return; }
          say('Boost deleted'); refresh();
        });
      }
      return;
    }
    /* Step 5 Boost: open the mBoost modal for a REAL listing. The
       page's demo openBoost(name) path is untouched: this handler
       only runs for real cards (data-cf-boost), and it swaps the
       modal into its real state — fake Pay button hidden, Interac
       reserve button shown, honest note text. */
    var bb = e.target.closest ? e.target.closest('[data-cf-boost]') : null;
    if (bb) {
      boostListing = { id: bb.dataset.cfBoost, title: bb.dataset.cfBoostTitle || 'This ad' };
      var bf = el('boostFor'); if (bf) bf.textContent = boostListing.title;
      var bform = el('boostForm'); if (bform) bform.classList.remove('hidden');
      var bd2 = el('boostDone'); if (bd2) bd2.classList.add('hidden');
      var rd2 = el('boostRealDone'); if (rd2) rd2.classList.add('hidden');
      var fe2 = el('boostRealError'); if (fe2) { fe2.classList.add('hidden'); fe2.textContent = ''; }
      var fakePay2 = el('boostFakePay'); if (fakePay2) fakePay2.style.display = 'none';
      var note2 = el('boostPayNote'); if (note2) note2.textContent = 'Interac e-Transfer only in this build · card checkout comes at launch';
      var rp2 = el('boostRealPay');
      if (rp2) { rp2.style.display = ''; rp2.disabled = false; rp2.textContent = 'Reserve with Interac e-Transfer · $2.99'; }
      try { if (typeof openM === 'function') openM('mBoost'); } catch (e2) {}
      return;
    }
    /* Step 5 Boost: Interac reserve. Inserts the Pending boosts row
       (the database generates the BST code via the step-5 SQL
       default) and shows the honest confirmation + Interac
       instructions. If the BST code cannot be read back, the row is
       rolled back and the real error is shown — a code-less Pending
       boost is never left behind, because Martin could never match
       its payment. No Stripe path exists here by design: while
       BOOST_PAYMENT_LINK is a placeholder, no button may open it. */
    var realPay = e.target.closest ? e.target.closest('#boostRealPay') : null;
    if (realPay) {
      if (!boostListing) {
        /* Stale modal state (reopened without a real target): hand
           the modal back to the page's demo flow, untouched. */
        restoreBoostModalDemo();
        try { if (typeof boostPay === 'function') boostPay(); } catch (e2) {}
        return;
      }
      var user = await getUser(client);
      if (!user) { say('Please log in again to reserve a boost.'); return; }
      realPay.disabled = true;
      var rpOrig = realPay.textContent; realPay.textContent = 'Reserving…';
      var errEl = el('boostRealError');
      if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
      try {
        var ins = await client.from('boosts').insert([{
          listing_id: boostListing.id, buyer_id: user.id,
          amount: BOOST_PRICE, payment_method: 'etransfer', status: 'Pending'
        }]).select('id').single();
        if (ins.error || !ins.data || !ins.data.id) throw ins.error || new Error('Could not reserve the boost.');
        var codeRes = await client.from('boosts').select('payment_ref').eq('id', ins.data.id).maybeSingle();
        var bst = codeRes && codeRes.data && codeRes.data.payment_ref;
        if (codeRes.error || !bst) {
          try { await client.from('boosts').delete().eq('id', ins.data.id); } catch (e2) {}
          throw new Error('The step-5 SQL has not been run yet — boosts need it first (BST codes). Run supabase/cf-boost-migration.sql, then try again.');
        }
        var bform2 = el('boostForm'); if (bform2) bform2.classList.add('hidden');
        var rdone = el('boostRealDone');
        if (rdone) {
          rdone.innerHTML = '<div class="big"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:44px;height:44px;vertical-align:middle"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg></div><h2>Payment sent — Martin activates your boost</h2>' +
            '<p>Send <b>$2.99</b> by Interac e-Transfer to <b>' + esc(BOOST_ADMIN_EMAIL) + '</b> with <b>' + esc(bst) + '</b> in the message.<br>' +
            'Martin activates your boost, usually the same day — it then runs 7 days, pinned first in its category.</p>' +
            '<p class="sub">Boost ref: <b>' + esc(bst) + '</b> · Ad: ' + esc(boostListing.title) + '</p>' +
            '<button class="btn dark" onclick="closeM(\'mBoost\')">Back to my listings</button>';
          rdone.classList.remove('hidden');
          try { playBoostSound(); } catch (e3) {}
        }
        boostListing = null;
        realPay.disabled = false; realPay.textContent = rpOrig;
        say('Boost reserved — ' + bst);
        refresh();
      } catch (err) {
        realPay.disabled = false; realPay.textContent = rpOrig;
        var rmsg = 'Could not reserve the boost: ' + (err && err.message ? err.message : 'Something went wrong.');
        if (errEl) { errEl.textContent = rmsg; errEl.classList.remove('hidden'); }
        else say(rmsg);
      }
      return;
    }
    var viewAd = e.target.closest ? e.target.closest('[data-cf-viewad]') : null;
    if (viewAd) {
      var vd = document.querySelector('[data-cf-adetail="' + viewAd.dataset.cfViewad + '"]');
      if (vd) { vd.hidden = !vd.hidden; viewAd.textContent = vd.hidden ? 'View ad' : 'Hide ad'; }
      return;
    }
    var approve = e.target.closest ? e.target.closest('[data-cf-approve]') : null;
    var reject = e.target.closest ? e.target.closest('[data-cf-reject]') : null;
    var act = e.target.closest ? e.target.closest('[data-cf-order-activate]') : null;
    var soon = e.target.closest ? e.target.closest('[data-cf-order-soon]') : null;
    var exp = e.target.closest ? e.target.closest('[data-cf-order-expire]') : null;
    var bAct = e.target.closest ? e.target.closest('[data-cf-boost-activate]') : null;
    var bExp = e.target.closest ? e.target.closest('[data-cf-boost-expire]') : null;
    var btn = approve || reject || act || soon || exp || bAct || bExp;
    if (!btn) return;
    btn.disabled = true;
    var orig = btn.textContent; btn.textContent = 'Working…';
    var done = function (ok, msg) {
      btn.disabled = false; btn.textContent = orig;
      say(msg);
      if (ok) refresh();
    };
    if (approve) {
      /* Approve clears any old reject reason — but if the
         reject-reason SQL has not run yet, that column write fails,
         so retry as a plain status update rather than blocking an
         approval on a migration. */
      client.from('listings').update({ status: 'active', rejection_reason: null }).eq('id', approve.dataset.cfApprove).then(function (res) {
        if (res.error && res.error.message && res.error.message.indexOf('rejection_reason') !== -1) {
          return client.from('listings').update({ status: 'active' }).eq('id', approve.dataset.cfApprove);
        }
        return res;
      }).then(function (res) {
        if (!res.error) notifyBuyer('notify-buyer-ad-live', { listing_id: approve.dataset.cfApprove });
        done(!res.error, res.error ? 'Approve failed: ' + res.error.message + ' — run the step-4 SQL first?' : 'Ad approved — it is live now');
      });
    } else if (reject) {
      /* Reject reason (Oct 29, option 1): custom text wins, else the
         picked preset. The seller sees it on My ads next to
         Rejected. Category is locked in the editor, so the wrong-
         category presets say "post a NEW ad" — editing this one
         cannot fix the category. */
      var rId = reject.dataset.cfReject, rReason = '';
      try {
        var rSel = document.querySelector('[data-cf-reject-reason="' + rId + '"]');
        var rCus = document.querySelector('[data-cf-reject-custom="' + rId + '"]');
        rReason = (rCus && rCus.value.trim()) || (rSel && rSel.value) || '';
      } catch (e) {}
      client.from('listings').update({ status: 'rejected', rejection_reason: rReason || null }).eq('id', rId).then(function (res) {
        if (!res.error) notifyBuyer('notify-ad-rejected', { listing_id: rId });
        done(!res.error, res.error ? 'Reject failed: ' + res.error.message + ' — run supabase/cf-reject-reason-migration.sql first?' : 'Ad rejected — reason sent to seller: ' + (rReason || 'none'));
      });
    } else if (act) {
      var exp30 = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      client.from('orders').update({ status: 'Active', expires_at: exp30 }).eq('id', act.dataset.cfOrderActivate).then(function (res) {
        if (!res.error) notifyBuyer('notify-buyer-package-live', { order_id: act.dataset.cfOrderActivate });
        done(!res.error, res.error ? 'Activate failed: ' + res.error.message : 'Order activated — live for 30 days');
      });
    } else if (soon) {
      client.from('orders').update({ status: 'Expiring soon' }).eq('id', soon.dataset.cfOrderSoon).then(function (res) {
        done(!res.error, res.error ? 'Update failed: ' + res.error.message : 'Order marked expiring soon');
      });
    } else if (exp) {
      client.from('orders').update({ status: 'Expired' }).eq('id', exp.dataset.cfOrderExpire).then(function (res) {
        done(!res.error, res.error ? 'Update failed: ' + res.error.message : 'Order marked expired');
      });
    } else if (bAct) {
      (async function () {
        try {
          var listingId = bAct.dataset.cfBoostListing;
          /* D2 re-boost extends: if another live boost exists for
             this ad, the new 7 days run from the LATEST expiry, not
             from now — no days lost. */
          var base = Date.now();
          try {
            var ob = await client.from('boosts').select('expires_at').eq('listing_id', listingId).eq('status', 'Active');
            (ob.data || []).forEach(function (r) {
              var ms = new Date(r.expires_at).getTime();
              if (ms > base) base = ms;
            });
          } catch (e2) {}
          var nowIso = new Date().toISOString();
          var newExp = new Date(base + BOOST_DAYS * 24 * 3600 * 1000).toISOString();
          var up = await client.from('boosts').update({ status: 'Active', activated_at: nowIso, expires_at: newExp }).eq('id', bAct.dataset.cfBoostActivate);
          if (up.error) { done(false, 'Activate failed: ' + up.error.message); return; }
          /* listings.boosted is a cache flag only (the marketplace
             pins from cf_effective_boosts, not the flag), so a flag
             failure here is cosmetic and never blocks activation. */
          try { await client.from('listings').update({ boosted: true }).eq('id', listingId); } catch (e2) {}
          done(true, 'Boost activated — live for 7 days');
        } catch (err) {
          done(false, 'Activate failed: ' + (err && err.message ? err.message : 'Something went wrong.'));
        }
      })();
    } else if (bExp) {
      (async function () {
        try {
          var listingId2 = bExp.dataset.cfBoostListing;
          var up2 = await client.from('boosts').update({ status: 'Expired' }).eq('id', bExp.dataset.cfBoostExpire);
          if (up2.error) { done(false, 'Update failed: ' + up2.error.message); return; }
          /* Clear the cache flag only when no other live boost
             remains for this ad. */
          try {
            var ob2 = await client.from('boosts').select('expires_at').eq('listing_id', listingId2).eq('status', 'Active');
            var stillLive = (ob2.data || []).some(function (r) { return new Date(r.expires_at).getTime() > Date.now(); });
            if (!stillLive) await client.from('listings').update({ boosted: false }).eq('id', listingId2);
          } catch (e2) {}
          done(true, 'Boost expired');
        } catch (err) {
          done(false, 'Update failed: ' + (err && err.message ? err.message : 'Something went wrong.'));
        }
      })();
    }
  });

  /* ============ Ad manager v1.3: real Edit + admin search ============ */


  /* Thumbnails (Nov 13, 2026): every uploaded photo also gets a
     640x480 sibling object named <file>-t.jpg. Cards, the carousel
     and other small renders use the thumb; the detail gallery keeps
     the full-size original. Server-side image transforms are not
     enabled on this Supabase plan (403 FeatureNotEnabled), so thumbs
     are made in the browser at upload time. */
  function dashThumbUrlFor(url) {
    try {
      var u = String(url || '');
      if (u.indexOf('/listing-photos/') === -1) return url;
      if (/-t\.(jpe?g|png)$/i.test(u)) return url;
      return u.replace(/\.(jpe?g|png)$/i, '-t.$1');
    } catch (e) { return url; }
  }
  window.CFThumbUrl = window.CFThumbUrl || dashThumbUrlFor;
  function thumbPathFor(path) {
    return String(path).replace(/\.(jpe?g|png)$/i, '-t.$1');
  }
  /* 1200x900 cropper data URL -> 640x480 JPEG blob (null on failure).
     Best-effort by design: a failed thumb never fails a post. */
  function makeThumbBlob(dataUrl) {
    return new Promise(function (resolve) {
      try {
        var img = new Image();
        img.onload = function () {
          try {
            var c = document.createElement('canvas');
            c.width = 640; c.height = 480;
            var ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, 640, 480);
            if (c.toBlob) { c.toBlob(function (b) { resolve(b || null); }, 'image/jpeg', 0.8); }
            else { resolve(dataUrlToBlob(c.toDataURL('image/jpeg', 0.8))); }
          } catch (e) { resolve(null); }
        };
        img.onerror = function () { resolve(null); };
        img.src = dataUrl;
      } catch (e) { resolve(null); }
    });
  }
  /* Fallback: an <img> pointed at a thumb that does not exist (photos
     posted before thumbs) swaps ONCE to the full-size original.
     Capture phase because img error events do not bubble. */
  try {
    if (!window.__cfThumbFallback) {
      window.__cfThumbFallback = true;
      document.addEventListener('error', function (ev) {
        var t = ev && ev.target;
        if (!t || t.tagName !== 'IMG' || t.__cfFullTried) return;
        var s = t.getAttribute('src') || '';
        if (s.indexOf('/listing-photos/') === -1 || !/-t\.(jpe?g|png)$/i.test(s)) return;
        t.__cfFullTried = true;
        t.src = s.replace(/-t(\.(?:jpe?g|png))$/i, '$1');
      }, true);
    }
  } catch (e) {}

  function dataUrlToBlob(dataUrl) {
    try {
      var parts = String(dataUrl).split(',');
      var mime = (parts[0].match(/data:(.*?);/) || [])[1] || 'image/jpeg';
      var bin = atob(parts[1] || '');
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    } catch (e) { return null; }
  }

  function closeRealEditor() {
    realEdit = null;
    var save = el('edSave');
    if (save) { save.onclick = null; save.textContent = 'Save changes'; } /* falls back to the demo saveEditor() */
    var ttl = el('edTitle'); if (ttl) ttl.textContent = 'Edit ad';
    var sub = el('edSub');
    if (sub) sub.textContent = 'Changes go live instantly. Drafts auto-save.';
    var hint = el('photoHint');
    if (hint) hint.textContent = 'Free accounts: up to 8 photos \u00B7 Business: up to 20';
    var extra = el('cfEdPostExtra'); if (extra) extra.style.display = 'none';
    var pv = document.querySelector('#mEditor [onclick*="openAdPreview"]');
    if (pv) pv.style.display = '';
    var cat = el('edCat');
    if (cat) { cat.disabled = false; cat.style.opacity = ''; cat.style.background = ''; }
  }

  function photoTile(url, isCover, isNew, previewKey) {
    var attrs = isNew ? ' data-preview="' + esc(previewKey) + '"' : ' data-url="' + esc(url) + '"';
    return '<div class="ptile' + (isCover ? ' cover' : '') + '"' + attrs + '>' +
      '<img src="' + esc(isNew ? previewKey : url) + '">' +
      '<button class="star" title="Cover photo">&#9733;</button>' +
      '<button class="rm" title="Remove photo">&times;</button></div>';
  }

  /* ---- Post a NEW ad from the dashboard (Nov 14, 2026) ----
     The dashboard editor gains a "new" mode next to its edit mode:
     the Post button opens the same editor with a category picker,
     the Cars/Homes field boxes, a condition + tags row (below),
     package-aware photo caps and the marketplace's insert rules
     (pending queue, auto-moderation attempt, admin email, package
     quota attach). Boost stays on the ad card after posting - the
     dashboard's native flow. Jobs keep their own posting flow on
     the marketplace, so Jobs is not in this category list. */
  var POST_CATS_D = ['Cars', 'Homes', 'Rentals', 'Services', 'Clothes', 'Computers', 'Electronics', 'Home', 'Sports', 'Tools', 'Free'];
  /* Category taxonomy unified Nov 17, 2026 (Martin): ONE list on
     both post forms — marketplace names win (Home, not Home &
     Garden; Clothes, not Fashion; Sports, not Sports & Outdoors;
     Free, not Free Stuff). Pets + Kids & Baby removed from the
     picker (no marketplace categories for them; Kids & Baby is
     demand-gated — add it only if kids/baby ads pile up in Home).
     Jobs stays out of this picker by design (its own flow).
     Computers + Tools added — dashboard posters could not pick
     them before. Old ads saved under the retired names still
     display via CAT_ALIAS in cf-listings.js. */

  function categoryOfPackageD(name) {
    var n = String(name || '');
    if (/dealer/i.test(n)) return 'Cars';
    if (/agent/i.test(n)) return 'Homes';
    if (/rental/i.test(n)) return 'Rentals';
    if (/service/i.test(n)) return 'Services';
    if (/job/i.test(n)) return 'Jobs';
    return null;
  }
  function packageLimitForD(order) {
    var n = String((order && order.package) || '').toLowerCase();
    if (/unlimited/.test(n)) return null;
    if (/starter/.test(n)) return 10;
    if (/plus/.test(n)) return 30;
    if (/single|solo/.test(n)) return 1;
    return null;
  }
  function pkgDefaultForD(orders, category) {
    var now = new Date();
    var cands = (orders || []).filter(function (o) {
      return o && o.status === 'Active' && categoryOfPackageD(o.package) === category &&
        (!o.expires_at || new Date(o.expires_at) > now);
    });
    if (!cands.length) return null;
    var pref = null;
    try { pref = localStorage.getItem('cfOrdersDefaultOrderId'); } catch (e) {}
    if (pref) {
      for (var i = 0; i < cands.length; i++) if (String(cands[i].id) === String(pref)) return cands[i];
    }
    return cands[0];
  }
  function capForPostD(orders, category) {
    var has = function (re) {
      return (orders || []).some(function (o) {
        return o && o.status === 'Active' && re.test(String(o.package || '')) &&
          (!o.expires_at || new Date(o.expires_at) > new Date());
      });
    };
    if (category === 'Cars') return has(/dealer/i) ? 20 : 8;
    if (category === 'Homes') return has(/agent/i) ? 40 : 8;
    if (category === 'Rentals') return has(/rental/i) ? 40 : 8;
    return 8;
  }
  function fmtPkgDateD(iso) {
    try {
      return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' });
    } catch (e) { return ''; }
  }
  function postExtraBox() {
    var box = el('cfEdPostExtra');
    if (box) return box;
    var locEl = el('edLoc');
    if (!locEl || !locEl.closest) return null;
    var fld = locEl.closest('.fld');
    if (!fld || !fld.parentNode) return null;
    box = document.createElement('div');
    box.id = 'cfEdPostExtra';
    box.style.display = 'none';
    box.innerHTML =
      '<div class="f2">' +
      '<div class="fld" id="cfEdCondWrap"><label>Condition</label><select id="cfEdCondition"><option>Like new</option><option>Good</option><option>Used</option><option>New</option></select></div>' +
      '<div class="fld"><label>Tags <span style="color:var(--mu);font-weight:400">(optional, up to 6)</span></label><input id="cfEdTags" maxlength="150" placeholder="e.g. leather, vintage \u2014 separate with commas"></div>' +
      '</div>';
    fld.parentNode.insertBefore(box, fld.nextSibling);
    /* Tags parity (Nov 15, 2026): Enter in the tags box adds the
       comma, exactly like the marketplace form's #adTags handler —
       Martin typed a tag, hit Enter, and nothing happened. */
    box.addEventListener('keydown', function (e) {
      if (!e || !e.target || e.target.id !== 'cfEdTags' || e.key !== 'Enter') return;
      e.preventDefault();
      var tv = e.target.value.trim();
      if (tv && tv.charAt(tv.length - 1) !== ',') e.target.value = tv + ', ';
    });
    return box;
  }
  /* Free Stuff posts carry no price (Nov 15, 2026, Martin: "free
     means free — no price"): for that category the price field
     hides entirely and the save below stores 0 without asking. */
  function syncFreePriceD() {
    var p = el('edPrice');
    if (!p) return;
    var wrap = p.closest ? p.closest('.fld') : null;
    var isFree = !!(realEdit && (realEdit.category === 'Free' || realEdit.category === 'Free Stuff'));
    if (wrap) wrap.style.display = isFree ? 'none' : '';
  }
  function syncPostExtraD(category) {
    var box = postExtraBox();
    if (!box) return;
    box.style.display = (realEdit && realEdit.mode === 'new') ? '' : 'none';
    var cw = el('cfEdCondWrap');
    if (cw) cw.style.display = (category === 'Cars' || category === 'Homes' || category === 'Rentals') ? 'none' : '';
  }
  function syncPostSubD(category) {
    var sub = el('edSub');
    if (!sub || !realEdit) return;
    var ord = pkgDefaultForD(realEdit.orders, category);
    var txt;
    if (ord) {
      txt = 'Posting under your ' + (ord.package || 'package');
      if (ord.amount != null && !isNaN(Number(ord.amount))) txt += ' \u2014 $' + Math.round(Number(ord.amount)) + '/mo';
      if (ord.expires_at) txt += ', active until ' + fmtPkgDateD(ord.expires_at);
      txt += '.';
    } else {
      txt = 'Your ad goes to the approval queue when you post.';
    }
    if (category === 'Cars') {
      var dOrd = pkgDefaultForD(realEdit.orders, 'Cars');
      txt += (dOrd && /dealer/i.test(String(dOrd.package || ''))) ? ' Posting as an automotive dealer.' : ' Posting as a private seller.';
    }
    sub.textContent = txt;
  }
  function syncPostCapD(category) {
    if (!realEdit) return;
    realEdit.limit = capForPostD(realEdit.orders, category);
    var hint = el('photoHint');
    if (hint) hint.textContent = 'Up to ' + realEdit.limit + ' photos for this ad \u00B7 tap \u2605 for cover';
  }
  function onPostCatChangeD() {
    if (!realEdit || realEdit.mode !== 'new') return;
    var cat = el('edCat');
    var category = cat ? cat.value : realEdit.category;
    realEdit.category = category;
    fillEditorCarFields({ category: category, specs: null });
    fillEditorHomeFields({ category: category, specs: null });
    fillEditorSvcFields({ category: category, specs: null });
    syncPostExtraD(category);
    syncPostSubD(category);
    syncPostCapD(category);
    syncFreePriceD();
  }
  async function openRealPost() {
    var client = getClient();
    if (!client) { say('Please log in first.'); return; }
    var user = await getUser(client);
    if (!user) { say('Please log in first.'); return; }
    var isAdv = false;
    try {
      var pr = await client.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (pr && pr.data && pr.data.role === 'advertiser') isAdv = true;
    } catch (e) {}
    var myOrders = [];
    try {
      var orr = await client.from('orders')
        .select('id,package,amount,status,expires_at,created_at')
        .eq('buyer_id', user.id).order('created_at', { ascending: false }).limit(50);
      if (orr && orr.data) myOrders = orr.data;
    } catch (e2) {}
    var startCat = 'Cars';
    for (var ci = 0; ci < POST_CATS_D.length; ci++) {
      if (pkgDefaultForD(myOrders, POST_CATS_D[ci])) { startCat = POST_CATS_D[ci]; break; }
    }
    realEdit = { id: null, mode: 'new', uid: user.id, origUrls: [], newFiles: {}, limit: 8, category: startCat, isAdvertiser: isAdv, orders: myOrders, origSellerType: '' };
    var edTitle = el('edTitle'); if (edTitle) edTitle.textContent = 'Post an ad';
    var name = el('edName'); if (name) name.value = '';
    var price = el('edPrice'); if (price) price.value = '';
    var desc = el('edDesc'); if (desc) desc.value = '';
    var loc = el('edLoc'); if (loc) loc.value = 'Mississauga, ON';
    var cat = el('edCat');
    if (cat) {
      cat.innerHTML = POST_CATS_D.map(function (c) { return '<option>' + c + '</option>'; }).join('');
      cat.value = startCat;
      cat.disabled = false; cat.style.opacity = ''; cat.style.background = '';
      if (!cat.dataset.cfPostBound) {
        cat.dataset.cfPostBound = '1';
        cat.addEventListener('change', onPostCatChangeD);
      }
    }
    postExtraBox();
    var tags = el('cfEdTags'); if (tags) tags.value = '';
    var cond = el('cfEdCondition'); if (cond) cond.value = 'Like new';
    var grid = el('pgrid');
    if (grid) grid.innerHTML = '<div class="ptile add" title="Add photo" data-cf-add-photo>+</div>';
    fillEditorCarFields({ category: startCat, specs: null });
    fillEditorHomeFields({ category: startCat, specs: null });
    fillEditorSvcFields({ category: startCat, specs: null });
    syncPostExtraD(startCat);
    syncPostSubD(startCat);
    syncPostCapD(startCat);
    syncFreePriceD();
    var save = el('edSave');
    if (save) { save.textContent = 'Post ad'; save.onclick = function () { realSave(); }; }
    var pv = document.querySelector('#mEditor [onclick*="openAdPreview"]');
    if (pv) pv.style.display = 'none';
    try { if (typeof openM === 'function') openM('mEditor'); } catch (e3) {}
  }
  function notifyAdminPendingAdD(client, payload) {
    try {
      client.auth.getSession().then(function (res) {
        var token = res && res.data && res.data.session ? res.data.session.access_token : null;
        if (!token || !client.supabaseUrl) return;
        fetch(client.supabaseUrl + '/functions/v1/notify-admin-pending-ad', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': client.supabaseKey, 'Authorization': 'Bearer ' + token },
          body: JSON.stringify(payload)
        }).catch(function () {});
      }).catch(function () {});
    } catch (e) {}
  }

  async function openRealEditor(id) {
    var client = getClient();
    if (!client) return;
    var user = await getUser(client);
    if (!user) { say('Please log in first.'); return; }
    var lr = await client.from('listings')
      .select('id,title,description,price,category,location,status,photo_url,seller_id,rejection_reason,specs,address_text,latitude,longitude,show_area_only')
      .eq('id', id).maybeSingle();
    if (lr && lr.error) {
      /* Address columns missing (Photon migration not pasted yet). */
      lr = await client.from('listings')
        .select('id,title,description,price,category,location,status,photo_url,seller_id,rejection_reason,specs')
        .eq('id', id).maybeSingle();
    }
    if (lr && lr.error) {
      /* Specs column missing (Cars migration not pasted yet). */
      lr = await client.from('listings')
        .select('id,title,description,price,category,location,status,photo_url,seller_id,rejection_reason')
        .eq('id', id).maybeSingle();
    }
    if (!lr || !lr.data) { say('Could not load that ad.'); return; }
    var ad = lr.data;
    if (String(ad.seller_id || '') !== String(user.id)) { say('That ad is not yours.'); return; }
    if (['active', 'pending', 'rejected'].indexOf(ad.status) === -1) {
      say('Only active, pending, or rejected ads can be edited — post a new ad for the rest.');
      return;
    }
    var photos = [];
    try {
      var ph = await client.from('listing_photos')
        .select('photo_url,position').eq('listing_id', id).order('position', { ascending: true });
      (ph.data || []).forEach(function (p) { if (p.photo_url) photos.push(p.photo_url); });
    } catch (e) {}
    if (!photos.length && ad.photo_url) photos = [ad.photo_url];
    var limit = 8;
    var isAdv = false;
    try {
      var pr = await client.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (pr && pr.data && pr.data.role === 'advertiser') { limit = 20; isAdv = true; }
    } catch (e2) {}
    try {
      var orr2 = await client.from('orders')
        .select('id,package,amount,status,expires_at,created_at')
        .eq('buyer_id', user.id).order('created_at', { ascending: false }).limit(50);
      if (orr2 && orr2.data) svcOrdersD = orr2.data;
    } catch (e4) {}
    realEdit = { id: id, uid: user.id, origUrls: photos.slice(), newFiles: {}, limit: limit, category: ad.category || '', isAdvertiser: isAdv, origSellerType: (parseCarSpecs(ad.specs).seller_type || ''), origAddr: { text: ad.address_text || '', lat: ad.latitude == null ? null : Number(ad.latitude), lng: ad.longitude == null ? null : Number(ad.longitude), area: !!ad.show_area_only } };
    var edTitle = el('edTitle'); if (edTitle) edTitle.textContent = 'Edit ad';
    var edSub = el('edSub');
    /* Rejected-editor guidance (Oct 29, best-solution build):
       category is LOCKED here on purpose, so say so plainly and
       point at the package + new post instead of a dead dropdown. */
    if (edSub) {
      if (ad.status === 'rejected' && /Services/.test(ad.rejection_reason || '')) {
        edSub.innerHTML = 'Category stays as-is and cannot be changed here. Posting as a business? <a href="advertise.html">Get a services package</a>, then post a new ad under Services.';
      } else if (ad.status === 'rejected') {
        edSub.textContent = 'Category stays as-is and cannot be changed here. Post a new ad in the correct category instead.';
      } else {
        edSub.textContent = 'Saved edits go back for approval before they show again. Category stays as-is.';
      }
    }
    var name = el('edName'); if (name) name.value = ad.title || '';
    var price = el('edPrice'); if (price) price.value = ad.price == null ? '' : String(ad.price);
    var desc = el('edDesc'); if (desc) desc.value = ad.description || '';
    var loc = el('edLoc'); if (loc) loc.value = ad.location || '';
    var cat = el('edCat');
    if (cat) {
      var hasOpt = false;
      for (var ci = 0; ci < cat.options.length; ci++) {
        if (cat.options[ci].text === ad.category || cat.options[ci].value === ad.category) { hasOpt = true; break; }
      }
      if (!hasOpt && ad.category) {
        var opt = document.createElement('option');
        opt.text = ad.category; opt.value = ad.category;
        cat.appendChild(opt);
      }
      cat.value = ad.category || '';
      cat.disabled = true;
      /* Visibly locked, not just functionally locked — no more
         tappable-looking dropdown that goes nowhere. */
      cat.style.opacity = '0.6';
      cat.style.background = '#f1f1f1';
    }
    fillEditorCarFields(ad);
    fillEditorHomeFields(ad);
    fillEditorSvcFields(ad);
    var grid = el('pgrid');
    if (grid) {
      var tiles = photos.map(function (u, i) {
        return photoTile(u, (ad.photo_url ? u === ad.photo_url : i === 0), false, null);
      }).join('');
      grid.innerHTML = tiles + '<div class="ptile add" title="Add photo" data-cf-add-photo>+</div>';
    }
    var save = el('edSave');
    if (save) save.onclick = function () { realSave(); };
    syncFreePriceD();
    try { if (typeof openM === 'function') openM('mEditor'); } catch (e3) {}
  }

  async function realSave() {
    if (!realEdit) { try { if (typeof saveEditor === 'function') saveEditor(); } catch (e) {} return; }
    var client = getClient();
    if (!client) return;
    var st = realEdit;
    var isNew = !!(st && st.mode === 'new');
    if (isNew) {
      var catSel = el('edCat');
      if (catSel && catSel.value) st.category = catSel.value;
    }
    var title = (el('edName') ? el('edName').value : '').trim();
    var priceRaw = (el('edPrice') ? el('edPrice').value : '').replace(/[$,\s]/g, '');
    var price = parseFloat(priceRaw);
    if (!title) { say('Give the ad a title first.'); return; }
    if (st.category === 'Free' || st.category === 'Free Stuff') price = 0;
    if (isNaN(price) || price < 0) { say('Enter a valid price.'); return; }
    /* Cars fields v1: the category is locked in the editor, so a
       Cars ad always carries specs — re-collect and re-validate
       the required five before anything uploads. */
    var edCarSpecs = null;
    if (st.category === 'Cars') {
      edCarSpecs = collectEditorCarSpecs();
      if (isNew) {
        var dOrd2 = pkgDefaultForD(st.orders, 'Cars');
        edCarSpecs.seller_type = (dOrd2 && /dealer/i.test(String(dOrd2.package || ''))) ? 'dealer' : 'private';
      } else if (st.origSellerType) {
        edCarSpecs.seller_type = st.origSellerType;
      }
      var edCarErr = validateCarSpecsD(edCarSpecs);
      if (edCarErr) { say(edCarErr); return; }
    }
    var edHomeSpecs = null;
    if (st.category === 'Homes' || st.category === 'Rentals') {
      edHomeSpecs = collectEditorHomeSpecs(st.category);
      var edHomeErr = validateHomeSpecsD(edHomeSpecs, st.category);
      if (edHomeErr) { say(edHomeErr); return; }
    }
    var edSvcSpecs = null;
    if (st.category === 'Services') {
      edSvcSpecs = collectEditorSvcSpecs();
    }
    /* Photon address (edit fix, Nov 23, 2026): Homes & Rentals
       only. For edits, only CHANGED fields ride the patch, so a
       price-only edit stays byte-identical to before and keeps
       its auto-approve behaviour. A fresh pick carries coords; a
       hand-typed address keeps the text but drops stale coords;
       an emptied field clears all three. */
    var edAddrFields = null;
    if (st.category === 'Homes' || st.category === 'Rentals') {
      var aInp = el('cfEdAddr');
      var aTxt = aInp ? aInp.value.trim() : '';
      var aArea = !!(el('cfEdAreaOnly') && el('cfEdAreaOnly').checked);
      var aPick = window.__cfEdAddrPick;
      var aLat = null, aLng = null;
      if (aTxt && aPick && aPick.text === aTxt) { aLat = aPick.lat; aLng = aPick.lng; }
      if (isNew) {
        edAddrFields = { address_text: aTxt || null, latitude: aLat, longitude: aLng, show_area_only: aArea };
      } else {
        var oA = st.origAddr || { text: '', lat: null, lng: null, area: false };
        edAddrFields = {};
        if (aTxt !== oA.text) edAddrFields.address_text = aTxt || null;
        if (aLat !== oA.lat) edAddrFields.latitude = aLat;
        if (aLng !== oA.lng) edAddrFields.longitude = aLng;
        if (aArea !== oA.area) edAddrFields.show_area_only = aArea;
        if (!Object.keys(edAddrFields).length) edAddrFields = null;
      }
    }
    var grid = el('pgrid');
    var tiles = grid ? grid.querySelectorAll('.ptile:not(.add)') : [];
    var finalExisting = [];
    var toUpload = [];
    var cover = null;
    for (var ti = 0; ti < tiles.length; ti++) {
      var t = tiles[ti];
      var isCover = t.classList.contains('cover');
      if (t.dataset && t.dataset.url) {
        finalExisting.push(t.dataset.url);
        if (isCover) cover = t.dataset.url;
      } else if (t.dataset && t.dataset.preview && st.newFiles[t.dataset.preview]) {
        toUpload.push({ file: st.newFiles[t.dataset.preview], preview: t.dataset.preview });
        if (isCover) cover = '__NEW__' + (toUpload.length - 1);
      }
    }
    if (!tiles.length) cover = null;
    var uploaded = [];
    var thumbPaths = [];
    try {
      for (var ui = 0; ui < toUpload.length; ui++) {
        var blob = dataUrlToBlob(toUpload[ui].preview);
        if (!blob) throw new Error('Could not read a new photo. Please pick it again.');
        var path = st.uid + '/' + Date.now() + '-' + ui + '.jpg';
        var up = await client.storage.from('listing-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
        if (up.error) throw up.error;
        var pub = client.storage.from('listing-photos').getPublicUrl(path);
        var purl = pub && pub.data && pub.data.publicUrl ? pub.data.publicUrl : null;
        if (!purl) throw new Error('Could not get a public link for a new photo.');
        uploaded.push({ path: path, url: purl });
        /* Thumbnail sibling (best-effort; never fails the save). */
        try {
          var tBlob2 = await makeThumbBlob(toUpload[ui].preview);
          if (tBlob2) {
            var tPath2 = thumbPathFor(path);
            var tup2 = await client.storage.from('listing-photos').upload(tPath2, tBlob2, { contentType: 'image/jpeg', upsert: false });
            if (!tup2.error) thumbPaths.push(tPath2);
          }
        } catch (te2) {}
      }
    } catch (upErr) {
      if (uploaded.length) {
        try { await client.storage.from('listing-photos').remove(uploaded.map(function (u) { return u.path; }).concat(thumbPaths)); } catch (e2) {}
      }
      say('Could not save photos: ' + (upErr && upErr.message ? upErr.message : 'Something went wrong.'));
      return;
    }
    var finalUrls = [];
    for (var fi = 0; fi < tiles.length; fi++) {
      var ft = tiles[fi];
      if (ft.dataset && ft.dataset.url) finalUrls.push(ft.dataset.url);
      else if (ft.dataset && ft.dataset.preview) {
        var match = uploaded.filter(function (r) { return r.url; });
        /* New tiles appear in tile order, same as toUpload/uploaded order. */
        var slot = 0;
        for (var sj = 0; sj < fi; sj++) {
          var pt = tiles[sj];
          if (pt.dataset && pt.dataset.preview) slot++;
        }
        if (match[slot]) finalUrls.push(match[slot].url);
      }
    }
    finalUrls = finalUrls.filter(Boolean);
    if (cover && String(cover).indexOf('__NEW__') === 0) {
      var slotN = parseInt(String(cover).slice(7), 10);
      cover = uploaded[slotN] ? uploaded[slotN].url : null;
    }
    if (!cover && finalUrls.length) cover = finalUrls[0];
    if (isNew) {
      var user2 = null;
      try { user2 = await getUser(client); } catch (e9) {}
      var condVal = '';
      if (st.category !== 'Cars' && st.category !== 'Homes' && st.category !== 'Rentals') {
        var condEl = el('cfEdCondition');
        condVal = condEl ? condEl.value : 'Like new';
      }
      var tagList = null;
      var tagsEl = el('cfEdTags');
      if (tagsEl && tagsEl.value.trim()) {
        var seenT = {}, outT = [];
        tagsEl.value.split(',').forEach(function (piece) {
          var t = piece.trim().replace(/^#+/, '').toLowerCase();
          if (t && t.length <= 24 && !seenT[t]) { seenT[t] = 1; if (outT.length < 6) outT.push(t); }
        });
        if (outT.length) tagList = outT;
      }
      var newRow = {
        seller_id: st.uid, title: title, description: el('edDesc') ? el('edDesc').value : '',
        price: price, category: st.category, condition: condVal,
        location: el('edLoc') ? el('edLoc').value : '', status: 'pending',
        boosted: false, photo_url: cover
      };
      if (tagList) newRow.tags = tagList;
      if (edCarSpecs) newRow.specs = edCarSpecs;
      if (edHomeSpecs) newRow.specs = edHomeSpecs;
      if (edSvcSpecs) newRow.specs = edSvcSpecs;
      if (edAddrFields) {
        newRow.address_text = edAddrFields.address_text;
        newRow.latitude = edAddrFields.latitude;
        newRow.longitude = edAddrFields.longitude;
        newRow.show_area_only = edAddrFields.show_area_only;
      }
      /* Package quota: when the category's default package is a
         finite plan and it is already full, the ad parks on the
         order and goes live at renewal - the marketplace rule. */
      var quotaFull = false;
      var defOrd = pkgDefaultForD(st.orders, st.category);
      var defLimit = defOrd ? packageLimitForD(defOrd) : null;
      if (defOrd && defLimit != null) {
        try {
          var cnt = await client.from('listings').select('id', { count: 'exact', head: true })
            .eq('seller_id', st.uid).eq('category', st.category)
            .in('status', ['active', 'pending']).gte('created_at', defOrd.created_at);
          if (cnt && typeof cnt.count === 'number' && cnt.count >= defLimit) {
            newRow.pending_pkg_order_id = defOrd.id;
            quotaFull = true;
          }
        } catch (e10) {}
      }
      /* Package-holder auto-approve (Nov 25, 2026 — Martin's ruling:
         package holders post straight to live). pkgDefaultForD is
         this file's own match: an Active, unexpired order whose
         package label maps to this category (categoryOfPackageD).
         When one matches and the finite-package quota is not full,
         the ad inserts as 'active' instead of 'pending' — the
         step-4 guard trigger permits that one transition for
         matching package holders once the migration
         cf-pkg-autoapprove-migration.sql has run (it ships with
         this version). A quota-full ad
         stays parked on its order exactly as today, and everyone
         else queues exactly as today. */
      var pkgAutoApproved = !!defOrd && !quotaFull;
      if (pkgAutoApproved) newRow.status = 'active';
      var ins = await client.from('listings').insert([newRow]).select('id').single();
      if (ins.error && (edCarSpecs || edHomeSpecs || edSvcSpecs) && /specs/i.test(ins.error.message || '')) {
        delete newRow.specs;
        ins = await client.from('listings').insert([newRow]).select('id').single();
      }
      if (ins.error && /pending_pkg_order_id/i.test(ins.error.message || '')) {
        delete newRow.pending_pkg_order_id;
        quotaFull = false;
        ins = await client.from('listings').insert([newRow]).select('id').single();
      }
      if (ins.error && edAddrFields && /address_text|latitude|longitude|show_area_only/i.test(ins.error.message || '')) {
        delete newRow.address_text; delete newRow.latitude; delete newRow.longitude; delete newRow.show_area_only;
        ins = await client.from('listings').insert([newRow]).select('id').single();
      }
      if (ins.error || !ins.data || !ins.data.id) {
        say('Could not post: ' + (ins.error ? ins.error.message : 'Something went wrong.'));
        return;
      }
      var newId = ins.data.id;
      if (finalUrls.length) {
        var photoRows = finalUrls.map(function (u, idx) { return { listing_id: newId, photo_url: u, position: idx }; });
        var phIns = await client.from('listing_photos').insert(photoRows);
        if (phIns.error) {
          try { await client.from('listings').delete().eq('id', newId); } catch (e11) {}
          try { await client.storage.from('listing-photos').remove(uploaded.map(function (u) { return u.path; }).concat(thumbPaths)); } catch (e12) {}
          say('Could not post: ' + phIns.error.message);
          return;
        }
      }
      /* A package-holder ad was already inserted active (above) —
         it skips the CFAutoMod safety net; the net still gets its
         chance on every other new ad, exactly as before. */
      var autoApproved = pkgAutoApproved;
      try {
        if (!autoApproved && user2 && window.CFAutoMod && typeof window.CFAutoMod.tryAutoApprove === 'function') {
          autoApproved = await window.CFAutoMod.tryAutoApprove(client, user2, newId, {
            title: title, description: newRow.description, category: st.category, price: price, photo_url: cover
          });
        }
      } catch (e13) { if (!pkgAutoApproved) autoApproved = false; }
      if (!autoApproved) {
        notifyAdminPendingAdD(client, { listing_id: newId, title: title, category: st.category, price: price });
      }
      closeRealEditor();
      try { if (typeof closeM === 'function') closeM('mEditor'); } catch (e14) {}
      say(autoApproved ? 'Ad posted \u2014 live now' : (quotaFull ? 'Ad posted \u2014 it goes live when your package renews' : 'Ad posted \u2014 pending approval'));
      refresh();
      return;
    }
    var removed = st.origUrls.filter(function (u) { return finalUrls.indexOf(u) === -1; });
    try {
      if (removed.length) {
        await client.from('listing_photos').delete().eq('listing_id', st.id).in('photo_url', removed);
        var paths = [];
        removed.forEach(function (u) {
          var marker = '/listing-photos/';
          var idx = String(u).indexOf(marker);
          if (idx !== -1) {
            var p = String(u).slice(idx + marker.length).split('?')[0];
            try { p = decodeURIComponent(p); } catch (e3) {}
            if (p && paths.indexOf(p) === -1) paths.push(p);
          }
        });
        /* Thumbnails: drop each removed photo's -t sibling too. */
        var tExtras = [];
        paths.forEach(function (p) {
          var tp = thumbPathFor(p);
          if (tp !== p && paths.indexOf(tp) === -1 && tExtras.indexOf(tp) === -1) tExtras.push(tp);
        });
        paths = paths.concat(tExtras);
        if (paths.length) {
          try { await client.storage.from('listing-photos').remove(paths); } catch (e4) {}
        }
      }
    } catch (e5) {}
    try {
      var newRows = uploaded.map(function (u, i) {
        return { listing_id: st.id, photo_url: u.url, position: 1000 + i };
      });
      if (newRows.length) {
        var ins = await client.from('listing_photos').insert(newRows);
        if (ins.error) throw ins.error;
      }
    } catch (e6) {
      say('Photos saved, but the photo list could not be updated: ' + (e6 && e6.message ? e6.message : ''));
    }
    var upd = {
      title: title,
      price: price,
      description: el('edDesc') ? el('edDesc').value : '',
      location: el('edLoc') ? el('edLoc').value : '',
      photo_url: cover,
      status: 'pending'
    };
    if (edCarSpecs) upd.specs = edCarSpecs;
    if (edHomeSpecs) upd.specs = edHomeSpecs;
    if (edSvcSpecs) upd.specs = edSvcSpecs;
    if (edAddrFields) { Object.keys(edAddrFields).forEach(function (k) { upd[k] = edAddrFields[k]; }); }
    var res = await client.from('listings').update(upd).eq('id', st.id);
    if (res.error && (edCarSpecs || edHomeSpecs || edSvcSpecs) && /specs/i.test(res.error.message || '')) {
      /* Specs column missing: save everything else (same graceful
         pattern as the post path). */
      try { console.warn('[ClassiFlip] listings.specs update failed - saving without specs.'); } catch (e8) {}
      delete upd.specs;
      res = await client.from('listings').update(upd).eq('id', st.id);
    }
    if (res.error && edAddrFields && /address_text|latitude|longitude|show_area_only/i.test(res.error.message || '')) {
      /* Address columns missing: save everything else. */
      delete upd.address_text; delete upd.latitude; delete upd.longitude; delete upd.show_area_only;
      res = await client.from('listings').update(upd).eq('id', st.id);
    }
    if (res.error) { say('Could not save: ' + res.error.message); return; }
    closeRealEditor();
    try { if (typeof closeM === 'function') closeM('mEditor'); } catch (e7) {}
    say('Edits saved — back for approval');
    refresh();
  }

  async function runAdminSearch() {
    var input = el('adminSearchInput');
    var box = el('adminSearchResults');
    if (!input || !box) return;
    var q = (input.value || '').trim();
    if (q.length < 2) { box.innerHTML = '<div class="notice">Type at least 2 characters — a name, an email, or part of a phone number.</div>'; return; }
    var client = getClient();
    if (!client) return;
    box.innerHTML = '<div class="notice">Searching…</div>';
    var pat = '%' + q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/,/g, '') + '%';
    var sellerIds = [];
    var sellerLabel = {};
    try {
      var orr = await client.from('orders')
        .select('buyer_id,business_name,buyer_name,buyer_email,buyer_phone,order_number,status')
        .or('business_name.ilike.' + pat + ',buyer_email.ilike.' + pat + ',buyer_phone.ilike.' + pat)
        .limit(50);
      (orr.data || []).forEach(function (o) {
        if (o.buyer_id && sellerIds.indexOf(o.buyer_id) === -1) sellerIds.push(o.buyer_id);
        if (o.buyer_id && !sellerLabel[o.buyer_id]) sellerLabel[o.buyer_id] = o.business_name || o.buyer_name || o.buyer_email || o.buyer_id;
      });
    } catch (e) {}
    try {
      var prr = await client.from('profiles')
        .select('id,display_name,email')
        .or('display_name.ilike.' + pat + ',email.ilike.' + pat)
        .limit(50);
      (prr.data || []).forEach(function (p) {
        if (p.id && sellerIds.indexOf(p.id) === -1) sellerIds.push(p.id);
        sellerLabel[p.id] = p.display_name || p.email || p.id;
      });
    } catch (e2) {}
    try {
      var bpr = await client.from('business_profiles')
        .select('id,display_name')
        .ilike('display_name', pat)
        .limit(50);
      (bpr.data || []).forEach(function (b) {
        if (b.id && sellerIds.indexOf(b.id) === -1) sellerIds.push(b.id);
        sellerLabel[b.id] = b.display_name || sellerLabel[b.id];
      });
    } catch (e3) {}
    if (!sellerIds.length) {
      box.innerHTML = '<div class="notice">No business found for "' + esc(q) + '". Try another spelling, an email, or the last 4 digits of the phone number.</div>';
      return;
    }
    var ads = [];
    try {
      var ar = await client.from('listings')
        .select('id,title,price,status,category,location,created_at,seller_id')
        .in('seller_id', sellerIds).order('created_at', { ascending: false }).limit(100);
      if (ar && ar.data) ads = ar.data;
    } catch (e4) {}
    if (!ads.length) {
      box.innerHTML = '<div class="notice">Found ' + sellerIds.length + ' matching account(s) but no ads on file for them.</div>';
      return;
    }
    box.innerHTML = ads.map(function (x) {
      return '<div class="lcard">' +
        '<div class="inf"><div class="t">' + esc(x.title) + ' ' + pillFor(x.status) + '</div>' +
        '<div class="p">' + money(x.price) + '</div>' +
        '<div class="s">' + esc(sellerLabel[x.seller_id] || x.seller_id) + ' · ' + esc(x.category || '') + ' · ' + esc(x.location || '') + ' · ' + shortDate(x.created_at) + '</div></div>' +
        '<div class="acts"><button class="btn gho danger" data-cf-del="' + esc(x.id) + '">Delete</button></div></div>';
    }).join('');
  }

  /* Dashboard photo cropper (Nov 15, 2026): parity with the
     marketplace post form. Until now a photo picked in this editor
     locked in raw — no framing step — while the marketplace walks
     every photo through the 4:3 cropper. Same flow here: pick,
     drag to position, zoom, Use this crop (1200x900 JPEG) or Skip.
     The save path already uploads each tile's preview data URL, so
     a confirmed crop flows through unchanged, thumbs included. */
  var dCropQueue = [], dCropCurrent = null, dCropImg = null,
      dCropZoom = 1, dCropOX = 0, dCropOY = 0, dCropDrag = null,
      dCropUi = null;
  function dCropBuild() {
    if (dCropUi) return dCropUi;
    var st = document.createElement('style');
    st.textContent =
      '.dcrop-back{position:fixed;inset:0;background:rgba(6,17,34,.66);z-index:9999;display:none;align-items:center;justify-content:center;padding:16px}' +
      '.dcrop-back.open{display:flex}' +
      '.dcrop-card{background:#fff;border-radius:18px;width:min(480px,100%);max-height:92vh;overflow:auto;padding:20px}' +
      '.dcrop-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}' +
      '.dcrop-head h3{margin:0;font-size:19px;color:#0a2540}' +
      '.dcrop-x{border:0;background:none;font-size:24px;line-height:1;cursor:pointer;color:#5a6b7d;padding:4px 8px}' +
      '.dcrop-stage{width:100%;max-width:420px;margin:0 auto;aspect-ratio:4/3;position:relative;overflow:hidden;border-radius:14px;background:#111;touch-action:none}' +
      '.dcrop-stage img{position:absolute;left:50%;top:50%;cursor:grab;user-select:none;-webkit-user-drag:none;max-width:none;will-change:transform}' +
      '.dcrop-hint{margin:10px 0 0;text-align:center;color:#5a6b7d;font-size:13px}' +
      '.dcrop-zoom{display:flex;align-items:center;gap:10px;margin-top:14px;font-size:13px;color:#1c2b3a}' +
      '.dcrop-zoom input{flex:1;accent-color:#f97316}' +
      '.dcrop-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}' +
      '.dcrop-btn{border-radius:9px;padding:11px 18px;font-weight:700;font-size:14px;cursor:pointer;border:1px solid #d5dce4;background:#fff;color:#0a2540}' +
      '.dcrop-btn.primary{background:#f97316;border-color:#f97316;color:#fff}';
    document.head.appendChild(st);
    var back = document.createElement('div');
    back.className = 'dcrop-back';
    back.id = 'dCropBack';
    back.innerHTML =
      '<div class="dcrop-card">' +
      '<div class="dcrop-head"><h3 id="dCropTitle">Crop photo</h3><button type="button" class="dcrop-x" id="dCropClose" aria-label="Close">&times;</button></div>' +
      '<div class="dcrop-stage" id="dCropStage"><img id="dCropImg" alt=""></div>' +
      '<p class="dcrop-hint">Drag the photo to position it. The wide frame shown is exactly what buyers will see.</p>' +
      '<div class="dcrop-zoom"><span>Zoom</span><input type="range" id="dCropZoom" min="100" max="300" value="100" aria-label="Zoom"><span id="dCropZoomVal">100%</span></div>' +
      '<div class="dcrop-actions"><button type="button" class="dcrop-btn" id="dCropSkip">Skip photo</button><button type="button" class="dcrop-btn primary" id="dCropUse">Use this crop</button></div>' +
      '</div>';
    document.body.appendChild(back);
    dCropUi = back;
    document.getElementById('dCropZoom').addEventListener('input', function (e) {
      dCropZoom = Number(e.target.value) / 100; dCropClamp(); dCropRender();
    });
    var stage = document.getElementById('dCropStage');
    stage.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      dCropDrag = { x: e.clientX - dCropOX, y: e.clientY - dCropOY };
      if (stage.setPointerCapture) { try { stage.setPointerCapture(e.pointerId); } catch (err) {} }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!dCropDrag) return;
      dCropOX = e.clientX - dCropDrag.x; dCropOY = e.clientY - dCropDrag.y;
      dCropClamp(); dCropRender();
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      stage.addEventListener(ev, function () { dCropDrag = null; });
    });
    document.getElementById('dCropUse').addEventListener('click', dCropUse);
    document.getElementById('dCropSkip').addEventListener('click', dCropSkip);
    document.getElementById('dCropClose').addEventListener('click', dCropSkip);
    return back;
  }
  function dCropDims() {
    var s = document.getElementById('dCropStage');
    return { w: (s && s.clientWidth) || 320, h: (s && s.clientHeight) || 240 };
  }
  function dCropBase() {
    if (!dCropImg) return 1;
    var d = dCropDims();
    return Math.max(d.w / (dCropImg.naturalWidth || 1), d.h / (dCropImg.naturalHeight || 1));
  }
  function dCropClamp() {
    if (!dCropImg) return;
    var d = dCropDims(), b = dCropBase() * dCropZoom,
        dw = (dCropImg.naturalWidth || 1) * b, dh = (dCropImg.naturalHeight || 1) * b;
    dCropOX = Math.max(-(dw - d.w) / 2, Math.min((dw - d.w) / 2, dCropOX));
    dCropOY = Math.max(-(dh - d.h) / 2, Math.min((dh - d.h) / 2, dCropOY));
  }
  function dCropRender() {
    var img = document.getElementById('dCropImg');
    if (!img || !dCropImg) return;
    var b = dCropBase() * dCropZoom;
    img.style.width = ((dCropImg.naturalWidth || 1) * b) + 'px';
    img.style.height = ((dCropImg.naturalHeight || 1) * b) + 'px';
    img.style.transform = 'translate(-50%,-50%) translate(' + dCropOX + 'px,' + dCropOY + 'px)';
    var zv = document.getElementById('dCropZoomVal');
    if (zv) zv.textContent = Math.round(dCropZoom * 100) + '%';
  }
  function dCropClose() {
    if (dCropUi) dCropUi.classList.remove('open');
    if (dCropCurrent && dCropCurrent.url) { try { URL.revokeObjectURL(dCropCurrent.url); } catch (e) {} }
    dCropCurrent = null; dCropImg = null;
  }
  function dCropNext() {
    if (dCropCurrent) return;
    if (!realEdit) { dCropQueue = []; return; }
    if (!dCropQueue.length) return;
    var item = dCropQueue.shift();
    var img = new Image();
    img.onload = function () {
      dCropCurrent = item; dCropImg = img;
      dCropZoom = 1; dCropOX = 0; dCropOY = 0;
      var z = document.getElementById('dCropZoom'); if (z) z.value = 100;
      var view = document.getElementById('dCropImg'); if (view) view.src = item.url;
      var t = document.getElementById('dCropTitle');
      if (t) t.textContent = 'Crop photo' + (dCropQueue.length ? ' \u2014 ' + dCropQueue.length + ' more after this' : '');
      dCropBuild().classList.add('open');
      setTimeout(dCropRender, 0);
    };
    img.onerror = function () { dCropNext(); };
    img.src = item.url;
  }
  function dCropSkip() { dCropClose(); dCropNext(); }
  function dCropUse() {
    if (!dCropImg) return;
    var d = dCropDims(), b = dCropBase() * dCropZoom,
        dw = (dCropImg.naturalWidth || 1) * b, dh = (dCropImg.naturalHeight || 1) * b,
        left = d.w / 2 - dw / 2 + dCropOX, top = d.h / 2 - dh / 2 + dCropOY,
        sx = Math.max(0, (0 - left) / b), sy = Math.max(0, (0 - top) / b),
        sw = Math.min(d.w / b, (dCropImg.naturalWidth || 1) - sx),
        sh = Math.min(d.h / b, (dCropImg.naturalHeight || 1) - sy);
    var c = document.createElement('canvas');
    c.width = 1200; c.height = 900;
    c.getContext('2d').drawImage(dCropImg, sx, sy, sw, sh, 0, 0, 1200, 900);
    var dataUrl = c.toDataURL('image/jpeg', 0.82);
    dCropClose();
    dCropAddTile(dataUrl);
    dCropNext();
  }
  function dCropAddTile(dataUrl) {
    if (!realEdit) return;
    var g = el('pgrid'); if (!g) return;
    var count = g.querySelectorAll('.ptile:not(.add)').length;
    if (count >= realEdit.limit) {
      say('Photo limit reached for this account.');
      dCropQueue = []; dCropClose();
      return;
    }
    realEdit.newFiles[dataUrl] = dataUrlToBlob(dataUrl);
    var addTile = g.querySelector('.ptile.add');
    var tile = document.createElement('div');
    tile.className = 'ptile';
    tile.dataset.preview = dataUrl;
    tile.innerHTML = '<img src="' + dataUrl + '"><button class="star" title="Cover photo">&#9733;</button><button class="rm" title="Remove photo">&times;</button>';
    if (addTile) g.insertBefore(tile, addTile); else g.appendChild(tile);
  }
  function dCropEnqueue(files) {
    dCropBuild();
    var g = el('pgrid');
    var count = g ? g.querySelectorAll('.ptile:not(.add)').length : 0;
    var room = realEdit ? Math.max(0, realEdit.limit - count - dCropQueue.length - (dCropCurrent ? 1 : 0)) : 0;
    var added = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f || !f.type || f.type.indexOf('image/') !== 0) continue;
      if (added >= room) { say('Photo limit reached for this account.'); break; }
      dCropQueue.push({ url: URL.createObjectURL(f) });
      added++;
    }
    dCropNext();
  }
  /* Escape skips the current photo — capture phase so it beats
     the editor's own Escape-closes-the-editor handler below. */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dCropUi && dCropUi.classList.contains('open')) {
      e.stopPropagation();
      dCropSkip();
    }
  }, true);

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var viewBtn = t.closest('[data-cf-view]');
    if (viewBtn) {
      dashView = viewBtn.dataset.cfView === 'grid' ? 'grid' : 'list';
      refresh();
      return;
    }
    var editBtn = t.closest('[data-cf-edit]');
    if (editBtn) { openRealEditor(editBtn.dataset.cfEdit); return; }
    var addBtn = t.closest('[data-cf-add-photo]');
    if (addBtn && realEdit) {
      var grid = el('pgrid');
      var count = grid ? grid.querySelectorAll('.ptile:not(.add)').length : 0;
      if (count >= realEdit.limit) { say('Photo limit reached for this account.'); return; }
      var fi = document.createElement('input');
      fi.type = 'file'; fi.accept = 'image/*'; fi.multiple = true; fi.style.display = 'none';
      document.body.appendChild(fi);
      fi.addEventListener('change', function () {
        var files = fi.files || [];
        var imgs = [];
        for (var k = 0; k < files.length; k++) {
          if (files[k] && files[k].type && files[k].type.indexOf('image/') === 0) imgs.push(files[k]);
        }
        try { document.body.removeChild(fi); } catch (e5) {}
        if (imgs.length) dCropEnqueue(imgs);
      });
      fi.click();
      return;
    }
    var mx = t.closest('#mEditor .mx');
    if (mx && realEdit) { closeRealEditor(); return; }
    var sBtn = t.closest('[data-cf-admin-search]');
    if (sBtn) { runAdminSearch(); return; }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.id === 'adminSearchInput') {
      e.preventDefault();
      runAdminSearch();
    }
    if (e.key === 'Escape' && realEdit) { closeRealEditor(); }
  });

  /* Admin tabs (Oct 31, 2026): the admin section grew into one long
     scroll (queues + users + orders + boosts). Tabs fold it — one
     panel at a time, Approvals first — so a flood of ads or packages
     stays manageable. Pure show/hide: every list still renders
     exactly as before, into its existing container. Badges show
     action counts (pending items) on the tab buttons themselves. */
  function setTabBadge(id, n, always) {
    var b = el(id);
    if (!b) return;
    if (typeof n === 'number' && (always || n > 0)) { b.textContent = String(n); b.hidden = false; }
    else { b.hidden = true; }
  }
  /* Site overview card filler: takes a Supabase count result and
     writes the number; pending cards light up 'hot' when their
     queue is non-zero so work waiting is impossible to miss. */
  function setOv(id, res, hotWhenPositive) {
    var n = el(id);
    if (!n) return;
    var ok = res && !res.error && typeof res.count === 'number';
    n.textContent = ok ? String(res.count) : '—';
    if (hotWhenPositive) {
      var card = n.closest ? n.closest('.stat') : null;
      if (card) card.classList.toggle('hot', !!(ok && res.count > 0));
    }
  }

  /* Toronto day/week starts as UTC ISO strings, for created_at
     range filters (waitlist counter). Intl supplies the real
     EST/EDT offset — nothing is hardcoded. Week starts Monday. */
  function torontoParts(d) {
    var out = {};
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
        .formatToParts(d).forEach(function (p) { out[p.type] = p.value; });
    } catch (e) {}
    return out;
  }
  function torontoMidnightUTC(y, m, d) {
    var target = Date.UTC(y, m - 1, d, 0, 0, 0);
    var guess = target;
    for (var i = 0; i < 2; i++) {
      var o = {};
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(guess)).forEach(function (p) { o[p.type] = p.value; });
      var asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, (+o.hour) % 24, +o.minute, +o.second);
      if (asUTC === target) break;
      guess -= (asUTC - target);
    }
    return new Date(guess).toISOString();
  }
  function torontoTodayStart() {
    var p = torontoParts(new Date());
    return torontoMidnightUTC(+p.year, +p.month, +p.day);
  }
  function torontoWeekStart() {
    var p = torontoParts(new Date());
    var back = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.weekday] || 0;
    var md = new Date(Date.UTC(+p.year, +p.month - 1, +p.day - back));
    return torontoMidnightUTC(md.getUTCFullYear(), md.getUTCMonth() + 1, md.getUTCDate());
  }
  /* Overview pending cards jump straight to the work: open the
     matching Admin tab and scroll it into view. */
  document.addEventListener('click', function (e) {
    var g = e.target && e.target.closest ? e.target.closest('[data-cf-ovgo]') : null;
    if (!g) return;
    var tab = document.querySelector('[data-cf-atab="' + g.dataset.cfOvgo + '"]');
    if (tab) tab.click();
    var sect = el('adminSect');
    if (sect) sect.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-cf-atab]') : null;
    if (!t) return;
    var name = t.dataset.cfAtab;
    document.querySelectorAll('[data-cf-atab]').forEach(function (b) { b.classList.toggle('on', b === t); });
    document.querySelectorAll('[data-cf-apanel]').forEach(function (p) {
      var show = p.dataset.cfApanel === name;
      p.hidden = !show;
      p.style.display = show ? '' : 'none';
    });
  });

  /* Personal dashboard tabs (Oct 31, 2026): same folding as the
     admin tabs, one level up — My Ads / Messages / My Orders /
     My Boosts / Business Profile, one panel at a time, so the
     dashboard reads clean even when the founder account carries
     its own services ads + personal listings + orders + boosts.
     Pure show/hide; every section renders as before. The Business
     tab button stays hidden until the account is an advertiser
     (renderUser unhides it with the Business profile section). */
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-cf-dtab]') : null;
    if (!t) return;
    var name = t.dataset.cfDtab;
    document.querySelectorAll('[data-cf-dtab]').forEach(function (b) { b.classList.toggle('on', b === t); });
    document.querySelectorAll('[data-cf-dpanel]').forEach(function (p) {
      var show = p.dataset.cfDpanel === name;
      p.hidden = !show;
      p.style.display = show ? '' : 'none';
    });
  });

  /* Waitlist lead list (Nov 9, 2026): the Site Overview counter
     grows into the working list — newest first, filter by segment
     and category, counts per group, and a CSV export whose last
     three columns are blank tracker columns (Called/Emailed ·
     Date · Outcome/Notes), so the export IS Martin's call sheet.
     Admin-only end to end: this runs inside renderAdmin and the
     waitlist SELECT policy is is_admin. Fails soft with the SQL
     hint until cf-waitlist-segments-migration.sql has run.
     Export stamp (Nov 10, 2026): the export downloads only rows
     whose exported_at is still NULL, then stamps them, so a lead
     lands on exactly one call sheet; the "Include already-
     exported" checkbox re-downloads the full filtered list.
     Needs cf-waitlist-export-stamp-migration.sql (column + the
     admin UPDATE policy). */
  var cfWlRows = null, cfWlSeg = 'all', cfWlCat = 'all';
  var cfWlInclExported = false, cfWlClient = null;
  function cfWlFiltered() {
    if (!cfWlRows) return [];
    return cfWlRows.filter(function (r) {
      if (cfWlSeg !== 'all' && (r.signup_type || '') !== cfWlSeg) return false;
      if (cfWlCat !== 'all' && (r.category || '') !== cfWlCat) return false;
      return true;
    });
  }
  function cfWlPaint() {
    var box = el('adminWaitlistBox');
    if (!box || !cfWlRows) return;
    var cats = ['Cars', 'Homes', 'Rentals', 'Services', 'Jobs'];
    var nPriv = 0, nBiz = 0, nNew = 0, byCat = {};
    cfWlRows.forEach(function (r) {
      if (r.signup_type === 'business') nBiz++; else if (r.signup_type === 'private') nPriv++;
      if (!r.exported_at) nNew++;
      if (r.category) byCat[r.category] = (byCat[r.category] || 0) + 1;
    });
    var counts = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
      '<span style="border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:13px"><b>' + cfWlRows.length + '</b> total</span>' +
      '<span style="border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:13px"><b>' + nNew + '</b> new to export</span>' +
      '<span style="border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:13px"><b>' + nBiz + '</b> businesses</span>' +
      '<span style="border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:13px"><b>' + nPriv + '</b> private</span>' +
      cats.map(function (c) { return '<span style="border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:13px">' + c + ' <b>' + (byCat[c] || 0) + '</b></span>'; }).join('') +
      '</div>';
    var controls = '<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
      '<select id="wlSegFilter" aria-label="Filter by type" style="padding:8px;border:1px solid var(--line);border-radius:8px">' +
      '<option value="all"' + (cfWlSeg === 'all' ? ' selected' : '') + '>All signups</option>' +
      '<option value="business"' + (cfWlSeg === 'business' ? ' selected' : '') + '>Businesses</option>' +
      '<option value="private"' + (cfWlSeg === 'private' ? ' selected' : '') + '>Private sellers</option></select>' +
      '<select id="wlCatFilter" aria-label="Filter by category" style="padding:8px;border:1px solid var(--line);border-radius:8px">' +
      '<option value="all"' + (cfWlCat === 'all' ? ' selected' : '') + '>All categories</option>' +
      cats.map(function (c) { return '<option value="' + c + '"' + (cfWlCat === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') +
      '</select>' +
      '<button class="btn pri" type="button" data-cf-wl-export>Export CSV (call sheet)</button>' +
      '<label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" id="wlInclExported"' + (cfWlInclExported ? ' checked' : '') + '> Include already-exported</label></div>';
    var rows = cfWlFiltered();
    var list;
    if (!cfWlRows.length) {
      list = '<div class="notice">No waitlist signups yet.</div>';
    } else if (!rows.length) {
      list = '<div class="notice">No signups match this filter.</div>';
    } else {
      list = rows.map(function (r) {
        var isBiz = r.signup_type === 'business';
        var pill = r.signup_type
          ? '<span style="border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:12px;font-weight:700">' + (isBiz ? 'Business' : 'Private') + '</span>'
          : '<span style="border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:12px">Early signup</span>';
        var main = isBiz
          ? '<b>' + esc(r.business_name || '(no business name)') + '</b>' + (r.category ? ' · ' + esc(r.category) : '')
          : (r.intent ? 'Plans to sell: ' + esc(r.intent) : 'Private seller');
        var contact = esc(r.email || '') + (r.phone ? ' · <a href="tel:' + esc(r.phone.replace(/[^0-9+]/g, '')) + '">' + esc(r.phone) + '</a>' : '');
        var expTag = r.exported_at ? ' · <span style="font-weight:700">Exported ✓ ' + shortDate(r.exported_at) + '</span>' : '';
        return '<div class="lcard"><div class="inf"><div class="t">' + main + ' ' + pill + '</div>' +
          '<div class="s">' + contact + ' · ' + shortDate(r.created_at) + expTag + '</div></div></div>';
      }).join('');
    }
    box.innerHTML = counts + controls + list;
  }
  /* Revenue tab (Nov 17, 2026, Martin's ask): running dollar totals
     for packages + boosts, broken down by category and by month.
     Admin-only end to end (runs inside renderAdmin). REVENUE counts
     rows that were actually activated (paid): orders/boosts in
     Active, Expiring soon, or Expired. Pending reserves are shown
     separately as pipeline and are NOT counted as revenue. Months
     are Toronto months via torontoParts. Amounts print with cents
     (boosts are $2.99, so the whole-dollar money() helper won't do). */
  function money2(n) {
    try {
      return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
    } catch (e) { return '$' + Number(n || 0).toFixed(2); }
  }
  function pkgCategory(pkg) {
    var s = String(pkg || '').toLowerCase();
    if (s.indexOf('dealer') >= 0) return 'Cars \u2014 Dealers';
    if (s.indexOf('agent') >= 0) return 'Homes \u2014 Agents';
    if (s.indexOf('rental') >= 0) return 'Rentals';
    if (s.indexOf('service') >= 0) return 'Services';
    if (s.indexOf('job') >= 0) return 'Jobs';
    return 'Other packages';
  }
  function monthKeyToronto(iso) {
    try {
      var p = torontoParts(new Date(iso));
      return p.year + '-' + ('0' + p.month).slice(-2);
    } catch (e) { return 'unknown'; }
  }
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function monthLabel(key) {
    if (key === 'unknown') return 'Date unknown';
    var bits = key.split('-');
    return MONTH_NAMES[(+bits[1]) - 1] + ' ' + bits[0];
  }
  async function renderAdminRevenue(client) {
    var box = el('adminRevenueBox');
    if (!box) return;
    box.innerHTML = '<div class=\"notice\">Loading revenue\u2026</div>';
    var orr = await client.from('orders').select('id,package,amount,status,created_at').order('created_at', { ascending: false }).limit(1000);
    if (orr.error) { box.innerHTML = '<div class=\"notice\">Revenue unavailable \u2014 the orders read failed. The rest of Admin still works.</div>'; return; }
    var brr = await client.from('boosts').select('id,listing_id,amount,status,created_at').order('created_at', { ascending: false }).limit(1000);
    var orders = orr.data || [];
    var boosts = (brr && !brr.error && brr.data) || [];
    /* Boost category comes from the boosted ad itself. */
    var catByListing = {};
    try {
      var ids = [];
      boosts.forEach(function (b) { if (b.listing_id && ids.indexOf(b.listing_id) < 0) ids.push(b.listing_id); });
      for (var i = 0; i < ids.length; i += 100) {
        var lr = await client.from('listings').select('id,category').in('id', ids.slice(i, i + 100));
        if (lr && !lr.error && lr.data) lr.data.forEach(function (l) { catByListing[l.id] = l.category || 'Other'; });
      }
    } catch (e) {}
    var SOLD = { 'Active': 1, 'Expiring soon': 1, 'Expired': 1 };
    var nowKey = monthKeyToronto(new Date().toISOString());
    var tot = { all: 0, mtd: 0, pkg: 0, pkgN: 0, bst: 0, bstN: 0, pipe: 0, pipeN: 0 };
    var byCat = {}, byBoostCat = {}, byMonth = {};
    function bump(map, key, amt) { if (!map[key]) map[key] = { n: 0, amt: 0 }; map[key].n += 1; map[key].amt += amt; }
    function bumpMonth(key, kind, amt) { if (!byMonth[key]) byMonth[key] = { pkg: 0, pkgN: 0, bst: 0, bstN: 0 }; byMonth[key][kind] += amt; byMonth[key][kind + 'N'] += 1; }
    orders.forEach(function (o) {
      var amt = Number(o.amount) || 0;
      if (o.status === 'Pending') { tot.pipe += amt; tot.pipeN += 1; return; }
      if (!SOLD[o.status]) return;
      tot.all += amt; tot.pkg += amt; tot.pkgN += 1;
      var mk = monthKeyToronto(o.created_at);
      if (mk === nowKey) tot.mtd += amt;
      bump(byCat, pkgCategory(o.package), amt);
      bumpMonth(mk, 'pkg', amt);
    });
    boosts.forEach(function (b) {
      var amt = Number(b.amount) || 0;
      if (b.status === 'Pending') { tot.pipe += amt; tot.pipeN += 1; return; }
      if (!SOLD[b.status]) return;
      tot.all += amt; tot.bst += amt; tot.bstN += 1;
      var mk = monthKeyToronto(b.created_at);
      if (mk === nowKey) tot.mtd += amt;
      bump(byBoostCat, catByListing[b.listing_id] || 'Other', amt);
      bumpMonth(mk, 'bst', amt);
    });
    function rows(map, emptyMsg) {
      var keys = Object.keys(map).sort(function (a, b) { return map[b].amt - map[a].amt; });
      if (!keys.length) return '<p class=\"hint\">' + emptyMsg + '</p>';
      var h = '';
      keys.forEach(function (k) {
        h += '<div class=\"lcard\"><div class=\"inf\"><div class=\"t\">' + esc(k) + '</div><div class=\"s\">' + map[k].n + (map[k].n === 1 ? ' sale' : ' sales') + '</div></div><div class=\"p\">' + money2(map[k].amt) + '</div></div>';
      });
      return h;
    }
    var monthKeys = Object.keys(byMonth).sort().reverse();
    var monthHtml = '';
    if (!monthKeys.length) monthHtml = '<p class=\"hint\">No sales yet.</p>';
    monthKeys.forEach(function (k) {
      var m = byMonth[k];
      monthHtml += '<div class=\"lcard\"><div class=\"inf\"><div class=\"t\">' + esc(monthLabel(k)) + '</div><div class=\"s\">Packages ' + money2(m.pkg) + ' (' + m.pkgN + ') \u00b7 Boosts ' + money2(m.bst) + ' (' + m.bstN + ')</div></div><div class=\"p\">' + money2(m.pkg + m.bst) + '</div></div>';
    });
    box.innerHTML =
      '<div class=\"stats\">' +
      '<div class=\"stat\"><div class=\"n\">' + money2(tot.all) + '</div><div class=\"l\">Total revenue \u00b7 all time</div></div>' +
      '<div class=\"stat\"><div class=\"n\">' + money2(tot.mtd) + '</div><div class=\"l\">This month \u00b7 ' + esc(monthLabel(nowKey)) + '</div></div>' +
      '<div class=\"stat\"><div class=\"n\">' + money2(tot.pkg) + '</div><div class=\"l\">Packages \u00b7 ' + tot.pkgN + ' sold</div></div>' +
      '<div class=\"stat\"><div class=\"n\">' + money2(tot.bst) + '</div><div class=\"l\">Boosts \u00b7 ' + tot.bstN + ' sold</div></div>' +
      '</div>' +
      '<p class=\"hint\">Revenue counts packages and boosts that were activated (paid). Pending reserves are pipeline, not revenue: <strong>' + money2(tot.pipe) + '</strong> across ' + tot.pipeN + ' pending. Test sales are included until Reset 2 clears them on Dec 28.</p>' +
      '<h3 style=\"margin:16px 0 8px\">Packages by category</h3>' + rows(byCat, 'No package sales yet.') +
      '<h3 style=\"margin:16px 0 8px\">Boosts by category</h3>' + rows(byBoostCat, 'No boost sales yet.') +
      '<h3 style=\"margin:16px 0 8px\">Month by month</h3>' + monthHtml;
  }
  async function renderAdminWaitlist(client) {
    var box = el('adminWaitlistBox');
    if (!box) return;
    cfWlClient = client;
    var res = null;
    try {
      res = await client.from('waitlist_signups')
        .select('id,email,created_at,signup_type,business_name,category,phone,intent,exported_at')
        .order('created_at', { ascending: false }).limit(1000);
    } catch (e) {}
    if (!res || res.error || !res.data) {
      box.innerHTML = '<div class="notice">The waitlist list needs its SQL first (files: supabase/cf-waitlist-segments-migration.sql, then supabase/cf-waitlist-export-stamp-migration.sql). Run them in the Supabase SQL Editor, then refresh.</div>';
      return;
    }
    cfWlRows = res.data;
    setTabBadge('atabNWaitlist', cfWlRows.length, false);
    cfWlPaint();
  }
  function cfWlCsvCell(v) {
    v = (v === null || v === undefined) ? '' : String(v);
    return '"' + v.replace(/"/g, '""') + '"';
  }
  async function cfWlExport() {
    var rows = cfWlFiltered();
    var use = cfWlInclExported ? rows : rows.filter(function (r) { return !r.exported_at; });
    if (!use.length) {
      alert(rows.length
        ? 'Everything in this view is already exported. Tick "Include already-exported" to download the full list again.'
        : 'No signups match this filter.');
      return;
    }
    var head = ['Date', 'Type', 'Business', 'Category', 'Email', 'Phone', 'Intent', 'Called/Emailed', 'Date Contacted', 'Outcome/Notes'];
    var lines = [head.map(cfWlCsvCell).join(',')];
    use.forEach(function (r) {
      lines.push([
        r.created_at ? String(r.created_at).slice(0, 10) : '',
        r.signup_type || '',
        r.business_name || '',
        r.category || '',
        r.email || '',
        r.phone || '',
        r.intent || '',
        '', '', ''
      ].map(cfWlCsvCell).join(','));
    });
    var blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'classiflip-waitlist.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    /* Stamp the just-exported rows so they never download twice.
       Chunked at 100 ids to keep the update URL sane at scale.
       Fail-soft: if the stamp write fails, the rows simply stay
       unstamped and will be offered again next export. */
    var toStamp = use.filter(function (r) { return !r.exported_at; });
    if (toStamp.length && cfWlClient) {
      var stamp = new Date().toISOString();
      var ok = true;
      for (var i = 0; i < toStamp.length; i += 100) {
        var ids = toStamp.slice(i, i + 100).map(function (r) { return r.id; });
        try {
          var up = await cfWlClient.from('waitlist_signups').update({ exported_at: stamp }).in('id', ids);
          if (up && up.error) { ok = false; break; }
        } catch (e) { ok = false; break; }
      }
      if (ok) {
        toStamp.forEach(function (r) { r.exported_at = stamp; });
        cfWlPaint();
      }
    }
  }
  document.addEventListener('change', function (e) {
    if (!e.target) return;
    if (e.target.id === 'wlSegFilter') { cfWlSeg = e.target.value; cfWlPaint(); }
    if (e.target.id === 'wlCatFilter') { cfWlCat = e.target.value; cfWlPaint(); }
    if (e.target.id === 'wlInclExported') { cfWlInclExported = !!e.target.checked; }
  });
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-cf-wl-export]') : null;
    if (b) cfWlExport();
  });

  window.CFDashboard = { refresh: refresh, post: function () { openRealPost(); } };
  refresh();
})();
