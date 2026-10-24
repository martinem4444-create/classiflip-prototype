/* ClassiFlip real auth v1.1 — Supabase (marketplace-dev). Auto-closes the account box on success.
 *
 * HOW TO SWITCH IT ON:
 * 1. Replace PASTE_YOUR_PUBLISHABLE_KEY_HERE below with the project's
 *    publishable key (Supabase dashboard -> Settings -> API -> API Keys).
 *    The publishable key is public by design: it ships in this file for
 *    every visitor to see, and the database security rules are what
 *    protect the data. NEVER paste the secret key here.
 * 2. Upload this file next to index.html and keep the two script tags
 *    at the end of index.html.
 * Until the key is pasted in, this file does nothing and the page keeps
 * its original demo behaviour, so the zip is safe to deploy either way.
 *
 * WHAT IT DOES:
 * - Replaces the "Preview log in / Preview account creation" demo buttons
 *   with real Supabase signup and login.
 * - Signup asks for 18+ confirmation (18+ to sell) and a role
 *   (private seller or business advertiser), stored on the profile row.
 * - On every sign-in it upserts the profiles row from the account data.
 * - Restores the session on page load, so Post an ad and messaging stay
 *   available across visits. Header Log in becomes Log out when signed in.
 * - On success the account box closes on its own: at once after log in,
 *   and a few seconds after sign-up so the "check your email" note can
 *   be read first. Errors leave the box open so the user can retry.
 */
(function () {
  var CF_SUPABASE_URL = 'https://dbgmyvjaavpmernaxnav.supabase.co';
  var CF_SUPABASE_KEY = 'sb_publishable_dnMQ6lGSbCo8Ts1VBwte2Q_9D7OBNFe';

  if (!window.supabase || CF_SUPABASE_KEY.indexOf('PASTE_') === 0) return;

  var client = window.supabase.createClient(CF_SUPABASE_URL, CF_SUPABASE_KEY);
  window.CFAuth = { client: client };

  function notice(msg) {
    var n = document.getElementById('accountNotice');
    if (n) n.textContent = msg;
  }

  function closeBox() {
    if (typeof closeModals === 'function') closeModals();
  }

  function setHeaderAuthed() {
    var loginBtn = document.querySelector('[data-account-mode="login"]');
    if (loginBtn) { loginBtn.textContent = 'Log out'; loginBtn.dataset.cfLogout = '1'; }
    var createBtn = document.querySelector('[data-account-mode="create"]');
    if (createBtn) createBtn.style.display = 'none';
  }

  function setHeaderAnon() {
    var loginBtn = document.querySelector('[data-account-mode="login"]');
    if (loginBtn) { loginBtn.textContent = 'Log in'; delete loginBtn.dataset.cfLogout; }
    var createBtn = document.querySelector('[data-account-mode="create"]');
    if (createBtn) createBtn.style.display = '';
  }

  function afterSignIn(user) {
    var md = user.user_metadata || {};
    try {
      var p = client.from('profiles').upsert({
        id: user.id,
        email: user.email,
        display_name: md.display_name || null,
        role: (md.role === 'advertiser' ? 'advertiser' : 'private')
      }, { onConflict: 'id' });
      if (p && typeof p.then === 'function') p.catch(function () {});
    } catch (e) {}
    loggedIn = true;
    updateAccountUI();
    setHeaderAuthed();
  }

  client.auth.getSession().then(function (res) {
    if (res.data && res.data.session) afterSignIn(res.data.session.user);
  });

  client.auth.onAuthStateChange(function (event, session) {
    if (event === 'SIGNED_IN' && session) afterSignIn(session.user);
    if (event === 'SIGNED_OUT') { loggedIn = false; updateAccountUI(); setHeaderAnon(); }
  });

  document.addEventListener('click', function (e) {
    var logoutBtn = e.target.closest ? e.target.closest('[data-cf-logout]') : null;
    if (logoutBtn) {
      e.stopPropagation();
      e.preventDefault();
      client.auth.signOut().then(function () {
        loggedIn = false;
        updateAccountUI();
        setHeaderAnon();
        notice('You are logged out.');
      });
      return;
    }

    var demo = e.target.closest ? e.target.closest('[data-account-demo]') : null;
    if (!demo) return;
    e.stopPropagation();
    e.preventDefault();

    var pane = demo.closest('[data-account-pane]');
    var mode = pane ? pane.dataset.accountPane : 'login';

    (async function () {
      try {
        if (mode === 'create') {
          var name = document.getElementById('createName').value.trim();
          var email = document.getElementById('createEmail').value.trim();
          var pw = document.getElementById('createPassword').value;
          var adult = document.getElementById('createAdult');
          var roleSel = document.getElementById('createRole');
          if (adult && !adult.checked) { notice('Please confirm you are 18 or older to sell on ClassiFlip.'); return; }
          if (!email || pw.length < 6) { notice('Enter an email and a password of at least 6 characters.'); return; }
          var res = await client.auth.signUp({
            email: email,
            password: pw,
            options: { data: { display_name: name, role: roleSel ? roleSel.value : 'private' } }
          });
          if (res.error) throw res.error;
          if (res.data && res.data.session) {
            await afterSignIn(res.data.session.user);
          } else {
            notice('Account created. Check your email to confirm it, then log in.');
            setTimeout(closeBox, 4000);
            return;
          }
        } else {
          var le = document.getElementById('loginEmail').value.trim();
          var lp = document.getElementById('loginPassword').value;
          if (!le || !lp) { notice('Enter your email and password.'); return; }
          var r2 = await client.auth.signInWithPassword({ email: le, password: lp });
          if (r2.error) throw r2.error;
          if (r2.data && r2.data.session) await afterSignIn(r2.data.session.user);
        }
        var pending = null;
        if (typeof pendingMessageListingId !== 'undefined' && pendingMessageListingId) {
          pending = listings.find(function (x) { return x.id === pendingMessageListingId; });
        }
        pendingMessageListingId = null;
        if (pending) { closeModals(); openMessageThread(pending); }
        else { closeBox(); }
      } catch (err) {
        notice(err && err.message ? err.message : 'Something went wrong. Please try again.');
      }
    })();
  }, true);
})();
