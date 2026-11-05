import { useState, useRef, useEffect } from 'react';
import {
  FileText, Download, RefreshCw, AlertCircle, CheckCircle, X,
  ChevronDown, ChevronRight, Wallet,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { statementName, statementBasis, periodTerm } from '../components/payroll/taxFormNames';

const currentFY = () => {
  const now = new Date();
  const yr  = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${yr}-${yr + 1}`;
};

const FY_OPTIONS = (() => {
  const base = parseInt(currentFY(), 10);
  return [0, 1, 2].map(i => { const yr = base - i; return `${yr}-${yr + 1}`; });
})();

const fmtRupee = n => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function PayrollForm24Q({ setPage: _setPage, embedded = false }) {
  const [fy,          setFy]          = useState(currentFY());
  const [quarter,     setQuarter]     = useState('');
  const [data,        setData]        = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [dlLoading,   setDlLoading]   = useState(false);
  const [expanded,    setExpanded]    = useState({});
  const [toast,       setToast]       = useState(null);
  const [loadError,   setLoadError]   = useState(null);
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);
  const name = data?.form_label || statementName(fy);
  const term = data?.period_term || periodTerm(fy);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 4000);
  };

  const loadData = async () => {
    setLoading(true);
    setData(null);
    setLoadError(null);
    try {
      const params = { financial_year: fy };
      if (quarter) params.quarter = quarter;
      const r = await api.get('/tds/form24q', { params });
      if (!isMounted.current) return;
      setData(r?.data);
    } catch (e) {
      if (!isMounted.current) return;
      setLoadError(e?.response?.data?.message || e?.response?.data?.error || e?.message || 'request failed');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const downloadTxt = async () => {
    setDlLoading(true);
    try {
      const params = { financial_year: fy };
      if (quarter) params.quarter = quarter;
      const r = await api.get('/tds/form24q-download', { params, responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([r.data], { type: 'text/plain' }));
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `Form138_${fy.replace('-', '_')}${quarter ? `_${quarter}` : ''}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`${name} data extract downloaded. It is not a filed return — prepare and validate the statement in the official utility (RPU/FVU) before filing.`);
    } catch (e) {
      // The download is refused while validation errors exist; the body is a
      // Blob because of responseType — read it for the reason.
      let body = null;
      try { body = JSON.parse(await e?.response?.data?.text?.()); } catch { /* not JSON */ }
      if (body?.validation) setData(d => ({ ...(d || {}), validation: body.validation }));
      const msg = e?.response?.status === 422 ? (body?.message || `${name} has validation errors`)
        : e?.response?.status === 404 ? 'No approved salary TDS for the selected period.'
          : 'Download failed';
      showToast(msg, 'error');
    } finally {
      if (isMounted.current) setDlLoading(false);
    }
  };

  // Why the extract cannot be downloaded right now, or null when it can.
  const dlBlocked = !data
    ? (loadError ? 'the data did not load' : 'run "View Data" first — validation runs on the selected year and quarter')
    : !data.validation?.ok
      ? `${data.validation?.errors?.length || 0} validation error(s) below must be fixed first`
      : !data.quarters?.length ? 'there is no approved salary TDS in the selected period' : null;

  const card  = { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,.08)' };
  const btn   = (bg, color = '#fff', disabled = false) => ({
    background: disabled ? '#e5e7eb' : bg, color: disabled ? '#9ca3af' : color,
    border: 'none', borderRadius: 8, padding: '9px 18px', cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
  });
  const badge = (color, bg) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 99,
    fontSize: 11, fontWeight: 600, color, background: bg });

  return (
    <PageShell embedded={embedded} dock={embedded ? null :
      <PageHero
        icon={Wallet}
        eyebrow="Human Resources"
        title={name}
        subtitle="Quarterly statement of tax deducted from salary"
      />
    }>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999, display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 18px', borderRadius: 10,
          background: toast.type === 'error' ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${toast.type === 'error' ? '#fca5a5' : '#86efac'}`,
          boxShadow: '0 4px 20px rgba(0,0,0,.1)',
          color: toast.type === 'error' ? '#991b1b' : '#166534', fontSize: 13, fontWeight: 500 }}>
          {toast.type === 'error' ? <AlertCircle size={15} /> : <CheckCircle size={15} />}
          {toast.message}
          <button onClick={() => setToast(null)} style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
            <X size={13} />
          </button>
        </div>
      )}

      {/* Controls */}
      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Tax year (FY)</label>
            <select value={fy} onChange={e => { setFy(e.target.value); setData(null); setLoadError(null); }}
              style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', fontSize: 13, background: '#fff', minWidth: 140 }}>
              {FY_OPTIONS.map(f => <option key={f} value={f}>{periodTerm(f)} {f}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Quarter</label>
            <select value={quarter} onChange={e => { setQuarter(e.target.value); setData(null); setLoadError(null); }}
              style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', fontSize: 13, background: '#fff', minWidth: 120 }}>
              <option value="">All Quarters</option>
              <option value="Q1">Q1 (Apr–Jun)</option>
              <option value="Q2">Q2 (Jul–Sep)</option>
              <option value="Q3">Q3 (Oct–Dec)</option>
              <option value="Q4">Q4 (Jan–Mar)</option>
            </select>
          </div>
          <button style={btn('#0891b2', '#fff', loading)} onClick={loadData} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            {loading ? 'Loading...' : 'View Data'}
          </button>
          <button style={btn('#6B3FDB', '#fff', dlLoading || !!dlBlocked)} onClick={downloadTxt}
            disabled={dlLoading || !!dlBlocked}
            title={dlBlocked || 'Download the data extract'}>
            <Download size={14} />
            {dlLoading ? 'Downloading...' : 'Download data extract'}
          </button>
        </div>
        {dlBlocked && (
          <p style={{ margin: '10px 0 0', fontSize: 12, color: '#92400e' }}>
            <strong>Download unavailable:</strong> {dlBlocked}
          </p>
        )}
        {/* In the body, not only the hero subtitle: embedded in Payroll Center there is no hero. */}
        <p style={{ margin: '12px 0 0', fontSize: 12, color: '#374151' }}>{data?.statute || statementBasis(fy)}</p>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: '#9ca3af' }}>
          Built from <strong>approved</strong> payroll only; test records are excluded. The extract is generated only when TAN,
          PAN, amounts and challan deposits validate. It is an input for the official return utility, not an FVU file.
        </p>
      </div>

      {/* Grand Total Summary */}
      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 16, marginBottom: 20 }}>
          {[
            { label: term, value: data.financial_year, color: '#6366f1' },
            { label: 'Quarters with Data', value: data.quarters?.length || 0, color: '#0891b2' },
            { label: 'Total Salary Paid', value: fmtRupee(data.grand_total?.salary), color: '#10b981', isText: true },
            { label: 'Total TDS Deducted', value: fmtRupee(data.grand_total?.tds), color: '#7c5cf0', isText: true },
          ].map(k => (
            <div key={k.label} style={{ ...card, borderTop: `3px solid ${k.color}` }}>
              <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>{k.label}</div>
              <div style={{ fontSize: k.isText ? 18 : 24, fontWeight: 700, color: '#1f2937' }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      {loadError && (
        <div role="alert" style={{ ...card, marginBottom: 16, borderLeft: '4px solid #dc2626', color: '#991b1b', fontSize: 13 }}>
          <strong>Could not load {name} data for {term} {fy}{quarter ? ` ${quarter}` : ''}:</strong> {loadError}. Nothing has been validated.
        </div>
      )}

      {/* Validation — a pass means only that Pulse's checks (TAN, PAN, amounts,
          challan deposits, approval) found nothing. It is not a filed return. */}
      {data?.validation && (
        <div style={{ ...card, marginBottom: 16, borderLeft: `4px solid ${data.validation.ok ? '#16a34a' : '#dc2626'}` }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: data.validation.ok ? '#166534' : '#991b1b', marginBottom: 6 }}>
            {data.validation.ok
              ? 'Pulse validation passed — the data extract can be downloaded'
              : `Not ready to file: ${data.validation.errors.length} validation error(s) — no data extract is produced until they are fixed`}
          </div>
          {data.validation.ok && (
            <div style={{ fontSize: 12, color: '#374151', marginBottom: 6 }}>
              This is not a filed return. Prepare the statement in the official return preparation utility, validate it with the FVU, and file it.
            </div>
          )}
          {data.validation.errors.map((e, i) => <div key={`e${i}`} style={{ fontSize: 12, color: '#991b1b' }}>• {e.code ? <strong>{e.code}{e.quarter ? ` · ${e.quarter}` : ''}: </strong> : null}{e.message}</div>)}
          {data.validation.warnings.map((w, i) => <div key={`w${i}`} style={{ fontSize: 12, color: '#92400e' }}>• {w.message}</div>)}
        </div>
      )}

      {!data && !loading && !loadError && (
        <div style={{ ...card, marginBottom: 16, fontSize: 13, color: '#6b7280' }}>
          Choose a financial year and quarter, then <strong>View Data</strong>. Pulse lists every validation failure it finds; nothing is filed from this screen.
        </div>
      )}

      {/* Quarter breakdown */}
      {data?.quarters?.map(qtr => (
        <div key={qtr.quarter} style={{ ...card, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer',
            padding: '0 0 12px', borderBottom: expanded[qtr.quarter] ? '1px solid #f3f4f6' : 'none' }}
            onClick={() => setExpanded(p => ({ ...p, [qtr.quarter]: !p[qtr.quarter] }))}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {expanded[qtr.quarter] ? <ChevronDown size={16} color="#6b7280" /> : <ChevronRight size={16} color="#6b7280" />}
              <span style={{ fontWeight: 700, fontSize: 15, color: '#1f2937' }}>{qtr.quarter}</span>
              <span style={badge('#0891b2', '#e0f2fe')}>{qtr.deductees?.length || 0} employees</span>
            </div>
            <div style={{ display: 'flex', gap: 24, fontSize: 13 }}>
              <span style={{ color: '#6b7280' }}>Salary: <strong style={{ color: '#1f2937' }}>{fmtRupee(qtr.totals?.salary)}</strong></span>
              <span style={{ color: '#6b7280' }}>TDS: <strong style={{ color: '#dc2626' }}>{fmtRupee(qtr.totals?.tds)}</strong></span>
            </div>
          </div>

          {expanded[qtr.quarter] && (
            <div style={{ overflowX: 'auto', marginTop: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#f3f4f6' }}>
                    {['#', 'Employee', 'PAN', 'Act section', 'Salary Paid', 'TDS Deducted', 'TDS Deposited'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {qtr.deductees?.map((d, i) => (
                    <tr key={d.employee_id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ padding: '8px 12px', color: '#9ca3af' }}>{d.sno}</td>
                      <td style={{ padding: '8px 12px' }}>
                        <div style={{ fontWeight: 600, color: '#1f2937' }}>{d.employee_name}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{d.employee_code}</div>
                      </td>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: '#374151' }}>
                        {!d.employee_pan ? <span style={{ color: '#dc2626' }}>MISSING</span>
                          : d.pan_valid ? d.employee_pan : <span style={{ color: '#dc2626' }}>{d.employee_pan} (invalid)</span>}
                      </td>
                      <td style={{ padding: '8px 12px' }}><span style={badge('#374151', '#f3f4f6')}>{d.section}</span></td>
                      <td style={{ padding: '8px 12px', color: '#1f2937', fontWeight: 500 }}>{fmtRupee(d.total_salary)}</td>
                      <td style={{ padding: '8px 12px', color: '#dc2626', fontWeight: 600 }}>{fmtRupee(d.total_tds)}</td>
                      <td style={{ padding: '8px 12px', color: Math.round(d.total_deposited) === Math.round(d.total_tds) ? '#166534' : '#b45309', fontWeight: 600 }}>{fmtRupee(d.total_deposited)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {data && !data.quarters?.length && (
        <div style={{ ...card, textAlign: 'center', padding: 48, color: '#9ca3af' }}>
          <FileText size={40} style={{ marginBottom: 12, opacity: 0.3 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: '#6b7280' }}>No approved salary TDS for this period</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Only approved or paid payroll is reported. Generate and approve payroll for these months to see {name} data.</div>
        </div>
      )}
    </PageShell>
  );
}
