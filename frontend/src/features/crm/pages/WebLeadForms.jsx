/**
 * WebLeadForms.jsx — the staff side of web-to-lead capture.
 *
 * `/crm/web-lead-forms` shipped with complete CRUD and no UI at all, so no form
 * key could ever be minted from inside the product and the public capture
 * endpoint had nothing to point at. Both `web_lead_forms` and
 * `web_lead_submissions` were therefore permanently empty — see
 * MODULE_FEATURE_CONNECTION_MANUAL §157.1.
 *
 * What this page has to get right that a plain CRUD screen would not:
 *  - The form key is the credential. It is generated server-side, never chosen,
 *    and it is the only thing standing between a public URL and your lead table.
 *    It is shown for copying but treated as a secret in the copy around it.
 *  - PATCH returns `form_key: '[redacted]'`. Merging that response into local
 *    state would blank the key in the UI and make it look revoked, so every save
 *    re-reads the list instead (GET returns the real key).
 *  - Refused submissions matter more than accepted ones. A form quietly turning
 *    enquiries away is the failure this page exists to make visible, so the
 *    rejected count sits next to the accepted one rather than behind a filter.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Globe, Plus, X, Copy, Check, RefreshCw, Code2, Inbox,
  ShieldAlert, ToggleLeft, ToggleRight, Edit2, ChevronRight,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import './WebLeadForms.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

// ── formatters ────────────────────────────────────────────────────────────────
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};
const fmtDateTime = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return `${fmtDate(d)} ${dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

// The five values `web_lead_submissions.status` is constrained to. Everything
// except `accepted` is an enquiry that did NOT become a lead, which is why they
// are all coloured as warnings rather than greys.
const STATUS_META = {
  accepted:     { label: 'Accepted',     bg: '#dcfce7', color: '#166534' },
  duplicate:    { label: 'Duplicate',    bg: '#e0e7ff', color: '#3730a3' },
  rejected:     { label: 'Rejected',     bg: '#fee2e2', color: '#991b1b' },
  rate_limited: { label: 'Rate limited', bg: '#fef3c7', color: '#92400e' },
  spam:         { label: 'Spam',         bg: '#f3f4f6', color: '#4b5563' },
};
const statusMeta = (s) => STATUS_META[s] || { label: s || 'Unknown', bg: '#f3f4f6', color: '#6b7280' };

const emptyForm = () => ({
  name: '', lead_source: 'Website', default_zone: '', default_industry: '',
  max_per_hour: 60, allowed_origins: '',
});

// ── copy-to-clipboard button ──────────────────────────────────────────────────
function CopyBtn({ value, label = 'Copy', title }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // clipboard is unavailable on an insecure origin — fall back to a
      // selectable prompt rather than failing silently.
      window.prompt('Copy this:', value);
    }
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  };
  return (
    <button type="button" className="wlf-copy" onClick={copy} title={title || label}>
      {done ? <Check size={12} /> : <Copy size={12} />}
      {done ? 'Copied' : label}
    </button>
  );
}

// ── the embed snippet ─────────────────────────────────────────────────────────
// Field names are the ones the public route reads; `website` is the honeypot and
// must stay present, hidden, and empty — a bot that fills it gets a 200 and is
// silently binned, which is what stops it learning it was detected.
const snippetFor = (key) => `<form action="${API_BASE}/public/web-lead/${key}" method="POST">
  <input name="company_name"    placeholder="Company" />
  <input name="contact_person"  placeholder="Your name" />
  <input name="email"           type="email" placeholder="Email" />
  <input name="phone"           placeholder="Phone" />
  <input name="industry"        placeholder="Industry" />
  <input name="location"        placeholder="City" />
  <textarea name="message"      placeholder="How can we help?"></textarea>

  <!-- Honeypot: keep it hidden and empty. Bots fill it; people never see it. -->
  <input name="website" tabindex="-1" autocomplete="off" style="display:none" />

  <button type="submit">Send enquiry</button>
</form>`;

// ── submissions list for one form ─────────────────────────────────────────────
function SubmissionsPanel({ formId }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [filter, setFilter]   = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/crm/web-lead-forms/${formId}/submissions`);
      setRows(Array.isArray(data?.data) ? data.data : []);
    } catch (err) {
      setRows([]);
      setError(err.response?.data?.error || 'Could not load submissions');
    } finally {
      setLoading(false);
    }
  }, [formId]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c = { all: rows.length };
    rows.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }, [rows]);

  const shown = filter === 'all' ? rows : rows.filter(r => r.status === filter);

  if (loading) return <div className="wlf-loading"><div className="wlf-spinner" /></div>;
  if (error)   return <div className="wlf-err">{error}</div>;

  return (
    <div className="wlf-subs">
      <div className="wlf-sub-hd">
        <div className="wlf-chips">
          {['all', 'accepted', 'duplicate', 'rejected', 'rate_limited', 'spam']
            .filter(k => k === 'all' || counts[k])
            .map(k => (
              <button
                key={k}
                className={`wlf-chip${filter === k ? ' is-on' : ''}`}
                onClick={() => setFilter(k)}
              >
                {k === 'all' ? 'All' : statusMeta(k).label} ({counts[k] || 0})
              </button>
            ))}
        </div>
        <button className="wlf-btn-ghost" onClick={load} title="Reload submissions">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="wlf-empty wlf-empty--sm">
          <Inbox size={28} color="#d1d5db" />
          <p>{rows.length === 0 ? 'Nothing submitted through this form yet' : 'Nothing with that status'}</p>
        </div>
      ) : (
        <div className="wlf-table-wrap">
          <table className="wlf-table">
            <thead>
              <tr>
                <th>When</th><th>Status</th><th>Company</th><th>Email</th>
                <th>Why refused</th><th>Lead</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(s => {
                const m = statusMeta(s.status);
                return (
                  <tr key={s.id}>
                    <td className="wlf-nowrap">{fmtDateTime(s.created_at)}</td>
                    <td><span className="wlf-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span></td>
                    <td>{s.company_name || '—'}</td>
                    <td className="wlf-mono">{s.email || '—'}</td>
                    {/* The reason is the whole point of logging a refusal. */}
                    <td className="wlf-reason">{s.reason || '—'}</td>
                    <td>{s.lead_id ? `#${s.lead_id}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── create / edit drawer ──────────────────────────────────────────────────────
function FormDrawer({ editing, onClose, onSaved, showToast }) {
  const isEdit = !!editing;
  const [form, setForm] = useState(() =>
    isEdit
      ? {
          name: editing.name || '',
          lead_source: editing.lead_source || 'Website',
          default_zone: editing.default_zone || '',
          default_industry: editing.default_industry || '',
          max_per_hour: editing.max_per_hour ?? 60,
          allowed_origins: (editing.allowed_origins || []).join('\n'),
        }
      : emptyForm()
  );
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.name.trim()) { showToast('Give the form a name', 'error'); return; }
    const perHour = Number(form.max_per_hour);
    if (!Number.isFinite(perHour) || perHour <= 0) {
      showToast('Submissions per hour must be a positive number', 'error');
      return;
    }
    // One origin per line. Blank means "accept from anywhere", which is the
    // right default for a form you paste into a site you do not control.
    const origins = form.allowed_origins
      .split('\n').map(o => o.trim()).filter(Boolean);

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        lead_source: form.lead_source.trim() || 'Website',
        default_zone: form.default_zone.trim() || null,
        default_industry: form.default_industry.trim() || null,
        max_per_hour: perHour,
        allowed_origins: origins,
      };
      if (isEdit) await api.patch(`/crm/web-lead-forms/${editing.id}`, payload);
      else        await api.post('/crm/web-lead-forms', payload);
      onSaved(isEdit ? 'Form updated' : 'Form created — copy its key below');
    } catch (err) {
      showToast(err.response?.data?.error || `Could not ${isEdit ? 'update' : 'create'} the form`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="wlf-mask" onClick={onClose}>
      <div className="wlf-drawer" onClick={e => e.stopPropagation()}>
        <div className="wlf-drawer-hd">
          <h3>{isEdit ? 'Edit form' : 'New web-to-lead form'}</h3>
          <button className="wlf-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="wlf-drawer-body">
          <label className="wlf-field">
            <span>Form name</span>
            <input
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="Website — Contact Us"
              autoFocus
            />
            <em>Internal only. Names the source of the enquiry in your own reports.</em>
          </label>

          <div className="wlf-row2">
            <label className="wlf-field">
              <span>Lead source</span>
              <input value={form.lead_source} onChange={e => set('lead_source', e.target.value)} placeholder="Website" />
            </label>
            <label className="wlf-field">
              <span>Submissions per hour</span>
              <input
                type="number" min="1" max="10000"
                value={form.max_per_hour}
                onChange={e => set('max_per_hour', e.target.value)}
              />
              <em>Counted from the table, so a restart cannot reset it.</em>
            </label>
          </div>

          <div className="wlf-row2">
            <label className="wlf-field">
              <span>Default zone</span>
              <input value={form.default_zone} onChange={e => set('default_zone', e.target.value)} placeholder="South" />
            </label>
            <label className="wlf-field">
              <span>Default industry</span>
              <input value={form.default_industry} onChange={e => set('default_industry', e.target.value)} placeholder="Manufacturing" />
            </label>
          </div>
          <p className="wlf-hint">
            Defaults fill in only when the visitor leaves that field blank.
          </p>

          <label className="wlf-field">
            <span>Allowed origins</span>
            <textarea
              rows={3}
              value={form.allowed_origins}
              onChange={e => set('allowed_origins', e.target.value)}
              placeholder={'https://yourcompany.com\nhttps://www.yourcompany.com'}
            />
            <em>
              One per line. Leave empty to accept from anywhere. A submission from
              any other origin is refused and logged with the origin it came from.
            </em>
          </label>
        </div>

        <div className="wlf-drawer-ft">
          <button className="wlf-btn-outline" onClick={onClose}>Cancel</button>
          <button className="wlf-btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create form'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────
export default function WebLeadForms() {
  const [forms,    setForms]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [drawer,   setDrawer]   = useState(null);   // 'create' | form object
  const [expanded, setExpanded] = useState(null);   // form id
  const [showKey,  setShowKey]  = useState(null);   // form id whose key is revealed
  const [toast,    setToast]    = useState(null);

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/crm/web-lead-forms');
      setForms(Array.isArray(data) ? data : []);
    } catch (err) {
      setForms([]);
      setError(err.response?.data?.error || 'Could not load web-to-lead forms');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (f) => {
    try {
      await api.patch(`/crm/web-lead-forms/${f.id}`, { is_active: !f.is_active });
      // Deliberately a re-read, not a merge of the PATCH response: that response
      // redacts `form_key`, and writing it into state would blank the key here.
      await load();
      showToast(f.is_active ? 'Form paused — it now returns "not found"' : 'Form is live again');
    } catch (err) {
      showToast(err.response?.data?.error || 'Could not change the form', 'error');
    }
  };

  const totals = useMemo(() => {
    // submissions_30d includes refusals; captured is the difference, so the two
    // headline numbers partition the traffic instead of overlapping.
    const all30     = forms.reduce((s, f) => s + (f.submissions_30d || 0), 0);
    const refused30 = forms.reduce((s, f) => s + (f.rejected_30d || 0), 0);
    return {
      forms:     forms.length,
      active:    forms.filter(f => f.is_active).length,
      captured30: Math.max(0, all30 - refused30),
      refused30,
    };
  }, [forms]);

  return (
    <PageShell
      className="web-lead-forms"
      dock={
        <PageHero
          icon={Globe}
          eyebrow="CRM · Lead Capture"
          title="Web-to-Lead Forms"
          subtitle="Turn a form on your website into a lead in the pipeline, with the refusals visible"
          meta={[
            { label: 'forms', value: totals.forms },
            { label: 'live', value: totals.active },
            { label: 'captured (30d)', value: totals.captured30 },
            { label: 'refused (30d)', value: totals.refused30 },
          ]}
          actions={
            <>
              <button className="plh-cta plh-cta--ghost" onClick={load} disabled={loading}>
                <RefreshCw size={14} /> Refresh
              </button>
              <button className="plh-cta" onClick={() => setDrawer('create')}>
                <Plus size={14} /> New Form
              </button>
            </>
          }
        />
      }
    >
      {toast && <div className={`wlf-toast wlf-toast-${toast.type}`}>{toast.msg}</div>}
      {error && <div className="wlf-err">{error}</div>}

      {loading ? (
        <div className="wlf-loading"><div className="wlf-spinner" /></div>
      ) : forms.length === 0 ? (
        <div className="wlf-empty">
          <Globe size={40} color="#d1d5db" />
          <h3>No capture forms yet</h3>
          <p>
            Create one to get a form key and a snippet you can paste into your website.
            Enquiries arrive as leads, assigned by the usual round-robin.
          </p>
          <button className="wlf-btn-primary" onClick={() => setDrawer('create')}>
            <Plus size={14} /> New Form
          </button>
        </div>
      ) : (
        <div className="wlf-list">
          {forms.map(f => {
            const open = expanded === f.id;
            const keyShown = showKey === f.id;
            const endpoint = `${API_BASE}/public/web-lead/${f.form_key}`;
            return (
              <div key={f.id} className={`wlf-card${f.is_active ? '' : ' is-paused'}`}>
                <div className="wlf-card-hd">
                  <button
                    className="wlf-expand"
                    onClick={() => setExpanded(open ? null : f.id)}
                    aria-expanded={open}
                    aria-label={open ? 'Collapse' : 'Expand'}
                  >
                    <ChevronRight size={16} className={open ? 'wlf-chev-open' : ''} />
                  </button>

                  <div className="wlf-card-main">
                    <span className="wlf-card-name">{f.name}</span>
                    <span className="wlf-card-meta">
                      {f.lead_source}
                      {f.default_zone ? ` · ${f.default_zone}` : ''}
                      {f.default_industry ? ` · ${f.default_industry}` : ''}
                      {' · '}max {f.max_per_hour}/hr
                      {(f.allowed_origins || []).length
                        ? ` · ${f.allowed_origins.length} allowed origin${f.allowed_origins.length !== 1 ? 's' : ''}`
                        : ' · any origin'}
                    </span>
                  </div>

                  <div className="wlf-card-stats">
                    {/* `submissions_30d` from the API counts EVERY submission,
                        refused ones included, so showing it as "captured" beside
                        "refused" would count the same enquiry twice. Captured is
                        the difference. */}
                    <div className="wlf-stat">
                      <span className="wlf-stat-val">{Math.max(0, (f.submissions_30d || 0) - (f.rejected_30d || 0))}</span>
                      <span className="wlf-stat-lbl">captured 30d</span>
                    </div>
                    {/* Refusals sit beside captures on purpose — a form quietly
                        turning enquiries away is the failure worth surfacing. */}
                    <div className={`wlf-stat${f.rejected_30d ? ' wlf-stat--warn' : ''}`}>
                      <span className="wlf-stat-val">{f.rejected_30d || 0}</span>
                      <span className="wlf-stat-lbl">refused 30d</span>
                    </div>
                    <div className="wlf-stat">
                      {/* The stored counter increments on accepts only. */}
                      <span className="wlf-stat-val">{f.submission_count || 0}</span>
                      <span className="wlf-stat-lbl">leads all time</span>
                    </div>
                  </div>

                  <div className="wlf-card-actions">
                    <span className={`wlf-badge ${f.is_active ? 'wlf-live' : 'wlf-paused'}`}>
                      {f.is_active ? 'Live' : 'Paused'}
                    </span>
                    <button
                      className="wlf-icon-btn"
                      onClick={() => toggleActive(f)}
                      title={f.is_active ? 'Pause this form' : 'Make this form live'}
                    >
                      {f.is_active ? <ToggleRight size={18} color="#059669" /> : <ToggleLeft size={18} color="#9ca3af" />}
                    </button>
                    <button className="wlf-icon-btn" onClick={() => setDrawer(f)} title="Edit form">
                      <Edit2 size={14} />
                    </button>
                  </div>
                </div>

                {open && (
                  <div className="wlf-card-body">
                    <div className="wlf-key-row">
                      <div className="wlf-key-block">
                        <label>Form key</label>
                        <div className="wlf-key-val">
                          <code className="wlf-mono">
                            {keyShown ? f.form_key : '•'.repeat(Math.min(32, (f.form_key || '').length))}
                          </code>
                          <button className="wlf-btn-ghost" onClick={() => setShowKey(keyShown ? null : f.id)}>
                            {keyShown ? 'Hide' : 'Reveal'}
                          </button>
                          <CopyBtn value={f.form_key} label="Copy key" />
                        </div>
                        {/* The key is the only thing gating a public URL. */}
                        <p className="wlf-hint">
                          <ShieldAlert size={12} /> Anyone holding this key can post enquiries to your
                          pipeline. Paste it into your site, not into a public repo or a ticket.
                        </p>
                      </div>

                      <div className="wlf-key-block">
                        <label>Endpoint</label>
                        <div className="wlf-key-val">
                          <code className="wlf-mono wlf-ellipsis" title={endpoint}>{endpoint}</code>
                          <CopyBtn value={endpoint} label="Copy URL" />
                        </div>
                        <p className="wlf-hint">
                          Created {fmtDate(f.created_at)}
                          {f.last_submission_at ? ` · last submission ${fmtDateTime(f.last_submission_at)}` : ' · no submissions yet'}
                        </p>
                      </div>
                    </div>

                    <details className="wlf-snippet">
                      <summary><Code2 size={13} /> Paste this into your website</summary>
                      <div className="wlf-snippet-body">
                        <CopyBtn value={snippetFor(f.form_key)} label="Copy snippet" />
                        <pre className="wlf-pre">{snippetFor(f.form_key)}</pre>
                      </div>
                    </details>

                    <SubmissionsPanel formId={f.id} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {drawer && (
        <FormDrawer
          editing={drawer === 'create' ? null : drawer}
          onClose={() => setDrawer(null)}
          showToast={showToast}
          onSaved={async (msg) => {
            setDrawer(null);
            await load();
            showToast(msg);
          }}
        />
      )}
    </PageShell>
  );
}
