import { useState, useEffect, useRef, useCallback } from 'react';
import DOMPurify from 'dompurify';
import {
  Mail, Plus, Search, Edit2, Trash2, Copy, Eye, EyeOff, X,
  ToggleLeft, ToggleRight, RefreshCw,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast as useGlobalToast } from '@/context/ToastContext';
import { matchesSearch } from '../shared/search';
import EmailSetupWarning from '../shared/components/EmailSetupWarning';
import { PageHero } from '@/components/pulse-ui';

// ── Events the system actually sends ──────────────────────────────────────────
// Each key is the trigger the backend fires (services/emailTrigger.js). The list
// used to offer interview_scheduled / rejection / offer_letter / joining_
// instructions / interview_reminder, none of which is ever sent, so a template
// saved under them never went out. `vars` are the placeholders that event fills;
// any other {{placeholder}} would arrive blank.
const TYPE_CFG = {
  application_received:   { label: 'Application received',   color: '#6366f1', bg: '#eef2ff',
    when: 'A candidate is added or applies on the careers page', vars: ['candidate_name', 'candidate_email', 'job_title'] },
  interview_l1_scheduled: { label: 'Interview scheduled',    color: '#0891b2', bg: '#ecfeff',
    when: 'An interview is booked', vars: ['candidate_name', 'interview_date', 'interview_mode'] },
  interview_rejected:     { label: 'Not progressing',        color: '#dc2626', bg: '#fef2f2',
    when: 'An interview outcome is "Not selected"', vars: ['candidate_name', 'rejection_reason'] },
  offer_sent:             { label: 'Offer sent',             color: '#16a34a', bg: '#f0fdf4',
    when: 'An offer is approved. E-mail only — no letter is attached; letters are issued at onboarding', vars: ['candidate_name', 'company_name', 'job_title', 'ctc', 'joining_date', 'offer_expiry_date'] },
  hired_welcome:          { label: 'Welcome on joining',     color: '#6B3FDB', bg: '#faf5ff',
    when: 'The employee record is created for a hire', vars: ['candidate_name', 'job_title', 'joining_date', 'employee_id'] },
};

const ALL_TYPES = Object.entries(TYPE_CFG).map(([value, cfg]) => ({ value, ...cfg }));

const VAR_DESC = {
  candidate_name: "Candidate's full name", candidate_email: "Candidate's email", job_title: 'Position title',
  company_name: 'Your company', interview_date: 'Interview date and time', interview_mode: 'In person / Video call / Phone',
  rejection_reason: 'Reason recorded with the outcome', ctc: 'Annual CTC', joining_date: 'Joining date',
  offer_expiry_date: 'Offer valid until', employee_id: 'New employee code',
};
// Example values for the preview, so it reads like the e-mail a candidate gets.
const SAMPLE = {
  candidate_name: 'Priya Sharma', candidate_email: 'priya@example.com', job_title: 'Service Engineer',
  company_name: 'Your company', interview_date: '24 Nov 26, 10:30', interview_mode: 'Video call',
  rejection_reason: 'We have chosen a candidate whose experience is closer to the role', ctc: '₹6,00,000',
  joining_date: '01 Dec 26', offer_expiry_date: '28 Nov 26', employee_id: 'EMP0123',
};
const fillSample = (text) => String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => SAMPLE[k] ?? m);
const varsFor = (type) => (TYPE_CFG[type]?.vars || []).map(k => ({ key: `{{${k}}}`, desc: VAR_DESC[k] || k }));

const EMPTY_FORM = {
  template_name: '',
  template_type: 'application_received',
  subject: '',
  body_html: '',
  is_active: true,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const stripHtml = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// ── Delete confirmation dialog ────────────────────────────────────────────────
function ConfirmDialog({ msg, onConfirm, onCancel }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '28px 32px',
        maxWidth: 380, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,.2)',
      }}>
        <div style={{ fontSize: 36, marginBottom: 12, textAlign: 'center' }}>🗑️</div>
        <div style={{ fontSize: 15, color: '#374151', textAlign: 'center', marginBottom: 24 }}>{msg}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={onCancel} style={{
            padding: '9px 22px', borderRadius: 8, border: '1px solid #e5e7eb',
            background: '#f9fafb', color: '#374151', fontWeight: 600, cursor: 'pointer', fontSize: 14,
          }}>Cancel</button>
          <button onClick={onConfirm} style={{
            padding: '9px 22px', borderRadius: 8, border: 'none',
            background: '#dc2626', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 14,
          }}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── Template card ─────────────────────────────────────────────────────────────
function TemplateCard({ tpl, onEdit, onDelete, onToggle, onDuplicate }) {
  const cfg = TYPE_CFG[tpl.template_type] || TYPE_CFG.application_received;
  const preview = stripHtml(tpl.body_html || '');

  return (
    <div style={{
      background: '#fff', borderRadius: 14, border: '1.5px solid #f0f0f8',
      padding: '20px', display: 'flex', flexDirection: 'column', gap: 12,
      transition: 'box-shadow .2s, border-color .2s',
      opacity: tpl.is_active ? 1 : 0.55,
    }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 6px 24px rgba(75,45,206,.1)'; e.currentTarget.style.borderColor = '#c7b8f5'; }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = ''; e.currentTarget.style.borderColor = '#f0f0f8'; }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {tpl.template_name}
          </div>
          {tpl.in_use && (
            <div style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, color: '#065f46', background: '#d1fae5', borderRadius: 10, padding: '1px 8px', marginBottom: 6, marginRight: 6 }}>IN USE</div>
          )}
          {tpl.is_default && (
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
              {tpl.overridden ? 'Shared default — your own version is used instead' : 'Shared default. Edit it to make your own version.'}
            </div>
          )}
          <span style={{
            display: 'inline-block', padding: '3px 10px', borderRadius: 20,
            fontSize: 11, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase',
            background: cfg.bg, color: cfg.color,
          }}>
            {cfg.label}
          </span>
        </div>
        {/* Status pill */}
        <button
          disabled={tpl.is_default}
          onClick={() => onToggle(tpl.id, tpl.is_active)}
          title={tpl.is_active ? 'Active — click to deactivate' : 'Inactive — click to activate'}
          style={{
            padding: '4px 10px', borderRadius: 20, border: 'none', cursor: 'pointer',
            fontSize: 11, fontWeight: 700,
            background: tpl.is_active ? '#dcfce7' : '#f3f4f6',
            color: tpl.is_active ? '#16a34a' : '#9ca3af',
            flexShrink: 0,
          }}
        >
          {tpl.is_active ? '● Active' : '○ Inactive'}
        </button>
      </div>

      {/* Subject */}
      <div style={{ fontSize: 13, color: '#374151' }}>
        <span style={{ fontWeight: 600, color: '#6b7280', marginRight: 6 }}>Subject:</span>
        <span style={{ fontStyle: tpl.subject ? 'normal' : 'italic', color: tpl.subject ? '#111827' : '#9ca3af' }}>
          {tpl.subject || 'No subject set'}
        </span>
      </div>

      {/* Body preview */}
      <div style={{
        fontSize: 12, color: '#9ca3af', lineHeight: 1.6,
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
        overflow: 'hidden', background: '#fafafa', borderRadius: 8,
        padding: '8px 12px', border: '1px solid #f0f0f8',
        minHeight: 60,
      }}>
        {preview || <span style={{ fontStyle: 'italic' }}>No body content</span>}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid #f3f4f6' }}>
        <button onClick={() => onEdit(tpl)} style={btnStyle('#4B2DCE', '#fff')}>
          <Edit2 size={12} /> Edit
        </button>
        <button onClick={() => onDuplicate(tpl)} style={btnStyle('#f3f4f6', '#374151')}>
          <Copy size={12} /> Duplicate
        </button>
        {!tpl.is_default && (
          <button onClick={() => onDelete(tpl.id, tpl.template_name)} style={{ ...btnStyle('#fef2f2', '#dc2626'), marginLeft: 'auto' }}>
            <Trash2 size={12} /> Delete
          </button>
        )}
      </div>
    </div>
  );
}

function btnStyle(bg, color) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '6px 12px', borderRadius: 7, border: 'none',
    background: bg, color, fontSize: 12, fontWeight: 600,
    cursor: 'pointer',
  };
}

// ── Drawer (create / edit) ────────────────────────────────────────────────────
function TemplateDrawer({ editing, onClose, onSaved, showToast }) {
  const [form, setForm] = useState(editing
    ? {
        template_name: editing.template_name,
        template_type: editing.template_type,
        subject: editing.subject,
        body_html: editing.body_html,
        is_active: editing.is_active,
      }
    : { ...EMPTY_FORM });
  const [saving, setSaving]     = useState(false);
  const [preview, setPreview]   = useState(false);
  const bodyRef                 = useRef(null);
  const subjectRef              = useRef(null);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  // Insert variable at cursor in the active field
  const insertVar = (varKey) => {
    const el = document.activeElement;
    if (el === bodyRef.current || el === subjectRef.current) {
      const start = el.selectionStart;
      const end   = el.selectionEnd;
      const field = el === bodyRef.current ? 'body_html' : 'subject';
      const val   = form[field];
      set(field, val.slice(0, start) + varKey + val.slice(end));
      // Restore cursor after insert
      setTimeout(() => {
        el.focus();
        el.setSelectionRange(start + varKey.length, start + varKey.length);
      }, 0);
    } else {
      // Default: append to body
      set('body_html', (form.body_html || '') + varKey);
      bodyRef.current?.focus();
    }
  };

  const handleSave = async () => {
    if (!form.template_name.trim()) return showToast('Template name is required', 'error');
    if (!form.subject.trim())       return showToast('Subject is required', 'error');
    if (!form.body_html.trim())     return showToast('Body cannot be empty', 'error');
    const allowed = new Set(TYPE_CFG[form.template_type]?.vars || []);
    const unknown = [...new Set([...`${form.subject} ${form.body_html}`.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))].filter(v => !allowed.has(v));
    if (unknown.length && !window.confirm(`This event does not fill ${unknown.map(v => `{{${v}}}`).join(', ')} — it would arrive blank. Save anyway?`)) return;
    setSaving(true);
    try {
      const payload = { ...form };
      if (editing) {
        await api.put(`/recruitment/email-templates/${editing.id}`, payload);
        showToast(editing.is_default ? 'Saved as your own version — it replaces the shared default' : 'Template updated');
      } else {
        await api.post('/recruitment/email-templates', payload);
        showToast('Template created');
      }
      onSaved();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to save template', 'error');
    } finally {
      setSaving(false);
    }
  };

  const typeCfg = TYPE_CFG[form.template_type] || TYPE_CFG.application_received;

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 900,
      }} />
      {/* Drawer */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', maxHeight: 'calc(100vh - 48px)', borderRadius: 12, overflowY: 'auto', maxWidth: 'calc(100vw - 32px)', width: 680,
        background: '#fff', zIndex: 901,
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,.18)',
        animation: 'pulse-dialog-fade .18s ease-out',
      }}>
        {/* Drawer header */}
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid #f0f0f8',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>
              {editing ? 'Edit Template' : 'New Email Template'}
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
              {editing ? `Editing "${editing.template_name}"` : 'Fill in the details below'}
            </div>
          </div>
          <button onClick={onClose} style={{ background: '#f3f4f6', border: 'none', borderRadius: 8, padding: 8, cursor: 'pointer', display: 'flex' }}>
            <X size={16} color="#6b7280" />
          </button>
        </div>

        {/* Drawer body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>

          {/* Name + Type row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
            <div>
              <label style={labelStyle}>Template Name *</label>
              <input
                style={inputStyle}
                placeholder="e.g. Interview Invite"
                value={form.template_name}
                onChange={e => set('template_name', e.target.value)}
              />
            </div>
            <div>
              <label style={labelStyle}>Type *</label>
              <select style={inputStyle} value={form.template_type} onChange={e => set('template_type', e.target.value)}>
                {ALL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </div>

          {/* Type badge preview */}
          <div style={{ marginBottom: 18 }}>
            <span style={{
              display: 'inline-block', padding: '4px 12px', borderRadius: 20,
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
              background: typeCfg.bg, color: typeCfg.color,
            }}>
              {typeCfg.label}
            </span>
          </div>

          {/* Subject */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label style={{ ...labelStyle, margin: 0 }}>Subject Line *</label>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>{form.subject.length} chars</span>
            </div>
            <input
              ref={subjectRef}
              style={inputStyle}
              placeholder="Use {{variable}} for dynamic content"
              value={form.subject}
              onChange={e => set('subject', e.target.value)}
            />
          </div>

          {/* Body editor */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label style={{ ...labelStyle, margin: 0 }}>Email Body (HTML) *</label>
              <button
                type="button"
                onClick={() => setPreview(p => !p)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '4px 10px', borderRadius: 6, border: '1px solid #e5e7eb',
                  background: preview ? '#4B2DCE' : '#f9fafb', color: preview ? '#fff' : '#6b7280',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {preview ? <><EyeOff size={12} /> Editor</> : <><Eye size={12} /> Preview</>}
              </button>
            </div>

            {preview ? (
              <div style={{
                border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden',
                minHeight: 280,
              }}>
                <div style={{
                  background: '#f8f7ff', padding: '8px 14px', fontSize: 11,
                  color: '#6b7280', borderBottom: '1px solid #e5e7eb', fontWeight: 600,
                }}>
                  Preview with example values — {fillSample(form.subject) || '(no subject)'}
                </div>
                <div
                  style={{ padding: '20px 24px', minHeight: 240, fontSize: 14, lineHeight: 1.7, color: '#374151' }}
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(fillSample(form.body_html) || '<p style="color:#9ca3af">No content yet…</p>') }}
                />
              </div>
            ) : (
              <textarea
                ref={bodyRef}
                style={{ ...inputStyle, minHeight: 260, fontFamily: '"Fira Code", "Consolas", monospace', fontSize: 13, resize: 'vertical' }}
                placeholder={'<p>Dear {{candidate_name}},</p>\n<p>We are pleased to invite you…</p>'}
                value={form.body_html}
                onChange={e => set('body_html', e.target.value)}
              />
            )}
          </div>

          {/* Variable chips */}
          <div style={{
            background: '#fafafa', border: '1px solid #f0f0f8', borderRadius: 10,
            padding: '14px 16px', marginBottom: 18,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>
              Click a placeholder to insert it — these are the ones this event fills
            </div>
            {TYPE_CFG[form.template_type]?.when && (
              <div style={{ fontSize: 12, color: '#374151', marginBottom: 8 }}>Sent when: {TYPE_CFG[form.template_type].when}</div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {varsFor(form.template_type).map(v => (
                <button
                  key={v.key}
                  type="button"
                  title={v.desc}
                  onClick={() => insertVar(v.key)}
                  style={{
                    padding: '4px 10px', borderRadius: 6, border: '1px solid #e5e7eb',
                    background: '#fff', color: '#4B2DCE', fontSize: 12, fontWeight: 600,
                    cursor: 'pointer', fontFamily: 'monospace',
                    transition: 'background .15s, border-color .15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#F2EFFE'; e.currentTarget.style.borderColor = '#6B3FDB'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = '#e5e7eb'; }}
                >
                  {v.key}
                </button>
              ))}
            </div>
          </div>

          {/* Active toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={() => set('is_active', !form.is_active)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
            >
              {form.is_active
                ? <ToggleRight size={28} color="#16a34a" />
                : <ToggleLeft size={28} color="#9ca3af" />
              }
            </button>
            <span style={{ fontSize: 13, fontWeight: 600, color: form.is_active ? '#16a34a' : '#9ca3af' }}>
              {form.is_active ? 'On — this is the e-mail sent for this event (any other one for the event is switched off)' : 'Off — not sent'}
            </span>
          </div>

        </div>

        {/* Drawer footer */}
        <div style={{
          padding: '16px 24px', borderTop: '1px solid #f0f0f8',
          display: 'flex', justifyContent: 'flex-end', gap: 10,
          flexShrink: 0, background: '#fafafa',
        }}>
          <button onClick={onClose} style={btnStyle('#f3f4f6', '#374151')}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ ...btnStyle('#4B2DCE', '#fff'), opacity: saving ? 0.7 : 1, padding: '9px 24px', fontSize: 13 }}
          >
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Template'}
          </button>
        </div>
      </div>
    </>
  );
}

const labelStyle = { display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em' };
const inputStyle = { width: '100%', padding: '9px 13px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', transition: 'border-color .15s' };

// ── Main page ─────────────────────────────────────────────────────────────────
export default function EmailTemplates({ embedded = false }) {
  const [templates,  setTemplates]  = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing,    setEditing]    = useState(null);
  const [search,     setSearch]     = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [confirm,    setConfirm]    = useState(null); // { id, name }
  const [emailOk,    setEmailOk]    = useState(true);
  useEffect(() => {
    api.get('/recruitment/setup-status').then(r => setEmailOk(r.data?.email_configured !== false)).catch(() => {});
  }, []);
  const _globalToast = useGlobalToast();
  const showToast = useCallback((msg, type = 'success') => _globalToast({ message: msg, type }), [_globalToast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/recruitment/email-templates');
      setTemplates(Array.isArray(res.data) ? res.data : []);
    } catch {
      showToast('Failed to load templates', 'error');
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (id, current) => {
    try {
      await api.put(`/recruitment/email-templates/${id}`, { is_active: !current });
      showToast(current ? 'Switched off' : 'Switched on — any other template for this event was switched off');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to update status', 'error');
    }
  };

  const handleDelete = async () => {
    if (!confirm) return;
    try {
      await api.delete(`/recruitment/email-templates/${confirm.id}`);
      showToast('Template deleted');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to delete template', 'error');
    } finally {
      setConfirm(null);
    }
  };

  const handleDuplicate = async (tpl) => {
    try {
      const payload = {
        template_name: `${tpl.template_name} (Copy)`,
        template_type: tpl.template_type,
        subject: tpl.subject,
        body_html: tpl.body_html,
        is_active: false,
      };
      await api.post('/recruitment/email-templates', payload);
      showToast('Copy made (switched off) — edit it, then switch it on');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to duplicate template', 'error');
    }
  };

  const openCreate = () => { setEditing(null); setDrawerOpen(true); };
  const openEdit   = (tpl) => { setEditing(tpl); setDrawerOpen(true); };
  const closeDrawer = () => { setDrawerOpen(false); setEditing(null); };
  const onSaved    = () => { closeDrawer(); load(); };

  // Filter
  const filtered = templates.filter(t => {
    const matchSearch = matchesSearch(t, [
      'template_name',
      'subject',
      tt => TYPE_CFG[tt.template_type]?.label,
    ], search);
    const matchType = typeFilter === 'all' || t.template_type === typeFilter;
    return matchSearch && matchType;
  });

  // What the sender picks for each event: the company's own active template,
  // else the shared default (services/emailTrigger.js).
  const withUse = templates.map(t => ({
    ...t, in_use: t.is_active && (t.is_default ? !t.overridden : true),
  }));
  const shown = filtered.map(t => withUse.find(w => w.id === t.id) || t);
  const missing = ALL_TYPES.filter(ty => !withUse.some(t => t.in_use && t.template_type === ty.value));

  return (
    <>
      <style>{`
        @keyframes et-fadein   { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
        @keyframes et-slide-in { from { transform:translateX(100%); } to { transform:translateX(0); } }
        .et-input:focus { border-color: #6B3FDB !important; box-shadow: 0 0 0 3px rgba(107,63,219,.12) !important; }
      `}</style>

      {confirm && (
        <ConfirmDialog
          msg={`Delete "${confirm.name}"? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirm(null)}
        />
      )}
      {drawerOpen && (
        <TemplateDrawer
          editing={editing}
          onClose={closeDrawer}
          onSaved={onSaved}
          showToast={showToast}
        />
      )}

      <div>
        {!embedded && (
          <PageHero icon={Mail} eyebrow="Recruitment" title="Email Templates"
            subtitle="The e-mails candidates receive, one per event" />
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: '#6b7280' }}>
            One template is sent per event. Shared defaults are used until you make your own version.
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="pulse-btn-secondary" onClick={load} title="Refresh"><RefreshCw size={14} /></button>
            <button type="button" className="pulse-btn-primary" onClick={openCreate}><Plus size={14} /> New template</button>
          </div>
        </div>
        <EmailSetupWarning show={!emailOk} />
        {missing.length > 0 && !loading && (
          <div style={{ padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, color: '#92400e', fontSize: 13, marginBottom: 14 }}>
            Nothing is sent for: {missing.map(m => m.label).join(', ')} — no template is switched on for {missing.length > 1 ? 'these events' : 'this event'}.
          </div>
        )}

        {/* ── Filter bar ── */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Search */}
          <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 340 }}>
            <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
            <input
              style={{ ...inputStyle, paddingLeft: 34, fontSize: 13 }}
              className="et-input"
              placeholder="Search templates…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
                <X size={13} color="#9ca3af" />
              </button>
            )}
          </div>

          {/* Type filter */}
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <button
              onClick={() => setTypeFilter('all')}
              style={{
                padding: '6px 14px', borderRadius: 20, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: typeFilter === 'all' ? '#4B2DCE' : '#f3f4f6',
                color: typeFilter === 'all' ? '#fff' : '#374151',
              }}
            >
              All
            </button>
            {ALL_TYPES.filter(t => templates.some(tp => tp.template_type === t.value)).map(t => (
              <button
                key={t.value}
                onClick={() => setTypeFilter(typeFilter === t.value ? 'all' : t.value)}
                style={{
                  padding: '6px 14px', borderRadius: 20, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  background: typeFilter === t.value ? t.color : t.bg,
                  color: typeFilter === t.value ? '#fff' : t.color,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Template grid ── */}
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 18 }}>
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} style={{ height: 200, background: 'linear-gradient(90deg,#f0f0f8 25%,#f8f7ff 50%,#f0f0f8 75%)', backgroundSize: '200% 100%', borderRadius: 14, animation: 'et-fadein .5s ease' }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 20px' }}>
            <div style={{ fontSize: 52, marginBottom: 16 }}>
              {search || typeFilter !== 'all' ? '🔍' : '✉️'}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#374151', marginBottom: 8 }}>
              {search || typeFilter !== 'all' ? 'No templates match your filters' : 'No templates yet'}
            </div>
            <div style={{ fontSize: 14, color: '#9ca3af', marginBottom: 24 }}>
              {search || typeFilter !== 'all'
                ? 'Try adjusting your search or clearing the type filter'
                : 'Create your first email template to get started'}
            </div>
            {!(search || typeFilter !== 'all') && (
              <button onClick={openCreate} style={{ ...btnStyle('#4B2DCE', '#fff'), padding: '11px 24px', fontSize: 14 }}>
                <Plus size={15} /> Create Template
              </button>
            )}
            {(search || typeFilter !== 'all') && (
              <button onClick={() => { setSearch(''); setTypeFilter('all'); }} style={btnStyle('#f3f4f6', '#374151')}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 18 }}>
            {shown.map(tpl => (
              <TemplateCard
                key={tpl.id}
                tpl={tpl}
                onEdit={openEdit}
                onDelete={(id, name) => setConfirm({ id, name })}
                onToggle={handleToggle}
                onDuplicate={handleDuplicate}
              />
            ))}
          </div>
        )}

      </div>
    </>
  );
}
