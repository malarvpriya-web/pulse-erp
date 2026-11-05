import React, { useState, useEffect, useCallback } from 'react';
import { Globe, Copy, RefreshCw, ExternalLink } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { fmtDate } from '@/utils/dateFormatter';

/**
 * Careers page administration.
 *
 * The public page at /careers/:portalKey is anonymous by design, so everything
 * that governs it — the key, who may post to it, how often, and whether salary
 * is published — has to be manageable from inside the ERP. This is that screen.
 *
 * The submission log deliberately shows REFUSED submissions alongside accepted
 * ones. A rejected row is the only evidence that a portal is being abused, or
 * that a real applicant was turned away by a rule that is set too tightly.
 */

const STATUS_STYLE = {
  accepted:     { bg: '#e3f3ea', color: '#12633a', label: 'Accepted' },
  duplicate:    { bg: '#eef2f7', color: '#4a5568', label: 'Duplicate' },
  spam:         { bg: '#fbf0df', color: '#9a5b06', label: 'Spam (honeypot)' },
  rate_limited: { bg: '#fbf0df', color: '#9a5b06', label: 'Rate limited' },
  rejected:     { bg: '#fbeae8', color: '#a81e17', label: 'Rejected' },
};

const card  = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 10, padding: '16px 18px' };
const label = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };
const input = { width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' };
const eyebrow = { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.04em' };

export default function CareersPageAdmin({ setPage }) {
  const _toast = useToast();
  const toast  = useCallback((msg, type = 'success') => _toast({ message: msg, type }), [_toast]);

  const [portal, setPortal]           = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [form, setForm]               = useState({
    display_name: '', intro_text: '', allowed_origins: '',
    max_per_hour: 60, show_salary_range: false, is_active: true,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, sRes] = await Promise.allSettled([
        api.get('/recruitment/careers-portal'),
        api.get('/recruitment/careers-portal/submissions'),
      ]);
      const p = pRes.status === 'fulfilled' ? pRes.value.data : null;
      setPortal(p);
      if (p) {
        setForm({
          display_name: p.display_name || '',
          intro_text: p.intro_text || '',
          allowed_origins: Array.isArray(p.allowed_origins) ? p.allowed_origins.join(', ') : '',
          max_per_hour: p.max_per_hour ?? 60,
          show_salary_range: !!p.show_salary_range,
          is_active: p.is_active !== false,
        });
      }
      setSubmissions(sRes.status === 'fulfilled' && Array.isArray(sRes.value.data) ? sRes.value.data : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const publicUrl = portal ? `${window.location.origin}/careers/${portal.portal_key}` : '';

  const create = async () => {
    setSaving(true);
    try {
      await api.post('/recruitment/careers-portal', { display_name: form.display_name || 'Careers' });
      toast('Careers page created');
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not create the careers page', 'error');
    } finally { setSaving(false); }
  };

  const rotate = async () => {
    setSaving(true);
    try {
      await api.post('/recruitment/careers-portal', { display_name: form.display_name || 'Careers' });
      toast('New link generated — the previous one no longer works');
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not rotate the link', 'error');
    } finally { setSaving(false); }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/recruitment/careers-portal', {
        display_name: form.display_name,
        intro_text: form.intro_text,
        allowed_origins: form.allowed_origins,
        max_per_hour: Number(form.max_per_hour) || 60,
        show_salary_range: form.show_salary_range,
        is_active: form.is_active,
      });
      toast('Saved');
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not save', 'error');
    } finally { setSaving(false); }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast('Link copied');
    } catch {
      toast('Could not copy — select the link and copy it manually', 'error');
    }
  };

  if (loading) return <div style={{ padding: 24, color: '#6b7280' }}>Loading…</div>;

  return (
    <PageShell dock={
      <PageHero
        icon={Globe}
        eyebrow="Recruitment"
        title="Careers Page"
        subtitle="The public page candidates apply through, and the log of everything it has received"
      />
    }>
      {!portal ? (
        <div style={{ ...card, maxWidth: 640 }}>
          <h3 style={{ margin: 0, fontSize: 17 }}>No careers page yet</h3>
          <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.55, marginTop: 8 }}>
            Creating one gives you a public link that lists every <strong>open</strong> job opening
            and lets people apply directly. Applicants arrive in the pipeline as ordinary
            candidates — same duplicate checks, same search, same stages.
          </p>
          <div style={{ marginTop: 14, maxWidth: 320 }}>
            <label style={label} htmlFor="cp-name">Page heading</label>
            <input id="cp-name" style={input} value={form.display_name}
                   onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                   placeholder="Careers at Manifest" />
          </div>
          <button onClick={create} disabled={saving}
                  style={{ marginTop: 14, background: '#4B2DCE', color: '#fff', border: 'none', borderRadius: 6, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            {saving ? 'Creating…' : 'Create careers page'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* The link */}
          <div style={card}>
            <div style={eyebrow}>Public link</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <code style={{ flex: '1 1 320px', minWidth: 0, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 10px', fontSize: 12.5, overflowX: 'auto', whiteSpace: 'nowrap' }}>
                {publicUrl}
              </code>
              <button onClick={copy} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, padding: '7px 11px', cursor: 'pointer' }}>
                <Copy size={12} /> Copy
              </button>
              <a href={publicUrl} target="_blank" rel="noopener noreferrer"
                 style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#4B2DCE', background: '#EFEAFD', border: '1px solid #ddd3fb', borderRadius: 6, padding: '7px 11px', textDecoration: 'none' }}>
                <ExternalLink size={12} /> Open
              </a>
              <button onClick={rotate} disabled={saving}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#9a5b06', background: '#fbf0df', border: '1px solid #ecd4a8', borderRadius: 6, padding: '7px 11px', cursor: 'pointer' }}>
                <RefreshCw size={12} /> New link
              </button>
            </div>
            <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 8, lineHeight: 1.5 }}>
              Anyone with this link can see your open roles and apply. Generating a new link
              revokes the old one immediately — use it if the link has been posted somewhere you
              did not intend.
            </p>
          </div>

          {/* Counters */}
          {portal.stats && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10 }}>
              {[
                ['Applications',  portal.stats.accepted,     '#12633a'],
                ['Last 7 days',   portal.stats.last_7_days,  '#4B2DCE'],
                ['Duplicates',    portal.stats.duplicates,   '#6b7280'],
                ['Bots blocked',  portal.stats.spam,         '#9a5b06'],
                ['Rate limited',  portal.stats.rate_limited, '#9a5b06'],
                ['Refused',       portal.stats.rejected,     '#a81e17'],
              ].map(([lbl, val, color]) => (
                <div key={lbl} style={{ ...card, padding: '12px 14px' }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color, lineHeight: 1 }}>{val ?? 0}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{lbl}</div>
                </div>
              ))}
            </div>
          )}

          {/* Settings */}
          <div style={card}>
            <div style={eyebrow}>Settings</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14, marginTop: 10 }}>
              <div>
                <label style={label} htmlFor="cp-title">Page heading</label>
                <input id="cp-title" style={input} value={form.display_name}
                       onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} />
              </div>
              <div>
                <label style={label} htmlFor="cp-cap">Applications accepted per hour</label>
                <input id="cp-cap" type="number" min="1" max="10000" style={input} value={form.max_per_hour}
                       onChange={e => setForm(f => ({ ...f, max_per_hour: e.target.value }))} />
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={label} htmlFor="cp-intro">Introduction</label>
              <textarea id="cp-intro" rows={2} style={{ ...input, resize: 'vertical' }} value={form.intro_text}
                        onChange={e => setForm(f => ({ ...f, intro_text: e.target.value }))}
                        placeholder="We build power electronics for industry. Here is where we are hiring." />
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={label} htmlFor="cp-origins">Allowed website addresses</label>
              <input id="cp-origins" style={input} value={form.allowed_origins}
                     onChange={e => setForm(f => ({ ...f, allowed_origins: e.target.value }))}
                     placeholder="https://www.example.com, https://careers.example.com" />
              <p style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 5, lineHeight: 1.5 }}>
                Comma-separated. Leave blank to accept applications from anywhere — fine while you
                are testing, worth setting once the form is embedded in your own site.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 14 }}>
              <label htmlFor="cp-salary" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
                <input id="cp-salary" type="checkbox" checked={form.show_salary_range}
                       onChange={e => setForm(f => ({ ...f, show_salary_range: e.target.checked }))} />
                Publish the salary range on each advert
              </label>
              <label htmlFor="cp-active" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
                <input id="cp-active" type="checkbox" checked={form.is_active}
                       onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
                Careers page is live
              </label>
            </div>

            <button onClick={save} disabled={saving}
                    style={{ marginTop: 16, background: '#4B2DCE', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>

          {/* The log */}
          <div style={card}>
            <div style={eyebrow}>Recent submissions</div>
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '6px 0 10px' }}>
              Refused submissions are shown too — they are how you notice a rule set too tightly,
              or a form being hammered.
            </p>
            {submissions.length === 0 ? (
              <p style={{ fontSize: 13, color: '#9ca3af', margin: 0 }}>Nothing yet.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 620 }}>
                  <thead>
                    <tr>
                      {['When', 'Applicant', 'Role', 'Outcome', 'Detail'].map(h => (
                        <th key={h} style={{ textAlign: 'left', fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em', padding: '8px 10px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {submissions.map(s => {
                      const st = STATUS_STYLE[s.status] || { bg: '#f3f4f6', color: '#374151', label: s.status };
                      return (
                        <tr key={s.id}>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6', whiteSpace: 'nowrap', color: '#6b7280' }}>{fmtDate(s.created_at)}</td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6' }}>
                            {s.applicant_name || '—'}
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{s.applicant_email || ''}</div>
                          </td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6', color: '#6b7280' }}>{s.job_title || '—'}</td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6' }}>
                            <span style={{ background: st.bg, color: st.color, borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{st.label}</span>
                          </td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6', color: '#9ca3af', fontSize: 12 }}>{s.reason || ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
