/* cf-jobs.js — ClassiFlip real Jobs wiring (Nov 1, 2026)
 *
 * Graduates the Jobs section from demo data to the real backend
 * (supabase/cf-jobs-migration.sql):
 *
 *   - Loads ACTIVE job_postings into the page's jobs array ahead of
 *     the samples (real rows carry live:true and render "LIVE JOB").
 *   - Logged-in job posts insert into job_postings as 'pending'
 *     (approval gate, same as marketplace ads) and ping the admin
 *     email function. Logged-out posting keeps the demo preview,
 *     exactly like marketplace posts.
 *   - Applying to a REAL job requires sign-in, uploads the optional
 *     resume to the private 'resumes' bucket, inserts a
 *     job_applications row, and pings the employer email function.
 *     Sample jobs keep the demo apply flow untouched.
 *   - Fixes the demo copy ("prototype job", "demo only") when the
 *     open detail/form belongs to a real job.
 *   - Package coverage: an employer with an Active jobs package
 *     ('jobs-single' / 'jobs-unlimited' order) never sees the plan
 *     picker — the post is covered and linked to the order. A Single
 *     covers one post (posts since the order began, rejected posts
 *     excluded); once spent, the form says so and shows the picker
 *     for the next post. Signed-in posters also lose the "prototype"
 *     wording on the plan notice, and the button reads "Post job".
 *
 * Uses window.CFAuth.client (cf-auth.js). No keys in this file.
 */
(function () {
  'use strict';

  var FN_BASE = 'https://dbgmyvjaavpmernaxnav.functions.supabase.co/';
  var myId = null;
  var realIds = {};            // String(job_postings.id) -> true
  var pendingResume = null;    // { jobId, file } stashed at form submit
  var posting = false;
  var jobPkg = null;           // active jobs package: {kind, orderId, covered}
  var SINGLE_USED_NOTE = 'Your Single job-post credit is already used, so this post needs its own plan. ';

  function getClient() {
    try {
      if (window.CFAuth && window.CFAuth.client) return window.CFAuth.client;
    } catch (e) {}
    return null;
  }
  function esc(s) {
    if (typeof safe === 'function') return safe(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isRealJob(id) { return !!realIds[String(id)]; }

  /* Fire-and-forget edge-function ping (same pattern as cf-listings'
     notifyAdminPendingAd): JWT in the header, function derives the
     recipient from the database. Email failure never blocks the UI. */
  function notify(fn, payload) {
    try {
      var client = getClient();
      if (!client) return;
      client.auth.getSession().then(function (s) {
        var token = s && s.data && s.data.session && s.data.session.access_token;
        if (!token) return;
        fetch(FN_BASE + fn, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify(payload || {})
        }).catch(function () {});
      }).catch(function () {});
    } catch (e) {}
  }

  async function refreshUser() {
    var client = getClient();
    if (!client) { myId = null; return null; }
    try {
      var r = await client.auth.getUser();
      myId = (r && r.data && r.data.user) ? r.data.user.id : null;
    } catch (e) { myId = null; }
    return myId;
  }

  /* ------------------------------------------- jobs package coverage */
  /* An employer holding an Active jobs package (orders rows
     'jobs-single' / 'jobs-unlimited') should never be asked to pick a
     plan again: the picker hides and the post is covered. A Single
     covers ONE post — counted as posts made since the order began
     (rejected posts don't burn the credit). */
  async function loadJobPackage() {
    jobPkg = null;
    var client = getClient();
    if (!client) { applyPackageToForm(); return; }
    var uid = myId || window.__cfMyId || (await refreshUser());
    if (!uid) { applyPackageToForm(); return; }
    try {
      /* NOTE (Nov 2 fix): orders.package stores the DISPLAY LABEL
         (cf-orders.js writes PACKAGES[key][0], e.g. 'Jobs Employer
         Unlimited'), not the slug — match both or coverage never hits. */
      var res = await client.from('orders')
        .select('id,package,status,expires_at,created_at')
        .eq('buyer_id', uid)
        .in('package', ['jobs-single', 'jobs-unlimited', 'Jobs Single Job Post', 'Jobs Employer Unlimited'])
        .in('status', ['Active', 'Expiring soon'])
        .order('created_at', { ascending: false });
      if (!res.error && res.data && res.data.length) {
        var now = Date.now();
        var rows = res.data.filter(function (o) {
          return !o.expires_at || new Date(o.expires_at).getTime() > now;
        });
        var unl = null, sgl = null;
        rows.forEach(function (o) {
          if ((o.package === 'jobs-unlimited' || o.package === 'Jobs Employer Unlimited') && !unl) unl = o;
          if ((o.package === 'jobs-single' || o.package === 'Jobs Single Job Post') && !sgl) sgl = o;
        });
        if (unl) {
          jobPkg = { kind: 'unlimited', orderId: unl.id, covered: true };
        } else if (sgl) {
          var used = 0;
          try {
            var cnt = await client.from('job_postings')
              .select('id', { count: 'exact', head: true })
              .eq('employer_id', uid)
              .neq('status', 'rejected')
              .gte('created_at', sgl.created_at);
            used = (cnt && typeof cnt.count === 'number') ? cnt.count : 0;
          } catch (e2) {}
          jobPkg = { kind: 'single', orderId: sgl.id, covered: used === 0 };
        }
      }
    } catch (e) {}
    applyPackageToForm();
  }

  function pkgCovered() {
    return !!(jobPkg && (jobPkg.kind === 'unlimited' || jobPkg.covered));
  }

  function applyPackageToForm() {
    var form = document.getElementById('jobPostForm');
    if (!form) return;
    if (!(myId || window.__cfMyId)) return;   // logged out: demo copy stays
    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.textContent !== 'Posting…') submitBtn.textContent = 'Post job';
    var fieldset = form.querySelector('fieldset');
    var tip = null;
    form.querySelectorAll('p').forEach(function (p) {
      if (p.textContent.indexOf('Posting 5 jobs') !== -1) tip = p;
    });
    var notice = document.getElementById('jobPlanNotice');
    if (pkgCovered()) {
      if (fieldset) fieldset.style.display = 'none';
      if (tip) tip.style.display = 'none';
      var radio = form.querySelector('input[name="jobPlan"][value="' + jobPkg.kind + '"]');
      if (radio) radio.checked = true;
      if (notice) {
        notice.textContent = jobPkg.kind === 'unlimited'
          ? '✓ Your Unlimited jobs package is active — post as many jobs as you like. Each post goes to a quick approval, then runs for 30 days.'
          : '✓ Your Single job post package is active — this post is covered by it. It goes to a quick approval, then runs for 30 days.';
      }
    } else {
      if (fieldset) fieldset.style.display = '';
      if (tip) tip.style.display = '';
      scrubNotice();
    }
  }

  /* The page rewrites the plan notice (with "prototype" wording) every
     time the plan radio changes. For signed-in employers, strip that
     sentence and, when a Single credit is spent, say so up front. */
  function scrubNotice() {
    var n = document.getElementById('jobPlanNotice');
    if (!n) return;
    if (!(myId || window.__cfMyId)) return;
    if (pkgCovered()) return;   // applyPackageToForm owns the notice
    var t = n.textContent || '';
    var nt = t.split(' No payment is taken in this prototype.').join('')
              .split('No payment is taken in this prototype.').join('').trim();
    if (jobPkg && jobPkg.kind === 'single' && !jobPkg.covered && nt.indexOf(SINGLE_USED_NOTE) !== 0) {
      nt = SINGLE_USED_NOTE + nt;
    }
    if (nt && nt !== t) n.textContent = nt;
  }

  /* ------------------------------------------------------------ load jobs */
  function toJobShape(row) {
    return {
      id: row.id,
      live: true,
      employer_id: row.employer_id,
      title: row.title || 'Job',
      company: row.company || '',
      category: row.category || 'General Labour',
      type: row.type || 'Part-time',
      location: row.location || 'GTA',
      pay: row.pay || 'Pay not listed',
      desc: row.description || '',
      created_at: row.created_at
    };
  }

  async function loadRealJobs() {
    var client = getClient();
    if (!client) return;
    try {
      var res = await client.from('job_postings')
        .select('id,employer_id,title,company,category,type,location,pay,description,created_at,expires_at')
        .eq('status', 'active')
        .order('created_at', { ascending: false });
      if (res.error || !res.data) return;
      var now = Date.now();
      var rows = res.data.filter(function (r) {
        return !r.expires_at || new Date(r.expires_at).getTime() > now;
      }).map(toJobShape);
      // Drop previously loaded real rows, then put fresh ones first.
      if (typeof jobs !== 'undefined') {
        for (var i = jobs.length - 1; i >= 0; i--) {
          if (jobs[i] && jobs[i].live) { delete realIds[String(jobs[i].id)]; jobs.splice(i, 1); }
        }
        rows.slice().reverse().forEach(function (j) { jobs.unshift(j); });
        rows.forEach(function (j) { realIds[String(j.id)] = true; });
        try { renderJobs(); } catch (e) {}
      }
      // Seed "Applied ✓" state for this user.
      var uid = await refreshUser();
      if (uid) {
        var apps = await client.from('job_applications').select('job_id').eq('applicant_id', uid);
        if (!apps.error && apps.data && typeof appliedJobs !== 'undefined') {
          apps.data.forEach(function (a) { appliedJobs.add(String(a.job_id)); });
        }
      }
    } catch (e) { /* Jobs section still shows samples. */ }
  }

  /* ------------------------------------------------------------ post a job */
  async function postRealJob() {
    var client = getClient();
    if (!client || posting) return;
    var uid = myId || window.__cfMyId || (await refreshUser());
    if (!uid) return;
    posting = true;
    var form = document.getElementById('jobPostForm');
    var submitBtn = form ? form.querySelector('button[type="submit"]') : null;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Posting…'; }
    function fail(msg) {
      posting = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Post job'; }
      var n = document.getElementById('jobPlanNotice');
      if (n) { n.textContent = msg; n.style.borderColor = 'var(--orange)'; }
    }
    var val = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    var planEl = document.querySelector('input[name="jobPlan"]:checked');
    var covered = pkgCovered();
    var row = {
      employer_id: uid,
      title: val('jobTitleInput'),
      company: val('companyInput'),
      category: val('jobCategoryInput') || 'General Labour',
      type: val('jobTypeInput') || 'Part-time',
      location: val('jobLocationInput') || 'Mississauga',
      pay: val('jobPayInput'),
      description: val('jobDescriptionInput'),
      plan: covered ? jobPkg.kind : (planEl && planEl.value === 'unlimited' ? 'unlimited' : 'single'),
      order_id: covered ? jobPkg.orderId : null,
      status: 'pending'
    };
    if (!row.title || !row.company) { fail('Please add a job title and company name.'); return; }
    try {
      var ins = await client.from('job_postings').insert([row]).select('id').single();
      if (ins.error || !ins.data) { fail('Could not post the job — please try again.'); return; }
      notify('notify-admin-pending-job', { job_id: ins.data.id, title: row.title, company: row.company });
      var body = form.closest('.dialog-body');
      if (body) {
        body.innerHTML =
          '<div class="apply-success">' +
          '<div class="big"><svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.6 2.6L16 9.5"/></svg></div>' +
          '<h3>Job post received</h3>' +
          '<p>Your post for <strong>' + esc(row.title) + '</strong> at ' + esc(row.company) +
          ' is in the approval queue. Once it is approved it goes live for 30 days and job seekers can apply right on ClassiFlip — applications land in your dashboard under <strong>Job Applications</strong>.</p>' +
          '<button type="button" class="primary" data-close style="width:100%;min-height:48px">Done</button></div>';
      }
      posting = false;
      loadJobPackage();   // a Single credit may now be spent
    } catch (e) {
      fail('Could not post the job — please try again.');
    }
  }

  /* Capture-phase: intercept real (signed-in) job posts before the
     page's own demo submit runs. Logged out -> demo preview as today. */
  document.addEventListener('submit', function (e) {
    if (!e.target || e.target.id !== 'jobPostForm') return;
    if (!getClient()) return;
    if (!(myId || window.__cfMyId)) return;   // not signed in: demo flow
    e.preventDefault();
    e.stopPropagation();
    postRealJob();
  }, true);

  /* -------------------------------------------------------------- applying */
  /* Stash the chosen resume File at form submit (the page's review
     step only carries the file NAME forward). */
  document.addEventListener('submit', function (e) {
    if (!e.target || e.target.id !== 'jobApplyForm') return;
    var fid = e.target.dataset ? e.target.dataset.jobId : null;
    if (!isRealJob(fid)) { pendingResume = null; return; }
    var rf = e.target.querySelector('#jaResume');
    var f = rf && rf.files && rf.files[0] ? rf.files[0] : null;
    pendingResume = f ? { jobId: String(fid), file: f } : null;
  }, true);

  /* Real jobs require sign-in to apply (samples stay demo-open). */
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-apply-job]') : null;
    if (!b) return;
    if (!isRealJob(b.dataset.applyJob)) return;
    if (myId || window.__cfMyId) return;
    e.preventDefault();
    e.stopPropagation();
    try { if (typeof setAccountMode === 'function') setAccountMode('login'); } catch (err) {}
    try { if (typeof openModal === 'function') openModal('accountModal'); } catch (err) {}
  }, true);

  function successScreen(x, already) {
    var titleEl = document.getElementById('detailTitle');
    var bodyEl = document.getElementById('detailBody');
    if (!bodyEl) return;
    if (titleEl) titleEl.textContent = 'Application sent';
    bodyEl.innerHTML = '<div class="apply-success">' +
      (typeof applySteps === 'function' ? applySteps(3) : '') +
      '<div class="big"><svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.6 2.6L16 9.5"/></svg></div>' +
      '<p>Your application' + (x ? ' for <strong>' + esc(x.title) + '</strong>' + (x.company ? ' at ' + esc(x.company) : '') : '') +
      (already ? ' was already on file with this employer — no need to send it twice.' : ' is on its way. The employer can see it right away in their ClassiFlip dashboard, and typically replies within a few days.') + '</p>' +
      '<button type="button" class="primary" data-close style="width:100%;min-height:48px">Back to jobs</button></div>';
    try { if (typeof openModal === 'function') openModal('detailModal'); } catch (e) {}
  }

  function applyError(msg) {
    var bodyEl = document.getElementById('detailBody');
    if (!bodyEl) return;
    var n = document.createElement('div');
    n.className = 'notice';
    n.style.borderColor = 'var(--orange)';
    n.style.marginTop = '12px';
    n.textContent = msg;
    bodyEl.appendChild(n);
  }

  async function submitRealApplication(btn) {
    var client = getClient();
    var a = window._jobApp;
    if (!client || !a) return;
    var uid = myId || (await refreshUser());
    if (!uid) { applyError('Please sign in again, then submit.'); return; }
    var x = (typeof jobById === 'function') ? jobById(a.id) : null;
    var d = a.d || {};
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      var resumePath = null;
      if (pendingResume && pendingResume.jobId === String(a.id) && pendingResume.file) {
        var f = pendingResume.file;
        if (f.size > 5 * 1024 * 1024) {
          btn.disabled = false; btn.textContent = 'Submit application';
          applyError('That resume is over 5 MB — please attach a smaller file.');
          return;
        }
        var clean = f.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80) || 'resume';
        resumePath = uid + '/' + a.id + '/' + clean;
        var up = await client.storage.from('resumes').upload(resumePath, f, { upsert: true });
        if (up.error) {
          btn.disabled = false; btn.textContent = 'Submit application';
          applyError('The resume upload failed — your application was not sent. Please try again.');
          return;
        }
      }
      var ins = await client.from('job_applications').insert([{
        job_id: a.id,
        applicant_id: uid,
        name: d.name || '',
        email: d.email || '',
        phone: d.phone || '',
        note: d.note || '',
        resume_path: resumePath
      }]).select('id').single();
      if (ins.error) {
        if (ins.error.code === '23505') {           // already applied
          try { appliedJobs.add(String(a.id)); } catch (e) {}
          pendingResume = null;
          successScreen(x, true);
          return;
        }
        btn.disabled = false; btn.textContent = 'Submit application';
        applyError('Could not send the application — please try again.');
        return;
      }
      try { appliedJobs.add(String(a.id)); } catch (e) {}
      notify('notify-employer-application', { application_id: ins.data.id });
      pendingResume = null;
      window._jobApp = null;
      successScreen(x, false);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Submit application';
      applyError('Could not send the application — please try again.');
    }
  }

  /* Capture-phase: real-job submits never reach the demo handler. */
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-submit-apply]') : null;
    if (!b) return;
    var a = window._jobApp;
    if (!a || !isRealJob(a.id)) return;
    e.preventDefault();
    e.stopPropagation();
    submitRealApplication(b);
  }, true);

  /* ------------------------------------------------- demo-copy corrections */
  /* When the open detail/form belongs to a real job, swap the
     prototype wording for live wording. */
  function fixDetailCopy() {
    var bodyEl = document.getElementById('detailBody');
    if (!bodyEl) return;
    var applyBtn = bodyEl.querySelector('[data-apply-job]');
    var form = bodyEl.querySelector('#jobApplyForm');
    var id = applyBtn ? applyBtn.dataset.applyJob : (form ? form.dataset.jobId : (window._jobApp ? window._jobApp.id : null));
    if (!id || !isRealJob(id)) return;
    bodyEl.querySelectorAll('.prototype-tag').forEach(function (t) {
      if (t.textContent.indexOf('SAMPLE JOB') === 0) t.textContent = t.textContent.replace('SAMPLE JOB', 'LIVE JOB');
    });
    bodyEl.querySelectorAll('.notice').forEach(function (n) {
      if (n.textContent.indexOf('This is an interactive prototype job') === 0) {
        n.textContent = 'Live job posting on ClassiFlip. Apply here — the employer gets your application right away.';
      }
    });
    if (form) {
      var label = form.querySelector('label[for="jaResume"] span');
      if (label) label.textContent = '(optional — PDF or Word, sent to the employer)';
      bodyEl.querySelectorAll('p').forEach(function (p) {
        if (p.textContent.indexOf('Demo only') === 0) {
          p.textContent = 'Real application — it goes straight to the employer.';
        }
      });
    }
  }
  try {
    var detailBodyEl = document.getElementById('detailBody');
    if (detailBodyEl && window.MutationObserver) {
      new MutationObserver(function () { fixDetailCopy(); }).observe(detailBodyEl, { childList: true });
    }
  } catch (e) {}

  /* ------------------------------------------------------------------ init */
  function init() {
    refreshUser();
    loadRealJobs();
    loadJobPackage();
    try {
      var client = getClient();
      if (client && client.auth && client.auth.onAuthStateChange) {
        client.auth.onAuthStateChange(function () { refreshUser(); loadJobPackage(); });
      }
    } catch (e) {}
    try {
      var jn = document.getElementById('jobPlanNotice');
      if (jn && window.MutationObserver) {
        new MutationObserver(function () { scrubNotice(); })
          .observe(jn, { childList: true, characterData: true, subtree: true });
      }
      var jm = document.getElementById('jobPostModal');
      if (jm && window.MutationObserver) {
        new MutationObserver(function () {
          if (jm.classList.contains('open')) loadJobPackage();
        }).observe(jm, { attributes: true, attributeFilter: ['class'] });
      }
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.CFJobs = { refresh: loadRealJobs, isRealJob: isRealJob };
})();
