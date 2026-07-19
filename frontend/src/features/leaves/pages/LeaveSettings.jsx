import React, { useState, useEffect } from 'react';
import { Pencil, Trash2, X, Plus, Zap, Settings, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import '../../crm/pages/Leads.css';
import './LeaveSettings.css';

const TABS = ['Leave Types', 'Allocations', 'Policy Rules', 'Accrual & Carry Forward'];

// Only these roles may add/edit/delete leave configuration. Everyone else who
// reaches this page (e.g. via a Page-Access "View" override) gets a read-only
// list — no Add/Edit/Delete/Allocate/Run controls. Must mirror the backend's
// LEAVE_ADMIN_ROLES (leaves.routes.js / accrual.routes.js) so the UI never
// shows a control the API will 403.
const MANAGE_ROLES = new Set(['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec']);

const EMPTY_TYPE = {
  leave_name: '', default_days: '', description: '',
  carry_forward_allowed: false, max_carry_forward_days: '', is_encashable: false,
  allow_half_day: true, requires_attachment: false, requires_medical_cert_days: '',
  allow_negative_balance: false, min_notice_days: '', max_consecutive_days: '',
  accrual_type: 'manual', accrual_days_per_month: '', gender_restriction: '',
  allowed_in_probation: true, is_paid: true, is_lop_type: false,
};

const EMPTY_ALLOC = { employee_id: '', leave_type_id: '', allocated_days: '', year: new Date().getFullYear() };

// ── Inline Toast ──────────────────────────────────────────────────────────────
function Toast({ msg, type, onClose }) {
  useEffect(() => { if (!msg) return; const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [msg, onClose]);
  if (!msg) return null;
  return (
    <div className={`ls-toast ls-toast-${type}`} style={{ position:'fixed', top:24, right:24, zIndex:9999 }}>
      {msg}
      <button onClick={onClose} style={{ marginLeft:12, background:'none', border:'none', cursor:'pointer', color:'inherit', fontWeight:700 }}>×</button>
    </div>
  );
}

// ── Leave Type Form Modal ─────────────────────────────────────────────────────
function LeaveTypeModal({ mode, initial, onSave, onClose }) {
  const [form, setForm] = useState(initial);
  const [err,  setErr]  = useState('');
  const [saving, setSaving] = useState(false);

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const toggle = k => setForm(f => ({ ...f, [k]: !f[k] }));

  const handleSave = async () => {
    const name = (form.leave_name || '').trim();
    if (!name || name.length < 2) { setErr('Leave name must be at least 2 characters'); return; }
    if (form.default_days === '' || form.default_days === null) { setErr('Default days is required'); return; }
    setErr(''); setSaving(true);
    try {
      await onSave(form);
      onClose();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || 'Failed to save');
    } finally { setSaving(false); }
  };

  const Field = ({ label, children, req }) => (
    <div className="ls-field" style={{ marginBottom:12 }}>
      <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>
        {label}{req && <span className="ls-req"> *</span>}
      </label>
      {children}
    </div>
  );

  const inputStyle = { width:'100%', padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, outline:'none', boxSizing:'border-box' };
  const checkRow   = (k, label) => (
    <label key={k} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', marginBottom:8 }}>
      <input type="checkbox" checked={!!form[k]} onChange={() => toggle(k)} />
      {label}
    </label>
  );

  return (
    <div className="ls-overlay" onClick={onClose}>
      <div className="ls-modal" style={{ maxWidth:620, width:'95vw', maxHeight:'90vh', overflowY:'auto' }} onClick={e => e.stopPropagation()}>
        <div className="ls-modal-hd">
          <span>{mode === 'add' ? 'Add Leave Type' : `Edit — ${initial.leave_name}`}</span>
          <button className="ls-close" onClick={onClose}><X size={16}/></button>
        </div>
        <div className="ls-modal-body">
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Field label="Leave Name" req><input style={inputStyle} value={form.leave_name} onChange={e => setF('leave_name', e.target.value)} placeholder="e.g. Earned Leave" autoFocus /></Field>
            <Field label="Default Days / Year" req><input type="number" min="0" style={inputStyle} value={form.default_days} onChange={e => setF('default_days', e.target.value)} placeholder="e.g. 12" /></Field>
            <Field label="Accrual Type">
              <select style={inputStyle} value={form.accrual_type} onChange={e => setF('accrual_type', e.target.value)}>
                <option value="manual">Manual (HR allocates)</option>
                <option value="monthly">Monthly accrual</option>
                <option value="quarterly">Quarterly accrual</option>
                <option value="yearly">Yearly credit</option>
                <option value="joining_date">Pro-rated from joining</option>
              </select>
            </Field>
            {form.accrual_type !== 'manual' && (
              <Field label="Days per Month (accrual)"><input type="number" min="0" step="0.25" style={inputStyle} value={form.accrual_days_per_month} onChange={e => setF('accrual_days_per_month', e.target.value)} placeholder="e.g. 1.0" /></Field>
            )}
            <Field label="Min Notice Days"><input type="number" min="0" style={inputStyle} value={form.min_notice_days} onChange={e => setF('min_notice_days', e.target.value)} placeholder="0 = no requirement" /></Field>
            <Field label="Max Consecutive Days"><input type="number" min="0" style={inputStyle} value={form.max_consecutive_days} onChange={e => setF('max_consecutive_days', e.target.value)} placeholder="leave blank = no limit" /></Field>
            <Field label="Medical Cert Required After (days)"><input type="number" min="0" style={inputStyle} value={form.requires_medical_cert_days} onChange={e => setF('requires_medical_cert_days', e.target.value)} placeholder="e.g. 3 — blank = not required" /></Field>
            <Field label="Gender Restriction">
              <select style={inputStyle} value={form.gender_restriction || ''} onChange={e => setF('gender_restriction', e.target.value || null)}>
                <option value="">No restriction (all genders)</option>
                <option value="F">Female only</option>
                <option value="M">Male only</option>
              </select>
            </Field>
          </div>
          <div style={{ gridColumn:'1/-1' }}>
            <Field label="Description"><textarea rows={2} style={inputStyle} value={form.description} onChange={e => setF('description', e.target.value)} placeholder="Optional description" /></Field>
          </div>

          <div style={{ marginTop:16 }}>
            <div style={{ fontSize:12, fontWeight:700, color:'#6b7280', textTransform:'uppercase', letterSpacing:1, marginBottom:10 }}>Policy Flags</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:2 }}>
              {checkRow('is_paid',              '✅ Paid Leave (no salary deduction)')}
              {checkRow('carry_forward_allowed','📂 Carry Forward to next year')}
              {checkRow('is_encashable',         '💰 Encashable')}
              {checkRow('allow_half_day',         '½ Half Day allowed')}
              {checkRow('requires_attachment',    '📎 Attachment required')}
              {checkRow('allow_negative_balance', '➖ Allow negative balance (LOP)')}
              {checkRow('allowed_in_probation',   '🔓 Available during probation')}
              {checkRow('is_lop_type',            '⚠️ Loss of Pay type')}
            </div>
          </div>

          {form.carry_forward_allowed && (
            <div style={{ marginTop:12, display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <Field label="Max Carry Forward Days"><input type="number" min="0" style={inputStyle} value={form.max_carry_forward_days} onChange={e => setF('max_carry_forward_days', e.target.value)} placeholder="e.g. 30" /></Field>
            </div>
          )}
          {form.is_encashable && (
            <div style={{ marginTop:12, display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <Field label="Max Encash Days / Year"><input type="number" min="0" style={inputStyle} value={form.max_encash_days_per_year || ''} onChange={e => setF('max_encash_days_per_year', e.target.value)} placeholder="e.g. 15" /></Field>
            </div>
          )}
        </div>
        {err && <div className="ls-modal-err">{err}</div>}
        <div className="ls-modal-ft">
          <button className="ls-btn-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="ls-btn-save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : mode === 'add' ? 'Add Leave Type' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Accrual & Carry Forward Tab ───────────────────────────────────────────────
function AccrualTab({ showToast, canManage = true }) {
  const [running, setRunning] = useState('');
  const [accrualForm, setAccrualForm]   = useState({ month: new Date().getMonth() + 1, year: new Date().getFullYear() });
  const [cfForm,      setCfForm]        = useState({ from_year: new Date().getFullYear() - 1 });

  const run = async (action, payload) => {
    setRunning(action);
    try {
      const r = await api.post(`/leave-accrual/${action}`, payload);
      const d = r.data;
      if (action === 'run') showToast(`Accrual complete — ${d.records_accrued} records updated for ${d.employees_processed} employees`, 'success');
      if (action === 'carry-forward') showToast(`Carry forward complete — ${d.records_carried} records`, 'success');
      if (action === 'expire') showToast(`Expiry complete — ${d.records_expired} records expired`, 'success');
    } catch (e) {
      showToast(e?.response?.data?.error || e.message || 'Failed', 'error');
    } finally { setRunning(''); }
  };

  const card = (title, desc, children, action) => (
    <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, padding:20, marginBottom:20 }}>
      <h3 style={{ margin:'0 0 4px', fontSize:15, fontWeight:700, color:'#1f2937' }}>{title}</h3>
      <p style={{ margin:'0 0 16px', fontSize:12, color:'#6b7280' }}>{desc}</p>
      {children}
    </div>
  );

  if (!canManage) {
    return (
      <div style={{ padding:'40px 20px', textAlign:'center', color:'#6b7280', fontSize:14 }}>
        Accrual &amp; carry-forward actions are managed by HR.
      </div>
    );
  }

  return (
    <div>
      {card('Monthly Accrual', 'Run monthly leave accrual for all active employees (Factories Act compliant — 1 day EL per 20 working days).',
        <div style={{ display:'flex', gap:12, alignItems:'flex-end', flexWrap:'wrap' }}>
          <div>
            <label style={{ fontSize:12, fontWeight:600, display:'block', marginBottom:4 }}>Month</label>
            <select value={accrualForm.month} onChange={e => setAccrualForm(f => ({...f,month:e.target.value}))}
              style={{ padding:'7px 12px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13 }}>
              {[...Array(12)].map((_,i)=><option key={i+1} value={i+1}>{new Date(0,i).toLocaleString('default',{month:'long'})}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize:12, fontWeight:600, display:'block', marginBottom:4 }}>Year</label>
            <input type="number" value={accrualForm.year} onChange={e => setAccrualForm(f=>({...f,year:e.target.value}))}
              style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, width:90 }}/>
          </div>
          <button disabled={running==='run'} onClick={() => run('run', accrualForm)}
            style={{ padding:'8px 20px', background:'#6366f1', color:'#fff', border:'none', borderRadius:8, fontWeight:600, fontSize:13, cursor:'pointer', opacity:running?0.6:1 }}>
            {running==='run' ? 'Running…' : 'Run Accrual'}
          </button>
        </div>
      )}
      {card('Year-End Carry Forward', 'Transfer unused earned leave balance to the next year (respects max_carry_forward_days per type).',
        <div style={{ display:'flex', gap:12, alignItems:'flex-end', flexWrap:'wrap' }}>
          <div>
            <label style={{ fontSize:12, fontWeight:600, display:'block', marginBottom:4 }}>From Year</label>
            <input type="number" value={cfForm.from_year} onChange={e => setCfForm({from_year:e.target.value})}
              style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, width:100 }}/>
          </div>
          <button disabled={!!running} onClick={() => run('carry-forward', cfForm)}
            style={{ padding:'8px 20px', background:'#10b981', color:'#fff', border:'none', borderRadius:8, fontWeight:600, fontSize:13, cursor:'pointer', opacity:running?0.6:1 }}>
            {running==='carry-forward' ? 'Processing…' : `Carry Forward ${cfForm.from_year} → ${Number(cfForm.from_year)+1}`}
          </button>
        </div>
      )}
      {card('Expire Stale Carry Forward', 'Expire carried-forward leave balances that have passed their validity period.',
        <button disabled={!!running} onClick={() => run('expire', {})}
          style={{ padding:'8px 20px', background:'#ef4444', color:'#fff', border:'none', borderRadius:8, fontWeight:600, fontSize:13, cursor:'pointer', opacity:running?0.6:1 }}>
          {running==='expire' ? 'Expiring…' : 'Run Expiry'}
        </button>
      )}
    </div>
  );
}

// ── Policy Rules Tab ──────────────────────────────────────────────────────────
const EMPTY_POLICY = {
  policy_name: '', accrual_type: 'manual', accrual_days_per_month: '',
  min_notice_days: '', max_consecutive_days: '',
  carry_forward_allowed: false, max_carry_forward_days: '', carry_forward_expiry_months: '',
  sandwich_rule: false, include_weekends: false, include_holidays: false,
  probation_allowed: true, allow_negative_balance: false,
  requires_attachment: false, requires_medical_cert_days: '',
  gender_restriction: '', department_restriction: '', is_active: true,
};

function PolicyRulesTab({ leaveTypes, showToast, canManage = true }) {
  const [policies,   setPolicies]   = useState([]);
  const [editModal,  setEditModal]  = useState(null); // null | { leaveType, policy }
  const [form,       setForm]       = useState(EMPTY_POLICY);
  const [saving,     setSaving]     = useState(false);
  const [filterText, setFilterText] = useState('');
  const [deptList,   setDeptList]   = useState([]);

  const fetchPolicies = () =>
    api.get('/leaves/policies').then(r => setPolicies(r.data || [])).catch(() => {});

  useEffect(() => {
    fetchPolicies();
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  const openEdit = (lt) => {
    const existing = policies.find(p => p.leave_type_id === lt.id) || {};
    setForm({
      policy_name:                existing.policy_name                ?? `${lt.leave_name} Policy`,
      accrual_type:               existing.accrual_type               ?? lt.accrual_type               ?? 'manual',
      accrual_days_per_month:     existing.accrual_days_per_month     ?? lt.accrual_days_per_month     ?? '',
      min_notice_days:            existing.min_notice_days            ?? lt.min_notice_days            ?? '',
      max_consecutive_days:       existing.max_consecutive_days       ?? lt.max_consecutive_days       ?? '',
      carry_forward_allowed:      existing.carry_forward_allowed      ?? lt.carry_forward_allowed      ?? false,
      max_carry_forward_days:     existing.max_carry_forward_days     ?? lt.max_carry_forward_days     ?? '',
      carry_forward_expiry_months:existing.carry_forward_expiry_months                                 ?? '',
      sandwich_rule:              existing.sandwich_rule              ?? false,
      include_weekends:           existing.include_weekends           ?? false,
      include_holidays:           existing.include_holidays           ?? false,
      probation_allowed:          existing.probation_allowed          ?? lt.allowed_in_probation       ?? true,
      allow_negative_balance:     existing.allow_negative_balance     ?? lt.allow_negative_balance     ?? false,
      requires_attachment:        existing.requires_attachment        ?? lt.requires_attachment        ?? false,
      requires_medical_cert_days: existing.requires_medical_cert_days ?? lt.requires_medical_cert_days ?? '',
      gender_restriction:         existing.gender_restriction         ?? lt.gender_restriction         ?? '',
      department_restriction:     existing.department_restriction     ?? '',
      is_active:                  existing.is_active                  ?? true,
    });
    setEditModal({ leaveType: lt, policy: existing });
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/leaves/policies/${editModal.leaveType.id}`, form);
      showToast(`Policy saved for ${editModal.leaveType.leave_name}`);
      setEditModal(null);
      fetchPolicies();
    } catch (e) {
      showToast(e?.response?.data?.error || 'Failed to save policy', 'error');
    } finally { setSaving(false); }
  };

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const inputStyle = { width:'100%', padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, outline:'none', boxSizing:'border-box' };

  const filteredTypes = leaveTypes.filter(lt =>
    !filterText || lt.leave_name.toLowerCase().includes(filterText.toLowerCase())
  );

  const configured = (lt) => policies.some(p => p.leave_type_id === lt.id && p.is_active !== false);

  return (
    <div>
      {/* header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexWrap:'wrap', gap:10 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:700, color:'#1f2937' }}>Leave Policy Rules</div>
          <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>Per-company policy overrides for each leave type (sandwich rule, CF, notice, gender restriction, etc.)</div>
        </div>
        <input value={filterText} onChange={e => setFilterText(e.target.value)}
          placeholder="Filter leave types…"
          style={{ padding:'7px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, width:200 }} />
      </div>

      <div className="leads-table-container">
        <table className="leads-table">
          <thead>
            <tr>
              <th>Leave Type</th>
              <th>Accrual</th>
              <th>Notice (days)</th>
              <th>Max Consec.</th>
              <th>Carry Fwd</th>
              <th>Sandwich</th>
              <th>Probation</th>
              <th>Gender</th>
              <th>Status</th>
              {canManage && <th style={{ width:80 }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filteredTypes.length === 0 ? (
              <tr><td colSpan={canManage ? 10 : 9} className="ls-empty">No leave types found</td></tr>
            ) : filteredTypes.map(lt => {
              const pol = policies.find(p => p.leave_type_id === lt.id);
              return (
                <tr key={lt.id}>
                  <td style={{ fontWeight:600 }}>{lt.leave_name}</td>
                  <td style={{ fontSize:11, color:'#6b7280' }}>{pol ? pol.accrual_type || lt.accrual_type || 'manual' : <span style={{ color:'#d1d5db' }}>—</span>}</td>
                  <td>{pol?.min_notice_days ?? lt.min_notice_days ?? <span style={{ color:'#d1d5db' }}>—</span>}</td>
                  <td>{pol?.max_consecutive_days ?? lt.max_consecutive_days ?? <span style={{ color:'#d1d5db' }}>—</span>}</td>
                  <td>{(pol?.carry_forward_allowed ?? lt.carry_forward_allowed) ? <span style={{ color:'#059669' }}>✓ {pol?.max_carry_forward_days ?? lt.max_carry_forward_days ?? '?'}d</span> : '—'}</td>
                  <td>{pol?.sandwich_rule ? <span style={{ color:'#d97706' }}>Yes</span> : '—'}</td>
                  <td>{(pol?.probation_allowed ?? lt.allowed_in_probation) !== false ? <span style={{ color:'#059669' }}>✓</span> : <span style={{ color:'#ef4444' }}>✗</span>}</td>
                  <td style={{ fontSize:11 }}>{(pol?.gender_restriction ?? lt.gender_restriction) || <span style={{ color:'#d1d5db' }}>All</span>}</td>
                  <td>
                    {configured(lt)
                      ? <span style={{ background:'#d1fae5', color:'#065f46', padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:600 }}>Active</span>
                      : <span style={{ background:'#fef3c7', color:'#92400e', padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:600 }}>Default</span>}
                  </td>
                  {canManage && (
                    <td>
                      <button className="ls-btn-icon ls-btn-edit" onClick={() => openEdit(lt)} title="Configure policy">
                        <Settings size={13}/>
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Policy Edit Modal */}
      {editModal && (
        <div className="ls-overlay" onClick={() => setEditModal(null)}>
          <div className="ls-modal" style={{ maxWidth:680, width:'95vw', maxHeight:'90vh', overflowY:'auto' }}
               onClick={e => e.stopPropagation()}>
            <div className="ls-modal-hd">
              <span>Policy Rules — {editModal.leaveType.leave_name}</span>
              <button className="ls-close" onClick={() => setEditModal(null)}><X size={16}/></button>
            </div>
            <div className="ls-modal-body">

              {/* General */}
              <div style={{ fontWeight:700, fontSize:11, color:'#6b7280', textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>General</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:16 }}>
                <div className="ls-field">
                  <label>Policy Name</label>
                  <input style={inputStyle} value={form.policy_name} onChange={e => setF('policy_name', e.target.value)} />
                </div>
                <div className="ls-field">
                  <label>Accrual Type</label>
                  <select style={inputStyle} value={form.accrual_type} onChange={e => setF('accrual_type', e.target.value)}>
                    <option value="manual">Manual</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="yearly">Yearly</option>
                    <option value="joining_date">From Joining Date</option>
                  </select>
                </div>
                {form.accrual_type !== 'manual' && (
                  <div className="ls-field">
                    <label>Days per Month (accrual)</label>
                    <input type="number" min="0" step="0.25" style={inputStyle} value={form.accrual_days_per_month} onChange={e => setF('accrual_days_per_month', e.target.value)} placeholder="e.g. 1.0" />
                  </div>
                )}
                <div className="ls-field">
                  <label>Min Notice Days</label>
                  <input type="number" min="0" style={inputStyle} value={form.min_notice_days} onChange={e => setF('min_notice_days', e.target.value)} placeholder="0 = no requirement" />
                </div>
                <div className="ls-field">
                  <label>Max Consecutive Days</label>
                  <input type="number" min="0" style={inputStyle} value={form.max_consecutive_days} onChange={e => setF('max_consecutive_days', e.target.value)} placeholder="blank = no limit" />
                </div>
                <div className="ls-field">
                  <label>Medical Cert Required After (days)</label>
                  <input type="number" min="0" style={inputStyle} value={form.requires_medical_cert_days} onChange={e => setF('requires_medical_cert_days', e.target.value)} placeholder="e.g. 3" />
                </div>
                <div className="ls-field">
                  <label>Gender Restriction</label>
                  <select style={inputStyle} value={form.gender_restriction || ''} onChange={e => setF('gender_restriction', e.target.value || null)}>
                    <option value="">No restriction (all genders)</option>
                    <option value="F">Female only</option>
                    <option value="M">Male only</option>
                  </select>
                </div>
                <div className="ls-field">
                  <label>Department Restriction</label>
                  <select style={inputStyle} value={form.department_restriction || ''} onChange={e => setF('department_restriction', e.target.value || null)}>
                    <option value="">All Departments</option>
                    {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>

              {/* Carry Forward */}
              <div style={{ fontWeight:700, fontSize:11, color:'#6b7280', textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Carry Forward</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:16 }}>
                <div className="ls-field" style={{ gridColumn:'1/-1' }}>
                  <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer' }}>
                    <input type="checkbox" checked={!!form.carry_forward_allowed} onChange={e => setF('carry_forward_allowed', e.target.checked)} />
                    Carry Forward to next year
                  </label>
                </div>
                {form.carry_forward_allowed && (
                  <>
                    <div className="ls-field">
                      <label>Max Carry Forward Days</label>
                      <input type="number" min="0" style={inputStyle} value={form.max_carry_forward_days} onChange={e => setF('max_carry_forward_days', e.target.value)} placeholder="e.g. 30" />
                    </div>
                    <div className="ls-field">
                      <label>Expiry (months after Jan 1)</label>
                      <input type="number" min="0" max="12" style={inputStyle} value={form.carry_forward_expiry_months} onChange={e => setF('carry_forward_expiry_months', e.target.value)} placeholder="e.g. 3 = expires Apr 1" />
                    </div>
                  </>
                )}
              </div>

              {/* Behaviour Flags */}
              <div style={{ fontWeight:700, fontSize:11, color:'#6b7280', textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Behaviour Flags</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4, marginBottom:16 }}>
                {[
                  ['sandwich_rule',        '🥪 Sandwich Rule (weekends between leave count as leave)'],
                  ['include_weekends',     '📅 Include weekends in day count'],
                  ['include_holidays',     '🏖️ Include holidays in day count'],
                  ['probation_allowed',    '🔓 Allowed during probation'],
                  ['allow_negative_balance','➖ Allow negative balance (LOP)'],
                  ['requires_attachment',  '📎 Attachment required'],
                  ['is_active',            '✅ Policy is active'],
                ].map(([k, label]) => (
                  <label key={k} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', padding:'4px 0' }}>
                    <input type="checkbox" checked={!!form[k]} onChange={e => setF(k, e.target.checked)} />
                    {label}
                  </label>
                ))}
              </div>

            </div>
            <div className="ls-modal-ft">
              <button className="ls-btn-cancel" onClick={() => setEditModal(null)}>Cancel</button>
              <button className="ls-btn-save" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save Policy'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
const LeaveSettings = ({ setPage }) => {
  // hasAnyRole, NOT user.role: roles are many-to-many (user_roles) and `role` is
  // only the PRIMARY mirror, so gating on it alone made this page read-only for
  // anyone holding hr/hr_manager as a secondary role — exactly the case
  // MANAGE_ROLES exists to allow.
  const { hasAnyRole } = useAuth();
  const canManage = hasAnyRole(...MANAGE_ROLES);
  const [activeTab,   setActiveTab]   = useState(0);
  const [leaveTypes,  setLeaveTypes]  = useState([]);
  const [employees,   setEmployees]   = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [toast,       setToast]       = useState(null);
  const [typeModal,   setTypeModal]   = useState(null); // null | 'add' | typeObj
  const [allocModal,      setAllocModal]      = useState(null);
  const [allocForm,       setAllocForm]       = useState(EMPTY_ALLOC);
  const [pendingDeleteType, setPendingDeleteType] = useState(null);
  const [pendingBulkAlloc,  setPendingBulkAlloc]  = useState(false);
  const [allocErr,    setAllocErr]    = useState('');
  const [allocSaving, setAllocSaving] = useState(false);

  const showToast = (msg, type = 'success') => setToast({ msg, type });

  const fetchLeaveTypes  = () => api.get('/leaves/types').then(r => setLeaveTypes(r.data || [])).catch(() => {});
  const fetchEmployees   = () => api.get('/employees').then(r => setEmployees((r.data||[]).filter(e=>!['left','terminated'].includes((e.status||'').toLowerCase())))).catch(()=>{});
  const fetchAllocations = () => api.get('/leaves/allocations').then(r => setAllocations(r.data||[])).catch(()=>{});

  useEffect(() => { fetchLeaveTypes(); fetchEmployees(); fetchAllocations(); }, []);

  const saveType = async (form) => {
    if (typeModal === 'add') {
      await api.post('/leaves/types', form);
      showToast('Leave type added');
    } else {
      await api.put(`/leaves/types/${typeModal.id}`, form);
      showToast('Leave type updated');
    }
    fetchLeaveTypes();
  };

  const deleteType = async () => {
    if (!pendingDeleteType) return;
    const t = pendingDeleteType;
    setPendingDeleteType(null);
    try {
      await api.delete(`/leaves/types/${t.id}`);
      showToast('Leave type deleted');
      fetchLeaveTypes();
    } catch (e) { showToast(e?.response?.data?.error || 'Failed to delete', 'error'); }
  };

  const saveAlloc = async () => {
    if (!allocForm.employee_id)   { setAllocErr('Select an employee'); return; }
    if (!allocForm.leave_type_id) { setAllocErr('Select a leave type'); return; }
    if (!allocForm.allocated_days && allocForm.allocated_days !== 0) { setAllocErr('Enter allocated days'); return; }
    setAllocErr(''); setAllocSaving(true);
    try {
      await api.post('/leaves/allocate', allocForm);
      showToast(allocModal === 'add' ? 'Leave allocated' : 'Allocation updated');
      setAllocModal(null);
      fetchAllocations();
    } catch (e) { setAllocErr(e?.response?.data?.error || 'Failed'); }
    finally { setAllocSaving(false); }
  };

  const bulkAllocate = async () => {
    setPendingBulkAlloc(false);
    try {
      const r = await api.post('/leaves/bulk-allocate', { year: new Date().getFullYear() });
      showToast(`Bulk allocation complete — ${r.data.records} records created`);
      fetchAllocations();
    } catch (e) { showToast(e?.response?.data?.error || 'Bulk allocation failed', 'error'); }
  };

  const tabContent = [
    // ── Tab 0: Leave Types ───────────────────────────────────────────────────
    <div key="types">
      {canManage && (
        <div style={{ display:'flex', justifyContent:'flex-end', gap:10, marginBottom:16 }}>
          <button className="primary-btn" onClick={() => setTypeModal('add')}><Plus size={14}/> Add Leave Type</button>
        </div>
      )}
      <div className="leads-table-container">
        <table className="leads-table">
          <thead>
            <tr>
              <th>Name</th><th>Days</th><th>Accrual</th><th>Carry Fwd</th>
              <th>Half Day</th><th>Encashable</th><th>Paid</th><th>Attachment</th>
              {canManage && <th style={{width:100}}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {leaveTypes.length === 0
              ? <tr><td colSpan={canManage ? 9 : 8} className="ls-empty">No leave types configured</td></tr>
              : leaveTypes.map(t => (
                <tr key={t.id}>
                  <td style={{ fontWeight:600 }}>{t.leave_name}</td>
                  <td>{t.default_days}</td>
                  <td style={{ fontSize:11, color:'#6b7280' }}>{t.accrual_type || 'manual'}{t.accrual_days_per_month > 0 ? ` (${t.accrual_days_per_month}/mo)` : ''}</td>
                  <td>{t.carry_forward_allowed ? <span style={{ color:'#059669' }}>✓ {t.max_carry_forward_days}d</span> : '—'}</td>
                  <td>{t.allow_half_day ? <span style={{ color:'#059669' }}>✓</span> : '—'}</td>
                  <td>{t.is_encashable ? <span style={{ color:'#d97706' }}>✓</span> : '—'}</td>
                  <td>{t.is_paid !== false ? <span style={{ color:'#059669' }}>Paid</span> : <span style={{ color:'#ef4444' }}>Unpaid</span>}</td>
                  <td>{t.requires_attachment ? <span style={{ color:'#6366f1' }}>Reqd</span> : '—'}</td>
                  {canManage && (
                    <td>
                      <div className="ls-actions">
                        <button className="ls-btn-icon ls-btn-edit" onClick={() => setTypeModal(t)}><Pencil size={13}/></button>
                        <button className="ls-btn-icon ls-btn-del"  onClick={() => setPendingDeleteType(t)}><Trash2 size={13}/></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>,

    // ── Tab 1: Allocations ────────────────────────────────────────────────────
    <div key="alloc">
      {canManage && (
        <div style={{ display:'flex', justifyContent:'flex-end', gap:10, marginBottom:16 }}>
          <button className="primary-btn" onClick={() => { setAllocForm(EMPTY_ALLOC); setAllocErr(''); setAllocModal('add'); }}><Plus size={14}/> Allocate Leave</button>
          <button className="primary-btn" onClick={() => setPendingBulkAlloc(true)}><Zap size={14}/> Bulk Allocate</button>
        </div>
      )}
      <div className="leads-table-container">
        <table className="leads-table">
          <thead>
            <tr><th>Employee</th><th>Leave Type</th><th>Allocated</th><th>Used</th><th>Remaining</th><th>Year</th>{canManage && <th style={{width:80}}>Actions</th>}</tr>
          </thead>
          <tbody>
            {allocations.length === 0
              ? <tr><td colSpan={canManage ? 7 : 6} className="ls-empty">No allocations yet. Use "Bulk Allocate" to initialize all employees.</td></tr>
              : allocations.map(a => (
                <tr key={a.id}>
                  <td>{a.employee_name}</td>
                  <td>{a.leave_name}</td>
                  <td style={{ fontWeight:600 }}>{a.allocated_days}</td>
                  <td>{a.used_days}</td>
                  <td style={{ color: Number(a.remaining_days) === 0 ? '#ef4444' : '#10b981', fontWeight:600 }}>{a.remaining_days}</td>
                  <td>{a.year}</td>
                  {canManage && (
                    <td>
                      <button className="ls-btn-icon ls-btn-edit" onClick={() => { setAllocForm({employee_id:a.employee_id,leave_type_id:a.leave_type_id,allocated_days:a.allocated_days,year:a.year}); setAllocErr(''); setAllocModal(a); }}>
                        <Pencil size={13}/>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>,

    // ── Tab 2: Policy Rules (live CRUD editor) ────────────────────────────────
    <PolicyRulesTab key="policy" leaveTypes={leaveTypes} showToast={showToast} canManage={canManage} />,

    // ── Tab 3: Accrual & Carry Forward ───────────────────────────────────────
    <AccrualTab key="accrual" showToast={showToast} canManage={canManage} />,
  ];

  return (
    <div className="leads-page">
      <ConfirmDialog
        open={!!pendingDeleteType}
        title="Delete Leave Type"
        message={pendingDeleteType ? `Delete "${pendingDeleteType.leave_name}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteType}
        onCancel={() => setPendingDeleteType(null)}
      />
      <ConfirmDialog
        open={pendingBulkAlloc}
        title="Bulk Allocate Leave"
        message="Allocate default leave days to all active employees for the current year?"
        confirmLabel="Allocate"
        variant="warning"
        onConfirm={bulkAllocate}
        onCancel={() => setPendingBulkAlloc(false)}
      />
      <Toast msg={toast?.msg} type={toast?.type} onClose={() => setToast(null)} />

      <div className="leads-header">
        <h1>Leave Settings</h1>
        {setPage && canManage && (
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={() => setPage('WorkflowBuilder')}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px', background:'#f5f3ff', color:'#6B3FDB', border:'1px solid #ddd6fe', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
              <Zap size={14}/> Automation Rules
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:0, borderBottom:'2px solid #e5e7eb', marginBottom:24 }}>
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setActiveTab(i)} style={{
            padding:'9px 20px', fontWeight:activeTab===i?700:500, fontSize:13, border:'none', background:'none',
            cursor:'pointer', color:activeTab===i?'#6B3FDB':'#6b7280',
            borderBottom:activeTab===i?'2px solid #6B3FDB':'2px solid transparent', marginBottom:-2,
          }}>{t}</button>
        ))}
      </div>

      {tabContent[activeTab]}

      {/* Leave Type Modal */}
      {typeModal !== null && (
        <LeaveTypeModal
          mode={typeModal === 'add' ? 'add' : 'edit'}
          initial={typeModal === 'add' ? EMPTY_TYPE : { ...EMPTY_TYPE, ...typeModal, default_days: typeModal.default_days ?? typeModal.annual_quota }}
          onSave={saveType}
          onClose={() => setTypeModal(null)}
        />
      )}

      {/* Allocation Modal */}
      {allocModal !== null && (
        <div className="ls-overlay" onClick={() => setAllocModal(null)}>
          <div className="ls-modal" onClick={e => e.stopPropagation()}>
            <div className="ls-modal-hd">
              <span>{allocModal === 'add' ? 'Allocate Leave' : 'Edit Allocation'}</span>
              <button className="ls-close" onClick={() => setAllocModal(null)}><X size={16}/></button>
            </div>
            <div className="ls-modal-body">
              {[
                ['Employee', 'employee_id', employees.map(e => ({ value:e.id, label:`${e.first_name||''} ${e.last_name||''}`.trim() }))],
                ['Leave Type', 'leave_type_id', leaveTypes.map(t => ({ value:t.id, label:t.leave_name }))],
              ].map(([label, key, opts]) => (
                <div key={key} className="ls-field">
                  <label>{label} <span className="ls-req">*</span></label>
                  <select value={allocForm[key]} onChange={e => setAllocForm(f=>({...f,[key]:e.target.value}))} disabled={allocModal !== 'add'}>
                    <option value="">Select…</option>
                    {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              ))}
              <div className="ls-field">
                <label>Allocated Days <span className="ls-req">*</span></label>
                <input type="number" min="0" value={allocForm.allocated_days} onChange={e => setAllocForm(f=>({...f,allocated_days:e.target.value}))} placeholder="e.g. 12" />
              </div>
              <div className="ls-field">
                <label>Year</label>
                <input type="number" value={allocForm.year} onChange={e => setAllocForm(f=>({...f,year:e.target.value}))} />
              </div>
            </div>
            {allocErr && <div className="ls-modal-err">{allocErr}</div>}
            <div className="ls-modal-ft">
              <button className="ls-btn-cancel" onClick={() => setAllocModal(null)}>Cancel</button>
              <button className="ls-btn-save" onClick={saveAlloc} disabled={allocSaving}>{allocSaving ? 'Saving…' : allocModal==='add'?'Allocate':'Save Changes'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LeaveSettings;
