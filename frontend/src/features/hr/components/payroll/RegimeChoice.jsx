import { useEffect, useState } from 'react';
import api from '@/services/api/client';

/**
 * Self-Service → IT Declaration: the employee's own income-tax regime for the
 * year. The employer deducts tax under the regime the employee intimates; with
 * no choice, the new regime. It can be changed here until the first month of
 * the year is finalised; after that, HR records a change from a written request.
 */
export default function RegimeChoice({ financialYear }) {
  const [state, setState] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    api.get('/payroll/my-tax-regime', { params: { financial_year: financialYear } })
      .then(r => setState(r.data?.data || null)).catch(() => setState(null));
  }, [financialYear]);
  if (!state) return null;
  const save = async (regime) => {
    try {
      await api.put('/payroll/my-tax-regime', { financial_year: financialYear, regime });
      setState(s => ({ ...s, regime, declared: true }));
      setMsg({ ok: true, text: `Recorded: ${regime === 'old' ? 'old' : 'new'} regime for ${financialYear}.` });
    } catch (e) { setMsg({ ok: false, text: e?.response?.data?.message || 'Not saved' }); }
  };
  return (
    <div style={{ background: '#f5f3ff', border: '1px solid #e9e4ff', borderRadius: 10, padding: 14, marginBottom: 16 }}>
      <label style={{ fontSize: 13, fontWeight: 600, color: '#4c1d95' }}>
        Income-tax regime for {financialYear}{' '}
        <select value={state.regime} onChange={e => save(e.target.value)} style={{ marginLeft: 6, padding: '4px 8px' }}>
          <option value="new">New regime{state.declared ? '' : ' (default)'}</option>
          <option value="old">Old regime (80C, HRA and other declarations count)</option>
        </select>
      </label>
      <p style={{ margin: '6px 0 0', fontSize: 12, color: '#6b7280' }}>
        Your declarations below reduce the tax deducted only under the old regime. You can change this until the first payroll of the year is approved.
      </p>
      {msg && <p style={{ margin: '6px 0 0', fontSize: 12, color: msg.ok ? '#166534' : '#b91c1c' }}>{msg.text}</p>}
    </div>
  );
}
