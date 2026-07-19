// frontend/src/features/crm/pages/CRMEmail.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import DOMPurify from 'dompurify';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { useToast } from '@/context/ToastContext';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import api from '@/services/api/client';

// ─── Helpers ───────────────────────────────────────────────────────────────────
const STAGE_COLORS = {
  Prospecting: '#6366f1', Qualification: '#3b82f6', Proposal: '#f59e0b',
  Negotiation: '#ef4444', Won: '#10b981', Lost: '#6b7280',
};
const CATEGORY_COLORS = {
  prospect: '#6B3FDB', 'follow-up': '#3b82f6', proposal: '#f59e0b', closing: '#10b981',
};
const PROVIDER_COLORS = { gmail: '#ea4335', outlook: '#0078d4', smtp: '#6b7280' };

function relativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

function getInitials(email) {
  if (!email) return '?';
  const local = email.split('@')[0];
  const parts = local.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function formatHour(h) {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function AvatarCircle({ email, size = 36 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: '#6B3FDB',
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.33, fontWeight: 700, flexShrink: 0, letterSpacing: 0.5,
    }}>
      {getInitials(email)}
    </div>
  );
}

function StageBadge({ stage }) {
  const color = STAGE_COLORS[stage] || '#6b7280';
  return (
    <span style={{
      background: color + '18', color, border: `1px solid ${color}40`,
      borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 600,
    }}>
      {stage}
    </span>
  );
}

function CategoryBadge({ category }) {
  const color = CATEGORY_COLORS[category] || '#6b7280';
  return (
    <span style={{
      background: color + '18', color, border: `1px solid ${color}40`,
      borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 600,
    }}>
      {category}
    </span>
  );
}

function LeadBadge({ name }) {
  return (
    <span style={{
      background: '#d1fae5', color: '#065f46', border: '1px solid #a7f3d0',
      borderRadius: 20, padding: '1px 8px', fontSize: 11, fontWeight: 600,
    }}>
      {name}
    </span>
  );
}

function ProviderBadge({ provider }) {
  const color = PROVIDER_COLORS[provider] || '#6b7280';
  return (
    <span style={{
      background: color + '18', color, border: `1px solid ${color}40`,
      borderRadius: 20, padding: '2px 8px', fontSize: 10, fontWeight: 700,
      textTransform: 'uppercase',
    }}>
      {provider}
    </span>
  );
}

function KpiCard({ label, value, suffix = '', color = '#6B3FDB' }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '20px 24px', flex: 1, minWidth: 0,
    }}>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}<span style={{ fontSize: 16, fontWeight: 500, color: '#999', marginLeft: 2 }}>{suffix}</span></div>
    </div>
  );
}

// ─── Email Setup Screen ────────────────────────────────────────────────────────
function EmailSetupScreen({ onConnectSMTP }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafafd' }}>
      <div style={{
        textAlign: 'center', background: '#fff', borderRadius: 20, padding: '48px 56px',
        boxShadow: '0 4px 24px rgba(0,0,0,0.08)', border: '1px solid #f0f0f4', maxWidth: 480,
      }}>
        <div style={{ fontSize: 64, marginBottom: 20 }}>✉️</div>
        <h2 style={{ margin: '0 0 10px', fontSize: 22, fontWeight: 800, color: '#1e1e2e' }}>
          Connect Your Email
        </h2>
        <p style={{ margin: '0 0 28px', fontSize: 14, color: '#888', lineHeight: 1.6 }}>
          Link your mailbox to send emails to leads and contacts, track opens and replies,
          and run automated email sequences — all from within the CRM.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
          <button
            onClick={onConnectSMTP}
            style={{
              padding: '13px 28px', background: '#6B3FDB', color: '#fff',
              border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 15,
            }}
          >
            Connect via SMTP / IMAP
          </button>
          <button
            disabled
            title="Gmail OAuth requires Google app verification — contact admin"
            style={{
              padding: '13px 28px', background: '#f5f5f5', color: '#aaa',
              border: '1px solid #e0e0e0', borderRadius: 10, cursor: 'not-allowed',
              fontWeight: 600, fontSize: 14,
            }}
          >
            Connect Gmail (coming soon)
          </button>
        </div>

        <div style={{ display: 'flex', gap: 20, justifyContent: 'center', fontSize: 12, color: '#bbb' }}>
          {['Track email opens', 'Log to CRM records', 'Run sequences'].map(f => (
            <span key={f} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ color: '#10b981', fontWeight: 700 }}>✓</span> {f}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Connect SMTP Modal ────────────────────────────────────────────────────────
function ConnectEmailModal({ onConnected, onClose }) {
  const [form, setForm] = useState({
    display_name: '', email_address: '',
    smtp_host: '', smtp_port: '587',
    smtp_username: '', smtp_password: '',
    imap_host: '', imap_port: '993',
  });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null); // { success, message }

  const set = (key, val) => {
    setResult(null);
    setForm(f => ({ ...f, [key]: val }));
  };

  // Auto-fill imap_host from smtp_host
  const handleSmtpHostChange = (val) => {
    setResult(null);
    setForm(f => ({
      ...f,
      smtp_host: val,
      imap_host: f.imap_host || val,
    }));
  };

  async function handleTest() {
    setTesting(true);
    setResult(null);
    try {
      const res = await api.post('/crm/email-accounts/connect-smtp', {
        ...form,
        smtp_port: parseInt(form.smtp_port) || 587,
        imap_port: parseInt(form.imap_port) || 993,
      });
      setResult({ success: true, message: 'Connected successfully!' });
      setTimeout(() => {
        onConnected(res.data?.data);
        onClose();
      }, 800);
    } catch (err) {
      setResult({
        success: false,
        message: err?.response?.data?.message || 'Connection failed — check your settings',
      });
    } finally {
      setTesting(false);
    }
  }

  const isFormReady = form.email_address && form.smtp_host && form.smtp_username && form.smtp_password;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, width: 560, maxHeight: '92vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: '22px 28px', borderBottom: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: '0 0 2px', fontSize: 18, fontWeight: 700, color: '#1e1e2e' }}>Connect Email Account</h3>
            <p style={{ margin: 0, fontSize: 12, color: '#888' }}>SMTP / IMAP — works with Gmail, Outlook, Zoho, or any provider</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#888', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Identity */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Display Name</label>
              <input value={form.display_name} onChange={e => set('display_name', e.target.value)}
                placeholder="e.g. Sales — John" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Email Address *</label>
              <input value={form.email_address} onChange={e => set('email_address', e.target.value)}
                placeholder="john@yourcompany.com" type="email" style={inputStyle} />
            </div>
          </div>

          {/* SMTP */}
          <div style={{ background: '#f5f3ff', borderRadius: 10, padding: '14px 16px', border: '1px solid #e9e4ff' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>SMTP (Outgoing)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: 10, marginBottom: 10 }}>
              <div>
                <label style={labelStyle}>SMTP Host *</label>
                <input value={form.smtp_host} onChange={e => handleSmtpHostChange(e.target.value)}
                  placeholder="smtp.gmail.com" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Port *</label>
                <select value={form.smtp_port} onChange={e => set('smtp_port', e.target.value)} style={inputStyle}>
                  <option value="587">587 (TLS)</option>
                  <option value="465">465 (SSL)</option>
                  <option value="25">25</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={labelStyle}>Username *</label>
                <input value={form.smtp_username} onChange={e => set('smtp_username', e.target.value)}
                  placeholder="john@yourcompany.com" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Password / App Password *</label>
                <input value={form.smtp_password} onChange={e => set('smtp_password', e.target.value)}
                  type="password" placeholder="••••••••••••" style={inputStyle} />
              </div>
            </div>
          </div>

          {/* IMAP */}
          <div style={{ background: '#f0f9ff', borderRadius: 10, padding: '14px 16px', border: '1px solid #bae6fd' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>IMAP (Incoming)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: 10 }}>
              <div>
                <label style={labelStyle}>IMAP Host</label>
                <input value={form.imap_host} onChange={e => set('imap_host', e.target.value)}
                  placeholder="imap.gmail.com" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Port</label>
                <select value={form.imap_port} onChange={e => set('imap_port', e.target.value)} style={inputStyle}>
                  <option value="993">993 (SSL)</option>
                  <option value="143">143 (TLS)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Provider hints */}
          <div style={{ fontSize: 12, color: '#888', background: '#fafafa', borderRadius: 8, padding: '10px 14px', border: '1px solid #f0f0f4' }}>
            <strong style={{ color: '#555' }}>Gmail:</strong> smtp.gmail.com:587 · Use an <em>App Password</em> (not your login password) if 2FA is on.
            {' '}<strong style={{ color: '#555' }}>Outlook:</strong> smtp.office365.com:587
          </div>

          {/* Result banner */}
          {result && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: result.success ? '#d1fae5' : '#fee2e2',
              color: result.success ? '#065f46' : '#991b1b',
              border: `1px solid ${result.success ? '#a7f3d0' : '#fecaca'}`,
            }}>
              {result.success ? '✓ ' : '✗ '}{result.message}
            </div>
          )}
        </div>

        <div style={{ padding: '14px 28px', borderTop: '1px solid #f0f0f4', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '9px 20px', background: '#f5f5f5', border: '1px solid #e0e0e0', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>Cancel</button>
          <button
            onClick={handleTest}
            disabled={testing || !isFormReady}
            style={{
              padding: '9px 24px', background: '#6B3FDB', color: '#fff', border: 'none',
              borderRadius: 8, cursor: isFormReady && !testing ? 'pointer' : 'not-allowed',
              fontWeight: 700, fontSize: 14,
              opacity: isFormReady && !testing ? 1 : 0.5,
            }}
          >
            {testing ? 'Testing Connection...' : 'Test & Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 5 };
const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fff' };

// ─── Template Modal ────────────────────────────────────────────────────────────
function TemplateModal({ template, onSave, onClose }) {
  const VARS = ['{{lead_name}}', '{{company_name}}', '{{sender_name}}', '{{demo_date}}', '{{quote_amount}}', '{{timeline}}', '{{deadline}}', '{{discounted_amount}}', '{{valid_until}}', '{{start_date}}', '{{account_manager}}'];
  const [form, setForm] = useState({
    name: template?.name || '', category: template?.category || 'prospect',
    stage_trigger: template?.stage_trigger || '', subject: template?.subject || '',
    body_html: template?.body_html || '', variables: template?.variables || [],
  });
  const bodyRef = useRef(null);

  function insertVar(v) {
    const el = bodyRef.current;
    if (!el) { setForm(f => ({ ...f, body_html: f.body_html + v })); return; }
    const start = el.selectionStart;
    const val = form.body_html;
    setForm(f => ({ ...f, body_html: val.slice(0, start) + v + val.slice(el.selectionEnd) }));
    setTimeout(() => { el.selectionStart = el.selectionEnd = start + v.length; el.focus(); }, 0);
  }

  function handleSave() {
    const vars = [...new Set((form.body_html + ' ' + form.subject).match(/\{\{[a-z_]+\}\}/g) || [])];
    onSave({ ...form, variables: vars });
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, width: 680, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: '24px 28px', borderBottom: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1e1e2e' }}>{template ? 'Edit Template' : 'New Template'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#888' }}>×</button>
        </div>
        <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <label style={labelStyle}>Template Name *</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Initial Prospect Outreach"
                style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={labelStyle}>Category</label>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }}>
                <option value="prospect">Prospect</option>
                <option value="follow-up">Follow-up</option>
                <option value="proposal">Proposal</option>
                <option value="closing">Closing</option>
              </select>
            </div>
          </div>
          <div>
            <label style={labelStyle}>Stage Trigger (optional)</label>
            <select value={form.stage_trigger} onChange={e => setForm(f => ({ ...f, stage_trigger: e.target.value }))}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }}>
              <option value="">— None —</option>
              {['Prospecting','Qualification','Proposal','Negotiation','Won'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Subject *</label>
            <input value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
              placeholder="e.g. Streamline Your Business with Pulse ERP"
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
          </div>
          <div>
            <label style={labelStyle}>Insert Variable</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {VARS.map(v => (
                <button key={v} onClick={() => insertVar(v)} style={{ background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'monospace' }}>
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Body (HTML supported) *</label>
            <textarea ref={bodyRef} value={form.body_html} onChange={e => setForm(f => ({ ...f, body_html: e.target.value }))}
              placeholder="<p>Dear {{lead_name}},</p>"
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, outline: 'none', minHeight: 160, resize: 'vertical', fontFamily: 'monospace', boxSizing: 'border-box' }} />
          </div>
        </div>
        <div style={{ padding: '16px 28px', borderTop: '1px solid #f0f0f4', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '8px 20px', background: '#f5f5f5', border: '1px solid #e0e0e0', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>Cancel</button>
          <button onClick={handleSave} style={{ padding: '8px 24px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>Save Template</button>
        </div>
      </div>
    </div>
  );
}

// ─── Sequence Builder Drawer ───────────────────────────────────────────────────
function SequenceDrawer({ templates, onSave, onClose, sequence }) {
  const [form, setForm] = useState(sequence
    ? { name: sequence.name || '', trigger_stage: sequence.trigger_stage || 'Prospecting', steps: sequence.steps?.length ? sequence.steps : [{ day_offset: 0, template_id: '' }] }
    : { name: '', trigger_stage: 'Prospecting', steps: [{ day_offset: 0, template_id: '' }] });

  function addStep() { setForm(f => ({ ...f, steps: [...f.steps, { day_offset: f.steps.length * 2, template_id: '' }] })); }
  function removeStep(idx) { setForm(f => ({ ...f, steps: f.steps.filter((_, i) => i !== idx) })); }
  function updateStep(idx, field, value) {
    setForm(f => ({ ...f, steps: f.steps.map((s, i) => i === idx ? { ...s, [field]: value } : s) }));
  }

  function handleSave() {
    if (!form.name.trim()) return;
    onSave({ ...form, steps: form.steps.map(s => ({ ...s, day_offset: parseInt(s.day_offset) || 0 })) });
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ width: 500, background: '#fff', height: '100%', overflow: 'auto', boxShadow: '-8px 0 30px rgba(0,0,0,0.15)' }}>
        <div style={{ padding: '24px 24px 16px', borderBottom: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1e1e2e' }}>{sequence ? 'Edit Sequence' : 'Create Sequence'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#888' }}>×</button>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>Sequence Name *</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. New Lead Nurture"
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
          </div>
          <div>
            <label style={labelStyle}>Trigger Stage</label>
            <select value={form.trigger_stage} onChange={e => setForm(f => ({ ...f, trigger_stage: e.target.value }))}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }}>
              {['Prospecting','Qualification','Proposal','Negotiation','Won'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <label style={labelStyle}>Steps</label>
              <button onClick={addStep} style={{ background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>+ Add Step</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {form.steps.map((step, idx) => (
                <div key={idx} style={{ background: '#f5f3ff', borderRadius: 10, padding: '14px 16px', border: '1px solid #e9e4ff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#6B3FDB' }}>Step {idx + 1}</span>
                    {form.steps.length > 1 && (
                      <button onClick={() => removeStep(idx)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Remove</button>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 10 }}>
                    <div>
                      <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 4 }}>Day Offset</label>
                      <input type="number" min={0} value={step.day_offset}
                        onChange={e => updateStep(idx, 'day_offset', e.target.value)}
                        style={{ width: '100%', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 4 }}>Template</label>
                      <select value={step.template_id} onChange={e => updateStep(idx, 'template_id', e.target.value)}
                        style={{ width: '100%', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}>
                        <option value="">— Select Template —</option>
                        {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid #f0f0f4', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '8px 20px', background: '#f5f5f5', border: '1px solid #e0e0e0', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>Cancel</button>
          <button onClick={handleSave} style={{ padding: '8px 24px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>Save Sequence</button>
        </div>
      </div>
    </div>
  );
}

// ─── Enroll Modal ──────────────────────────────────────────────────────────────
function EnrollModal({ sequence, onEnroll, onClose }) {
  const [leadId, setLeadId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleEnroll() {
    if (!leadId) { setError('Please enter a Lead ID'); return; }
    setLoading(true); setError('');
    try {
      await api.post(`/crm/email-sequences/${sequence.id}/enroll`, { lead_id: parseInt(leadId) });
      onEnroll();
      onClose();
    } catch (e) {
      setError(e?.response?.data?.message || 'Failed to enroll lead');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, width: 400, boxShadow: '0 12px 40px rgba(0,0,0,0.18)' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Enroll Lead in Sequence</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#888' }}>×</button>
        </div>
        <div style={{ padding: '20px 24px' }}>
          <p style={{ margin: '0 0 16px', color: '#555', fontSize: 13 }}>
            Enrolling in: <strong>{sequence.name}</strong>
          </p>
          <label style={labelStyle}>Lead ID *</label>
          <input type="number" value={leadId} onChange={e => setLeadId(e.target.value)}
            placeholder="e.g. 42"
            style={{ width: '100%', padding: '9px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
          {error && <p style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>{error}</p>}
        </div>
        <div style={{ padding: '12px 24px', borderTop: '1px solid #f0f0f4', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '8px 18px', background: '#f5f5f5', border: '1px solid #e0e0e0', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={handleEnroll} disabled={loading}
            style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Enrolling...' : 'Enroll'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Compose Drawer ────────────────────────────────────────────────────────────
function ComposeDrawer({ accounts, templates, onSend, onClose, initialData }) {
  const [form, setForm] = useState({
    to: initialData?.to || '', cc: '', subject: initialData?.subject || '',
    body: initialData?.body || '', account_id: accounts[0]?.id || '',
    template_id: '', schedule: false, schedule_at: '',
  });
  const [showCc, setShowCc] = useState(false);
  const [sending, setSending] = useState(false);

  function applyTemplate(tid) {
    const tpl = templates.find(t => t.id === parseInt(tid));
    if (!tpl) return;
    setForm(f => ({ ...f, template_id: tid, subject: tpl.subject, body: tpl.body_html }));
  }

  async function handleSend() {
    if (!form.to || !form.subject) return;
    setSending(true);
    try {
      await api.post('/crm/emails/send', {
        account_id: form.account_id,
        to_emails: form.to.split(',').map(s => s.trim()).filter(Boolean),
        cc_emails: form.cc ? form.cc.split(',').map(s => s.trim()).filter(Boolean) : [],
        subject: form.subject,
        body_html: form.body,
        body_text: form.body.replace(/<[^>]+>/g, ''),
      });
      onSend();
      onClose();
    } catch (_) {
      setSending(false);
    }
  }

  return (
    <div style={{ position: 'fixed', bottom: 0, right: 24, width: 560, background: '#fff', borderRadius: '12px 12px 0 0', boxShadow: '0 -4px 30px rgba(0,0,0,0.18)', zIndex: 900, border: '1px solid #e9e4ff', borderBottom: 'none' }}>
      <div style={{ background: '#6B3FDB', borderRadius: '12px 12px 0 0', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>New Email</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
      </div>
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#888', width: 28, textAlign: 'right', flexShrink: 0 }}>From</span>
          <select value={form.account_id} onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))}
            style={{ flex: 1, padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, outline: 'none' }}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.email_address}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#888', width: 28, textAlign: 'right', flexShrink: 0 }}>To</span>
          <input value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value }))}
            placeholder="recipient@example.com, another@example.com"
            style={{ flex: 1, padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, outline: 'none' }} />
          <button onClick={() => setShowCc(v => !v)} style={{ fontSize: 11, color: '#6B3FDB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
            {showCc ? 'Hide CC' : 'CC'}
          </button>
        </div>
        {showCc && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#888', width: 28, textAlign: 'right', flexShrink: 0 }}>CC</span>
            <input value={form.cc} onChange={e => setForm(f => ({ ...f, cc: e.target.value }))}
              placeholder="cc@example.com"
              style={{ flex: 1, padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, outline: 'none' }} />
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#888', width: 28, textAlign: 'right', flexShrink: 0 }}>Subj</span>
          <input value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
            placeholder="Email subject"
            style={{ flex: 1, padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, outline: 'none' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#888', width: 28, textAlign: 'right', flexShrink: 0 }}>Tpl</span>
          <select value={form.template_id} onChange={e => applyTemplate(e.target.value)}
            style={{ flex: 1, padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, outline: 'none' }}>
            <option value="">— Use a template —</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
          placeholder="Compose your email here..."
          style={{ width: '100%', padding: '10px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, outline: 'none', minHeight: 200, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, color: '#555' }}>
            <input type="checkbox" checked={form.schedule} onChange={e => setForm(f => ({ ...f, schedule: e.target.checked }))} />
            Schedule send
          </label>
          {form.schedule && (
            <input type="datetime-local" value={form.schedule_at} onChange={e => setForm(f => ({ ...f, schedule_at: e.target.value }))}
              style={{ padding: '5px 10px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 12, outline: 'none' }} />
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4 }}>
          <button onClick={handleSend} disabled={sending || !form.to || !form.subject}
            style={{ padding: '9px 28px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 14, opacity: (sending || !form.to || !form.subject) ? 0.6 : 1 }}>
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Email Row ─────────────────────────────────────────────────────────────────
function EmailRow({ email, selected, onClick }) {
  const isUnread = email.direction === 'inbound' && !email.is_read && !email.opened_at;
  const displayAddr = email.direction === 'inbound'
    ? email.from_email
    : (Array.isArray(email.to_emails) ? email.to_emails[0] : email.to_emails);
  const preview = (email.body_text || email.body_html?.replace(/<[^>]+>/g, '') || '').slice(0, 80);

  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px',
      borderBottom: '1px solid #f5f5f8', cursor: 'pointer',
      background: selected ? '#f5f3ff' : (isUnread ? '#fefeff' : '#fff'),
      borderLeft: selected ? '3px solid #6B3FDB' : '3px solid transparent',
    }}>
      <AvatarCircle email={displayAddr} size={38} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontSize: 13, fontWeight: isUnread ? 700 : 500, color: '#1e1e2e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
            {displayAddr}
          </span>
          <span style={{ fontSize: 11, color: '#aaa', flexShrink: 0 }}>{relativeTime(email.sent_at || email.received_at)}</span>
        </div>
        <div style={{ fontSize: 13, fontWeight: isUnread ? 600 : 400, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>
          {email.subject}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {email.lead_name && <LeadBadge name={email.lead_name} />}
          <span style={{ fontSize: 12, color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Email Detail ──────────────────────────────────────────────────────────────
function EmailDetail({ email, onReply, onForward }) {
  if (!email) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#fafafd', gap: 12 }}>
        <div style={{ fontSize: 56 }}>✉️</div>
        <div style={{ fontSize: 16, color: '#bbb', fontWeight: 500 }}>Select an email to read</div>
        <div style={{ fontSize: 13, color: '#ccc' }}>Your conversations will appear here</div>
      </div>
    );
  }

  const toList = Array.isArray(email.to_emails) ? email.to_emails.join(', ') : email.to_emails;
  const ccList = Array.isArray(email.cc_emails) ? email.cc_emails.join(', ') : email.cc_emails;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
      <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f4' }}>
        <h2 style={{ margin: '0 0 14px', fontSize: 18, fontWeight: 700, color: '#1e1e2e', lineHeight: 1.4 }}>{email.subject}</h2>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
          <AvatarCircle email={email.from_email} size={40} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#1e1e2e' }}>{email.from_email}</div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
              To: {toList}
              {ccList && ccList.length > 0 && <span style={{ marginLeft: 8 }}>CC: {ccList}</span>}
            </div>
            <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
              {(email.sent_at || email.received_at)
                ? new Date(email.sent_at || email.received_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
                : ''}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {email.opened_at && <span style={{ fontSize: 11, background: '#d1fae5', color: '#065f46', padding: '2px 8px', borderRadius: 12, fontWeight: 600 }}>Opened</span>}
            {email.clicked_at && <span style={{ fontSize: 11, background: '#dbeafe', color: '#1e40af', padding: '2px 8px', borderRadius: 12, fontWeight: 600 }}>Clicked</span>}
          </div>
        </div>
        {(email.lead_name || email.lead_stage) && (
          <div style={{ background: '#f5f3ff', borderRadius: 10, padding: '10px 14px', border: '1px solid #e9e4ff', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div>
              <span style={{ fontSize: 11, color: '#999', display: 'block', marginBottom: 2 }}>Associated Lead</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#6B3FDB' }}>{email.lead_name || `Lead #${email.lead_id}`}</span>
                {email.lead_stage && <StageBadge stage={email.lead_stage} />}
              </div>
            </div>
          </div>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
        <div
          style={{ fontSize: 14, lineHeight: 1.7, color: '#333' }}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(email.body_html || `<p>${email.body_text || ''}</p>`) }}
        />
      </div>
      <div style={{ padding: '14px 24px', borderTop: '1px solid #f0f0f4', display: 'flex', gap: 10 }}>
        <button onClick={() => onReply(email)} style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Reply</button>
        <button onClick={() => onForward(email)} style={{ padding: '8px 20px', background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Forward</button>
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────
export default function CRMEmail() {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('inbox');
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [showCompose, setShowCompose] = useState(false);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [forwardEmail, setForwardEmail] = useState(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [showSequenceDrawer, setShowSequenceDrawer] = useState(false);
  const [editingSequence, setEditingSequence] = useState(null);
  const [enrollTarget, setEnrollTarget] = useState(null);

  const [emails, setEmails] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [sequences, setSequences] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingDisconnect,      setPendingDisconnect]      = useState(null);
  const [pendingDeleteSequence,  setPendingDeleteSequence]  = useState(null);

  const loadAll = useCallback(async () => {
    const [emailsRes, templatesRes, sequencesRes, analyticsRes, accountsRes] = await Promise.allSettled([
      api.get('/crm/emails'),
      api.get('/crm/email-templates'),
      api.get('/crm/email-sequences'),
      api.get('/crm/email-analytics'),
      api.get('/crm/email-accounts'),
    ]);
    setEmails(emailsRes.status === 'fulfilled' ? (emailsRes.value?.data?.data || []) : []);
    setTemplates(templatesRes.status === 'fulfilled' ? (templatesRes.value?.data?.data || []) : []);
    setSequences(sequencesRes.status === 'fulfilled' ? (sequencesRes.value?.data?.data || []) : []);
    setAnalytics(analyticsRes.status === 'fulfilled' ? (analyticsRes.value?.data?.data || null) : null);
    setAccounts(accountsRes.status === 'fulfilled' ? (accountsRes.value?.data?.data || []) : []);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const inboxEmails = emails.filter(e => e.direction === 'inbound');
  const sentEmails = emails.filter(e => e.direction === 'outbound');
  const draftEmails = emails.filter(e => e.is_draft);

  const folderEmails = activeTab === 'inbox' ? inboxEmails
    : activeTab === 'sent' ? sentEmails
    : activeTab === 'drafts' ? draftEmails
    : [];

  const unreadCount = inboxEmails.filter(e => !e.is_read && !e.opened_at).length;

  async function handleSync(accountId) {
    try {
      await api.post(`/crm/email-accounts/${accountId}/sync`);
      await loadAll();
    } catch (err) { toast.error(err?.response?.data?.error || 'Email sync failed'); }
  }

  async function handleDisconnect() {
    if (!pendingDisconnect) return;
    const accountId = pendingDisconnect;
    setPendingDisconnect(null);
    try {
      await api.delete(`/crm/email-accounts/${accountId}`);
      setAccounts(prev => prev.filter(a => a.id !== accountId));
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to disconnect account'); }
  }

  function handleAccountConnected(newAccount) {
    if (newAccount) setAccounts(prev => [...prev, newAccount]);
    loadAll();
  }

  async function handleSaveTemplate(formData) {
    try {
      if (editingTemplate?.id) {
        await api.put(`/crm/email-templates/${editingTemplate.id}`, formData);
      } else {
        await api.post('/crm/email-templates', formData);
      }
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to save template'); return; }
    setShowTemplateModal(false);
    setEditingTemplate(null);
    const res = await api.get('/crm/email-templates').catch(() => null);
    setTemplates(res?.data?.data || []);
  }

  async function handleDeleteTemplate(id) {
    try {
      await api.delete(`/crm/email-templates/${id}`);
      setTemplates(prev => prev.filter(t => t.id !== id));
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to delete template'); }
  }

  function handleDuplicateTemplate(tpl) {
    setEditingTemplate({ ...tpl, id: null, name: `${tpl.name} (Copy)` });
    setShowTemplateModal(true);
  }

  async function handleSaveSequence(formData) {
    try {
      if (editingSequence?.id) {
        await api.put(`/crm/email-sequences/${editingSequence.id}`, formData);
      } else {
        await api.post('/crm/email-sequences', formData);
      }
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to save sequence'); return; }
    setShowSequenceDrawer(false);
    setEditingSequence(null);
    const res = await api.get('/crm/email-sequences').catch(() => null);
    setSequences(res?.data?.data || []);
  }

  async function handleDeleteSequence() {
    if (!pendingDeleteSequence) return;
    const id = pendingDeleteSequence;
    setPendingDeleteSequence(null);
    try {
      await api.delete(`/crm/email-sequences/${id}`);
      setSequences(prev => prev.filter(s => s.id !== id));
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to delete sequence'); }
  }

  const SIDEBAR_ITEMS = [
    { key: 'inbox',     label: 'Inbox',     icon: '📥', badge: unreadCount > 0 ? unreadCount : null },
    { key: 'sent',      label: 'Sent',      icon: '📤', badge: null },
    { key: 'drafts',    label: 'Drafts',    icon: '📝', badge: draftEmails.length > 0 ? draftEmails.length : null },
    { key: 'templates', label: 'Templates', icon: '📋', badge: null },
    { key: 'sequences', label: 'Sequences', icon: '🔁', badge: null },
    { key: 'analytics', label: 'Analytics', icon: '📊', badge: null },
  ];

  const isEmailView = ['inbox', 'sent', 'drafts'].includes(activeTab);
  const hasNoAccounts = accounts.length === 0;

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#f5f3ff', fontFamily: "'Inter', -apple-system, sans-serif" }}>
      <ConfirmDialog
        open={!!pendingDisconnect}
        title="Disconnect Email Account"
        message="Disconnect this email account?"
        confirmLabel="Disconnect"
        variant="warning"
        onConfirm={handleDisconnect}
        onCancel={() => setPendingDisconnect(null)}
      />
      <ConfirmDialog
        open={!!pendingDeleteSequence}
        title="Delete Sequence"
        message="Delete this sequence?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeleteSequence}
        onCancel={() => setPendingDeleteSequence(null)}
      />

      {/* ── Left Sidebar ── */}
      <div style={{ width: 220, background: '#fff', borderRight: '1px solid #e9e4ff', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>

        {/* Header + Compose */}
        <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid #f0f0f4' }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#6B3FDB', marginBottom: 12 }}>CRM Email</div>
          <div title={hasNoAccounts ? 'Connect an email account first' : ''}>
            <button
              onClick={() => hasNoAccounts ? setShowConnectModal(true) : setShowCompose(true)}
              disabled={false}
              style={{
                width: '100%', padding: '9px 0', background: hasNoAccounts ? '#f5f3ff' : '#6B3FDB',
                color: hasNoAccounts ? '#a78bfa' : '#fff',
                border: hasNoAccounts ? '1px dashed #c4b5fd' : 'none',
                borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
              }}
            >
              {hasNoAccounts ? '+ Connect Account' : '+ Compose'}
            </button>
          </div>
        </div>

        {/* Nav items */}
        <div style={{ padding: '10px 10px 4px', flex: 1, overflowY: 'auto' }}>
          {SIDEBAR_ITEMS.map(item => (
            <div
              key={item.key}
              onClick={() => setActiveTab(item.key)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 2,
                background: activeTab === item.key ? '#f5f3ff' : 'transparent',
                color: activeTab === item.key ? '#6B3FDB' : '#444',
                fontWeight: activeTab === item.key ? 600 : 400, fontSize: 13,
              }}
            >
              <span>{item.icon} {item.label}</span>
              {item.badge != null && (
                <span style={{ background: '#6B3FDB', color: '#fff', borderRadius: 20, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>
                  {item.badge}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Connected Accounts */}
        <div style={{ borderTop: '1px solid #f0f0f4', padding: '12px 10px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#bbb', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8, paddingLeft: 4 }}>
            Connected Accounts
          </div>

          {loading ? (
            <div style={{ fontSize: 12, color: '#ccc', padding: '6px 4px' }}>Loading...</div>
          ) : accounts.length === 0 ? (
            <div style={{ fontSize: 12, color: '#bbb', padding: '6px 4px', fontStyle: 'italic' }}>No accounts connected</div>
          ) : (
            accounts.map(acc => {
              const syncColor = acc.sync_status === 'synced' ? '#10b981' : acc.sync_status === 'error' ? '#ef4444' : '#f59e0b';
              return (
                <div key={acc.id} style={{ padding: '8px 8px', borderRadius: 8, marginBottom: 4, background: '#fafafd', border: '1px solid #f0f0f4' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: syncColor, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#1e1e2e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {acc.display_name || acc.email_address}
                    </span>
                    <ProviderBadge provider={acc.provider} />
                  </div>
                  <div style={{ fontSize: 11, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 6 }}>
                    {acc.email_address}
                  </div>
                  <div style={{ display: 'flex', gap: 5 }}>
                    <button onClick={() => handleSync(acc.id)}
                      style={{ flex: 1, padding: '4px 0', background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 5, cursor: 'pointer', fontSize: 10, fontWeight: 600 }}>
                      Sync
                    </button>
                    <button onClick={() => setPendingDisconnect(acc.id)}
                      style={{ flex: 1, padding: '4px 0', background: '#fff5f5', color: '#ef4444', border: '1px solid #fecaca', borderRadius: 5, cursor: 'pointer', fontSize: 10, fontWeight: 600 }}>
                      Disconnect
                    </button>
                  </div>
                  {acc.last_sync_at && (
                    <div style={{ fontSize: 10, color: '#ccc', marginTop: 4, textAlign: 'center' }}>
                      Synced {relativeTime(acc.last_sync_at)}
                    </div>
                  )}
                </div>
              );
            })
          )}

          <button
            onClick={() => setShowConnectModal(true)}
            style={{ width: '100%', padding: '7px 0', background: 'transparent', color: '#6B3FDB', border: '1px dashed #c4b5fd', borderRadius: 7, cursor: 'pointer', fontSize: 11, fontWeight: 600, marginTop: 4 }}
          >
            + Connect Account
          </button>
        </div>
      </div>

      {/* ── Main area ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Email inbox / sent / drafts */}
        {isEmailView && (
          <>
            {hasNoAccounts && !loading ? (
              <EmailSetupScreen onConnectSMTP={() => setShowConnectModal(true)} />
            ) : (
              <>
                {/* Email list */}
                <div style={{ width: 360, borderRight: '1px solid #e9e4ff', background: '#fff', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                  <div style={{ padding: '14px 16px', borderBottom: '1px solid #f0f0f4' }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#1e1e2e' }}>
                      {activeTab === 'inbox' ? 'Inbox' : activeTab === 'sent' ? 'Sent' : 'Drafts'} ({folderEmails.length})
                    </span>
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto' }}>
                    {loading ? (
                      <div style={{ padding: 24, textAlign: 'center', color: '#aaa' }}>Loading...</div>
                    ) : folderEmails.length === 0 ? (
                      <div style={{ padding: 40, textAlign: 'center', color: '#ccc', lineHeight: 1.8 }}>
                        <div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>
                        <div style={{ fontWeight: 500 }}>No emails yet</div>
                        <div style={{ fontSize: 12 }}>Emails you send or receive will appear here</div>
                      </div>
                    ) : (
                      folderEmails.map(email => (
                        <EmailRow key={email.id} email={email}
                          selected={selectedEmail?.id === email.id}
                          onClick={() => setSelectedEmail(email)} />
                      ))
                    )}
                  </div>
                </div>

                {/* Email detail */}
                <EmailDetail
                  email={selectedEmail}
                  onReply={() => { setForwardEmail(null); setShowCompose(true); }}
                  onForward={email => { setForwardEmail(email); setShowCompose(true); }}
                />
              </>
            )}
          </>
        )}

        {/* Templates Tab */}
        {activeTab === 'templates' && (
          <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div>
                <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 800, color: '#1e1e2e' }}>Email Templates</h2>
                <p style={{ margin: 0, fontSize: 13, color: '#888' }}>{templates.length} templates available</p>
              </div>
              <button onClick={() => { setEditingTemplate(null); setShowTemplateModal(true); }}
                style={{ padding: '9px 22px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                + New Template
              </button>
            </div>
            {templates.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 0', color: '#bbb' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>No templates yet</div>
                <div style={{ fontSize: 13 }}>Create reusable email templates for your sales team</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                {templates.map(tpl => (
                  <div key={tpl.id} style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#1e1e2e', lineHeight: 1.3 }}>{tpl.name}</div>
                      <CategoryBadge category={tpl.category} />
                    </div>
                    <div style={{ fontSize: 12, color: '#666', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.subject}</div>
                    {tpl.variables?.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {tpl.variables.slice(0, 4).map(v => (
                          <span key={v} style={{ background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 4, padding: '1px 7px', fontSize: 10, fontFamily: 'monospace' }}>
                            {`{{${v}}}`}
                          </span>
                        ))}
                        {tpl.variables.length > 4 && <span style={{ fontSize: 10, color: '#aaa' }}>+{tpl.variables.length - 4}</span>}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 4, borderTop: '1px solid #f5f5f8', paddingTop: 10 }}>
                      <button onClick={() => { setEditingTemplate(tpl); setShowTemplateModal(true); }}
                        style={{ flex: 1, padding: '6px 0', background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                        Edit
                      </button>
                      <button onClick={() => handleDuplicateTemplate(tpl)}
                        style={{ flex: 1, padding: '6px 0', background: '#f5f5f5', color: '#555', border: '1px solid #e8e8e8', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                        Duplicate
                      </button>
                      <button onClick={() => handleDeleteTemplate(tpl.id)}
                        style={{ flex: 1, padding: '6px 0', background: '#fff5f5', color: '#ef4444', border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Sequences Tab */}
        {activeTab === 'sequences' && (
          <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div>
                <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 800, color: '#1e1e2e' }}>Email Sequences</h2>
                <p style={{ margin: 0, fontSize: 13, color: '#888' }}>Automated multi-step email campaigns</p>
              </div>
              <button onClick={() => setShowSequenceDrawer(true)}
                style={{ padding: '9px 22px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                + Create Sequence
              </button>
            </div>
            {sequences.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 0', color: '#bbb' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🔁</div>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>No sequences yet</div>
                <div style={{ fontSize: 13 }}>Build automated email drip campaigns for your leads</div>
              </div>
            ) : (
              <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f5f3ff', borderBottom: '1px solid #e9e4ff' }}>
                      {['Sequence Name', 'Trigger Stage', 'Steps', 'Enrolled', 'Active', 'Actions'].map(h => (
                        <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sequences.map((seq, idx) => (
                      <tr key={seq.id} style={{ borderBottom: idx < sequences.length - 1 ? '1px solid #f5f5f8' : 'none' }}>
                        <td style={{ padding: '14px 16px', fontSize: 14, fontWeight: 600, color: '#1e1e2e' }}>{seq.name}</td>
                        <td style={{ padding: '14px 16px' }}>{seq.trigger_stage ? <StageBadge stage={seq.trigger_stage} /> : <span style={{ color: '#ccc' }}>—</span>}</td>
                        <td style={{ padding: '14px 16px', fontSize: 14, color: '#444' }}>
                          <span style={{ background: '#f5f3ff', color: '#6B3FDB', padding: '2px 10px', borderRadius: 12, fontWeight: 600, fontSize: 12 }}>
                            {seq.step_count || (seq.steps?.length || 0)} steps
                          </span>
                        </td>
                        <td style={{ padding: '14px 16px', fontSize: 14, color: '#444' }}>{seq.enrolled_count || 0} leads</td>
                        <td style={{ padding: '14px 16px' }}>
                          <div style={{ width: 36, height: 20, borderRadius: 10, background: seq.is_active ? '#6B3FDB' : '#d1d5db', position: 'relative' }}>
                            <div style={{ width: 16, height: 16, background: '#fff', borderRadius: '50%', position: 'absolute', top: 2, left: seq.is_active ? 18 : 2, transition: 'left 0.2s' }} />
                          </div>
                        </td>
                        <td style={{ padding: '14px 16px' }}>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => setEnrollTarget(seq)} style={{ padding: '5px 12px', background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Enroll Lead</button>
                            <button onClick={() => { setEditingSequence(seq); setShowSequenceDrawer(true); }} style={{ padding: '5px 12px', background: '#f5f5f5', color: '#555', border: '1px solid #e8e8e8', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Edit</button>
                            <button onClick={() => setPendingDeleteSequence(seq.id)} style={{ padding: '5px 12px', background: '#fff5f5', color: '#ef4444', border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Analytics Tab */}
        {activeTab === 'analytics' && (
          <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 800, color: '#1e1e2e' }}>Email Analytics</h2>
              <p style={{ margin: 0, fontSize: 13, color: '#888' }}>Performance metrics for your email campaigns</p>
            </div>
            {!analytics || analytics.total_sent === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 0', color: '#bbb' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>No data yet</div>
                <div style={{ fontSize: 13 }}>Analytics will appear once you start sending emails</div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
                  <KpiCard label="Total Sent" value={analytics.total_sent.toLocaleString('en-IN')} color="#6B3FDB" />
                  <KpiCard label="Open Rate" value={analytics.open_rate} suffix="%" color="#10b981" />
                  <KpiCard label="Click Rate" value={analytics.click_rate} suffix="%" color="#3b82f6" />
                  <KpiCard label="Reply Rate" value={analytics.reply_rate} suffix="%" color="#f59e0b" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '20px 20px 12px' }}>
                    <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#1e1e2e' }}>Best Send Times</h3>
                    <ResponsiveContainer width="100%" height={320}>
                      <BarChart data={analytics.best_send_times} layout="vertical" margin={{ top: 0, right: 20, left: 40, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f4" />
                        <XAxis type="number" domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 11, fill: '#aaa' }} />
                        <YAxis type="category" dataKey="hour" tickFormatter={formatHour} tick={{ fontSize: 10, fill: '#888' }} width={38} />
                        <Tooltip formatter={(val) => [`${val}%`, 'Open Rate']} labelFormatter={formatHour} contentStyle={{ borderRadius: 8, border: '1px solid #e9e4ff', fontSize: 12 }} />
                        <Bar dataKey="open_rate" radius={[0, 4, 4, 0]} maxBarSize={12}>
                          {analytics.best_send_times.map((entry, idx) => (
                            <Cell key={idx} fill={entry.open_rate >= 60 ? '#6B3FDB' : entry.open_rate >= 40 ? '#a78bfa' : '#ddd6fe'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '20px 20px 12px' }}>
                    <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#1e1e2e' }}>Top Templates</h3>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #f0f0f4' }}>
                          {['Template', 'Opens', 'Clicks', 'Open Rate'].map(h => (
                            <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Template' ? 'left' : 'center', fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.top_templates.map((tpl, idx) => (
                          <tr key={idx} style={{ borderBottom: idx < analytics.top_templates.length - 1 ? '1px solid #f9f9fb' : 'none' }}>
                            <td style={{ padding: '11px 10px', fontSize: 13, fontWeight: 500, color: '#1e1e2e', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.name}</td>
                            <td style={{ padding: '11px 10px', fontSize: 13, color: '#444', textAlign: 'center' }}>{tpl.opens}</td>
                            <td style={{ padding: '11px 10px', fontSize: 13, color: '#444', textAlign: 'center' }}>{tpl.clicks}</td>
                            <td style={{ padding: '11px 10px', textAlign: 'center' }}>
                              <span style={{
                                background: tpl.open_rate >= 60 ? '#d1fae5' : tpl.open_rate >= 40 ? '#fef9c3' : '#fee2e2',
                                color: tpl.open_rate >= 60 ? '#065f46' : tpl.open_rate >= 40 ? '#854d0e' : '#991b1b',
                                padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700,
                              }}>
                                {tpl.open_rate}%
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Modals and Drawers ── */}
      {showConnectModal && (
        <ConnectEmailModal
          onConnected={handleAccountConnected}
          onClose={() => setShowConnectModal(false)}
        />
      )}

      {showTemplateModal && (
        <TemplateModal
          template={editingTemplate}
          onSave={handleSaveTemplate}
          onClose={() => { setShowTemplateModal(false); setEditingTemplate(null); }}
        />
      )}

      {showSequenceDrawer && (
        <SequenceDrawer
          templates={templates}
          sequence={editingSequence}
          onSave={handleSaveSequence}
          onClose={() => { setShowSequenceDrawer(false); setEditingSequence(null); }}
        />
      )}

      {enrollTarget && (
        <EnrollModal
          sequence={enrollTarget}
          onEnroll={() => loadAll()}
          onClose={() => setEnrollTarget(null)}
        />
      )}

      {showCompose && !hasNoAccounts && (
        <ComposeDrawer
          accounts={accounts}
          templates={templates}
          initialData={forwardEmail ? {
            subject: `Fwd: ${forwardEmail.subject || ''}`,
            body: `\n\n--- Forwarded message ---\nFrom: ${forwardEmail.from_email || ''}\nSubject: ${forwardEmail.subject || ''}\n\n${forwardEmail.body_text || ''}`,
          } : null}
          onSend={() => { loadAll(); setForwardEmail(null); }}
          onClose={() => { setShowCompose(false); setForwardEmail(null); }}
        />
      )}
    </div>
  );
}
