import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer
} from 'recharts';
import {
  DollarSign, Users, Download, Eye, Plus, X, CheckCircle,
  AlertCircle, FileText, TrendingUp, TrendingDown, RefreshCw,
  Search, Calendar, Printer, Clock
} from 'lucide-react';
import api from '@/services/api/client';
import './Payroll.css';

// ── Sample data ──────────────────────────────────────────────────────────────
const SAMPLE_LIST = [
  { id:1, employee_id:'EMP001', name:'Arjun Sharma',  department:'Engineering', designation:'Sr. Developer',   month:'February 2026', basic:45000, hra:18000, allowances:8000, gross:71000, pf:5400, esi:532,  tds:4200, total_deductions:10132, net_pay:60868, status:'paid',       paid_on:'28 Feb 2026' },
  { id:2, employee_id:'EMP002', name:'Priya Menon',   department:'Design',      designation:'UI Designer',     month:'February 2026', basic:38000, hra:15200, allowances:6000, gross:59200, pf:4560, esi:444,  tds:2800, total_deductions:7804,  net_pay:51396, status:'paid',       paid_on:'28 Feb 2026' },
  { id:3, employee_id:'EMP003', name:'Rahul Kumar',   department:'Engineering', designation:'Developer',       month:'February 2026', basic:32000, hra:12800, allowances:5000, gross:49800, pf:3840, esi:374,  tds:1800, total_deductions:6014,  net_pay:43786, status:'paid',       paid_on:'28 Feb 2026' },
  { id:4, employee_id:'EMP004', name:'Sneha Pillai',  department:'QA',          designation:'QA Engineer',     month:'February 2026', basic:28000, hra:11200, allowances:4500, gross:43700, pf:3360, esi:328,  tds:1200, total_deductions:4888,  net_pay:38812, status:'pending',    paid_on:null },
  { id:5, employee_id:'EMP005', name:'Vikram Singh',  department:'Engineering', designation:'Backend Dev',     month:'February 2026', basic:35000, hra:14000, allowances:5500, gross:54500, pf:4200, esi:409,  tds:2200, total_deductions:6809,  net_pay:47691, status:'pending',    paid_on:null },
  { id:6, employee_id:'EMP006', name:'Divya Nair',    department:'HR',          designation:'HR Executive',    month:'February 2026', basic:30000, hra:12000, allowances:4000, gross:46000, pf:3600, esi:345,  tds:1500, total_deductions:5445,  net_pay:40555, status:'processing', paid_on:null },
  { id:7, employee_id:'EMP007', name:'Karan Mehta',   department:'Finance',     designation:'Finance Analyst', month:'February 2026', basic:40000, hra:16000, allowances:7000, gross:63000, pf:4800, esi:473,  tds:3200, total_deductions:8473,  net_pay:54527, status:'paid',       paid_on:'28 Feb 2026' },
  { id:8, employee_id:'EMP008', name:'Ananya Iyer',   department:'Marketing',   designation:'Marketing Exec',  month:'February 2026', basic:26000, hra:10400, allowances:3500, gross:39900, pf:3120, esi:299,  tds:900,  total_deductions:4319,  net_pay:35581, status:'on_hold',    paid_on:null },
];

const SAMPLE_SUMMARY = { total_employees:24, total_gross:1248000, total_net:1089450, total_deductions:158550, paid_count:18, pending_count:4, processing_count:2 };

const SAMPLE_TREND = [
  { month:'Sep', gross:1180000, net:1030000 },
  { month:'Oct', gross:1195000, net:1042000 },
  { month:'Nov', gross:1210000, net:1055000 },
  { month:'Dec', gross:1235000, net:1078000 },
  { month:'Jan', gross:1240000, net:1082000 },
  { month:'Feb', gross:1248000, net:1089450 },
];

const MONTHS = ['April 2025','May 2025','June 2025','July 2025','August 2025','September 2025','October 2025','November 2025','December 2025','January 2026','February 2026','March 2026'];

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtRupee = (n) => {
  if (n >= 100000) return `₹${(n/100000).toFixed(1)}L`;
  if (n >= 1000)   return `₹${(n/1000).toFixed(0)}K`;
  return `₹${n}`;
};
const fmtN = (n) => Number(n||0).toLocaleString('en-IN');

// ── Toast ─────────────────────────────────────────────────────────────────────
const Toast = ({ toast, onClose }) => {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className={`py-toast ${toast.type === 'error' ? 'py-toast-error' : 'py-toast-success'}`}>
      {toast.type === 'error' ? <AlertCircle size={16}/> : <CheckCircle size={16}/>}
      <span>{toast.message}</span>
      <button onClick={onClose} style={{marginLeft:'auto',background:'none',border:'none',cursor:'pointer'}}><X size={14}/></button>
    </div>
  );
};

// ── Status badge ──────────────────────────────────────────────────────────────
const StatusBadge = ({ status }) => {
  const map = {
    paid:       'py-badge-paid',
    pending:    'py-badge-pending',
    processing: 'py-badge-processing',
    on_hold:    'py-badge-on_hold',
  };
  return <span className={`py-badge ${map[status] || 'py-badge-pending'}`}>{status.replace('_',' ')}</span>;
};

// ── Payslip Drawer ────────────────────────────────────────────────────────────
const PayslipDrawer = ({ slip, onClose, onDownload, onPrint }) => {
  if (!slip) return null;
  return (
    <>
      <div className="py-overlay" onClick={onClose}/>
      <div className="py-drawer">
        <div className="py-drawer-hd">
          <span className="py-drawer-title">Salary Slip</span>
          <button className="py-icon-btn" onClick={onClose}><X size={16}/></button>
        </div>
        <div className="py-drawer-body">
          {/* Header card */}
          <div className="py-slip-header">
            <p className="py-slip-title">SALARY SLIP</p>
            <p className="py-slip-name">{slip.name}</p>
            <p className="py-slip-meta">{slip.designation} · {slip.department}</p>
            <p className="py-slip-meta">{slip.employee_id} · {slip.month}</p>
          </div>

          {/* Earnings */}
          <span className="py-slip-section-hd">Earnings</span>
          <table className="py-slip-table">
            <tbody>
              <tr><td>Basic Salary</td><td>₹{fmtN(slip.basic)}</td></tr>
              <tr><td>House Rent Allowance (HRA)</td><td>₹{fmtN(slip.hra)}</td></tr>
              <tr><td>Other Allowances</td><td>₹{fmtN(slip.allowances)}</td></tr>
              <tr className="py-slip-total-row"><td><strong>Gross Earnings</strong></td><td><strong>₹{fmtN(slip.gross)}</strong></td></tr>
            </tbody>
          </table>

          {/* Deductions */}
          <span className="py-slip-section-hd">Deductions</span>
          <table className="py-slip-table">
            <tbody>
              <tr><td>Provident Fund (PF 12%)</td><td style={{color:'#ef4444'}}>₹{fmtN(slip.pf)}</td></tr>
              <tr><td>ESI (0.75%)</td><td style={{color:'#ef4444'}}>₹{fmtN(slip.esi)}</td></tr>
              <tr><td>Income Tax (TDS)</td><td style={{color:'#ef4444'}}>₹{fmtN(slip.tds)}</td></tr>
              <tr className="py-slip-total-row"><td><strong>Total Deductions</strong></td><td><strong style={{color:'#ef4444'}}>₹{fmtN(slip.total_deductions)}</strong></td></tr>
            </tbody>
          </table>

          {/* Net Pay */}
          <div className="py-net-pay-box">
            <p className="py-net-pay-label">NET PAY</p>
            <p className="py-net-pay-val">₹{fmtN(slip.net_pay)}</p>
          </div>

          {/* Status */}
          <div style={{textAlign:'center',marginTop:8}}>
            <StatusBadge status={slip.status}/>
            {slip.paid_on && <p style={{fontSize:12,color:'#6b7280',marginTop:6}}>Paid on {slip.paid_on}</p>}
          </div>
        </div>
        <div className="py-drawer-footer">
          <button className="py-btn-ghost" onClick={onPrint}><Printer size={14}/> Print</button>
          <button className="py-btn-primary" onClick={onDownload}><Download size={14}/> Download</button>
        </div>
      </div>
    </>
  );
};

// ── Generate Payroll Drawer ───────────────────────────────────────────────────
const GenerateDrawer = ({ open, onClose, onSubmit }) => {
  const [form, setForm] = useState({ month:'February 2026', department:'All', notes:'' });
  if (!open) return null;
  return (
    <>
      <div className="py-overlay" onClick={onClose}/>
      <div className="py-drawer py-drawer-sm">
        <div className="py-drawer-hd">
          <span className="py-drawer-title">Generate Payroll</span>
          <button className="py-icon-btn" onClick={onClose}><X size={16}/></button>
        </div>
        <div className="py-drawer-body">
          <div className="py-warning">
            <AlertCircle size={16} style={{flexShrink:0,marginTop:1}}/>
            <span>This will process payroll for all active employees in the selected department for the chosen month.</span>
          </div>
          <div className="py-form-group">
            <label className="py-label">Payroll Month</label>
            <select className="py-select" value={form.month} onChange={e=>setForm({...form,month:e.target.value})}>
              {MONTHS.map(m=><option key={m}>{m}</option>)}
            </select>
          </div>
          <div className="py-form-group">
            <label className="py-label">Department</label>
            <select className="py-select" value={form.department} onChange={e=>setForm({...form,department:e.target.value})}>
              {['All','Engineering','Design','QA','HR','Finance','Marketing'].map(d=><option key={d}>{d}</option>)}
            </select>
          </div>
          <div className="py-form-group">
            <label className="py-label">Notes (optional)</label>
            <textarea className="py-textarea" rows={3} placeholder="Any special instructions…" value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/>
          </div>
        </div>
        <div className="py-drawer-footer">
          <button className="py-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="py-btn-primary" onClick={()=>onSubmit(form)}>Generate Payroll</button>
        </div>
      </div>
    </>
  );
};

// ── Custom tooltip ─────────────────────────────────────────────────────────────
const TrendTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{background:'#fff',border:'1px solid #f0f0f4',borderRadius:8,padding:'10px 14px',fontSize:12,boxShadow:'0 2px 8px rgba(0,0,0,0.08)'}}>
      <p style={{fontWeight:600,color:'#111827',marginBottom:4}}>{label}</p>
      {payload.map(p=>(
        <p key={p.dataKey} style={{color:p.color,margin:'2px 0'}}>{p.dataKey==='gross'?'Gross':'Net'}: {fmtRupee(p.value)}</p>
      ))}
    </div>
  );
};

// ── Main Component ────────────────────────────────────────────────────────────
export default function Payroll({ setPage }) {
  const [payrollList, setPayrollList]   = useState(SAMPLE_LIST);
  const [summary, setSummary]           = useState(SAMPLE_SUMMARY);
  const [trend, setTrend]               = useState(SAMPLE_TREND);
  const [selectedMonth, setSelectedMonth] = useState('February 2026');
  const [searchTerm, setSearchTerm]     = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSlip, setSelectedSlip] = useState(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [loading, setLoading]           = useState(false);
  const [toast, setToast]               = useState(null);

  const showToast = useCallback((message, type='success') => setToast({ message, type }), []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, sumRes, trendRes] = await Promise.allSettled([
        api.get(`/payroll?month=${encodeURIComponent(selectedMonth)}`),
        api.get('/payroll/summary'),
        api.get('/payroll/trend'),
      ]);
      if (listRes.status==='fulfilled'  && listRes.value.data?.length)  setPayrollList(listRes.value.data);
      if (sumRes.status==='fulfilled'   && sumRes.value.data)            setSummary(sumRes.value.data);
      if (trendRes.status==='fulfilled' && trendRes.value.data?.length)  setTrend(trendRes.value.data);
    } catch { /* fall back to sample data */ }
    finally { setLoading(false); }
  }, [selectedMonth]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleGenerate = async (form) => {
    try { await api.post('/payroll/generate', form); } catch { /* proceed */ }
    setShowGenerate(false);
    showToast(`Payroll generation initiated for ${form.month} — ${form.department}`);
  };

  const filtered = payrollList.filter(e => {
    const matchSearch = !searchTerm ||
      e.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.department.toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.employee_id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchStatus = statusFilter === 'all' || e.status === statusFilter;
    return matchSearch && matchStatus;
  });

  return (
    <div className="py-root">
      <Toast toast={toast} onClose={() => setToast(null)}/>
      <PayslipDrawer
        slip={selectedSlip}
        onClose={() => setSelectedSlip(null)}
        onDownload={() => showToast(`Downloading payslip for ${selectedSlip?.name}…`)}
        onPrint={() => showToast('Preparing print preview…')}
      />
      <GenerateDrawer open={showGenerate} onClose={() => setShowGenerate(false)} onSubmit={handleGenerate}/>

      {/* Header */}
      <div className="py-header">
        <div>
          <h1 className="py-title">Payroll Management</h1>
          <p style={{fontSize:13,color:'#6b7280',margin:'4px 0 0'}}>
            {new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}
          </p>
        </div>
        <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
          {/* Month pills */}
          <div className="py-month-pills">
            {['January 2026','February 2026','March 2026'].map(m => (
              <button key={m} className={`py-month-pill${selectedMonth===m?' active':''}`} onClick={() => setSelectedMonth(m)}>
                {m.split(' ')[0]}
              </button>
            ))}
          </div>
          <button className="py-btn-generate" onClick={() => setShowGenerate(true)}>
            <Plus size={14}/> Generate Payroll
          </button>
          <button className="py-icon-btn" onClick={loadData} title="Refresh">
            <RefreshCw size={14} className={loading ? 'py-spin' : ''}/>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="py-kpis">
        {[
          { icon: Users,        label: 'Total Employees',   value: summary.total_employees, sub: 'On payroll',         color: '#6366f1' },
          { icon: TrendingUp,   label: 'Total Gross',       value: fmtRupee(summary.total_gross), sub: selectedMonth,  color: '#10b981' },
          { icon: DollarSign,   label: 'Total Net Pay',     value: fmtRupee(summary.total_net), sub: 'After deductions',color: '#3b82f6' },
          { icon: TrendingDown, label: 'Total Deductions',  value: fmtRupee(summary.total_deductions), sub: 'PF + ESI + TDS', color: '#f59e0b' },
        ].map((k, i) => (
          <div key={i} className="py-kpi">
            <div className="py-kpi-icon" style={{background:k.color+'18',color:k.color}}><k.icon size={20}/></div>
            <div>
              <p className="py-kpi-label">{k.label}</p>
              <p className="py-kpi-val">{k.value}</p>
              <p className="py-kpi-sub">{k.sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Status chips */}
      <div className="py-status-chips">
        <span className="py-chip py-chip-paid"><CheckCircle size={12}/> {summary.paid_count} Paid</span>
        <span className="py-chip py-chip-pending"><Clock size={12}/> {summary.pending_count} Pending</span>
        <span className="py-chip py-chip-processing"><RefreshCw size={12}/> {summary.processing_count} Processing</span>
      </div>

      {/* Trend Chart */}
      <div className="py-card">
        <div className="py-card-hd">
          <span className="py-card-title"><TrendingUp size={14} style={{marginRight:6,verticalAlign:'middle',color:'#6366f1'}}/> Monthly Payroll Trend</span>
          <span style={{fontSize:12,color:'#9ca3af'}}>Last 6 months</span>
        </div>
        <div className="py-card-body">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={trend} margin={{top:5,right:20,left:0,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" vertical={false}/>
              <XAxis dataKey="month" tick={{fontSize:11,fill:'#9ca3af'}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fontSize:11,fill:'#9ca3af'}} axisLine={false} tickLine={false} tickFormatter={fmtRupee} width={52}/>
              <Tooltip content={<TrendTooltip/>}/>
              <Line type="monotone" dataKey="gross" stroke="#6366f1" strokeWidth={2.5} dot={{r:4,fill:'#6366f1'}} name="Gross"/>
              <Line type="monotone" dataKey="net"   stroke="#10b981" strokeWidth={2.5} dot={{r:4,fill:'#10b981'}} name="Net"/>
            </LineChart>
          </ResponsiveContainer>
          <div style={{display:'flex',gap:20,justifyContent:'center',marginTop:4,fontSize:12,color:'#6b7280'}}>
            <span><span style={{display:'inline-block',width:10,height:10,borderRadius:2,background:'#6366f1',marginRight:5}}/> Gross</span>
            <span><span style={{display:'inline-block',width:10,height:10,borderRadius:2,background:'#10b981',marginRight:5}}/> Net Pay</span>
          </div>
        </div>
      </div>

      {/* Salary Slips Table */}
      <div className="py-card">
        <div className="py-card-hd">
          <span className="py-card-title"><FileText size={14} style={{marginRight:6,verticalAlign:'middle',color:'#3b82f6'}}/> Salary Slips — {selectedMonth}</span>
          <span style={{fontSize:12,color:'#9ca3af'}}>{filtered.length} records</span>
        </div>
        <div className="py-table-controls">
          <div className="py-search-wrap">
            <Search size={14} className="py-search-icon"/>
            <input className="py-search" placeholder="Search by name, department, ID…" value={searchTerm} onChange={e=>setSearchTerm(e.target.value)}/>
          </div>
          <select className="py-filter" value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>
            <option value="all">All Status</option>
            <option value="paid">Paid</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="on_hold">On Hold</option>
          </select>
        </div>
        <div className="py-table-wrap">
          {filtered.length === 0 ? (
            <div className="py-empty"><FileText size={28} color="#d1d5db"/><p>No records found</p></div>
          ) : (
            <table className="py-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Gross</th>
                  <th>PF</th>
                  <th>ESI</th>
                  <th>TDS</th>
                  <th>Deductions</th>
                  <th>Net Pay</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(e => (
                  <tr key={e.id}>
                    <td>
                      <span className="py-emp-name">{e.name}</span>
                      <span className="py-emp-dept">{e.department}</span>
                      <span className="py-emp-id">{e.employee_id}</span>
                    </td>
                    <td><span className="py-amt">{fmtRupee(e.gross)}</span></td>
                    <td><span className="py-deduction">₹{fmtN(e.pf)}</span></td>
                    <td><span className="py-deduction">₹{fmtN(e.esi)}</span></td>
                    <td><span className="py-deduction">₹{fmtN(e.tds)}</span></td>
                    <td><span className="py-deduction">{fmtRupee(e.total_deductions)}</span></td>
                    <td><span className="py-net">{fmtRupee(e.net_pay)}</span></td>
                    <td><StatusBadge status={e.status}/></td>
                    <td>
                      <button className="py-action-btn" title="View Payslip" onClick={()=>setSelectedSlip(e)}><Eye size={14}/></button>
                      <button className="py-action-btn" title="Download" onClick={()=>showToast(`Downloading payslip for ${e.name}…`)}><Download size={14}/></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
