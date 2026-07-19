// PATH: frontend/src/pages/HRDashboard.jsx
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  Users, UserCheck, UserX, Clock, RefreshCw, ChevronRight,
  Plus, Bell, CheckCircle, Calendar, Briefcase,
  TrendingDown, Zap, ArrowUpRight, Filter, BarChart2, Inbox,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie, AreaChart, Area,
} from 'recharts';
import api from '@/services/api/client';
import {
  getHeadcount, getAttrition, getOfferAcceptance, getAbsenteeism,
  getAttritionTrend, getHiringTrend, getGenderDist, getDeptWorkforce,
  getProductivity, getTopPerformers, getHRInsights,
  getHeadcountTrend, getSalaryBands, getTimeToHire,
  getSatisfaction, getOnboarding, getComplianceAlerts,
} from '@/features/hr-analytics/services/hrAnalyticsApi';
import { generateInsights } from '@/features/analytics/services/insightsEngine';
import HeadcountCard           from '@/features/hr-analytics/components/HeadcountCard';
import AttritionRateCard       from '@/features/hr-analytics/components/AttritionRateCard';
import OfferAcceptanceCard     from '@/features/hr-analytics/components/OfferAcceptanceCard';
import AbsenteeismCard         from '@/features/hr-analytics/components/AbsenteeismCard';
import AttritionTrendChart     from '@/features/hr-analytics/components/AttritionTrendChart';
import HiringTrendChart        from '@/features/hr-analytics/components/HiringTrendChart';
import GenderDistributionChart from '@/features/hr-analytics/components/GenderDistributionChart';
import DepartmentStrengthChart from '@/features/hr-analytics/components/DepartmentStrengthChart';
import ProductivityTrendChart  from '@/features/hr-analytics/components/ProductivityTrendChart';
import TopPerformersTable      from '@/features/hr-analytics/components/TopPerformersTable';
import InsightsPanel           from '@/features/hr-analytics/components/InsightsPanel';
import HeadcountTrendChart     from '@/features/hr-analytics/components/HeadcountTrendChart';
import SalaryBandChart         from '@/features/hr-analytics/components/SalaryBandChart';
import TimeToHireCard          from '@/features/hr-analytics/components/TimeToHireCard';
import SatisfactionCard        from '@/features/hr-analytics/components/SatisfactionCard';
import OnboardingWidget        from '@/features/hr-analytics/components/OnboardingWidget';
import ComplianceWidget        from '@/features/hr-analytics/components/ComplianceWidget';
import OrgSummaryWidget        from '@/features/hr-analytics/components/OrgSummaryWidget';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

const P      = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const DEPTS = ['All','Engineering','Sales','HR','Finance','Operations','Marketing','Support'];

function generateHRInsights({ total: _total, attritionRate, newHires, pendingLeaves, probationEnding }) {
  const out = [];
  if (attritionRate > 15)
    out.push({ type:'danger',  emoji:'⚠️',  text:`Attrition at ${attritionRate}% is critical. Immediate retention interventions recommended.` });
  else if (attritionRate > 10)
    out.push({ type:'warning', emoji:'📊', text:`Attrition at ${attritionRate}% is above ideal 8%. Run exit interview analysis to identify patterns.` });
  else
    out.push({ type:'success', emoji:'🌱', text:`Attrition at ${attritionRate}% is within healthy range. Retention programs are effective.` });

  if (newHires > 0)
    out.push({ type:'info',    emoji:'🎉', text:`${newHires} new hire${newHires>1?'s':''} this month. Ensure onboarding is smooth — first 90 days are critical.` });

  if (pendingLeaves > 5)
    out.push({ type:'warning', emoji:'📋', text:`${pendingLeaves} leave requests pending approval. Delays may affect employee satisfaction.` });

  if (probationEnding > 0)
    out.push({ type:'info',    emoji:'🏆', text:`${probationEnding} employee${probationEnding>1?'s':''} completing probation this week. Schedule performance review meetings.` });

  return out.slice(0, 3);
}

function computeHRAlerts(employees) {
  const alerts = [];
  const today = new Date();
  const in7   = new Date(today.getTime() + 7 * 86400000);

  employees.forEach(e => {
    if (e.status === 'Probation' && e.probation_end_date) {
      const end = new Date(e.probation_end_date);
      if (end >= today && end <= in7)
        alerts.push({ priority:'medium', message:`${e.first_name} ${e.last_name}'s probation ends ${end.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}`, type:'probation' });
    }
    if (e.joining_date) {
      const j = new Date(e.joining_date);
      const thisYear = new Date(today.getFullYear(), j.getMonth(), j.getDate());
      const diff = Math.abs(thisYear - today);
      if (diff <= 7 * 86400000 && j.getFullYear() < today.getFullYear())
        alerts.push({ priority:'low', message:`${e.first_name}'s ${today.getFullYear() - j.getFullYear()}yr work anniversary this week!`, type:'anniversary' });
    }
  });

  const probationCount = employees.filter(e => e.status === 'Probation').length;
  if (probationCount > 5)
    alerts.unshift({ priority:'medium', message:`${probationCount} employees on probation — review pending confirmation letters`, type:'probation' });

  return alerts.slice(0, 6);
}

const EMPTY_ANALYTICS = {
  summary: { total: 0, active: 0, probation: 0, left: 0, avgTenure: 0 },
  genderBreakdown: [],
  deptBreakdown: [],
  newHiresMonthly: [],
  attritionMonthly: [],
};

const GENDER_COLORS = [P, '#a78bfa', '#ddd6fe'];
const ALERT_STYLE   = {
  high:   { bg:'#fef2f2', border:'#fecaca', dot:'#dc2626' },
  medium: { bg:'#fffbeb', border:'#fde68a', dot:'#d97706' },
  low:    { bg:'#eff6ff', border:'#bfdbfe', dot:'#2563eb' },
};

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 12px', fontSize:12 }}>
      <div style={{ fontWeight:600, color:'#374151', marginBottom:3 }}>{label}</div>
      {payload.map((p, i) => <div key={i} style={{ color:p.color||P }}>{p.name}: <b>{p.value}</b></div>)}
    </div>
  );
};

const EmptyState = ({ Icon: IconComponent = Inbox, message }) => (
  <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'32px 16px', color:'#9ca3af', gap:8 }}>
    <IconComponent size={28} color="#d1d5db" strokeWidth={1.5} />
    <p style={{ margin:0, fontSize:13 }}>{message}</p>
  </div>
);

const TABS = [
  { key: 'overview',   label: 'Overview',  icon: Users },
  { key: 'analytics',  label: 'Analytics', icon: BarChart2 },
];

const HR_ROLES = new Set(['hr', 'hr_manager', 'hr_admin', 'admin', 'super_admin']);

export default function HRDashboard({ setPage }) {
  const { role } = useAuth();
  const canManage = HR_ROLES.has(String(role || '').toLowerCase());

  const [activeTab,   setActiveTab]   = useState('overview');

  // ── Overview state ──────────────────────────────────────────────────────────
  const [analytics,   setAnalytics]   = useState(EMPTY_ANALYTICS);
  const [hrAlerts,    setHRAlerts]    = useState([]);
  const [approvals,   setApprovals]   = useState([]);
  const [dismissed,   setDismissed]   = useState(new Set());
  const [toast,       setToast]       = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [_lastSync,    setLastSync]    = useState(new Date());

  // ── Analytics state ─────────────────────────────────────────────────────────
  const analyticsLoadedRef             = useRef(false);
  const [dept,         setDept]        = useState('All');
  const [aLoading,     setALoading]    = useState(false);
  const [aError,       setAError]      = useState(null);
  const [lastRefresh,  setLastRefresh] = useState(null);
  const [headcount,    setHeadcount]   = useState({});
  const [attrition,    setAttrition]   = useState({});
  const [offerAccept,  setOfferAccept] = useState({});
  const [absenteeism,  setAbsenteeism] = useState({});
  const [attrTrend,    setAttrTrend]   = useState([]);
  const [hireTrend,    setHireTrend]   = useState([]);
  const [genderDist,   setGenderDist]  = useState([]);
  const [deptWorkforce,setDeptWorkforce] = useState([]);
  const [productivity, setProductivity] = useState([]);
  const [topPerformers,setTopPerformers] = useState([]);
  const [apiInsights,  setApiInsights] = useState([]);
  // ── New metrics ─────────────────────────────────────────────────────────────
  const [hcTrend,      setHcTrend]      = useState([]);
  const [salaryBands,  setSalaryBands]  = useState([]);
  const [timeToHire,   setTimeToHire]   = useState({});
  const [satisfaction, setSatisfaction] = useState({});
  const [onboarding,   setOnboarding]   = useState({});
  const [compliance,   setCompliance]   = useState([]);

  const showToast = (msg, type='success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // ── Overview load ───────────────────────────────────────────────────────────
  const loadOverview = useCallback(async () => {
    setLoading(true);
    const [analyticsR, empR, approvalsR, onboardingR, complianceR] = await Promise.allSettled([
      api.get('/employees/analytics'),
      api.get('/employees'),
      api.get('/leaves', { params: { status: 'pending' } }),
      getOnboarding(),
      getComplianceAlerts(),
    ]);
    if (analyticsR.status === 'fulfilled' && analyticsR.value.data?.summary)
      setAnalytics(analyticsR.value.data);
    if (empR.status === 'fulfilled' && Array.isArray(empR.value.data))
      setHRAlerts(computeHRAlerts(empR.value.data));
    if (approvalsR.status === 'fulfilled') {
      const raw = approvalsR.value.data;
      setApprovals(Array.isArray(raw) ? raw : (raw?.data || raw?.leaves || raw?.approvals || []));
    }
    if (onboardingR.status === 'fulfilled' && onboardingR.value)
      setOnboarding(onboardingR.value);
    if (complianceR.status === 'fulfilled' && Array.isArray(complianceR.value))
      setCompliance(complianceR.value);
    setLastSync(new Date());
    setLoading(false);
  }, []);

  // ── Analytics load (lazy) ───────────────────────────────────────────────────
  const loadAnalytics = useCallback(async () => {
    setALoading(true);
    setAError(null);
    const [hc, at, oa, ab, atT, hiT, gd, dw, pr, tp, ins, hcT, sb, tth, sat] = await Promise.allSettled([
      getHeadcount(), getAttrition(), getOfferAcceptance(), getAbsenteeism(),
      getAttritionTrend(), getHiringTrend(), getGenderDist(), getDeptWorkforce(),
      getProductivity(), getTopPerformers(), getHRInsights(),
      getHeadcountTrend(), getSalaryBands(), getTimeToHire(), getSatisfaction(),
    ]);
    if (hc.status  === 'fulfilled') setHeadcount(hc.value);
    if (at.status  === 'fulfilled') setAttrition(at.value);
    if (oa.status  === 'fulfilled') setOfferAccept(oa.value);
    if (ab.status  === 'fulfilled') setAbsenteeism(ab.value);
    if (atT.status === 'fulfilled') setAttrTrend(atT.value);
    if (hiT.status === 'fulfilled') setHireTrend(hiT.value);
    if (gd.status  === 'fulfilled') setGenderDist(gd.value);
    if (dw.status  === 'fulfilled') setDeptWorkforce(dw.value);
    if (pr.status  === 'fulfilled') setProductivity(pr.value);
    if (tp.status  === 'fulfilled') setTopPerformers(tp.value);
    if (ins.status === 'fulfilled') setApiInsights(ins.value);
    if (hcT.status === 'fulfilled') setHcTrend(hcT.value);
    if (sb.status  === 'fulfilled') setSalaryBands(sb.value);
    if (tth.status === 'fulfilled') setTimeToHire(tth.value);
    if (sat.status === 'fulfilled') setSatisfaction(sat.value);
    const allRejected = [hc,at,oa,ab,atT,hiT,gd,dw,pr,tp,ins,hcT,sb,tth,sat].every(r => r.status === 'rejected');
    if (allRejected) setAError('Failed to load HR analytics data');
    setALoading(false);
    setLastRefresh(new Date().toLocaleTimeString());
    analyticsLoadedRef.current = true;
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  const handleTabSwitch = (tab) => {
    setActiveTab(tab);
    if (tab === 'analytics' && !analyticsLoadedRef.current) loadAnalytics();
  };

  // ── Overview derived ────────────────────────────────────────────────────────
  const s              = analytics.summary;
  const attritionRate  = s.total > 0 ? Math.round((s.left / s.total) * 100) : 0;
  const pendingLeaves  = approvals.filter(a => !dismissed.has(a.id)).length;
  const probationEnding= hrAlerts.filter(a => a.type === 'probation').length;
  const newHires       = analytics.newHiresMonthly?.at(-1)?.hires || s.newHires || 0;

  const insights = useMemo(() => generateHRInsights({
    total: s.total, attritionRate, newHires, pendingLeaves, probationEnding,
  }), [s.total, attritionRate, newHires, pendingLeaves, probationEnding]);

  const trendData = (analytics.newHiresMonthly || []).map(h => {
    const ex = (analytics.attritionMonthly || []).find(a => a.month === h.month);
    return { month: (h.month || '').replace(' 24','').replace(' 25',''), hires: h.hires || 0, exits: ex?.exits || 0 };
  });

  const visibleApprovals = approvals.filter(a => !dismissed.has(a.id));

  // ── Analytics derived ───────────────────────────────────────────────────────
  const analyticsInsights = useMemo(() => {
    const ruleInsights = generateInsights({ attritionRate: attrition.rate, offerAcceptanceRate: offerAccept.rate });
    const seen = new Set(apiInsights.map(i => i.rule));
    return [...apiInsights, ...ruleInsights.filter(i => !seen.has(i.rule))];
  }, [attrition, offerAccept, apiInsights]);

  const filteredDepts = useMemo(() =>
    dept === 'All' ? deptWorkforce : deptWorkforce.filter(d => d.dept === dept),
  [dept, deptWorkforce]);

  const handleSelectPerformer = (p) => {
    if (setPage) {
      sessionStorage.setItem('selectedEmployee', JSON.stringify({ name: p.name, dept: p.dept }));
      setPage('EmployeeProfile');
    }
  };

  async function handleApprove(item) {
    try { await api.post(`/approvals/${item.id}/approve`); } catch { /**/ }
    setDismissed(prev => new Set([...prev, item.id]));
    showToast(`Approved ${item.type || 'request'} for ${item.employee || item.employee_name}`);
  }
  async function handleReject(item) {
    try { await api.post(`/approvals/${item.id}/reject`); } catch { /**/ }
    setDismissed(prev => new Set([...prev, item.id]));
    showToast(`Rejected ${item.type || 'request'} for ${item.employee || item.employee_name}`, 'error');
  }

  const INSIGHT_STYLE = {
    success: { bg:'#f0fdf4', border:'#bbf7d0', text:'#166534' },
    warning: { bg:'#fffbeb', border:'#fde68a', text:'#92400e' },
    danger:  { bg:'#fef2f2', border:'#fecaca', text:'#991b1b' },
    info:    { bg: LIGHT,    border: BORDER,   text:'#5b21b6' },
  };

  const shimmerStyle = {
    height: 14, borderRadius: 6,
    background: 'linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 50%, #f3f4f6 75%)',
    backgroundSize: '200% 100%',
    animation: 'hr-shimmer 1.4s infinite',
  };

  // Shared chart renderers — compact card + expanded modal use the same markup
  const deptChart = (h = 170, rows = 7) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={analytics.deptBreakdown?.slice(0, rows) || []} layout="vertical" margin={{ top: 0, right: 24, left: 80, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0eeff" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="department" tick={{ fontSize: 11 }} width={78} />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey="active" name="Active" stackId="a" fill="#10b981" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );

  const hiresExitsChart = (h = 150, months = 6) => (
    <ResponsiveContainer width="100%" height={h}>
      <AreaChart data={trendData.slice(-months)} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="hiresGradHR" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={P} stopOpacity={0.2} />
            <stop offset="95%" stopColor={P} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="exitsGradHR" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#dc2626" stopOpacity={0.15} />
            <stop offset="95%" stopColor="#dc2626" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="month" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} />
        <Tooltip content={<CustomTooltip />} />
        <Area type="monotone" dataKey="hires" name="Hires" stroke={P} strokeWidth={2} fill="url(#hiresGradHR)" dot={{ r: 3 }} />
        <Area type="monotone" dataKey="exits" name="Exits" stroke="#dc2626" strokeWidth={2} fill="url(#exitsGradHR)" dot={{ r: 3 }} />
      </AreaChart>
    </ResponsiveContainer>
  );

  return (
    <div style={{ padding:'16px 18px 20px', background:'#f8f9fc', minHeight:'100vh' }}>
      <style>{`@keyframes hr-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>

      {/* Toast */}
      {toast && (
        <div style={{
          position:'fixed', top:16, right:16, zIndex:1000,
          background: toast.type === 'error' ? '#fef2f2' : '#f0fdf4',
          border:`1px solid ${toast.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
          color: toast.type === 'error' ? '#991b1b' : '#166534',
          borderRadius:8, padding:'10px 16px', fontSize:13,
          display:'flex', alignItems:'center', gap:8, boxShadow:'0 4px 12px rgba(0,0,0,0.1)',
        }}>
          {toast.msg}
        </div>
      )}

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16 }}>
        <div>
          <h1 style={{ margin:0, fontSize:22, fontWeight:700, color:'#111827' }}>HR Dashboard</h1>
          <p style={{ margin:'4px 0 0', color:'#6b7280', fontSize:13 }}>
            {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
            {' · '}<span style={{ color:P, fontWeight:500 }}>People & Culture</span>
            {activeTab === 'analytics' && lastRefresh && (
              <span style={{ marginLeft:8, color:'#d1d5db' }}>· Updated {lastRefresh}</span>
            )}
          </p>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {activeTab === 'analytics' && (
            <div style={{ display:'flex', alignItems:'center', gap:6, background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, padding:'6px 10px' }}>
              <Filter size={13} color="#9ca3af"/>
              <select value={dept} onChange={e => setDept(e.target.value)} style={{ border:'none', outline:'none', fontSize:12, color:'#374151', cursor:'pointer', background:'transparent' }}>
                {DEPTS.map(d => <option key={d}>{d}</option>)}
              </select>
            </div>
          )}
          {activeTab === 'overview' && canManage && (
            <button onClick={() => setPage('AddEmployee')} style={{
              padding:'7px 12px', background:P, color:'#fff', border:'none',
              borderRadius:8, cursor:'pointer', fontSize:12, display:'flex', alignItems:'center', gap:5,
            }}>
              <Plus size={13} /> Add Employee
            </button>
          )}
          <button
            onClick={() => activeTab === 'overview' ? loadOverview() : loadAnalytics()}
            disabled={activeTab === 'overview' ? loading : aLoading}
            style={{ padding:'7px 10px', background:'#fff', border:`1px solid ${BORDER}`, borderRadius:8, cursor:'pointer', color:'#6b7280' }}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* ── Tab switcher ──────────────────────────────────────────────────────── */}
      <div style={{ display:'flex', gap:2, background:'#f3f4f6', borderRadius:10, padding:3, marginBottom:14, width:'fit-content' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => handleTabSwitch(t.key)}
            style={{
              display:'flex', alignItems:'center', gap:6,
              padding:'6px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:500,
              background: activeTab === t.key ? '#fff' : 'transparent',
              color: activeTab === t.key ? P : '#6b7280',
              boxShadow: activeTab === t.key ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
              transition: 'all 0.15s',
            }}
          >
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════════════════════════
          OVERVIEW TAB
      ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'overview' && (
        <>
          {/* AI HR Insights */}
          <div className="dk-anim" style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, padding:'12px 14px', marginBottom:12 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
              <div style={{ width:30, height:30, borderRadius:8, background:LIGHT, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <Zap size={15} color={P} />
              </div>
              <div>
                <div style={{ fontSize:13, fontWeight:600, color:'#374151' }}>AI HR Insights</div>
                <div style={{ fontSize:11, color:'#9ca3af' }}>Analysed from workforce data</div>
              </div>
            </div>
            <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
              {insights.map((ins, i) => {
                const c = INSIGHT_STYLE[ins.type];
                return (
                  <div key={i} style={{ flex:'1 1 280px', background:c.bg, border:`1px solid ${c.border}`, borderRadius:8, padding:'10px 14px', display:'flex', alignItems:'flex-start', gap:10 }}>
                    <span style={{ fontSize:18, lineHeight:1 }}>{ins.emoji}</span>
                    <span style={{ fontSize:12, color:c.text, lineHeight:1.55 }}>{ins.text}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* KPI Cards */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:10, marginBottom:12 }}>
            {[
              { icon:Users,        label:'Total Employees', value:s.total||0,          sub:`${s.active||0} active`,                                                    color:P,         page:'EmployeesData',      statusFilter: null          },
              { icon:UserCheck,    label:'On Probation',    value:s.probation||0,       sub:'Pending confirmation',                                                     color:'#d97706', page:'EmployeesData',      statusFilter: 'Probation'   },
              { icon:Calendar,     label:'New Hires (Mo)',  value:newHires,             sub:'This month',                                                               color:'#10b981', page:'EmployeesDashboard', statusFilter: null          },
              { icon:TrendingDown, label:'Attrition Rate',  value:`${attritionRate}%`, sub:attritionRate>12?'Above benchmark':'Within range', color:attritionRate>12?'#dc2626':'#10b981', page:'ExEmployees', statusFilter: null },
              { icon:Clock,        label:'Pending Leaves',  value:pendingLeaves,        sub:'Awaiting approval',                                                        color:'#ef4444', page:'LeaveApprovals',     statusFilter: null          },
            ].map((k, i) => (
              <div key={i} className="dk-anim"
                onClick={() => {
                  if (k.statusFilter) sessionStorage.setItem('employeeStatusFilter', k.statusFilter);
                  if (k.page) setPage(k.page);
                }}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 6px 16px rgba(107,63,219,0.13)')}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
                style={{ '--dk-i': i, background:'#fff', border:`1px solid ${BORDER}`, borderRadius:11, padding:'11px 13px', cursor:'pointer', transition:'box-shadow 0.15s', display:'flex', alignItems:'center', gap:11 }}
              >
                <div style={{ width:36, height:36, borderRadius:9, background:k.color+'18', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <k.icon size={17} color={k.color} />
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:11, color:'#9ca3af', marginBottom:2 }}>{k.label}</div>
                  {loading ? <div style={{ ...shimmerStyle, width:50, marginBottom:4 }} /> : (
                    <div style={{ fontSize:20, fontWeight:700, color:'#111827' }}>{k.value}</div>
                  )}
                  <div style={{ fontSize:11, color:k.color, fontWeight:500, marginTop:1 }}>{k.sub}</div>
                </div>
                <ChevronRight size={14} color="#d1d5db" />
              </div>
            ))}
          </div>

          {/* Row 2: Dept + Gender + Hires Trend */}
          <div style={{ display:'grid', gridTemplateColumns:'6fr 3fr 3fr', gap:12, marginBottom:12 }}>
            <div className="dk-anim" style={{ '--dk-i': 1, background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, padding:'14px 16px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <div style={{ fontSize:13, fontWeight:600, color:'#374151' }}>Department Headcount</div>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <button onClick={() => setPage('EmployeesDashboard')} style={{ background:'none', border:'none', cursor:'pointer', color:P, fontSize:11, display:'flex', alignItems:'center', gap:3 }}>
                    Full Analytics <ArrowUpRight size={11} />
                  </button>
                  {(analytics.deptBreakdown?.length || 0) > 0 && (
                    <ChartExpandButton title="Department Headcount" subtitle="Active employees per department"
                      onViewAll={() => setPage('EmployeesDashboard')} viewAllLabel="Full Analytics">
                      {deptChart(440, 20)}
                    </ChartExpandButton>
                  )}
                </div>
              </div>
              {analytics.deptBreakdown?.length === 0 ? <EmptyState Icon={Users} message="No department data yet" /> : deptChart(165)}
            </div>

            <div className="dk-anim" style={{ '--dk-i': 2, background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, padding:'14px 16px' }}>
              <div style={{ fontSize:13, fontWeight:600, color:'#374151', marginBottom:10 }}>Gender Distribution</div>
              {analytics.genderBreakdown?.length === 0 ? <EmptyState Icon={Inbox} message="No data available" /> : (
                <>
                  <ResponsiveContainer width="100%" height={130}>
                    <PieChart>
                      <Pie data={analytics.genderBreakdown||[]} dataKey="count" nameKey="gender"
                        cx="50%" cy="50%" outerRadius={52} innerRadius={28}
                        label={({ percent }) => `${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={11}>
                        {(analytics.genderBreakdown||[]).map((_, i) => <Cell key={i} fill={GENDER_COLORS[i%GENDER_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v, n) => [v, n]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display:'flex', flexDirection:'column', gap:4, marginTop:8 }}>
                    {(analytics.genderBreakdown||[]).map((g, i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:6, fontSize:11 }}>
                        <span style={{ width:8, height:8, borderRadius:2, background:GENDER_COLORS[i%GENDER_COLORS.length], display:'inline-block' }} />
                        <span style={{ color:'#374151', flex:1 }}>{g.gender}</span>
                        <span style={{ color:'#9ca3af' }}>{g.count}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="dk-anim" style={{ '--dk-i': 3, background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, padding:'14px 16px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <div style={{ fontSize:13, fontWeight:600, color:'#374151' }}>Hires vs Exits (6mo)</div>
                {trendData.length > 0 && (
                  <ChartExpandButton title="Hires vs Exits" subtitle="Monthly hiring vs attrition trend">
                    {hiresExitsChart(420, 12)}
                  </ChartExpandButton>
                )}
              </div>
              {trendData.length === 0 ? <EmptyState Icon={BarChart2} message="No trend data yet" /> : (
                <>
                  {hiresExitsChart(135)}
                  <div style={{ display:'flex', gap:14, marginTop:8 }}>
                    {[{ label:'Hires', color:P },{ label:'Exits', color:'#dc2626' }].map(l => (
                      <span key={l.label} style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, color:'#6b7280' }}>
                        <span style={{ width:10, height:10, borderRadius:2, background:l.color, display:'inline-block' }} />
                        {l.label}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Row 3: Onboarding + Compliance + Org Structure */}
          <div className="dk-anim" style={{ '--dk-i': 2, display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:12 }}>
            <OnboardingWidget data={onboarding} loading={loading} />
            <ComplianceWidget data={compliance} loading={loading} />
            <OrgSummaryWidget setPage={setPage} />
          </div>

          {/* Row 4: Alerts + Pending Approvals + Quick Actions */}
          <div style={{ display:'grid', gridTemplateColumns:'4fr 5fr 3fr', gap:12 }}>
            <div className="dk-anim" style={{ '--dk-i': 3, background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, padding:'14px 16px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14 }}>
                <Bell size={14} color="#ef4444" />
                <div style={{ fontSize:13, fontWeight:600, color:'#374151' }}>HR Alerts</div>
                {hrAlerts.filter(a=>a.priority==='high').length > 0 && (
                  <span style={{ marginLeft:'auto', fontSize:11, background:'#fef2f2', color:'#dc2626', padding:'2px 8px', borderRadius:6, fontWeight:600 }}>
                    {hrAlerts.filter(a=>a.priority==='high').length} urgent
                  </span>
                )}
              </div>
              {hrAlerts.length === 0 ? (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'32px 16px', color:'#9ca3af', gap:8 }}>
                  <CheckCircle size={28} color="#10b981" strokeWidth={1.5} />
                  <p style={{ margin:0, fontSize:13 }}>All systems healthy</p>
                </div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:8, maxHeight:260, overflowY:'auto' }}>
                  {hrAlerts.map((a, i) => {
                    const st = ALERT_STYLE[a.priority] || ALERT_STYLE.low;
                    return (
                      <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:8, padding:'8px 10px', borderRadius:8, background:st.bg, border:`1px solid ${st.border}` }}>
                        <span style={{ width:7, height:7, borderRadius:'50%', background:st.dot, flexShrink:0, marginTop:4 }} />
                        <span style={{ fontSize:12, color:'#374151', lineHeight:1.45 }}>{a.message}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="dk-anim" style={{ '--dk-i': 4, background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, padding:'14px 16px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <Clock size={14} color="#d97706" />
                  <span style={{ fontSize:13, fontWeight:600, color:'#374151' }}>Pending Approvals</span>
                  {visibleApprovals.length > 0 && (
                    <span style={{ fontSize:11, background:'#fffbeb', color:'#92400e', padding:'1px 7px', borderRadius:6 }}>{visibleApprovals.length}</span>
                  )}
                </div>
                <button onClick={() => setPage('LeaveApprovals')} style={{ background:'none', border:'none', cursor:'pointer', color:P, fontSize:11, display:'flex', alignItems:'center', gap:3 }}>
                  View all <ArrowUpRight size={11} />
                </button>
              </div>
              {loading ? (
                <div style={{ display:'flex', flexDirection:'column', gap:10, padding:'0 0 8px' }}>
                  {[1,2,3].map(i => <div key={i} style={{ ...shimmerStyle, width: i===2?'70%':i===3?'50%':'100%' }} />)}
                </div>
              ) : visibleApprovals.length === 0 ? (
                <div style={{ textAlign:'center', padding:'24px 0', color:'#9ca3af' }}>
                  <CheckCircle size={28} color="#10b981" style={{ margin:'0 auto 8px', display:'block' }} />
                  <div style={{ fontSize:13, color:'#374151', fontWeight:500 }}>All caught up!</div>
                </div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:8, maxHeight:260, overflowY:'auto' }}>
                  {visibleApprovals.map(item => (
                    <div key={item.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', background:LIGHT, borderRadius:8 }}>
                      <div style={{ width:32, height:32, borderRadius:'50%', background:P, color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, flexShrink:0 }}>
                        {(item.employee||item.employee_name||'E').charAt(0).toUpperCase()}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:'#374151' }}>{item.employee || item.employee_name}</div>
                        <div style={{ fontSize:11, color:'#6b7280' }}>{item.type || item.leave_type} · {item.dates || item.start_date}</div>
                      </div>
                      <div style={{ display:'flex', gap:5 }}>
                        <button onClick={() => handleApprove(item)} style={{ padding:'4px 10px', background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:6, cursor:'pointer', fontSize:11, color:'#166534' }}>✓</button>
                        <button onClick={() => handleReject(item)}  style={{ padding:'4px 10px', background:'#fef2f2', border:'1px solid #fecaca', borderRadius:6, cursor:'pointer', fontSize:11, color:'#991b1b' }}>✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="dk-anim" style={{ '--dk-i': 5, background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, padding:'14px 16px' }}>
              <div style={{ fontSize:13, fontWeight:600, color:'#374151', marginBottom:12 }}>Quick Actions</div>
              <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
                {[
                  { label:'Add Employee',      page:'AddEmployee',         color:'#10b981', icon:Plus,        hrOnly: true  },
                  { label:'Employee Records',  page:'EmployeesData',       color:P,         icon:Users,       hrOnly: false },
                  { label:'Leave Approvals',   page:'LeaveApprovals',      color:'#d97706', icon:CheckCircle, hrOnly: false },
                  { label:'Attendance',        page:'AttendanceDashboard', color:'#3b82f6', icon:UserCheck,   hrOnly: false },
                  { label:'Payroll',           page:'Payroll',             color:'#7c3aed', icon:Briefcase,   hrOnly: false },
                  { label:'Ex-Employees',      page:'ExEmployees',         color:'#ef4444', icon:UserX,       hrOnly: false },
                ].filter(q => !q.hrOnly || canManage).map((q, i) => (
                  <button key={i} onClick={() => setPage(q.page)} style={{
                    width:'100%', textAlign:'left', display:'flex', alignItems:'center', justifyContent:'space-between',
                    padding:'8px 12px', background:LIGHT, border:`1px solid ${BORDER}`, borderRadius:8,
                    cursor:'pointer', fontSize:12, color:'#374151',
                  }}
                    onMouseEnter={e => (e.currentTarget.style.background = BORDER)}
                    onMouseLeave={e => (e.currentTarget.style.background = LIGHT)}
                  >
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <q.icon size={13} color={q.color} />
                      {q.label}
                    </div>
                    <ChevronRight size={12} color="#9ca3af" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          ANALYTICS TAB
      ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'analytics' && (
        <>
          {aError && (
            <div style={{ background:'#fee2e2', color:'#dc2626', borderRadius:8, padding:'10px 14px', marginBottom:16, fontSize:13 }}>{aError}</div>
          )}
          {/* Row 1: 6 KPI cards */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:12, marginBottom:12 }}>
            <HeadcountCard       data={headcount}    loading={aLoading} />
            <AttritionRateCard   data={attrition}    loading={aLoading} />
            <OfferAcceptanceCard data={offerAccept}  loading={aLoading} />
            <AbsenteeismCard     data={absenteeism}  loading={aLoading} />
            <TimeToHireCard      data={timeToHire}   loading={aLoading} />
            <SatisfactionCard    data={satisfaction} loading={aLoading} />
          </div>
          {/* Row 2: Headcount trend 12M + Attrition trend */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
            <HeadcountTrendChart data={hcTrend}    loading={aLoading} />
            <AttritionTrendChart data={attrTrend}  loading={aLoading} />
          </div>
          {/* Row 3: Hires vs Exits + Salary bands */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
            <HiringTrendChart  data={hireTrend}  loading={aLoading} />
            <SalaryBandChart   data={salaryBands} loading={aLoading} />
          </div>
          {/* Row 4: Gender + Dept strength */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:12, marginBottom:12 }}>
            <GenderDistributionChart data={genderDist}    loading={aLoading} />
            <DepartmentStrengthChart data={filteredDepts} loading={aLoading} />
          </div>
          {/* Row 5: Productivity + Top performers */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
            <ProductivityTrendChart data={productivity}   loading={aLoading} />
            <TopPerformersTable     data={topPerformers}  loading={aLoading} onSelect={handleSelectPerformer} />
          </div>
          <InsightsPanel insights={analyticsInsights} loading={aLoading} />
        </>
      )}
    </div>
  );
}
