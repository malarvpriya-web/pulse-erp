// PATH: frontend/src/features/employees/pages/EmployeesDashboard.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Users, UserCheck, UserPlus, Clock, TrendingUp, UserX, RefreshCw, AlertCircle,
} from 'lucide-react';
import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  AreaChart, Area,
} from 'recharts';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

const P      = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const PIE_COLORS    = ['#6B3FDB', '#a78bfa', '#c4b5fd', '#ddd6fe', '#ede9fe'];
const GENDER_COLORS = { Male: '#6B3FDB', Female: '#ec4899', Other: '#10b981', 'Not specified': '#d1d5db' };

// ─── Fiscal year helpers ──────────────────────────────────────────────────────

function getFYOptions() {
  const now      = new Date();
  const year     = now.getFullYear();
  const mon      = now.getMonth();
  const curFYEnd = mon >= 3 ? year + 1 : year;
  return Array.from({ length: 5 }, (_, i) => {
    const fyEnd   = curFYEnd - i;
    const fyStart = fyEnd - 1;
    return {
      label    : `FY${String(fyEnd).slice(-2)}`,
      start    : `${fyStart}-04-01`,
      end      : `${fyEnd}-03-31`,
      key      : `FY${fyEnd}`,
      isCurrent: i === 0,
    };
  });
}

const FY_OPTIONS = getFYOptions();

// ─── Reusable primitives ──────────────────────────────────────────────────────

function KPI({ icon: Icon, label, value, sub, color = P, loading, index = 0 }) {
  return (
    <div className="kpi-card dk-anim" style={{
      background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 11,
      padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 11, '--dk-i': index,
    }}>
      <div style={{
        width: 38, height: 38, borderRadius: 10, background: LIGHT,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Icon size={18} color={color} />
      </div>
      <div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 1 }}>{label}</div>
        {loading
          ? <div style={{ height: 24, width: 60, background: '#f3f4f6', borderRadius: 4 }} />
          : <div style={{ fontSize: 20, fontWeight: 700, color: '#111827' }}>{value}</div>
        }
        {sub && !loading && <div style={{ fontSize: 11, color: '#6b7280' }}>{sub}</div>}
      </div>
    </div>
  );
}

function Card({ title, children, span = 1, action, index = 0 }) {
  return (
    <div className="dk-anim" style={{
      background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 11,
      padding: '13px 14px', gridColumn: `span ${span}`, '--dk-i': index,
    }}>
      {title && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{title}</div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function EmptyChart({ height = 200 }) {
  return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d1d5db', fontSize: 12 }}>
      No data available
    </div>
  );
}

const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      {label && <div style={{ fontWeight: 600, marginBottom: 4, color: '#374151' }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || P }}>{p.name}: <b>{p.value}</b></div>
      ))}
    </div>
  );
};

function Avatar({ name }) {
  const initials = (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div style={{
      width: 34, height: 34, borderRadius: 8, background: LIGHT, color: P,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, fontWeight: 700, flexShrink: 0,
    }}>
      {initials}
    </div>
  );
}

function EmployeeRow({ emp, sub }) {
  const name = [emp.first_name, emp.last_name].filter(Boolean).join(' ') || emp.name || '—';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid #f3f4f6` }}>
      <Avatar name={name} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
        <div style={{ fontSize: 11, color: '#9ca3af' }}>{emp.designation || emp.department || '—'} {sub ? `· ${sub}` : ''}</div>
      </div>
      {emp.department && (
        <span style={{ fontSize: 10, background: LIGHT, color: P, padding: '2px 8px', borderRadius: 20, whiteSpace: 'nowrap' }}>
          {emp.department}
        </span>
      )}
    </div>
  );
}

function SkeletonRows({ n = 4 }) {
  return Array.from({ length: n }).map((_, i) => (
    <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
      <div style={{ width: 34, height: 34, borderRadius: 8, background: '#f3f4f6' }} />
      <div style={{ flex: 1 }}>
        <div style={{ height: 12, width: '60%', background: '#f3f4f6', borderRadius: 4, marginBottom: 6 }} />
        <div style={{ height: 10, width: '40%', background: '#f3f4f6', borderRadius: 4 }} />
      </div>
    </div>
  ));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getThisMonthHires(newHiresMonthly = []) {
  if (!newHiresMonthly.length) return 0;
  const now   = new Date();
  const label = now.toLocaleString('en-US', { month: 'short' }) + ' ' + String(now.getFullYear()).slice(-2);
  const found = newHiresMonthly.find(r => r.month === label);
  return found?.hires ?? newHiresMonthly[newHiresMonthly.length - 1]?.hires ?? 0;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function EmployeesDashboard({ setPage }) {
  const [analytics,     setAnalytics]     = useState(null);
  const [probationList, setProbationList] = useState([]);
  const [recentHires,   setRecentHires]   = useState([]);
  const [birthdays,     setBirthdays]     = useState([]);
  const [anniversaries, setAnniversaries] = useState([]);
  const [confirmations, setConfirmations] = useState([]);
  const [expiringDocs,  setExpiringDocs]  = useState([]);
  const [upcomingExits, setUpcomingExits] = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [listLoading,   setListLoading]   = useState(true);
  const [error,         setError]         = useState(null);
  const [lastRefresh,   setLastRefresh]   = useState(null);
  const [activeFY,      setActiveFY]      = useState(FY_OPTIONS[0].key);

  const abortRef = useRef(null);

  const load = useCallback(async (fyKey) => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;

    setLoading(true);
    setListLoading(true);
    setError(null);

    // Wave 1 — analytics KPIs + charts (FY-scoped)
    try {
      const fy     = FY_OPTIONS.find(f => f.key === fyKey) || FY_OPTIONS[0];
      const params = new URLSearchParams({ fy_start: fy.start, fy_end: fy.end });
      const res    = await api.get(`/employees/analytics?${params}`);
      if (signal.aborted) return;
      setAnalytics(res.data || null);
    } catch (err) {
      if (!signal.aborted) setError(err.message || 'Failed to load analytics');
    } finally {
      if (!signal.aborted) setLoading(false);
    }

    if (signal.aborted) return;

    // Wave 2 — live employee lists + HR widgets (always current)
    const [probRes, allRes, bdRes, annRes, confRes, expRes, exitRes] = await Promise.allSettled([
      api.get('/employees', { params: { status: 'probation' } }),
      api.get('/employees'),
      api.get('/hr-widgets/upcoming-birthdays?days=30'),
      api.get('/hr-widgets/upcoming-anniversaries?days=30'),
      api.get('/hr-widgets/pending-confirmations?days=14'),
      api.get('/hr-widgets/expiring-documents?days=30'),
      api.get('/hr-widgets/upcoming-exits?days=30'),
    ]);

    if (signal.aborted) return;

    if (probRes.status === 'fulfilled') {
      const raw = probRes.value.data;
      setProbationList(Array.isArray(raw) ? raw.slice(0, 5) : []);
    }

    if (allRes.status === 'fulfilled') {
      const raw = allRes.value.data;
      if (Array.isArray(raw)) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const recent = raw
          .filter(e => e.joining_date && new Date(e.joining_date) >= cutoff)
          .sort((a, b) => new Date(b.joining_date) - new Date(a.joining_date))
          .slice(0, 5);
        setRecentHires(recent);
      }
    }

    if (bdRes.status   === 'fulfilled') setBirthdays(bdRes.value.data   || []);
    if (annRes.status  === 'fulfilled') setAnniversaries(annRes.value.data || []);
    if (confRes.status === 'fulfilled') setConfirmations(confRes.value.data || []);
    if (expRes.status  === 'fulfilled') setExpiringDocs(expRes.value.data  || []);
    if (exitRes.status === 'fulfilled') setUpcomingExits(exitRes.value.data || []);

    if (!signal.aborted) {
      setListLoading(false);
      setLastRefresh(new Date());
    }
  }, []);

  useEffect(() => {
    load(activeFY);
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [activeFY, load]);

  const s            = analytics?.summary        || {};
  const deptData     = analytics?.deptBreakdown  || [];
  const genderData   = analytics?.genderBreakdown || [];
  const skillData    = analytics?.skillBreakdown  || [];
  const tenureData   = analytics?.tenureGroups    || [];
  const statusData   = analytics?.statusBreakdown || [];
  const hiresMonthly = analytics?.newHiresMonthly || [];
  const exitsMonthly = analytics?.attritionMonthly || [];

  const totalHeadcount = (s.total || 0) + (s.left || 0);
  const attritionRate  = totalHeadcount > 0 ? ((s.left / totalHeadcount) * 100).toFixed(1) : '0.0';
  const isCurrentFY    = activeFY === FY_OPTIONS[0].key;
  const newHiresValue  = isCurrentFY
    ? getThisMonthHires(hiresMonthly)
    : hiresMonthly.reduce((acc, r) => acc + (r.hires || 0), 0);

  const hasHires     = hiresMonthly.length > 0;
  const hasAttrition = exitsMonthly.length > 0;

  const trendData = hasHires
    ? hiresMonthly.map(h => {
        const ex = exitsMonthly.find(a => a.month === h.month);
        return { month: h.month, Hires: h.hires, ...(hasAttrition ? { Exits: ex?.exits || 0 } : {}) };
      })
    : [];

  const genderChart = (h, r) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie data={genderData} dataKey="count" nameKey="gender"
          cx="50%" cy="50%" outerRadius={r}
          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
          labelLine={false} fontSize={11}
        >
          {genderData.map((entry, i) => (
            <Cell key={i} fill={GENDER_COLORS[entry.gender] || PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v) => [v, 'Count']} />
      </PieChart>
    </ResponsiveContainer>
  );

  const skillChart = (h, r) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie data={skillData} dataKey="count" nameKey="skill"
          cx="50%" cy="50%" outerRadius={r}
          label={({ percent }) => `${(percent * 100).toFixed(0)}%`}
          labelLine={false} fontSize={11}
        >
          {skillData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
        </Pie>
        <Tooltip formatter={(v, n) => [v, n]} />
        <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );

  const tenureChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={tenureData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0eeff" />
        <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip content={<ChartTip />} />
        <Bar dataKey="count" name="Employees" fill={P} radius={[4, 4, 0, 0]}>
          {tenureData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  const deptChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={deptData} layout="vertical" margin={{ top: 4, right: 24, left: 80, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0eeff" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="department" tick={{ fontSize: 11 }} width={78} />
        <Tooltip content={<ChartTip />} />
        <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="active" name="Active" fill="#16a34a" radius={[0, 4, 4, 0]} stackId="a" />
        <Bar dataKey="count"  name="Total"  fill={LIGHT}   radius={[0, 4, 4, 0]} stackId="b" />
      </BarChart>
    </ResponsiveContainer>
  );

  const statusChart = (h, inner, outer) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie
          data={statusData} dataKey="count" nameKey="status"
          cx="50%" cy="46%" innerRadius={inner} outerRadius={outer} paddingAngle={3}
          label={({ name, value }) => `${name}: ${value}`} labelLine={false} fontSize={11}
        >
          {statusData.map((entry) => {
            const colors = { Active: '#16a34a', Left: '#dc2626', Probation: '#d97706' };
            return <Cell key={entry.status} fill={colors[entry.status] || P} />;
          })}
        </Pie>
        <Tooltip formatter={(v) => [v, 'Count']} />
        <text x="50%" y="44%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 20, fontWeight: 700, fill: '#111827' }}>
          {s.total}
        </text>
        <text x="50%" y="55%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 10, fill: '#9ca3af' }}>
          Current
        </text>
      </PieChart>
    </ResponsiveContainer>
  );

  const trendChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <AreaChart data={trendData} margin={{ top: 4, right: 24, left: -10, bottom: 0 }}>
        <defs>
          <linearGradient id="hiresGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={P}         stopOpacity={0.18} />
            <stop offset="95%" stopColor={P}         stopOpacity={0} />
          </linearGradient>
          <linearGradient id="exitsGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#dc2626"   stopOpacity={0.15} />
            <stop offset="95%" stopColor="#dc2626"   stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0eeff" />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip content={<ChartTip />} />
        <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
        <Area type="monotone" dataKey="Hires" name="New Hires" stroke={P}       strokeWidth={2} fill="url(#hiresGrad)" dot={{ r: 3 }} />
        {hasAttrition && (
          <Area type="monotone" dataKey="Exits" name="Exits"  stroke="#dc2626" strokeWidth={2} fill="url(#exitsGrad)" dot={{ r: 3 }} />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );

  return (
    <div style={{ padding: '16px 18px 20px', background: '#f4f5f9', minHeight: 'calc(100vh - 64px)' }}>

      {/* ── Page header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111827' }}>Employee Overview</h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#9ca3af' }}>
            Workforce headcount, analytics and trends
            {lastRefresh && ` · Updated ${lastRefresh.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select
            value={activeFY}
            onChange={e => setActiveFY(e.target.value)}
            style={{
              padding: '7px 12px', border: `1.5px solid ${BORDER}`, borderRadius: 9,
              fontSize: 13, fontWeight: 600, color: '#374151', background: '#fff',
              cursor: 'pointer', outline: 'none',
            }}
          >
            {FY_OPTIONS.map(fy => (
              <option key={fy.key} value={fy.key}>
                {fy.label}{fy.isCurrent ? ' (Current)' : ''}
              </option>
            ))}
          </select>
          <button
            onClick={() => load(activeFY)}
            disabled={loading}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8, border: `1px solid ${BORDER}`,
              background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer',
            }}
          >
            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', marginBottom: 20, display: 'flex', gap: 10, alignItems: 'center', color: '#dc2626', fontSize: 13 }}>
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      {/* ── KPI Row (6 cards) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 12 }}>
        <KPI index={0} icon={Users}     label="Total Employees"                                 value={s.total     ?? '—'} sub="Active + Probation"                                                                loading={loading} />
        <KPI index={1} icon={UserCheck} label="Active"                                          value={s.active    ?? '—'} sub={s.total > 0 ? `${((s.active / s.total) * 100).toFixed(0)}% of workforce` : 'Confirmed'} loading={loading} color="#16a34a" />
        <KPI index={2} icon={Clock}     label="On Probation"                                    value={s.probation ?? '—'} sub="Pending confirmation"                                                             loading={loading} color="#d97706" />
        <KPI index={3} icon={UserPlus}  label={isCurrentFY ? 'New Hires (Month)' : 'New Hires (FY)'} value={newHiresValue}  sub={isCurrentFY ? 'Joined this month' : `In ${activeFY}`}                          loading={loading} color="#3b82f6" />
        <KPI index={4} icon={UserX}     label="Attrition Rate"                                  value={`${attritionRate}%`} sub={`${s.left ?? 0} exits`}                                                         loading={loading} color="#dc2626" />
        <KPI index={5} icon={TrendingUp} label="Avg. Tenure"                                   value={s.avgTenure ? `${s.avgTenure} yrs` : '—'} sub="Active employees"                                          loading={loading} color={P} />
      </div>

      {/* ── HR Alerts Row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 12 }}>
        {[
          {
            icon: '🎂', label: 'Birthdays', color: '#ec4899', bg: '#fdf2f8',
            items: birthdays, dateKey: 'date_of_birth', badge: 'BD',
          },
          {
            icon: '🎉', label: 'Anniversaries', color: '#6B3FDB', bg: LIGHT,
            items: anniversaries, dateKey: 'joining_date', badge: 'ANN',
          },
          {
            icon: '⏳', label: 'Confirmations Due', color: '#d97706', bg: '#fffbeb',
            items: confirmations, dateKey: 'probation_end_date', badge: 'PROB',
          },
          {
            icon: '📄', label: 'Expiring Docs', color: '#dc2626', bg: '#fef2f2',
            items: expiringDocs, dateKey: 'expiry_date', badge: 'EXP',
          },
          {
            icon: '🚪', label: 'Upcoming Exits', color: '#6b7280', bg: '#f9fafb',
            items: upcomingExits, dateKey: 'last_working_date', badge: 'EXIT',
          },
        ].map(({ icon, label, color, bg, items, dateKey, badge }) => (
          <div key={label} className="dk-anim" style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 11, padding: '11px 13px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{icon} {label}</div>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: bg, color }}>{items.length}</span>
            </div>
            {listLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[0,1].map(i => <div key={i} style={{ height: 10, background: '#f3f4f6', borderRadius: 4 }} />)}
              </div>
            ) : items.length === 0 ? (
              <div style={{ fontSize: 12, color: '#d1d5db' }}>None in next 30 days</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {items.slice(0, 4).map((emp, i) => {
                  const name = [emp.first_name, emp.last_name].filter(Boolean).join(' ') || emp.name || '—';
                  const date = emp[dateKey] ? new Date(emp[dateKey]).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 6, background: bg, color, flexShrink: 0 }}>{date}</span>
                      <span style={{ fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    </div>
                  );
                })}
                {items.length > 4 && <div style={{ fontSize: 11, color: '#9ca3af' }}>+{items.length - 4} more</div>}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Charts Row 1: Gender | Skill | Tenure ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 12, marginBottom: 12 }}>

        <Card index={11} title="Gender Distribution" span={4}
          action={!loading && genderData.length > 0 && (
            <ChartExpandButton title="Gender Distribution">{genderChart(430, 150)}</ChartExpandButton>
          )}>
          {loading ? (
            <div style={{ height: 180, background: '#f9fafb', borderRadius: 8 }} />
          ) : genderData.length === 0 ? (
            <EmptyChart height={180} />
          ) : genderChart(180, 66)}
        </Card>

        <Card index={12} title="Skill Type Distribution" span={4}
          action={!loading && skillData.length > 0 && (
            <ChartExpandButton title="Skill Type Distribution">{skillChart(430, 150)}</ChartExpandButton>
          )}>
          {loading ? (
            <div style={{ height: 180, background: '#f9fafb', borderRadius: 8 }} />
          ) : skillData.length === 0 ? (
            <EmptyChart height={180} />
          ) : skillChart(180, 66)}
        </Card>

        <Card index={13} title="Tenure Distribution (Active)" span={4}
          action={!loading && !tenureData.every(g => g.count === 0) && (
            <ChartExpandButton title="Tenure Distribution (Active)">{tenureChart(430)}</ChartExpandButton>
          )}>
          {loading ? (
            <div style={{ height: 180, background: '#f9fafb', borderRadius: 8 }} />
          ) : tenureData.every(g => g.count === 0) ? (
            <EmptyChart height={180} />
          ) : tenureChart(180)}
        </Card>

      </div>

      {/* ── Charts Row 2: Dept Headcount | Employment Status ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 12, marginBottom: 12 }}>

        <Card index={14} title="Department Headcount" span={7}
          action={!loading && deptData.length > 0 && (
            <ChartExpandButton title="Department Headcount">{deptChart(430)}</ChartExpandButton>
          )}>
          {loading ? (
            <div style={{ height: 215, background: '#f9fafb', borderRadius: 8 }} />
          ) : deptData.length === 0 ? (
            <EmptyChart height={215} />
          ) : (
            <>
              {deptChart(215)}
              <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                {[{ color: '#16a34a', label: 'Active' }, { color: P, label: 'Total headcount' }].map(l => (
                  <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6b7280' }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: l.color, display: 'inline-block' }} />
                    {l.label}
                  </span>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card index={15} title="Employment Status" span={5}
          action={!loading && statusData.length > 0 && (
            <ChartExpandButton title="Employment Status">{statusChart(430, 105, 165)}</ChartExpandButton>
          )}>
          {loading ? (
            <div style={{ height: 215, background: '#f9fafb', borderRadius: 8 }} />
          ) : statusData.length === 0 ? (
            <EmptyChart height={215} />
          ) : statusChart(215, 50, 80)}
        </Card>

      </div>

      {/* ── Hiring vs Attrition Trend ── */}
      <div style={{ marginBottom: 12 }}>
        <Card index={16} title={`Hiring vs Attrition — ${activeFY}`}
          action={!loading && hasHires && (
            <ChartExpandButton title={`Hiring vs Attrition — ${activeFY}`}>{trendChart(430)}</ChartExpandButton>
          )}>
          {loading ? (
            <div style={{ height: 195, background: '#f9fafb', borderRadius: 8 }} />
          ) : !hasHires ? (
            <EmptyChart height={195} />
          ) : (
            <>
              {trendChart(195)}
              {!hasAttrition && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#9ca3af' }}>
                  Attrition trend unavailable — exit date tracking not yet enabled
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      {/* ── Lists Row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

        <Card
          index={17}
          title="Recent New Hires"
          action={
            <button onClick={() => setPage?.('EmployeesData')}
              style={{ fontSize: 12, color: P, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              View all →
            </button>
          }
        >
          {listLoading ? (
            <SkeletonRows n={4} />
          ) : recentHires.length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: '#d1d5db', fontSize: 13 }}>
              No new hires in the last 30 days
            </div>
          ) : (
            recentHires.map((emp, i) => (
              <EmployeeRow key={emp.id || i} emp={emp} sub={`Joined ${formatDate(emp.joining_date)}`} />
            ))
          )}
        </Card>

        <Card
          index={18}
          title="On Probation"
          action={
            <button onClick={() => setPage?.('EmployeesData')}
              style={{ fontSize: 12, color: P, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              View all →
            </button>
          }
        >
          {listLoading ? (
            <SkeletonRows n={4} />
          ) : probationList.length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: '#d1d5db', fontSize: 13 }}>
              No employees currently on probation
            </div>
          ) : (
            probationList.map((emp, i) => (
              <EmployeeRow
                key={emp.id || i}
                emp={emp}
                sub={emp.joining_date ? `Joined ${formatDate(emp.joining_date)}` : undefined}
              />
            ))
          )}
        </Card>

      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
