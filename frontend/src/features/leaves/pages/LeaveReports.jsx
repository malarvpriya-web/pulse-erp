import { useState, useCallback, useEffect } from 'react';
import { Download, RefreshCw, BarChart2, FileText, TrendingDown, Users, Clock, Award, FileSpreadsheet } from 'lucide-react';
import api from '@/services/api/client';

const YEAR  = new Date().getFullYear();
const YEARS = [YEAR - 2, YEAR - 1, YEAR, YEAR + 1];
const MONTHS = [
  {v:'',l:'All Months'},{v:'1',l:'January'},{v:'2',l:'February'},{v:'3',l:'March'},
  {v:'4',l:'April'},{v:'5',l:'May'},{v:'6',l:'June'},{v:'7',l:'July'},
  {v:'8',l:'August'},{v:'9',l:'September'},{v:'10',l:'October'},
  {v:'11',l:'November'},{v:'12',l:'December'},
];

const fmt = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const cur  = v => v != null ? `₹${Number(v).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—';

function exportCSV(rows, columns, filename) {
  const header = columns.map(c => c.label).join(',');
  const body   = rows.map(r => columns.map(c => {
    const v = r[c.key];
    return typeof v === 'string' && v.includes(',') ? `"${v}"` : (v ?? '');
  }).join(',')).join('\n');
  const blob = new Blob([header + '\n' + body], { type:'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

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

const STATUS_COLORS = { approved:{bg:'#d1fae5',color:'#065f46'}, rejected:{bg:'#fee2e2',color:'#991b1b'}, pending:{bg:'#fef3c7',color:'#92400e'} };
const sc = s => STATUS_COLORS[(s||'').toLowerCase()] || STATUS_COLORS.pending;

const REPORTS = [
  { id:'leave',        label:'Leave Summary',          icon:FileText,    color:'#6366f1' },
  { id:'summary',      label:'Employee Balance Summary',icon:Users,       color:'#10b981' },
  { id:'liability',    label:'Leave Liability (₹)',    icon:TrendingDown, color:'#f59e0b' },
  { id:'lop',          label:'LOP Report',             icon:BarChart2,   color:'#ef4444' },
  { id:'department',   label:'Department Summary',      icon:Award,       color:'#8b5cf6' },
  { id:'approval-performance', label:'Approval Performance', icon:Clock, color:'#0891b2' },
];

export default function LeaveReports() {
  const [activeReport, setActiveReport] = useState('leave');
  const [filters, setFilters] = useState({ year:YEAR, month:'', department:'', status:'', employee_id:'', leave_type_id:'' });
  const [data,       setData]       = useState([]);
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
      const params = {};
      if (filters.year)          params.year          = filters.year;
      if (filters.month)         params.month         = filters.month;
      if (filters.department)    params.department    = filters.department;
      if (filters.status)        params.status        = filters.status;
      if (filters.employee_id)   params.employee_id   = filters.employee_id;
      if (filters.leave_type_id) params.leave_type_id = filters.leave_type_id;
      if (filters.start_date)    params.start_date    = filters.start_date;
      if (filters.end_date)      params.end_date      = filters.end_date;
      const r = await api.get(`/reports/leave${activeReport === 'leave' ? '' : `/${activeReport}`}`, { params });
      setData(Array.isArray(r.data) ? r.data : []);
      setRan(true);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Failed to load report');
    } finally { setLoading(false); }
  }, [activeReport, filters]);

  const activeConfig = REPORTS.find(r => r.id === activeReport);

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
      {key:'working_days',label:'Working Days'}, {key:'present_days',label:'Present'},
      {key:'lop_days',label:'LOP Days',render:v=><span style={{color:Number(v)>0?'#ef4444':'#10b981',fontWeight:600}}>{v}</span>},
      {key:'lop_amount',label:'LOP Deduction (₹)',render:cur},
    ],
    department: [
      {key:'department',label:'Department'}, {key:'total_employees',label:'Employees'},
      {key:'total_applications',label:'Applications'}, {key:'approved',label:'Approved'},
      {key:'rejected',label:'Rejected'}, {key:'pending',label:'Pending'},
      {key:'total_days_taken',label:'Days Taken'}, {key:'avg_days_per_employee',label:'Avg Days/Emp'},
    ],
    'approval-performance': [
      {key:'approver_name',label:'Approver'}, {key:'department',label:'Dept'},
      {key:'approval_level',label:'Level',render:v=>({1:'L1 Manager',2:'L2 Dept Head',3:'L3 HR',0:'System'}[v]||`L${v}`)},
      {key:'total_actions',label:'Total'}, {key:'approved_count',label:'Approved'},
      {key:'rejected_count',label:'Rejected'},
      {key:'avg_response_hours',label:'Avg Hours',render:v=><span style={{color:Number(v)>24?'#ef4444':Number(v)>8?'#f59e0b':'#10b981',fontWeight:600}}>{v}h</span>},
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
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ marginBottom:20, display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Leave Reports</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Comprehensive leave analytics and compliance reports</p>
        </div>
        {ran && data.length > 0 && (
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => exportCSV(data, cols, `${activeReport}-report-${filters.year}.csv`)}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', background:'#10b981', color:'#fff', border:'none', borderRadius:8, fontWeight:600, fontSize:13, cursor:'pointer' }}>
              <Download size={14}/> CSV
            </button>
            <button onClick={() => exportXLSX(data, cols, `${activeReport}-report-${filters.year}.xlsx`)}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', background:'#6366f1', color:'#fff', border:'none', borderRadius:8, fontWeight:600, fontSize:13, cursor:'pointer' }}>
              <FileSpreadsheet size={14}/> Excel
            </button>
          </div>
        )}
      </div>

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
          {['department','lop','leave','summary'].includes(activeReport) && (
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
              </select>
            </div>
          )}
          {['leave','summary','liability','lop'].includes(activeReport) && employees.length > 0 && (
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
          {['leave','summary','liability'].includes(activeReport) && leaveTypes.length > 0 && (
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
              <span style={{ fontSize:13, fontWeight:600, color:'#374151' }}>{data.length} record{data.length!==1?'s':''}</span>
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
    </div>
  );
}
