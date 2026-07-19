import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '@/services/api/client';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Users, Star, TrendingUp, Target, Award, CheckCircle, Clock, AlertTriangle, ChevronUp, ChevronDown } from 'lucide-react';
import './TeamPerformance.css';

const ratingColor = r => r >= 4 ? '#10b981' : r >= 3 ? '#6366f1' : r >= 2 ? '#f59e0b' : '#ef4444';

const REVIEW_STATUS = {
  completed:             { label: 'Completed',       bg: '#dcfce7', color: '#15803d' },
  self_submitted:        { label: 'Self Submitted',  bg: '#dbeafe', color: '#1d4ed8' },
  pending_manager_review:{ label: 'Awaiting Mgr',   bg: '#fef3c7', color: '#d97706' },
  self_review_pending:   { label: 'Not Started',     bg: '#f3f4f6', color: '#6b7280' },
  in_progress:           { label: 'In Progress',     bg: '#ede9fe', color: '#6d28d9' },
};

function ReviewStatusPill({ status }) {
  const s = REVIEW_STATUS[status] || REVIEW_STATUS.self_review_pending;
  return <span className="tp-status-pill" style={{ background: s.bg, color: s.color }}>{s.label}</span>;
}

function Stars({ val }) {
  return (
    <span className="tp-stars">
      {[1,2,3,4,5].map(i => (
        <Star key={i} size={11}
          color={i <= Math.round(val||0) ? '#f59e0b' : '#e5e7eb'}
          fill={i <= Math.round(val||0) ? '#f59e0b' : 'none'} />
      ))}
      <span className="tp-rating-num">{val ? Number(val).toFixed(1) : '—'}</span>
    </span>
  );
}

function Avatar({ name, size = 30 }) {
  const initials = (name || '?').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="tp-avatar" style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {initials}
    </div>
  );
}

export default function TeamPerformance() {
  const [members,   setMembers]   = useState([]);
  const [deptStats, setDeptStats] = useState([]);
  const [topPerfs,  setTopPerfs]  = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [sortKey,   setSortKey]   = useState('name');
  const [sortAsc,   setSortAsc]   = useState(true);
  const [deptFilter,setDeptFilter]= useState('all');
  const [tab,       setTab]       = useState('team');

  const load = useCallback(async () => {
    setLoading(true);
    const [membRes, deptRes, topRes] = await Promise.allSettled([
      api.get('/performance/team/members'),
      api.get('/performance/analytics/department-performance'),
      api.get('/performance/analytics/top-performers?limit=5'),
    ]);
    setMembers(membRes.status === 'fulfilled' ? (membRes.value?.data || []) : []);
    if (deptRes.status === 'fulfilled' && deptRes.value?.data?.length) {
      setDeptStats(deptRes.value.data.map(d => ({
        dept: d.department || 'General',
        avg:  d.avg_rating ? +Number(d.avg_rating).toFixed(2) : 0,
        count: Number(d.employee_count || 0),
        promos: Number(d.promotion_recommendations || 0),
      })));
    }
    setTopPerfs(topRes.status === 'fulfilled' ? (topRes.value?.data || []) : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const departments = useMemo(() => ['all', ...new Set(members.map(m => m.department).filter(Boolean))], [members]);

  const filtered = useMemo(() => {
    let list = deptFilter === 'all' ? members : members.filter(m => m.department === deptFilter);
    list = [...list].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (sortKey === 'final_rating' || sortKey === 'avg_goal_pct') {
        av = Number(av) || 0; bv = Number(bv) || 0;
      }
      if (av < bv) return sortAsc ? -1 : 1;
      if (av > bv) return sortAsc ? 1 : -1;
      return 0;
    });
    return list;
  }, [members, deptFilter, sortKey, sortAsc]);

  const kpis = useMemo(() => {
    const completed  = members.filter(m => m.review_status === 'completed').length;
    const notStarted = members.filter(m => !m.review_status || m.review_status === 'self_review_pending').length;
    const avgRating  = members.length ? (members.reduce((s, m) => s + Number(m.final_rating || 0), 0) / members.length).toFixed(1) : '—';
    const totalGoals = members.reduce((s, m) => s + Number(m.total_goals || 0), 0);
    const achieved   = members.reduce((s, m) => s + Number(m.achieved_goals || 0), 0);
    return { total: members.length, completed, notStarted, avgRating, totalGoals, achieved };
  }, [members]);

  const sort = (key) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  };

  const SortIcon = ({ k }) => sortKey === k
    ? (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
    : null;

  return (
    <div className="tp-root">
      {/* Header */}
      <div className="tp-header">
        <div className="tp-header-left">
          <div className="tp-header-icon"><Users size={20} /></div>
          <div>
            <h1 className="tp-title">Team Performance</h1>
            <p className="tp-sub">Reviews, goals, and ratings across the team</p>
          </div>
        </div>
        <div className="tp-header-right">
          <select className="tp-dept-sel" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
            {departments.map(d => <option key={d} value={d}>{d === 'all' ? 'All Departments' : d}</option>)}
          </select>
        </div>
      </div>

      <div className="tp-body">
        {/* KPIs */}
        <div className="tp-kpis">
          {[
            { icon: <Users size={18} />,       val: kpis.total,      label: 'Team Size',         bg: '#eef2ff', color: '#4338ca' },
            { icon: <CheckCircle size={18} />,  val: kpis.completed,  label: 'Reviews Done',      bg: '#dcfce7', color: '#15803d' },
            { icon: <Clock size={18} />,        val: kpis.notStarted, label: 'Not Started',       bg: '#fef3c7', color: '#d97706' },
            { icon: <Star size={18} />,         val: kpis.avgRating,  label: 'Avg Team Rating',   bg: '#fffbeb', color: '#d97706' },
            { icon: <Target size={18} />,       val: kpis.totalGoals, label: 'Total Goals',       bg: '#f0fdf4', color: '#15803d' },
            { icon: <Award size={18} />,        val: kpis.achieved,   label: 'Goals Achieved',    bg: '#dcfce7', color: '#065f46' },
          ].map(k => (
            <div key={k.label} className="tp-kpi">
              <div className="tp-kpi-icon" style={{ background: k.bg, color: k.color }}>{k.icon}</div>
              <div className="tp-kpi-val">{loading ? '…' : k.val}</div>
              <div className="tp-kpi-lbl">{k.label}</div>
            </div>
          ))}
        </div>

        {/* Tab bar */}
        <div className="tp-tabs">
          {[['team','Team Members'],['analytics','Dept Analytics'],['top','Top Performers']].map(([id,label]) => (
            <button key={id} className={`tp-tab${tab===id?' active':''}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        {/* ── Team Members tab ── */}
        {tab === 'team' && (
          <div className="tp-table-wrap">
            {loading ? (
              <div className="tp-loading"><div className="tp-spinner" /></div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px', color: '#9ca3af' }}>No team members found</div>
            ) : (
              <table className="tp-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th onClick={() => sort('name')} style={{ cursor: 'pointer' }}>
                      Employee <SortIcon k="name" />
                    </th>
                    <th>Department</th>
                    <th>Review Status</th>
                    <th onClick={() => sort('self_rating')} style={{ cursor: 'pointer' }}>
                      Self <SortIcon k="self_rating" />
                    </th>
                    <th onClick={() => sort('manager_rating')} style={{ cursor: 'pointer' }}>
                      Manager <SortIcon k="manager_rating" />
                    </th>
                    <th onClick={() => sort('final_rating')} style={{ cursor: 'pointer' }}>
                      Final <SortIcon k="final_rating" />
                    </th>
                    <th onClick={() => sort('avg_goal_pct')} style={{ cursor: 'pointer' }}>
                      Goals % <SortIcon k="avg_goal_pct" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m, i) => {
                    const goalPct = Math.round(Number(m.avg_goal_pct) || 0);
                    return (
                      <tr key={m.id} className="tp-row">
                        <td className="tp-rank">{i + 1}</td>
                        <td>
                          <div className="tp-emp">
                            <Avatar name={m.name} />
                            <div>
                              <div className="tp-emp-name">{m.name}</div>
                              <div className="tp-emp-role">{m.designation || '—'}</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ fontSize: 12, color: '#6b7280' }}>{m.department || '—'}</td>
                        <td><ReviewStatusPill status={m.review_status} /></td>
                        <td><Stars val={m.self_rating} /></td>
                        <td><Stars val={m.manager_rating} /></td>
                        <td>
                          <span style={{ fontSize: 14, fontWeight: 800, color: ratingColor(m.final_rating) }}>
                            {m.final_rating ? Number(m.final_rating).toFixed(1) : '—'}
                          </span>
                        </td>
                        <td>
                          <div className="tp-goals">
                            <span className="tp-goals-num">{goalPct}%</span>
                            <div className="tp-goals-track">
                              <div className="tp-goals-fill" style={{ width: `${goalPct}%`, background: goalPct >= 75 ? '#10b981' : goalPct >= 50 ? '#6366f1' : '#f59e0b' }} />
                            </div>
                            <span style={{ fontSize: 10, color: '#9ca3af' }}>({m.achieved_goals}/{m.total_goals})</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Dept Analytics tab ── */}
        {tab === 'analytics' && (
          <div className="tp-analytics-grid">
            <div className="tp-chart-card">
              <h3 className="tp-card-title">Average Rating by Department</h3>
              {deptStats.length === 0 ? (
                <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>No data</div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={deptStats} barSize={40}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                    <XAxis dataKey="dept" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 5]} tick={{ fontSize: 11 }} tickCount={6} />
                    <Tooltip formatter={v => [`${v} / 5`, 'Avg Rating']} />
                    <Bar dataKey="avg" radius={[5, 5, 0, 0]}>
                      {deptStats.map((d, i) => (
                        <Cell key={i} fill={ratingColor(d.avg)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="tp-dept-table-card">
              <h3 className="tp-card-title">Department Breakdown</h3>
              <table className="tp-dept-table">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th>Headcount</th>
                    <th>Avg Rating</th>
                    <th>Promotions</th>
                    <th>Review %</th>
                  </tr>
                </thead>
                <tbody>
                  {deptStats.map(d => {
                    const deptMembers = members.filter(m => m.department === d.dept);
                    const done = deptMembers.filter(m => m.review_status === 'completed').length;
                    const pct = deptMembers.length ? Math.round((done / deptMembers.length) * 100) : 0;
                    return (
                      <tr key={d.dept}>
                        <td style={{ fontWeight: 700 }}>{d.dept}</td>
                        <td>{d.count}</td>
                        <td>
                          <span style={{ fontWeight: 800, color: ratingColor(d.avg) }}>
                            {d.avg ? d.avg.toFixed(1) : '—'}
                          </span>
                        </td>
                        <td>{d.promos || 0}</td>
                        <td>
                          <div className="tp-goals">
                            <span className="tp-goals-num">{pct}%</span>
                            <div className="tp-goals-track" style={{ minWidth: 50 }}>
                              <div className="tp-goals-fill" style={{ width: `${pct}%`, background: '#6366f1' }} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Top Performers tab ── */}
        {tab === 'top' && (
          <div className="tp-top-grid">
            {loading ? (
              <div className="tp-loading"><div className="tp-spinner" /></div>
            ) : topPerfs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px', color: '#9ca3af', gridColumn: '1/-1' }}>
                No high-performers data yet (requires completed reviews with rating ≥ 4.0)
              </div>
            ) : topPerfs.map((p, i) => (
              <div key={p.id} className="tp-top-card">
                <div className="tp-top-rank">
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}
                </div>
                <Avatar name={p.name} size={48} />
                <div className="tp-top-name">{p.name}</div>
                <div className="tp-top-dept">{p.department}</div>
                <div className="tp-top-rating" style={{ color: ratingColor(p.avg_rating) }}>
                  {Number(p.avg_rating).toFixed(2)}
                  <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 500 }}> / 5</span>
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{p.review_count} review{p.review_count !== 1 ? 's' : ''}</div>
                <Stars val={p.avg_rating} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}