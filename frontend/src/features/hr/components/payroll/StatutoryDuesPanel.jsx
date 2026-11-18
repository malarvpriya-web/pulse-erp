import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { heldGrant } from '@/config/menuCatalog';
import { localDay } from '@/utils/dateFormatter';

/**
 * Payroll Center → Tax & Statutory → Dues, payments & files.
 *   What an approved month owes PF / ESI / PT / LWF / TDS, by when, and whether
 *   it has been paid; Finance records each payment with its challan reference
 *   (posted Dr payable / Cr bank by the server).
 *   The files to file with: PF ECR, ESI challan, payroll register, statutory bonus.
 * Every amount and every file comes from approved payroll on the server.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KIND = { pf: 'Provident Fund (EPFO)', esi: 'ESI (ESIC)', pt: 'Professional tax', lwf: 'Labour welfare fund', tds: 'Income tax deducted (TDS)' };
const STATUS = { due: ['Due', '#92400e', '#fef3c7'], overdue: ['Overdue', '#991b1b', '#fee2e2'], paid: ['Paid', '#065f46', '#d1fae5'], nothing_due: ['Nothing due', '#6b7280', '#f3f4f6'] };
const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

function lastMonths(n = 13) {
  const t = new Date(); const out = [];
  for (let i = 0; i < n; i++) { const d = new Date(t.getFullYear(), t.getMonth() - i, 1); out.push({ month: d.getMonth() + 1, year: d.getFullYear() }); }
  return out;
}

async function download(path, params, fileName, onError) {
  try {
    const r = await api.get(path, { params, responseType: 'blob' });
    const url = URL.createObjectURL(r.data);
    const a = document.createElement('a'); a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    let body = null;
    try { body = JSON.parse(await e?.response?.data?.text?.()); } catch { /* not JSON */ }
    const who = body?.employees?.length ? ` (${body.employees.map(x => x.employee_code).join(', ')})` : '';
    onError(`${body?.message || 'Download failed'}${who}`);
  }
}

export default function StatutoryDuesPanel() {
  const { permissions } = useAuth();
  const canPay = heldGrant(permissions, 'payroll_payment', 'approve');
  const options = lastMonths();
  const [sel, setSel] = useState(options[1]);
  const [dues, setDues] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [payFor, setPayFor] = useState(null);
  const [bonus, setBonus] = useState(null);
  const tag = `${MONTHS[sel.month - 1]}_${sel.year}`;

  const load = useCallback(async () => {
    setError(null); setDues(null);
    try { setDues((await api.get('/payroll/statutory-dues', { params: sel })).data?.data || null); }
    catch (e) { setError(e?.response?.data?.message || 'Could not load the statutory dues'); }
  }, [sel]);
  useEffect(() => { load(); }, [load]);

  const record = async () => {
    try {
      await api.post('/payroll/remittances', { kind: payFor.kind, month: sel.month, year: sel.year, reference: payFor.reference, paid_on: payFor.paid_on });
      setPayFor(null); setNotice(`${KIND[payFor.kind]} payment recorded and posted to the ledger.`); load();
    } catch (e) { setPayFor(p => ({ ...p, error: e?.response?.data?.message || 'Not recorded' })); }
  };

  // §262: a payment recorded wrongly is cancelled (its journal reversed), then recorded again.
  const cancelPayment = async (i) => {
    const reason = window.prompt(`Cancel the ${KIND[i.kind]} payment record ${i.remittance.challan_reference}?

Its ledger entry is reversed and the levy shows as due again, so you can record the correct payment. Say what was wrong (at least 10 characters):`);
    if (reason == null) return;
    try {
      const r = await api.put(`/payroll/remittances/${i.remittance.id}/cancel`, { reason });
      setNotice(r.data?.message || 'Payment record cancelled.'); load();
    } catch (err) { setError(err?.response?.data?.message || 'Not cancelled'); }
  };

  const bonusYear = sel.month >= 4 ? sel.year : sel.year - 1;
  const loadBonus = async () => {
    try { setBonus((await api.get('/payroll/statutory-bonus', { params: { year: bonusYear } })).data); }
    catch (e) { setError(e?.response?.data?.message || e?.response?.data?.error || 'Could not load the bonus report'); }
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13 }}>Payroll month{' '}
          <select value={`${sel.year}-${sel.month}`} onChange={(e) => { const [y, m] = e.target.value.split('-').map(Number); setSel({ month: m, year: y }); setBonus(null); }}
            style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            {options.map(o => <option key={`${o.year}-${o.month}`} value={`${o.year}-${o.month}`}>{MONTHS[o.month - 1]} {o.year}</option>)}
          </select>
        </label>
        <span style={{ fontSize: 12, color: '#6b7280' }}>Only approved payroll counts. Drafts owe nothing yet.</span>
      </div>
      {error && <div role="alert" style={{ background: '#fef2f2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}
      {notice && <div style={{ background: '#f0fdf4', color: '#166534', padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{notice}</div>}

      <h3 style={{ fontSize: 14, margin: '8px 0' }}>What {MONTHS[sel.month - 1]} {sel.year} owes</h3>
      {!dues ? <p style={{ fontSize: 13, color: '#6b7280' }}>Loading…</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 20 }}>
          <thead><tr style={{ background: '#f9fafb' }}>{['Levy', 'Amount', 'Due by', 'Status', 'Payment', ''].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 10px' }}>{h}</th>)}</tr></thead>
          <tbody>{dues.items.map(i => {
            const [label, fg, bg] = STATUS[i.status];
            return (
              <tr key={i.kind} style={{ borderTop: '1px solid #f3f4f6' }}>
                <td style={{ padding: '8px 10px', fontWeight: 600 }}>{KIND[i.kind]}</td>
                <td style={{ padding: '8px 10px' }}>{fmt(i.amount)}</td>
                <td style={{ padding: '8px 10px' }} title={i.due_basis}>{i.due_date || '—'}<div style={{ fontSize: 11, color: '#6b7280' }}>{i.due_basis}</div></td>
                <td style={{ padding: '8px 10px' }}><span style={{ background: bg, color: fg, padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{label}</span></td>
                <td style={{ padding: '8px 10px', fontSize: 12 }}>
                  {i.remittance ? `${i.remittance.challan_reference} on ${String(i.remittance.paid_on).slice(0, 10)}`
                    : i.kind === 'tds' ? `Deposited ${fmt(i.deposited)} — recorded in ${i.recorded_in}` : '—'}
                  {(i.cancelled || []).map(c => (
                    <div key={c.id} style={{ fontSize: 11, color: '#9ca3af', textDecoration: 'line-through' }} title={`Cancelled: ${c.cancel_reason}`}>
                      {c.challan_reference} on {String(c.paid_on).slice(0, 10)}
                    </div>
                  ))}
                  {(i.cancelled || []).length > 0 && <div style={{ fontSize: 11, color: '#6b7280' }}>Cancelled: {i.cancelled[i.cancelled.length - 1].cancel_reason}</div>}
                </td>
                <td style={{ padding: '8px 10px' }}>
                  {canPay && i.kind !== 'tds' && !i.remittance && i.amount > 0 && (
                    <button className="pulse-btn-secondary" onClick={() => setPayFor({ kind: i.kind, amount: i.amount, reference: '', paid_on: localDay(), error: null })}>Record payment</button>
                  )}
                  {canPay && i.remittance && (
                    <button className="pulse-btn-secondary" title="Recorded wrongly? Cancel it, then record the correct payment" onClick={() => cancelPayment(i)}>Cancel record</button>
                  )}
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      )}

      {payFor && (
        <div role="dialog" aria-label="Record statutory payment" style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <strong>{KIND[payFor.kind]} — {fmt(payFor.amount)}</strong>
          <div style={{ display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12 }}>Challan / transaction reference *<br />
              <input value={payFor.reference} onChange={e => setPayFor(p => ({ ...p, reference: e.target.value, error: null }))} style={{ padding: 6, border: '1px solid #d1d5db', borderRadius: 6, fontFamily: 'monospace' }} /></label>
            <label style={{ fontSize: 12 }}>Paid on *<br />
              <input type="date" max={localDay()} value={payFor.paid_on} onChange={e => setPayFor(p => ({ ...p, paid_on: e.target.value }))} style={{ padding: 6, border: '1px solid #d1d5db', borderRadius: 6 }} /></label>
          </div>
          {payFor.error && <p role="alert" style={{ color: '#b91c1c', fontSize: 12 }}>{payFor.error}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="pulse-btn-primary" onClick={record} disabled={payFor.reference.trim().length < 4}>Record and post</button>
            <button className="pulse-btn-secondary" onClick={() => setPayFor(null)}>Cancel</button>
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 14, margin: '8px 0' }}>Files to file with</h3>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <button className="pulse-btn-secondary" onClick={() => download('/payroll/pf-ecr', sel, `PF_ECR_${tag}.txt`, setError)}><Download size={13} /> PF ECR (EPFO upload)</button>
        <button className="pulse-btn-secondary" onClick={() => download('/payroll/esi-challan', sel, `ESI_Challan_${tag}.csv`, setError)}><Download size={13} /> ESI contribution sheet</button>
        <button className="pulse-btn-secondary" onClick={() => download('/payroll/register', { ...sel, basis: 'final' }, `Payroll_Register_${tag}_FINAL.csv`, setError)}><Download size={13} /> Payroll register (approved)</button>
        <button className="pulse-btn-secondary" onClick={() => download('/payroll/register', { ...sel, basis: 'preparation' }, `Payroll_Register_${tag}_with_drafts.csv`, setError)}><Download size={13} /> Register incl. drafts</button>
        <button className="pulse-btn-secondary" onClick={loadBonus}>Statutory bonus report {bonusYear}-{bonusYear + 1}</button>
      </div>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
        A file is refused, with the reason, when something it needs is missing (an unapproved month, a missing UAN or ESI number). Upload the ECR on the EPFO portal and enter the ESI amounts on the ESIC portal.
      </p>
      {bonus && (
        <div style={{ overflowX: 'auto' }}>
          <p style={{ fontSize: 13 }}><strong>{bonus.eligible_count}</strong> of {bonus.total_employees} eligible · minimum {fmt(bonus.total_min_bonus)} · maximum {fmt(bonus.total_max_bonus)} (figures from Settings → Statutory rules → Statutory bonus report)</p>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>Each month counts the Basic actually paid that month, up to {bonus.calc_ceiling_basis || fmt(bonus.calc_wage_ceiling)} (₹7,000 or the minimum wage, whichever is higher). The minimum bonus is never below ₹100; at least 30 working days in the year are needed.</p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: '#f9fafb' }}>{['Employee', 'Months', 'Days worked', 'Average Basic', 'Bonus wages', 'Eligible', 'Minimum', 'Maximum'].map(h => <th key={h} style={{ textAlign: 'left', padding: 6 }}>{h}</th>)}</tr></thead>
            <tbody>{bonus.employees.map(e => (
              <tr key={e.employee_id}><td style={{ padding: 6 }}>{e.employee_name} <span style={{ color: '#9ca3af' }}>{e.emp_code}</span></td><td style={{ padding: 6 }}>{e.months_worked}</td>
                <td style={{ padding: 6 }}>{e.worked_days ?? '—'}</td>
                <td style={{ padding: 6 }}>{fmt(e.avg_basic)}</td><td style={{ padding: 6 }}>{fmt(e.bonus_wages)}</td><td style={{ padding: 6 }}>{e.eligible ? 'Yes' : e.reason}</td><td style={{ padding: 6 }}>{fmt(e.min_bonus)}</td><td style={{ padding: 6 }}>{fmt(e.max_bonus)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
