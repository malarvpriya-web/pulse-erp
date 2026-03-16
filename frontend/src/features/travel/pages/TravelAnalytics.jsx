import { useState, useEffect, useCallback } from 'react';
import { TrendingUp, DollarSign, Plane, AlertTriangle } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import api from '@/services/api/client';
import './TravelAnalytics.css';

const SAMPLE_STATS = { ytdSpend: 842000, avgTripCost: 14200, totalTrips: 59, policyViolations: 3 };

const SAMPLE_TREND = [
  { month: 'Apr', amount: 68000 }, { month: 'May', amount: 74000 }, { month: 'Jun', amount: 52000 },
  { month: 'Jul', amount: 89000 }, { month: 'Aug', amount: 95000 }, { month: 'Sep', amount: 78000 },
  { month: 'Oct', amount: 95000 }, { month: 'Nov', amount: 120000 }, { month: 'Dec', amount: 88000 },
  { month: 'Jan', amount: 134000 }, { month: 'Feb', amount: 115000 }, { month: 'Mar', amount: 142000 },
];

const SAMPLE_DEPT = [
  { dept: 'Sales', flights: 85000, hotels: 42000, meals: 15000, transport: 12000 },
  { dept: 'Engineering', flights: 62000, hotels: 28000, meals: 10000, transport: 8000 },
  { dept: 'Finance', flights: 35000, hotels: 18000, meals: 7000, transport: 5000 },
  { dept: 'HR', flights: 28000, hotels: 12000, meals: 5000, transport: 4000 },
  { dept: 'Ops', flights: 45000, hotels: 22000, meals: 9000, transport: 7000 },
];

const SAMPLE_CATEGORY = [
  { name: 'Flights', value: 255000, color: '#6366f1' },
  { name: 'Hotels', value: 122000, color: '#8b5cf6' },
  { name: 'Meals', value: 46000, color: '#a78bfa' },
  { name: 'Transport', value: 36000, color: '#c4b5fd' },
  { name: 'Misc', value: 28000, color: '#e0e7ff' },
];

const SAMPLE_TRAVELERS = [
  { employee: 'Vikram Singh', trips: 9, spend: 118000 },
  { employee: 'Arjun Mehta', trips: 8, spend: 98000 },
  { employee: 'Priya Sharma', trips: 7, spend: 89000 },
  { employee: 'Rohit Gupta', trips: 6, spend: 82000 },
  { employee: 'Sneha Iyer', trips: 5, spend: 74000 },
];

const fmt = n => n >= 100000 ? `₹${(n / 100000).toFixed(1)}L` : n >= 1000 ? `₹${(n / 1000).toFixed(0)}K` : `₹${n}`;

export default function TravelAnalytics() {
  const [stats, setStats]       = useState(SAMPLE_STATS);
  const [trend, setTrend]       = useState(SAMPLE_TREND);
  const [dept, setDept]         = useState(SAMPLE_DEPT);
  const [category, setCategory] = useState(SAMPLE_CATEGORY);
  const [travelers, setTravelers] = useState(SAMPLE_TRAVELERS);
  const [period, setPeriod]     = useState('FY');

  const load = useCallback(async () => {
    const [s, t, d, c, tr] = await Promise.allSettled([
      api.get('/travel/analytics/stats', { params: { period } }),
      api.get('/travel/analytics/trend', { params: { period } }),
      api.get('/travel/analytics/department', { params: { period } }),
      api.get('/travel/analytics/category', { params: { period } }),
      api.get('/travel/analytics/travelers', { params: { period } }),
    ]);
    if (s.status === 'fulfilled' && s.value?.data) setStats(s.value.data);
    if (t.status === 'fulfilled' && Array.isArray(t.value?.data) && t.value.data.length) setTrend(t.value.data);
    if (d.status === 'fulfilled' && Array.isArray(d.value?.data) && d.value.data.length) setDept(d.value.data);
    if (c.status === 'fulfilled' && Array.isArray(c.value?.data) && c.value.data.length) setCategory(c.value.data);
    if (tr.status === 'fulfilled' && Array.isArray(tr.value?.data) && tr.value.data.length) setTravelers(tr.value.data);
  }, [period]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="tvana-root">
      <div className="tvana-header">
        <div>
          <h1 className="tvana-title">Travel Analytics</h1>
          <p className="tvana-sub">Analyse travel spend and patterns</p>
        </div>
        <div className="tvana-period-btns">
          {['MTD', 'QTD', 'FY'].map(p => (
            <button key={p} className={`tvana-period-btn ${period === p ? 'tvana-period-active' : ''}`} onClick={() => setPeriod(p)}>{p}</button>
          ))}
        </div>
      </div>

      <div className="tvana-stats">
        {[
          { icon: <DollarSign size={18} />, num: fmt(stats.ytdSpend), lbl: 'YTD Spend', bg: '#eef2ff', cl: '#4338ca' },
          { icon: <Plane size={18} />, num: stats.totalTrips, lbl: 'Total Trips', bg: '#dcfce7', cl: '#15803d' },
          { icon: <TrendingUp size={18} />, num: fmt(stats.avgTripCost), lbl: 'Avg Trip Cost', bg: '#fef3c7', cl: '#92400e' },
          { icon: <AlertTriangle size={18} />, num: stats.policyViolations, lbl: 'Policy Violations', bg: '#fee2e2', cl: '#dc2626' },
        ].map((s, i) => (
          <div key={i} className="tvana-stat">
            <div className="tvana-stat-icon" style={{ background: s.bg, color: s.cl }}>{s.icon}</div>
            <div><div className="tvana-stat-num">{s.num}</div><div className="tvana-stat-lbl">{s.lbl}</div></div>
          </div>
        ))}
      </div>

      {/* Row 1: trend + category */}
      <div className="tvana-row2">
        <div className="tvana-card">
          <div className="tvana-card-title">Monthly Spend Trend</div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={trend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="tvanaG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="month" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `₹${v/1000}K`} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={50} />
              <Tooltip formatter={v => [fmt(v), 'Spend']} />
              <Area type="monotone" dataKey="amount" stroke="#6366f1" strokeWidth={2} fill="url(#tvanaG)" dot={{ r: 2, fill: '#6366f1' }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="tvana-card">
          <div className="tvana-card-title">Spend by Category</div>
          <div className="tvana-pie-wrap">
            <ResponsiveContainer width={150} height={150}>
              <PieChart>
                <Pie data={category} dataKey="value" cx="50%" cy="50%" innerRadius={38} outerRadius={62} paddingAngle={3}>
                  {category.map((e, i) => <Cell key={i} fill={e.color} />)}
                </Pie>
                <Tooltip formatter={v => [fmt(v)]} />
              </PieChart>
            </ResponsiveContainer>
            <div className="tvana-legend">
              {category.map((c, i) => (
                <div key={i} className="tvana-legend-item">
                  <span className="tvana-legend-dot" style={{ background: c.color }} />
                  <span className="tvana-legend-lbl">{c.name}</span>
                  <span className="tvana-legend-val">{fmt(c.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Row 2: dept bar + top travelers */}
      <div className="tvana-row2">
        <div className="tvana-card">
          <div className="tvana-card-title">Spend by Department</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dept} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <XAxis dataKey="dept" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `₹${v/1000}K`} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={50} />
              <Tooltip formatter={v => [fmt(v)]} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="flights" stackId="a" fill="#6366f1" name="Flights" radius={[0,0,0,0]} />
              <Bar dataKey="hotels"  stackId="a" fill="#8b5cf6" name="Hotels" />
              <Bar dataKey="meals"   stackId="a" fill="#a78bfa" name="Meals" />
              <Bar dataKey="transport" stackId="a" fill="#c4b5fd" name="Transport" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="tvana-card">
          <div className="tvana-card-title">Top Travelers</div>
          <table className="tvana-tbl">
            <thead><tr><th>Employee</th><th>Trips</th><th>Spend</th></tr></thead>
            <tbody>
              {travelers.map((t, i) => (
                <tr key={i}>
                  <td>
                    <div className="tvana-emp">
                      <div className="tvana-avatar">{t.employee.split(' ').map(w => w[0]).join('').slice(0,2)}</div>
                      {t.employee}
                    </div>
                  </td>
                  <td><span className="tvana-trips-badge">{t.trips}</span></td>
                  <td><span className="tvana-spend">{fmt(t.spend)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
