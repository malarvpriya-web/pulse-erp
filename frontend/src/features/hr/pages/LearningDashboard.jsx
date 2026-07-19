// frontend/src/features/hr/pages/LearningDashboard.jsx
import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

const PIE_COLORS  = ['#6B3FDB','#2563eb','#16a34a','#d97706','#dc2626','#0891b2'];

function KPICard({ label, value, icon, color, sub, index = 0 }) {
  return (
    <div className="dk-anim" style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:11, padding:'11px 13px', display:'flex', flexDirection:'column', gap:2, '--dk-i': index }}>
      <div style={{ fontSize:18 }}>{icon}</div>
      <div style={{ fontSize:22, fontWeight:800, color, marginTop:1 }}>{value}</div>
      <div style={{ fontSize:11.5, fontWeight:600, color:'#374151' }}>{label}</div>
      {sub && <div style={{ fontSize:11, color:'#9ca3af' }}>{sub}</div>}
    </div>
  );
}

/* `children` is re-rendered inside the expand modal at full height — every chart
 * here uses ResponsiveContainer height="100%", so it fills whichever box it's in. */
function ChartCard({ title, height = 200, children, expandable = true, index = 0 }) {
  return (
    <div className="dk-anim" style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:11, padding:14, '--dk-i': index }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', margin:'0 0 9px' }}>
        <h4 style={{ margin:0, color:'#4c1d95', fontSize:13.5 }}>{title}</h4>
        {expandable && (
          <ChartExpandButton title={title}>
            <div style={{ height: 460 }}>{children}</div>
          </ChartExpandButton>
        )}
      </div>
      <div style={{ height }}>{children}</div>
    </div>
  );
}

function EmptyChart({ msg }) {
  return <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:'#9ca3af', fontSize:13 }}>{msg}</div>;
}

export default function LearningDashboard() {
  const [kpis, setKpis] = useState({});
  const [completionRates, setCompletionRates] = useState([]);
  const [costTrend, setCostTrend] = useState([]);
  const [costByType, setCostByType] = useState([]);
  const [skillGaps, setSkillGaps] = useState([]);
  const [certExpiry, setCertExpiry] = useState({});
  const [overdueTraining, setOverdueTraining] = useState([]);
  const [trainerEff, setTrainerEff] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [
      kpiRes, crRes, ctRes, cbtRes, sgRes, ceRes, ovRes, trRes,
    ] = await Promise.allSettled([
      api.get('/training/dashboard'),
      api.get('/lnd-reports/completion-rates'),
      api.get('/training/cost-trend'),
      api.get('/training/cost-by-type'),
      api.get('/lnd-reports/skill-gap/department'),
      api.get('/certifications/expiry-dashboard'),
      api.get('/lnd-reports/overdue-training'),
      api.get('/lnd-reports/trainer-effectiveness'),
    ]);

    if (kpiRes.status === 'fulfilled') setKpis(kpiRes.value.data || {});
    if (crRes.status === 'fulfilled') setCompletionRates((crRes.value.data || []).slice(0, 10));
    if (ctRes.status === 'fulfilled') setCostTrend(ctRes.value.data || []);
    if (cbtRes.status === 'fulfilled') setCostByType(cbtRes.value.data || []);
    if (sgRes.status === 'fulfilled') setSkillGaps((sgRes.value.data || []).slice(0, 8));
    if (ceRes.status === 'fulfilled') setCertExpiry(ceRes.value.data || {});
    if (ovRes.status === 'fulfilled') setOverdueTraining((ovRes.value.data || []).slice(0, 5));
    if (trRes.status === 'fulfilled') setTrainerEff((trRes.value.data || []).slice(0, 6));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const fmtINR = (n) => {
    const v = parseFloat(n) || 0;
    if (v >= 100000) return `₹${(v/100000).toFixed(1)}L`;
    return `₹${Math.round(v).toLocaleString('en-IN')}`;
  };

  if (loading) return (
    <div style={{ padding:40, textAlign:'center', color:'#6B3FDB', fontWeight:700, fontSize:18, background:'#f5f3ff', minHeight:'100vh' }}>
      Loading L&D Dashboard…
    </div>
  );

  const certData = [
    { name:'Active', value: certExpiry.active || 0 },
    { name:'Expiring 30d', value: certExpiry.expiring_30d || 0 },
    { name:'Expiring 60d', value: certExpiry.expiring_60d || 0 },
    { name:'Expired', value: certExpiry.expired || 0 },
  ].filter(d => d.value > 0);

  return (
    <div style={{ padding:'16px 18px 20px', background:'#f5f3ff', minHeight:'100vh' }}>
      <div style={{ marginBottom:14 }}>
        <h2 style={{ margin:0, color:'#4c1d95', fontSize:20 }}>🎓 L&D Command Centre</h2>
        <p style={{ margin:0, color:'#6b7280', fontSize:12.5 }}>Live learning & development intelligence across your organisation</p>
      </div>

      {/* KPI Row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(145px,1fr))', gap:10, marginBottom:14 }}>
        <KPICard index={0} label="Active Programs"       value={kpis.active_programs || 0}         icon="📅" color="#6B3FDB" />
        <KPICard index={1} label="Completion Rate"       value={`${kpis.completion_rate_pct || 0}%`} icon="✅" color="#16a34a" />
        <KPICard index={2} label="Employees Trained"     value={kpis.employees_trained || 0}        icon="👥" color="#2563eb" />
        <KPICard index={3} label="Training Cost"         value={fmtINR(kpis.total_training_cost)}   icon="💰" color="#d97706" />
        <KPICard index={4} label="Skill Gaps"            value={kpis.skill_gap_count || 0}          icon="⚠️" color="#dc2626" />
        <KPICard index={5} label="Mandatory Pending"     value={kpis.mandatory_pending || 0}        icon="🔴" color="#dc2626" sub="Non-compliant" />
        <KPICard index={6} label="Certs Expiring 30d"    value={kpis.certs_expiring_30d || 0}       icon="📋" color="#f97316" />
      </div>

      {/* Row 1: Completion rates + Cost trend */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
        <ChartCard index={7} title="Completion Rate by Program (Top 10)" height={195}>
          {completionRates.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={completionRates} layout="vertical" margin={{ left:120, right:20, top:4, bottom:4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e9e4ff" />
                <XAxis type="number" domain={[0,100]} tick={{ fontSize:10 }} tickFormatter={v => `${v}%`} />
                <YAxis type="category" dataKey="title" tick={{ fontSize:10 }} width={120} />
                <Tooltip formatter={v => [`${v}%`, 'Completion']} />
                <Bar dataKey="completion_pct" radius={[0,4,4,0]}>
                  {completionRates.map((r,i) => <Cell key={i} fill={r.completion_pct >= 80 ? '#16a34a' : r.completion_pct >= 50 ? '#d97706' : '#dc2626'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyChart msg="No completion data" />}
        </ChartCard>

        <ChartCard index={8} title="Monthly Training Spend" height={195}>
          {costTrend.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={costTrend} margin={{ top:4, right:20, left:0, bottom:4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e9e4ff" />
                <XAxis dataKey="month" tick={{ fontSize:10 }} />
                <YAxis tick={{ fontSize:10 }} tickFormatter={v => `₹${(v/1000).toFixed(0)}K`} />
                <Tooltip formatter={v => [fmtINR(v), 'Spend']} />
                <Line type="monotone" dataKey="cost" stroke="#6B3FDB" strokeWidth={2} dot={{ r:4 }} name="Training Spend" />
              </LineChart>
            </ResponsiveContainer>
          ) : <EmptyChart msg="No cost data" />}
        </ChartCard>
      </div>

      {/* Row 2: Cost by type + Cert expiry */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
        <ChartCard index={9} title="Cost by Training Type" height={180}>
          {costByType.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={costByType} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`} labelLine={false}>
                  {costByType.map((_,i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={v => [fmtINR(v)]} />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptyChart msg="No cost breakdown" />}
        </ChartCard>

        <ChartCard index={10} title="Certification Expiry Status" height={180}>
          {certData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={certData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value">
                  {certData.map((_,i) => <Cell key={i} fill={['#16a34a','#f97316','#d97706','#dc2626'][i]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptyChart msg="No certification data" />}
        </ChartCard>
      </div>

      {/* Row 3: Skill gaps + Trainer effectiveness */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
        <ChartCard index={11} title="Top Skill Gaps by Department" height={195}>
          {skillGaps.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={skillGaps} layout="vertical" margin={{ left:120, right:20, top:4, bottom:4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e9e4ff" />
                <XAxis type="number" domain={[0,5]} tick={{ fontSize:10 }} />
                <YAxis type="category" dataKey="skill_name" tick={{ fontSize:10 }} width={120} />
                <Tooltip />
                <Bar dataKey="avg_proficiency" name="Avg Proficiency" radius={[0,4,4,0]}>
                  {skillGaps.map((g,i) => <Cell key={i} fill={g.avg_proficiency < 2 ? '#dc2626' : g.avg_proficiency < 3 ? '#f97316' : '#16a34a'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyChart msg="No skill gap data" />}
        </ChartCard>

        <ChartCard index={12} title="Trainer Effectiveness (Avg Rating)" height={195}>
          {trainerEff.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trainerEff} margin={{ top:4, right:20, left:0, bottom:40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e9e4ff" />
                <XAxis dataKey="trainer" tick={{ fontSize:10 }} angle={-25} textAnchor="end" />
                <YAxis domain={[0,5]} tick={{ fontSize:10 }} />
                <Tooltip formatter={(v,n) => [v, n]} />
                <Bar dataKey="avg_rating" name="Avg Rating" radius={[4,4,0,0]}>
                  {trainerEff.map((t,i) => <Cell key={i} fill={t.avg_rating >= 4 ? '#16a34a' : t.avg_rating >= 3 ? '#d97706' : '#dc2626'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyChart msg="No trainer data" />}
        </ChartCard>
      </div>

      {/* Overdue Training Alert */}
      {overdueTraining.length > 0 && (
        <div className="dk-anim" style={{ background:'#fff', border:'1px solid #fecaca', borderRadius:11, padding:14, '--dk-i': 13 }}>
          <h4 style={{ margin:'0 0 9px', color:'#dc2626', fontSize:13.5 }}>🔴 Overdue Training ({overdueTraining.length} shown)</h4>
          <div style={{ maxHeight: 250, overflowY: 'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead><tr>
              {['Employee','Department','Training','Days Overdue','Mandatory'].map(h => (
                <th key={h} style={{ padding:'8px 12px', textAlign:'left', borderBottom:'1px solid #fecaca', color:'#dc2626', fontWeight:600, position:'sticky', top:0, background:'#fef2f2', zIndex:1 }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {overdueTraining.map(r => (
                <tr key={r.id} style={{ borderBottom:'1px solid #fef2f2' }}>
                  <td style={{ padding:'8px 12px', fontWeight:600 }}>{r.employee_name}</td>
                  <td style={{ padding:'8px 12px', color:'#6b7280' }}>{r.department}</td>
                  <td style={{ padding:'8px 12px' }}>{r.program}</td>
                  <td style={{ padding:'8px 12px', fontWeight:700, color:'#dc2626' }}>{r.days_overdue}d</td>
                  <td style={{ padding:'8px 12px' }}>
                    {r.is_mandatory && <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:600, background:'#fef2f2', color:'#dc2626' }}>Mandatory</span>}
                  </td>
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
