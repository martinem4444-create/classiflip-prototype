/* ClassiFlip password recovery v1 — "Forgot password?" for the account modal.
 *
 * WHAT IT DOES:
 * - Adds a "Forgot password?" link under the Log in button. It opens a
 *   reset form (email only) that sends a Supabase password-reset email.
 *   The notice afterwards is deliberately neutral so it never reveals
 *   whether an email has an account.
 * - When a reset link brings the visitor back (URL hash has
 *   type=recovery), it opens the account modal with a "Set a new
 *   password" form (new password + confirm, minimum 6 characters, the
 *   same rule as account settings). Saving updates the password and
 *   leaves the visitor logged in.
 *
 * HOW IT HOOKS IN:
 * - It reuses the Supabase client the live auth module already exposes
 *   as window.CFAuth.client, so cf-auth.js is never touched.
 * - All markup is injected by this file; index.html only gains the
 *   script tag. If window.CFAuth is missing (auth not switched on),
 *   this file does nothing: no errors, no visible change.
 * - It never logs an email address or any token.
 */
(function () {
  var auth = (window.CFAuth && window.CFAuth.client && window.CFAuth.client.auth)
    ? window.CFAuth.client.auth : null;
  if (!auth) return;

  var modal = document.getElementById('accountModal');
  var loginPane = modal ? modal.querySelector('[data-account-pane="login"]') : null;
  var noticeEl = document.getElementById('accountNotice');
  if (!modal || !loginPane) return;

  var SITE_URL = 'https://martinem4444-create.github.io/classiflip-prototype/';

  function notice(msg) {
    if (noticeEl) noticeEl.textContent = msg;
  }

  function setPane(mode) {
    if (typeof setAccountMode === 'function') { setAccountMode(mode); return; }
    document.querySelectorAll('[data-account-pane]').forEach(function (p) {
      p.classList.toggle('active', p.dataset.accountPane === mode);
    });
    document.querySelectorAll('[data-account-tab]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.accountTab === mode);
    });
  }

  function openAccountModal() {
    if (typeof openModal === 'function') openModal('accountModal');
    else modal.classList.add('open');
  }

  function closeAccountModal() {
    if (typeof closeModals === 'function') closeModals();
    else modal.classList.remove('open');
  }

  /* --- Build the two panes (reset request + set new password) --- */
  var dialogBody = modal.querySelector('.dialog-body');

  var recoveryPane = document.createElement('div');
  recoveryPane.className = 'account-pane';
  recoveryPane.setAttribute('data-account-pane', 'recovery');
  recoveryPane.innerHTML =
    '<p>Enter the email you signed up with and we will send you a reset link.</p>' +
    '<div class="field"><label for="cfResetEmail">Email</label>' +
    '<input id="cfResetEmail" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
    '<button type="button" class="primary" data-cf-reset-send>Send reset link</button>' +
    '<button type="button" class="link-btn" data-cf-reset-back>Back to log in</button>';
  dialogBody.appendChild(recoveryPane);

  var setPane2 = document.createElement('div');
  setPane2.className = 'account-pane';
  setPane2.setAttribute('data-account-pane', 'setpassword');
  setPane2.innerHTML =
    '<p>Choose a new password for your account.</p>' +
    '<div class="field"><label for="cfNewPassword">New password</label>' +
    '<input id="cfNewPassword" type="password" autocomplete="new-password" placeholder="At least 6 characters"></div>' +
    '<div class="field" style="margin-top:12px"><label for="cfNewPassword2">Confirm new password</label>' +
    '<input id="cfNewPassword2" type="password" autocomplete="new-password" placeholder="Repeat the new password"></div>' +
    '<button type="button" class="primary" data-cf-set-password>Save new password</button>' +
    '<button type="button" class="link-btn" data-cf-set-back>Request a new reset link</button>';
  dialogBody.appendChild(setPane2);

  /* --- "Forgot password?" link under the Log in button --- */
  var loginBtn = loginPane.querySelector('[data-account-demo]');
  var forgotBtn = document.createElement('button');
  forgotBtn.type = 'button';
  forgotBtn.className = 'link-btn';
  forgotBtn.setAttribute('data-cf-forgot', '1');
  forgotBtn.textContent = 'Forgot password?';
  if (loginBtn && loginBtn.parentNode) {
    loginBtn.parentNode.insertBefore(forgotBtn, loginBtn.nextSibling);
  } else {
    loginPane.appendChild(forgotBtn);
  }

  /* --- Click handling (own attributes only; never data-account-demo) --- */
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;

    if (t.closest('[data-cf-forgot]')) {
      var le = document.getElementById('loginEmail');
      var re = document.getElementById('cfResetEmail');
      if (le && re && le.value.trim()) re.value = le.value.trim();
      setPane('recovery');
      if (re) re.focus();
      return;
    }

    if (t.closest('[data-cf-reset-back]')) {
      setPane('login');
      return;
    }

    if (t.closest('[data-cf-set-back]')) {
      setPane('recovery');
      return;
    }

    if (t.closest('[data-cf-reset-send]')) {
      var emailEl = document.getElementById('cfResetEmail');
      var email = emailEl ? emailEl.value.trim() : '';
      if (!email || email.indexOf('@') === -1) {
        notice('Enter a valid email address.');
        return;
      }
      var btn = t.closest('[data-cf-reset-send]');
      btn.disabled = true;
      auth.resetPasswordForEmail(email, { redirectTo: SITE_URL }).then(function () {
        notice('If an account exists for that email, a reset link is on its way.');
        btn.disabled = false;
      }).catch(function () {
        /* Neutral on purpose: never reveal whether the email exists. */
        notice('If an account exists for that email, a reset link is on its way.');
        btn.disabled = false;
      });
      return;
    }

    if (t.closest('[data-cf-set-password]')) {
      var pw1 = document.getElementById('cfNewPassword');
      var pw2 = document.getElementById('cfNewPassword2');
      var npw = pw1 ? pw1.value : '';
      var cpw = pw2 ? pw2.value : '';
      if (!npw || npw.length < 6 || npw !== cpw) {
        notice('Passwords must match and be at least 6 characters.');
        return;
      }
      var btn2 = t.closest('[data-cf-set-password]');
      btn2.disabled = true;
      auth.updateUser({ password: npw }).then(function (res) {
        if (res.error) throw res.error;
        if (pw1) pw1.value = '';
        if (pw2) pw2.value = '';
        notice('Password updated — you are logged in.');
        if (typeof updateAccountUI === 'function') {
          try { updateAccountUI(); } catch (err) {}
        }
        setTimeout(closeAccountModal, 2000);
        btn2.disabled = false;
      }).catch(function (err) {
        var msg = err && err.message ? err.message : '';
        if (/expired|invalid/i.test(msg)) {
          notice('That link expired. Request a new reset link.');
        } else {
          notice(msg || 'Something went wrong. Please try again.');
        }
        btn2.disabled = false;
      });
      return;
    }
  });

  /* --- Recovery return: URL hash carries type=recovery --- */
  var recoveryHandled = false;

  function cleanRecoveryHash() {
    try {
      if (window.history && history.replaceState) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    } catch (err) {}
  }

  function showSetPassword() {
    if (recoveryHandled) return;
    recoveryHandled = true;
    openAccountModal();
    setPane('setpassword');
    notice('Choose a new password for your account.');
    cleanRecoveryHash();
  }

  function showExpired() {
    if (recoveryHandled) return;
    recoveryHandled = true;
    openAccountModal();
    setPane('recovery');
    notice('That link expired. Request a new reset link.');
    cleanRecoveryHash();
  }

  /* Primary trigger: Supabase fires PASSWORD_RECOVERY once the reset
     session from the link is established. */
  auth.onAuthStateChange(function (event) {
    if (event === 'PASSWORD_RECOVERY') showSetPassword();
  });

  /* Fallback: if the event already fired before this file loaded, the
     session is already established and getSession sees it. Only strip
     the hash after the session check resolves, so detection is never
     broken by cleaning up too early. */
  if ((window.location.hash || '').indexOf('type=recovery') !== -1) {
    auth.getSession().then(function (res) {
      if (res.data && res.data.session) showSetPassword();
      else showExpired();
    }).catch(function () {
      showExpired();
    });
  }
})();
