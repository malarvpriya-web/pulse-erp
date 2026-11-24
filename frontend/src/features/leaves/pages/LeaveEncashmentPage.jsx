/**
 * Leave Encashment — HR turns unused encashable leave into money.
 *
 * 2026-11-23 (Leaves review): an approved claim now reaches the employee. On
 * approval it is added as a one-time earning to the payout month's payroll
 * (Payroll → Generate picks it up) and income tax is deducted there at the
 * employee's slab — the flat "10% TDS" shown here before was never deducted
 * anywhere and nothing was paid. The claim turns "Paid" by itself once that
 * month's payroll is approved. Cancel asks for the reason (it sent a fixed
 * "Rejected by HR").
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, CheckCircle, XCircle, RefreshCw, IndianRupee, Info, Landmark } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell } from '@/components/pulse-ui';

const cur = v => v != null ? `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : '—';
const NOW = new Date();
const YEAR = NOW.getFullYear();
const YEARS = [YEAR - 2, YEAR - 1, YEAR];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS_COLOR = {
  pending:   { bg: '#ede9fe', color: '#5b21b6' },
  approved:  { bg: '#fef3c7', color: '#92400e' },
  paid:      { bg: '#d1fae5', color: '#065f46' },
  cancelled: { bg: '#fee2e2', color: '#991b1b' },
};
const sc = s => STATUS_COLOR[(s || '').toLowerCase()] || STATUS_COLOR.pending;
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const lbl = { fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 };
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' };

function CreateModal({ employees, year, tdsPct, onSave, onClose }) {
  const [form, setForm] = useState({
    employee_id: '', leave_type_id: '', year, days_encashed: '', reason: '',
    encashment_month: NOW.getMonth() + 1, encashment_year: YEAR,
  });
  const [eligible, setEligible] = useState([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!form.employee_id) { setEligible([]); return; }
    api.get(`/leave-encashment/eligible/${form.employee_id}`, { params: { year: form.year } })
      .then(r => setEligible(Array.isArray(r.data) ? r.data.filter(e => Number(e.max_encashable_now) > 0) : []))
      .catch(() => setEligible([]));
  }, [form.employee_id, form.year]);

  const elig = eligible.find(e => String(e.leave_type_id) === String(form.leave_type_id));
  const save = async () => {
    if (!form.employee_id) { setErr('Select an employee'); return; }
    if (!form.leave_type_id) { setErr('Select a leave type'); return; }
    if (!(Number(form.days_encashed) > 0)) { setErr('Enter the days to encash'); return; }
    if (elig && Number(form.days_encashed) > Number(elig.max_encashable_now)) { setErr(`At most ${Number(elig.max_encashable_now)} day(s) can be encashed`); return; }
    setSaving(true); setErr('');
    try { await onSave(form); onClose(); }
    catch (e) { setErr(e?.response?.data?.error || e.message || 'Failed'); }
    finally { setSaving(false); }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 28, width: 540, maxWidth: '95vw' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1f2937' }}>New leave encashment</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: 20 }}>×</button>
        </div>
        <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: '#4c1d95', display: 'flex', gap: 8 }}>
          <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Amount = days × (Basic ÷ 26), from the salary in force today. TDS {tdsPct ?? 20}% is deducted (Leave Settings → Leave Rules). Once approved it is paid with the chosen month's salary; it is not counted as PF / ESI wages.</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
          <div>
            <label style={lbl}>Employee *</label>
            <select value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value, leave_type_id: '' }))} style={inp}>
              <option value="">Select employee…</option>
              {employees.map(e => <option key={e.id} value={e.id}>{(e.name || `${e.first_name || ''} ${e.last_name || ''}`).trim()}{(e.office_id || e.employee_code) ? ` (${e.office_id || e.employee_code})` : ''}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>Balance year *</label>
            <select value={form.year} onChange={e => setForm(f => ({ ...f, year: e.target.value, leave_type_id: '' }))} style={inp}>
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Leave type *</label>
          {form.employee_id && eligible.length === 0 ? (
            <div style={{ padding: '10px 14px', background: '#ede9fe', borderRadius: 7, fontSize: 12, color: '#4c1d95' }}>
              No encashable balance for this employee in {form.year}.
            </div>
          ) : (
            <select value={form.leave_type_id} onChange={e => setForm(f => ({ ...f, leave_type_id: e.target.value }))} style={inp} disabled={!form.employee_id}>
              <option value="">Select leave type…</option>
              {eligible.map(e => <option key={e.leave_type_id} value={e.leave_type_id}>{e.leave_name} (up to {Number(e.max_encashable_now)} days)</option>)}
            </select>
          )}
        </div>
        {elig && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>Balance: <strong>{Number(elig.balance_days)}d</strong></span>
            <span>Already encashed this year: <strong>{Number(elig.already_encashed_this_year)}d</strong></span>
            <span>Can encash now: <strong style={{ color: '#059669' }}>{Number(elig.max_encashable_now)}d</strong></span>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
          <div>
            <label style={lbl}>Days *</label>
            <input type="number" min="0.5" step="0.5" max={elig?.max_encashable_now || undefined} value={form.days_encashed}
              onChange={e => setForm(f => ({ ...f, days_encashed: e.target.value }))} style={inp} placeholder="e.g. 5" />
          </div>
          <div>
            <label style={lbl}>Pay with salary of *</label>
            <select value={form.encashment_month} onChange={e => setForm(f => ({ ...f, encashment_month: Number(e.target.value) }))} style={inp}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>&nbsp;</label>
            <select value={form.encashment_year} onChange={e => setForm(f => ({ ...f, encashment_year: Number(e.target.value) }))} style={inp}>
              {[YEAR, YEAR + 1].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={lbl}>Reason</label>
          <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} style={inp} placeholder="e.g. Year-end encashment" />
        </div>
        {err && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="pulse-btn-secondary">Cancel</button>
          <button onClick={save} disabled={saving} className="pulse-btn-primary">{saving ? 'Saving…' : 'Create claim'}</button>
        </div>
      </div>
    </div>
  );
}

// Approve: choose the salary month that pays it (owner, 2026-11-23). A month
// whose payroll is already approved is refused by the server — pick a later one.
function ApproveDialog({ claim, onConfirm, onClose }) {
  const [m, setM] = useState(claim.encashment_month || NOW.getMonth() + 1);
  const [y, setY] = useState(claim.encashment_year || YEAR);
  const [busy, setBusy] = useState(false);
  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: 440, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>Approve encashment</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: '#6b7280' }}>
          {claim.employee_name} · {claim.leave_name} · {Number(claim.days_encashed)} day(s)
          {'gross_amount' in claim && <> · {cur(claim.gross_amount)} less TDS {cur(claim.tds_amount)} = <strong>{cur(claim.net_amount)}</strong></>}
        </p>
        <label style={lbl}>Pay with the salary of</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <select value={m} onChange={e => setM(Number(e.target.value))} style={inp} aria-label="Payout month">
            {MONTHS.map((mm, i) => <option key={mm} value={i + 1}>{mm}</option>)}
          </select>
          <select value={y} onChange={e => setY(Number(e.target.value))} style={inp} aria-label="Payout year">
            {[YEAR - 1, YEAR, YEAR + 1].map(yy => <option key={yy} value={yy}>{yy}</option>)}
          </select>
        </div>
        <p style={{ fontSize: 11, color: '#6b7280', margin: '8px 0 0' }}>Generate that month's payroll afterwards to include it.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button onClick={onClose} className="pulse-btn-secondary">Back</button>
          <button disabled={busy} className="pulse-btn-primary"
            onClick={async () => { setBusy(true); try { await onConfirm(m, y); } finally { setBusy(false); } }}>
            {busy ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReasonDialog({ claim, onConfirm, onClose }) {
  const [reason, setReason] = useState('');
  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: 440, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>Cancel encashment</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>{claim.employee_name} · {claim.leave_name} · {Number(claim.days_encashed)} day(s)</p>
        <label style={lbl}>Reason <span style={{ color: '#ef4444' }}>*</span></label>
        <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} style={{ ...inp, resize: 'vertical' }} placeholder="Tell the employee why" />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button onClick={onClose} className="pulse-btn-secondary">Back</button>
          <button onClick={() => onConfirm(reason)} disabled={!reason.trim()}
            style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: '#ef4444', color: '#fff', fontWeight: 600, fontSize: 13, cursor: reason.trim() ? 'pointer' : 'not-allowed', opacity: reason.trim() ? 1 : 0.5 }}>
            Cancel claim
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LeaveEncashmentPage() {
  const { user, hasPermission } = useAuth();
  const toast = useToast();
  // PC-01 decision 3: a claim for someone else is payroll:edit work.
  const claimsForOthers = typeof hasPermission === 'function' && hasPermission('payroll', 'edit');
  const canDecide = typeof hasPermission === 'function' && hasPermission('leaves', 'approve');
  const ownEmployeeId = user?.employee_id ?? null;

  const [records, setRecords] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [cancelFor, setCancelFor] = useState(null);
  const [approveFor, setApproveFor] = useState(null);
  const [tdsPct, setTdsPct] = useState(null);
  useEffect(() => { api.get('/leaves/settings').then(r => setTdsPct(r.data?.encashment_tds_pct ?? null)).catch(() => {}); }, []);
  const [fYear, setFYear] = useState(YEAR);
  const [fStatus, setFStatus] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { year: fYear };
      if (fStatus) params.status = fStatus;
      const r = await api.get('/leave-encashment', { params });
      if (mounted.current) setRecords(Array.isArray(r.data) ? r.data : []);
    } catch { if (mounted.current) setRecords([]); }
    finally { if (mounted.current) setLoading(false); }
  }, [fYear, fStatus]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/employees').then(r => setEmployees((r.data || []).filter(e => !['left', 'terminated', 'resigned'].includes((e.status || '').toLowerCase())))).catch(() => {});
  }, []);

  const createClaim = async (form) => {
    await api.post('/leave-encashment', form);
    toast.success('Encashment claim created — approve it to send it to payroll');
    load();
  };
  const approve = async (payout_month, payout_year) => {
    const r = approveFor;
    setActing(r.id);
    try {
      const { data } = await api.post(`/leave-encashment/approve/${r.id}`, { payout_month, payout_year });
      toast.success(`Approved — added to the ${MONTHS[(data?.payout_month || 1) - 1]} ${data?.payout_year} payroll. Generate that month's payroll to include it.`);
      setApproveFor(null);
      load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Approval failed'); }
    finally { if (mounted.current) setActing(null); }
  };
  const cancel = async (reason) => {
    const r = cancelFor; setCancelFor(null); setActing(r.id);
    try { await api.post(`/leave-encashment/reject/${r.id}`, { reason }); toast.success('Claim cancelled'); load(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Cancel failed'); }
    finally { if (mounted.current) setActing(null); }
  };

  const amountsWithheld = records.some(r => !('gross_amount' in r));
  const totals = records.reduce((acc, r) => {
    if (r.status === 'approved' || r.status === 'paid') { acc.days += Number(r.days_encashed || 0); acc.amount += Number(r.gross_amount || 0); }
    if (r.status === 'paid') acc.paid += Number(r.gross_amount || 0);
    if (r.status === 'pending') acc.pending++;
    return acc;
  }, { days: 0, amount: 0, paid: 0, pending: 0 });

  return (
    <PageShell dock={
      <PageHero icon={Landmark} eyebrow="Leave" title="Leave Encashment"
        subtitle="Pay unused encashable leave through payroll"
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={load}><RefreshCw size={13} /> Refresh</button>
          <button className="plh-cta" onClick={() => setShowModal(true)}><Plus size={14} /> New Encashment</button>
        </>}
      />
    }>
      {showModal && (
        <CreateModal year={fYear} tdsPct={tdsPct} onSave={createClaim} onClose={() => setShowModal(false)}
          employees={claimsForOthers ? employees : employees.filter(e => ownEmployeeId != null && String(e.id) === String(ownEmployeeId))} />
      )}
      {cancelFor && <ReasonDialog claim={cancelFor} onConfirm={cancel} onClose={() => setCancelFor(null)} />}
      {approveFor && <ApproveDialog claim={approveFor} onConfirm={approve} onClose={() => setApproveFor(null)} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Waiting for approval', value: totals.pending, color: '#5b21b6' },
          { label: `${fYear} days encashed`, value: `${totals.days} days`, color: '#6B3FDB' },
          ...(amountsWithheld ? [] : [
            { label: 'Approved amount', value: cur(totals.amount), color: '#92400e' },
            { label: 'Paid in payroll', value: cur(totals.paid), color: '#059669' },
          ]),
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '14px 18px' }}>
            <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase' }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={fYear} onChange={e => setFYear(e.target.value)} aria-label="Year" style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
          {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        {[['', 'All'], ['pending', 'Pending'], ['approved', 'Approved (in payroll)'], ['paid', 'Paid'], ['cancelled', 'Cancelled']].map(([v, l]) => (
          <button key={v} onClick={() => setFStatus(v)}
            style={{ padding: '6px 14px', borderRadius: 20, border: `1.5px solid ${fStatus === v ? '#6B3FDB' : '#e5e7eb'}`, background: fStatus === v ? '#f5f3ff' : '#fff', color: fStatus === v ? '#6B3FDB' : '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            {l}
          </button>
        ))}
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : records.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
            <IndianRupee size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
            <p style={{ margin: 0 }}>No encashment claims for {fYear}</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Employee', 'Leave type', 'Year', 'Days', 'Rate/day', 'Gross', 'TDS', 'Net', 'Paid with', 'Status', 'Reason', ''].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => {
                const s = sc(r.status);
                const pm = r.payroll_month || r.encashment_month;
                const py = r.payroll_year || r.encashment_year;
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ fontWeight: 600 }}>{r.employee_name || '—'}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{[r.employee_code, r.department].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td style={{ padding: '10px 12px' }}><span style={{ background: '#f5f3ff', color: '#6B3FDB', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>{r.leave_name || '—'}</span></td>
                    <td style={{ padding: '10px 12px', color: '#6b7280' }}>{r.year}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 700 }}>{Number(r.days_encashed)}</td>
                    <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>{cur(r.rate_per_day)}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 600 }}>{cur(r.gross_amount)}</td>
                    <td style={{ padding: '10px 12px', color: '#dc2626', fontSize: 12 }}>
                      {cur(r.tds_amount)}
                      {Number(r.gross_amount) > 0 && 'tds_amount' in r && <div style={{ fontSize: 10, color: '#9ca3af' }}>{Math.round((Number(r.tds_amount) / Number(r.gross_amount)) * 1000) / 10}%</div>}
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 700, color: '#059669' }}>{cur(r.net_amount)}</td>
                    <td style={{ padding: '10px 12px', fontSize: 12 }}>
                      {pm ? `${MONTHS[pm - 1]} ${py} salary` : '—'}
                      {r.payroll_status && <div style={{ fontSize: 10, color: '#6b7280' }}>payroll {r.payroll_status}</div>}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ ...s, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>{(r.status || '').charAt(0).toUpperCase() + (r.status || '').slice(1)}</span>
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: '#6b7280', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.reason}>{r.reason || '—'}</td>
                    <td style={{ padding: '10px 12px' }}>
                      {r.status === 'pending' && canDecide ? (
                        <div style={{ display: 'flex', gap: 5 }}>
                          <button onClick={() => setApproveFor(r)} disabled={acting === r.id}
                            style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 9px', background: '#d1fae5', color: '#065f46', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, opacity: acting === r.id ? 0.5 : 1 }}>
                            <CheckCircle size={11} /> Approve
                          </button>
                          <button onClick={() => setCancelFor(r)} disabled={acting === r.id}
                            style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 9px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, opacity: acting === r.id ? 0.5 : 1 }}>
                            <XCircle size={11} /> Cancel
                          </button>
                        </div>
                      ) : (
                        <span style={{ fontSize: 12, color: '#9ca3af' }}>{r.approved_by_name ? `By ${r.approved_by_name}` : '—'}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </PageShell>
  );
}
