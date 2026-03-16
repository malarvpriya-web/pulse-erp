import { useState, useEffect, useCallback } from 'react';
import { TrendingUp, Users, Clock, BarChart2 } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Legend, Cell
} from 'recharts';
import api from '@/services/api/client';
import './UtilizationReport.css';

const SAMPLE_EMPLOYEES = [
  { id: 1, employee: 'Kiran Das',    department: 'Engineering', billable: 38, nonBillable: 7,  total: 45, utilization: 84 },
  { id: 2, employee: 'Meera Joshi',  department: 'Engineering', billable: 34, nonBillable: 4,  total: 38, utilization: 89 },
  { id: 3, employee: 'Rohit Gupta',  department: 'Operations',  billable: 28, nonBillable: 12, total: 40, utilization: 70 },
  { id: 4, employee: 'Sneha Iyer',   department: 'Finance',     billable: 30, nonBillable: 12, total: 42, utilization: 71 },
  { id: 5, employee: 'Vikram Singh', department: 'Sales',       billable: 35, nonBillable: 6,  total: 41, utilization: 85 },
  { id: 6, employee: 'Anika Patel',  department: 'HR',          billable: 20, nonBillable: 20, total: 40, utilization: 50 },
  { id: 7, employee: 'Arjun Mehta',  department: 'Sales',       billable: 36, nonBillable: 5,  total: 41, utilization: 88 },
  { id: 8, employee: 'Priya Sharma', department: 'Engineering', billable: 32, nonBillable: 8,  total: 40, utilization: 80 },
];

const SAMPLE_CHART = [
  { week: 'W1 Mar', billable: 276, nonBillable: 84 },
  { week: 'W2 Mar', billable: 290, nonBillable: 74 },
  { week: 'W3 Mar', billable: 268, nonBillable: 92 },
  { week: 'W4 Mar', billable: 310, nonBillable: 58 },
];

const PERIODS = ['This Month', 'Last Month', 'Q1 FY2026', 'Q2 FY2026', 'Q3 FY2026', 'Q4 FY2026'];

function utilizationColor(u) {
  if (u >= 80) return '#15803d';
  if (u >= 60) return '#1d4ed8';
  if (u >= 40) return '#d97706';
  return '#dc2626';
}

export default function UtilizationReport() {
  const [employees, setEmployees] = useState(SAMPLE_EMPLOYEES);
  const [chartData, setChartData] = useState(SAMPLE_CHART);
  const [loading, setLoading]     = useState(false);
  const [period, setPeriod]       = useState(PERIODS[0]);
  const [sortBy, setSortBy]       = useState('utilization');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [empRes, chartRes] = await Promise.allSettled([
        api.get('/timesheets/utilization', { params: { period } }),
        api.get('/timesheets/utilization/chart', { params: { period } }),
      ]);
      if (empRes.status === 'fulfilled') {
        const raw = empRes.value.data?.data ?? empRes.value.data;
        setEmployees(Array.isArray(raw) && raw.length ? raw : SAMPLE_EMPLOYEES);
      } else { setEmployees(SAMPLE_EMPLOYEES); }
      if (chartRes.status === 'fulfilled') {
        const raw = chartRes.value.data?.data ?? chartRes.value.data;
        setChartData(Array.isArray(raw) && raw.length ? raw : SAMPLE_CHART);
      } else { setChartData(SAMPLE_CHART); }
    } catch {
      setEmployees(SAMPLE_EMPLOYEES);
      setChartData(SAMPLE_CHART);
    }
    finally { setLoading(false); }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const sorted = [...employees].sort((a, b) => {
    if (sortBy === 'utilization') return b.utilization - a.utilization;
    if (sortBy === 'billable')    return b.billable - a.billable;
    if (sortBy === 'total')       return b.total - a.total;
    return 0;
  });

  const totalBillable    = employees.reduce((s, e) => s + e.billable, 0);
  const totalNonBillable = employees.reduce((s, e) => s + e.nonBillable, 0);
  const totalHours       = employees.reduce((s, e) => s + e.total, 0);
  const avgUtilization   = employees.length
    ? Math.round(employees.reduce((s, e) => s + e.utilization, 0) / employees.length)
    : 0;

  return (
    <div className="ur-root">
      <div className="ur-header">
        <div>
          <h1 className="ur-title">Utilization Report</h1>
          <p className="ur-sub">Billable vs non-billable hours analysis</p>
        </div>
        <div className="ur-header-r">
          <select className="ur-period-sel" value={period} onChange={e => setPeriod(e.target.value)}>
            {PERIODS.map(p => <option key={p}>{p}</option>)}
          </select>
        </div>
      </div>

      {/* Summary */}
      <div className="ur-summary">
        <div className="ur-sum-card">
          <div className="ur-sum-icon" style={{ background: '#eef2ff', color: '#4338ca' }}><TrendingUp size={18} /></div>
          <div>
            <div className="ur-sum-num">{avgUtilization}%</div>
            <div className="ur-sum-lbl">Avg Utilization</div>
          </div>
        </div>
        <div className="ur-sum-card">
          <div className="ur-sum-icon" style={{ background: '#dcfce7', color: '#15803d' }}><Clock size={18} /></div>
          <div>
            <div className="ur-sum-num">{totalBillable}h</div>
            <div className="ur-sum-lbl">Billable Hours</div>
          </div>
        </div>
        <div className="ur-sum-card">
          <div className="ur-sum-icon" style={{ background: '#fef3c7', color: '#92400e' }}><Clock size={18} /></div>
          <div>
            <div className="ur-sum-num">{totalNonBillable}h</div>
            <div className="ur-sum-lbl">Non-Billable Hours</div>
          </div>
        </div>
        <div className="ur-sum-card">
          <div className="ur-sum-icon" style={{ background: '#ede9fe', color: '#7c3aed' }}><Users size={18} /></div>
          <div>
            <div className="ur-sum-num">{totalHours}h</div>
            <div className="ur-sum-lbl">Total Hours Logged</div>
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="ur-chart-card">
        <div className="ur-card-title">Billable vs Non-Billable Hours <span className="ur-card-sub">by week</span></div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <XAxis dataKey="week" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={35} />
            <Tooltip formatter={(v, name) => [`${v}h`, name === 'billable' ? 'Billable' : 'Non-Billable']} />
            <Legend formatter={v => v === 'billable' ? 'Billable' : 'Non-Billable'} wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="billable"    name="billable"    fill="#6366f1" radius={[3,3,0,0]} />
            <Bar dataKey="nonBillable" name="nonBillable" fill="#e0e7ff" radius={[3,3,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="ur-table-hd">
        <span className="ur-table-title">Employee Utilization</span>
        <div className="ur-sort">
          <span className="ur-sort-lbl">Sort by:</span>
          {[['utilization','Utilization %'],['billable','Billable Hrs'],['total','Total Hrs']].map(([k,lbl]) => (
            <button key={k} className={`ur-sort-btn ${sortBy===k?'ur-sort-active':''}`} onClick={() => setSortBy(k)}>{lbl}</button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="ur-loading"><div className="ur-spinner" /></div>
      ) : (
        <div className="ur-table-wrap">
          <table className="ur-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Department</th>
                <th>Billable</th>
                <th>Non-Billable</th>
                <th>Total</th>
                <th>Utilization</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((e, rank) => {
                const uc = utilizationColor(e.utilization);
                return (
                  <tr key={e.id} className="ur-row">
                    <td>
                      <div className="ur-emp">
                        <div className="ur-rank">{rank + 1}</div>
                        <div className="ur-avatar">{e.employee.split(' ').map(w=>w[0]).join('').slice(0,2)}</div>
                        <span className="ur-emp-name">{e.employee}</span>
                      </div>
                    </td>
                    <td><span className="ur-dept">{e.department}</span></td>
                    <td><span className="ur-hrs ur-hrs-bill">{e.billable}h</span></td>
                    <td><span className="ur-hrs ur-hrs-nonbill">{e.nonBillable}h</span></td>
                    <td><span className="ur-hrs">{e.total}h</span></td>
                    <td>
                      <div className="ur-util-cell">
                        <span className="ur-util-num" style={{ color: uc }}>{e.utilization}%</span>
                        <div className="ur-util-track">
                          <div className="ur-util-fill" style={{ width: `${e.utilization}%`, background: uc }} />
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
