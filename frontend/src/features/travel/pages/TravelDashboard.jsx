import { useState, useEffect, useCallback } from 'react';
import { Plane, Clock, DollarSign, TrendingUp, Plus, ChevronRight, MapPin, Calendar } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import api from '@/services/api/client';
import './TravelDashboard.css';

const SAMPLE_STATS = { totalTrips: 24, pendingApprovals: 5, expensesThisMonth: 142000, advanceBalance: 38500 };

const SAMPLE_REQUESTS = [
  { id: 1, employee: 'Arjun Mehta', destination: 'Mumbai', purpose: 'Client Meeting', travelDate: '2026-03-20', status: 'Pending' },
  { id: 2, employee: 'Priya Sharma', destination: 'Bengaluru', purpose: 'Conference', travelDate: '2026-03-22', status: 'Approved' },
  { id: 3, employee: 'Rahul Verma', destination: 'Delhi', purpose: 'Training', travelDate: '2026-03-25', status: 'Pending' },
  { id: 4, employee: 'Sneha Iyer', destination: 'Chennai', purpose: 'Audit', travelDate: '2026-03-28', status: 'Approved' },
  { id: 5, employee: 'Kiran Das', destination: 'Hyderabad', purpose: 'Sales Visit', travelDate: '2026-04-01', status: 'Draft' },
];

const SAMPLE_TREND = [
  { month: 'Oct', amount: 95000 }, { month: 'Nov', amount: 120000 }, { month: 'Dec', amount: 88000 },
  { month: 'Jan', amount: 134000 }, { month: 'Feb', amount: 115000 }, { month: 'Mar', amount: 142000 },
];

const SAMPLE_CATEGORY = [
  { name: 'Flights', value: 62000, color: '#6366f1' },
  { name: 'Hotels', value: 41000, color: '#8b5cf6' },
  { name: 'Meals', value: 18000, color: '#a78bfa' },
  { name: 'Transport', value: 14000, color: '#c4b5fd' },
  { name: 'Misc', value: 7000, color: '#e0e7ff' },
];

const STATUS_COLORS = { Pending: '#fef3c7', Approved: '#dcfce7', Draft: '#f3f4f6', Rejected: '#fee2e2', Completed: '#e0e7ff' };
const STATUS_TEXT   = { Pending: '#92400e', Approved: '#15803d', Draft: '#374151', Rejected: '#991b1b', Completed: '#4338ca' };

const fmt = n => n >= 100000 ? `₹${(n / 100000).toFixed(1)}L` : n >= 1000 ? `₹${(n / 1000).toFixed(0)}K` : `₹${n}`;

export default function TravelDashboard({ setPage }) {
  const [stats, setStats]       = useState(SAMPLE_STATS);
  const [requests, setRequests] = useState(SAMPLE_REQUESTS);
  const [trend, setTrend]       = useState(SAMPLE_TREND);
  const [category, setCategory] = useState(SAMPLE_CATEGORY);

  const load = useCallback(async () => {
    const [s, r, t, c] = await Promise.allSettled([
      api.get('/travel/dashboard'),
      api.get('/travel/requests', { params: { limit: 5 } }),
      api.get('/travel/analytics/trend'),
      api.get('/travel/analytics/category'),
    ]);
    if (s.status === 'fulfilled' && s.value?.data) setStats(s.value.data);
    if (r.status === 'fulfilled' && Array.isArray(r.value?.data?.data ?? r.value?.data)) {
      const d = r.value.data?.data ?? r.value.data;
      if (d.length) setRequests(d);
    }
    if (t.status === 'fulfilled' && Array.isArray(t.value?.data) && t.value.data.length) setTrend(t.value.data);
    if (c.status === 'fulfilled' && Array.isArray(c.value?.data) && c.value.data.length) setCategory(c.value.data);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="tvd-root">
      <div className="tvd-header">
        <div>
          <h1 className="tvd-title">Travel Dashboard</h1>
          <p className="tvd-sub">Overview of travel requests, expenses &amp; bookings</p>
        </div>
        <button className="tvd-btn-primary" onClick={() => setPage && setPage('TravelRequests')}>
          <Plus size={15} /> New Request
        </button>
      </div>

      <div className="tvd-stats">
        {[
          { icon: <Plane size={18} />, num: stats.totalTrips, lbl: 'Total Trips', bg: '#eef2ff', cl: '#4338ca' },
          { icon: <Clock size={18} />, num: stats.pendingApprovals, lbl: 'Pending Approvals', bg: '#fef3c7', cl: '#92400e' },
          { icon: <DollarSign size={18} />, num: fmt(stats.expensesThisMonth), lbl: 'Expenses This Month', bg: '#dcfce7', cl: '#15803d' },
          { icon: <TrendingUp size={18} />, num: fmt(stats.advanceBalance), lbl: 'Advance Balance', bg: '#ede9fe', cl: '#7c3aed' },
        ].map((s, i) => (
          <div key={i} className="tvd-stat">
            <div className="tvd-stat-icon" style={{ background: s.bg, color: s.cl }}>{s.icon}</div>
            <div><div className="tvd-stat-num">{s.num}</div><div className="tvd-stat-lbl">{s.lbl}</div></div>
          </div>
        ))}
      </div>

      <div className="tvd-charts">
        <div className="tvd-chart-card">
          <div className="tvd-card-hd"><span className="tvd-card-title">Monthly Expense Trend</span></div>
          <ResponsiveContainer width="100%" height={190}>
            <AreaChart data={trend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="tvdG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `₹${v / 1000}K`} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
              <Tooltip formatter={v => [fmt(v), 'Expenses']} />
              <Area type="monotone" dataKey="amount" stroke="#6366f1" strokeWidth={2} fill="url(#tvdG)" dot={{ r: 3, fill: '#6366f1' }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="tvd-chart-card">
          <div className="tvd-card-hd"><span className="tvd-card-title">By Category</span></div>
          <div className="tvd-pie-wrap">
            <ResponsiveContainer width={160} height={160}>
              <PieChart>
                <Pie data={category} dataKey="value" cx="50%" cy="50%" innerRadius={42} outerRadius={68} paddingAngle={3}>
                  {category.map((e, i) => <Cell key={i} fill={e.color} />)}
                </Pie>
                <Tooltip formatter={v => [fmt(v)]} />
              </PieChart>
            </ResponsiveContainer>
            <div className="tvd-legend">
              {category.map((c, i) => (
                <div key={i} className="tvd-legend-item">
                  <span className="tvd-legend-dot" style={{ background: c.color }} />
                  <span className="tvd-legend-lbl">{c.name}</span>
                  <span className="tvd-legend-val">{fmt(c.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="tvd-table-card">
        <div className="tvd-card-hd">
          <span className="tvd-card-title">Recent Travel Requests</span>
          <button className="tvd-link-btn" onClick={() => setPage && setPage('TravelRequests')}>
            View All <ChevronRight size={13} />
          </button>
        </div>
        <div className="tvd-table-wrap">
          <table className="tvd-table">
            <thead><tr><th>Employee</th><th>Destination</th><th>Purpose</th><th>Travel Date</th><th>Status</th></tr></thead>
            <tbody>
              {requests.map(r => (
                <tr key={r.id} className="tvd-row">
                  <td><div className="tvd-emp"><div className="tvd-avatar">{r.employee.split(' ').map(w => w[0]).join('').slice(0, 2)}</div>{r.employee}</div></td>
                  <td><div className="tvd-dest"><MapPin size={11} />{r.destination}</div></td>
                  <td>{r.purpose}</td>
                  <td><div className="tvd-date-cell"><Calendar size={11} />{new Date(r.travelDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</div></td>
                  <td><span className="tvd-badge" style={{ background: STATUS_COLORS[r.status], color: STATUS_TEXT[r.status] }}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="tvd-quick-actions">
        {[
          { label: 'My Requests', page: 'TravelRequests' },
          { label: 'Approvals', page: 'TravelApprovals' },
          { label: 'Expense Claims', page: 'TravelExpenses' },
          { label: 'Bookings', page: 'TravelBookings' },
          { label: 'Advances', page: 'TravelAdvances' },
          { label: 'Analytics', page: 'TravelAnalytics' },
        ].map(a => (
          <button key={a.page} className="tvd-action-btn" onClick={() => setPage && setPage(a.page)}>
            {a.label} <ChevronRight size={13} />
          </button>
        ))}
      </div>
    </div>
  );
}
