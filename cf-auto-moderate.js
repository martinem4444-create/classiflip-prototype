/* cf-auto-moderate.js v1 — BACK-POCKET SAFETY NET, OFF BY DEFAULT.
 *
 * PURPOSE: if ClassiFlip grows fast and Martin's human approval queue
 * strains, this lets clean ads from trusted sellers go live automatically
 * instead of waiting in pending. It is NOT active at launch.
 *
 * HOW TO FLIP IT (minutes, when volume demands it):
 *   1. Change ENABLED below from false to true.
 *   2. Upload ONLY this file (cf-auto-moderate.js) to GitHub Pages.
 *   3. Hard-refresh. From then on, eligible new posts go live at once;
 *      ineligible posts still land in pending for Martin, exactly as today.
 * To turn it back off, set ENABLED back to false and re-upload this file.
 *
 * WHAT IT NEVER DOES (fail-safe by design):
 *   - Never auto-approves an admin's own ad (that would bypass the
 *     self-approve guard). Admin ads always wait for another admin.
 *   - Never auto-approves a seller's first ads, a rejected seller, an
 *     ad with no photo, a Jobs/Homes/Rentals ad, or an ad matching a
 *     banned phrase or duplicating the seller's own live/pending title.
 *   - Never touches edits: an edited ad always returns to pending
 *     (dashboard editor), even with this switch on.
 *   - Never auto-activates a boost: a boosted ad's boost still waits
 *     for Martin to activate it, even if the ad itself went live.
 *   - If ANY check or the status update fails, the ad stays pending.
 *     Pending is always the safe fallback — never a silent live ad.
 *
 * ELIGIBILITY (all must pass):
 *   - Seller has at least 2 prior active ads and 0 rejected ads.
 *   - Title + description contain no banned phrase (list below).
 *   - Category is one of: Cars, Clothes, Computers, Electronics, Home,
 *     Services, Sports, Tools, Free. (Jobs, Homes, Rentals excluded.)
 *   - Price is sane: Free ads may be $0; all others must be > $0.
 *   - At least one photo (cover photo_url present).
 *   - No duplicate of the seller's own active/pending ad with the
 *     same title.
 */
(function () {
  'use strict';

  /* THE SWITCH. false = launch behaviour (every ad waits for Martin).
     true = auto-approve eligible ads only. Nothing else changes. */
  var ENABLED = false;

  var ELIGIBLE_CATEGORIES = [
    'Cars', 'Clothes', 'Computers', 'Electronics', 'Home',
    'Services', 'Sports', 'Tools', 'Free'
  ];

  /* Phrases that always send an ad to human review. Deliberately
     phrase-level, not single generic words (so "gift" alone, or a
     legitimate "investment property" style post, is not blocked). */
  var BANNED_PHRASES = [
    'crypto giveaway', 'double your bitcoin', 'double your crypto',
    'guaranteed investment', 'guaranteed profit', 'wire transfer only',
    'western union only', 'gift card payment', 'gift cards only',
    'venmo only', 'cashapp only', 'cash app only',
    'send money first', 'pay before viewing', 'free money',
    'investment opportunity guaranteed', 'bitcoin investment'
  ];

  function norm(s) { return String(s || '').toLowerCase(); }

  function hasBannedPhrase(title, desc) {
    var hay = norm(title) + ' ' + norm(desc);
    for (var i = 0; i < BANNED_PHRASES.length; i++) {
      if (hay.indexOf(BANNED_PHRASES[i]) !== -1) return BANNED_PHRASES[i];
    }
    return null;
  }

  async function checkEligible(client, user, ad) {
    if (!ENABLED) return { eligible: false, reason: 'auto-mod off' };
    if (!client || !user || !ad) return { eligible: false, reason: 'missing data' };

    /* Admins never self-approve, even automatically. */
    try {
      var prof = await client.from('profiles').select('is_admin').eq('id', user.id).maybeSingle();
      if (prof && prof.data && prof.data.is_admin) {
        return { eligible: false, reason: 'admin ad — human review' };
      }
    } catch (e) { /* If the profile read fails, stay pending. */ return { eligible: false, reason: 'profile check failed' }; }

    if (ELIGIBLE_CATEGORIES.indexOf(ad.category) === -1) {
      return { eligible: false, reason: 'category excluded' };
    }
    if (!ad.photo_url) return { eligible: false, reason: 'no photo' };
    if (ad.category !== 'Free' && !(Number(ad.price) > 0)) {
      return { eligible: false, reason: 'price not positive' };
    }
    if (String(ad.title || '').trim().length < 5) {
      return { eligible: false, reason: 'title too short' };
    }
    var banned = hasBannedPhrase(ad.title, ad.description);
    if (banned) return { eligible: false, reason: 'banned phrase: ' + banned };

    /* Seller history: at least 2 active, 0 rejected. */
    try {
      var hist = await client.from('listings')
        .select('status').eq('seller_id', user.id).limit(200);
      if (hist.error) throw hist.error;
      var rows = hist.data || [];
      var active = 0, rejected = 0;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].status === 'active') active++;
        if (rows[i].status === 'rejected') rejected++;
      }
      if (rejected > 0) return { eligible: false, reason: 'prior rejection' };
      if (active < 2) return { eligible: false, reason: 'fewer than 2 prior active ads' };
    } catch (e) {
      return { eligible: false, reason: 'history check failed' };
    }

    /* Duplicate title from the same seller (live or pending). */
    try {
      var dup = await client.from('listings')
        .select('id').eq('seller_id', user.id).eq('title', ad.title)
        .in('status', ['active', 'pending']).limit(5);
      if (!dup.error && dup.data && dup.data.length) {
        return { eligible: false, reason: 'duplicate title' };
      }
    } catch (e) { /* Duplicate check failing is not a pass — stay pending. */
      return { eligible: false, reason: 'duplicate check failed' };
    }

    return { eligible: true, reason: 'clean trusted-seller ad' };
  }

  /* Called by cf-listings.js right after a new listing insert.
     Returns true only if the ad was actually flipped to active. */
  async function tryAutoApprove(client, user, listingId, ad) {
    try {
      var check = await checkEligible(client, user, ad);
      if (!check.eligible) return false;
      var upd = await client.from('listings')
        .update({ status: 'active' }).eq('id', listingId).eq('seller_id', user.id);
      if (upd.error) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  window.CFAutoMod = {
    ENABLED: ENABLED,
    checkEligible: checkEligible,
    tryAutoApprove: tryAutoApprove
  };
})();
