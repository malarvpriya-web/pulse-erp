import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';

/**
 * The public careers page.
 *
 * Rendered fullscreen at /careers/:portalKey, OUTSIDE the ERP shell — no
 * sidebar, no topbar, no auth context. An applicant is not a user of this
 * system and must never be shown any of it.
 *
 * It deliberately does NOT use `@/services/api/client`: that client attaches the
 * stored JWT to every request and redirects to /login on a 401. Both behaviours
 * are wrong here — a stranger has no token, and a member of staff who happens to
 * be logged in must not have their session travel to a public form. Plain fetch,
 * no credentials.
 *
 * Everything the page needs comes from one anonymous endpoint, so it can be
 * embedded in a marketing site or linked to directly.
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

const ui = {
  page:    { minHeight: '100vh', background: '#faf9fc', color: '#15121f',
             fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif" },
  wrap:    { maxWidth: 880, margin: '0 auto', padding: '0 20px 72px' },
  head:    { padding: '48px 0 28px', borderBottom: '2px solid #15121f' },
  h1:      { fontSize: 34, fontWeight: 700, letterSpacing: '-.02em', margin: 0, lineHeight: 1.1 },
  intro:   { fontSize: 17, color: '#4a4458', margin: '12px 0 0', lineHeight: 1.55, maxWidth: '60ch' },
  card:    { background: '#fff', border: '1px solid #e5e1ee', borderRadius: 4, padding: '20px 22px',
             marginTop: 16, boxShadow: '0 1px 2px rgba(21,18,31,.05)' },
  jobTitle:{ fontSize: 19, fontWeight: 700, margin: 0, letterSpacing: '-.01em' },
  meta:    { display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 8,
             fontSize: 13, color: '#7b7490' },
  body:    { fontSize: 14.5, color: '#4a4458', lineHeight: 1.6, marginTop: 12, whiteSpace: 'pre-wrap' },
  btn:     { background: '#4b2dce', color: '#fff', border: 'none', borderRadius: 4,
             padding: '9px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  btnGhost:{ background: 'transparent', color: '#4b2dce', border: '1px solid #ddd3fb',
             borderRadius: 4, padding: '9px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  label:   { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#4a4458', marginBottom: 4 },
  input:   { width: '100%', padding: '9px 11px', border: '1px solid #e5e1ee', borderRadius: 4,
             fontSize: 14, fontFamily: 'inherit', background: '#fff', color: '#15121f' },
  grid2:   { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 },
  note:    { fontSize: 12.5, color: '#7b7490', marginTop: 6 },
  err:     { background: '#fbeae8', border: '1px solid #f0c4c0', color: '#a81e17',
             borderRadius: 4, padding: '11px 13px', fontSize: 14, marginTop: 14 },
  ok:      { background: '#e3f3ea', border: '1px solid #b9dfc9', color: '#12633a',
             borderRadius: 4, padding: '18px 20px', fontSize: 15, lineHeight: 1.55 },
};

const money = (n) => (n == null ? null : `₹${Number(n).toLocaleString('en-IN')}`);

function experienceLabel(job) {
  const { experience_min: lo, experience_max: hi } = job;
  if (lo == null && hi == null) return null;
  if (lo != null && hi != null) return `${lo}–${hi} years`;
  return lo != null ? `${lo}+ years` : `up to ${hi} years`;
}

const emptyForm = () => ({
  full_name: '', email: '', phone: '', current_company: '', current_designation: '',
  experience_years: '', notice_period_days: '', expected_ctc: '', location: '',
  cover_note: '', website: '',   // `website` is the honeypot — see below
});

export default function CareersPortal() {
  const { portalKey } = useParams();

  const [portal,  setPortal]  = useState(null);
  const [jobs,    setJobs]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);

  const [applyingTo, setApplyingTo] = useState(null);
  const [form,       setForm]       = useState(emptyForm());
  const [resume,     setResume]     = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [formErr,    setFormErr]    = useState(null);
  const [doneFor,    setDoneFor]    = useState(null);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/public/careers/${encodeURIComponent(portalKey)}`);
      if (!res.ok) throw new Error(res.status === 404 ? 'This careers page is not available.' : 'Could not load open roles.');
      const data = await res.json();
      setPortal(data.portal);
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [portalKey]);

  useEffect(() => { load(); }, [load]);

  const openApply = (job) => {
    setApplyingTo(job);
    setForm(emptyForm());
    setResume(null);
    setFormErr(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.full_name.trim()) return setFormErr('Please tell us your name.');
    if (!form.email.trim())     return setFormErr('Please give us an email address we can reply to.');

    setSubmitting(true);
    setFormErr(null);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => { if (v !== '' && v != null) fd.append(k, v); });
      if (resume) fd.append('resume', resume);

      const res = await fetch(
        `${API_BASE}/v1/public/careers/${encodeURIComponent(portalKey)}/apply/${applyingTo.id}`,
        { method: 'POST', body: fd }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');

      setDoneFor(applyingTo.job_title);
      setApplyingTo(null);
    } catch (e2) {
      setFormErr(e2.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div style={{ ...ui.page, padding: 48, textAlign: 'center', color: '#7b7490' }}>Loading open roles…</div>;
  }

  if (loadErr) {
    return (
      <div style={ui.page}>
        <div style={ui.wrap}>
          <div style={ui.head}><h1 style={ui.h1}>Careers</h1></div>
          <div style={ui.err}>{loadErr}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={ui.page}>
      <div style={ui.wrap}>
        <header style={ui.head}>
          <h1 style={ui.h1}>{portal?.display_name || 'Careers'}</h1>
          {portal?.intro_text && <p style={ui.intro}>{portal.intro_text}</p>}
          <p style={{ ...ui.note, marginTop: 14 }}>
            {jobs.length === 0
              ? 'No open positions at the moment.'
              : `${jobs.length} open position${jobs.length === 1 ? '' : 's'}`}
          </p>
        </header>

        {doneFor && (
          <div style={{ ...ui.ok, marginTop: 22 }}>
            <strong>Thank you — your application for {doneFor} has been received.</strong>
            <div style={{ marginTop: 6 }}>
              Our team will review it and be in touch if there is a fit. You can apply for other
              roles below.
            </div>
          </div>
        )}

        {jobs.map(job => {
          const exp = experienceLabel(job);
          const showingApply = applyingTo?.id === job.id;
          return (
            <article key={job.id} style={ui.card}>
              <h2 style={ui.jobTitle}>{job.job_title}</h2>
              <div style={ui.meta}>
                {job.department && <span>{job.department}</span>}
                {job.location && <span>{job.location}</span>}
                {job.employment_type && <span>{job.employment_type}</span>}
                {exp && <span>{exp}</span>}
                {/* Only present when the portal is configured to publish it. */}
                {job.salary_min != null && (
                  <span>{money(job.salary_min)}{job.salary_max != null ? ` – ${money(job.salary_max)}` : '+'}</span>
                )}
                {job.closing_date && <span>Closes {String(job.closing_date).slice(0, 10)}</span>}
              </div>

              {job.description  && <div style={ui.body}>{job.description}</div>}
              {job.requirements && (
                <div style={ui.body}><strong style={{ color: '#15121f' }}>What we are looking for: </strong>{job.requirements}</div>
              )}
              {job.benefits && (
                <div style={ui.body}><strong style={{ color: '#15121f' }}>Benefits: </strong>{job.benefits}</div>
              )}

              {!showingApply ? (
                <button type="button" style={{ ...ui.btn, marginTop: 16 }} onClick={() => openApply(job)}>
                  Apply for this role
                </button>
              ) : (
                <form onSubmit={submit} style={{ marginTop: 18, borderTop: '1px solid #e5e1ee', paddingTop: 18 }}>
                  <div style={ui.grid2}>
                    <div>
                      <label style={ui.label} htmlFor="ca-name">Full name *</label>
                      <input id="ca-name" style={ui.input} value={form.full_name}
                             onChange={e => set('full_name', e.target.value)} autoComplete="name" required />
                    </div>
                    <div>
                      <label style={ui.label} htmlFor="ca-email">Email *</label>
                      <input id="ca-email" type="email" style={ui.input} value={form.email}
                             onChange={e => set('email', e.target.value)} autoComplete="email" required />
                    </div>
                    <div>
                      <label style={ui.label} htmlFor="ca-phone">Phone</label>
                      <input id="ca-phone" style={ui.input} value={form.phone}
                             onChange={e => set('phone', e.target.value)} autoComplete="tel" />
                    </div>
                    <div>
                      <label style={ui.label} htmlFor="ca-loc">Where are you based?</label>
                      <input id="ca-loc" style={ui.input} value={form.location}
                             onChange={e => set('location', e.target.value)} placeholder="Bengaluru" />
                    </div>
                    <div>
                      <label style={ui.label} htmlFor="ca-emp">Current employer</label>
                      <input id="ca-emp" style={ui.input} value={form.current_company}
                             onChange={e => set('current_company', e.target.value)} />
                    </div>
                    <div>
                      <label style={ui.label} htmlFor="ca-title">Current job title</label>
                      <input id="ca-title" style={ui.input} value={form.current_designation}
                             onChange={e => set('current_designation', e.target.value)} />
                    </div>
                    <div>
                      <label style={ui.label} htmlFor="ca-exp">Years of experience</label>
                      <input id="ca-exp" type="number" min="0" max="60" step="0.5" style={ui.input}
                             value={form.experience_years} onChange={e => set('experience_years', e.target.value)} />
                    </div>
                    <div>
                      <label style={ui.label} htmlFor="ca-notice">Notice period (days)</label>
                      <input id="ca-notice" type="number" min="0" max="365" style={ui.input}
                             value={form.notice_period_days} onChange={e => set('notice_period_days', e.target.value)} />
                    </div>
                    <div>
                      <label style={ui.label} htmlFor="ca-ctc">Expected annual salary</label>
                      <input id="ca-ctc" type="number" min="0" style={ui.input}
                             value={form.expected_ctc} onChange={e => set('expected_ctc', e.target.value)} />
                    </div>
                  </div>

                  <div style={{ marginTop: 14 }}>
                    <label style={ui.label} htmlFor="ca-note">Anything you would like us to know?</label>
                    <textarea id="ca-note" rows={3} style={{ ...ui.input, resize: 'vertical' }}
                              value={form.cover_note} onChange={e => set('cover_note', e.target.value)} />
                  </div>

                  <div style={{ marginTop: 14 }}>
                    <label style={ui.label} htmlFor="ca-cv">Résumé</label>
                    <input id="ca-cv" type="file" accept=".pdf,.doc,.docx" style={{ fontSize: 13 }}
                           onChange={e => setResume(e.target.files?.[0] ?? null)} />
                    <p style={ui.note}>PDF or Word, up to 5 MB.</p>
                  </div>

                  {/* Honeypot. A person never sees this; a bot fills every field it
                      finds. aria-hidden and tabIndex keep it away from screen
                      readers and keyboard navigation so it only ever catches bots. */}
                  <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
                    <label htmlFor="ca-website">Do not fill this in</label>
                    <input id="ca-website" tabIndex={-1} autoComplete="off" value={form.website}
                           onChange={e => set('website', e.target.value)} />
                  </div>

                  {formErr && <div style={ui.err}>{formErr}</div>}

                  <p style={{ ...ui.note, marginTop: 14 }}>
                    By applying you agree that we may hold the details above to consider you for this
                    role and get in touch about it.
                  </p>

                  <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                    <button type="submit" style={{ ...ui.btn, opacity: submitting ? 0.6 : 1 }} disabled={submitting}>
                      {submitting ? 'Sending…' : 'Submit application'}
                    </button>
                    <button type="button" style={ui.btnGhost} onClick={() => setApplyingTo(null)} disabled={submitting}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
