import React, { useState, useEffect, useCallback } from 'react';
import {
  MapPin, AlertTriangle, Users, Calendar, Download, RefreshCw,
  ChevronDown, ChevronUp, Search, Filter, Shield,
} from 'lucide-react';
import api from '@/services/api/client';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20 };

function KPICard({ icon: Icon, color, label, value, sub }) {
  return (
    <div style={{ ...CARD, flex: 1, minWidth: 160 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: `${color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={18} color={color} />
        </div>
        <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: '#1f2937' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function ViolationRow({ row, expanded, onToggle }) {
  const violations = Array.isArray(row.violations) ? row.violations : [];
  const lastDate = row.last_violation ? new Date(row.last_violation).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

  return (
    <>
      <tr style={{ background: expanded ? '#faf5ff' : '#fff', borderBottom: '1px solid #f0f0f4' }}>
        <td style={{ padding: '12px 16px' }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: '#1f2937' }}>{row.employee_name}</div>
          <div style={{ fontSize: 12, color: '#9ca3af' }}>{row.designation || '—'}</div>
        </td>
        <td style={{ padding: '12px 16px', fontSize: 13, color: '#6b7280' }}>{row.department || '—'}</td>
        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
          <span style={{
            background: row.violation_count >= 5 ? '#fef2f2' : row.violation_count >= 2 ? '#fffbeb' : '#f0fdf4',
            color: row.violation_count >= 5 ? '#dc2626' : row.violation_count >= 2 ? '#d97706' : '#16a34a',
            borderRadius: 20, padding: '3px 12px', fontSize: 13, fontWeight: 700,
          }}>
            {row.violation_count}
          </span>
        </td>
        <td style={{ padding: '12px 16px', fontSize: 13, color: '#6b7280' }}>{lastDate}</td>
        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
          <button onClick={onToggle}
            style={{ border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: P, fontSize: 13, fontWeight: 500 }}>
            {expanded ? <><ChevronUp size={14} /> Hide</> : <><ChevronDown size={14} /> Details</>}
          </button>
        </td>
      </tr>
      {expanded && violations.slice(0, 10).map((v, i) => (
        <tr key={i} style={{ background: '#faf5ff', borderBottom: '1px solid #f3f0ff' }}>
          <td colSpan={5} style={{ padding: '8px 32px' }}>
            <div style={{ display: 'flex', gap: 20, alignItems: 'center', fontSize: 12 }}>
              <span style={{ color: '#6b7280', minWidth: 80 }}>
                {v.date ? new Date(v.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
              </span>
              <span style={{ background: '#fee2e2', color: '#dc2626', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>
                {v.distance_m ? `${v.distance_m}m away` : '—'}
              </span>
              <span style={{ color: '#374151', fontWeight: 500 }}>{v.rule || 'Unknown zone'}</span>
              <span style={{ color: '#9ca3af' }}>Allowed: {v.radius_m ? `${v.radius_m}m` : '—'}</span>
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

export default function GeoViolationsReport() {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const [fromDate, setFromDate] = useState(thirtyDaysAgo);
  const [toDate, setToDate] = useState(today);
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedRows, setExpandedRows] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      const res = await api.get(`/attendance/geo-violations?${params}`);
      setData(res.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load geo violations');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  const exportCSV = () => {
    if (!data?.employees?.length) return;
    const rows = data.employees.map(r => [
      r.employee_name, r.department || '', r.designation || '',
      r.violation_count, new Date(r.last_violation).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }),
    ]);
    const csv = [
      ['Employee', 'Department', 'Designation', 'Violations', 'Last Violation'],
      ...rows,
    ].map(r => r.join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `geo-violations-${fromDate}-to-${toDate}.csv`;
    a.click();
  };

  const toggleRow = (id) => setExpandedRows(p => ({ ...p, [id]: !p[id] }));

  const employees = (data?.employees || []).filter(r =>
    !search || r.employee_name?.toLowerCase().includes(search.toLowerCase()) ||
    r.department?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <MapPin size={18} color="#dc2626" />
            </div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1f2937' }}>Geo Violation Report</h2>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            Clock-in attempts blocked outside mandatory geo-fence zones
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={load} disabled={loading}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            Refresh
          </button>
          <button onClick={exportCSV} disabled={!data?.employees?.length}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* Date filters */}
      <div style={{ ...CARD, marginBottom: 20, display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>From Date</label>
          <input type="date" value={fromDate} max={toDate}
            onChange={e => setFromDate(e.target.value)}
            style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none' }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>To Date</label>
          <input type="date" value={toDate} min={fromDate} max={today}
            onChange={e => setToDate(e.target.value)}
            style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none' }} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Search</label>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
            <input placeholder="Employee or department..."
              value={search} onChange={e => setSearch(e.target.value)}
              style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 10px 7px 30px', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
          </div>
        </div>
        <button onClick={load}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>
          <Filter size={14} /> Apply
        </button>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 14, marginBottom: 20, color: '#dc2626', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* KPI cards */}
      {data && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          <KPICard icon={AlertTriangle} color="#dc2626" label="Total Violations"
            value={data.summary?.total_violations ?? 0}
            sub={`${fromDate} to ${toDate}`} />
          <KPICard icon={Users} color="#f59e0b" label="Employees Affected"
            value={data.summary?.employees_affected ?? 0}
            sub="Unique employees with violations" />
          <KPICard icon={Calendar} color="#ef4444" label="Today's Violations"
            value={data.summary?.today_violations ?? 0}
            sub="Clock-in blocks today" />
          <KPICard icon={Shield} color="#6B3FDB" label="Compliance Risk"
            value={data.summary?.employees_affected >= 5 ? 'HIGH' : data.summary?.employees_affected >= 2 ? 'MEDIUM' : 'LOW'}
            sub="Based on affected employee count" />
        </div>
      )}

      {/* Table */}
      <div style={CARD}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>
            <RefreshCw size={24} style={{ marginBottom: 12, animation: 'spin 1s linear infinite' }} />
            <p style={{ margin: 0, fontSize: 14 }}>Loading violations...</p>
          </div>
        ) : employees.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <Shield size={24} color="#16a34a" />
            </div>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: '#1f2937' }}>No Violations Found</h3>
            <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
              {search ? 'No results match your search.' : 'No geo-fence violations in the selected date range.'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #f0f0f4', background: '#fafaf9' }}>
                  <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>Employee</th>
                  <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>Department</th>
                  <th style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 600, color: '#374151' }}>Violations</th>
                  <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>Last Violation</th>
                  <th style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 600, color: '#374151' }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {employees.map(row => (
                  <ViolationRow
                    key={row.employee_id}
                    row={row}
                    expanded={!!expandedRows[row.employee_id]}
                    onToggle={() => toggleRow(row.employee_id)}
                  />
                ))}
              </tbody>
            </table>
            <div style={{ padding: '12px 16px', fontSize: 12, color: '#9ca3af', borderTop: '1px solid #f0f0f4' }}>
              Showing {employees.length} employee{employees.length !== 1 ? 's' : ''} with violations
            </div>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
