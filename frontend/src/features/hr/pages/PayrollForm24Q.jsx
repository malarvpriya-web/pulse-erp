import { useState, useRef } from 'react';
import { FileText, Download, RefreshCw, AlertCircle, CheckCircle, X, ChevronDown, ChevronRight } from 'lucide-react';
import api from '@/services/api/client';

const currentFY = () => {
  const now = new Date();
  const yr  = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${yr}-${yr + 1}`;
};

const FY_OPTIONS = (() => {
  const base = new Date().getFullYear();
  return [0, 1, 2].map(i => { const yr = base - i; return `${yr}-${yr + 1}`; });
})();

const fmtRupee = n => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function PayrollForm24Q({ setPage: _setPage }) {
  const [fy,          setFy]          = useState(currentFY());
  const [quarter,     setQuarter]     = useState('');
  const [data,        setData]        = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [dlLoading,   setDlLoading]   = useState(false);
  const [expanded,    setExpanded]    = useState({});
  const [toast,       setToast]       = useState(null);
  const isMounted = useRef(true);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 4000);
  };

  const loadData = async () => {
    setLoading(true);
    setData(null);
    try {
      const params = { financial_year: fy };
      if (quarter) params.quarter = quarter;
      const r = await api.get('/tds/form24q', { params });
      if (!isMounted.current) return;
      setData(r?.data);
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e?.response?.data?.message || 'Failed to load Form 24Q data', 'error');
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
      a.download = `Form24Q_${fy.replace('-', '_')}${quarter ? `_${quarter}` : ''}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Form 24Q text file downloaded. Import into NSDL RPU to generate FVU.');
    } catch (e) {
      const msg = e?.response?.status === 404
        ? 'No TDS data found for the selected period. Generate payroll first.'
        : 'Download failed';
      showToast(msg, 'error');
    } finally {
      if (isMounted.current) setDlLoading(false);
    }
  };

  const card  = { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,.08)' };
  const btn   = (bg, color = '#fff', disabled = false) => ({
    background: disabled ? '#e5e7eb' : bg, color: disabled ? '#9ca3af' : color,
    border: 'none', borderRadius: 8, padding: '9px 18px', cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
  });
  const badge = (color, bg) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 99,
    fontSize: 11, fontWeight: 600, color, background: bg });

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

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

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#0891b2,#0e7490)',
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <FileText size={22} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Form 24Q</h1>
            <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Quarterly TDS return — Salary (Section 192)</p>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Financial Year</label>
            <select value={fy} onChange={e => { setFy(e.target.value); setData(null); }}
              style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', fontSize: 13, background: '#fff', minWidth: 140 }}>
              {FY_OPTIONS.map(f => <option key={f} value={f}>FY {f}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Quarter</label>
            <select value={quarter} onChange={e => { setQuarter(e.target.value); setData(null); }}
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
          <button style={btn('#6B3FDB', '#fff', dlLoading)} onClick={downloadTxt} disabled={dlLoading}>
            <Download size={14} />
            {dlLoading ? 'Downloading...' : 'Download .txt'}
          </button>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 12, color: '#9ca3af' }}>
          The downloaded .txt file can be imported into NSDL RPU software to generate the FVU file for e-filing.
        </p>
      </div>

      {/* Grand Total Summary */}
      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 16, marginBottom: 20 }}>
          {[
            { label: 'Financial Year', value: data.financial_year, color: '#6366f1' },
            { label: 'Quarters with Data', value: data.quarters?.length || 0, color: '#0891b2' },
            { label: 'Total Salary Paid', value: fmtRupee(data.grand_total?.salary), color: '#10b981', isText: true },
            { label: 'Total TDS Deducted', value: fmtRupee(data.grand_total?.tds), color: '#f59e0b', isText: true },
          ].map(k => (
            <div key={k.label} style={{ ...card, borderTop: `3px solid ${k.color}` }}>
              <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>{k.label}</div>
              <div style={{ fontSize: k.isText ? 18 : 24, fontWeight: 700, color: '#1f2937' }}>{k.value}</div>
            </div>
          ))}
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
                    {['#', 'Employee', 'PAN', 'Section', 'Salary Paid', 'TDS Deducted'].map(h => (
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
                        {d.employee_pan === 'PANNOTAVBL' ? <span style={{ color: '#f59e0b' }}>MISSING</span> : d.employee_pan}
                      </td>
                      <td style={{ padding: '8px 12px' }}><span style={badge('#374151', '#f3f4f6')}>{d.section}</span></td>
                      <td style={{ padding: '8px 12px', color: '#1f2937', fontWeight: 500 }}>{fmtRupee(d.total_salary)}</td>
                      <td style={{ padding: '8px 12px', color: '#dc2626', fontWeight: 600 }}>{fmtRupee(d.total_tds)}</td>
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
          <div style={{ fontSize: 15, fontWeight: 600, color: '#6b7280' }}>No TDS data found</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Generate and mark payroll as paid to see Form 24Q data.</div>
        </div>
      )}
    </div>
  );
}
