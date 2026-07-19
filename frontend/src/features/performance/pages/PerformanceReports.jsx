import { useState, useEffect } from 'react';
import { Download, FileText, BarChart2, Target, TrendingUp, Award, Users, MessageSquare, RefreshCw, AlertCircle, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';

const REPORTS = [
  { key: 'summary',           label: 'Performance Summary',      desc: 'All employees with ratings, self/manager scores, KRA, calibrated rating', icon: FileText,    color: '#3b82f6', roles: ['manager', 'hr', 'super_admin', 'admin'] },
  { key: 'pending',           label: 'Pending Reviews',          desc: 'Who hasn\'t completed self or manager reviews yet', icon: RefreshCw,   color: '#f59e0b', roles: ['manager', 'hr', 'super_admin', 'admin'] },
  { key: 'rating-distribution', label: 'Rating Distribution',   desc: 'Bell curve breakdown by department and rating band', icon: BarChart2,   color: '#8b5cf6', roles: ['manager', 'hr', 'super_admin', 'admin'] },
  { key: 'goals',             label: 'Goal Completion',          desc: 'Goal status, achievement %, targets vs actuals per employee', icon: Target,     color: '#10b981', roles: ['manager', 'hr', 'super_admin', 'admin'] },
  { key: 'kra-scores',        label: 'KRA Scores',               desc: 'Per-KRA scores (self, manager, final) for all employees', icon: BarChart2,  color: '#f59e0b', roles: ['manager', 'hr', 'super_admin', 'admin'] },
  { key: 'increments',        label: 'Increment Recommendations', desc: 'Increment % and new CTC by department with approval status', icon: TrendingUp, color: '#10b981', roles: ['hr', 'super_admin', 'admin'] },
  { key: 'promotions',        label: 'Promotion Pipeline',        desc: 'All promotion recommendations with current/proposed designation', icon: Award,     color: '#ef4444', roles: ['hr', 'super_admin', 'admin'] },
  { key: 'feedback360',       label: '360° Feedback Summary',    desc: 'Feedback completion rate and average scores per employee', icon: MessageSquare, color: '#3b82f6', roles: ['hr', 'super_admin', 'admin'] },
];

export default function PerformanceReports() {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set. Filtering the report list by it alone hid every HR report from someone
  // holding hr as a secondary role. See AuthContext.
  const { hasAnyRole } = useAuth();

  const [activeReport, setActiveReport] = useState(null);
  const [data, setData]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);
  const [filters, setFilters] = useState({ cycle_id: '', department: '' });
  const [deptList, setDeptList] = useState([]);

  useEffect(() => {
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  const accessible = REPORTS.filter(r => hasAnyRole(...r.roles));

  async function loadReport(key) {
    setLoading(true);
    setError(null);
    setActiveReport(key);
    try {
      const params = new URLSearchParams();
      if (filters.cycle_id)   params.set('cycle_id', filters.cycle_id);
      if (filters.department) params.set('department', filters.department);
      const res = await api.get(`/performance/reports/${key}?${params}`);
      setData(res.data || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function downloadCSV(key) {
    try {
      const params = new URLSearchParams({ format: 'csv' });
      if (filters.cycle_id)   params.set('cycle_id', filters.cycle_id);
      if (filters.department) params.set('department', filters.department);
      const res = await api.get(`/performance/reports/${key}?${params}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a   = document.createElement('a');
      a.href    = url;
      a.download = `${key}_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e.message); }
  }

  const inp = { background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '7px 12px', fontSize: 13, color: 'var(--color-text-primary)' };

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px', color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <FileText size={20} style={{ color: 'var(--color-primary)' }} /> PMS Reports
      </h1>
      <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 24px' }}>All reports support CSV export. Use filters to scope by cycle or department.</p>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 24, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontWeight: 600 }}>Department:</label>
          <select style={{ ...inp, width: 180 }} value={filters.department} onChange={e => setFilters(f => ({ ...f, department: e.target.value }))}>
            <option value="">All Departments</option>
            {deptList.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontWeight: 600 }}>Cycle ID:</label>
          <input style={{ ...inp, width: 100 }} type="number" value={filters.cycle_id} onChange={e => setFilters(f => ({ ...f, cycle_id: e.target.value }))} placeholder="All cycles" />
        </div>
        {activeReport && (
          <button onClick={() => loadReport(activeReport)} style={{ padding: '7px 16px', background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={13} /> Apply Filters
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: '#ef444418', color: '#ef4444', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={15} /> {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}><X size={14} /></button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginBottom: 28 }}>
        {accessible.map(r => {
          const Icon = r.icon;
          const isActive = activeReport === r.key;
          return (
            <div key={r.key} onClick={() => loadReport(r.key)} style={{
              background: isActive ? `${r.color}12` : 'var(--color-background-secondary)',
              border: isActive ? `1.5px solid ${r.color}` : '0.5px solid var(--color-border-tertiary)',
              borderRadius: 12, padding: '16px 20px', cursor: 'pointer',
              transition: 'all 0.15s',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: `${r.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon size={16} style={{ color: r.color }} />
                </div>
                <button onClick={e => { e.stopPropagation(); downloadCSV(r.key); }} style={{
                  padding: '4px 10px', background: `${r.color}18`, color: r.color,
                  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  <Download size={11} /> CSV
                </button>
              </div>
              <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 14, color: 'var(--color-text-primary)' }}>{r.label}</p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-secondary)' }}>{r.desc}</p>
            </div>
          );
        })}
      </div>

      {/* Report Data Preview */}
      {activeReport && (
        <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '0.5px solid var(--color-border-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              {REPORTS.find(r => r.key === activeReport)?.label} — {data.length} records
            </h3>
            <button onClick={() => downloadCSV(activeReport)} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
              background: 'var(--color-primary)', color: '#fff', border: 'none',
              borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600,
            }}>
              <Download size={13} /> Export CSV
            </button>
          </div>

          {loading ? (
            <div style={{ textAlign: 'center', padding: 48 }}><RefreshCw size={18} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-primary)' }} /></div>
          ) : data.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--color-text-secondary)' }}>
              <p style={{ margin: 0 }}>No data found for the selected filters</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border-tertiary)', background: 'var(--color-background)' }}>
                    {Object.keys(data[0]).map(k => (
                      <th key={k} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', textTransform: 'capitalize' }}>
                        {k.replace(/_/g, ' ')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.slice(0, 100).map((row, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                      {Object.values(row).map((v, j) => (
                        <td key={j} style={{ padding: '8px 12px', color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }}>
                          {v == null ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.length > 100 && (
                <p style={{ padding: '8px 16px', fontSize: 12, color: 'var(--color-text-secondary)', borderTop: '0.5px solid var(--color-border-tertiary)', margin: 0 }}>
                  Showing first 100 of {data.length} records. Export CSV for full data.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
