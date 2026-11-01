/* ClassiFlip founding-spot gate (Oct 31, 2026 — Martin's ruling).
 *
 * Founding spots are capped at 10 per category (dealers, agents,
 * rentals, services, jobs = 50 total). This script asks the database
 * how many spots each category has taken (cf_founding_counts RPC —
 * counts only, no buyer data) and closes the founding offer for any
 * category that is full:
 *
 * - advertise.html: the category's "Founding: $X" price rows flip to
 *   "Founding spots sold out", its Claim buttons disable, the claim
 *   modal drops the sold-out packages, and if ALL categories fill,
 *   the founding banner + bottom CTA switch to sold-out copy.
 * - advertise-pay.html: sold-out categories disable in the order
 *   form's category picker; if ALL categories fill, the founding
 *   tiers disable in the package dropdown and the founding card's
 *   buy/reserve links switch off.
 *
 * The database trigger (cf-founding-cap-migration.sql) is the hard
 * backstop — this script is the friendly front door. If the RPC is
 * missing or fails (e.g. the migration has not been run yet), the
 * page behaves exactly as before: everything stays offered.
 *
 * Exposes window.CFFounding = { ready, counts, isSoldOut(cat),
 * allSoldOut() } for cf-orders.js (submit-time friendly check).
 */
(function () {
  'use strict';

  var CAP = 10;
  var CATS = ['dealers', 'agents', 'rentals', 'services', 'jobs'];
  /* Claim-modal package prefixes on advertise.html -> category key. */
  var CLAIM_PREFIX = {
    'Dealer': 'dealers',
    'Real estate': 'agents',
    'Rentals': 'rentals',
    'Services': 'services',
    'Jobs': 'jobs'
  };

  var api = {
    counts: null,
    ready: null,
    isSoldOut: function (cat) {
      return !!(api.counts && (api.counts[cat] || 0) >= CAP);
    },
    allSoldOut: function () {
      if (!api.counts) return false;
      return CATS.every(function (c) { return (api.counts[c] || 0) >= CAP; });
    }
  };
  window.CFFounding = api;

  function getClient() {
    try {
      if (window.CFAuth && window.CFAuth.client) return window.CFAuth.client;
    } catch (e) {}
    return null;
  }

  function fetchCounts() {
    var client = getClient();
    if (!client) return Promise.resolve(null);
    return client.rpc('cf_founding_counts').then(function (r) {
      if (!r || r.error || !r.data) return null;
      var out = {};
      CATS.forEach(function (c) { out[c] = 0; });
      r.data.forEach(function (row) {
        if (row && row.category) out[row.category] = row.taken || 0;
      });
      return out;
    }).catch(function () { return null; });
  }

  /* ---------- advertise.html ---------- */

  function gateAdvertise(counts) {
    CATS.forEach(function (cat) {
      if ((counts[cat] || 0) < CAP) return;
      var sect = document.querySelector('.sect[data-cat="' + cat + '"]');
      if (!sect) return;
      sect.querySelectorAll('.fnd').forEach(function (f) {
        f.innerHTML = '<b>Founding spots sold out</b>';
      });
      sect.querySelectorAll('button').forEach(function (b) {
        if (b.getAttribute('onclick') && b.getAttribute('onclick').indexOf('claim(') === 0) {
          b.disabled = true;
          b.textContent = 'Founding sold out';
          b.style.opacity = '.55';
          b.style.cursor = 'not-allowed';
        }
      });
    });

    /* Claim modal: drop sold-out categories from the package list.
       claim() rebuilds the <select> on every open, so wrap it. */
    if (typeof window.claim === 'function' && !window.claim.__cfWrapped) {
      var orig = window.claim;
      var wrapped = function (pkg) {
        orig(pkg);
        var sel = document.getElementById('cPkg');
        if (!sel) return;
        var soldPrefix = Object.keys(CLAIM_PREFIX).filter(function (p) {
          return (counts[CLAIM_PREFIX[p]] || 0) >= CAP;
        });
        if (!soldPrefix.length) return;
        var kept = [];
        Array.prototype.forEach.call(sel.options, function (o) {
          var sold = soldPrefix.some(function (p) { return o.text.indexOf(p + ' —') === 0; });
          if (!sold) kept.push(o.text);
        });
        if (pkg && soldPrefix.some(function (p) { return pkg.indexOf(p + ' —') === 0; })) {
          sel.innerHTML = kept.map(function (t) { return '<option>' + t + '</option>'; }).join('');
          var m = document.getElementById('cMsg2');
          if (m) {
            m.textContent = 'That category\u2019s founding spots just sold out — pick another category, or standard rates apply.';
            m.style.display = 'block';
            m.style.color = '#B3372A';
          }
        } else {
          sel.innerHTML = kept.map(function (t) {
            return '<option' + (t === pkg ? ' selected' : '') + '>' + t + '</option>';
          }).join('');
        }
      };
      wrapped.__cfWrapped = true;
      window.claim = wrapped;
    }

    if (api.allSoldOut()) {
      var banner = document.querySelector('.found');
      if (banner) {
        var t = banner.querySelector('.t');
        if (t) t.textContent = 'FOUNDING ADVERTISERS — SOLD OUT';
        var ul = banner.querySelector('ul');
        if (ul) ul.innerHTML = '<li>All 50 founding spots are claimed. Standard rates below now apply — still half the big boards, every eyeball local.</li>';
      }
      var ctaBtn = document.querySelector('.cta button');
      if (ctaBtn) {
        ctaBtn.disabled = true;
        ctaBtn.textContent = 'Founding spots sold out';
        ctaBtn.style.opacity = '.55';
        ctaBtn.style.cursor = 'not-allowed';
      }
      var ctaP = document.querySelector('.cta p');
      if (ctaP) ctaP.textContent = 'All 50 founding spots are gone. Standard rates now apply.';
    }
  }

  /* ---------- advertise-pay.html ---------- */

  function gatePay(counts) {
    /* Category picker: disable the full categories. */
    var catSel = document.getElementById('orderCategory');
    if (catSel) {
      Array.prototype.forEach.call(catSel.options, function (o) {
        if (o.value && (counts[o.value] || 0) >= CAP) {
          o.disabled = true;
          o.textContent = o.textContent + ' — founding sold out';
        }
      });
      if (catSel.value && (counts[catSel.value] || 0) >= CAP) catSel.value = '';
    }

    if (!api.allSoldOut()) return;

    /* Every category full: founding tiers + founding card switch off. */
    var pkgSel = document.getElementById('orderPackage');
    if (pkgSel) {
      Array.prototype.forEach.call(pkgSel.options, function (o) {
        if (o.value.indexOf('founding-') === 0) {
          o.disabled = true;
          o.textContent = o.textContent + ' — sold out';
        }
      });
      if (pkgSel.value.indexOf('founding-') === 0) {
        pkgSel.value = 'dealer-single';
        pkgSel.dispatchEvent(new Event('change'));
      }
    }
    var banner = document.querySelector('.found');
    if (banner) {
      var t = banner.querySelector('.t');
      if (t) t.textContent = 'FOUNDING ADVERTISERS — SOLD OUT';
      banner.querySelectorAll('a.fpay, a.orderlink').forEach(function (a) {
        a.textContent = 'Founding spots sold out';
        a.removeAttribute('href');
        a.style.pointerEvents = 'none';
        a.style.opacity = '.55';
      });
    }
  }

  function apply() {
    if (!api.counts) return;
    gateAdvertise(api.counts);
    gatePay(api.counts);
  }

  api.ready = fetchCounts().then(function (counts) {
    api.counts = counts;
    if (counts) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply);
      } else {
        apply();
      }
    }
    return counts;
  });
})();
