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
const monthName = v => (v ? MONTHS.find(m => m.v === String(v))?.l : '') || '—';

const fmt = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const cur = v => v != null ? `₹${Number(v).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—';
const num = v => v == null || v === '' ? '—' : String(Number(v));

const ACCRUAL = { monthly:'Monthly', yearly:'Yearly', joining_date:'Pro-rated (joining)', worked:'By days worked', carry_forward:'Carried forward', manual:'Set by HR' };
const RUN = { cron:'Automatic', catch_up:'Catch-up', manual:'Run by HR', 'set by HR':'Leave Settings' };
const LEVEL = { 1:'L1 Manager', 2:'L2 Dept Head', 3:'HR (final)' };

// The request-by-request "Leave Summary" report was removed 2026-11-24: it
// was the same list as Leaves → All Leaves (the register).
const REPORTS = [
  { id:'summary',      label:'Employee Balance Summary', icon:Users,       color:'#10b981',
    hint:'Per employee and leave type: allocated + carried forward − encashed − used = remaining. Pending days are not yet deducted.' },
  { id:'liability',    label:'Leave Liability (₹)',    icon:TrendingDown, color:'#7c5cf0',
    hint:'Unused encashable leave valued at Basic in force ÷ 26 — the rate an encashment claim pays.' },
  { id:'lop',          label:'LOP Report',             icon:BarChart2,   color:'#ef4444',
    hint:'Approved Loss of Pay leave, and the payroll figure once Attendance → Payroll Sync has run for the month.' },
  { id:'department',   label:'Department Summary',     icon:Award,       color:'#8b5cf6',
    hint:'Requests and days taken per department, by the month each leave starts.' },
  { id:'approval-performance', label:'Approval Performance', icon:Clock, color:'#0891b2',
    hint:'Approve / reject decisions per approver and step, timed from when the request reached that step.' },
  { id:'credits',      label:'Leave Credit History',   icon:PlusCircle,  color:'#059669',
    hint:'Every credit: automatic monthly / yearly / by days worked, carried forward, and days set by HR in Leave Settings.' },
  { id:'carry-forward', label:'Carried-Forward Leave', icon:CalendarClock, color:'#b45309',
    hint:'Days carried into the year and when they lapse.' },
];

// What each report's API accepts — mirrors backend reports/reportCatalog.js
// (any other parameter is a 400).
const SERVER_FILTERS = {
  summary: ['year', 'department'],
  liability: ['year'],
  lop: ['year', 'month'],
  department: ['year', 'month'],
  'approval-performance': ['start_date', 'end_date'],
  credits: ['year', 'department'],
  'carry-forward': ['year', 'department'],
};
// Controls shown per report. Those the API does not take are applied to the
// rows it returned (every such row carries the field).
const CONTROLS = {
  summary: ['year', 'department', 'employee', 'type'],
  liability: ['year', 'department', 'employee', 'type'],
  lop: ['year', 'month', 'department', 'employee'],
  department: ['year', 'month', 'department'],
  'approval-performance': ['year', 'month'],
  credits: ['year', 'department', 'employee', 'type'],
  'carry-forward': ['year', 'department', 'employee', 'type'],
};

const badge = (color, text) => <span style={{ color, fontWeight:600 }}>{text}</span>;

// text: plain value for the table AND the CSV/Excel file; cell: optional styling.
// total: summed in the footer row.
const COLUMNS = {
  summary: [
    {key:'employee_name',label:'Employee'}, {key:'department',label:'Dept'}, {key:'leave_name',label:'Leave Type'},
    {key:'allocated_days',label:'Allocated',text:num,total:true},
    {key:'carried_forward_days',label:'Carried Fwd',text:num,total:true},
    {key:'encashed_days',label:'Encashed',text:num,total:true},
    {key:'used_days',label:'Used',text:num,total:true},
    {key:'pending_days',label:'Pending Days',text:num,total:true},
    // Loss of Pay has no balance — "−1 remaining" read as an overdraft.
    {key:'remaining_days',label:'Remaining',text:(v,r)=>r.is_lop_type ? '—' : num(v),total:true,
      cell:(t,v,r)=>r.is_lop_type ? t : badge(Number(v)<=0?'#ef4444':'#10b981', t)},
    {key:'rejected_count',label:'Rejected',text:num,total:true},
  ],
  liability: [
    {key:'employee_name',label:'Employee'}, {key:'department',label:'Dept'},
    {key:'leave_name',label:'Leave Type'}, {key:'balance_days',label:'Balance Days',text:num,total:true},
    {key:'daily_rate',label:'Daily Rate',text:v=>v == null ? 'No salary on record' : cur(v),
      cell:(t,v)=>v == null ? badge('#b45309', t) : t},
    {key:'liability_amount',label:'Liability (₹)',text:cur,total:'cur'},
  ],
  lop: [
    {key:'employee_name',label:'Employee'}, {key:'department',label:'Dept'},
    {key:'month',label:'Month',text:monthName}, {key:'year',label:'Year'},
    {key:'working_days',label:'Working Days',text:num}, {key:'present_days',label:'Present',text:num},
    {key:'leave_lop_days',label:'From Leave',text:num,total:true},
    {key:'lop_days',label:'LOP Days',text:num,total:true,cell:(t,v)=>badge(Number(v)>0?'#ef4444':'#10b981', t)},
    {key:'lop_amount',label:'LOP Deduction (₹)',text:cur,total:'cur'},
    {key:'source',label:'Source',cell:(t,v)=><span style={{fontSize:11,color:v==='payroll sync'?'#065f46':'#b45309'}}>{t}</span>},
  ],
  department: [
    {key:'department',label:'Department'}, {key:'total_employees',label:'Employees',text:num,total:true},
    {key:'total_applications',label:'Applications',text:num,total:true}, {key:'approved',label:'Approved',text:num,total:true},
    {key:'rejected',label:'Rejected',text:num,total:true}, {key:'pending',label:'Pending',text:num,total:true},
    {key:'total_days_taken',label:'Days Taken',text:num,total:true}, {key:'avg_days_per_employee',label:'Avg Days/Emp',text:num},
  ],
  credits: [
    {key:'employee_name',label:'Employee'}, {key:'department',label:'Dept'}, {key:'leave_name',label:'Leave Type'},
    {key:'days_accrued',label:'Days Credited',text:num,total:true},
    {key:'accrual_type',label:'How',text:v=>ACCRUAL[v]||v||'—'},
    {key:'month',label:'Month',text:monthName}, {key:'year',label:'Year'},
    {key:'run_mode',label:'Run',text:v=>RUN[v]||v||'—'}, {key:'run_by_name',label:'By'},
    {key:'credited_at',label:'On',text:fmt},
  ],
  'carry-forward': [
    {key:'employee_name',label:'Employee'}, {key:'department',label:'Dept'}, {key:'leave_name',label:'Leave Type'},
    {key:'carried_forward_days',label:'Carried In',text:num,total:true},
    {key:'max_carry_forward_days',label:'Max Allowed',text:num},
    {key:'expires_on',label:'Expires',text:v=>v ? fmt(v) : 'Never'},
  ],
  'approval-performance': [
    {key:'approver_name',label:'Approver'}, {key:'department',label:'Approver Dept'},
    {key:'approval_level',label:'Step',text:v=>LEVEL[v]||`Level ${v}`},
    {key:'total_actions',label:'Decisions',text:num,total:true}, {key:'approved_count',label:'Approved',text:num,total:true},
    {key:'rejected_count',label:'Rejected',text:num,total:true},
    {key:'avg_response_hours',label:'Avg Hours',text:v=>v == null ? '—' : `${v}h`,
      cell:(t,v)=>badge(Number(v)>24?'#ef4444':Number(v)>8?'#7c5cf0':'#10b981', t)},
    {key:'max_response_hours',label:'Slowest',text:v=>v == null ? '—' : `${v}h`},
  ],
};

const textOf = (c, row) => {
  const v = row[c.key];
  if (c.text) return c.text(v, row);
  return v == null || v === '' ? '—' : String(v);
};

// Exports carry what the table shows ("Set by HR", "L1 Manager"), not codes.
const asExportRows = (rows, cols) => rows.map(r => Object.fromEntries(cols.map(c => [c.key, textOf(c, r)])));

const exportCSV = (rows, cols, filename) =>
  downloadCsv(filename, cols.map(c => ({ label: c.label, key: c.key })), asExportRows(rows, cols));

async function exportXLSX(rows, cols, filename) {
  try {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([
      cols.map(c => c.label),
      ...asExportRows(rows, cols).map(r => cols.map(c => {
        const t = r[c.key];
        // numbers stay numbers so the sheet can add them up
        return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : (t === '—' ? '' : t);
      })),
    ]);
    ws['!cols'] = cols.map(c => ({ wch: Math.max(c.label.length, 12) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leave Report');
    XLSX.writeFile(wb, filename);
  } catch {
    exportCSV(rows, cols, filename.replace(/\.xlsx$/, '.csv'));
  }
}

const label = { fontSize:11, fontWeight:600, color:'#6b7280', display:'block', marginBottom:4, textTransform:'uppercase' };
const select = { padding:'7px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, background:'#fff' };

export default function LeaveReports() {
  const [activeReport, setActiveReport] = useState('summary');
  const [filters, setFilters] = useState({ year:String(YEAR), month:'', department:'', employee_id:'', leave_type_id:'' });
  const [rawData,    setData]       = useState([]);
  const [total,      setTotal]      = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [ranFor,     setRanFor]     = useState(null);
  const [employees,  setEmployees]  = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [deptList,   setDeptList]   = useState([]);

  const setF = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const has = c => (CONTROLS[activeReport] || []).includes(c);

  useEffect(() => {
    Promise.all([
      api.get('/employees').catch(() => ({ data: [] })),
      // include_inactive: credit history and older years still name switched-off types
      api.get('/leaves/types', { params: { include_inactive: 1 } }).catch(() => ({ data: [] })),
      api.get('/admin/config/departments').catch(() => ({ data: [] })),
    ]).then(([empRes, ltRes, deptRes]) => {
      setEmployees(Array.isArray(empRes.data) ? empRes.data : []);
      setLeaveTypes(Array.isArray(ltRes.data) ? ltRes.data : []);
      setDeptList(Array.isArray(deptRes.data) ? deptRes.data.map(d => d.name || d).filter(Boolean) : []);
    });
  }, []);

  // Server-side parameters only; a change to them re-runs the report.
  const serverParams = useMemo(() => {
    const allowed = SERVER_FILTERS[activeReport] || [];
    const p = {};
    if (allowed.includes('year') && filters.year) p.year = filters.year;
    if (allowed.includes('month') && filters.month) p.month = filters.month;
    if (allowed.includes('department') && filters.department) p.department = filters.department;
    if (allowed.includes('start_date') && filters.year) {
      const y = Number(filters.year), m = Number(filters.month) || 0;
      const last = m ? new Date(y, m, 0).getDate() : 31;
      p.start_date = `${y}-${String(m || 1).padStart(2, '0')}-01`;
      p.end_date = `${y}-${String(m || 12).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    }
    return p;
  }, [activeReport, filters.year, filters.month, filters.department]);

  const loadReport = useCallback(async (signal) => {
    setLoading(true); setError(null);
    try {
      const r = await api.get(`/reports/leave/${activeReport}`, { params: serverParams, signal });
      setData(Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.rows) ? r.data.rows : []));
      setTotal(Number(r.data?.total) || null);
      setRanFor(activeReport);
    } catch (e) {
      if (e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED') return;
      setData([]); setRanFor(activeReport);
      setError(e?.response?.status === 403
        ? 'You do not have access to this report.'
        : (e?.response?.data?.error || e.message || 'Failed to load report'));
    } finally { setLoading(false); }
  }, [activeReport, serverParams]);

  // Live: runs on opening, on choosing a report and on every filter change.
  useEffect(() => {
    const ctl = new AbortController();
    loadReport(ctl.signal);
    return () => ctl.abort();
  }, [loadReport]);

  const activeConfig = REPORTS.find(r => r.id === activeReport);
  const cols = COLUMNS[activeReport];

  const typeName = leaveTypes.find(t => String(t.id) === String(filters.leave_type_id))?.leave_name;
  const data = useMemo(() => (ranFor === activeReport ? rawData : []).filter(r =>
    (!has('type') || !typeName || r.leave_name === typeName) &&
    (!has('employee') || !filters.employee_id || String(r.employee_id) === String(filters.employee_id)) &&
    (!has('department') || !filters.department || r.department === filters.department)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [rawData, ranFor, activeReport, typeName, filters.employee_id, filters.department]);

  // Departments in the master plus any an employee record still carries.
  const departments = useMemo(() => {
    const s = new Set(deptList);
    rawData.forEach(r => r.department && s.add(r.department));
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [deptList, rawData]);

  const pickReport = id => {
    if (id === activeReport) return;
    setActiveReport(id); setData([]); setRanFor(null); setError(null);
  };

  const fileBase = `leave-${activeReport}-${filters.year}${filters.month && has('month') ? `-${filters.month.padStart(2, '0')}` : ''}`;
  const truncated = total > rawData.length;

  const totalRow = data.length > 0 && cols.some(c => c.total) ? (
    <tr style={{ background:'#f0fdf4', fontWeight:700 }}>
      {cols.map((c, i) => {
        let v = '';
        if (i === 0) v = `Total (${data.length})`;
        else if (c.total) {
          const sum = data.reduce((s, r) => s + (c.key === 'remaining_days' && r.is_lop_type ? 0 : Number(r[c.key] || 0)), 0);
          v = c.total === 'cur' ? cur(sum) : String(Math.round(sum * 100) / 100);
        }
        return <td key={c.key} style={{ padding:'10px 12px', borderTop:'2px solid #bbf7d0', whiteSpace:'nowrap' }}>{v}</td>;
      })}
    </tr>
  ) : null;

  const clearable = filters.department || filters.employee_id || filters.leave_type_id || filters.month;

  return (
    <PageShell dock={
      <PageHero
        icon={BarChart3}
        eyebrow="Leave"
        title="Leave Reports"
        subtitle="Balances, liability, Loss of Pay, credits and approval speed — every single request is in All Leaves"
        actions={data.length > 0 && (
          <div style={{ display:'flex', gap:8 }}>
            <button className="plh-cta" onClick={() => exportCSV(data, cols, `${fileBase}.csv`)}>
              <Download size={14}/> CSV
            </button>
            <button className="plh-cta" onClick={() => exportXLSX(data, cols, `${fileBase}.xlsx`)}>
              <FileSpreadsheet size={14}/> Excel
            </button>
          </div>
        )}
      />
    }>

      {/* Report type cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:10, marginBottom:20 }}>
        {REPORTS.map(r => (
          <button key={r.id} onClick={() => pickReport(r.id)} aria-pressed={activeReport === r.id}
            style={{ padding:'12px 16px', borderRadius:10, border:`2px solid ${activeReport===r.id?r.color:'#e5e7eb'}`, background:activeReport===r.id?r.color+'15':'#fff', cursor:'pointer', textAlign:'left', transition:'all .15s' }}>
            <r.icon size={18} color={r.color} style={{ marginBottom:6 }}/>
            <div style={{ fontSize:12, fontWeight:700, color:activeReport===r.id?r.color:'#374151' }}>{r.label}</div>
          </button>
        ))}
      </div>

      {/* Filters — every change re-runs the report */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', padding:'16px 20px', marginBottom:20 }}>
        <div style={{ display:'flex', gap:12, alignItems:'flex-end', flexWrap:'wrap' }}>
          <div>
            <label style={label} htmlFor="lr-year">Year</label>
            <select id="lr-year" value={filters.year} onChange={e => setF('year', e.target.value)} style={select}>
              {YEARS.map(y => <option key={y} value={String(y)}>{y}</option>)}
            </select>
          </div>
          {has('month') && (
            <div>
              <label style={label} htmlFor="lr-month">Month</label>
              <select id="lr-month" value={filters.month} onChange={e => setF('month', e.target.value)} style={select}>
                {MONTHS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
              </select>
            </div>
          )}
          {has('department') && (
            <div>
              <label style={label} htmlFor="lr-dept">Department</label>
              <select id="lr-dept" value={filters.department} onChange={e => setF('department', e.target.value)} style={{ ...select, width:160 }}>
                <option value="">All Departments</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          )}
          {has('employee') && employees.length > 0 && (
            <div>
              <label style={label} htmlFor="lr-emp">Employee</label>
              <select id="lr-emp" value={filters.employee_id} onChange={e => setF('employee_id', e.target.value)} style={{ ...select, maxWidth:200 }}>
                <option value="">All Employees</option>
                {employees.map(e => (
                  <option key={e.id} value={e.id}>
                    {(e.name || `${e.first_name || ''} ${e.last_name || ''}`).trim()}{e.office_id ? ` (${e.office_id})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {has('type') && leaveTypes.length > 0 && (
            <div>
              <label style={label} htmlFor="lr-type">Leave Type</label>
              <select id="lr-type" value={filters.leave_type_id} onChange={e => setF('leave_type_id', e.target.value)} style={{ ...select, maxWidth:180 }}>
                <option value="">All Types</option>
                {leaveTypes.map(lt => <option key={lt.id} value={lt.id}>{lt.leave_name}{lt.is_active === false ? ' (off)' : ''}</option>)}
              </select>
            </div>
          )}
          {clearable && (
            <button onClick={() => setFilters(f => ({ ...f, month:'', department:'', employee_id:'', leave_type_id:'' }))}
              style={{ padding:'8px 14px', background:'#fff', color:'#374151', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, cursor:'pointer' }}>
              Clear filters
            </button>
          )}
          <button onClick={() => loadReport()} disabled={loading}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', background:'var(--color-primary, #6B3FDB)', color:'#fff', border:'none', borderRadius:8, fontWeight:600, fontSize:13, cursor:'pointer', opacity:loading?0.6:1, marginLeft:'auto' }}>
            <RefreshCw size={13} className={loading?'spinning':''}/> {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        <p style={{ margin:'10px 0 0', fontSize:12, color:'#6b7280' }}>{activeConfig.hint}</p>
      </div>

      {/* Results */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', overflow:'auto' }}>
        {loading && ranFor !== activeReport ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading…</div>
        ) : error ? (
          <div style={{ padding:40, textAlign:'center', color:'#ef4444' }}>{error}</div>
        ) : data.length === 0 ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>
            <activeConfig.icon size={36} color="#d1d5db" style={{ display:'block', margin:'0 auto 10px' }}/>
            No records for these filters
          </div>
        ) : (
          <>
            <div style={{ padding:'12px 16px', borderBottom:'1px solid #f0f0f4', display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap' }}>
              <span style={{ fontSize:13, fontWeight:600, color:'#374151' }}>
                {data.length} record{data.length!==1?'s':''}
                {truncated && <span style={{ color:'#b45309', fontWeight:500 }}> — first {rawData.length} of {total}; narrow the filters</span>}
              </span>
              <span style={{ fontSize:12, color:'#9ca3af' }}>
                {activeConfig.label} · {has('month') && filters.month ? `${monthName(filters.month)} ` : ''}{filters.year}
              </span>
            </div>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12, opacity: loading ? 0.5 : 1 }}>
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
                    {cols.map(c => {
                      const t = textOf(c, row);
                      return (
                        <td key={c.key} title={t} style={{ padding:'9px 12px', color:'#374151', whiteSpace:'nowrap', maxWidth:220, overflow:'hidden', textOverflow:'ellipsis' }}>
                          {c.cell ? c.cell(t, row[c.key], row) : t}
                        </td>
                      );
                    })}
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
