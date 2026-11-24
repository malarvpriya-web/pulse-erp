import React, { useState, useEffect } from 'react';
import { Pencil, Trash2, X, Plus, Zap, SlidersHorizontal } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import '../../crm/pages/Leads.css';
import './LeaveSettings.css';
import { PageHero, PageShell } from '@/components/pulse-ui';
import SaturdayOffPicker from '../components/SaturdayOffPicker';

// Policy Rules tab removed 2026-11-23: it saved to leave_policies, which
// nothing read. Every rule that is enforced lives on the leave type itself.
const TABS = ['Leave Types', 'Allocations', 'Accrual & Carry Forward', 'Leave Rules'];

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
  is_paid: true, is_lop_type: false, l2_required: false, is_active: true,
  carry_forward_expiry_months: '', max_encash_days_per_year: '', days_worked_per_leave_day: 20,
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

// A labelled form row. Declared at module level on purpose: defined inside
// LeaveTypeModal it was a NEW component on every render, so React remounted
// each input on every keystroke — focus jumped to the autoFocus name box and
// "15" typed in Default Days became Days "1", Name "5" (2026-11-24).
function Field({ label, children, req }) {
  return (
    <div className="ls-field" style={{ marginBottom:12 }}>
      <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>
        {label}{req && <span className="ls-req"> *</span>}
      </label>
      {children}
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
                <option value="monthly">Monthly accrual (days per month, on the 1st)</option>
                <option value="yearly">Yearly credit (whole year in January)</option>
                <option value="joining_date">Yearly credit, pro-rated from joining</option>
                <option value="worked">1 day for every N days worked (Factories Act)</option>
                {form.accrual_type === 'quarterly' && <option value="quarterly">Quarterly (not applied automatically)</option>}
              </select>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                {form.accrual_type === 'monthly' && 'Credited automatically on the 1st of each month. A month missed while the server was off is caught up.'}
                {(form.accrual_type === 'yearly' || form.accrual_type === 'joining_date') && 'Default Days / Year is credited once a year in January. Someone joining mid-year gets the share for the months left.'}
                {form.accrual_type === 'manual' && 'New balances start at Default Days / Year; HR changes them by hand.'}
                {form.accrual_type === 'worked' && `After each month ends, days worked (present, half day as ½, paid leave) ÷ ${form.days_worked_per_leave_day || 20} are credited.`}
                {' '}A change applies to balances not yet credited this year.
              </div>
            </Field>
            {form.accrual_type === 'worked' && (
              <Field label="1 day of leave for every … days worked"><input type="number" min="1" step="1" style={inputStyle} value={form.days_worked_per_leave_day ?? 20} onChange={e => setF('days_worked_per_leave_day', e.target.value)} placeholder="20" /></Field>
            )}
            {form.accrual_type === 'monthly' && (
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
              {checkRow('is_lop_type',            '⚠️ Loss of Pay type')}
              {checkRow('l2_required',            '🧑‍💼 Needs department head (L2) approval')}
              {checkRow('is_active',              '✅ Active (employees can apply)')}
            </div>
            <div style={{ fontSize:11, color:'#6b7280', marginTop:6 }}>
              Company rules for every type: during probation and notice period only Loss of Pay can be taken;
              weekends/holidays inside a leave are charged as Loss of Pay (clubbing). Approval is always
              Manager → HR, with the department head in between when ticked above.
            </div>
          </div>

          {form.carry_forward_allowed && (
            <div style={{ marginTop:12, display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <Field label="Max Carry Forward Days"><input type="number" min="0" style={inputStyle} value={form.max_carry_forward_days} onChange={e => setF('max_carry_forward_days', e.target.value)} placeholder="e.g. 30" /></Field>
              <Field label="Carried days expire after (months from 1 Jan)"><input type="number" min="0" max="12" style={inputStyle} value={form.carry_forward_expiry_months ?? ''} onChange={e => setF('carry_forward_expiry_months', e.target.value)} placeholder="blank = never expire" /></Field>
            </div>
          )}
          {form.is_encashable && (
            <div style={{ marginTop:12, display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <Field label="Max Encash Days / Year"><input type="number" min="0" style={inputStyle} value={form.max_encash_days_per_year || ''} onChange={e => setF('max_encash_days_per_year', e.target.value)} placeholder="blank = no yearly cap" /></Field>
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
      {card('Monthly Accrual', 'Credits each leave type by its accrual setting (monthly: days per month; yearly: the year\'s days in January). This runs by itself on the 1st of every month — use this only to catch up a month that was missed. Running it twice does not credit twice.',
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
      {card('Year-End Carry Forward', 'Moves unused days of types with "Carry Forward" ticked into the next year, up to each type\'s Max Carry Forward Days.',
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
      {card('Expire Carried-Forward Days', 'Removes carried-forward days once a type\'s "expire after (months)" has passed. Also runs by itself on the 1st of every month.',
        <button disabled={!!running} onClick={() => run('expire', {})}
          style={{ padding:'8px 20px', background:'#ef4444', color:'#fff', border:'none', borderRadius:8, fontWeight:600, fontSize:13, cursor:'pointer', opacity:running?0.6:1 }}>
          {running==='expire' ? 'Expiring…' : 'Run Expiry'}
        </button>
      )}
    </div>
  );
}

// ── Leave Rules Tab (owner, 2026-11-23) ───────────────────────────────────────
// Company-wide rules: tax on leave encashment, and which Saturdays are off.
function LeaveRulesTab({ showToast, canManage }) {
  const [rules, setRules] = useState(null);          // GET /leaves/settings
  const [att, setAtt] = useState(null);              // GET /attendance/general-settings (working days)
  const [tds, setTds] = useState('');
  const [esc, setEsc] = useState('');
  const [sat, setSat] = useState(null);              // { working_days, saturday_off_weeks }
  const [busy, setBusy] = useState('');

  const load = () => {
    api.get('/leaves/settings').then(r => { setRules(r.data); setTds(String(r.data?.encashment_tds_pct ?? 20)); setEsc(String(r.data?.escalation_days ?? 3)); }).catch(() => setRules({}));
    api.get('/attendance/general-settings').then(r => {
      setAtt(r.data); setSat({ working_days: r.data?.working_days || [], saturday_off_weeks: r.data?.saturday_off_weeks || [] });
    }).catch(() => setAtt(null));
  };
  useEffect(load, []);

  const saveTds = async () => {
    setBusy('tds');
    try {
      await api.put('/leaves/settings', { encashment_tds_pct: Number(tds) });
      showToast(`Encashment TDS set to ${Number(tds)}%`); load();
    } catch (e) { showToast(e?.response?.data?.error || 'Could not save', 'error'); }
    finally { setBusy(''); }
  };
  const saveEsc = async () => {
    setBusy('esc');
    try {
      await api.put('/leaves/settings', { escalation_days: Number(esc) });
      showToast(Number(esc) ? `Requests are escalated after ${Number(esc)} day(s) at one step` : 'Escalation switched off'); load();
    } catch (e) { showToast(e?.response?.data?.error || 'Could not save', 'error'); }
    finally { setBusy(''); }
  };
  const saveSat = async () => {
    setBusy('sat');
    try {
      await api.put('/attendance/general-settings', sat);
      showToast('Saturdays saved — attendance, payroll and leave day counts use it from now'); load();
    } catch (e) { showToast(e?.response?.data?.error || 'Could not save', 'error'); }
    finally { setBusy(''); }
  };

  const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 20 };
  const satDirty = att && sat && (JSON.stringify([...(att.working_days || [])].sort()) !== JSON.stringify([...sat.working_days].sort())
    || JSON.stringify(att.saturday_off_weeks || []) !== JSON.stringify(sat.saturday_off_weeks));

  return (
    <div>
      <div style={card}>
        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#1f2937' }}>Weekly off — Saturdays</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: '#6b7280' }}>
          Choose 2nd and/or 4th Saturday (or any) as off. Leave days, clubbing, attendance absence and payroll working days all follow this.
          Sunday and the other weekly offs are set in Attendance → Configuration → General Settings.
        </p>
        {!sat ? <div style={{ fontSize: 13, color: '#9ca3af' }}>Loading…</div> : (
          <>
            <SaturdayOffPicker workingDays={sat.working_days} weeks={sat.saturday_off_weeks} disabled={!canManage}
              onChange={v => setSat(s => ({ ...s, ...v }))} />
            {canManage && (
              <button className="primary-btn" style={{ marginTop: 12 }} disabled={!satDirty || busy === 'sat'} onClick={saveSat}>
                {busy === 'sat' ? 'Saving…' : 'Save Saturdays'}
              </button>
            )}
          </>
        )}
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#1f2937' }}>Tax on leave encashment</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: '#6b7280' }}>
          Flat income-tax % deducted when an encashment is paid in payroll (instead of the employee's slab). Change it when the government rule changes;
          new claims use the new %. Encashment is not counted as PF / ESI wages.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="number" min="0" max="100" step="0.5" value={tds} disabled={!canManage} onChange={e => setTds(e.target.value)}
            aria-label="Encashment TDS percent" style={{ width: 90, padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13 }} />
          <span style={{ fontSize: 13, color: '#374151' }}>%</span>
          {canManage && (
            <button className="primary-btn" disabled={busy === 'tds' || tds === '' || Number(tds) === Number(rules?.encashment_tds_pct)} onClick={saveTds}>
              {busy === 'tds' ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>

      <div style={card}>
        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#1f2937' }}>Escalate a waiting request</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: '#6b7280' }}>
          A request that waits this many days at one step is escalated once for that step (weekdays, 09:00): at the manager step the manager's
          own manager and HR are told and HR may then decide it; at the department-head step the department's heads and HR; at the HR step HR and admins.
          0 = never.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="number" min="0" max="30" step="1" value={esc} disabled={!canManage} onChange={e => setEsc(e.target.value)}
            aria-label="Escalate after days" style={{ width: 90, padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13 }} />
          <span style={{ fontSize: 13, color: '#374151' }}>days</span>
          {canManage && (
            <button className="primary-btn" disabled={busy === 'esc' || esc === '' || Number(esc) === Number(rules?.escalation_days ?? 3)} onClick={saveEsc}>
              {busy === 'esc' ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>

      <div style={{ ...card, background: '#f9fafb' }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 700, color: '#1f2937' }}>Always applied</h3>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#4b5563', lineHeight: 1.8 }}>
          <li>During probation and the notice period, every leave is Loss of Pay — paid leave cannot be applied.</li>
          <li>Weekly offs and holidays inside a leave (clubbing) are charged as Loss of Pay.</li>
          <li>Approval: Manager → HR, with the department head in between for types that need one.</li>
          <li>Earned Leave by days worked: set a type's accrual to "1 day for every N days worked" (Factories Act: 20).</li>
        </ul>
      </div>
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
  const [allocYear,   setAllocYear]   = useState(new Date().getFullYear());
  const [allocSearch, setAllocSearch] = useState('');
  const [allocType,   setAllocType]   = useState('');

  const showToast = (msg, type = 'success') => setToast({ msg, type });

  const fetchLeaveTypes  = () => api.get('/leaves/types', { params: { include_inactive: 1 } }).then(r => setLeaveTypes(r.data || [])).catch(() => {});
  const fetchEmployees   = () => api.get('/employees').then(r => setEmployees((r.data||[]).filter(e=>!['left','terminated'].includes((e.status||'').toLowerCase())))).catch(()=>{});
  const fetchAllocations = (y = allocYear) => api.get('/leaves/allocations', { params: { year: y } }).then(r => setAllocations(r.data||[])).catch(()=>{});

  useEffect(() => { fetchLeaveTypes(); fetchEmployees(); }, []);
  useEffect(() => { fetchAllocations(allocYear); }, [allocYear]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeTypes = leaveTypes.filter(t => t.is_active !== false);
  const shownAllocations = allocations.filter(a =>
    (!allocType || String(a.leave_type_id) === String(allocType)) &&
    (!allocSearch || [a.employee_name, a.employee_code, a.department].some(v => String(v || '').toLowerCase().includes(allocSearch.toLowerCase()))));

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
      const r = await api.post('/leaves/bulk-allocate', { year: allocYear });
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
              <th>Half Day</th><th>Encashable</th><th>Paid</th><th>Attachment</th><th>L2</th><th>Active</th>
              {canManage && <th style={{width:100}}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {leaveTypes.length === 0
              ? <tr><td colSpan={canManage ? 11 : 10} className="ls-empty">No leave types configured</td></tr>
              : leaveTypes.map(t => (
                <tr key={t.id} style={t.is_active === false ? { opacity: 0.55 } : undefined}>
                  <td style={{ fontWeight:600 }}>{t.leave_name}</td>
                  <td>{t.default_days}</td>
                  <td style={{ fontSize:11, color:'#6b7280' }}>{t.accrual_type === 'worked' ? `1 per ${Number(t.days_worked_per_leave_day || 20)} days worked` : (t.accrual_type || 'manual')}{t.accrual_type === 'monthly' && t.accrual_days_per_month > 0 ? ` (${t.accrual_days_per_month}/mo)` : ''}</td>
                  <td>{t.carry_forward_allowed ? <span style={{ color:'#059669' }}>✓ {t.max_carry_forward_days}d</span> : '—'}</td>
                  <td>{t.allow_half_day ? <span style={{ color:'#059669' }}>✓</span> : '—'}</td>
                  <td>{t.is_encashable ? <span style={{ color:'#6d28d9' }}>✓</span> : '—'}</td>
                  <td>{t.is_paid !== false ? <span style={{ color:'#059669' }}>Paid</span> : <span style={{ color:'#ef4444' }}>Unpaid</span>}</td>
                  <td>{t.requires_attachment ? <span style={{ color:'#6B3FDB' }}>Reqd</span> : t.requires_medical_cert_days > 0 ? <span style={{ color:'#6B3FDB' }}>&gt;{t.requires_medical_cert_days}d</span> : '—'}</td>
                  <td>{t.l2_required ? <span style={{ color:'#6B3FDB' }}>✓</span> : '—'}</td>
                  <td>{t.is_active !== false ? <span style={{ color:'#059669' }}>Yes</span> : <span style={{ color:'#6b7280' }}>No</span>}</td>
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
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'center' }}>
        <input value={allocSearch} onChange={e => setAllocSearch(e.target.value)} placeholder="Search employee, code, department…"
          style={{ flex:'1 1 220px', padding:'7px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13 }} />
        <select value={allocType} onChange={e => setAllocType(e.target.value)}
          style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13 }}>
          <option value="">All leave types</option>
          {activeTypes.map(t => <option key={t.id} value={t.id}>{t.leave_name}</option>)}
        </select>
        <select value={allocYear} onChange={e => setAllocYear(Number(e.target.value))}
          style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13 }}>
          {[0, 1, 2].map(k => new Date().getFullYear() + 1 - k).map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <span style={{ fontSize:12, color:'#6b7280' }}>{shownAllocations.length} of {allocations.length}</span>
        {canManage && (
          <div style={{ display:'flex', gap:10, marginLeft:'auto' }}>
            <button className="primary-btn" onClick={() => { setAllocForm({ ...EMPTY_ALLOC, year: allocYear }); setAllocErr(''); setAllocModal('add'); }}><Plus size={14}/> Allocate Leave</button>
            <button className="primary-btn" onClick={() => setPendingBulkAlloc(true)}><Zap size={14}/> Bulk Allocate</button>
          </div>
        )}
      </div>
      <div className="leads-table-container">
        <table className="leads-table">
          <thead>
            <tr><th>Employee</th><th>Leave Type</th><th>Allocated</th><th>Carried Fwd</th><th>Used</th><th>Pending</th><th>Encashed</th><th>Remaining</th><th>Year</th>{canManage && <th style={{width:80}}>Actions</th>}</tr>
          </thead>
          <tbody>
            {shownAllocations.length === 0
              ? <tr><td colSpan={canManage ? 10 : 9} className="ls-empty">{allocations.length ? 'No allocation matches the filters.' : `No allocations for ${allocYear}. Use "Bulk Allocate" to set up all employees.`}</td></tr>
              : shownAllocations.map(a => (
                <tr key={a.id}>
                  <td>{a.employee_name}{a.employee_code ? <span style={{ color:'#9ca3af', fontSize:11 }}> · {a.employee_code}</span> : null}</td>
                  <td>{a.leave_name}</td>
                  <td style={{ fontWeight:600 }}>{Number(a.allocated_days)}</td>
                  <td>{Number(a.carried_forward_days) || '—'}</td>
                  <td>{Number(a.used_days)}</td>
                  <td>{Number(a.pending_days) || '—'}</td>
                  <td>{Number(a.encashed_days) || '—'}</td>
                  <td style={{ color: Number(a.remaining_days) <= 0 ? '#ef4444' : '#10b981', fontWeight:600 }}>{Number(a.remaining_days)}</td>
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

    // ── Tab 2: Accrual & Carry Forward ───────────────────────────────────────
    <AccrualTab key="accrual" showToast={showToast} canManage={canManage} />,

    // ── Tab 3: Leave Rules ───────────────────────────────────────────────────
    <LeaveRulesTab key="rules" showToast={showToast} canManage={canManage} />,
  ];

  return (
    <PageShell dock={
      <PageHero
        icon={SlidersHorizontal}
        eyebrow="Leave"
        title="Leave Settings"
        actions={setPage && canManage && (
          <div style={{ display:'flex', gap:10 }}>
            <button className="plh-cta" onClick={() => setPage('WorkflowBuilder')}>
              <Zap size={14}/> Automation Rules
            </button>
          </div>
        )}
      />
    }>
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
        message={`Allocate default leave days to all active employees for ${allocYear}? Existing balances are not changed.`}
        confirmLabel="Allocate"
        variant="warning"
        onConfirm={bulkAllocate}
        onCancel={() => setPendingBulkAlloc(false)}
      />
      <Toast msg={toast?.msg} type={toast?.type} onClose={() => setToast(null)} />



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
                ['Leave Type', 'leave_type_id', activeTypes.map(t => ({ value:t.id, label:t.leave_name }))],
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
                {/* Read-only on edit: a changed year saved a NEW allocation for that
                    year and left this one as it was. */}
                <input type="number" value={allocForm.year} disabled={allocModal !== 'add'} onChange={e => setAllocForm(f=>({...f,year:e.target.value}))} />
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
    </PageShell>
  );
};

export default LeaveSettings;
