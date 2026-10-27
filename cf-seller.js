/* ClassiFlip dealer pages v1 — public seller page (seller.html).
   Reads ONLY the business_profiles table (public-read by policy) plus
   the seller's live listings. No profiles, orders, emails, or auth
   phones are ever read here — a business page shows only what the
   business itself published. No login is needed to view the page.
   Reuses window.CFAuth.client (no keys of its own). Fails soft:
   a missing row, a missing migration, or a dead client all land on
   a plain explanatory state, never a blank page. */
(function () {
  'use strict';

  var stateEl = document.getElementById('sellerState');
  var pageEl = document.getElementById('sellerPage');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fail(msg) {
    if (stateEl) { stateEl.hidden = false; stateEl.textContent = msg; }
    if (pageEl) pageEl.hidden = true;
  }

  function getClient() {
    try {
      if (window.CFAuth && window.CFAuth.client) return window.CFAuth.client;
    } catch (e) {}
    return null;
  }

  function priceOf(x) {
    if (x.price == null || x.price === '') return '';
    var n = Number(x.price);
    if (isNaN(n)) return esc(x.price);
    return '$' + n.toLocaleString('en-CA', { maximumFractionDigits: 0 });
  }

  function firstPhoto(x) {
    /* listings rows carry photos from cf-listings' shape when reused;
       here we fetch listing_photos separately, so this reads the
       joined row the same way the marketplace does. */
    if (x && x._photo) return x._photo;
    return null;
  }

  async function init() {
    var m = /[?&]id=([^&]+)/.exec(location.search || '');
    var sellerId = m ? decodeURIComponent(m[1]) : '';
    if (!sellerId) { fail('No business selected. Head back to the marketplace and tap a dealer\'s page from one of their ads.'); return; }

    var client = getClient();
    if (!client) { fail('This page needs the site\'s connection to load. Check your connection and refresh.'); return; }

    /* 1. The storefront row. No row = no public page (private sellers
       never have rows — the migration's trigger enforces that). */
    var prof;
    try {
      prof = await client.from('business_profiles').select('*').eq('id', sellerId).maybeSingle();
    } catch (e) { prof = null; }
    if (!prof || prof.error || !prof.data) {
      fail('This business page doesn\'t exist yet. The seller may not have set up their public page, or the link may be out of date.');
      return;
    }
    var b = prof.data;

    /* Header: logo (or placeholder), name, verified badge, tagline. */
    var logoEl = document.getElementById('sellerLogo');
    if (b.logo_url && logoEl) {
      var img = document.createElement('img');
      img.alt = 'Business logo';
      img.src = b.logo_url;
      img.onerror = function () { logoEl.textContent = '🏬'; };
      logoEl.textContent = '';
      logoEl.appendChild(img);
    }
    document.getElementById('sellerName').textContent = b.display_name || 'Business';
    document.title = 'ClassiFlip — ' + (b.display_name || 'Business');
    var ver = document.getElementById('sellerVerified');
    if (ver) ver.hidden = false;
    if (b.tagline) {
      var tg = document.getElementById('sellerTagline');
      tg.textContent = b.tagline;
      tg.hidden = false;
    }

    /* Contact strip: only fields the business actually published.
       Empty fields render nothing — never a blank row, never a
       private email or auth phone (those live nowhere near here). */
    var contact = document.getElementById('sellerContact');
    var rows = [];
    if (b.website) rows.push('<div><b>Website</b><a href="' + esc(b.website) + '" target="_blank" rel="noopener">' + esc(b.website.replace(/^https?:\/\//i, '')) + '</a></div>');
    if (b.business_phone) rows.push('<div><b>Phone</b><a href="tel:' + esc(b.business_phone.replace(/[^+\d]/g, '')) + '">' + esc(b.business_phone) + '</a></div>');
    if (b.address) rows.push('<div><b>Address</b>' + esc(b.address) + '</div>');
    if (b.hours) rows.push('<div><b>Hours</b>' + esc(b.hours) + '</div>');
    contact.innerHTML = rows.join('');
    if (!rows.length) contact.style.display = 'none';
    if (b.about) {
      var ab = document.getElementById('sellerAbout');
      ab.textContent = b.about;
      ab.hidden = false;
    }

    /* 2. This seller's LIVE listings only: status 'active' (lowercase
       — the marketplace fetch uses the same value) AND not expired.
       Pending, sold, and expired rows never reach the grid — the
       query itself excludes them, not just the render. */
    var nowIso = new Date().toISOString();
    var res;
    try {
      res = await client.from('listings')
        .select('id,title,price,condition,location,category,created_at')
        .eq('seller_id', sellerId)
        .eq('status', 'active')
        .or('expires_at.is.null,expires_at.gt.' + nowIso)
        .order('created_at', { ascending: false });
    } catch (e) { res = null; }
    var ads = (res && !res.error && res.data) ? res.data : [];

    /* Photos for the grid (best effort — a photo failure must not
       hide the listings themselves). */
    try {
      if (ads.length) {
        var ids = ads.map(function (a) { return a.id; });
        var ph = await client.from('listing_photos').select('listing_id,photo_url').in('listing_id', ids).order('sort_order', { ascending: true });
        if (ph && !ph.error && ph.data) {
          var byId = {};
          ph.data.forEach(function (p) { if (!byId[p.listing_id]) byId[p.listing_id] = p.photo_url; });
          ads.forEach(function (a) { a._photo = byId[a.id] || null; });
        }
      }
    } catch (e) {}

    /* Boosted-first FCFS, then newest first — the same order as the
       marketplace grid. A boost counts only while Active AND
       unexpired (cf_effective_boosts); an RPC failure degrades to
       plain newest-first instead of breaking the page. */
    var boostSort = {};
    try {
      var br = await client.rpc('cf_effective_boosts');
      if (br && !br.error && br.data) {
        br.data.forEach(function (r) {
          if (r && r.listing_id) {
            var bst = 0;
            if (r.payment_ref) {
              var mm = /BST-(\d+)/.exec(String(r.payment_ref));
              if (mm) bst = parseInt(mm[1], 10) || 0;
            }
            boostSort[r.listing_id] = { ms: r.activated_at ? new Date(r.activated_at).getTime() : 0, bst: bst };
          }
        });
      }
    } catch (e) {}
    var now = Date.now();
    ads.forEach(function (a) {
      var bs = boostSort[a.id];
      a._boosted = !!bs;
      a._boostMs = bs ? bs.ms : 0;
      a._bst = bs ? bs.bst : 0;
    });
    ads.sort(function (a, c) {
      if (a._boosted && !c._boosted) return -1;
      if (!a._boosted && c._boosted) return 1;
      if (a._boosted && c._boosted) {
        if (a._boostMs !== c._boostMs) return a._boostMs - c._boostMs;
        return a._bst - c._bst;
      }
      return new Date(c.created_at || 0) - new Date(a.created_at || 0);
    });

    /* Ad count + grid. Cards link back to the marketplace detail
       via index.html?listing=<id> (cf-listings.js opens it). */
    document.getElementById('sellerCount').textContent =
      ads.length + (ads.length === 1 ? ' live listing' : ' live listings');
    var grid = document.getElementById('sellerGrid');
    if (!ads.length) {
      document.getElementById('sellerEmpty').hidden = false;
    } else {
      grid.innerHTML = ads.map(function (a) {
        var photo = firstPhoto(a);
        var media = photo
          ? '<img src="' + esc(photo) + '" alt="">'
          : '<span style="font-size:44px">🏷️</span>';
        return '<a class="ad" href="index.html?listing=' + encodeURIComponent(a.id) + '">' +
          '<div class="ad-media">' + media + '</div>' +
          '<div class="ad-body"><h3>' + esc(a.title || 'Listing') + '</h3>' +
          '<div class="price">' + priceOf(a) + '</div>' +
          (a._boosted ? '<div class="boosted">🚀 BOOSTED</div>' : '') +
          '<div class="meta">' + esc(a.condition || '') + (a.location ? ' · ' + esc(a.location) : '') + '</div>' +
          '</div></a>';
      }).join('');
    }

    /* 3. Message area. Threads are anchored to a listing, so the
       composer sends against the seller's newest live listing and
       is disabled with an honest note when there is none. Logged
       out visitors get the login link (login lives on index.html). */
    var newestId = ads.length ? ads[0].id : null;
    var noteEl = document.getElementById('sellerMsgNote');
    var rowEl = document.getElementById('sellerMsgRow');
    var loginEl = document.getElementById('sellerMsgLogin');
    var user = null;
    try {
      var u = await client.auth.getUser();
      user = (u && u.data && u.data.user) ? u.data.user : null;
    } catch (e) {}
    if (!user) {
      loginEl.hidden = false;
    } else if (!newestId) {
      noteEl.textContent = 'No live listings right now, so messages can\'t be attached yet — check back once they post.';
    } else {
      rowEl.hidden = false;
      document.getElementById('sellerMsgSend').addEventListener('click', function () {
        var input = document.getElementById('sellerMsgInput');
        var body = input.value.trim();
        if (!body) { input.focus(); return; }
        var btn = document.getElementById('sellerMsgSend');
        btn.disabled = true;
        btn.textContent = 'Sending…';
        var send = (window.CFMessages && window.CFMessages.send)
          ? window.CFMessages.send(newestId, sellerId, body)
          : Promise.reject(new Error('messages unavailable'));
        send.then(function () {
          rowEl.hidden = true;
          document.getElementById('sellerMsgSent').hidden = false;
        }).catch(function () {
          btn.disabled = false;
          btn.textContent = 'Send message';
          noteEl.textContent = 'Could not send that message — try again.';
        });
      });
    }

    if (stateEl) stateEl.hidden = true;
    if (pageEl) pageEl.hidden = false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
