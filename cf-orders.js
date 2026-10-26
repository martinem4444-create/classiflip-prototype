/* ClassiFlip Interac orders v1 (step 4) — Supabase (marketplace-dev).
 *
 * WHAT IT DOES:
 * - Wires the "Reserve with Interac e-Transfer" links on advertise-pay.html:
 *   clicking one preselects that package in the Interac order form and
 *   scrolls to it.
 * - Submitting the form creates one row in public.orders (status defaults
 *   to 'Pending'; order_number defaults to the sequential CF-1001+ value
 *   from the database) and shows the buyer their order number plus the
 *   Interac instructions (e-Transfer to mm905media@gmail.com with the
 *   order number in the message). Martin activates the order from the
 *   dashboard admin queue; activation sets 30-day expiry.
 * - Boost Interac reserve (Oct 26, option 1): the boost card's
 *   "Reserve with Interac e-Transfer →" link opens an inline panel
 *   with a picker of the buyer's own ACTIVE ads (signed-in only) and
 *   inserts a Pending row in public.boosts (BST code from the
 *   database), mirroring the dashboard real boost flow. NOT a
 *   package: it never touches public.orders or the PACKAGES map.
 *
 * SECURITY NOTES:
 * - No keys in this file. It reuses window.CFAuth.client (the live
 *   keyed copy on the live site; the local placeholder copy means no
 *   client here, and the form then explains it needs the live site).
 * - Orders insert is allowed by the existing orders_create policy (the
 *   schema's design: anyone may create an order; only the buyer or an
 *   admin may read/update it). The buyer_id is attached when signed in;
 *   logged-out reservations have buyer_id null and are claimed by their
 *   order number — they appear in the admin queue either way.
 */
(function () {
  'use strict';

  /* key -> [display label, amount CAD]. Matches the prices printed on
     advertise-pay.html. Boost ($2.99) is deliberately NOT here: it is
     not an Interac package and must never create an orders row. The
     boost Interac reserve lives in its own section below and writes
     to public.boosts, not public.orders. */
  var PACKAGES = {
    'founding-single': ['Founding Single', 29],
    'founding-featured': ['Founding Featured', 79],
    'founding-unlimited': ['Founding Unlimited', 149],
    'dealer-single': ['Dealer Single Ad', 49],
    'dealer-lot-pack': ['Dealer Lot Pack', 149],
    'dealer-unlimited': ['Dealer Unlimited', 249],
    'agent-single': ['Agent Single Listing', 39],
    'agent-5-pack': ['Agent 5-Pack', 129],
    'agent-unlimited': ['Agent Unlimited', 199],
    'services-single': ['Services Single Service Ad', 29],
    'services-unlimited': ['Services Pro Unlimited', 99],
    'jobs-single': ['Jobs Single Job Post', 49],
    'jobs-unlimited': ['Jobs Employer Unlimited', 179]
  };

  /* Package-card button -> order-form option (the founding card has one
     button for three tiers, so it preselects the entry tier; the buyer
     can switch tiers in the dropdown). */
  var CARD_TO_OPTION = {
    'founding-advertiser': 'founding-single',
    'dealer-single': 'dealer-single',
    'dealer-lot-pack': 'dealer-lot-pack',
    'dealer-unlimited': 'dealer-unlimited',
    'agent-single': 'agent-single',
    'agent-5-pack': 'agent-5-pack',
    'agent-unlimited': 'agent-unlimited',
    'services-single': 'services-single',
    'services-unlimited': 'services-unlimited',
    'jobs-single': 'jobs-single',
    'jobs-unlimited': 'jobs-unlimited'
  };

  function getClient() {
    try {
      if (window.CFAuth && window.CFAuth.client) return window.CFAuth.client;
    } catch (e) {}
    return null;
  }

  function el(id) { return document.getElementById(id); }

  function money(n) {
    try {
      return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n);
    } catch (e) { return '$' + n; }
  }

  function notice(t) {
    var n = el('orderNotice');
    if (n) n.textContent = t;
  }

  function updateAmount() {
    var sel = el('orderPackage'), amt = el('orderAmount');
    if (sel && amt && PACKAGES[sel.value]) amt.textContent = money(PACKAGES[sel.value][1]);
  }

  document.addEventListener('click', function (e) {
    var r = e.target.closest ? e.target.closest('[data-order-package]') : null;
    if (!r) return;
    e.preventDefault();
    var key = CARD_TO_OPTION[r.dataset.orderPackage] || r.dataset.orderPackage;
    var sel = el('orderPackage');
    if (sel && PACKAGES[key]) { sel.value = key; updateAmount(); }
    var form = el('orderForm');
    if (form) form.scrollIntoView({ behavior: 'smooth' });
    var biz = el('orderBusiness');
    if (biz) { try { biz.focus({ preventScroll: true }); } catch (err) { biz.focus(); } }
  });

  var sel0 = el('orderPackage');
  if (sel0) sel0.addEventListener('change', updateAmount);
  updateAmount();

  var submit = el('orderSubmit');
  if (submit) submit.addEventListener('click', async function () {
    var business = el('orderBusiness').value.trim();
    var name = el('orderName').value.trim();
    var email = el('orderEmail').value.trim();
    var phone = el('orderPhone').value.trim();
    var pkgKey = el('orderPackage').value;
    if (!business || !name || !email || !PACKAGES[pkgKey]) {
      notice('Please fill in business name, your name, email, and a package.');
      return;
    }
    var client = getClient();
    if (!client) {
      notice('Checkout needs the live site connection — please open the live site to reserve.');
      return;
    }
    submit.disabled = true;
    var orig = submit.textContent;
    submit.textContent = 'Reserving…';
    try {
      var buyerId = null;
      try {
        var u = await client.auth.getUser();
        if (u && u.data && u.data.user) buyerId = u.data.user.id;
      } catch (e) {}
      var row = {
        business_name: business,
        package: PACKAGES[pkgKey][0],
        amount: PACKAGES[pkgKey][1],
        buyer_name: name,
        buyer_email: email,
        buyer_phone: phone || null,
        buyer_id: buyerId,
        payment_method: 'etransfer'
      };
      var res = await client.from('orders').insert([row]).select('order_number').single();
      if (res.error) throw res.error;
      var num = (res.data && res.data.order_number) ? res.data.order_number : 'CF-????';
      el('orderNumberBig').textContent = num;
      el('orderNumberBig2').textContent = num;
      el('orderAmountBig').textContent = money(PACKAGES[pkgKey][1]) + ' CAD';
      el('orderSummary').textContent = PACKAGES[pkgKey][0] + ' · ' + business + ' · reserved as ' + num + ' (status: Pending).';
      el('orderDone').style.display = 'block';
      notice('');
      el('orderDone').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      notice('Could not reserve: ' + (err && err.message ? err.message : 'Something went wrong.'));
    }
    submit.disabled = false;
    submit.textContent = orig;
  });

  /* ---------- Advertise-pay boost Interac reserve (Oct 26, 2026) ----
   * Option 1, approved Oct 26: the boost card on advertise-pay.html
   * has only a placeholder Stripe button, so this adds the working
   * Interac path WITHOUT touching that button (a known launch gate).
   * A boost requires a listing, so the flow is:
   *   1. Buyer clicks "Reserve with Interac e-Transfer →" on the
   *      boost card -> the #boostReserve panel opens.
   *   2. Signed-out buyers see a sign-in notice (this page and the
   *      Dashboard have no sign-in form; index.html does) and are
   *      sent to sign in / Dashboard. No picker, no insert.
   *   3. Signed-in buyers get a picker of their own ACTIVE ads
   *      (seller_id = auth.uid(), status = 'active' — the same
   *      rule the boosts_create policy enforces, so the insert
   *      cannot target someone else's ad).
   *   4. Reserve inserts a Pending row in public.boosts
   *      (payment_method 'etransfer', amount 2.99; payment_ref is
   *      the DB-generated BST code) and shows the BST code plus the
   *      Interac instructions, mirroring the dashboard real boost
   *      flow's honest copy ("Payment sent — Martin activates your
   *      boost"). NO fake "Ad boosted!" state: the boost only goes
   *      live when Martin activates it.
   *   5. If the BST code cannot be read back, the row is rolled
   *      back and the step-5 SQL error is shown — a code-less
   *      Pending boost is never left behind (same rule as the
   *      dashboard flow).
   * This section never touches PACKAGES, the order form, or the
   * placeholder Stripe button. */
  var BOOST_PRICE = 2.99;
  var BOOST_ADMIN_EMAIL = 'mm905media@gmail.com';
  var boostAdsById = {};

  function boostNotice(t) {
    var n = el('boostReserveNotice');
    if (n) n.textContent = t;
  }

  function boostShow(id) {
    ['boostReserveSignedOut', 'boostReserveForm', 'boostReserveDone'].forEach(function (x) {
      var d = el(x);
      if (d) d.style.display = (x === id) ? 'block' : 'none';
    });
  }

  async function loadBoostPicker() {
    boostShow(null);
    boostNotice('');
    var client = getClient();
    if (!client) {
      boostNotice('Checkout needs the live site connection — please open the live site to reserve.');
      return;
    }
    var user = null;
    try {
      var u = await client.auth.getUser();
      if (u && u.data && u.data.user) user = u.data.user;
    } catch (e) {}
    if (!user) {
      boostShow('boostReserveSignedOut');
      return;
    }
    var sel = el('boostListing');
    if (sel) sel.innerHTML = '';
    boostAdsById = {};
    var res;
    try {
      res = await client.from('listings')
        .select('id,title,price')
        .eq('seller_id', user.id).eq('status', 'active')
        .order('created_at', { ascending: false }).limit(100);
    } catch (e) { res = { error: e }; }
    if (!res || res.error) {
      boostNotice('Could not load your ads: ' + (res && res.error && res.error.message ? res.error.message : 'Something went wrong.'));
      return;
    }
    var ads = res.data || [];
    if (!ads.length) {
      boostNotice('You have no active ads yet — post an ad from your Dashboard first.');
      return;
    }
    ads.forEach(function (a) {
      boostAdsById[a.id] = a.title || 'This ad';
      if (sel) {
        var opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = (a.title || 'Untitled ad') + ' — ' + money(a.price || 0);
        sel.appendChild(opt);
      }
    });
    boostShow('boostReserveForm');
  }

  var boostLink = document.querySelector('[data-boost-interac]');
  if (boostLink) boostLink.addEventListener('click', async function (e) {
    e.preventDefault();
    var panel = el('boostReserve');
    if (!panel) return;
    panel.style.display = 'block';
    panel.scrollIntoView({ behavior: 'smooth' });
    await loadBoostPicker();
  });

  var boostSubmit = el('boostReserveSubmit');
  if (boostSubmit) boostSubmit.addEventListener('click', async function () {
    var sel = el('boostListing');
    var listingId = sel ? sel.value : '';
    if (!listingId) {
      boostNotice('Pick an ad to boost.');
      return;
    }
    var client = getClient();
    if (!client) {
      boostNotice('Checkout needs the live site connection — please open the live site to reserve.');
      return;
    }
    var user = null;
    try {
      var u = await client.auth.getUser();
      if (u && u.data && u.data.user) user = u.data.user;
    } catch (e) {}
    if (!user) {
      boostShow('boostReserveSignedOut');
      return;
    }
    boostSubmit.disabled = true;
    var orig = boostSubmit.textContent;
    boostSubmit.textContent = 'Reserving…';
    try {
      var ins = await client.from('boosts').insert([{
        listing_id: listingId, buyer_id: user.id,
        amount: BOOST_PRICE, payment_method: 'etransfer', status: 'Pending'
      }]).select('id').single();
      if (ins.error || !ins.data || !ins.data.id) throw ins.error || new Error('Could not reserve the boost.');
      var codeRes = await client.from('boosts').select('payment_ref').eq('id', ins.data.id).maybeSingle();
      var bst = codeRes && codeRes.data && codeRes.data.payment_ref;
      if (codeRes.error || !bst) {
        try { await client.from('boosts').delete().eq('id', ins.data.id); } catch (e2) {}
        throw new Error('The step-5 SQL has not been run yet — boosts need it first (BST codes). Run supabase/cf-boost-migration.sql, then try again.');
      }
      el('boostBstBig').textContent = bst;
      el('boostBstBig2').textContent = bst;
      el('boostAdTitle').textContent = boostAdsById[listingId] || 'This ad';
      boostShow('boostReserveDone');
      boostNotice('');
      el('boostReserveDone').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      boostNotice('Could not reserve the boost: ' + (err && err.message ? err.message : 'Something went wrong.'));
    }
    boostSubmit.disabled = false;
    boostSubmit.textContent = orig;
  });
})();
