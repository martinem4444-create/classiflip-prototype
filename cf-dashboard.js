/* ClassiFlip dashboard wiring v1.1 (step 4 + multi-photo) — Supabase (marketplace-dev).
 *
 * WHAT IT DOES (signed-in users only; logged-out visitors keep the demo):
 * - Replaces the demo listing cards with the signed-in user's REAL listings
 *   (all statuses: active / pending / rejected / sold / expired / hidden),
 *   with a real Delete action on each.
 * - Replaces the demo message rows with the user's REAL threads (via
 *   window.CFMessages.listThreads, the same module index.html uses).
 * - Replaces the demo stats with REAL counts (active, pending, unread, orders).
 * - Adds a "My orders" section: the user's own orders with status + expiry.
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

    /* Own listings, own orders, real threads — three independent reads. */
    var listings = [], orders = [], threads = [];
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
       later pass); Delete is real; View links to the marketplace. */
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
          return '<div class="lcard">' +
            (x.photo_url ? '<img src="' + esc(x.photo_url) + '" alt="">' : '<div class="ph">&#128722;</div>') +
            '<div class="inf"><div class="t">' + esc(x.title) + ' ' + pillFor(x.status) + '</div>' +
            '<div class="p">' + money(x.price) + '</div>' +
            '<div class="s">' + esc(x.category || '') + ' · ' + esc(x.condition || '') + ' · ' + esc(x.location || '') + ' · posted ' + shortDate(x.created_at) + '</div></div>' +
            '<div class="acts">' + viewBtn + '<button class="btn gho danger" data-cf-del="' + esc(x.id) + '">Delete</button></div>' +
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
          return '<div class="msgrow" onclick="location.href=\'messaging.html\'" style="cursor:pointer"><div class="av">' + esc(initial) + '</div>' +
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
    var approve = e.target.closest ? e.target.closest('[data-cf-approve]') : null;
    var reject = e.target.closest ? e.target.closest('[data-cf-reject]') : null;
    var act = e.target.closest ? e.target.closest('[data-cf-order-activate]') : null;
    var soon = e.target.closest ? e.target.closest('[data-cf-order-soon]') : null;
    var exp = e.target.closest ? e.target.closest('[data-cf-order-expire]') : null;
    var btn = approve || reject || act || soon || exp;
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
    }
  });

  window.CFDashboard = { refresh: refresh };
  refresh();
})();
