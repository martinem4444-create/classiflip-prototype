/* ClassiFlip account settings v1 — cf-account.js (Oct 26, 2026).
 *
 * WHAT IT DOES (approved spec: ClassiFlip_Account_Settings_Spec.md):
 * - Turns the header avatar + name into one button that opens an
 *   account menu: Profile · Settings · Dashboard · Sign out.
 * - Desktop: dropdown menu under the button. Phone (<=900px): the
 *   same menu as a bottom sheet (CSS-only switch, no forked logic).
 * - Profile panel (D1: separate panel, not a tab): display_name is
 *   the ONLY editable field (max 40 chars). Save upserts the row, so
 *   a missing profiles row repairs itself on first save.
 * - Settings panel (D1: separate panel): password change via
 *   updateUser (new + confirm, min 6 chars); email display + guarded
 *   change via updateUser (D3: type twice + confirmation notice).
 * - Sign out reuses cf-auth.js's existing [data-cf-logout] handler —
 *   NO new sign-out code is written here.
 * - Logout header fix (Oct 27, 2026): on logout the dashboard's
 *   hardcoded "Martin · Seller" button becomes "Log in" (click goes
 *   to index.html); it no longer fakes a signed-in header.
 * - D2: NO photo upload in v1 — the avatar stays the initial circle.
 * - Out of scope, deliberately NOT built: account deletion,
 *   notification prefs, public seller pages, phone field, role
 *   editing, is_admin input, theme row (the header toggle stays).
 *
 * HARD RULES (same as the other modules):
 * - NO API key or secret in this file. It only reuses
 *   window.CFAuth.client, which cf-auth.js already created.
 * - cf-auth.js is NEVER changed by this build. This module tolerates
 *   cf-auth.js's login-button text swap (index) and its header
 *   show/hide behaviour without fighting it.
 * - Fail-soft: no Supabase client (local placeholder-key copy, or a
 *   page without cf-auth.js) => this module does nothing at all and
 *   the page keeps its demo behaviour.
 * - User-supplied text is set via textContent / input values, never
 *   interpolated into innerHTML.
 * - Failures are never silent: saves show the real error in a toast
 *   or inline notice; reads fall back to auth data.
 */
(function () {
  'use strict';

  if (window.__cfAccountLoaded) return;
  window.__cfAccountLoaded = true;

  /* The page's own Supabase client, or null. Never a key of our own. */
  function getClient() {
    try {
      if (window.CFAuth && window.CFAuth.client) return window.CFAuth.client;
    } catch (e) {}
    return null;
  }

  var client = getClient();
  if (!client) return;

  /* ---------- small helpers ---------- */

  function emailPrefix(email) {
    if (!email) return '';
    var at = String(email).indexOf('@');
    return at > 0 ? String(email).slice(0, at) : String(email);
  }

  function roleWord(role) {
    return role === 'advertiser' ? 'Advertiser' : 'Seller';
  }

  function roleLabel(role) {
    return role === 'advertiser' ? 'Business advertiser' : 'Private seller';
  }

  function memberSinceText(createdAt) {
    if (!createdAt) return '';
    try {
      var d = new Date(createdAt);
      if (isNaN(d.getTime())) return '';
      return 'Member since ' + d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function displayNameOf(user, profile) {
    if (profile && profile.display_name) return profile.display_name;
    if (user && user.user_metadata && user.user_metadata.display_name) return user.user_metadata.display_name;
    if (user && user.email) return emailPrefix(user.email);
    return '';
  }

  function initialOf(name, email) {
    var s = name || emailPrefix(email) || '?';
    return String(s).charAt(0).toUpperCase();
  }

  function headerText(user, profile) {
    var name = displayNameOf(user, profile);
    var role = (profile && profile.role) || (user && user.user_metadata && user.user_metadata.role) || 'private';
    var text = name + ' · ' + roleWord(role);
    if (profile && profile.is_admin) text += ' · Admin';
    return text;
  }

  function validEmail(v) {
    return /[^@\s]+@[^@\s]+\.[^@\s]+/.test(String(v || ''));
  }

  /* ---------- state ---------- */

  var currentUser = null;    /* auth user object, or null when logged out */
  var currentProfile = null; /* profiles row, or null when missing/unreadable */
  var authed = false;

  /* ---------- injected CSS (one <style>, own class prefix) ---------- */

  function injectCss() {
    if (document.getElementById('cf-account-css')) return;
    var css =
      /* Converted dashboard button must look exactly like the old div. */
      'button.who,#accountMenuBtn{background:none;border:none;padding:0;font:inherit;color:inherit;cursor:pointer}' +
      /* Avatar button injected on index + thin-header pages. */
      '.cf-acct-who{display:inline-flex;align-items:center;gap:8px;background:none;border:none;padding:4px 6px;font:inherit;color:inherit;cursor:pointer;border-radius:999px}' +
      '.cf-acct-av{width:32px;height:32px;border-radius:50%;background:#2A4A7E;color:#fff;display:grid;place-items:center;font-weight:700;font-size:14px;flex:none}' +
      '.cf-acct-nm{font-size:13px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '@media(max-width:480px){.cf-acct-nm{display:none}}' +
      /* Menu backdrop + menu (dropdown desktop, bottom sheet phone). */
      '.cf-acct-backdrop{position:fixed;inset:0;background:rgba(13,21,38,.45);z-index:118;display:none}' +
      '.cf-acct-backdrop.on{display:block}' +
      '.cf-acct-menu{position:fixed;z-index:119;background:#fff;color:#1a2333;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.28);padding:8px;display:none;width:220px}' +
      '.cf-acct-menu.on{display:block}' +
      '.cf-acct-menu button,.cf-acct-menu a{display:flex;width:100%;text-align:left;padding:12px 14px;min-height:44px;align-items:center;border:none;background:none;font:inherit;font-size:15px;color:inherit;cursor:pointer;border-radius:10px;text-decoration:none;box-sizing:border-box}' +
      '.cf-acct-menu button:hover,.cf-acct-menu a:hover{background:#f0f3f9}' +
      'html[data-theme="dark"] .cf-acct-menu{background:#12161F;color:#EDF2F9}' +
      'html[data-theme="dark"] .cf-acct-menu button:hover,html[data-theme="dark"] .cf-acct-menu a:hover{background:#1D2739}' +
      '@media(max-width:900px){.cf-acct-menu{left:12px!important;right:12px!important;top:auto!important;bottom:12px!important;width:auto!important;border-radius:18px 18px 14px 14px;padding-bottom:calc(8px + env(safe-area-inset-bottom))}}' +
      /* Panels (profile + settings share one overlay + card). */
      '.cf-acct-panel{position:fixed;inset:0;z-index:121;display:none;overflow-y:auto;padding:16px;-webkit-overflow-scrolling:touch}' +
      '.cf-acct-panel.on{display:block}' +
      '.cf-acct-panel-backdrop{position:fixed;inset:0;background:rgba(13,21,38,.62);z-index:120;display:none}' +
      '.cf-acct-panel-backdrop.on{display:block}' +
      '.cf-acct-card{background:#fff;color:#1a2333;border-radius:22px;padding:26px;max-width:520px;width:100%;margin:5vh auto;position:relative;box-shadow:0 24px 70px rgba(0,0,0,.28);box-sizing:border-box}' +
      'html[data-theme="dark"] .cf-acct-card{background:#12161F;color:#EDF2F9}' +
      '.cf-acct-card h3{margin:0 0 4px;font-size:20px;letter-spacing:-.3px}' +
      '.cf-acct-card .cf-acct-sub{color:#667085;font-size:14px;margin:0 0 8px}' +
      'html[data-theme="dark"] .cf-acct-card .cf-acct-sub{color:#B9C6DA}' +
      '.cf-acct-close{position:absolute;top:14px;right:16px;background:none;border:none;font-size:26px;line-height:1;cursor:pointer;color:inherit;padding:4px}' +
      '.cf-acct-identity{display:flex;align-items:center;gap:14px;margin:14px 0 8px}' +
      '.cf-acct-bigav{width:56px;height:56px;border-radius:50%;background:#2A4A7E;color:#fff;display:grid;place-items:center;font-size:24px;font-weight:800;flex:none}' +
      '.cf-acct-identity .cf-acct-idname{font-weight:700;font-size:17px;word-break:break-word}' +
      '.cf-acct-identity .cf-acct-idrole{font-size:13.5px;color:#667085}' +
      'html[data-theme="dark"] .cf-acct-identity .cf-acct-idrole{color:#B9C6DA}' +
      '.cf-acct-field label{display:block;font-weight:600;margin:14px 0 6px;font-size:14px}' +
      '.cf-acct-field input{width:100%;padding:11px;border:1.5px solid #ccd3e2;border-radius:10px;font:inherit;background:#fff;color:inherit;box-sizing:border-box}' +
      'html[data-theme="dark"] .cf-acct-field input{background:#1A212E;border-color:#2A3448}' +
      '.cf-acct-btn-primary{border:1px solid var(--orange,#F4511E);background:var(--orange,#F4511E);color:#fff;border-radius:10px;padding:12px 18px;font:inherit;font-weight:600;cursor:pointer;margin-top:16px}' +
      '.cf-acct-btn-primary:disabled{opacity:.6;cursor:default}' +
      '.cf-acct-row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #e6e9f2;font-size:14.5px}' +
      'html[data-theme="dark"] .cf-acct-row{border-bottom-color:#232B3A}' +
      '.cf-acct-row span:last-child{color:#44506b;text-align:right;word-break:break-word}' +
      'html[data-theme="dark"] .cf-acct-row span:last-child{color:#B9C6DA}' +
      '.cf-acct-notice{background:#FFF4E5;border:1px solid #F5C97B;color:#7A4A00;padding:10px 12px;border-radius:10px;font-size:13.5px;margin:12px 0}' +
      '.cf-acct-notice.err{background:#FDECEC;border-color:#F5B5B5;color:#8B1A1A}' +
      '.cf-acct-notice.ok{background:#EAF7EE;border-color:#9ED5B0;color:#1E5C33}' +
      'html[data-theme="dark"] .cf-acct-notice{background:#2B1A12;border-color:#4A3220;color:#D8BFA8}' +
      /* Toast (same 2,400 ms rhythm as the dashboard toast). */
      '.cf-acct-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#101828;color:#fff;padding:12px 18px;border-radius:999px;font-size:14px;z-index:200;display:none;box-shadow:0 10px 30px rgba(0,0,0,.3);max-width:calc(100vw - 32px);text-align:center}' +
      '.cf-acct-toast.on{display:block}';
    var st = document.createElement('style');
    st.id = 'cf-account-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- toast ---------- */

  var toastTimer = null;
  function toast(msg) {
    try {
      var t = document.getElementById('cf-acct-toast');
      if (!t) return;
      t.textContent = msg;
      t.classList.add('on');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2400);
    } catch (e) {}
  }

  /* ---------- header avatar button ---------- */

  /* Dashboard trigger: the converted <button id="accountMenuBtn">, or
     the legacy .who div on a page whose HTML edit has not landed yet.
     On the legacy div we only attach behaviour — we never restructure
     the page's markup from here. */
  function dashboardTrigger() {
    return document.getElementById('accountMenuBtn') || document.querySelector('.who');
  }

  function accountButtons() {
    return {
      login: document.querySelector('[data-account-mode="login"]'),
      create: document.querySelector('[data-account-mode="create"]')
    };
  }

  function injectedButton() {
    return document.getElementById('cfAccountBtn');
  }

  function buildInjectedButton() {
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'cfAccountBtn';
    b.className = 'cf-acct-who';
    b.setAttribute('aria-haspopup', 'true');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-label', 'Account menu');
    var av = document.createElement('span');
    av.className = 'cf-acct-av';
    var nm = document.createElement('span');
    nm.className = 'cf-acct-nm';
    nm.id = 'cfAccountName';
    b.appendChild(av);
    b.appendChild(nm);
    b.addEventListener('click', function (e) {
      e.preventDefault();
      toggleMenu(b);
    });
    return b;
  }

  function placeInjectedButton(btn) {
    var themeBtn = document.getElementById('themeBtn');
    if (themeBtn && themeBtn.parentNode) {
      themeBtn.parentNode.insertBefore(btn, themeBtn.nextSibling);
      return;
    }
    var actions = document.querySelector('.nav-actions');
    if (actions) { actions.appendChild(btn); return; }
    var header = document.querySelector('header');
    if (header) header.appendChild(btn);
    else document.body.appendChild(btn);
  }

  /* Render the authed header from real profile/auth data only — the
     dashboard demo business toggle must never leak into this display. */
  function renderHeader() {
    if (!authed || !currentUser) return;
    var name = displayNameOf(currentUser, currentProfile);
    var text = headerText(currentUser, currentProfile);
    var init = initialOf(name, currentUser.email);

    var trig = dashboardTrigger();
    if (trig) {
      var av = trig.querySelector('.av');
      if (av) { av.style.display = ''; av.textContent = init; }
      var nm = trig.querySelector('.nm') || document.getElementById('whoName');
      if (nm) nm.textContent = text;
      trig.setAttribute('aria-haspopup', 'true');
      trig.setAttribute('aria-expanded', trig === menuAnchor ? 'true' : 'false');
      /* Click behaviour is attached once in init(); this only refreshes
         the visible name/initial. */
    }

    var btn = injectedButton();
    if (!btn) {
      /* No dashboard trigger on this page (index + thin headers):
         inject our own button next to the theme button. */
      if (!trig) {
        btn = buildInjectedButton();
        placeInjectedButton(btn);
      }
    }
    if (btn) {
      var bAv = btn.querySelector('.cf-acct-av');
      if (bAv) bAv.textContent = init;
      var bNm = btn.querySelector('.cf-acct-nm');
      if (bNm) bNm.textContent = text;
    }

    /* Index: hide Log in / Create while the avatar button is shown.
       cf-auth.js's own setHeaderAuthed does the same for Create and
       turns Log in into Log out; hiding both here is compatible with
       either order of the two modules. */
    var ab = accountButtons();
    if (ab.login) ab.login.style.display = 'none';
    if (ab.create) ab.create.style.display = 'none';
  }

  function unrenderHeader() {
    var btn = injectedButton();
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    /* Dashboard: the static .who button is hardcoded "Martin · Seller"
       in dashboard.html, so leaving it visible after logout fakes a
       signed-in header. Turn it into a Log in button instead: hide the
       avatar initial, show "Log in", and the init click handler sends
       a logged-out click to index.html where Log in lives. */
    var ab = accountButtons();
    if (ab.login) ab.login.style.display = '';
    if (ab.create) ab.create.style.display = '';
    var trig = dashboardTrigger();
    if (trig) {
      trig.setAttribute('aria-expanded', 'false');
      var tAv = trig.querySelector('.av');
      if (tAv) tAv.style.display = 'none';
      var tNm = trig.querySelector('.nm') || document.getElementById('whoName');
      if (tNm) tNm.textContent = 'Log in';
    }
  }

  /* ---------- menu ---------- */

  var menuAnchor = null; /* the button the open menu belongs to */

  function menuEls() {
    return {
      backdrop: document.getElementById('cf-acct-backdrop'),
      menu: document.getElementById('cf-acct-menu')
    };
  }

  function buildMenu() {
    if (document.getElementById('cf-acct-menu')) return;
    var backdrop = document.createElement('div');
    backdrop.id = 'cf-acct-backdrop';
    backdrop.className = 'cf-acct-backdrop';
    backdrop.addEventListener('click', closeMenu);
    var menu = document.createElement('div');
    menu.id = 'cf-acct-menu';
    menu.className = 'cf-acct-menu';
    menu.setAttribute('role', 'menu');
    var b1 = document.createElement('button');
    b1.type = 'button';
    b1.setAttribute('data-cf-acct-menu', 'profile');
    b1.textContent = 'Profile';
    var b2 = document.createElement('button');
    b2.type = 'button';
    b2.setAttribute('data-cf-acct-menu', 'settings');
    b2.textContent = 'Settings';
    var a = document.createElement('a');
    a.href = 'dashboard.html';
    a.textContent = 'Dashboard';
    /* Sign out: the data-cf-logout attribute lets cf-auth.js's own
       capture handler perform the sign-out. NO new sign-out code. */
    var b3 = document.createElement('button');
    b3.type = 'button';
    b3.setAttribute('data-cf-logout', '1');
    b3.textContent = 'Sign out';
    menu.appendChild(b1);
    menu.appendChild(b2);
    menu.appendChild(a);
    menu.appendChild(b3);
    menu.addEventListener('click', function (e) {
      var item = e.target && e.target.closest ? e.target.closest('[data-cf-acct-menu]') : null;
      if (!item) return;
      e.preventDefault();
      closeMenu();
      if (item.getAttribute('data-cf-acct-menu') === 'profile') openProfilePanel();
      else openSettingsPanel();
    });
    document.body.appendChild(backdrop);
    document.body.appendChild(menu);
  }

  function openMenu(anchor) {
    if (!authed) return;
    var els = menuEls();
    if (!els.menu || !els.backdrop || !anchor) return;
    menuAnchor = anchor;
    /* Desktop dropdown: anchor under the button, right-aligned. The
       phone bottom-sheet layout is CSS-only (max-width:900px) and
       overrides these inline coordinates. */
    try {
      var r = anchor.getBoundingClientRect();
      els.menu.style.top = (r.bottom + 8) + 'px';
      els.menu.style.left = Math.max(8, Math.min(r.right - 220, window.innerWidth - 232)) + 'px';
    } catch (e) {}
    els.backdrop.classList.add('on');
    els.menu.classList.add('on');
    anchor.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    var els = menuEls();
    if (els.backdrop) els.backdrop.classList.remove('on');
    if (els.menu) els.menu.classList.remove('on');
    if (menuAnchor) menuAnchor.setAttribute('aria-expanded', 'false');
    menuAnchor = null;
  }

  function toggleMenu(anchor) {
    if (!authed) return;
    var els = menuEls();
    if (els.menu && els.menu.classList.contains('on')) closeMenu();
    else openMenu(anchor);
  }

  /* ---------- panels ---------- */

  var panelElsCache = null;
  function panelEls() {
    if (panelElsCache) return panelElsCache;
    var backdrop = document.getElementById('cf-acct-panel-backdrop');
    var panel = document.getElementById('cf-acct-panel');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'cf-acct-panel-backdrop';
      backdrop.className = 'cf-acct-panel-backdrop';
      backdrop.addEventListener('click', closePanel);
      document.body.appendChild(backdrop);
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'cf-acct-panel';
      panel.className = 'cf-acct-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      document.body.appendChild(panel);
    }
    panelElsCache = { backdrop: backdrop, panel: panel };
    return panelElsCache;
  }

  function openPanelShell(title) {
    var els = panelEls();
    var card = document.createElement('div');
    card.className = 'cf-acct-card';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'cf-acct-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', closePanel);
    var h = document.createElement('h3');
    h.textContent = title;
    card.appendChild(close);
    card.appendChild(h);
    els.panel.innerHTML = '';
    els.panel.appendChild(card);
    els.backdrop.classList.add('on');
    els.panel.classList.add('on');
    document.body.style.overflow = 'hidden';
    return card;
  }

  function closePanel() {
    var els = panelEls();
    els.backdrop.classList.remove('on');
    els.panel.classList.remove('on');
    els.panel.innerHTML = '';
    document.body.style.overflow = '';
  }

  function noticeEl(kind) {
    var n = document.createElement('div');
    n.className = 'cf-acct-notice' + (kind ? ' ' + kind : '');
    n.style.display = 'none';
    return n;
  }

  function showNotice(el, msg, kind) {
    el.className = 'cf-acct-notice' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function hideNotice(el) {
    el.style.display = 'none';
    el.textContent = '';
  }

  function openProfilePanel() {
    if (!authed || !currentUser) return;
    var card = openPanelShell('Profile');
    var missing = !currentProfile;

    var ident = document.createElement('div');
    ident.className = 'cf-acct-identity';
    var bigAv = document.createElement('div');
    bigAv.className = 'cf-acct-bigav';
    bigAv.textContent = initialOf(displayNameOf(currentUser, currentProfile), currentUser.email);
    var idText = document.createElement('div');
    var idName = document.createElement('div');
    idName.className = 'cf-acct-idname';
    idName.textContent = displayNameOf(currentUser, currentProfile);
    var idRole = document.createElement('div');
    idRole.className = 'cf-acct-idrole';
    var role = (currentProfile && currentProfile.role) || (currentUser.user_metadata && currentUser.user_metadata.role) || 'private';
    idRole.textContent = roleLabel(role) + (currentProfile && currentProfile.is_admin ? ' · Admin' : '');
    idText.appendChild(idName);
    idText.appendChild(idRole);
    ident.appendChild(bigAv);
    ident.appendChild(idText);
    card.appendChild(ident);

    if (missing) {
      var setup = noticeEl('');
      setup.textContent = 'Finish setting up your profile — save once to create it.';
      setup.style.display = 'block';
      card.appendChild(setup);
    }

    var fld = document.createElement('div');
    fld.className = 'cf-acct-field';
    var lab = document.createElement('label');
    lab.setAttribute('for', 'cfAcctNameInput');
    lab.textContent = 'Display name';
    var input = document.createElement('input');
    input.id = 'cfAcctNameInput';
    input.type = 'text';
    input.maxLength = 40;
    input.autocomplete = 'name';
    input.value = (currentProfile && currentProfile.display_name) || (currentUser.user_metadata && currentUser.user_metadata.display_name) || '';
    fld.appendChild(lab);
    fld.appendChild(input);
    card.appendChild(fld);

    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'cf-acct-btn-primary';
    save.textContent = 'Save profile';
    save.addEventListener('click', function () {
      var name = input.value.trim().slice(0, 40);
      save.disabled = true;
      save.textContent = 'Saving…';
      /* Upsert repairs a missing row: id + email satisfy the NOT NULL
         columns, and omitted columns (role, is_admin, phone,
         created_at) keep their existing values. */
      client.from('profiles').upsert({
        id: currentUser.id,
        email: currentUser.email,
        display_name: name ? name : null
      }, { onConflict: 'id' }).then(function (res) {
        save.disabled = false;
        save.textContent = 'Save profile';
        if (res.error) {
          toast(res.error.message || 'Could not save profile.');
          return;
        }
        /* Re-read so the header shows exactly what the database holds. */
        loadProfile().then(function () {
          renderHeader();
          idName.textContent = displayNameOf(currentUser, currentProfile);
          idRole.textContent = roleLabel((currentProfile && currentProfile.role) || role) + (currentProfile && currentProfile.is_admin ? ' · Admin' : '');
          bigAv.textContent = initialOf(displayNameOf(currentUser, currentProfile), currentUser.email);
          if (currentProfile) {
            var sn = card.querySelector('.cf-acct-notice');
            if (sn) sn.style.display = 'none';
          }
        });
        toast('Profile saved');
      }).catch(function (err) {
        save.disabled = false;
        save.textContent = 'Save profile';
        toast((err && err.message) ? err.message : 'Could not save profile.');
      });
    });
    card.appendChild(save);

    var rowEmail = document.createElement('div');
    rowEmail.className = 'cf-acct-row';
    var rowEmailK = document.createElement('span');
    rowEmailK.textContent = 'Email';
    var rowEmailV = document.createElement('span');
    rowEmailV.textContent = currentUser.email || '';
    rowEmail.appendChild(rowEmailK);
    rowEmail.appendChild(rowEmailV);
    card.appendChild(rowEmail);

    var rowRole = document.createElement('div');
    rowRole.className = 'cf-acct-row';
    var rowRoleK = document.createElement('span');
    rowRoleK.textContent = 'Role';
    var rowRoleV = document.createElement('span');
    rowRoleV.textContent = roleLabel(role);
    rowRole.appendChild(rowRoleK);
    rowRole.appendChild(rowRoleV);
    card.appendChild(rowRole);

    var since = memberSinceText(currentProfile && currentProfile.created_at);
    if (since) {
      var rowSince = document.createElement('div');
      rowSince.className = 'cf-acct-row';
      var rowSinceK = document.createElement('span');
      rowSinceK.textContent = 'Member';
      var rowSinceV = document.createElement('span');
      rowSinceV.textContent = since;
      rowSince.appendChild(rowSinceK);
      rowSince.appendChild(rowSinceV);
      card.appendChild(rowSince);
    }
  }

  function openSettingsPanel() {
    if (!authed || !currentUser) return;
    var card = openPanelShell('Settings');

    var signed = document.createElement('p');
    signed.className = 'cf-acct-sub';
    signed.textContent = 'Signed in as ' + (currentUser.email || '');
    card.appendChild(signed);

    /* --- Password change --- */
    var pwHead = document.createElement('div');
    pwHead.className = 'cf-acct-field';
    var pwLab = document.createElement('label');
    pwLab.textContent = 'Change password';
    pwHead.appendChild(pwLab);
    card.appendChild(pwHead);

    var pw1 = document.createElement('input');
    pw1.type = 'password';
    pw1.autocomplete = 'new-password';
    pw1.placeholder = 'New password';
    var pw1Wrap = document.createElement('div');
    pw1Wrap.className = 'cf-acct-field';
    pw1Wrap.appendChild(pw1);
    card.appendChild(pw1Wrap);

    var pw2 = document.createElement('input');
    pw2.type = 'password';
    pw2.autocomplete = 'new-password';
    pw2.placeholder = 'Confirm new password';
    var pw2Wrap = document.createElement('div');
    pw2Wrap.className = 'cf-acct-field';
    pw2Wrap.appendChild(pw2);
    card.appendChild(pw2Wrap);

    var pwNote = noticeEl('');
    card.appendChild(pwNote);

    var pwBtn = document.createElement('button');
    pwBtn.type = 'button';
    pwBtn.className = 'cf-acct-btn-primary';
    pwBtn.textContent = 'Update password';
    pwBtn.addEventListener('click', function () {
      var a = pw1.value;
      var b = pw2.value;
      if (!a || a.length < 6 || !b || b.length < 6) {
        showNotice(pwNote, 'Use at least 6 characters.', 'err');
        return;
      }
      if (a !== b) {
        showNotice(pwNote, 'Passwords do not match.', 'err');
        return;
      }
      pwBtn.disabled = true;
      pwBtn.textContent = 'Updating…';
      client.auth.updateUser({ password: a }).then(function (res) {
        pwBtn.disabled = false;
        pwBtn.textContent = 'Update password';
        if (res.error) {
          showNotice(pwNote, res.error.message || 'Could not update password.', 'err');
          return;
        }
        pw1.value = '';
        pw2.value = '';
        hideNotice(pwNote);
        toast('Password updated');
      }).catch(function (err) {
        pwBtn.disabled = false;
        pwBtn.textContent = 'Update password';
        showNotice(pwNote, (err && err.message) ? err.message : 'Could not update password.', 'err');
      });
    });
    card.appendChild(pwBtn);

    /* --- Email change (D3, guarded) --- */
    var emHead = document.createElement('div');
    emHead.className = 'cf-acct-field';
    var emLab = document.createElement('label');
    emLab.textContent = 'Change email';
    emHead.appendChild(emLab);
    card.appendChild(emHead);

    var guard = noticeEl('');
    guard.textContent = 'Supabase will send a confirmation to the new address. The change only takes effect after you confirm it — your old email keeps working until then, so a typo can\u2019t lock you out.';
    guard.style.display = 'block';
    card.appendChild(guard);

    var em1 = document.createElement('input');
    em1.type = 'email';
    em1.autocomplete = 'email';
    em1.placeholder = 'New email';
    var em1Wrap = document.createElement('div');
    em1Wrap.className = 'cf-acct-field';
    em1Wrap.appendChild(em1);
    card.appendChild(em1Wrap);

    var em2 = document.createElement('input');
    em2.type = 'email';
    em2.autocomplete = 'email';
    em2.placeholder = 'Confirm new email';
    var em2Wrap = document.createElement('div');
    em2Wrap.className = 'cf-acct-field';
    em2Wrap.appendChild(em2);
    card.appendChild(em2Wrap);

    var emNote = noticeEl('');
    card.appendChild(emNote);

    var emBtn = document.createElement('button');
    emBtn.type = 'button';
    emBtn.className = 'cf-acct-btn-primary';
    emBtn.textContent = 'Update email';
    emBtn.addEventListener('click', function () {
      var a = em1.value.trim();
      var b = em2.value.trim();
      if (a !== b) {
        showNotice(emNote, 'Emails do not match.', 'err');
        return;
      }
      if (!validEmail(a)) {
        showNotice(emNote, 'Enter a valid email address.', 'err');
        return;
      }
      if (currentUser.email && a.toLowerCase() === String(currentUser.email).toLowerCase()) {
        showNotice(emNote, 'That is already your current email.', 'err');
        return;
      }
      emBtn.disabled = true;
      emBtn.textContent = 'Updating…';
      client.auth.updateUser({ email: a }).then(function (res) {
        emBtn.disabled = false;
        emBtn.textContent = 'Update email';
        if (res.error) {
          showNotice(emNote, res.error.message || 'Could not update email.', 'err');
          return;
        }
        em1.value = '';
        em2.value = '';
        showNotice(emNote, 'Confirmation sent to ' + a + '. Check that inbox to complete the change — your old email keeps working until then.', 'ok');
      }).catch(function (err) {
        emBtn.disabled = false;
        emBtn.textContent = 'Update email';
        showNotice(emNote, (err && err.message) ? err.message : 'Could not update email.', 'err');
      });
    });
    card.appendChild(emBtn);
  }

  /* ---------- profile read ---------- */

  function loadProfile() {
    if (!currentUser) return Promise.resolve(null);
    try {
      return client.from('profiles')
        .select('id,email,display_name,role,is_admin,created_at')
        .eq('id', currentUser.id)
        .maybeSingle()
        .then(function (res) {
          if (res.error || !res.data) { currentProfile = null; }
          else { currentProfile = res.data; }
          return currentProfile;
        })
        .catch(function () { currentProfile = null; return null; });
    } catch (e) {
      currentProfile = null;
      return Promise.resolve(null);
    }
  }

  /* ---------- auth state ---------- */

  function setAuthed(user) {
    currentUser = user;
    authed = true;
    renderHeader();
    loadProfile().then(function () { renderHeader(); });
  }

  function setAnon() {
    currentUser = null;
    currentProfile = null;
    authed = false;
    closeMenu();
    closePanel();
    unrenderHeader();
  }

  /* ---------- init ---------- */

  function init() {
    try { injectCss(); } catch (e) {}
    try {
      var toastDiv = document.createElement('div');
      toastDiv.id = 'cf-acct-toast';
      toastDiv.className = 'cf-acct-toast';
      document.body.appendChild(toastDiv);
    } catch (e) {}
    try { buildMenu(); } catch (e) {}

    /* Dashboard trigger click: attached once. Logged out, the trigger
       now reads "Log in" (see unrenderHeader) and goes to index.html
       where Log in lives; logged in, it opens the account menu. */
    try {
      var trig = dashboardTrigger();
      if (trig && !trig.dataset.cfAcctBound) {
        trig.dataset.cfAcctBound = '1';
        trig.addEventListener('click', function (e) {
          e.preventDefault();
          if (!authed) { window.location.href = 'index.html'; return; }
          toggleMenu(trig);
        });
      }
    } catch (e) {}

    /* Escape closes panel first, then menu. */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var p = document.getElementById('cf-acct-panel');
      if (p && p.classList.contains('on')) { closePanel(); return; }
      closeMenu();
    });

    try {
      client.auth.getSession().then(function (res) {
        if (res.data && res.data.session) setAuthed(res.data.session.user);
        else setAnon();
      }).catch(function () { setAnon(); });
    } catch (e) { setAnon(); }

    try {
      client.auth.onAuthStateChange(function (event, session) {
        if (event === 'SIGNED_IN' && session) setAuthed(session.user);
        if (event === 'SIGNED_OUT') setAnon();
      });
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
