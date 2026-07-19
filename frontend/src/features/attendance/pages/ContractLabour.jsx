import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  HardHat, Plus, Edit2, Trash2, RefreshCw, Shield, Clock, AlertCircle,
  AlertTriangle, Check, X, FileText, Download, Search, Phone,
  CalendarCheck, CheckSquare, XSquare, MinusSquare, Users,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };

// ── Helpers ───────────────────────────────────────────────────────────────────
function daysTo(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - new Date()) / 86400000);
}

function computeStatus(w) {
  if (!w.is_active) return 'inactive';
  const d = daysTo(w.contract_expiry);
  if (d === null) return 'active';
  if (d < 0) return 'expired';
  if (d <= 30) return 'expiring';
  return 'active';
}

function fmt(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ── Status Badge ──────────────────────────────────────────────────────────────
const STATUS_MAP = {
  active:   { bg: '#ecfdf5', color: '#15803d', label: 'Active' },
  expiring: { bg: '#fffbeb', color: '#b45309', label: 'Expiring' },
  expired:  { bg: '#fef2f2', color: '#dc2626', label: 'Expired' },
  inactive: { bg: '#f9fafb', color: '#6b7280', label: 'Inactive' },
};

function StatusBadge({ status }) {
  const s = STATUS_MAP[status] || STATUS_MAP.inactive;
  return (
    <span style={{ background: s.bg, color: s.color, borderRadius: 10, padding: '2px 10px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  );
}

// ── Shared input style ────────────────────────────────────────────────────────
const inp = (extra = {}) => ({
  border: '1px solid #e9e4ff', borderRadius: 8, padding: '8px 12px',
  fontSize: 13, width: '100%', outline: 'none', boxSizing: 'border-box',
  fontFamily: 'Inter, sans-serif', ...extra,
});

function SectionLabel({ text }) {
  return (
    <div style={{ gridColumn: '1/-1', borderTop: '1px solid #f0f0f4', paddingTop: 14, marginTop: 6 }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: P, textTransform: 'uppercase', letterSpacing: 1 }}>{text}</span>
    </div>
  );
}

function FieldLabel({ text, required }) {
  return (
    <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.4 }}>
      {text}{required && <span style={{ color: '#dc2626' }}> *</span>}
    </label>
  );
}

// ── Add / Edit Form ───────────────────────────────────────────────────────────
const EMPTY = {
  employee_name: '', employee_code: '', aadhar_number: '', contact_phone: '',
  contractor_company: '', designation: '', branch: '', shift_id: '',
  contract_start: '', contract_expiry: '',
  safety_certified: false, safety_cert_expiry: '',
  pf_member: false, esi_covered: false, is_active: true, notes: '',
};

function ContractorForm({ worker, onSave, onClose }) {
  const initial = worker ? {
    ...EMPTY, ...worker,
    contract_start:      worker.contract_start?.slice(0, 10)      || '',
    contract_expiry:     worker.contract_expiry?.slice(0, 10)     || '',
    safety_cert_expiry:  worker.safety_cert_expiry?.slice(0, 10)  || '',
  } : EMPTY;

  const [form, setForm] = useState(initial);
  const [shifts, setShifts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    api.get('/attendance/shifts').then(r => setShifts(r.data || [])).catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!form.employee_name.trim())    { setErr('Worker name is required'); return; }
    if (!form.contractor_company.trim()) { setErr('Contractor company is required'); return; }
    setSaving(true); setErr('');
    try {
      const payload = {
        ...form,
        shift_id:           form.shift_id           || null,
        contract_start:     form.contract_start     || null,
        contract_expiry:    form.contract_expiry    || null,
        safety_cert_expiry: form.safety_cert_expiry || null,
      };
      const res = form.id
        ? await api.put(`/attendance/contract-labour/${form.id}`, payload)
        : await api.post('/attendance/contract-labour', payload);
      onSave(res.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Save failed — check required fields');
    } finally { setSaving(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.52)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: '92vh', overflowY: 'auto', padding: 30 }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
            {form.id ? 'Edit Contract Worker' : 'Add Contract Worker'}
          </h2>
          <button onClick={onClose} style={{ border: 'none', background: '#f5f3ff', borderRadius: 8, padding: 6, cursor: 'pointer', lineHeight: 0 }}>
            <X size={16} />
          </button>
        </div>

        {err && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#dc2626', fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

          <SectionLabel text="Worker Details" />

          <div style={{ gridColumn: '1/-1' }}>
            <FieldLabel text="Worker Name" required />
            <input style={inp()} value={form.employee_name}
              onChange={e => set('employee_name', e.target.value)} placeholder="Full name" />
          </div>
          <div>
            <FieldLabel text="Employee Code" />
            <input style={inp()} value={form.employee_code}
              onChange={e => set('employee_code', e.target.value)} placeholder="e.g. CW-001" />
          </div>
          <div>
            <FieldLabel text="Aadhar Number" />
            <input style={inp()} value={form.aadhar_number}
              onChange={e => set('aadhar_number', e.target.value)} placeholder="12-digit Aadhar" maxLength={14} />
          </div>
          <div>
            <FieldLabel text="Contact Phone" />
            <input style={inp()} value={form.contact_phone}
              onChange={e => set('contact_phone', e.target.value)} placeholder="Mobile number" />
          </div>
          <div>
            <FieldLabel text="Designation" />
            <select style={inp()} value={form.designation} onChange={e => set('designation', e.target.value)}>
              <option value="">-- Select Designation --</option>
              {['Welder','Helper','Fitter','Electrician','Plumber','Painter','Operator','Technician','Supervisor','Labour','Driver','Security','Housekeeping','Other'].map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          <SectionLabel text="Deployment" />

          <div style={{ gridColumn: '1/-1' }}>
            <FieldLabel text="Contractor Company" required />
            <input style={inp()} value={form.contractor_company}
              onChange={e => set('contractor_company', e.target.value)} placeholder="Name of contracting firm" />
          </div>
          <div>
            <FieldLabel text="Branch / Site" />
            <input style={inp()} value={form.branch}
              onChange={e => set('branch', e.target.value)} placeholder="e.g. Chennai Plant" />
          </div>
          <div>
            <FieldLabel text="Shift" />
            <select style={inp()} value={form.shift_id || ''} onChange={e => set('shift_id', e.target.value)}>
              <option value="">Select shift…</option>
              {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel text="Contract Start" />
            <input type="date" style={inp()} value={form.contract_start}
              onChange={e => set('contract_start', e.target.value)} />
          </div>
          <div>
            <FieldLabel text="Contract Expiry" />
            <input type="date" style={inp()} value={form.contract_expiry}
              onChange={e => set('contract_expiry', e.target.value)} />
          </div>

          <SectionLabel text="Compliance & Safety" />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[
              { key: 'safety_certified', label: 'Safety Certified' },
              { key: 'pf_member',        label: 'PF Member' },
              { key: 'esi_covered',      label: 'ESI Covered' },
            ].map(({ key, label }) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={!!form[key]} onChange={e => set(key, e.target.checked)}
                  style={{ accentColor: P, width: 15, height: 15, cursor: 'pointer' }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{label}</span>
              </label>
            ))}
            {form.id && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={!!form.is_active} onChange={e => set('is_active', e.target.checked)}
                  style={{ accentColor: P, width: 15, height: 15, cursor: 'pointer' }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Active Worker</span>
              </label>
            )}
          </div>

          <div>
            <FieldLabel text="Safety Cert Expiry" />
            <input type="date" style={inp({ opacity: form.safety_certified ? 1 : 0.45 })}
              value={form.safety_cert_expiry}
              onChange={e => set('safety_cert_expiry', e.target.value)}
              disabled={!form.safety_certified} />
            {!form.safety_certified && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Enable Safety Certified first</div>
            )}
          </div>

          <div style={{ gridColumn: '1/-1' }}>
            <FieldLabel text="Notes" />
            <textarea style={{ ...inp(), height: 64, resize: 'vertical' }} value={form.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Compliance notes, special instructions, licence numbers…" />
          </div>

        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ padding: '9px 22px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '9px 26px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 14, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : form.id ? 'Update Worker' : 'Add Worker'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Renew Contract Modal ──────────────────────────────────────────────────────
function RenewModal({ worker, onRenew, onClose }) {
  const today = new Date();
  const base  = worker.contract_expiry ? new Date(worker.contract_expiry) : today;
  const [newExpiry, setNewExpiry] = useState('');
  const [saving, setSaving]       = useState(false);
  const [err, setErr]             = useState('');

  const quickAdd = (months) => {
    const d = new Date(base < today ? today : base);
    d.setMonth(d.getMonth() + months);
    setNewExpiry(d.toISOString().slice(0, 10));
  };

  const handleRenew = async () => {
    if (!newExpiry) { setErr('Select a new expiry date'); return; }
    if (new Date(newExpiry) <= today) { setErr('New expiry must be in the future'); return; }
    setSaving(true); setErr('');
    try {
      const res = await api.put(`/attendance/contract-labour/${worker.id}`, {
        ...worker, contract_expiry: newExpiry, is_active: true,
        safety_cert_expiry: worker.safety_cert_expiry?.slice(0, 10) || null,
        contract_start:     worker.contract_start?.slice(0, 10)     || null,
      });
      onRenew(res.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Renewal failed');
    } finally { setSaving(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.52)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 420, padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Renew Contract</h2>
          <button onClick={onClose} style={{ border: 'none', background: '#f5f3ff', borderRadius: 8, padding: 6, cursor: 'pointer', lineHeight: 0 }}><X size={16} /></button>
        </div>
        <div style={{ background: '#f9fafb', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: 13 }}>
          <div style={{ fontWeight: 700, color: '#1f2937' }}>{worker.employee_name}</div>
          <div style={{ color: '#6b7280', marginTop: 2 }}>{worker.contractor_company}</div>
          <div style={{ marginTop: 6, color: '#9ca3af', fontSize: 12 }}>
            Current expiry: <strong style={{ color: '#dc2626' }}>{fmt(worker.contract_expiry)}</strong>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {[{ label: '+3 Months', m: 3 }, { label: '+6 Months', m: 6 }, { label: '+1 Year', m: 12 }].map(o => (
            <button key={o.m} onClick={() => quickAdd(o.m)}
              style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: `1px solid ${P}`, background: '#f5f3ff', color: P, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {o.label}
            </button>
          ))}
        </div>
        <FieldLabel text="New Expiry Date" />
        <input type="date" value={newExpiry} onChange={e => setNewExpiry(e.target.value)}
          style={inp({ marginBottom: 0 })} />
        {err && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleRenew} disabled={saving || !newExpiry}
            style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 14, fontWeight: 600, cursor: (saving || !newExpiry) ? 'not-allowed' : 'pointer', opacity: (saving || !newExpiry) ? 0.7 : 1 }}>
            {saving ? 'Renewing…' : 'Renew Contract'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Delete Confirm ────────────────────────────────────────────────────────────
function DeleteConfirm({ worker, onConfirm, onClose }) {
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState(null);

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteErr(null);
    try {
      await api.delete(`/attendance/contract-labour/${worker.id}`);
      onConfirm(worker.id);
    } catch (e) {
      setDeleteErr(e.response?.data?.error || 'Delete failed');
      setDeleting(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Delete Worker Record" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.52)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 380, padding: 28 }}>
        <h2 style={{ margin: '0 0 10px', fontSize: 17, fontWeight: 700, color: '#dc2626' }}>Delete Worker Record?</h2>
        <p style={{ margin: '0 0 18px', fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>
          This permanently removes <strong style={{ color: '#1f2937' }}>{worker.employee_name}</strong> ({worker.contractor_company})
          from the system. This cannot be undone.
        </p>
        {deleteErr && <div style={{ marginBottom: 12, fontSize: 13, color: '#dc2626' }}>{deleteErr}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleDelete} disabled={deleting}
            style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontSize: 14, fontWeight: 600, cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.7 : 1 }}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Statutory Registers (Form XII, XIII, XIV & XIX) ──────────────────────────
function RegisterView({ workers, onClose }) {
  const [active, setActive]   = useState('xii');
  const [month, setMonth]     = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const contentRef = useRef(null);

  const contractors = [...new Set(workers.map(w => w.contractor_company).filter(Boolean))].map(co => ({
    name:    co,
    workers: workers.filter(w => w.contractor_company === co),
  }));

  const printRegister = () => {
    if (!contentRef.current) return;
    const win = window.open('', '_blank');
    if (!win) { toast.error('Allow pop-ups to print registers'); return; }
    win.document.write(`<!DOCTYPE html><html><head>
      <title>CLRA Statutory Register</title>
      <style>
        body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#000}
        h2{text-align:center;margin-bottom:4px;font-size:16px}
        h3{text-align:center;margin-bottom:4px;font-size:13px;color:#444;font-weight:normal}
        p.sub{text-align:center;font-size:11px;color:#888;margin-bottom:18px}
        table{width:100%;border-collapse:collapse;page-break-inside:auto}
        tr{page-break-inside:avoid}
        th,td{border:1px solid #333;padding:6px 8px;text-align:left;vertical-align:top}
        th{background:#e8e8e8;font-weight:bold;font-size:11px}
        td{font-size:11px}
        .ok{color:#15803d;font-weight:bold} .no{color:#dc2626;font-weight:bold}
      </style></head><body>
      ${contentRef.current.innerHTML}
      </body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 400);
  };

  const thStyle = { border: '1px solid #d1d5db', padding: '8px 10px', background: '#f5f3ff', fontWeight: 700, fontSize: 11, textAlign: 'left' };
  const tdStyle = { border: '1px solid #e5e7eb', padding: '8px 10px', fontSize: 12, verticalAlign: 'top' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.52)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 960, maxHeight: '92vh', overflowY: 'auto', padding: 28 }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Statutory Registers</h2>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: '#9ca3af' }}>Contract Labour (Regulation and Abolition) Act, 1970</p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button onClick={printRegister}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: `1px solid ${P}`, background: '#f5f3ff', color: P, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              <Download size={13} /> Print / Export
            </button>
            <button onClick={onClose}
              style={{ border: 'none', background: '#f5f3ff', borderRadius: 8, padding: 6, cursor: 'pointer', lineHeight: 0 }}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { id: 'xii',  label: 'Form XII' },
            { id: 'xiii', label: 'Form XIII' },
            { id: 'xiv',  label: 'Form XIV' },
            { id: 'xix',  label: 'Form XIX' },
          ].map(t => (
            <button key={t.id} onClick={() => setActive(t.id)}
              style={{ padding: '7px 14px', borderRadius: 8, border: `1px solid ${active === t.id ? P : '#e9e4ff'}`, background: active === t.id ? P : '#fff', color: active === t.id ? '#fff' : '#6b7280', fontSize: 13, fontWeight: active === t.id ? 600 : 400, cursor: 'pointer' }}>
              {t.label}
            </button>
          ))}
          {(active === 'xiv' || active === 'xix') && (
            <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>Month:</span>
              <input type="month" value={month} onChange={e => setMonth(e.target.value)}
                style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '5px 10px', fontSize: 13, outline: 'none' }} />
            </div>
          )}
        </div>

        <div ref={contentRef}>
          {active === 'xii' && (
            <div>
              <h2>FORM XII</h2>
              <h3>[See Rule 74(1)] — Register of Contractors</h3>
              <p style={{ textAlign: 'center', fontSize: 12, color: '#888', marginBottom: 14 }}>
                Under the Contract Labour (Regulation &amp; Abolition) Act, 1970
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {['S.No', 'Contractor Company', 'Workers Deployed', 'Contract Period', 'Compliance'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {contractors.length === 0
                    ? <tr><td colSpan={5} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af', padding: 24 }}>No contractor data available</td></tr>
                    : contractors.map((c, i) => {
                        const allStart  = c.workers.map(w => w.contract_start).filter(Boolean).sort();
                        const allExpiry = c.workers.map(w => w.contract_expiry).filter(Boolean).sort();
                        const okCount   = c.workers.filter(w => w.compliance_ok).length;
                        return (
                          <tr key={c.name} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
                            <td style={tdStyle}>{i + 1}</td>
                            <td style={{ ...tdStyle, fontWeight: 600 }}>{c.name}</td>
                            <td style={tdStyle}>{c.workers.length}</td>
                            <td style={tdStyle}>
                              {allStart[0] ? `${fmt(allStart[0])} → ${fmt(allExpiry[allExpiry.length - 1])}` : '—'}
                            </td>
                            <td style={tdStyle}>
                              <span style={{ color: okCount === c.workers.length ? '#15803d' : '#dc2626', fontWeight: 700 }}>
                                {okCount}/{c.workers.length} Compliant
                              </span>
                            </td>
                          </tr>
                        );
                      })
                  }
                </tbody>
              </table>
            </div>
          )}

          {active === 'xiii' && (
            <div>
              <h2>FORM XIII</h2>
              <h3>[See Rule 75] — Register of Workmen</h3>
              <p style={{ textAlign: 'center', fontSize: 12, color: '#888', marginBottom: 14 }}>
                Under the Contract Labour (Regulation &amp; Abolition) Act, 1970
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    {['S.No', 'Worker Name', 'Code', 'Aadhar', 'Designation', 'Contractor', 'Contract Period', 'PF', 'ESI', 'Safety Cert'].map(h => (
                      <th key={h} style={{ ...thStyle, fontSize: 10 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {workers.length === 0
                    ? <tr><td colSpan={10} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af', padding: 24 }}>No worker data available</td></tr>
                    : workers.map((w, i) => (
                        <tr key={w.id} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
                          <td style={tdStyle}>{i + 1}</td>
                          <td style={{ ...tdStyle, fontWeight: 600 }}>{w.employee_name}</td>
                          <td style={tdStyle}>{w.employee_code || '—'}</td>
                          <td style={tdStyle}>{w.aadhar_number || '—'}</td>
                          <td style={tdStyle}>{w.designation || '—'}</td>
                          <td style={tdStyle}>{w.contractor_company || '—'}</td>
                          <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                            {w.contract_start ? `${fmt(w.contract_start)} →\n${fmt(w.contract_expiry)}` : '—'}
                          </td>
                          <td style={tdStyle}><span style={{ color: w.pf_member ? '#15803d' : '#dc2626', fontWeight: 700 }}>{w.pf_member ? 'Yes' : 'No'}</span></td>
                          <td style={tdStyle}><span style={{ color: w.esi_covered ? '#15803d' : '#dc2626', fontWeight: 700 }}>{w.esi_covered ? 'Yes' : 'No'}</span></td>
                          <td style={tdStyle}>
                            {w.safety_certified
                              ? <span style={{ color: '#15803d', fontWeight: 700 }}>Yes{w.safety_cert_expiry ? ` (exp ${fmt(w.safety_cert_expiry)})` : ''}</span>
                              : <span style={{ color: '#dc2626', fontWeight: 700 }}>No</span>}
                          </td>
                        </tr>
                      ))
                  }
                </tbody>
              </table>
            </div>
          )}

          {active === 'xiv' && (() => {
            const [yr, mo] = month.split('-').map(Number);
            const daysInMonth = new Date(yr, mo, 0).getDate();
            const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
            const monthLabel = new Date(yr, mo - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
            const activeWorkers = workers.filter(w => w.is_active !== false);
            return (
              <div>
                <h2>FORM XIV</h2>
                <h3>[See Rule 78(1)(a)] — Muster Roll</h3>
                <p style={{ textAlign: 'center', fontSize: 11, color: '#888', marginBottom: 4 }}>
                  Under the Contract Labour (Regulation &amp; Abolition) Act, 1970
                </p>
                <p style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#444', marginBottom: 14 }}>
                  Month: {monthLabel}
                </p>
                <p style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                  Mark: P = Present &nbsp;|&nbsp; A = Absent &nbsp;|&nbsp; H = Holiday &nbsp;|&nbsp; WO = Week Off &nbsp;|&nbsp; L = Leave
                </p>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10, minWidth: 1200 }}>
                    <thead>
                      <tr>
                        <th style={{ ...thStyle, fontSize: 9, minWidth: 30 }}>S.No</th>
                        <th style={{ ...thStyle, fontSize: 9, minWidth: 120 }}>Worker Name</th>
                        <th style={{ ...thStyle, fontSize: 9, minWidth: 70 }}>Contractor</th>
                        <th style={{ ...thStyle, fontSize: 9, minWidth: 60 }}>Designation</th>
                        {days.map(d => (
                          <th key={d} style={{ ...thStyle, fontSize: 9, textAlign: 'center', padding: '6px 3px', minWidth: 22 }}>{d}</th>
                        ))}
                        <th style={{ ...thStyle, fontSize: 9, textAlign: 'center', minWidth: 40 }}>Total<br/>Present</th>
                        <th style={{ ...thStyle, fontSize: 9, minWidth: 60 }}>Signature</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeWorkers.length === 0
                        ? <tr><td colSpan={days.length + 6} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af', padding: 24 }}>No active workers</td></tr>
                        : activeWorkers.map((w, i) => (
                            <tr key={w.id} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
                              <td style={{ ...tdStyle, textAlign: 'center' }}>{i + 1}</td>
                              <td style={{ ...tdStyle, fontWeight: 600, fontSize: 10 }}>{w.employee_name}</td>
                              <td style={{ ...tdStyle, fontSize: 9 }}>{w.contractor_company || '—'}</td>
                              <td style={{ ...tdStyle, fontSize: 9 }}>{w.designation || '—'}</td>
                              {days.map(d => (
                                <td key={d} style={{ ...tdStyle, textAlign: 'center', padding: '6px 2px', minWidth: 22, color: '#aaa' }}>_</td>
                              ))}
                              <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 700 }}>__</td>
                              <td style={{ ...tdStyle }}></td>
                            </tr>
                          ))
                      }
                    </tbody>
                  </table>
                </div>
                <p style={{ fontSize: 10, color: '#888', marginTop: 12 }}>
                  Certified that the above is a correct record of attendance for the month of {monthLabel}.
                </p>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, fontSize: 11 }}>
                  <div>Date: ________________</div>
                  <div>Signature of Contractor: ________________</div>
                  <div>Signature of Principal Employer: ________________</div>
                </div>
              </div>
            );
          })()}

          {active === 'xix' && (() => {
            const [yr, mo] = month.split('-').map(Number);
            const monthLabel = new Date(yr, mo - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
            const activeWorkers = workers.filter(w => w.is_active !== false);
            return (
              <div>
                <h2>FORM XIX</h2>
                <h3>[See Rule 78(1)(b)] — Register of Wages</h3>
                <p style={{ textAlign: 'center', fontSize: 11, color: '#888', marginBottom: 4 }}>
                  Under the Contract Labour (Regulation &amp; Abolition) Act, 1970
                </p>
                <p style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#444', marginBottom: 14 }}>
                  Month: {monthLabel}
                </p>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                  <thead>
                    <tr>
                      {[
                        'S.No', 'Worker Name', 'Employee Code', 'Designation', 'Contractor',
                        'Working Days', 'Days Present', 'Basic Wages (₹)', 'DA / HRA (₹)',
                        'Gross Wages (₹)', 'PF Deduction (₹)', 'ESI Deduction (₹)',
                        'Other Deductions (₹)', 'Net Wages Payable (₹)', 'Signature / Thumb'
                      ].map(h => (
                        <th key={h} style={{ ...thStyle, fontSize: 9, padding: '6px 6px' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeWorkers.length === 0
                      ? <tr><td colSpan={15} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af', padding: 24 }}>No active workers</td></tr>
                      : activeWorkers.map((w, i) => (
                          <tr key={w.id} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
                            <td style={{ ...tdStyle, textAlign: 'center' }}>{i + 1}</td>
                            <td style={{ ...tdStyle, fontWeight: 600, fontSize: 10 }}>{w.employee_name}</td>
                            <td style={{ ...tdStyle, fontSize: 9 }}>{w.employee_code || '—'}</td>
                            <td style={{ ...tdStyle, fontSize: 9 }}>{w.designation || '—'}</td>
                            <td style={{ ...tdStyle, fontSize: 9 }}>{w.contractor_company || '—'}</td>
                            <td style={{ ...tdStyle, textAlign: 'center', color: '#aaa' }}>__</td>
                            <td style={{ ...tdStyle, textAlign: 'center', color: '#aaa' }}>__</td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: '#aaa' }}>__</td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: '#aaa' }}>__</td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: '#aaa' }}>__</td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: w.pf_member ? '#374151' : '#aaa' }}>
                              {w.pf_member ? '__' : 'N/A'}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: w.esi_covered ? '#374151' : '#aaa' }}>
                              {w.esi_covered ? '__' : 'N/A'}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: '#aaa' }}>__</td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: '#aaa' }}>__</td>
                            <td style={{ ...tdStyle }}></td>
                          </tr>
                        ))
                    }
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f5f3ff', fontWeight: 700 }}>
                      <td colSpan={9} style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>TOTAL</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#aaa' }}>__</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#aaa' }}>__</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#aaa' }}>__</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#aaa' }}>__</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#aaa' }}>__</td>
                      <td style={tdStyle}></td>
                    </tr>
                  </tfoot>
                </table>
                <p style={{ fontSize: 10, color: '#888', marginTop: 12 }}>
                  Certified that the wages for the month of {monthLabel} have been paid to all the contract workmen as shown above.
                </p>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, fontSize: 11 }}>
                  <div>Date of Payment: ________________</div>
                  <div>Signature of Contractor: ________________</div>
                  <div>Signature of Principal Employer: ________________</div>
                </div>
              </div>
            );
          })()}
        </div>

      </div>
    </div>
  );
}

const ATT_STATUS_OPTS = [
  { value: 'present',  label: 'Present',  Icon: CheckSquare,  color: '#15803d', bg: '#ecfdf5' },
  { value: 'absent',   label: 'Absent',   Icon: XSquare,      color: '#dc2626', bg: '#fef2f2' },
  { value: 'halfday',  label: 'Half Day', Icon: MinusSquare,  color: '#d97706', bg: '#fffbeb' },
];

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ContractLabour() {
  const toast = useToast();
  const [workers,       setWorkers]       = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [filterStatus,  setFilterStatus]  = useState('all');
  const [search,        setSearch]        = useState('');
  const [showForm,      setShowForm]      = useState(false);
  const [editWorker,    setEditWorker]    = useState(null);
  const [renewWorker,   setRenewWorker]   = useState(null);
  const [deleteWorker,  setDeleteWorker]  = useState(null);
  const [showRegisters, setShowRegisters] = useState(false);
  const [msg,           setMsg]           = useState('');
  const [mainView,      setMainView]      = useState('workers'); // 'workers' | 'attendance'

  // attendance tab state
  const [attDate,       setAttDate]       = useState(() => new Date().toISOString().split('T')[0]);
  const [attRecords,    setAttRecords]    = useState([]);
  const [attLoading,    setAttLoading]    = useState(false);
  const [attMarking,    setAttMarking]    = useState({}); // workerId → true
  const [bulkStatus,    setBulkStatus]    = useState('present');
  const [bulkLoading,   setBulkLoading]   = useState(false);

  const flash = (text) => { setMsg(text); setTimeout(() => setMsg(''), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await api.get('/attendance/contract-labour');
      const rows = Array.isArray(res.data) ? res.data : [];
      setWorkers(rows.map(w => ({ ...w, _status: w.status || computeStatus(w) })));
    } catch {
      setWorkers([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const enrich = (w) => ({ ...w, _status: w.status || computeStatus(w) });

  const handleSave = (saved) => {
    const w = enrich(saved);
    setWorkers(prev => prev.find(x => x.id === w.id)
      ? prev.map(x => x.id === w.id ? w : x)
      : [w, ...prev]);
    setShowForm(false); setEditWorker(null);
    flash('Worker record saved');
  };

  const handleRenew = (updated) => {
    setWorkers(prev => prev.map(w => w.id === updated.id ? enrich(updated) : w));
    setRenewWorker(null);
    flash('Contract renewed successfully');
  };

  const handleDelete = (id) => {
    setWorkers(prev => prev.filter(w => w.id !== id));
    setDeleteWorker(null);
    flash('Worker record deleted');
  };

  // ── Attendance tab ─────────────────────────────────────────────────────────
  const loadAttendance = useCallback(async (date) => {
    setAttLoading(true);
    try {
      const res = await api.get(`/attendance/contract-labour/attendance?date=${date}`);
      setAttRecords(Array.isArray(res.data) ? res.data : []);
    } catch {
      setAttRecords([]);
      toast.error('Failed to load attendance');
    } finally { setAttLoading(false); }
  }, [toast]);

  useEffect(() => {
    if (mainView === 'attendance') loadAttendance(attDate);
  }, [mainView, attDate, loadAttendance]);

  const handleMarkOne = async (workerId, status) => {
    setAttMarking(prev => ({ ...prev, [workerId]: true }));
    try {
      await api.post('/attendance/contract-labour/attendance', {
        worker_id: workerId,
        date: attDate,
        status,
      });
      setAttRecords(prev => prev.map(r =>
        r.worker_id === workerId ? { ...r, status } : r
      ));
      toast.success('Attendance marked');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to mark attendance');
    } finally {
      setAttMarking(prev => { const n = { ...prev }; delete n[workerId]; return n; });
    }
  };

  const handleBulkMark = async () => {
    setBulkLoading(true);
    try {
      await api.post('/attendance/contract-labour/bulk-mark', {
        date: attDate,
        status: bulkStatus,
      });
      await loadAttendance(attDate);
      toast.success(`All workers marked as ${bulkStatus} for ${attDate}`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Bulk mark failed');
    } finally { setBulkLoading(false); }
  };

  // KPIs — computed from local state (no separate stats call needed)
  const kpi = {
    active:   workers.filter(w => w._status === 'active').length,
    expiring: workers.filter(w => w._status === 'expiring').length,
    expired:  workers.filter(w => w._status === 'expired').length,
    noSafety: workers.filter(w => {
      if (!w.safety_certified) return true;
      const d = daysTo(w.safety_cert_expiry);
      return d !== null && d < 0;
    }).length,
  };

  const TABS = [
    { key: 'all',      label: `All (${workers.length})` },
    { key: 'active',   label: `Active (${kpi.active})` },
    { key: 'expiring', label: `Expiring (${kpi.expiring})` },
    { key: 'expired',  label: `Expired (${kpi.expired})` },
  ];

  const filtered = workers.filter(w => {
    const matchStatus = filterStatus === 'all' || w._status === filterStatus;
    const q = search.toLowerCase();
    const matchSearch = !q
      || (w.employee_name      || '').toLowerCase().includes(q)
      || (w.contractor_company || '').toLowerCase().includes(q)
      || (w.designation        || '').toLowerCase().includes(q)
      || (w.branch             || '').toLowerCase().includes(q)
      || (w.aadhar_number      || '').includes(q);
    return matchStatus && matchSearch;
  });

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif', margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1f2937' }}>Contract Labour</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Track contract workers, compliance, and statutory obligations under CLRA Act 1970
          </p>
          {/* Main view tabs */}
          <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            {[
              { key: 'workers',    label: 'Workers',    Icon: Users },
              { key: 'attendance', label: 'Attendance', Icon: CalendarCheck },
            ].map(({ key, label, Icon }) => (
              <button key={key} onClick={() => setMainView(key)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: `1px solid ${mainView === key ? P : '#e9e4ff'}`, background: mainView === key ? P : '#fff', color: mainView === key ? '#fff' : '#6b7280', fontWeight: mainView === key ? 700 : 500, fontSize: 13, cursor: 'pointer' }}>
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setShowRegisters(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 10, border: `1px solid ${P}`, background: '#f5f3ff', color: P, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
            <FileText size={14} /> Statutory Registers
          </button>
          <button onClick={() => { setEditWorker(null); setShowForm(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 10, border: 'none', background: P, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
            <Plus size={16} /> Add Worker
          </button>
        </div>
      </div>

      {/* Flash */}
      {msg && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 14px', marginBottom: 14, color: '#15803d', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Check size={13} /> {msg}
        </div>
      )}

      {/* Alert Banners */}
      {kpi.expiring > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', marginBottom: 10, fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={14} color="#d97706" />
          <strong>{kpi.expiring}</strong> contract{kpi.expiring > 1 ? 's' : ''} expiring within 30 days — renew before expiry to stay compliant.
        </div>
      )}
      {kpi.noSafety > 0 && (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#991b1b', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Shield size={14} color="#dc2626" />
          <strong>{kpi.noSafety}</strong> worker{kpi.noSafety > 1 ? 's' : ''} without valid safety certification — must not be deployed on factory floor.
        </div>
      )}

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 22 }}>
        {[
          { label: 'Active Workers',  value: kpi.active,   color: '#10b981', bg: '#ecfdf5', Icon: HardHat },
          { label: 'Expiring (30d)',  value: kpi.expiring, color: '#f59e0b', bg: '#fffbeb', Icon: Clock },
          { label: 'Expired',        value: kpi.expired,  color: '#ef4444', bg: '#fef2f2', Icon: AlertCircle },
          { label: 'No Safety Cert', value: kpi.noSafety, color: '#dc2626', bg: '#fff0f0', Icon: Shield },
        ].map(k => (
          <div key={k.label} style={{ ...CARD, padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: 10, background: k.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <k.Icon size={20} color={k.color} />
            </div>
            <div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#1f2937', lineHeight: 1 }}>{k.value}</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Attendance Tab ───────────────────────────────────────────────── */}
      {mainView === 'attendance' && (
        <div>
          {/* Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CalendarCheck size={15} color={P} />
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Date</label>
              <input type="date" value={attDate} onChange={e => setAttDate(e.target.value)}
                style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 12px', fontSize: 13, outline: 'none', fontFamily: 'Inter, sans-serif' }} />
            </div>
            <button onClick={() => loadAttendance(attDate)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 13, color: '#6b7280', cursor: 'pointer' }}>
              <RefreshCw size={13} /> Refresh
            </button>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>Bulk mark all as</span>
              <select value={bulkStatus} onChange={e => setBulkStatus(e.target.value)}
                style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'Inter, sans-serif' }}>
                {ATT_STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button onClick={handleBulkMark} disabled={bulkLoading}
                style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontWeight: 700, fontSize: 13, cursor: bulkLoading ? 'not-allowed' : 'pointer', opacity: bulkLoading ? 0.7 : 1 }}>
                {bulkLoading ? 'Marking…' : 'Bulk Mark'}
              </button>
            </div>
          </div>

          {/* Attendance table */}
          {attLoading ? (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af', fontSize: 14 }}>Loading attendance…</div>
          ) : attRecords.length === 0 ? (
            <div style={{ ...CARD, textAlign: 'center', padding: 60 }}>
              <CalendarCheck size={44} color="#d1d5db" style={{ marginBottom: 12 }} />
              <p style={{ color: '#6b7280', margin: '0 0 4px', fontWeight: 600 }}>No attendance records for {attDate}</p>
              <p style={{ color: '#d1d5db', margin: 0, fontSize: 13 }}>Use Bulk Mark to mark all workers at once</p>
            </div>
          ) : (
            <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #f0f0f4', background: '#fafafa' }}>
                    {['Worker', 'Contractor', 'Designation', 'Status', 'Mark'].map(h => (
                      <th key={h} style={{ padding: '11px 14px', textAlign: 'left', fontWeight: 700, color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {attRecords.map((r, i) => {
                    const curOpt = ATT_STATUS_OPTS.find(o => o.value === r.status);
                    const busy = attMarking[r.worker_id];
                    return (
                      <tr key={r.worker_id || i} style={{ borderBottom: '1px solid #f5f5f5', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ padding: '11px 14px', fontWeight: 700, color: '#1f2937' }}>
                          {r.employee_name}
                          {r.employee_code && <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.employee_code}</div>}
                        </td>
                        <td style={{ padding: '11px 14px', color: '#374151' }}>{r.contractor_company || '—'}</td>
                        <td style={{ padding: '11px 14px', color: '#374151' }}>{r.designation || '—'}</td>
                        <td style={{ padding: '11px 14px' }}>
                          {curOpt ? (
                            <span style={{ background: curOpt.bg, color: curOpt.color, borderRadius: 8, padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>
                              {curOpt.label}
                            </span>
                          ) : (
                            <span style={{ background: '#f3f4f6', color: '#9ca3af', borderRadius: 8, padding: '3px 10px', fontSize: 11 }}>Not Marked</span>
                          )}
                        </td>
                        <td style={{ padding: '11px 14px' }}>
                          <div style={{ display: 'flex', gap: 5 }}>
                            {ATT_STATUS_OPTS.map(o => (
                              <button key={o.value} onClick={() => handleMarkOne(r.worker_id, o.value)}
                                disabled={busy || r.status === o.value}
                                title={o.label}
                                style={{ border: `1px solid ${r.status === o.value ? o.color : '#e9e4ff'}`, background: r.status === o.value ? o.bg : '#fff', color: r.status === o.value ? o.color : '#9ca3af', borderRadius: 6, padding: '4px 8px', fontSize: 11, fontWeight: 600, cursor: busy || r.status === o.value ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 3 }}>
                                <o.Icon size={11} /> {o.label}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ padding: '10px 16px', borderTop: '1px solid #f0f0f4', fontSize: 12, color: '#9ca3af' }}>
                {attRecords.length} workers — {attDate}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Workers Tab ──────────────────────────────────────────────────── */}
      {mainView === 'workers' && <>

      {/* Filter Tabs + Search */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setFilterStatus(t.key)}
              style={{ padding: '6px 16px', borderRadius: 20, border: `1px solid ${filterStatus === t.key ? P : '#e9e4ff'}`, background: filterStatus === t.key ? P : '#fff', color: filterStatus === t.key ? '#fff' : '#6b7280', fontSize: 13, fontWeight: filterStatus === t.key ? 600 : 400, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search worker, company, site…"
            style={{ paddingLeft: 30, paddingRight: 12, paddingTop: 7, paddingBottom: 7, borderRadius: 8, border: '1px solid #e9e4ff', fontSize: 13, outline: 'none', width: 230, fontFamily: 'Inter, sans-serif' }} />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af', fontSize: 14 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60 }}>
          <HardHat size={44} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#6b7280', margin: '0 0 4px', fontWeight: 600 }}>No contract workers found</p>
          <p style={{ color: '#d1d5db', margin: 0, fontSize: 13 }}>
            {search ? 'Try a different search term' : 'Add your first contract worker to get started'}
          </p>
        </div>
      ) : (
        <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #f0f0f4', background: '#fafafa' }}>
                {['Worker', 'Contractor', 'Role & Site', 'Contract Period', 'Safety', 'PF / ESI', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '11px 14px', textAlign: 'left', fontWeight: 700, color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((w, i) => {
                const contractDays  = daysTo(w.contract_expiry);
                const certDays      = daysTo(w.safety_cert_expiry);
                const safetyOk      = w.safety_certified && (certDays === null || certDays >= 0);
                const certExpiring  = w.safety_certified && certDays !== null && certDays >= 0 && certDays <= 30;

                return (
                  <tr key={w.id} style={{ borderBottom: '1px solid #f5f5f5', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>

                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ fontWeight: 700, color: '#1f2937' }}>{w.employee_name}</div>
                      {w.employee_code && (
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{w.employee_code}</div>
                      )}
                      {w.aadhar_number && (
                        <div style={{ fontSize: 11, color: '#a78bfa', marginTop: 1 }}>Aadhar ••••{w.aadhar_number.slice(-4)}</div>
                      )}
                      {w.contact_phone && (
                        <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 3, marginTop: 1 }}>
                          <Phone size={10} /> {w.contact_phone}
                        </div>
                      )}
                    </td>

                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ fontWeight: 500, color: '#374151' }}>{w.contractor_company || '—'}</div>
                      {w.shift_name && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{w.shift_name}</div>}
                    </td>

                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ color: '#374151' }}>{w.designation || '—'}</div>
                      {w.branch && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{w.branch}</div>}
                    </td>

                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{fmt(w.contract_start)}</div>
                      <div style={{ fontSize: 12, fontWeight: 500, color: '#374151' }}>→ {fmt(w.contract_expiry)}</div>
                      {contractDays !== null && contractDays >= 0 && contractDays <= 30 && (
                        <div style={{ fontSize: 11, color: '#d97706', fontWeight: 700, marginTop: 2 }}>⚠ {contractDays}d left</div>
                      )}
                      {contractDays !== null && contractDays < 0 && (
                        <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 700, marginTop: 2 }}>EXPIRED {Math.abs(contractDays)}d ago</div>
                      )}
                    </td>

                    <td style={{ padding: '11px 14px' }}>
                      {safetyOk ? (
                        <div>
                          <span style={{ color: '#15803d', fontWeight: 700, fontSize: 12 }}>✓ Certified</span>
                          {certExpiring && (
                            <div style={{ fontSize: 11, color: '#d97706', fontWeight: 600, marginTop: 2 }}>Cert exp in {certDays}d</div>
                          )}
                          {w.safety_cert_expiry && (
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{fmt(w.safety_cert_expiry)}</div>
                          )}
                        </div>
                      ) : (
                        <div>
                          <span style={{ color: '#dc2626', fontWeight: 700, fontSize: 12 }}>✗ Not Certified</span>
                          {w.safety_certified && certDays !== null && certDays < 0 && (
                            <div style={{ fontSize: 11, color: '#dc2626', marginTop: 2 }}>Cert expired</div>
                          )}
                        </div>
                      )}
                    </td>

                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ background: w.pf_member ? '#ecfdf5' : '#fef2f2', color: w.pf_member ? '#15803d' : '#dc2626', borderRadius: 8, padding: '2px 8px', fontSize: 11, fontWeight: 700, display: 'inline-block' }}>
                          PF: {w.pf_member ? 'Yes' : 'No'}
                        </span>
                        <span style={{ background: w.esi_covered ? '#ecfdf5' : '#fef2f2', color: w.esi_covered ? '#15803d' : '#dc2626', borderRadius: 8, padding: '2px 8px', fontSize: 11, fontWeight: 700, display: 'inline-block' }}>
                          ESI: {w.esi_covered ? 'Yes' : 'No'}
                        </span>
                      </div>
                    </td>

                    <td style={{ padding: '11px 14px' }}>
                      <StatusBadge status={w._status} />
                      {w.compliance_ok === false && (
                        <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 600, marginTop: 4 }}>Non-Compliant</div>
                      )}
                    </td>

                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ display: 'flex', gap: 5 }}>
                        <button onClick={() => { setEditWorker(w); setShowForm(true); }} title="Edit worker"
                          style={{ border: 'none', background: '#f0f9ff', borderRadius: 6, padding: '5px 7px', cursor: 'pointer', color: '#0369a1', lineHeight: 0 }}>
                          <Edit2 size={13} />
                        </button>
                        <button onClick={() => setRenewWorker(w)} title="Renew contract"
                          style={{ border: 'none', background: '#f0fdf4', borderRadius: 6, padding: '5px 7px', cursor: 'pointer', color: '#15803d', lineHeight: 0 }}>
                          <RefreshCw size={13} />
                        </button>
                        <button onClick={() => setDeleteWorker(w)} title="Delete record"
                          style={{ border: 'none', background: '#fef2f2', borderRadius: 6, padding: '5px 7px', cursor: 'pointer', color: '#dc2626', lineHeight: 0 }}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>

                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ padding: '10px 16px', borderTop: '1px solid #f0f0f4', fontSize: 12, color: '#9ca3af' }}>
            Showing {filtered.length} of {workers.length} workers
          </div>
        </div>
      )}

      </>}

      {/* Modals */}
      {showForm      && <ContractorForm worker={editWorker}    onSave={handleSave}   onClose={() => { setShowForm(false); setEditWorker(null); }} />}
      {renewWorker   && <RenewModal     worker={renewWorker}   onRenew={handleRenew} onClose={() => setRenewWorker(null)} />}
      {deleteWorker  && <DeleteConfirm  worker={deleteWorker}  onConfirm={handleDelete} onClose={() => setDeleteWorker(null)} />}
      {showRegisters && <RegisterView   workers={workers}      onClose={() => setShowRegisters(false)} />}
    </div>
  );
}
