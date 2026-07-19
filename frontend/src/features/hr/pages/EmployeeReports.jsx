// frontend/src/features/hr/pages/EmployeeReports.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';

function downloadCSV(data, filename) {
  if (!data?.length) return;
  const headers = Object.keys(data[0]);
  const rows = data.map(r => headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = filename;
  a.click();
}

const REPORTS = [
  { key: 'headcount',  label: 'Headcount Report',       icon: '👥', desc: 'All active & probation employees with department, designation, grade, band',       file: 'headcount-report.csv' },
  { key: 'attrition',  label: 'Attrition Report',       icon: '📉', desc: 'Employees who left/resigned/terminated — includes exit reason and exit date',       file: 'attrition-report.csv' },
  { key: 'doc-expiry', label: 'Document Expiry Report',  icon: '📄', desc: 'Documents expiring within configurable window — for renewal/follow-up',            file: 'doc-expiry-report.csv' },
];

export default function EmployeeReports() {
  const [loading, setLoading] = useState({});
  const [counts, setCounts]   = useState({});
  const [attrFrom, setFrom]   = useState('');
  const [attrTo, setTo]       = useState('');
  const [msg, setMsg]         = useState({ text: '', type: '' });

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 3000);
  };

  const fetchPreview = useCallback(async () => {
    try {
      const [hc, at, doc] = await Promise.allSettled([
        api.get('/analytics/employee-reports/headcount'),
        api.get('/analytics/employee-reports/attrition'),
        api.get('/analytics/employee-reports/doc-expiry'),
      ]);
      setCounts({
        headcount:  hc.status  === 'fulfilled' ? (hc.value.data?.total  || 0) : '—',
        attrition:  at.status  === 'fulfilled' ? (at.value.data?.total  || 0) : '—',
        'doc-expiry': doc.status === 'fulfilled' ? (doc.value.data?.total || 0) : '—',
      });
    } catch { /* silent */ }
  }, []);

  useEffect(() => { fetchPreview(); }, [fetchPreview]);

  const handleDownload = async (key) => {
    setLoading(p => ({ ...p, [key]: true }));
    try {
      let url = `/analytics/employee-reports/${key}`;
      if (key === 'attrition') {
        const params = new URLSearchParams();
        if (attrFrom) params.set('from', attrFrom);
        if (attrTo)   params.set('to',   attrTo);
        if (params.toString()) url += '?' + params;
      }
      const { data } = await api.get(url);
      const rows = data?.data || [];
      if (!rows.length) { flash('No data found for selected filters', 'error'); return; }
      const cfg = REPORTS.find(r => r.key === key);
      downloadCSV(rows, cfg?.file || `${key}.csv`);
      flash(`Downloaded ${rows.length} rows`);
    } catch (err) {
      flash(err.response?.data?.error || 'Download failed', 'error');
    } finally {
      setLoading(p => ({ ...p, [key]: false }));
    }
  };

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>Employee Reports</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>Download headcount, attrition, and document expiry reports as CSV</p>
      </div>

      {msg.text && (
        <div style={{ marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14, background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a', border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 20 }}>
        {REPORTS.map(report => (
          <div key={report.key} style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 24 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>{report.icon}</div>
            <div style={{ fontWeight: 700, color: '#1f2937', fontSize: 16, marginBottom: 6 }}>{report.label}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16, lineHeight: 1.5 }}>{report.desc}</div>

            {counts[report.key] !== undefined && (
              <div style={{ marginBottom: 16, padding: '8px 14px', background: '#f5f3ff', borderRadius: 8, fontSize: 13 }}>
                <span style={{ fontWeight: 700, color: '#6B3FDB', fontSize: 18 }}>{counts[report.key]}</span>
                <span style={{ color: '#6b7280', marginLeft: 6 }}>records available</span>
              </div>
            )}

            {report.key === 'attrition' && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>From</label>
                  <input type="date" value={attrFrom} onChange={e => setFrom(e.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>To</label>
                  <input type="date" value={attrTo} onChange={e => setTo(e.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                </div>
              </div>
            )}

            <button
              onClick={() => handleDownload(report.key)}
              disabled={loading[report.key]}
              style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', cursor: loading[report.key] ? 'default' : 'pointer', fontWeight: 700, fontSize: 14, background: '#6B3FDB', color: '#fff', opacity: loading[report.key] ? 0.7 : 1 }}
            >
              {loading[report.key] ? 'Generating…' : '⬇ Download CSV'}
            </button>
          </div>
        ))}
      </div>

      {/* Age Distribution Chart */}
      <AgeDistribution />
    </div>
  );
}

function AgeDistribution() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/analytics/age-distribution')
      .then(r => setData(r.data?.data || []))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, []);

  const max = Math.max(...data.map(d => d.count), 1);

  return (
    <div style={{ marginTop: 28, background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 24 }}>
      <h3 style={{ margin: '0 0 20px', color: '#4c1d95', fontSize: 16 }}>Age Distribution</h3>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 20, color: '#9ca3af' }}>Loading…</div>
      ) : data.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 20, color: '#9ca3af' }}>No data (add Date of Birth to employee profiles)</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, height: 160 }}>
          {data.map(d => (
            <div key={d.bracket} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#6B3FDB' }}>{d.count}</div>
              <div style={{ width: '100%', height: Math.max(8, (d.count / max) * 120), background: 'linear-gradient(180deg,#6B3FDB,#a78bfa)', borderRadius: '4px 4px 0 0' }} />
              <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'center', wordBreak: 'break-all' }}>{d.bracket}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
