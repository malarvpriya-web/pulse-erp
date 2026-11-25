import React, { useEffect, useState } from 'react';
import api from '@/services/api/client';

// Change History tab of Leave Settings (2026-11-25): who changed a leave type,
// an allocation or a leave rule, and every accrual / carry-forward / expiry
// run — from audit_logs via GET /leaves/settings/history.

const KINDS = [
  ['', 'All changes'], ['types', 'Leave types'], ['allocations', 'Allocations'],
  ['rules', 'Leave rules'], ['runs', 'Accrual & carry forward runs'],
];

const FIELD_LABEL = {
  leave_name: 'Name', default_days: 'Default days', description: 'Description',
  accrual_type: 'Accrual', accrual_days_per_month: 'Days / month', days_worked_per_leave_day: 'Days worked per leave day',
  carry_forward_allowed: 'Carry forward', max_carry_forward_days: 'Max carry forward', carry_forward_expiry_months: 'Carried days expire (months)',
  is_encashable: 'Encashable', max_encash_days_per_year: 'Max encash / year', allow_half_day: 'Half day',
  requires_attachment: 'Attachment required', requires_medical_cert_days: 'Medical cert after (days)',
  allow_negative_balance: 'Negative balance', min_notice_days: 'Min notice', max_consecutive_days: 'Max consecutive',
  gender_restriction: 'Gender', is_paid: 'Paid', is_lop_type: 'Loss of Pay type', l2_required: 'Dept head (L2)',
  is_active: 'Active', allocated_days: 'Allocated days', encashment_tds_pct: 'Encashment TDS %', escalation_days: 'Escalate after (days)',
};
// The old row says annual_quota, the form sends default_days.
const ALIAS = { default_days: 'annual_quota' };

const show = (v) => {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? String(n) : String(v);
};
const same = (a, b) => show(a) === show(b) || (Number(a || 0) === 0 && Number(b || 0) === 0 && !/[a-z]/i.test(`${a}${b}`));

function changes(oldD, newD) {
  if (!oldD || !newD) return [];
  return Object.keys(FIELD_LABEL)
    .filter(k => k in newD)
    .map(k => [k, oldD[k] !== undefined ? oldD[k] : oldD[ALIAS[k]], newD[k]])
    .filter(([, o, n]) => !same(o, n))
    .map(([k, o, n]) => `${FIELD_LABEL[k]}: ${show(o)} → ${show(n)}`);
}

const ACTION = { create: 'Added', update: 'Changed', delete: 'Deleted', correction: 'Corrected', bulk_allocate: 'Bulk allocated', run: 'Ran', initialize: 'Set up' };

function describe(r) {
  const n = r.new_data || {}, o = r.old_data || {};
  const who = r.employee_name ? `${r.employee_name}${r.employee_code ? ` · ${r.employee_code}` : ''}` : '';
  switch (r.record_type) {
    case 'leave_type':
      return { what: `${ACTION[r.action] || r.action} leave type "${r.leave_name || `#${r.record_id}`}"`,
        detail: r.action === 'update' ? changes(o, n) : r.action === 'create' ? [`${show(n.default_days)} days / year`] : [] };
    case 'leave_balance':
      if (r.action === 'bulk_allocate') return { what: `Bulk allocated ${n.year}`, detail: [`${show(n.records)} new balance(s)${n.existing != null ? `, ${n.existing} already there` : ''}`] };
      return { what: `${ACTION[r.action] || r.action} allocation — ${who || 'employee'} · ${r.balance_type || 'leave'} ${r.year || ''}`.trim(),
        detail: [r.action === 'delete' ? `${show(o.allocated_days)} days removed`
          : r.action === 'create' ? `${show(n.allocated_days)} days` : `Allocated days: ${show(o.allocated_days)} → ${show(n.allocated_days)}`,
          n.reason].filter(Boolean) };
    case 'leave_settings':
      return { what: 'Changed leave rules', detail: changes(o, n) };
    case 'leave_accrual':
      return { what: `Accrual run ${show(n.month)}/${show(n.year)}`, detail: [`${show(n.accrued)} credited, ${show(n.skipped)} already done${Number(n.failed) ? `, ${n.failed} failed` : ''}`] };
    case 'leave_carry_forward':
      return { what: `Carry forward ${show(n.from_year)} → ${show(n.to_year)}`, detail: [`${show(n.records_carried)} balance(s) carried`] };
    case 'leave_expiry':
      return { what: `Carried-forward expiry ${show(n.year)}`, detail: [`${show(n.records_expired)} balance(s) expired`] };
    default:
      return { what: `${r.action} ${r.record_type}`, detail: [] };
  }
}

const when = (d) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function LeaveSettingsHistory() {
  const [kind, setKind] = useState('');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let live = true;
    setRows(null); setErr('');
    api.get('/leaves/settings/history', { params: { kind: kind || undefined, limit: 300 } })
      .then(r => { if (live) setRows(r.data || []); })
      .catch(e => { if (live) { setRows([]); setErr(e?.response?.data?.error || 'Could not load the history'); } });
    return () => { live = false; };
  }, [kind]);

  const items = (rows || [])
    // An allocation saved without a change (logged before 2026-11-25) says nothing.
    .filter(r => !(r.record_type === 'leave_balance' && r.action === 'update'
      && r.old_data && r.new_data && Number(r.old_data.allocated_days) === Number(r.new_data.allocated_days)))
    .map(r => ({ r, ...describe(r) }))
    .filter(({ r, what, detail }) => !search || [what, r.changed_by, ...detail].join(' ').toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search change, person…"
          style={{ flex: '1 1 220px', padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
        <select value={kind} onChange={e => setKind(e.target.value)} aria-label="Kind of change"
          style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
          {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {rows && <span style={{ fontSize: 12, color: '#6b7280' }}>{items.length} change(s){rows.length >= 300 ? ' · latest 300' : ''}</span>}
      </div>
      {err && <div className="ls-modal-err" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="leads-table-container">
        <table className="leads-table">
          <thead><tr><th style={{ width: 140 }}>When</th><th style={{ width: 170 }}>By</th><th>Change</th><th>Details</th></tr></thead>
          <tbody>
            {rows === null
              ? <tr><td colSpan={4} className="ls-empty">Loading…</td></tr>
              : items.length === 0
                ? <tr><td colSpan={4} className="ls-empty">No changes recorded{kind || search ? ' for this filter' : ''}.</td></tr>
                : items.map(({ r, what, detail }) => (
                  <tr key={r.id}>
                    <td style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{when(r.created_at)}</td>
                    <td style={{ fontSize: 13 }}>{r.changed_by}</td>
                    <td style={{ fontWeight: 600, fontSize: 13 }}>{what}</td>
                    <td style={{ fontSize: 12, color: '#4b5563' }}>{detail.length ? detail.map((d, i) => <div key={i}>{d}</div>) : '—'}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
        Saturday weekly-off changes are recorded with the attendance settings (Attendance → Configuration).
      </div>
    </div>
  );
}
