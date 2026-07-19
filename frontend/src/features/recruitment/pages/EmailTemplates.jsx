import { useState, useEffect, useRef, useCallback } from 'react';
import DOMPurify from 'dompurify';
import {
  Mail, Plus, Search, Edit2, Trash2, Copy, Eye, EyeOff,
  X, Check, ChevronDown, ToggleLeft, ToggleRight, RefreshCw,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast as useGlobalToast } from '@/context/ToastContext';

// ── Type config ───────────────────────────────────────────────────────────────
const TYPE_CFG = {
  application_received: { label: 'Application Received', color: '#6366f1', bg: '#eef2ff' },
  interview_scheduled:  { label: 'Interview Scheduled',  color: '#0891b2', bg: '#ecfeff' },
  interview_reminder:   { label: 'Interview Reminder',   color: '#d97706', bg: '#fffbeb' },
  rejection:            { label: 'Rejection',             color: '#dc2626', bg: '#fef2f2' },
  offer_letter:         { label: 'Offer Letter',          color: '#16a34a', bg: '#f0fdf4' },
  joining_instructions: { label: 'Joining Instructions',  color: '#6B3FDB', bg: '#faf5ff' },
};

const ALL_TYPES = Object.entries(TYPE_CFG).map(([value, cfg]) => ({ value, ...cfg }));

// ── Available template variables ──────────────────────────────────────────────
const VARIABLES = [
  { key: '{{candidate_name}}',  desc: "Candidate's full name" },
  { key: '{{candidate_email}}', desc: "Candidate's email" },
  { key: '{{job_title}}',       desc: 'Position title' },
  { key: '{{company_name}}',    desc: 'Your company' },
  { key: '{{interview_date}}',  desc: 'Interview date' },
  { key: '{{interview_time}}',  desc: 'Interview time' },
  { key: '{{meeting_link}}',    desc: 'Video call link' },
  { key: '{{offer_salary}}',    desc: 'Offered salary' },
  { key: '{{joining_date}}',    desc: 'Start date' },
  { key: '{{recruiter_name}}',  desc: 'Recruiter name' },
];

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
        <button onClick={() => onDelete(tpl.id, tpl.template_name)} style={{ ...btnStyle('#fef2f2', '#dc2626'), marginLeft: 'auto' }}>
          <Trash2 size={12} /> Delete
        </button>
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
    setSaving(true);
    try {
      const payload = { ...form };
      if (editing) {
        await api.put(`/recruitment/email-templates/${editing.id}`, payload);
        showToast('Template updated');
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
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 'min(680px, 95vw)',
        background: '#fff', zIndex: 901,
        display: 'flex', flexDirection: 'column',
        boxShadow: '-8px 0 40px rgba(0,0,0,.15)',
        animation: 'et-slide-in .22s ease',
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
                  Preview — {form.subject || '(no subject)'}
                </div>
                <div
                  style={{ padding: '20px 24px', minHeight: 240, fontSize: 14, lineHeight: 1.7, color: '#374151' }}
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(form.body_html || '<p style="color:#9ca3af">No content yet…</p>') }}
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
              Click a variable to insert at cursor
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {VARIABLES.map(v => (
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
              {form.is_active ? 'Active — template will be available for use' : 'Inactive — template is hidden from use'}
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
export default function EmailTemplates({ setPage }) {
  const [templates,  setTemplates]  = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing,    setEditing]    = useState(null);
  const [search,     setSearch]     = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [confirm,    setConfirm]    = useState(null); // { id, name }
  const _globalToast = useGlobalToast();
  const showToast = useCallback((msg, type = 'success') => _globalToast({ message: msg, type }), [_globalToast]);

  const load = useCallback(async () => {

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
      setTemplates(prev => prev.map(t => t.id === id ? { ...t, is_active: !current } : t));
      showToast(current ? 'Template deactivated' : 'Template activated');
    } catch {
      showToast('Failed to update status', 'error');
    }
  };

  const handleDelete = async () => {
    if (!confirm) return;
    try {
      await api.delete(`/recruitment/email-templates/${confirm.id}`);
      setTemplates(prev => prev.filter(t => t.id !== confirm.id));
      showToast('Template deleted');
    } catch {
      showToast('Failed to delete template', 'error');
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
      const res = await api.post('/recruitment/email-templates', payload);
      setTemplates(prev => [...prev, res.data]);
      showToast('Template duplicated');
    } catch {
      showToast('Failed to duplicate template', 'error');
    }
  };

  const openCreate = () => { setEditing(null); setDrawerOpen(true); };
  const openEdit   = (tpl) => { setEditing(tpl); setDrawerOpen(true); };
  const closeDrawer = () => { setDrawerOpen(false); setEditing(null); };
  const onSaved    = () => { closeDrawer(); load(); };

  // Filter
  const filtered = templates.filter(t => {
    const q = search.toLowerCase();
    const matchSearch = !q
      || t.template_name.toLowerCase().includes(q)
      || t.subject.toLowerCase().includes(q)
      || (TYPE_CFG[t.template_type]?.label || '').toLowerCase().includes(q);
    const matchType = typeFilter === 'all' || t.template_type === typeFilter;
    return matchSearch && matchType;
  });

  const activeCount   = templates.filter(t => t.is_active).length;
  const inactiveCount = templates.length - activeCount;

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

      <div style={{ padding: '28px 32px', margin: '0 auto' }}>

        {/* ── Page header ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28, flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <button
                onClick={() => setPage('RecruitmentDashboard')}
                style={{ background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, color: '#374151', fontWeight: 500 }}
              >
                ← Back
              </button>
            </div>
            <h1 style={{ fontSize: 26, fontWeight: 800, color: '#111827', margin: 0 }}>Email Templates</h1>
            <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>
              Manage recruitment email templates · {activeCount} active{inactiveCount > 0 ? `, ${inactiveCount} inactive` : ''}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={load}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: '#f3f4f6', border: 'none', borderRadius: 9, cursor: 'pointer', color: '#374151', fontSize: 13 }}
            >
              <RefreshCw size={14} /> Refresh
            </button>
            <button
              onClick={openCreate}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 20px', background: '#4B2DCE', color: '#fff', border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 700, fontSize: 14 }}
            >
              <Plus size={15} /> New Template
            </button>
          </div>
        </div>

        {/* ── Stats row ── */}
        <div style={{ display: 'flex', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'Total', value: templates.length, color: '#4B2DCE', bg: '#F2EFFE' },
            { label: 'Active', value: activeCount, color: '#16a34a', bg: '#f0fdf4' },
            { label: 'Inactive', value: inactiveCount, color: '#9ca3af', bg: '#f9fafb' },
            ...ALL_TYPES.map(t => ({
              label: t.label, color: t.color, bg: t.bg,
              value: templates.filter(tp => tp.template_type === t.value).length,
            })),
          ].filter(s => s.value > 0).map((s, i) => (
            <div key={i} style={{
              padding: '8px 16px', borderRadius: 20, background: s.bg,
              fontSize: 12, fontWeight: 700, color: s.color,
              border: `1px solid ${s.bg === '#f9fafb' ? '#e5e7eb' : s.bg}`,
            }}>
              {s.value} {s.label}
            </div>
          ))}
        </div>

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
            {filtered.map(tpl => (
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

        {/* ── Variables reference ── */}
        {templates.length > 0 && (
          <div style={{
            marginTop: 40, background: '#fafafa', border: '1px solid #f0f0f8',
            borderRadius: 14, padding: '20px 24px',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 12 }}>
              📋 Available Template Variables
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {VARIABLES.map(v => (
                <div key={v.key} title={v.desc} style={{
                  display: 'flex', flexDirection: 'column', padding: '6px 12px',
                  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
                }}>
                  <code style={{ fontSize: 12, color: '#4B2DCE', fontWeight: 700 }}>{v.key}</code>
                  <span style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{v.desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </>
  );
}
