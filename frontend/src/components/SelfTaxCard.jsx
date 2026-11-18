import { useState, useEffect } from 'react';
import api from '@/services/api/client';

/*
 * My Details → Payroll tab, self view only (2026-11-11): the employee's own tax
 * regime and this year's IT declarations, read-only. Finance records both
 * (Payroll Center); a mistake is reported with Request change → Finance.
 */
const DECL_LABEL = { '80C': '80C', '80CCD': 'NPS (own)', '80D': '80D health insurance', HOME_LOAN: 'Home-loan interest', HRA: 'HRA (rent)', LTA: 'LTA', other: 'Other' };
const DECL_STATUS = { submitted: 'Waiting for review', approved: 'Approved', rejected: 'Rejected' };
const inr = n => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
function currentFY() {
  const d = new Date(); const y = d.getFullYear();
  return d.getMonth() + 1 >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}
const th = { textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: '#6b7280', padding: '0 8px 8px 0', borderBottom: '1px solid #f0f0f4' };
const td = { padding: '8px 8px 8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13, color: '#374151' };

export default function SelfTaxCard() {
  const fy = currentFY();
  const [regime, setRegime] = useState(undefined);   // undefined = loading, null = unavailable
  const [decls, setDecls] = useState(undefined);

  useEffect(() => {
    let live = true;
    api.get('/payroll/my-tax-regime', { params: { financial_year: fy } })
      .then(r => { if (live) setRegime(r.data?.data || null); }).catch(() => { if (live) setRegime(null); });
    api.get('/self-service/it-declarations', { params: { financial_year: fy } })
      .then(r => { if (live) setDecls(Array.isArray(r.data) ? r.data : []); }).catch(() => { if (live) setDecls(null); });
    return () => { live = false; };
  }, [fy]);

  return (
    <div data-testid="self-tax-card" style={{ gridColumn: '1 / -1', background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#6B3FDB', marginBottom: 4 }}>Tax regime &amp; IT declarations — FY {fy}</div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>Recorded by Finance. Something wrong? Use Request change → Tax regime &amp; IT declarations.</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
        <span style={{ color: '#6b7280' }}>Tax regime</span>
        <span style={{ fontWeight: 600, color: '#111827' }}>
          {regime === undefined ? '…' : regime ? `${regime.regime === 'old' ? 'Old' : 'New'} regime${regime.declared ? '' : ' (company default)'}` : 'Not available'}
        </span>
      </div>
      {decls === undefined ? null : decls === null ? (
        <div style={{ fontSize: 13, color: '#9ca3af', paddingTop: 8 }}>Your declarations could not be loaded.</div>
      ) : decls.length === 0 ? (
        <div style={{ fontSize: 13, color: '#9ca3af', paddingTop: 8 }}>No IT declarations on file for this year. To claim 80C, HRA, 80D etc., give Finance your proofs.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
          <thead><tr><th style={th}>Section</th><th style={th}>Description</th><th style={th}>Declared</th><th style={th}>Approved</th><th style={th}>Status</th></tr></thead>
          <tbody>
            {decls.map(d => (
              <tr key={d.id}>
                <td style={td}>{DECL_LABEL[d.declaration_type] || d.declaration_type}</td>
                <td style={td}>{d.description || '—'}</td>
                <td style={td}>{inr(d.claimed_amount ?? d.amount)}</td>
                <td style={td}>{d.status === 'approved' ? inr(d.amount) : '—'}</td>
                <td style={td}>{DECL_STATUS[d.status] || d.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
