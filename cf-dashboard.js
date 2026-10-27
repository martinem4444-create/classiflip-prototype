/* ClassiFlip dashboard wiring v1.2 (step 4 + multi-photo + step 5 Boost) — Supabase (marketplace-dev).
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

  var renderedReal = false;
  var inFlight = false;

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
      /* Signed out after a real render: reload to restore the demo. */
      if (renderedReal) { try { location.reload(); } catch (e) {} }
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
       navigates to the real seller.html page.
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

  function cfBizPreview() {
    /* Preview = the real public page, never the old demo modal. */
    if (window.__cfBizUserId) {
      location.href = 'seller.html?id=' + encodeURIComponent(window.__cfBizUserId);
      return;
    }
    cfBizUid().then(function (uid) {
      if (uid) {
        window.__cfBizUserId = uid;
        location.href = 'seller.html?id=' + encodeURIComponent(uid);
      } else if (typeof toast === 'function') {
        toast('Sign in as a business to preview your page');
      }
    });
  }

  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'bpSaveBtn') { e.preventDefault(); cfBizSave(); }
    if (e.target && e.target.id === 'bpPreviewBtn') { e.preventDefault(); cfBizPreview(); }
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
        .select('id,title,price,category,condition,location,status,created_at,photo_url')
        .eq('seller_id', user.id).order('created_at', { ascending: false }).limit(100);
      if (lr && lr.data) listings = lr.data;
    } catch (e) {}
    try {
      var orr = await client.from('orders')
        .select('id,order_number,business_name,package,amount,buyer_name,buyer_email,status,expires_at,created_at')
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
    try {
      if (window.CFMessages && window.CFMessages.listThreads) {
        var th = await window.CFMessages.listThreads();
        if (th) threads = th;
      }
    } catch (e) {}

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
      window.__cfBizUserId = user.id;
      cfBizLoad();
    }
    var statsSeller = el('statsSeller');
    if (statsSeller) {
      statsSeller.classList.remove('hidden');
      statsSeller.innerHTML =
        '<div class="stat"><div class="n">' + nActive + '</div><div class="l">Active listings</div></div>' +
        '<div class="stat"><div class="n">' + nPending + '</div><div class="l">Pending approval</div></div>' +
        '<div class="stat' + (nUnread ? ' hot' : '') + '"><div class="n">' + nUnread + '</div><div class="l">Unread messages</div></div>' +
        '<div class="stat"><div class="n">' + orders.length + '</div><div class="l">My orders</div></div>';
    }

    /* Real listing cards. Edit stays demo-only (real ad editing is a
       later pass); Delete is real; View links to the marketplace.
       Step 5 Boost: a Boost button on ACTIVE rows only, plus a
       "Boosted until" pill when the ad has a live boost (an Active
       boosts row with expires_at in the future — the latest expiry
       wins, because re-boost extends). */
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
        listSeller.innerHTML = '<div class="notice">No ads yet — post one from the Marketplace and it will show up here once approved.</div>';
      } else {
        listSeller.innerHTML = listings.map(function (x) {
          var viewBtn = x.status === 'active'
            ? '<a class="btn gho" href="index.html">View</a>'
            : '<span class="btn gho" style="opacity:.55">' + (x.status === 'pending' ? 'Awaiting approval' : esc(x.status)) + '</span>';
          var boostPill = liveBoostByListing[x.id]
            ? ' <span class="pill boost">🚀 Boosted until ' + fullDate(new Date(liveBoostByListing[x.id]).toISOString()) + '</span>' : '';
          var boostBtn = x.status === 'active'
            ? '<button class="btn pri" data-cf-boost="' + esc(x.id) + '" data-cf-boost-title="' + esc(x.title) + '">Boost · $2.99</button>' : '';
          return '<div class="lcard">' +
            (x.photo_url ? '<img src="' + esc(x.photo_url) + '" alt="">' : '<div class="ph">&#128722;</div>') +
            '<div class="inf"><div class="t">' + esc(x.title) + ' ' + pillFor(x.status) + boostPill + '</div>' +
            '<div class="p">' + money(x.price) + '</div>' +
            '<div class="s">' + esc(x.category || '') + ' · ' + esc(x.condition || '') + ' · ' + esc(x.location || '') + ' · posted ' + shortDate(x.created_at) + '</div></div>' +
            '<div class="acts">' + viewBtn + boostBtn + '<button class="btn gho danger" data-cf-del="' + esc(x.id) + '">Delete</button></div>' +
            '</div>';
        }).join('');
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
            return '<div class="lcard"><div class="inf"><div class="t">' + esc(o.order_number) + ' · ' + esc(o.package || '') + ' ' + pillForOrder(o.status) + '</div>' +
              '<div class="p">' + money(o.amount) + '</div>' +
              '<div class="s">' + esc(o.business_name || '') + ' · ordered ' + fullDate(o.created_at) +
              (o.expires_at ? ' · expires ' + fullDate(o.expires_at) : '') + '</div></div></div>';
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
            return '<div class="lcard"><div class="inf"><div class="t">' + esc(b.payment_ref || 'Boost') + ' · ' + esc(titlesById[b.listing_id] || 'Ad') + ' ' + pillForOrder(b.status) + '</div>' +
              '<div class="p">$' + Number(b.amount).toFixed(2) + ' · ' + (b.payment_method === 'etransfer' ? 'Interac e-Transfer' : 'Card') + '</div>' +
              '<div class="s">reserved ' + fullDate(b.created_at) +
              (b.activated_at ? ' · activated ' + fullDate(b.activated_at) : '') +
              (b.expires_at ? ' · expires ' + fullDate(b.expires_at) : '') + '</div></div></div>';
          }).join('');
        }
      }
    }

    /* Post button goes to the real post flow on the marketplace. */
    var postBtn = el('postBtn');
    if (postBtn) postBtn.onclick = function () { location.href = 'index.html'; };

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

  async function renderAdmin(client) {
    var adsList = el('adminAdsList'), ordersList = el('adminOrdersList'), expList = el('adminExpiringList');
    if (adsList) adsList.innerHTML = '<div class="notice">Loading pending ads…</div>';
    if (ordersList) ordersList.innerHTML = '<div class="notice">Loading orders…</div>';

    /* Pending ads (needs the step-4 admin read policy; without it this
       returns [] and the hint below explains why). */
    var pending = [];
    try {
      var pr = await client.from('listings')
        .select('id,title,description,price,category,location,status,photo_url,created_at,seller_id')
        .eq('status', 'pending').order('created_at', { ascending: true }).limit(100);
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
        return '<div class="lcard">' +
          (x.photo_url ? '<img src="' + esc(x.photo_url) + '" alt="">' : '<div class="ph">&#128722;</div>') +
          '<div class="inf"><div class="t">' + esc(x.title) + ' ' + pillFor('pending') + '</div>' +
          '<div class="p">' + money(x.price) + '</div>' +
          '<div class="s">' + esc(x.category || '') + ' · ' + esc(x.location || '') + ' · seller ' + esc(s.display_name || s.email || x.seller_id || '') + ' · ' + shortDate(x.created_at) + '</div>' +
          strip +
          (desc ? '<div style="margin-top:8px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word">' + esc(desc) + '</div>'
                : '<div style="margin-top:8px;font-size:13px;color:var(--mu)">No description provided.</div>') + '</div>' +
          '<div class="acts"><button class="btn pri" data-cf-approve="' + esc(x.id) + '">Approve</button>' +
          '<button class="btn gho danger" data-cf-reject="' + esc(x.id) + '">Reject</button></div></div>';
      }).join('');
    } else {
      adsList.innerHTML = '<div class="notice">No ads awaiting approval. If you know a pending ad exists and this stays empty, the step-4 SQL has not been run yet (see the note below).</div>';
    }

    /* All orders, newest first. */
    var allOrders = [];
    try {
      var orr = await client.from('orders')
        .select('id,order_number,business_name,package,amount,buyer_name,buyer_email,buyer_phone,status,expires_at,created_at')
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
            ' · ordered ' + fullDate(o.created_at) + (o.expires_at ? ' · expires ' + fullDate(o.expires_at) : '') + '</div></div>' +
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
    var actBoosts = allBoosts.filter(function (b) { return b.status === 'Active'; });
    if (bActiveList) {
      bActiveList.innerHTML = actBoosts.length
        ? actBoosts.map(function (b) {
            var expMs = b.expires_at ? new Date(b.expires_at).getTime() - Date.now() : 0;
            var flag = (b.expires_at && expMs > 0 && expMs <= 3 * 24 * 3600 * 1000) ? ' <span class="pill pend">Expiring soon</span>' : '';
            return boostCard(b, '<div class="acts">' + flag + '<button class="btn gho danger" data-cf-boost-expire="' + esc(b.id) + '" data-cf-boost-listing="' + esc(b.listing_id) + '">Expire</button></div>');
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
    var client = getClient();
    if (!client) return;
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
      client.from('listings').delete().eq('id', id).then(function (res) {
        if (res.error) { say('Could not delete: ' + res.error.message); return; }
        if (cleanupPaths.length) {
          client.storage.from('listing-photos').remove(cleanupPaths).catch(function () {});
        }
        say('Ad deleted'); refresh();
      });
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
          rdone.innerHTML = '<div class="big">🚀</div><h2>Payment sent — Martin activates your boost</h2>' +
            '<p>Send <b>$2.99</b> by Interac e-Transfer to <b>' + esc(BOOST_ADMIN_EMAIL) + '</b> with <b>' + esc(bst) + '</b> in the message.<br>' +
            'Martin activates your boost, usually the same day — it then runs 7 days, pinned first in its category.</p>' +
            '<p class="sub">Boost ref: <b>' + esc(bst) + '</b> · Ad: ' + esc(boostListing.title) + '</p>' +
            '<button class="btn dark" onclick="closeM(\'mBoost\')">Back to my listings</button>';
          rdone.classList.remove('hidden');
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
      client.from('listings').update({ status: 'active' }).eq('id', approve.dataset.cfApprove).then(function (res) {
        done(!res.error, res.error ? 'Approve failed: ' + res.error.message + ' — run the step-4 SQL first?' : 'Ad approved — it is live now');
      });
    } else if (reject) {
      client.from('listings').update({ status: 'rejected' }).eq('id', reject.dataset.cfReject).then(function (res) {
        done(!res.error, res.error ? 'Reject failed: ' + res.error.message : 'Ad rejected — it stays hidden');
      });
    } else if (act) {
      var exp30 = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      client.from('orders').update({ status: 'Active', expires_at: exp30 }).eq('id', act.dataset.cfOrderActivate).then(function (res) {
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

  window.CFDashboard = { refresh: refresh };
  refresh();
})();
