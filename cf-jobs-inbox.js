/* cf-jobs-inbox.js — ClassiFlip Jobs on the dashboard (Nov 1, 2026)
 *
 * Fills the "Job Applications" dashboard tab (index: cf-jobs.js):
 *   - My job posts: the signed-in employer's postings + statuses.
 *   - Applications received: the employer inbox — applicant contact
 *     details, note, resume download (signed URL into the private
 *     'resumes' bucket), and a Mark-viewed action.
 *   - Applications I've sent: the applicant's own list.
 * Tab badge shows the count of NEW (unviewed) applications received.
 *
 * For admins it also appends a "Job postings — approvals" block into
 * the admin control centre: pending job_postings with Approve
 * (live for 30 days + employer email) and two-tap Reject w/ reason.
 *
 * All reads/writes ride the RLS in supabase/cf-jobs-migration.sql.
 * Uses window.CFAuth.client. No keys in this file.
 */
(function () {
  'use strict';

  var FN_BASE = 'https://dbgmyvjaavpmernaxnav.functions.supabase.co/';
  var client = null;
  var me = null;
  var isAdmin = false;
  var myJobs = [];       // job_postings rows (mine)
  var received = [];     // applications to my jobs (+ job title/company)
  var sent = [];         // my applications (+ job title/company)
  var appFilter = 'all'; // received-inbox filter: 'all' or one job id

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(ts) {
    try {
      var d = new Date(ts);
      return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return ''; }
  }
  function pill(status) {
    if (status === 'active') return '<span class="pill live">Live</span>';
    if (status === 'pending') return '<span class="pill pause">Pending approval</span>';
    if (status === 'rejected') return '<span class="pill pause">Rejected</span>';
    if (status === 'expired') return '<span class="pill pause">Expired</span>';
    if (status === 'hidden') return '<span class="pill pause">Hidden</span>';
    if (status === 'new') return '<span class="pill boost">New</span>';
    if (status === 'viewed') return '<span class="pill">Viewed</span>';
    return '<span class="pill">' + esc(status) + '</span>';
  }
  function notify(fn, payload) {
    try {
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

  /* ------------------------------------------------------------- data load */
  async function loadAll() {
    var panel = document.getElementById('cfJobAppsPanel');
    if (!panel) return;
    client = (window.CFAuth && window.CFAuth.client) || null;
    if (!client) { panel.innerHTML = '<p class="hint">Sign in to see job applications.</p>'; return; }
    try {
      var u = await client.auth.getUser();
      me = (u && u.data && u.data.user) || null;
    } catch (e) { me = null; }
    if (!me) { panel.innerHTML = '<p class="hint">Sign in to see job applications.</p>'; return; }

    try {
      var prof = await client.from('profiles').select('is_admin').eq('id', me.id).maybeSingle();
      isAdmin = !!(prof && prof.data && prof.data.is_admin);
    } catch (e) { isAdmin = false; }

    // My postings (all statuses — employer read policy).
    try {
      var jp = await client.from('job_postings')
        .select('id,title,company,category,type,location,pay,status,rejection_reason,created_at,expires_at')
        .eq('employer_id', me.id).order('created_at', { ascending: false });
      myJobs = (!jp.error && jp.data) ? jp.data : [];
    } catch (e) { myJobs = []; }

    // Applications received (RLS: employer read on own jobs' rows).
    received = [];
    if (myJobs.length) {
      try {
        var ids = myJobs.map(function (j) { return j.id; });
        var ra = await client.from('job_applications')
          .select('id,job_id,applicant_id,name,email,phone,note,resume_path,status,created_at')
          .in('job_id', ids).order('created_at', { ascending: false });
        if (!ra.error && ra.data) {
          var byId = {};
          myJobs.forEach(function (j) { byId[j.id] = j; });
          received = ra.data.map(function (a) {
            var j = byId[a.job_id] || {};
            return Object.assign({}, a, { jobTitle: j.title || 'Job', jobCompany: j.company || '' });
          });
        }
      } catch (e) {}
    }

    // Applications I've sent.
    sent = [];
    try {
      var sa = await client.from('job_applications')
        .select('id,job_id,status,created_at')
        .eq('applicant_id', me.id).order('created_at', { ascending: false });
      if (!sa.error && sa.data && sa.data.length) {
        var jids = sa.data.map(function (a) { return a.job_id; });
        var jobsRes = await client.from('job_postings').select('id,title,company').in('id', jids);
        var jmap = {};
        if (!jobsRes.error && jobsRes.data) jobsRes.data.forEach(function (j) { jmap[j.id] = j; });
        sent = sa.data.map(function (a) {
          var j = jmap[a.job_id] || {};
          return Object.assign({}, a, { jobTitle: j.title || 'Job (no longer listed)', jobCompany: j.company || '' });
        });
      }
    } catch (e) {}

    renderPanel();
    if (isAdmin) renderAdminBlock();
  }

  /* ---------------------------------------------------------------- render */
  function renderPanel() {
    var panel = document.getElementById('cfJobAppsPanel');
    if (!panel) return;
    var badge = document.getElementById('dtabNJobApps');
    var newCount = received.filter(function (a) { return a.status === 'new'; }).length;
    if (badge) {
      badge.hidden = newCount === 0;
      badge.textContent = String(newCount);
    }

    var counts = {};
    received.forEach(function (a) { counts[a.job_id] = (counts[a.job_id] || 0) + 1; });

    var html = '';

    html += '<h3 style="margin:18px 0 8px">Applications received</h3>';
    if (!received.length) {
      html += '<p class="hint">No applications yet. When a job seeker applies to one of your live job posts, it lands here (and you get an email).</p>';
    } else {
      if (appFilter !== 'all' && !myJobs.some(function (j) { return String(j.id) === appFilter; })) appFilter = 'all';
      if (myJobs.length >= 2) {
        html += '<div style="margin:0 0 10px"><label class="hint" for="cfJobAppFilter" style="margin-right:6px">Show applications for:</label>' +
          '<select id="cfJobAppFilter" style="border:1.5px solid var(--ln);border-radius:10px;padding:8px 10px;font-size:14px;max-width:100%">' +
          '<option value="all"' + (appFilter === 'all' ? ' selected' : '') + '>All my jobs (' + received.length + ')</option>' +
          myJobs.map(function (j) {
            var c = counts[j.id] || 0;
            return '<option value="' + esc(j.id) + '"' + (appFilter === String(j.id) ? ' selected' : '') + '>' + esc(j.title) + ' (' + c + ')</option>';
          }).join('') +
          '</select></div>';
      }
      var shown = appFilter === 'all' ? received : received.filter(function (a) { return String(a.job_id) === appFilter; });
      if (!shown.length) {
        html += '<p class="hint">No applications for this job yet.</p>';
      } else {
      html += shown.map(function (a) {
        return '<div class="lcard"><div class="inf">' +
          '<div class="t">' + esc(a.name) + ' ' + pill(a.status) + '</div>' +
          '<div class="s">Applied to <b>' + esc(a.jobTitle) + '</b>' + (a.jobCompany ? ' · ' + esc(a.jobCompany) : '') + ' · ' + fmtDate(a.created_at) + '</div>' +
          '<div class="s">' + esc(a.email) + (a.phone ? ' · ' + esc(a.phone) : '') + '</div>' +
          (a.note ? '<div class="s" style="margin-top:4px">“' + esc(a.note) + '”</div>' : '') +
          '</div><div class="acts">' +
          (a.resume_path ? '<button class="btn gho" data-cf-resume="' + esc(a.id) + '">Resume</button>' : '') +
          (a.status === 'new' ? '<button class="btn pri" data-cf-viewed="' + esc(a.id) + '">Mark viewed</button>' : '') +
          '</div></div>';
      }).join('');
      }
    }

    html += '<h3 style="margin:22px 0 8px">My job posts</h3>';
    if (!myJobs.length) {
      html += '<p class="hint">You have not posted a job yet. Post one from the Jobs section on the marketplace — it goes live after a quick approval.</p>';
    } else {
      html += myJobs.map(function (j) {
        var n = counts[j.id] || 0;
        return '<div class="lcard"><div class="inf">' +
          '<div class="t">' + esc(j.title) + ' ' + pill(j.status) + '</div>' +
          '<div class="s">' + esc(j.company) + ' · ' + esc(j.category) + ' · ' + esc(j.type) + ' · ' + esc(j.location || '') + '</div>' +
          '<div class="s">' + n + ' application' + (n === 1 ? '' : 's') + ' · posted ' + fmtDate(j.created_at) +
          (j.status === 'active' && j.expires_at ? ' · runs to ' + fmtDate(j.expires_at) : '') +
          (j.status === 'rejected' && j.rejection_reason ? ' · Reason: ' + esc(j.rejection_reason) : '') +
          '</div></div></div>';
      }).join('');
    }

    html += '<h3 style="margin:22px 0 8px">Applications I\'ve sent</h3>';
    if (!sent.length) {
      html += '<p class="hint">Jobs you apply to on ClassiFlip will show up here.</p>';
    } else {
      html += sent.map(function (a) {
        return '<div class="lcard"><div class="inf">' +
          '<div class="t">' + esc(a.jobTitle) + ' ' + pill(a.status) + '</div>' +
          '<div class="s">' + (a.jobCompany ? esc(a.jobCompany) + ' · ' : '') + 'Applied ' + fmtDate(a.created_at) + '</div>' +
          '</div></div>';
      }).join('');
    }

    panel.innerHTML = html;
  }

  /* --------------------------------------------------------- admin block */
  var adminJobs = [];
  async function renderAdminBlock() {
    var sect = document.getElementById('adminSect');
    if (!sect || !client) return;
    var box = document.getElementById('cfAdminJobs');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cfAdminJobs';
      box.style.marginTop = '18px';
      sect.appendChild(box);
    }
    try {
      var res = await client.from('job_postings')
        .select('id,employer_id,title,company,category,type,location,pay,description,plan,created_at')
        .eq('status', 'pending').order('created_at', { ascending: true });
      adminJobs = (!res.error && res.data) ? res.data : [];
    } catch (e) { adminJobs = []; }
    if (!adminJobs.length) {
      box.innerHTML = '<h3 style="margin:0 0 6px">Job postings — approvals</h3><p class="hint">No job postings waiting.</p>';
      return;
    }
    box.innerHTML = '<h3 style="margin:0 0 6px">Job postings — approvals (' + adminJobs.length + ' waiting)</h3>' +
      adminJobs.map(function (j) {
        return '<div class="lcard"><div class="inf">' +
          '<div class="t">' + esc(j.title) + ' <span class="pill pause">Pending</span></div>' +
          '<div class="s">' + esc(j.company) + ' · ' + esc(j.category) + ' · ' + esc(j.type) + ' · ' + esc(j.location || '') + (j.pay ? ' · ' + esc(j.pay) : '') + '</div>' +
          (j.description ? '<div class="s" style="margin-top:4px">' + esc(j.description) + '</div>' : '') +
          '<div class="s">Plan: ' + esc(j.plan || 'single') + ' · posted ' + fmtDate(j.created_at) + '</div>' +
          '</div><div class="acts">' +
          '<button class="btn pri" data-cf-japprove="' + esc(j.id) + '">Approve · 30 days</button>' +
          '<button class="btn gho" data-cf-jreject="' + esc(j.id) + '">Reject</button>' +
          '</div>' +
          '<div class="hidden" data-cf-jreason="' + esc(j.id) + '" style="padding:0 12px 12px">' +
          '<input type="text" placeholder="Reason (shown to the employer)" data-cf-jreason-input="' + esc(j.id) + '" style="width:100%;border:1.5px solid var(--ln);border-radius:10px;padding:9px 11px;font-size:14px">' +
          '<button class="btn pri" data-cf-jreject-confirm="' + esc(j.id) + '" style="margin-top:8px">Confirm reject</button>' +
          '</div></div>';
      }).join('');
  }

  /* ---------------------------------------------------------------- actions */
  document.addEventListener('click', async function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var resumeBtn = t.closest('[data-cf-resume]');
    if (resumeBtn && client) {
      var app = received.find(function (a) { return String(a.id) === resumeBtn.dataset.cfResume; });
      if (app && app.resume_path) {
        resumeBtn.disabled = true; resumeBtn.textContent = 'Opening…';
        try {
          var s = await client.storage.from('resumes').createSignedUrl(app.resume_path, 600);
          if (s && s.data && s.data.signedUrl) window.open(s.data.signedUrl, '_blank');
        } catch (err) {}
        resumeBtn.disabled = false; resumeBtn.textContent = 'Resume';
      }
      return;
    }

    var viewedBtn = t.closest('[data-cf-viewed]');
    if (viewedBtn && client) {
      viewedBtn.disabled = true;
      try {
        await client.from('job_applications').update({ status: 'viewed' }).eq('id', viewedBtn.dataset.cfViewed);
        var a2 = received.find(function (a) { return String(a.id) === viewedBtn.dataset.cfViewed; });
        if (a2) a2.status = 'viewed';
        renderPanel();
      } catch (err) { viewedBtn.disabled = false; }
      return;
    }

    var approveBtn = t.closest('[data-cf-japprove]');
    if (approveBtn && client && isAdmin) {
      approveBtn.disabled = true; approveBtn.textContent = 'Approving…';
      try {
        var exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        var up = await client.from('job_postings')
          .update({ status: 'active', expires_at: exp, rejection_reason: null })
          .eq('id', approveBtn.dataset.cfJapprove);
        if (!up.error) {
          notify('notify-employer-job-live', { job_id: approveBtn.dataset.cfJapprove });
          adminJobs = adminJobs.filter(function (j) { return String(j.id) !== approveBtn.dataset.cfJapprove; });
          renderAdminBlock();
          loadAll();
        } else { approveBtn.disabled = false; approveBtn.textContent = 'Approve · 30 days'; }
      } catch (err) { approveBtn.disabled = false; approveBtn.textContent = 'Approve · 30 days'; }
      return;
    }

    var rejectBtn = t.closest('[data-cf-jreject]');
    if (rejectBtn) {
      var boxR = document.querySelector('[data-cf-jreason="' + rejectBtn.dataset.cfJreject + '"]');
      if (boxR) boxR.classList.toggle('hidden');
      return;
    }

    var rejectConfirm = t.closest('[data-cf-jreject-confirm]');
    if (rejectConfirm && client && isAdmin) {
      var id = rejectConfirm.dataset.cfJrejectConfirm;
      var input = document.querySelector('[data-cf-jreason-input="' + id + '"]');
      var reason = input ? input.value.trim() : '';
      rejectConfirm.disabled = true; rejectConfirm.textContent = 'Rejecting…';
      try {
        var up2 = await client.from('job_postings')
          .update({ status: 'rejected', rejection_reason: reason || null })
          .eq('id', id);
        if (!up2.error) {
          adminJobs = adminJobs.filter(function (j) { return String(j.id) !== id; });
          renderAdminBlock();
          loadAll();
        } else { rejectConfirm.disabled = false; rejectConfirm.textContent = 'Confirm reject'; }
      } catch (err) { rejectConfirm.disabled = false; rejectConfirm.textContent = 'Confirm reject'; }
      return;
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'cfJobAppFilter') {
      appFilter = e.target.value;
      renderPanel();
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadAll);
  else loadAll();

  window.CFJobsInbox = { refresh: loadAll };
})();
