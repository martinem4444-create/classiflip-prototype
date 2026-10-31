/* ClassiFlip real messages v1 — Supabase (marketplace-dev).
   Real threads + sends; demo fallback preserved. Reuses window.CFAuth.client (no keys).
   RLS: messages_participants — only the two people in a chat can read; inserts require sender_id = auth.uid().
   Note: both parties need a profiles row (FK), so in testing state each tester needs the manual SQL row first. */
(function () {
  if (window.CFMessages) return;

  function getClient() {
    try {
      if (window.CFAuth && window.CFAuth.client) return window.CFAuth.client;
    } catch (e) {}
    return null;
  }

  /* Launch gate (Oct 31, 2026, Martin's call): the Messages PAGE is
     members-only. This module also loads on index, seller and
     dashboard pages, so the gate is scoped to messaging.html ONLY.
     With a live auth client and NO session, bounce to the homepage
     instead of serving the demo threads. No client yet never bounces
     — the check polls until the client appears; SIGNED_OUT bounces. */
  (function gateBoot() {
    var onMessagesPage = false;
    try { onMessagesPage = /(^|\/)messaging\.html$/.test(location.pathname); } catch (e) {}
    if (!onMessagesPage) return;
    var done = false;
    function bounce() {
      if (done) return;
      done = true;
      try { location.replace('index.html'); } catch (e) {}
    }
    function check() {
      var client = getClient();
      if (!client) return false;
      try {
        if (!check.subscribed && client.auth.onAuthStateChange) {
          check.subscribed = true;
          client.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT') bounce(); });
        }
      } catch (e) {}
      client.auth.getSession().then(function (s) {
        if (!(s && s.data && s.data.session)) bounce();
      }).catch(function () {});
      return true;
    }
    if (check()) return;
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (check() || tries > 20) clearInterval(iv);
    }, 250);
  })();

  async function getUser() {
    var client = getClient();
    if (!client) return null;
    try {
      var res = await client.auth.getUser();
      return res && res.data && res.data.user ? res.data.user : null;
    } catch (e) { return null; }
  }

  function relTime(iso) {
    try {
      var mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
      if (mins < 60) return mins + 'm';
      var hrs = Math.round(mins / 60);
      if (hrs < 24) return hrs + 'h';
      return Math.round(hrs / 24) + 'd';
    } catch (e) { return ''; }
  }

  /* Privacy (Martin, Oct 30, 2026): chat shows FIRST NAME ONLY —
     never a last name. Trims the profile display_name to its
     first word at display time; the stored name is untouched. */
  function firstName(dn) {
    var t = (dn || '').trim();
    if (!t) return '';
    return t.split(/\s+/)[0];
  }

  function clockTime(iso) {
    try {
      var d = new Date(iso);
      var h = d.getHours(), m = ('0' + d.getMinutes()).slice(-2);
      var ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (!h) h = 12;
      return h + ':' + m + ' ' + ap;
    } catch (e) { return ''; }
  }

  function money(n) {
    try { return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n); }
    catch (e) { return '$' + n; }
  }

  async function getSellerId(listingId) {
    var client = getClient();
    if (!client) return null;
    try {
      var res = await client.from('listings').select('seller_id').eq('id', listingId).maybeSingle();
      if (res.error || !res.data) return null;
      return res.data.seller_id || null;
    } catch (e) { return null; }
  }

  /* Threads for the logged-in user: one per (listing, other party).
     Returns null when logged out, [] when logged in with no real threads yet. */
  async function listThreads() {
    var client = getClient();
    var me = await getUser();
    if (!client || !me) return null;
    try {
      var res = await client.from('messages')
        .select('id,listing_id,sender_id,receiver_id,body,is_read,created_at')
        .or('sender_id.eq.' + me.id + ',receiver_id.eq.' + me.id)
        .order('created_at', { ascending: false })
        .limit(200);
      if (res.error || !res.data || !res.data.length) return [];
      var groups = {}, order = [];
      res.data.forEach(function (m) {
        var other = m.sender_id === me.id ? m.receiver_id : m.sender_id;
        var key = m.listing_id + '|' + other;
        if (!groups[key]) { groups[key] = { listingId: m.listing_id, otherId: other, lastBody: m.body, lastAt: m.created_at, unread: 0 }; order.push(key); }
        if (m.receiver_id === me.id && !m.is_read) groups[key].unread++;
      });
      var listingIds = order.map(function (k) { return groups[k].listingId; });
      var otherIds = order.map(function (k) { return groups[k].otherId; });
      var listingsById = {}, profilesById = {};
      try {
        var lr = await client.from('listings').select('id,title,price,photo_url').in('id', listingIds);
        (lr.data || []).forEach(function (r) { listingsById[r.id] = r; });
      } catch (e) {}
      try {
        var pr = await client.rpc('get_display_names', { ids: otherIds });
        (pr.data || []).forEach(function (r) { profilesById[r.id] = r; });
      } catch (e) {}
      return order.map(function (k) {
        var g = groups[k], l = listingsById[g.listingId] || {}, p = profilesById[g.otherId] || {};
        return {
          id: 'live:' + g.listingId + ':' + g.otherId,
          live: true, listingId: g.listingId, otherId: g.otherId,
          name: firstName(p.display_name) || 'Seller',
          ad: l.title || 'Listing',
          price: (l.price === undefined || l.price === null) ? '' : money(l.price),
          img: l.photo_url || '',
          time: relTime(g.lastAt),
          unread: g.unread > 0,
          qr: ['Is this still available?', 'Can I pick it up tomorrow?', 'What is your lowest price?'],
          msgs: []
        };
      });
    } catch (e) { return []; }
  }

  /* Full history for one (listing, other party) pair, oldest first.
     Shape matches the demo thread format: [[who, text, time], ...]. */
  async function getMessages(listingId, otherId) {
    var client = getClient();
    var me = await getUser();
    if (!client || !me) return null;
    try {
      var res = await client.from('messages')
        .select('sender_id,receiver_id,body,created_at')
        .eq('listing_id', listingId)
        .or('and(sender_id.eq.' + me.id + ',receiver_id.eq.' + otherId + '),and(sender_id.eq.' + otherId + ',receiver_id.eq.' + me.id + ')')
        .order('created_at', { ascending: true })
        .limit(200);
      if (res.error || !res.data) return [];
      try {
        await client.from('messages').update({ is_read: true })
          .eq('listing_id', listingId).eq('sender_id', otherId).eq('receiver_id', me.id).eq('is_read', false);
      } catch (e) {}
      return res.data.map(function (m) {
        return [m.sender_id === me.id ? 'me' : 'them', m.body, clockTime(m.created_at)];
      });
    } catch (e) { return []; }
  }

  async function send(listingId, receiverId, body) {
    var client = getClient();
    var me = await getUser();
    if (!client || !me) return { ok: false, error: 'Not signed in.' };
    if (!receiverId) return { ok: false, error: 'This seller has no account yet.' };
    try {
      var res = await client.from('messages').insert({ listing_id: listingId, sender_id: me.id, receiver_id: receiverId, body: body });
      if (res.error) return { ok: false, error: res.error.message || 'Send failed.' };
      return { ok: true };
    } catch (e) { return { ok: false, error: (e && e.message) || 'Send failed.' }; }
  }

  async function sendForListing(listingId, body) {
    var sellerId = await getSellerId(listingId);
    return send(listingId, sellerId, body);
  }

  /* For the marketplace detail thread: seller + history for one listing. */
  async function loadThread(listingId) {
    var sellerId = await getSellerId(listingId);
    if (!sellerId) return { sellerId: null, msgs: [] };
    return { sellerId: sellerId, msgs: await getMessages(listingId, sellerId) };
  }

  window.CFMessages = {
    listThreads: listThreads,
    getMessages: getMessages,
    send: send,
    sendForListing: sendForListing,
    loadThread: loadThread,
    getSellerId: getSellerId,
    getUser: getUser
  };
})();
