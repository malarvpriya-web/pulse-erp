/**
 * Ready-made careers section for the company website (Careers Website tab).
 *
 * Owner decision 2026-11-17: candidates apply on the company's own website.
 * This builds a self-contained snippet — one <div> and one <script>, no
 * libraries — that the web developer pastes into the careers page. It lists
 * the open jobs from GET /public/careers/:key and posts the application
 * (multipart, with the résumé) to /public/careers/:key/apply/:jobId, the same
 * two calls the developer card documents. The job id it posts is what links
 * the applicant to the job in Pulse.
 *
 * Everything from the API is written with textContent, never innerHTML, so a
 * job description cannot inject markup into the company's website. The hidden
 * `website` field is the server's bot trap and must stay empty.
 */
export function buildCareersEmbed({ listUrl, heading = 'Open positions' }) {
  const cfg = JSON.stringify({ listUrl, heading });
  return `<!-- Careers section — jobs and applications come from Pulse. Paste where the jobs should appear. -->
<div id="pulse-careers"></div>
<style>
  #pulse-careers{font-family:inherit;color:#1f2937;max-width:900px}
  #pulse-careers .pc-job{border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;margin:0 0 12px;background:#fff}
  #pulse-careers .pc-title{font-size:18px;font-weight:700;margin:0 0 4px}
  #pulse-careers .pc-meta{font-size:13px;color:#6b7280;margin:0 0 8px}
  #pulse-careers .pc-text{white-space:pre-line;font-size:14px;line-height:1.55;margin:8px 0}
  #pulse-careers button{background:#6B3FDB;color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer}
  #pulse-careers button[disabled]{opacity:.6;cursor:default}
  #pulse-careers .pc-link{background:none;color:#6B3FDB;padding:0;font-weight:600}
  #pulse-careers form{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:12px}
  #pulse-careers label{display:flex;flex-direction:column;font-size:13px;font-weight:600;gap:4px}
  #pulse-careers input,#pulse-careers textarea{font:inherit;font-weight:400;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px}
  #pulse-careers .pc-wide{grid-column:1/-1}
  #pulse-careers .pc-note{font-size:12px;color:#6b7280}
  #pulse-careers .pc-msg{padding:10px 12px;border-radius:8px;font-size:14px}
  #pulse-careers .pc-ok{background:#ecfdf5;color:#065f46}
  #pulse-careers .pc-err{background:#fef2f2;color:#991b1b}
  #pulse-careers .pc-trap{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
</style>
<script>
(function () {
  var CFG = ${cfg};
  var root = document.getElementById('pulse-careers');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function field(form, name, label, type, required, wide) {
    var l = el('label', wide ? 'pc-wide' : null, label + (required ? ' *' : ''));
    var i = type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
    if (type !== 'textarea') i.type = type || 'text';
    i.name = name; if (required) i.required = true;
    if (type === 'file') i.accept = '.pdf,.doc,.docx';
    l.appendChild(i); form.appendChild(l); return i;
  }
  function applyForm(job, consent, box) {
    var form = document.createElement('form');
    field(form, 'full_name', 'Full name', 'text', true);
    field(form, 'email', 'Email', 'email', true);
    field(form, 'phone', 'Phone', 'tel');
    field(form, 'location', 'Current city', 'text');
    field(form, 'current_company', 'Current company', 'text');
    field(form, 'current_designation', 'Current designation', 'text');
    field(form, 'experience_years', 'Experience (years)', 'number');
    field(form, 'notice_period_days', 'Notice period (days)', 'number');
    field(form, 'expected_ctc', 'Expected CTC (per year)', 'number');
    field(form, 'resume', 'Résumé (PDF or Word)', 'file', false, true);
    field(form, 'cover_note', 'Anything you would like us to know', 'textarea', false, true);
    var trap = el('label', 'pc-trap', 'Leave this empty'); var t = document.createElement('input');
    t.name = 'website'; t.tabIndex = -1; t.autocomplete = 'off'; trap.appendChild(t); form.appendChild(trap);
    form.appendChild(el('p', 'pc-note pc-wide', consent || ''));
    var msg = el('div', 'pc-wide'); var send = el('button', 'pc-wide', 'Send application'); send.type = 'submit';
    form.appendChild(send); form.appendChild(msg);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault(); send.disabled = true; msg.className = 'pc-wide'; msg.textContent = 'Sending…';
      fetch(CFG.listUrl + '/apply/' + encodeURIComponent(job.id), { method: 'POST', body: new FormData(form) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok) { form.replaceWith(el('div', 'pc-msg pc-ok', res.j.message || 'Thank you — your application has been received.')); }
          else { send.disabled = false; msg.className = 'pc-msg pc-err pc-wide'; msg.textContent = res.j.error || 'Could not send your application. Please try again.'; }
        })
        .catch(function () { send.disabled = false; msg.className = 'pc-msg pc-err pc-wide'; msg.textContent = 'Could not reach the server. Please try again.'; });
    });
    box.appendChild(form);
  }
  function render(data) {
    root.textContent = '';
    root.appendChild(el('h2', null, (data.portal && data.portal.display_name) || CFG.heading));
    if (data.portal && data.portal.intro_text) root.appendChild(el('p', 'pc-text', data.portal.intro_text));
    var jobs = data.jobs || [];
    if (!jobs.length) { root.appendChild(el('p', null, 'There are no open positions right now. Please check back soon.')); return; }
    jobs.forEach(function (job) {
      var card = el('div', 'pc-job');
      card.appendChild(el('h3', 'pc-title', job.job_title));
      var exp = job.experience_min != null || job.experience_max != null
        ? (job.experience_min != null ? job.experience_min : 0) + (job.experience_max != null ? '–' + job.experience_max : '+') + ' yrs' : null;
      card.appendChild(el('p', 'pc-meta', [job.department, job.location, job.employment_type, exp,
        job.number_of_positions > 1 ? job.number_of_positions + ' openings' : null].filter(Boolean).join(' · ')));
      var more = el('div'); more.hidden = true;
      ['description', 'requirements', 'skills_required', 'benefits'].forEach(function (k) { if (job[k]) more.appendChild(el('p', 'pc-text', job[k])); });
      if (job.closing_date) more.appendChild(el('p', 'pc-note', 'Apply by ' + String(job.closing_date).slice(0, 10)));
      var toggle = el('button', 'pc-link', 'View details and apply'); toggle.type = 'button';
      toggle.addEventListener('click', function () {
        more.hidden = !more.hidden; toggle.textContent = more.hidden ? 'View details and apply' : 'Hide';
        if (!more.hidden && !more.dataset.form) { more.dataset.form = '1'; applyForm(job, data.portal && data.portal.consent_text, more); }
      });
      card.appendChild(toggle); card.appendChild(more); root.appendChild(card);
    });
  }
  root.textContent = 'Loading open positions…';
  fetch(CFG.listUrl).then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
    .then(render).catch(function () { root.textContent = 'Open positions could not be loaded right now.'; });
})();
</script>`;
}
