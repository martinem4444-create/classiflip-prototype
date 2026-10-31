/* ClassiFlip password eyeball — show/hide toggle on every password field.
   Martin's call, Oct 30, 2026: an eyeball helps people type their password,
   especially on mobile. Standalone enhancer: wraps each password input and
   adds a 40px touch-target eye button inside the field's right edge.
   Covers static fields (login / create account) AND dynamically built ones
   (account-settings password change, recovery set-new-password) via a
   MutationObserver. Skips the Chrome credential decoy field.
   Display-only: never reads, stores, or changes the password value. */
(function () {
  if (window.CFPwEye) return;
  window.CFPwEye = true;

  var EYE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.6 10.6 0 0 1 12 19c-6.5 0-10-7-10-7a17.6 17.6 0 0 1 4.06-4.94M9.9 4.24A9.5 9.5 0 0 1 12 5c6.5 0 10 7 10 7a17.7 17.7 0 0 1-2.16 3.19M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

  var css = document.createElement('style');
  css.textContent =
    '.cf-pw-wrap{position:relative;display:block}' +
    '.cf-pw-wrap input{padding-right:48px !important}' +
    '.cf-pw-eye{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:40px;height:40px;display:grid;place-items:center;background:transparent;border:0;border-radius:10px;color:#68788F;cursor:pointer;padding:0;z-index:2}' +
    '.cf-pw-eye:active{background:rgba(24,54,95,.08)}';
  document.head.appendChild(css);

  function enhance(input) {
    try {
      if (!input || input.dataset.cfEye) return;
      if (input.name === 'cf-decoy-pass') return;
      if (input.closest && input.closest('[aria-hidden="true"]')) return;
      var parent = input.parentElement;
      if (!parent) return;
      input.dataset.cfEye = '1';
      var wrap = document.createElement('span');
      wrap.className = 'cf-pw-wrap';
      parent.insertBefore(wrap, input);
      wrap.appendChild(input);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cf-pw-eye';
      btn.innerHTML = EYE;
      btn.setAttribute('aria-label', 'Show password');
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', function () {
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.innerHTML = show ? EYE_OFF : EYE;
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        btn.setAttribute('aria-pressed', show ? 'true' : 'false');
        try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (e2) {} }
      });
      wrap.appendChild(btn);
    } catch (e) {}
  }

  function scan(root) {
    try {
      var list = (root || document).querySelectorAll('input[type="password"]');
      for (var i = 0; i < list.length; i++) enhance(list[i]);
    } catch (e) {}
  }

  function start() {
    scan(document);
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'INPUT' && n.type === 'password') enhance(n);
            else if (n.querySelectorAll) scan(n);
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
