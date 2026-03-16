import { useState, useEffect, useCallback } from 'react';
import { Star, TrendingUp, Award } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import api from '@/services/api/client';
import './TeamPerformance.css';

const SAMPLE = [
  { id: 1, employee: 'Vikram Singh',  role: 'Sr. Sales Manager', rating: 4.8, goalsTotal: 5, goalsCompleted: 5, attendance: 97, score: 94, trend: 'up' },
  { id: 2, employee: 'Arjun Mehta',   role: 'Sales Manager',     rating: 4.5, goalsTotal: 4, goalsCompleted: 4, attendance: 95, score: 88, trend: 'up' },
  { id: 3, employee: 'Priya Sharma',  role: 'Sales Executive',   rating: 4.2, goalsTotal: 4, goalsCompleted: 3, attendance: 93, score: 80, trend: 'stable' },
  { id: 4, employee: 'Sneha Iyer',    role: 'Sales Executive',   rating: 4.6, goalsTotal: 3, goalsCompleted: 3, attendance: 98, score: 91, trend: 'up' },
  { id: 5, employee: 'Kiran Das',     role: 'BD Manager',        rating: 3.8, goalsTotal: 5, goalsCompleted: 2, attendance: 88, score: 65, trend: 'down' },
  { id: 6, employee: 'Rohit Gupta',   role: 'Sales Manager',     rating: 4.1, goalsTotal: 4, goalsCompleted: 3, attendance: 91, score: 78, trend: 'stable' },
  { id: 7, employee: 'Meera Joshi',   role: 'Engineer',          rating: 4.7, goalsTotal: 6, goalsCompleted: 6, attendance: 96, score: 92, trend: 'up' },
  { id: 8, employee: 'Suresh Nair',   role: 'Finance Lead',      rating: 4.3, goalsTotal: 4, goalsCompleted: 3, attendance: 94, score: 83, trend: 'stable' },
];

const PERIODS = ['Q1 FY2026','Q2 FY2026','Q3 FY2026','Q4 FY2026'];

function ratingColor(r) { return r >= 4.5 ? '#15803d' : r >= 3.5 ? '#1d4ed8' : '#dc2626'; }
function scoreColor(s)  { return s >= 85 ? '#15803d' : s >= 65 ? '#1d4ed8' : '#dc2626'; }

function Stars({ rating }) {
  const full = Math.floor(rating);
  return (
    <div className="tp-stars">
      {[1,2,3,4,5].map(i => (
        <Star key={i} size={11} fill={i <= full ? '#f59e0b' : 'none'} color="#f59e0b" />
      ))}
      <span className="tp-rating-num">{rating.toFixed(1)}</span>
    </div>
  );
}

export default function TeamPerformance() {
  const [team, setTeam]       = useState(SAMPLE);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod]   = useState(PERIODS[0]);
  const [sortBy, setSortBy]   = useState('score');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/performance/team', { params: { period } });
      const raw = res.data?.data ?? res.data;
      setTeam(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } catch { setTeam(SAMPLE); }
    finally { setLoading(false); }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const sorted = [...team].sort((a, b) => {
    if (sortBy === 'score')    return b.score - a.score;
    if (sortBy === 'rating')   return b.rating - a.rating;
    if (sortBy === 'goals')    return (b.goalsCompleted / (b.goalsTotal||1)) - (a.goalsCompleted / (a.goalsTotal||1));
    if (sortBy === 'attendance') return b.attendance - a.attendance;
    return 0;
  });

  const avgScore      = Math.round(team.reduce((s, m) => s + m.score, 0) / (team.length||1));
  const avgRating     = (team.reduce((s, m) => s + m.rating, 0) / (team.length||1)).toFixed(1);
  const topPerformer  = [...team].sort((a,b) => b.score - a.score)[0];
  const chartData     = sorted.map(m => ({ name: m.employee.split(' ')[0], score: m.score }));

  return (
    <div className="tp-root">
      <div className="tp-header">
        <div>
          <h1 className="tp-title">Team Performance</h1>
          <p className="tp-sub">Performance metrics across your team</p>
        </div>
        <div className="tp-header-r">
          <select className="tp-period-sel" value={period} onChange={e => setPeriod(e.target.value)}>
            {PERIODS.map(p => <option key={p}>{p}</option>)}
          </select>
        </div>
      </div>

      {/* Summary */}
      <div className="tp-summary">
        <div className="tp-sum-card">
          <div className="tp-sum-icon" style={{ background: '#eef2ff', color: '#4338ca' }}><TrendingUp size={18} /></div>
          <div><div className="tp-sum-num">{avgScore}%</div><div className="tp-sum-lbl">Avg Performance</div></div>
        </div>
        <div className="tp-sum-card">
          <div className="tp-sum-icon" style={{ background: '#fef3c7', color: '#92400e' }}><Star size={18} /></div>
          <div><div className="tp-sum-num">{avgRating}</div><div className="tp-sum-lbl">Avg Rating</div></div>
        </div>
        <div className="tp-sum-card">
          <div className="tp-sum-icon" style={{ background: '#dcfce7', color: '#15803d' }}><Award size={18} /></div>
          <div>
            <div className="tp-sum-num">{topPerformer?.employee.split(' ')[0]}</div>
            <div className="tp-sum-lbl">Top Performer</div>
          </div>
        </div>
        <div className="tp-sum-card">
          <div className="tp-sum-icon" style={{ background: '#ede9fe', color: '#7c3aed' }}><TrendingUp size={18} /></div>
          <div>
            <div className="tp-sum-num">{team.filter(m => m.trend === 'up').length}</div>
            <div className="tp-sum-lbl">Improving</div>
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="tp-chart-card">
        <div className="tp-card-title">Performance Score by Team Member</div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis domain={[0,100]} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
            <Tooltip formatter={v => [`${v}%`, 'Score']} />
            <Bar dataKey="score" radius={[4,4,0,0]}>
              {chartData.map((d, i) => <Cell key={i} fill={scoreColor(d.score)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="tp-table-hd">
        <span className="tp-table-title">Team Members</span>
        <div className="tp-sort">
          <span className="tp-sort-lbl">Sort by:</span>
          {[['score','Score'],['rating','Rating'],['goals','Goals'],['attendance','Attendance']].map(([k,lbl]) => (
            <button key={k} className={`tp-sort-btn ${sortBy===k?'tp-sort-active':''}`} onClick={() => setSortBy(k)}>{lbl}</button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="tp-loading"><div className="tp-spinner" /></div>
      ) : (
        <div className="tp-table-wrap">
          <table className="tp-table">
            <thead>
              <tr><th>Employee</th><th>Rating</th><th>Goals</th><th>Attendance</th><th>Score</th><th>Trend</th></tr>
            </thead>
            <tbody>
              {sorted.map((m, rank) => (
                <tr key={m.id} className="tp-row">
                  <td>
                    <div className="tp-emp">
                      <div className="tp-rank">{rank+1}</div>
                      <div className="tp-avatar">{m.employee.split(' ').map(w=>w[0]).join('').slice(0,2)}</div>
                      <div>
                        <div className="tp-emp-name">{m.employee}</div>
                        <div className="tp-emp-role">{m.role}</div>
                      </div>
                    </div>
                  </td>
                  <td><Stars rating={m.rating} /></td>
                  <td>
                    <div className="tp-goals">
                      <span className="tp-goals-num">{m.goalsCompleted}/{m.goalsTotal}</span>
                      <div className="tp-goals-track">
                        <div className="tp-goals-fill" style={{ width: `${(m.goalsCompleted/m.goalsTotal)*100}%` }} />
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="tp-att">
                      <span className="tp-att-num" style={{ color: m.attendance >= 95 ? '#15803d' : m.attendance >= 85 ? '#92400e' : '#dc2626' }}>{m.attendance}%</span>
                    </div>
                  </td>
                  <td>
                    <div className="tp-score-cell">
                      <span className="tp-score-num" style={{ color: scoreColor(m.score) }}>{m.score}%</span>
                      <div className="tp-score-track">
                        <div className="tp-score-fill" style={{ width: `${m.score}%`, background: scoreColor(m.score) }} />
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`tp-trend tp-trend-${m.trend}`}>
                      {m.trend === 'up' ? '▲' : m.trend === 'down' ? '▼' : '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
