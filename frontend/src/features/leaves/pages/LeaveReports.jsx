import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Download, RefreshCw, BarChart2, TrendingDown, Users, Clock,
  Award, FileSpreadsheet, BarChart3, PlusCircle, CalendarClock,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { downloadCsv } from '../components/leaveShared';

const YEAR  = new Date().getFullYear();
// Next year only from December, when leave for January is being applied.
const YEARS = [YEAR - 2, YEAR - 1, YEAR, ...(new Date().getMonth() === 11 ? [YEAR + 1] : [])];
const MONTHS = [
  {v:'',l:'All Months'},{v:'1',l:'January'},{v:'2',l:'February'},{v:'3',l:'March'},
  {v:'4',l:'April'},{v:'5',l:'May'},{v:'6',l:'June'},{v:'7',l:'July'},
  {v:'8',l:'August'},{v:'9',l:'September'},{v:'10',l:'October'},
  {v:'11',l:'November'},{v:'12',l:'December'},
];

const fmt = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const cur  = v => v != null ? `₹${Number(v).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—';

// Quotes, commas and line breaks in a reason no longer break the file.
const exportCSV = (rows, columns, filename) =>
  downloadCsv(filename, columns.map(c => ({ label: c.label, key: c.key })), rows);

async function exportXLSX(rows, columns, filename) {
  try {
    // Dynamic import so bundle only loads xlsx when needed
    const XLSX = await import('xlsx');
    const wsData = [
      columns.map(c => c.label),
      ...rows.map(r => columns.map(c => {
        const v = r[c.key];
        return v ?? '';
      })),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    // Auto-fit column widths
    ws['!cols'] = columns.map(c => ({ wch: Math.max(c.label.length, 12) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leave Report');
    XLSX.writeFile(wb, filename.replace('.csv', '.xlsx'));
  } catch {
    // Fallback to CSV if xlsx not installed
    exportCSV(rows, columns, filename);
  }
}

const STATUS_COLORS = { approved:{bg:'#d1fae5',color:'#065f46'}, rejected:{bg:'#fee2e2',color:'#991b1b'}, pending:{bg:'#ede9fe',color:'#5b21b6'}, cancelled:{bg:'#f3f4f6',color:'#6b7280'} };
const sc = s => STATUS_COLORS[(s||'').toLowerCase()] || STATUS_COLORS.pending;

// The request-by-request "Leave Summary" report was removed 2026-11-24: it
// was the same list as Leaves → All Leaves (the register), which has more
// filters, totals, CSV and each request's approval history.
const REPORTS = [
  { id:'summary',      label:'Employee Balance Summary',icon:Users,       color:'#10b981' },
  { id:'liability',    label:'Leave Liability (₹)',    icon:TrendingDown, color:'#7c5cf0' },
  { id:'lop',          label:'LOP Report',             icon:BarChart2,   color:'#ef4444' },
  { id:'department',   label:'Department Summary',      icon:Award,       color:'#8b5cf6' },
  { id:'approval-performance', label:'Approval Performance', icon:Clock, color:'#0891b2' },
  { id:'credits',      label:'Leave Credit History',   icon:PlusCircle,  color:'#059669' },
  { id:'carry-forward', label:'Carried-Forward Leave', icon:CalendarClock, color:'#b45309' },
];

// What each report accepts — mirrors backend reports/reportCatalog.js.
const REPORT_FILTERS = {
  leave: ['start_date', 'end_date', 'department', 'status', 'employee_id'],
  summary: ['year', 'department'],
  liability: ['year'],
  lop: ['year', 'month'],
  department: ['year', 'month'],
  'approval-performance': ['start_date', 'end_date'],
  credits: ['year', 'department'],
  'carry-forward': ['year', 'department'],
};
// Which filter controls to show (Year/Month drive start_date/end_date).
const shows = (report, control) => {
  const f = REPORT_FILTERS[report] || [];
  if (control === 'year') return f.includes('year') || f.includes('start_date');
  if (control === 'month') return f.includes('month') || f.includes('start_date');
  return f.includes(control);
};

export default function LeaveReports() {
  const [activeReport, setActiveReport] = useState('summary');
  const [filters, setFilters] = useState({ year:YEAR, month:'', department:'', status:'', employee_id:'', leave_type_id:'' });
  const [rawData,    setData]       = useState([]);
  const [total,      setTotal]      = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [ran,        setRan]        = useState(false);
  const [employees,  setEmployees]  = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [deptList,   setDeptList]   = useState([]);

  const setF = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  useEffect(() => {
    Promise.all([
      api.get('/employees').catch(() => ({ data: [] })),
      api.get('/leaves/types', { params: { applicable: 1 } }).catch(() => ({ data: [] })),
      api.get('/admin/config/departments').catch(() => ({ data: [] })),
    ]).then(([empRes, ltRes, deptRes]) => {
      setEmployees(Array.isArray(empRes.data) ? empRes.data : []);
      setLeaveTypes(Array.isArray(ltRes.data) ? ltRes.data : []);
      setDeptList(Array.isArray(deptRes.data) ? deptRes.data.map(d => d.name || d) : []);
    });
  }, []);

  const loadReport = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // Each report accepts only its own filters (the server answers 400 to any
      // other, so sending Year to the Leave Summary made it fail every time).
      // Year/Month become a date range for the reports that take one.
      const allowed = REPORT_FILTERS[activeReport] || [];
      const params = {};
      const put = (k, v) => { if (v !== '' && v != null && allowed.includes(k)) params[k] = v; };
      put('year', filters.year); put('month', filters.month);
      put('department', filters.department); put('status', filters.status);
      put('employee_id', filters.employee_id);
      if (allowed.includes('start_date') && filters.year) {
        const y = Number(filters.year), m = Number(filters.month) || 0;
        const last = m ? new Date(y, m, 0).getDate() : 31;
        params.start_date = `${y}-${String(m || 1).padStart(2, '0')}-01`;
        params.end_date = `${y}-${String(m || 12).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
      }
      const r = await api.get(`/reports/leave${activeReport === 'leave' ? '' : `/${activeReport}`}`, { params });
      // The reports API answers { rows, total, … } — reading only a bare array
      // made every report show "No records" whatever the data.
      setData(Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.rows) ? r.data.rows : []));
      setTotal(Number(r.data?.total) || null);
      setRan(true);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Failed to load report');
    } finally { setLoading(false); }
  }, [activeReport, filters]);

  const activeConfig = REPORTS.find(r => r.id === activeReport);

  // Filters a report's API does not take (leave type everywhere; employee and
  // department on the summary reports) are applied to the rows it returned.
  const typeName = leaveTypes.find(t => String(t.id) === String(filters.leave_type_id))?.leave_name;
  const data = useMemo(() => rawData.filter(r =>
    (!typeName || !('leave_name' in r) || r.leave_name === typeName) &&
    (!filters.employee_id || !('employee_id' in r) || String(r.employee_id) === String(filters.employee_id)) &&
    (!filters.department || !('department' in r) || r.department === filters.department)
  ), [rawData, typeName, filters.employee_id, filters.department]);

  const COLUMNS = {
    leave: [
      {key:'employee_name',label:'Employee'}, {key:'department',label:'Dept'}, {key:'leave_name',label:'Leave Type'},
      {key:'start_date',label:'From',render:fmt}, {key:'end_date',label:'To',render:fmt},
      {key:'number_of_days',label:'Days'}, {key:'status',label:'Status',render:s=><span style={{...sc(s),padding:'2px 8px',borderRadius:12,fontSize:11,fontWeight:600}}>{s||'—'}</span>},
      {key:'reason',label:'Reason'},
    ],
    summary: [
      {key:'employee_name',label:'Employee'}, {key:'department',label:'Dept'}, {key:'leave_name',label:'Leave Type'},
      {key:'allocated_days',label:'Allocated'}, {key:'used_days',label:'Used'},
      {key:'remaining_days',label:'Remaining',render:v=><span style={{color:Number(v)===0?'#ef4444':'#10b981',fontWeight:600}}>{v}</span>},
      {key:'pending_count',label:'Pending'}, {key:'rejected_count',label:'Rejected'},
    ],
    liability: [
      {key:'employee_name',label:'Employee'}, {key:'department',label:'Dept'},
      {key:'leave_name',label:'Leave Type'}, {key:'balance_days',label:'Balance Days'},
      {key:'daily_rate',label:'Daily Rate',render:cur}, {key:'liability_amount',label:'Liability (₹)',render:cur},
    ],
    lop: [
      {key:'employee_name',label:'Employee'}, {key:'department',label:'Dept'},
      {key:'month',label:'Month'}, {key:'year',label:'Year'},
      {key:'working_days',label:'Working Days',render:v=>v ?? '—'}, {key:'present_days',label:'Present',render:v=>v ?? '—'},
      {key:'leave_lop_days',label:'From Leave'},
      {key:'lop_days',label:'LOP Days',render:v=><span style={{color:Number(v)>0?'#ef4444':'#10b981',fontWeight:600}}>{v}</span>},
      {key:'lop_amount',label:'LOP Deduction (₹)',render:cur},
      {key:'source',label:'Source',render:v=><span style={{fontSize:11,color:v==='payroll sync'?'#065f46':'#b45309'}}>{v}</span>},
    ],
    department: [
      {key:'department',label:'Department'}, {key:'total_employees',label:'Employees'},
      {key:'total_applications',label:'Applications'}, {key:'approved',label:'Approved'},
      {key:'rejected',label:'Rejected'}, {key:'pending',label:'Pending'},
      {key:'total_days_taken',label:'Days Taken'}, {key:'avg_days_per_employee',label:'Avg Days/Emp'},
    ],
    credits: [
      {key:'employee_name',label:'Employee'}, {key:'department',label:'Dept'}, {key:'leave_name',label:'Leave Type'},
      {key:'days_accrued',label:'Days Credited'},
      {key:'accrual_type',label:'How',render:v=>({monthly:'Monthly',yearly:'Yearly',joining_date:'Pro-rated (joining)',worked:'By days worked',carry_forward:'Carried forward'}[v]||v||'—')},
      {key:'month',label:'Month',render:(v)=>v ? MONTHS.find(m=>m.v===String(v))?.l : '—'}, {key:'year',label:'Year'},
      {key:'run_mode',label:'Run'}, {key:'run_by_name',label:'By'}, {key:'credited_at',label:'On',render:fmt},
    ],
    'carry-forward': [
      {key:'employee_name',label:'Employee'}, {key:'department',label:'Dept'}, {key:'leave_name',label:'Leave Type'},
      {key:'carried_forward_days',label:'Carried In'}, {key:'max_carry_forward_days',label:'Max Allowed'},
      {key:'expires_on',label:'Expires',render:v=>v ? fmt(v) : 'Never'},
    ],
    'approval-performance': [
      {key:'approver_name',label:'Approver'}, {key:'department',label:'Dept'},
      {key:'approval_level',label:'Level',render:v=>({1:'L1 Manager',2:'L2 Dept Head',3:'L3 HR',0:'System'}[v]||`L${v}`)},
      {key:'total_actions',label:'Total'}, {key:'approved_count',label:'Approved'},
      {key:'rejected_count',label:'Rejected'},
      {key:'avg_response_hours',label:'Avg Hours',render:v=><span style={{color:Number(v)>24?'#ef4444':Number(v)>8?'#7c5cf0':'#10b981',fontWeight:600}}>{v}h</span>},
    ],
  };

  const cols = COLUMNS[activeReport] || COLUMNS.leave;

  const totalRow = data.length > 0 && (activeReport === 'liability' || activeReport === 'lop') ? (
    <tr style={{ background:'#f0fdf4', fontWeight:700 }}>
      {cols.map((c,i) => (
        <td key={c.key} style={{ padding:'10px 12px', borderTop:'2px solid #bbf7d0' }}>
          {i === 0 ? `Total (${data.length})` :
           c.key === 'liability_amount' ? cur(data.reduce((s,r)=>s+Number(r.liability_amount||0),0)) :
           c.key === 'lop_amount' ? cur(data.reduce((s,r)=>s+Number(r.lop_amount||0),0)) :
           c.key === 'lop_days' ? data.reduce((s,r)=>s+Number(r.lop_days||0),0).toFixed(1) :
           c.key === 'number_of_days' ? data.reduce((s,r)=>s+Number(r.number_of_days||0),0) : ''}
        </td>
      ))}
    </tr>
  ) : null;

  return (
    <PageShell dock={
      <PageHero
        icon={BarChart3}
        eyebrow="Leave"
        title="Leave Reports"
        subtitle="Balances, liability, Loss of Pay, credits and approval speed — every single request is in All Leaves"
        actions={ran && data.length> 0 && (
          <div style={{ display:'flex', gap:8 }}>
            <button className="plh-cta" onClick={() => exportCSV(data, cols, `${activeReport}-report-${filters.year}.csv`)}>
              <Download size={14}/> CSV
            </button>
            <button className="plh-cta" onClick={() => exportXLSX(data, cols, `${activeReport}-report-${filters.year}.xlsx`)}>
              <FileSpreadsheet size={14}/> Excel
            </button>
          </div>
        )}
      />
    }>


      {/* Report type cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:10, marginBottom:20 }}>
        {REPORTS.map(r => (
          <button key={r.id} onClick={() => { setActiveReport(r.id); setData([]); setRan(false); }}
            style={{ padding:'12px 16px', borderRadius:10, border:`2px solid ${activeReport===r.id?r.color:'#e5e7eb'}`, background:activeReport===r.id?r.color+'15':'#fff', cursor:'pointer', textAlign:'left', transition:'all .15s' }}>
            <r.icon size={18} color={r.color} style={{ marginBottom:6 }}/>
            <div style={{ fontSize:12, fontWeight:700, color:activeReport===r.id?r.color:'#374151' }}>{r.label}</div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', padding:'16px 20px', marginBottom:20 }}>
        <div style={{ display:'flex', gap:12, alignItems:'flex-end', flexWrap:'wrap' }}>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280', display:'block', marginBottom:4, textTransform:'uppercase' }}>Year</label>
            <select value={filters.year} onChange={e => setF('year', e.target.value)}
              style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13 }}>
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          {shows(activeReport, 'month') && (
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#6b7280', display:'block', marginBottom:4, textTransform:'uppercase' }}>Month</label>
              <select value={filters.month} onChange={e => setF('month', e.target.value)}
                style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13 }}>
                {MONTHS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
              </select>
            </div>
          )}
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:'#6b7280', display:'block', marginBottom:4, textTransform:'uppercase' }}>Department</label>
            <select value={filters.department} onChange={e => setF('department', e.target.value)}
              style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, width:160, background:'#fff' }}>
              <option value="">All Departments</option>
              {deptList.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          {activeReport === 'leave' && (
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#6b7280', display:'block', marginBottom:4, textTransform:'uppercase' }}>Status</label>
              <select value={filters.status} onChange={e => setF('status', e.target.value)}
                style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13 }}>
                <option value="">All</option>
                <option value="approved">Approved</option>
                <option value="pending">Pending</option>
                <option value="rejected">Rejected</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
          )}
          {['leave','summary','liability','credits','carry-forward'].includes(activeReport) && employees.length > 0 && (
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#6b7280', display:'block', marginBottom:4, textTransform:'uppercase' }}>Employee</label>
              <select value={filters.employee_id} onChange={e => setF('employee_id', e.target.value)}
                style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, maxWidth:180 }}>
                <option value="">All Employees</option>
                {employees.map(e => (
                  <option key={e.id} value={e.id}>
                    {(e.name || `${e.first_name || ''} ${e.last_name || ''}`).trim()}
                  </option>
                ))}
              </select>
            </div>
          )}
          {['leave','summary','liability','credits','carry-forward'].includes(activeReport) && leaveTypes.length > 0 && (
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:'#6b7280', display:'block', marginBottom:4, textTransform:'uppercase' }}>Leave Type</label>
              <select value={filters.leave_type_id} onChange={e => setF('leave_type_id', e.target.value)}
                style={{ padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, maxWidth:180 }}>
                <option value="">All Types</option>
                {leaveTypes.map(lt => <option key={lt.id} value={lt.id}>{lt.leave_name}</option>)}
              </select>
            </div>
          )}
          <button onClick={loadReport} disabled={loading}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 20px', background:'#6366f1', color:'#fff', border:'none', borderRadius:8, fontWeight:600, fontSize:13, cursor:'pointer', opacity:loading?0.6:1 }}>
            <RefreshCw size={13} className={loading?'spinning':''}/> {loading ? 'Loading…' : 'Run Report'}
          </button>
        </div>
      </div>

      {/* Results */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', overflow:'auto' }}>
        {!ran ? (
          <div style={{ padding:60, textAlign:'center', color:'#9ca3af' }}>
            <activeConfig.icon size={40} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }}/>
            <p style={{ margin:0, fontSize:14 }}>Select filters and click <strong>Run Report</strong> to see data</p>
          </div>
        ) : error ? (
          <div style={{ padding:40, textAlign:'center', color:'#ef4444' }}>{error}</div>
        ) : data.length === 0 ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>No records match your criteria</div>
        ) : (
          <>
            <div style={{ padding:'12px 16px', borderBottom:'1px solid #f0f0f4', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <span style={{ fontSize:13, fontWeight:600, color:'#374151' }}>
                {data.length} record{data.length!==1?'s':''}
                {total > rawData.length && <span style={{ color:'#b45309', fontWeight:500 }}> — first {rawData.length} of {total}; narrow the filters</span>}
              </span>
              <span style={{ fontSize:12, color:'#9ca3af' }}>{activeConfig.label} · {filters.year}</span>
            </div>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead>
                <tr style={{ background:'#f9fafb' }}>
                  {cols.map(c => (
                    <th key={c.key} style={{ padding:'10px 12px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' }}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((row, i) => (
                  <tr key={i} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                    {cols.map(c => (
                      <td key={c.key} style={{ padding:'9px 12px', color:'#374151', whiteSpace:'nowrap', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis' }}>
                        {c.render ? c.render(row[c.key], row) : (row[c.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {totalRow && <tfoot>{totalRow}</tfoot>}
            </table>
          </>
        )}
      </div>
    </PageShell>
  );
}
