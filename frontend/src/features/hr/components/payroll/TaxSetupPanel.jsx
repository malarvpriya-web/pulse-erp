import { useCallback, useEffect, useState } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { heldGrant } from '@/config/menuCatalog';

/**
 * Payroll Center → Salary Structures & Loans → Tax regime & opening balances.
 *   Regime: each employee's choice for the tax year (CBDT: the employer deducts
 *     under the regime the employee intimates; with none, the new regime).
 *     Employees can also declare it themselves in Self-Service.
 *   Opening balance: salary, tax and PF already paid this tax year outside
 *     Pulse — before going live, or by a previous employer (Form 12B). Monthly
 *     tax spreads what is still due over the remaining months, so a missing
 *     opening balance means too little tax is deducted.
 */
const fyNow = () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-${y + 1}`; };
const fyOptions = () => { const y = parseInt(fyNow(), 10); return [y, y - 1].map(x => `${x}-${x + 1}`); };
const fmt = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')}`);

export default function TaxSetupPanel() {
  const { hasPermission, permissions } = useAuth();
  const canEdit = typeof hasPermission === 'function' && hasPermission('payroll', 'edit');
  // Only the Finance Manager records a regime (tax_regime:edit, 2026-11-11). The
  // grant itself, with NO admin shortcut — the server gives admins none either.
  const canSetRegime = heldGrant(permissions, 'tax_regime', 'edit');
  const [fy, setFy] = useState(fyNow());
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [edit, setEdit] = useState(null);
  const [search, setSearch] = useState('');
  const [pf, setPf] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows((await api.get('/payroll/tax-setup', { params: { financial_year: fy } })).data?.data?.employees || []); }
    catch (e) { setRows([]); setError(e?.response?.data?.message || 'Could not load the tax setup'); }
  }, [fy]);
  useEffect(() => { load(); }, [load]);

  const setRegime = async (r, regime) => {
    try {
      await api.put(`/payroll/tax-regime/${r.employee_id}`, { financial_year: fy, regime });
      setNotice(`${r.name}: ${regime === 'old' ? 'old' : 'new'} regime recorded for ${fy}. Regenerate any draft of this year.`); load();
    } catch (e) { setError(e?.response?.data?.message || 'Not saved'); }
  };
  const saveOpening = async () => {
    try {
      await api.put(`/payroll/opening-balances/${edit.employee_id}`, { financial_year: fy, ...edit.values });
      setEdit(null); setNotice('Opening balance saved. Regenerate any draft of this year so its tax uses it.'); load();
    } catch (e) { setEdit(x => ({ ...x, error: e?.response?.data?.message || 'Not saved' })); }
  };

  // §262: an employee who is not a PF member (Form 11; PF wage above the ceiling, never a member before).
  const savePf = async () => {
    try {
      const r = pf.mode === 'end'
        ? await api.put(`/payroll/pf-exclusions/${pf.employee_id}/end`, { ended_on: pf.date, reason: pf.reason })
        : await api.put(`/payroll/pf-exclusions/${pf.employee_id}`, { effective_from: pf.date, declaration_reference: pf.reference, reason: pf.reason });
      setPf(null); setNotice(r.data?.message || 'Saved'); load();
    } catch (err) { setPf(x => ({ ...x, error: err?.response?.data?.message || 'Not saved' })); }
  };

  const shown = (rows || []).filter(r => !search || [r.name, r.employee_code, r.department].some(v => String(v || '').toLowerCase().includes(search.toLowerCase())));
  const cell = { padding: '8px 10px', borderTop: '1px solid #f3f4f6' };

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ fontSize: 13 }}>Tax year{' '}
          <select value={fy} onChange={e => setFy(e.target.value)} style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            {fyOptions().map(f => <option key={f} value={f}>{f}</option>)}
          </select></label>
        <input placeholder="Search employee…" value={search} onChange={e => setSearch(e.target.value)} style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 8 }} />
      </div>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
        No choice recorded means the <strong>new regime</strong> (the law's default). Record the old regime only from the employee's own written choice
        {canSetRegime ? '.' : ' — only the Finance Manager can record it.'}
        An opening balance is the salary, tax and PF of this tax year paid outside Pulse — before go-live, or by a previous employer (Form 12B).
      </p>
      {error && <div role="alert" style={{ background: '#fef2f2', color: '#991b1b', padding: '8px 12px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>{error}</div>}
      {notice && <div style={{ background: '#f0fdf4', color: '#166534', padding: '8px 12px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>{notice}</div>}
      {rows == null ? <p>Loading…</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ background: '#f9fafb' }}>{['Employee', 'Tax regime', 'PF', 'Opening salary', 'Opening tax', 'Opening PF', 'Months', 'Source', ''].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 10px' }}>{h}</th>)}</tr></thead>
          <tbody>{shown.map(r => (
            <tr key={r.employee_id}>
              <td style={cell}><strong>{r.name}</strong> <span style={{ color: '#9ca3af' }}>{r.employee_code}</span></td>
              <td style={cell}>
                <select aria-label={`Tax regime of ${r.name}`} value={r.regime} disabled={!canSetRegime} title={canSetRegime ? undefined : 'Only the Finance Manager records a tax regime'} onChange={e => setRegime(r, e.target.value)}>
                  <option value="new">New regime{r.regime_declared ? '' : ' (default)'}</option>
                  <option value="old">Old regime</option>
                </select>
              </td>
              <td style={{ ...cell, fontSize: 12 }}>
                {r.pf_excluded_from
                  ? <span title={`Form 11: ${r.pf_declaration_reference}`}>Not a member from {String(r.pf_excluded_from).slice(0, 10)}</span>
                  : 'Member'}
                {canEdit && (
                  <div><button type="button" style={{ background: 'none', border: 'none', padding: 0, color: '#6d28d9', cursor: 'pointer', fontSize: 11 }}
                    onClick={() => setPf(r.pf_excluded_from
                      ? { mode: 'end', employee_id: r.employee_id, name: r.name, date: '', reason: '', error: null }
                      : { mode: 'set', employee_id: r.employee_id, name: r.name, date: '', reference: '', reason: '', error: null })}>
                    {r.pf_excluded_from ? 'Join PF' : 'Not a PF member…'}
                  </button></div>
                )}
              </td>
              <td style={cell}>{fmt(r.opening_gross)}</td><td style={cell}>{fmt(r.opening_tds)}</td><td style={cell}>{fmt(r.opening_pf)}</td>
              <td style={cell}>{r.opening_months ?? '—'}</td><td style={{ ...cell, fontSize: 12, color: '#6b7280' }}>{r.opening_source || '—'}</td>
              <td style={cell}>{canEdit && <button className="pulse-btn-secondary" onClick={() => setEdit({ employee_id: r.employee_id, name: r.name, error: null,
                values: { gross: r.opening_gross ?? '', tds: r.opening_tds ?? '', employee_pf: r.opening_pf ?? '', months: r.opening_months ?? '', source: r.opening_source ?? '' } })}>Opening balance</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {pf && (
        <div role="dialog" aria-label="PF membership" style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginTop: 16 }}>
          <strong>{pf.mode === 'end' ? `${pf.name} joins PF` : `${pf.name} is not a PF member`}</strong>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '6px 0 0' }}>
            {pf.mode === 'end'
              ? 'PF is deducted from the month of this date. That month must not be approved yet.'
              : 'Only for an employee whose PF wage was above the PF ceiling when they joined and who has never been a PF member (no UAN). They declare it on Form 11. Payroll then deducts no PF and the company pays no employer PF for them. Pulse checks all three before saving.'}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10, marginTop: 10 }}>
            <label style={{ fontSize: 12 }}>{pf.mode === 'end' ? 'PF from *' : 'No PF from * (usually the joining date)'}<br />
              <input type="date" value={pf.date} onChange={e => setPf(x => ({ ...x, date: e.target.value, error: null }))} style={{ width: '100%', padding: 6, border: '1px solid #d1d5db', borderRadius: 6 }} /></label>
            {pf.mode === 'set' && (
              <label style={{ fontSize: 12 }}>Form 11 reference *<br />
                <input value={pf.reference} placeholder="e.g. Form 11 signed 01-Feb-2026" onChange={e => setPf(x => ({ ...x, reference: e.target.value, error: null }))} style={{ width: '100%', padding: 6, border: '1px solid #d1d5db', borderRadius: 6 }} /></label>
            )}
            <label style={{ fontSize: 12, gridColumn: '1 / -1' }}>{pf.mode === 'end' ? 'Reason *' : 'Note'}<br />
              <input value={pf.reason} onChange={e => setPf(x => ({ ...x, reason: e.target.value, error: null }))} style={{ width: '100%', padding: 6, border: '1px solid #d1d5db', borderRadius: 6 }} /></label>
          </div>
          {pf.error && <p role="alert" style={{ color: '#b91c1c', fontSize: 12 }}>{pf.error}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="pulse-btn-primary" onClick={savePf} disabled={!pf.date || (pf.mode === 'set' && pf.reference.trim().length < 3)}>Save</button>
            <button className="pulse-btn-secondary" onClick={() => setPf(null)}>Cancel</button>
          </div>
        </div>
      )}
      {edit && (
        <div role="dialog" aria-label="Opening balance" style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginTop: 16 }}>
          <strong>Opening balance — {edit.name}, {fy}</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginTop: 10 }}>
            {[['gross', 'Salary paid (₹)'], ['tds', 'Tax deducted (₹)'], ['employee_pf', 'Employee PF (₹)'], ['months', 'Months covered']].map(([k, l]) => (
              <label key={k} style={{ fontSize: 12 }}>{l}<br /><input type="number" min="0" value={edit.values[k]}
                onChange={e => setEdit(x => ({ ...x, error: null, values: { ...x.values, [k]: e.target.value } }))} style={{ width: '100%', padding: 6, border: '1px solid #d1d5db', borderRadius: 6 }} /></label>
            ))}
            <label style={{ fontSize: 12, gridColumn: '1 / -1' }}>Where the figures come from *<br /><input value={edit.values.source} placeholder='e.g. "Form 12B from previous employer"'
              onChange={e => setEdit(x => ({ ...x, error: null, values: { ...x.values, source: e.target.value } }))} style={{ width: '100%', padding: 6, border: '1px solid #d1d5db', borderRadius: 6 }} /></label>
          </div>
          {edit.error && <p role="alert" style={{ color: '#b91c1c', fontSize: 12 }}>{edit.error}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="pulse-btn-primary" onClick={saveOpening}>Save</button>
            <button className="pulse-btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
