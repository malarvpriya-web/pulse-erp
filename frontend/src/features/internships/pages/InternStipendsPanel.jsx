// Internships → Stipends (HR audit 2026-11-16, 11-03 F-22). The stipend on an
// intern record was never paid: nothing read it. HR raises a month's dues
// (internships:edit), may correct an amount with a reason, and Finance records
// each payment with its UTR, value date and the company bank account
// (payroll_payment:approve; never the person who raised it). Backend:
// /intern-stipends (modules/hr/internStipends.routes.js). No accounting
// journal is posted from here; Finance books the expense in Accounting.
import { useCallback, useEffect, useState } from 'react';
import api from '@/services/api/client';
import { LoadError } from '@/components/pulse-ui';
import { fmt } from '@/utils/format';
import { fmtDate, localDay } from '@/utils/dateFormatter';

const thisMonth = () => localDay().slice(0, 7);
const cell = { padding: '8px', fontSize: 13, borderTop: '1px solid #f3f4f6', verticalAlign: 'top' };
const head = { padding: '6px 8px', fontSize: 12, color: '#6b7280', textAlign: 'left' };
const tone = { due: '#b45309', paid: '#047857', cancelled: '#6b7280' };

export default function InternStipendsPanel() {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [editing, setEditing] = useState(null);   // { id, amount, reason, mode: 'adjust'|'cancel'|'pay', utr, value_date, bank_account_id }
  const [banks, setBanks] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData((await api.get('/intern-stipends', { params: { month } })).data); }
    catch (e) { setError(e?.response?.data?.error || 'Stipends could not be loaded.'); }
  }, [month]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!data?.can_pay || banks) return;
    api.get('/finance/bank-accounts').then(r => setBanks((r.data?.data ?? r.data ?? []).filter(b => b.is_active !== false))).catch(() => setBanks([]));
  }, [data, banks]);

  const run = async (fn, ok) => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: typeof ok === 'function' ? ok(r) : ok }); setEditing(null); await load(); }
    catch (e) { setMsg({ ok: false, text: e?.response?.data?.error || 'The request failed.' }); }
    finally { setBusy(false); }
  };
  const generate = () => run(() => api.post('/intern-stipends/generate', { month }),
    (r) => `${r.data.raised} stipend(s) raised for ${month}.${r.data.skipped?.length ? ` Skipped: ${r.data.skipped.join('; ')}.` : ''}`);
  const save = () => {
    const e = editing;
    if (e.mode === 'adjust') return run(() => api.patch(`/intern-stipends/${e.id}`, { amount: Number(e.amount), reason: e.reason }), 'Amount corrected.');
    if (e.mode === 'cancel') return run(() => api.post(`/intern-stipends/${e.id}/cancel`, { reason: e.reason }), 'Stipend cancelled.');
    return run(() => api.post(`/intern-stipends/${e.id}/pay`, { utr: e.utr, value_date: e.value_date, bank_account_id: Number(e.bank_account_id) }), 'Payment recorded.');
  };

  const rows = data?.rows || [];
  const total = rows.filter(r => r.status !== 'cancelled').reduce((s, r) => s + Number(r.amount || 0), 0);

  return (
    <div style={{ padding: 4 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ fontSize: 12 }}>Month
          <input type="month" value={month} max={thisMonth()} onChange={e => setMonth(e.target.value || thisMonth())} style={{ display: 'block', padding: 6, marginTop: 4 }} />
        </label>
        {data?.can_raise && (
          <button type="button" className="pulse-btn-primary" disabled={busy} onClick={generate}>Raise stipends for {month}</button>
        )}
        <span style={{ fontSize: 13, color: '#4b5563' }}>{rows.length} row(s) · {fmt(total)}</span>
      </div>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
        Raising works out each intern's stipend for the month from their stipend and frequency (part months pro-rated) and
        skips anyone already raised. Finance records the payment here; the accounting entry is booked in Finance → Accounting.
      </p>
      {msg && <div role={msg.ok ? 'status' : 'alert'} style={{ padding: 10, borderRadius: 8, marginBottom: 12, background: msg.ok ? '#ecfdf5' : '#fef2f2', color: msg.ok ? '#047857' : '#b91c1c', fontSize: 13 }}>{msg.text}</div>}
      {error ? <LoadError compact message={error} onRetry={load} /> : !data ? <p>Loading…</p> : rows.length === 0 ? (
        <p style={{ fontSize: 13, color: '#6b7280' }}>No stipends for {month}.{data.can_raise ? ' Use "Raise stipends" to work them out.' : ''}</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
          <thead><tr><th style={head}>Intern</th><th style={head}>How it was worked out</th><th style={head}>Pay to</th><th style={{ ...head, textAlign: 'right' }}>Amount</th><th style={head}>Status</th><th style={head} /></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td style={cell}><strong>{r.intern_name}</strong><div style={{ fontSize: 11, color: '#6b7280' }}>{r.intern_code}{r.department ? ` · ${r.department}` : ''}</div></td>
                <td style={{ ...cell, fontSize: 12 }}>{r.basis}{r.adjust_reason ? <div style={{ color: '#b45309' }}>Changed from {fmt(r.computed_amount)}: {r.adjust_reason}</div> : null}</td>
                <td style={{ ...cell, fontSize: 12 }}>{r.bank_ifsc ? `${r.bank_name || ''} · ${r.bank_ifsc} · …${r.account_last4 || ''}` : <span style={{ color: '#b91c1c' }}>No bank details on the intern record</span>}</td>
                <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>{fmt(r.amount)}</td>
                <td style={{ ...cell, color: tone[r.status] }}>
                  {r.status === 'paid' ? `Paid ${fmtDate(r.value_date)} · ${r.utr}` : r.status === 'cancelled' ? `Cancelled: ${r.cancel_reason}` : 'Due'}
                </td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                  {r.status === 'due' && data.can_raise && <>
                    <button type="button" className="pulse-btn-secondary" onClick={() => setEditing({ id: r.id, mode: 'adjust', amount: r.amount, reason: '' })}>Change</button>{' '}
                    <button type="button" className="pulse-btn-secondary" onClick={() => setEditing({ id: r.id, mode: 'cancel', reason: '' })}>Cancel</button>{' '}
                  </>}
                  {r.status === 'due' && data.can_pay && (
                    String(r.created_by) === String(data.me)
                      ? <span style={{ fontSize: 11, color: '#6b7280' }}>You raised it; someone else records the payment</span>
                      : <button type="button" className="pulse-btn-primary" onClick={() => setEditing({ id: r.id, mode: 'pay', utr: '', value_date: localDay(), bank_account_id: '' })}>Record payment</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div style={{ marginTop: 16, padding: 16, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', display: 'grid', gap: 10, maxWidth: 560 }}>
          <strong>{editing.mode === 'adjust' ? 'Change amount' : editing.mode === 'cancel' ? 'Cancel stipend' : 'Record payment'}</strong>
          {editing.mode === 'adjust' && (
            <label style={{ fontSize: 12 }}>Amount (₹)<input type="number" min="0" step="1" value={editing.amount} onChange={e => setEditing(x => ({ ...x, amount: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6 }} /></label>
          )}
          {editing.mode !== 'pay' && (
            <label style={{ fontSize: 12 }}>Reason<input value={editing.reason} onChange={e => setEditing(x => ({ ...x, reason: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6 }} /></label>
          )}
          {editing.mode === 'pay' && <>
            <label style={{ fontSize: 12 }}>Bank transaction reference (UTR)<input value={editing.utr} onChange={e => setEditing(x => ({ ...x, utr: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6 }} /></label>
            <label style={{ fontSize: 12 }}>Value date<input type="date" max={localDay()} value={editing.value_date} onChange={e => setEditing(x => ({ ...x, value_date: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6 }} /></label>
            <label style={{ fontSize: 12 }}>Paid from
              <select value={editing.bank_account_id} onChange={e => setEditing(x => ({ ...x, bank_account_id: e.target.value }))} style={{ display: 'block', width: '100%', padding: 6 }}>
                <option value="">{banks == null ? 'Loading…' : banks.length ? '-- Choose bank account --' : 'No active bank account'}</option>
                {(banks || []).map(b => <option key={b.id} value={b.id}>{b.account_name || b.bank_name} · {String(b.account_number || '').slice(-4)}</option>)}
              </select>
            </label>
          </>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="pulse-btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="pulse-btn-secondary" onClick={() => setEditing(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
