import { useState, useEffect } from 'react';
import {
  Trophy, TrendingUp, Users, Target, Award, Star,
  CheckCircle, Clock, AlertCircle, BarChart2, ArrowRight,
  RefreshCw, Activity, FileText
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, Cell, PieChart, Pie, Legend,
  LineChart, Line
} from 'recharts';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6'];

function KPICard({ label, value, sub, icon: Icon, color = '#3b82f6', index = 0 }) {
  return (
    <div className="dk-anim" style={{
      background: 'var(--color-background-secondary)',
      border: '0.5px solid var(--color-border-tertiary)',
      borderRadius: 'var(--border-radius-lg)',
      padding: '12px 14px',
      display: 'flex', alignItems: 'center', gap: 11, '--dk-i': index,
    }}>
      <div style={{
        width: 38, height: 38, borderRadius: 10,
        background: `${color}18`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon size={18} style={{ color }} />
      </div>
      <div>
        <p style={{ fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--color-text-primary)' }}>{value ?? '—'}</p>
        <p style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', margin: 0 }}>{label}</p>
        {sub && <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)', margin: 0 }}>{sub}</p>}
      </div>
    </div>
  );
}

export default function PerformanceDashboard() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [dash, setDash]     = useState(null);
  const [dist, setDist]     = useState([]);
  const [deptPerf, setDeptPerf] = useState([]);
  const [topPerf, setTopPerf]   = useState([]);
  const [goalRate, setGoalRate] = useState([]);
  const [cycle, setCycle]       = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [dashRes, distRes, deptRes, topRes, goalRes, cycleRes] = await Promise.allSettled([
        api.get('/performance/analytics/dashboard'),
        api.get('/performance/analytics/rating-distribution'),
        api.get('/performance/team/department-performance'),
        api.get('/performance/team/top-performers'),
        api.get('/performance/goals/completion-rate'),
        api.get('/performance/cycles/active/current'),
      ]);
      if (dashRes.status === 'fulfilled') setDash(dashRes.value.data);
      if (distRes.status === 'fulfilled') setDist(distRes.value.data || []);
      if (deptRes.status === 'fulfilled') setDeptPerf(deptRes.value.data || []);
      if (topRes.status === 'fulfilled')  setTopPerf(topRes.value.data || []);
      if (goalRes.status === 'fulfilled') setGoalRate(goalRes.value.data || []);
      if (cycleRes.status === 'fulfilled') setCycle(cycleRes.value.data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, gap: 8 }}>
      <RefreshCw size={18} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-primary)' }} />
      <span style={{ color: 'var(--color-text-secondary)' }}>Loading PMS Dashboard...</span>
    </div>
  );

  if (error) return (
    <div style={{ padding: 32, color: '#ef4444', display: 'flex', gap: 8, alignItems: 'center' }}>
      <AlertCircle size={18} /> {error}
    </div>
  );

  const totalReviews   = dash?.total_reviews ?? 0;
  const completed      = dash?.completed_reviews ?? 0;
  const completionPct  = totalReviews ? Math.round(completed * 100 / totalReviews) : 0;
  const avgRating      = dash?.avg_rating ?? '—';
  const pendingSelf    = dash?.pending_self ?? 0;
  const pendingMgr     = dash?.pending_manager ?? 0;

  const ratingChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={dist}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" />
        <XAxis dataKey="rating_band" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => [v, 'Employees']} />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {dist.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  const deptChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={deptPerf} layout="vertical">
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" />
        <XAxis type="number" domain={[0, 5]} tick={{ fontSize: 11 }} />
        <YAxis dataKey="department" type="category" tick={{ fontSize: 11 }} width={90} />
        <Tooltip formatter={(v) => [Number(v).toFixed(2), 'Avg Rating']} />
        <Bar dataKey="avg_rating" fill="#3b82f6" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );

  const goalChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <LineChart data={goalRate}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" />
        <XAxis dataKey="review_period" tick={{ fontSize: 11 }} />
        <YAxis unit="%" tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => [`${v}%`, 'Completion Rate']} />
        <Line type="monotone" dataKey="completion_rate" stroke="#10b981" strokeWidth={2} dot />
      </LineChart>
    </ResponsiveContainer>
  );

  return (
    <div style={{ padding: '16px 18px 20px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Trophy size={20} style={{ color: 'var(--color-primary)' }} />
            PMS Dashboard
          </h1>
          {cycle && (
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '4px 0 0' }}>
              Active Cycle: <strong>{cycle.name}</strong> — {cycle.review_period}
            </p>
          )}
        </div>
        <button onClick={load} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 16px', borderRadius: 8,
          background: 'var(--color-background-secondary)',
          border: '0.5px solid var(--color-border-tertiary)',
          cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)',
        }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Cycle deadline strip */}
      {cycle && (
        <div style={{
          background: '#3b82f618', borderRadius: 10, padding: '8px 14px',
          marginBottom: 12, display: 'flex', gap: 24, flexWrap: 'wrap',
        }}>
          {cycle.self_review_deadline && (
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              Self Review: <strong style={{ color: 'var(--color-text-primary)' }}>{cycle.self_review_deadline}</strong>
            </span>
          )}
          {cycle.manager_review_deadline && (
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              Manager Review: <strong style={{ color: 'var(--color-text-primary)' }}>{cycle.manager_review_deadline}</strong>
            </span>
          )}
          {cycle.calibration_deadline && (
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              Calibration: <strong style={{ color: 'var(--color-text-primary)' }}>{cycle.calibration_deadline}</strong>
            </span>
          )}
          <span style={{
            marginLeft: 'auto', fontSize: 12, fontWeight: 600,
            padding: '2px 10px', borderRadius: 20,
            background: cycle.status === 'active' ? '#10b98118' : '#f59e0b18',
            color: cycle.status === 'active' ? '#10b981' : '#f59e0b',
          }}>
            {cycle.status?.toUpperCase()}
          </span>
        </div>
      )}

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 12 }}>
        <KPICard index={0} label="Total Reviews" value={totalReviews} icon={FileText} color="#3b82f6" />
        <KPICard index={1} label="Completed Reviews" value={`${completed} (${completionPct}%)`} icon={CheckCircle} color="#10b981" />
        <KPICard index={2} label="Pending Self Reviews" value={pendingSelf} icon={Clock} color="#f59e0b" />
        <KPICard index={3} label="Pending Manager Reviews" value={pendingMgr} icon={Users} color="#ef4444" />
        <KPICard index={4} label="Avg Rating" value={avgRating} sub="(calibrated)" icon={Star} color="#8b5cf6" />
        <KPICard index={5} label="Top Performers" value={topPerf.length} sub="Rating ≥ 4.0" icon={Award} color="#10b981" />
      </div>

      {/* Charts row 1 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        {/* Rating Distribution */}
        <div style={{
          background: 'var(--color-background-secondary)',
          border: '0.5px solid var(--color-border-tertiary)',
          borderRadius: 'var(--border-radius-lg)', padding: 14, '--dk-i': 6,
        }} className="dk-anim">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 9px' }}>
            <h3 style={{ fontSize: 13.5, fontWeight: 600, margin: 0, color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <BarChart2 size={15} /> Rating Distribution
            </h3>
            {dist.length > 0 && <ChartExpandButton title="Rating Distribution">{ratingChart(430)}</ChartExpandButton>}
          </div>
          {dist.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', textAlign: 'center', padding: '32px 0' }}>No completed reviews yet</p>
          ) : ratingChart(180)}
        </div>

        {/* Department Performance */}
        <div style={{
          background: 'var(--color-background-secondary)',
          border: '0.5px solid var(--color-border-tertiary)',
          borderRadius: 'var(--border-radius-lg)', padding: 14, '--dk-i': 7,
        }} className="dk-anim">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 9px' }}>
            <h3 style={{ fontSize: 13.5, fontWeight: 600, margin: 0, color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <TrendingUp size={15} /> Department Performance
            </h3>
            {deptPerf.length > 0 && <ChartExpandButton title="Department Performance">{deptChart(430)}</ChartExpandButton>}
          </div>
          {deptPerf.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', textAlign: 'center', padding: '32px 0' }}>No department data</p>
          ) : deptChart(180)}
        </div>
      </div>

      {/* Goal Completion trend */}
      {goalRate.length > 0 && (
        <div style={{
          background: 'var(--color-background-secondary)',
          border: '0.5px solid var(--color-border-tertiary)',
          borderRadius: 'var(--border-radius-lg)', padding: 14, marginBottom: 12, '--dk-i': 8,
        }} className="dk-anim">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 9px' }}>
            <h3 style={{ fontSize: 13.5, fontWeight: 600, margin: 0, color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Target size={15} /> Goal Completion Rate by Period
            </h3>
            <ChartExpandButton title="Goal Completion Rate by Period">{goalChart(430)}</ChartExpandButton>
          </div>
          {goalChart(165)}
        </div>
      )}

      {/* Top Performers table */}
      {topPerf.length > 0 && (
        <div style={{
          background: 'var(--color-background-secondary)',
          border: '0.5px solid var(--color-border-tertiary)',
          borderRadius: 'var(--border-radius-lg)', padding: 14, '--dk-i': 9,
        }} className="dk-anim">
          <h3 style={{ fontSize: 13.5, fontWeight: 600, margin: '0 0 9px', color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Award size={15} /> Top Performers
          </h3>
          <div style={{ overflowX: 'auto', maxHeight: 300, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Employee', 'Department', 'Designation', 'Avg Rating', 'Reviews'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--color-background-secondary)', borderBottom: '1px solid var(--color-border-tertiary)', zIndex: 1 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topPerf.map((p, i) => (
                  <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 500 }}>{p.name}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{p.department}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{p.designation}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{
                        background: '#10b98118', color: '#10b981',
                        padding: '2px 8px', borderRadius: 20, fontWeight: 600, fontSize: 12,
                      }}>{p.avg_rating}</span>
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{p.review_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
