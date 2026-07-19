import { useState, useEffect, useCallback } from 'react';
import {
  Download, RefreshCw, Search, Users, Clock, TrendingUp,
  Target, AlertTriangle, CheckCircle,
} from 'lucide-react';
import api from '@/services/api/client';

// ── CSV export helper ──────────────────────────────────────────
function exportCSV(rows, filename) {
  if (!rows || rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const fmt = n => n >= 100000 ? `₹${(n/100000).toFixed(1)}L` : `₹${Number(n||0).toLocaleString('en-IN')}`;
const pct = (n) => `${parseFloat(n||0).toFixed(1)}%`;

// ── Sub-components ────────────────────────────────────────────

function KpiCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div style={{ background:'#fff', borderRadius:12, padding:'18px 20px', border:'1px solid #f0f0f4', display:'flex', alignItems:'center', gap:14 }}>
      <div style={{ width:44, height:44, borderRadius:10, background:color+'22', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
        <Icon size={20} color={color} />
      </div>
      <div>
        <div style={{ fontSize:22, fontWeight:800, color:'#111827' }}>{value}</div>
        <div style={{ fontSize:12, fontWeight:600, color:'#374151' }}>{label}</div>
        {sub && <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>{sub}</div>}
      </div>
    </div>
  );
}

function SectionHeader({ title, onExport, exportLabel = 'Export CSV' }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
      <h3 style={{ fontSize:15, fontWeight:700, color:'#111827', margin:0 }}>{title}</h3>
      {onExport && (
        <button onClick={onExport} style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 14px', background:'#f3f4f6', border:'none', borderRadius:8, cursor:'pointer', fontSize:12, fontWeight:600, color:'#374151' }}>
          <Download size={13} /> {exportLabel}
        </button>
      )}
    </div>
  );
}

function TableWrap({ children }) {
  return (
    <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'auto' }}>
      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>{children}</table>
    </div>
  );
}

const TH = ({ children, right }) => (
  <th style={{ padding:'10px 16px', textAlign: right ? 'right' : 'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap', background:'#f9fafb' }}>{children}</th>
);
const TD = ({ children, right, bold }) => (
  <td style={{ padding:'10px 16px', textAlign: right ? 'right' : 'left', color: bold ? '#111827' : '#374151', fontWeight: bold ? 600 : 400, borderBottom:'1px solid #f9fafb' }}>{children}</td>
);

// ── Main component ────────────────────────────────────────────
export default function RecruitmentReports() {
  const today = new Date();
  const sixtyDaysAgo = new Date(today);
  sixtyDaysAgo.setDate(today.getDate() - 60);

  const [fromDate, setFromDate] = useState(sixtyDaysAgo.toISOString().slice(0, 10));
  const [toDate,   setToDate]   = useState(today.toISOString().slice(0, 10));
  const [dept,     setDept]     = useState('');
  const [tab,      setTab]      = useState('summary');
  const [loading,  setLoading]  = useState(false);
  const [deptList, setDeptList] = useState([]);

  const [summary,  setSummary]  = useState(null);
  const [aging,    setAging]    = useState([]);
  const [source,   setSource]   = useState([]);
  const [pipeline, setPipeline] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = { from_date: fromDate, to_date: toDate };
    if (dept) params.department = dept;

    const [sumRes, ageRes, srcRes, pipRes] = await Promise.allSettled([
      api.get('/recruitment/reports/summary', { params }),
      api.get('/recruitment/reports/vacancy-aging', { params }),
      api.get('/recruitment/reports/source-effectiveness', { params }),
      api.get('/recruitment/reports/department-pipeline', { params }),
    ]);

    setSummary(sumRes.status === 'fulfilled' ? sumRes.value.data : null);
    setAging(ageRes.status === 'fulfilled' && Array.isArray(ageRes.value.data) ? ageRes.value.data : []);
    setSource(srcRes.status === 'fulfilled' && Array.isArray(srcRes.value.data) ? srcRes.value.data : []);
    setPipeline(pipRes.status === 'fulfilled' && Array.isArray(pipRes.value.data) ? pipRes.value.data : []);
    setLoading(false);
  }, [fromDate, toDate, dept]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  const tabs = [
    { key: 'summary',  label: 'Summary' },
    { key: 'aging',    label: 'Vacancy Aging' },
    { key: 'source',   label: 'Source Effectiveness' },
    { key: 'pipeline', label: 'Dept Pipeline' },
  ];

  return (
    <div style={{ padding:28, background:'#f9fafb', minHeight:'100vh', margin:'0 auto' }}>

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:24, flexWrap:'wrap', gap:16 }}>
        <div>
          <h1 style={{ fontSize:24, fontWeight:800, color:'#111827', margin:0 }}>Recruitment Reports</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Hiring analytics, vacancy aging, source ROI and department pipeline</p>
        </div>
        <button onClick={load} style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 16px', background:'#f3f4f6', border:'none', borderRadius:9, cursor:'pointer', fontSize:13, color:'#374151' }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div style={{ display:'flex', gap:12, marginBottom:24, flexWrap:'wrap', background:'#fff', padding:16, borderRadius:12, border:'1px solid #f0f0f4' }}>
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          <label style={{ fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase', letterSpacing:'.04em' }}>From Date</label>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, outline:'none' }} />
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          <label style={{ fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase', letterSpacing:'.04em' }}>To Date</label>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, outline:'none' }} />
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          <label style={{ fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase', letterSpacing:'.04em' }}>Department</label>
          <select value={dept} onChange={e => setDept(e.target.value)}
            style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, outline:'none', width:180, background:'#fff' }}>
            <option value="">All Departments</option>
            {deptList.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div style={{ display:'flex', alignItems:'flex-end' }}>
          <button onClick={load} style={{ padding:'7px 20px', background:'#4B2DCE', color:'#fff', border:'none', borderRadius:7, cursor:'pointer', fontSize:13, fontWeight:700 }}>
            Apply
          </button>
        </div>
      </div>

      {/* KPI row */}
      {summary && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:14, marginBottom:24 }}>
          <KpiCard icon={Users}      label="Total Candidates" value={summary.total_candidates || 0}   color="#4B2DCE" />
          <KpiCard icon={CheckCircle} label="Total Hired"     value={summary.total_hired || 0}         color="#16a34a" />
          <KpiCard icon={Target}     label="Active Pipeline"  value={summary.active_pipeline || 0}     color="#0891b2" />
          <KpiCard icon={Clock}      label="Avg Time to Hire" value={summary.avg_time_to_hire ? `${parseFloat(summary.avg_time_to_hire).toFixed(0)}d` : '—'} color="#d97706" />
          <KpiCard icon={TrendingUp} label="Hire Rate"
            value={summary.total_candidates > 0 ? pct((summary.total_hired / summary.total_candidates) * 100) : '0%'}
            color="#6B3FDB" />
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:20, flexWrap:'wrap' }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding:'8px 18px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:600,
              background: tab===t.key ? '#4B2DCE' : '#f3f4f6',
              color: tab===t.key ? '#fff' : '#374151' }}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>Loading…</div>
      ) : (
        <>
          {/* ── SUMMARY TAB ── */}
          {tab === 'summary' && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>
              <div>
                <SectionHeader title="Hire by Source" onExport={() => exportCSV([
                  { source: 'referral', hires: summary?.referral_hires },
                  { source: 'linkedin', hires: summary?.linkedin_hires },
                  { source: 'website', hires: summary?.website_hires },
                  { source: 'job_portal', hires: summary?.job_portal_hires },
                ], 'hire_by_source.csv')} />
                <TableWrap>
                  <thead><tr><TH>Source</TH><TH right>Hires</TH></tr></thead>
                  <tbody>
                    {[
                      { label: 'Referral',   val: summary?.referral_hires },
                      { label: 'LinkedIn',   val: summary?.linkedin_hires },
                      { label: 'Website',    val: summary?.website_hires },
                      { label: 'Job Portal', val: summary?.job_portal_hires },
                    ].map(r => (
                      <tr key={r.label}><TD>{r.label}</TD><TD right bold>{r.val || 0}</TD></tr>
                    ))}
                  </tbody>
                </TableWrap>
              </div>
              <div>
                <SectionHeader title="Conversion Funnel" />
                <TableWrap>
                  <thead><tr><TH>Stage</TH><TH right>Count</TH></tr></thead>
                  <tbody>
                    {[
                      { label: 'Applied',         val: summary?.total_candidates },
                      { label: 'Hired',           val: summary?.total_hired },
                      { label: 'Rejected',        val: summary?.total_rejected },
                      { label: 'Active Pipeline', val: summary?.active_pipeline },
                    ].map(r => (
                      <tr key={r.label}><TD>{r.label}</TD><TD right bold>{r.val || 0}</TD></tr>
                    ))}
                  </tbody>
                </TableWrap>
              </div>
            </div>
          )}

          {/* ── VACANCY AGING TAB ── */}
          {tab === 'aging' && (
            <div>
              <SectionHeader
                title="Open Vacancies by Age"
                onExport={() => exportCSV(aging.map(r => ({
                  job_title: r.job_title,
                  department: r.department,
                  days_open: Math.round(r.days_open),
                  positions: r.number_of_positions,
                  filled: r.positions_filled,
                  applicants: r.applicant_count,
                  status: r.days_open > 60 ? 'At Risk' : 'Normal',
                })), 'vacancy_aging.csv')}
              />
              {aging.length === 0 ? (
                <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:40, textAlign:'center', color:'#9ca3af' }}>No open vacancies in this period.</div>
              ) : (
                <TableWrap>
                  <thead>
                    <tr>
                      <TH>Job Title</TH><TH>Department</TH><TH right>Days Open</TH>
                      <TH right>Positions</TH><TH right>Filled</TH><TH right>Applicants</TH><TH>Risk</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {aging.map(r => {
                      const days = Math.round(parseFloat(r.days_open || 0));
                      const atRisk = days > 60;
                      return (
                        <tr key={r.id}>
                          <TD bold>{r.job_title}</TD>
                          <TD>{r.department || '—'}</TD>
                          <TD right bold>{days}</TD>
                          <TD right>{r.number_of_positions || 1}</TD>
                          <TD right>{r.positions_filled || 0}</TD>
                          <TD right>{r.applicant_count || 0}</TD>
                          <TD>
                            <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:600,
                              background: atRisk ? '#fee2e2' : '#d1fae5', color: atRisk ? '#991b1b' : '#065f46' }}>
                              {atRisk && <AlertTriangle size={10} />}
                              {atRisk ? 'At Risk' : 'Normal'}
                            </span>
                          </TD>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableWrap>
              )}
            </div>
          )}

          {/* ── SOURCE EFFECTIVENESS TAB ── */}
          {tab === 'source' && (
            <div>
              <SectionHeader
                title="Source Effectiveness"
                onExport={() => exportCSV(source, 'source_effectiveness.csv')}
              />
              {source.length === 0 ? (
                <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:40, textAlign:'center', color:'#9ca3af' }}>No data for this period.</div>
              ) : (
                <TableWrap>
                  <thead>
                    <tr>
                      <TH>Source</TH><TH right>Applications</TH><TH right>Hires</TH>
                      <TH right>Rejections</TH><TH right>Hire Rate</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {source.map(r => (
                      <tr key={r.source}>
                        <TD bold>{r.source || '—'}</TD>
                        <TD right>{r.total_applications || 0}</TD>
                        <TD right>{r.hires || 0}</TD>
                        <TD right>{r.rejections || 0}</TD>
                        <TD right>
                          <span style={{ padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:700,
                            background: parseFloat(r.hire_rate_pct) >= 20 ? '#d1fae5' : '#fef3c7',
                            color: parseFloat(r.hire_rate_pct) >= 20 ? '#065f46' : '#92400e' }}>
                            {pct(r.hire_rate_pct)}
                          </span>
                        </TD>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </div>
          )}

          {/* ── DEPARTMENT PIPELINE TAB ── */}
          {tab === 'pipeline' && (
            <div>
              <SectionHeader
                title="Department Pipeline Breakdown"
                onExport={() => exportCSV(pipeline, 'department_pipeline.csv')}
              />
              {pipeline.length === 0 ? (
                <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:40, textAlign:'center', color:'#9ca3af' }}>No data for this period.</div>
              ) : (
                <TableWrap>
                  <thead>
                    <tr>
                      <TH>Department</TH><TH right>Total</TH><TH right>Applied</TH>
                      <TH right>Screening</TH><TH right>1st Round</TH><TH right>2nd Round</TH>
                      <TH right>Offer</TH><TH right>Hired</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {pipeline.map(r => (
                      <tr key={r.department}>
                        <TD bold>{r.department}</TD>
                        <TD right bold>{r.total || 0}</TD>
                        <TD right>{r.applied || 0}</TD>
                        <TD right>{r.screening || 0}</TD>
                        <TD right>{r.first_level || 0}</TD>
                        <TD right>{r.second_level || 0}</TD>
                        <TD right>{r.offer || 0}</TD>
                        <TD right>
                          <span style={{ padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:700, background:'#d1fae5', color:'#065f46' }}>
                            {r.hired || 0}
                          </span>
                        </TD>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
