import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import api from '@/services/api/client';

/**
 * Payroll Processing → One-time earnings & deductions (§261).
 *
 * An amount for ONE employee in the selected month: an earning (incentive,
 * reimbursement paid through salary) is part of gross and taxed in that month;
 * a deduction (canteen, fine, notice-pay recovery) comes off net pay and is
 * credited to the account chosen here. Generate Payroll picks them up; a draft
 * made before a change is out of date until generated again. Once the
 * employee's month is approved the amounts are locked.
 */
const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const EMPTY = { employee_id: '', kind: 'earning', label: '', amount: '', account_code: '', reason: '' };
const inp = { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, width: '100%', boxSizing: 'border-box' };

export default function PayrollAdjustmentsPanel({ month, year, period, employees = [], canEdit = false, onChanged, notify }) {
  const [rows, setRows] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { setRows((await api.get('/payroll/adjustments', { params: { month, year } })).data?.data || []); }
    catch (e) { setRows([]); setError(e?.response?.data?.message || 'Could not load the adjustments'); }
  }, [month, year]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (rows?.length) setOpen(true); }, [rows?.length]);
  useEffect(() => {
    if (!canEdit || !open || accounts.length) return;
    api.get('/payroll/adjustments/accounts').then(r => setAccounts(r.data?.data || [])).catch(() => setAccounts([]));
  }, [canEdit, open, accounts.length]);

  const add = async () => {
    if (saving) return;
    setSaving(true); setError(null);
    try {
      const r = await api.post('/payroll/adjustments', { ...form, month, year, amount: Number(form.amount) });
      setForm(f => ({ ...EMPTY, employee_id: f.employee_id, kind: f.kind, account_code: f.account_code }));
      notify?.(r.data?.message || 'Saved');
      await load(); onChanged?.();
    } catch (e) { setError(e?.response?.data?.message || 'Not saved'); }
    finally { setSaving(false); }
  };
  const remove = async (row) => {
    if (!window.confirm(`Remove "${row.label}" (${fmt(row.amount)}) for ${row.employee_name}?`)) return;
    try {
      const r = await api.delete(`/payroll/adjustments/${row.id}`);
      notify?.(r.data?.message || 'Removed');
      await load(); onChanged?.();
    } catch (e) { notify?.(e?.response?.data?.message || 'Could not remove', 'error'); }
  };

  const earnings = (rows || []).filter(r => r.kind === 'earning').reduce((t, r) => t + r.amount, 0);
  const deductions = (rows || []).filter(r => r.kind === 'deduction').reduce((t, r) => t + r.amount, 0);
  const valid = form.employee_id && form.label.trim() && Number(form.amount) > 0 && form.reason.trim().length >= 5
    && (form.kind === 'earning' || form.account_code);
  const payable = employees.filter(e => e.eligible);

  return (
    <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 16px', marginBottom: 16 }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 700, fontSize: 13, color: '#111827' }}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        One-time earnings &amp; deductions — {period}
        {rows?.length ? <span style={{ fontWeight: 500, color: '#6b7280' }}>&nbsp;· {rows.length} entered · +{fmt(earnings)} / −{fmt(deductions)}</span> : null}
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>
            For this month only. An <strong>earning</strong> (incentive, reimbursement paid through salary) is added to gross and taxed this month.
            A <strong>deduction</strong> (canteen, fine, notice-pay recovery) is taken from net pay and credited to the account you choose.
            Generate the payroll again after a change. Locked once the employee&apos;s month is approved.
          </p>
          {rows === null ? <p style={{ fontSize: 12 }}>Loading…</p> : rows.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 12 }}>
              <thead><tr style={{ background: '#f9fafb' }}>{['Employee', 'Type', 'Name', 'Amount', 'Credited to', 'Reason', 'Entered by', ''].map(h => <th key={h} style={{ textAlign: 'left', padding: 6 }}>{h}</th>)}</tr></thead>
              <tbody>{rows.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={{ padding: 6 }}>{r.employee_name} <span style={{ color: '#9ca3af' }}>{r.employee_code}</span></td>
                  <td style={{ padding: 6, color: r.kind === 'earning' ? '#065f46' : '#991b1b' }}>{r.kind === 'earning' ? 'Earning' : 'Deduction'}</td>
                  <td style={{ padding: 6 }}>{r.label}</td>
                  <td style={{ padding: 6 }}>{r.kind === 'earning' ? '+' : '−'}{fmt(r.amount)}</td>
                  <td style={{ padding: 6 }}>{r.account_code ? `${r.account_code} ${r.account_name || ''}` : '—'}</td>
                  <td style={{ padding: 6 }}>{r.reason}</td>
                  <td style={{ padding: 6, color: '#6b7280' }}>{r.created_by_name || '—'}</td>
                  <td style={{ padding: 6 }}>
                    {r.locked ? <span style={{ fontSize: 11, color: '#6b7280' }}>Locked ({r.run_status})</span>
                      : canEdit && <button type="button" title="Remove" onClick={() => remove(r)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626' }}><Trash2 size={14} /></button>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {canEdit && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8, alignItems: 'end' }}>
              <label style={{ fontSize: 11 }}>Employee *
                <select aria-label="Employee" value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))} style={inp}>
                  <option value="">Choose…</option>
                  {payable.map(e => <option key={e.employee_id} value={e.employee_id}>{e.name} ({e.employee_code})</option>)}
                </select>
              </label>
              <label style={{ fontSize: 11 }}>Type *
                <select aria-label="Type" value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value }))} style={inp}>
                  <option value="earning">Earning (added to pay)</option>
                  <option value="deduction">Deduction (taken from pay)</option>
                </select>
              </label>
              <label style={{ fontSize: 11 }}>Name *
                <input value={form.label} maxLength={80} placeholder={form.kind === 'earning' ? 'e.g. Sales incentive' : 'e.g. Canteen recovery'} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} style={inp} />
              </label>
              <label style={{ fontSize: 11 }}>Amount (₹) *
                <input type="number" min="1" step="1" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={inp} />
              </label>
              {form.kind === 'deduction' && (
                <label style={{ fontSize: 11 }}>Credit to account *
                  <select aria-label="Credit to account" value={form.account_code} onChange={e => setForm(f => ({ ...f, account_code: e.target.value }))} style={inp}>
                    <option value="">Choose…</option>
                    {accounts.map(a => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                  </select>
                </label>
              )}
              <label style={{ fontSize: 11, gridColumn: 'span 2' }}>Reason *
                <input value={form.reason} placeholder="Why this amount, for the approver" onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} style={inp} />
              </label>
              <button type="button" className="pulse-btn-primary" onClick={add} disabled={!valid || saving}
                style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
                <Plus size={13} /> {saving ? 'Saving…' : 'Add'}
              </button>
            </div>
          )}
          {!payable.length && canEdit && <p style={{ fontSize: 12, color: '#92400e' }}>No employee is payable for {period} yet (see Eligibility above).</p>}
          {error && <p role="alert" style={{ color: '#b91c1c', fontSize: 12, marginTop: 8 }}>{error}</p>}
        </div>
      )}
    </section>
  );
}
