import { useState, useEffect, useCallback, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { IndianRupee, Users, Download, Eye, X, CheckCircle, AlertCircle, FileText, TrendingUp, RefreshCw, Search, Lock, ThumbsUp, CreditCard, RotateCcw } from 'lucide-react';
import api from '@/services/api/client';

const fmtRupee = n => { if(n>=100000) return `₹${(n/100000).toFixed(1)}L`; if(n>=1000) return `₹${(n/1000).toFixed(0)}K`; return `₹${n||0}`; };
const fmtN = n => Number(n||0).toLocaleString('en-IN');

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const FY_ORDER    = ['April','May','June','July','August','September','October','November','December','January','February','March'];

// Builds the 12-month list for the current financial year (Apr–Mar)
const getCurrentFYMonths = () => {
  const today  = new Date();
  const fyYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return FY_ORDER.map((m, i) => `${m} ${i <= 8 ? fyYear : fyYear + 1}`);
};

const getCurrentFYMonth = () =>
  `${MONTH_NAMES[new Date().getMonth()]} ${new Date().getFullYear()}`;

const parseSelectedMonth = (str) => {
  const [name, yr] = str.split(' ');
  return { month: MONTH_NAMES.indexOf(name) + 1, year: parseInt(yr, 10) };
};

const MONTHS = getCurrentFYMonths();

const STATUS_COLOR = {
  paid:             { bg:'#d1fae5', color:'#065f46' },
  pending:          { bg:'#fef3c7', color:'#92400e' },
  processing:       { bg:'#dbeafe', color:'#1e40af' },
  on_hold:          { bg:'#fee2e2', color:'#991b1b' },
  pending_approval: { bg:'#ede9fe', color:'#5b21b6' },
};

export default function Payroll({ setPage: _setPage }) {
  const [payrolls,        setPayrolls]        = useState([]);
  const [summary,         setSummary]         = useState({});
  const [trend,           setTrend]           = useState([]);
  const [loading,         setLoading]         = useState(false);
  const [genLoading,      setGenLoading]      = useState(false);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [markAllLoading,  setMarkAllLoading]  = useState(false);
  const [showMarkAllConfirm, setShowMarkAllConfirm] = useState(false);
  const [rerunId,         setRerunId]         = useState(null);
  const [search,          setSearch]          = useState('');
  const [statusFilter,    setStatusFilter]    = useState('All');
  const [selectedMonth,   setSelectedMonth]   = useState(getCurrentFYMonth());
  const [toast,           setToast]           = useState(null);
  const [viewPayslip,     setViewPayslip]     = useState(null);
  const [confirmModal,    setConfirmModal]    = useState(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (message, type='success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(() => {
    setLoading(true);
    const { month, year } = parseSelectedMonth(selectedMonth);
    Promise.allSettled([
      api.get('/payroll', { params: { month, year, limit: 100 } }),
      api.get('/payroll/summary', { params: { month, year } }),
      api.get('/payroll/trend'),
    ]).then(([listRes, summaryRes, trendRes]) => {
      if (!isMounted.current) return;
      setPayrolls(listRes.status==='fulfilled'    ? (Array.isArray(listRes.value?.data)    ? listRes.value.data    : []) : []);
      setSummary(summaryRes.status==='fulfilled'  ? (summaryRes.value?.data || {})                                       : {});
      setTrend(trendRes.status==='fulfilled'      ? (Array.isArray(trendRes.value?.data)   ? trendRes.value.data   : []) : []);
    }).finally(() => { if (isMounted.current) setLoading(false); });
  }, [selectedMonth]);

  useEffect(() => { load(); }, [load]);

  // Period is locked once any record has been paid or is in processing
  const isLocked          = summary.is_locked || payrolls.some(p => p.status === 'paid' || p.status === 'processing');
  const hasPendingApproval = payrolls.some(p => p.status === 'pending_approval');
  const pendingCount      = payrolls.filter(p => p.status === 'pending').length;

  // Show confirm modal with pre-computed totals before generating
  const handleGenerateClick = () => {
    if (isLocked) {
      showToast('This period is locked. Use the per-row Re-run button for corrections.', 'error');
      return;
    }
    const gross      = summary.total_gross       || payrolls.reduce((s,p) => s+Number(p.gross||0),           0);
    const deductions = summary.total_deductions  || payrolls.reduce((s,p) => s+Number(p.total_deductions||0),0);
    const net        = summary.total_net         || payrolls.reduce((s,p) => s+Number(p.net_pay||0),         0);
    const count      = summary.total_employees   || payrolls.length;
    setConfirmModal({ gross, deductions, net, count });
  };

  const confirmGenerate = async () => {
    setConfirmModal(null);
    setGenLoading(true);

    try {
      const { month, year } = parseSelectedMonth(selectedMonth);
      const res = await api.post('/payroll/generate', { month, year });
      if (!isMounted.current) return;
      const msg = res?.data?.message || `Payroll generated for ${selectedMonth}`;
      const errCount = res?.data?.errors?.length || 0;
      showToast(errCount ? `${msg} — ${errCount} employee(s) had errors` : msg, errCount ? 'error' : 'success');
      load();
    } catch(e) {
      if (!isMounted.current) return;
      showToast(e?.response?.data?.message || e?.response?.data?.error || 'Failed to generate payroll', 'error');
    } finally { if (isMounted.current) setGenLoading(false); }
  };

  const approvePayroll = async () => {
    if (approvalLoading) return;
    const pending = payrolls.filter(p => p.status === 'pending');
    if (!pending.length) { showToast('No pending records to approve', 'error'); return; }
    setApprovalLoading(true);
    try {
      const { month, year } = parseSelectedMonth(selectedMonth);
      const res = await api.post('/payroll/approve', { month, year });
      if (!isMounted.current) return;
      showToast(res?.data?.message || `Payroll approved for ${selectedMonth}`);
      load();
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e?.response?.data?.message || 'Approval failed — Finance Head role required', 'error');
    } finally { if (isMounted.current) setApprovalLoading(false); }
  };

  const markPaid = async (employeeId) => {
    try {
      const { month, year } = parseSelectedMonth(selectedMonth);
      await api.post(`/payroll/${employeeId}/mark-paid`, { payment_date: new Date().toISOString().slice(0,10), month, year });
      if (!isMounted.current) return;
      showToast('Marked as paid');
      load();
    } catch { if (isMounted.current) showToast('Failed to mark as paid', 'error'); }
  };

  const markAllPaid = async () => {
    if (markAllLoading) return;
    const ids = payrolls.filter(p => p.status === 'pending').map(p => p.employee_id);
    if (!ids.length) { showToast('No pending records', 'error'); return; }

    setMarkAllLoading(true);
    try {
      const { month, year } = parseSelectedMonth(selectedMonth);
      await Promise.all(ids.map(id =>
        api.post(`/payroll/${id}/mark-paid`, { payment_date: new Date().toISOString().slice(0,10), month, year })
      ));
      if (!isMounted.current) return;
      showToast(`${ids.length} employees marked as paid`);
      load();
    } catch { if (isMounted.current) showToast('Bulk payment failed', 'error'); }
    finally { if (isMounted.current) setMarkAllLoading(false); }
  };

  const rerunEmployee = async (employeeId, name) => {
    setRerunId(employeeId);
    try {
      const { month, year } = parseSelectedMonth(selectedMonth);
      await api.post('/payroll/generate', { month, year, employee_id: employeeId });
      if (!isMounted.current) return;
      showToast(`Payroll re-run for ${name}`);
      load();
    } catch(e) {
      if (!isMounted.current) return;
      showToast(e?.response?.data?.error || 'Re-run failed', 'error');
    } finally { if (isMounted.current) setRerunId(null); }
  };

  const loadPayslip = async (employeeId) => {
    try {
      const { month, year } = parseSelectedMonth(selectedMonth);
      const r = await api.get('/payroll/payslips', { params: { employee_id: employeeId, month, year } });
      if (!isMounted.current) return;
      const data = r?.data?.data ?? r?.data ?? null;
      setViewPayslip(data);
    } catch { showToast('Could not load payslip', 'error'); }
  };

  const exportNEFT = () => {
    if (!filtered.length) { showToast('No records to export', 'error'); return; }
    const rows = [
      ['Employee Name','Employee ID','Bank Account','IFSC Code','Net Pay (INR)','Payment Date'],
      ...filtered.map(p => [
        `"${p.name || p.employee_name || ''}"`,
        p.employee_id || '',
        p.bank_account || '',
        p.ifsc_code || '',
        p.net_pay || 0,
        new Date().toISOString().slice(0,10),
      ]),
    ];
    const csv  = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type:'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `NEFT_${selectedMonth.replace(' ','_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('NEFT file exported');
  };

  const filtered = payrolls.filter(p => {
    const matchStatus = statusFilter==='All' || p.status===statusFilter;
    const matchSearch = !search || [p.name, p.employee_id, p.department, p.designation]
      .some(v => (v||'').toLowerCase().includes(search.toLowerCase()));
    return matchStatus && matchSearch;
  });

  const kpis = [
    { label:'Total Employees',  value: summary.total_employees || payrolls.length,                                                                       icon:Users,       color:'#6366f1' },
    { label:'Total Gross',      value: fmtRupee(summary.total_gross      || payrolls.reduce((s,p)=>s+Number(p.gross||0),0)),                             icon:IndianRupee,  color:'#10b981', isText:true },
    { label:'Total Deductions', value: fmtRupee(summary.total_deductions || payrolls.reduce((s,p)=>s+Number(p.total_deductions||0),0)),                  icon:TrendingUp,  color:'#f59e0b', isText:true },
    { label:'Net Payable',      value: fmtRupee(summary.total_net        || payrolls.reduce((s,p)=>s+Number(p.net_pay||0),0)),                           icon:CheckCircle, color:'#8b5cf6', isText:true },
  ];

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>

      {/* Toast */}
      {toast && (
        <div style={{ position:'fixed', top:20, right:20, zIndex:9999, display:'flex', alignItems:'center', gap:8,
          padding:'12px 18px', borderRadius:10,
          background: toast.type==='error'?'#fef2f2':'#f0fdf4',
          border:`1px solid ${toast.type==='error'?'#fca5a5':'#86efac'}`,
          boxShadow:'0 4px 20px rgba(0,0,0,.1)',
          color: toast.type==='error'?'#991b1b':'#166534', fontSize:13, fontWeight:500 }}>
          {toast.type==='error' ? <AlertCircle size={15}/> : <CheckCircle size={15}/>}
          {toast.message}
          <button onClick={()=>setToast(null)} style={{ marginLeft:8, background:'none', border:'none', cursor:'pointer', color:'inherit' }}><X size={13}/></button>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:3000,
          display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
          onClick={() => setConfirmModal(null)}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:460,
            boxShadow:'0 20px 60px rgba(0,0,0,.25)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
              <h2 style={{ fontSize:16, fontWeight:700, color:'#1f2937', margin:0 }}>Confirm Payroll Generation</h2>
              <button onClick={() => setConfirmModal(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            <p style={{ color:'#6b7280', fontSize:13, margin:'0 0 20px' }}>
              You are generating payroll for <strong>{selectedMonth}</strong>. Review the summary below.
            </p>
            <div style={{ background:'#f9fafb', borderRadius:10, padding:16, marginBottom:16 }}>
              {[
                ['Employees',        confirmModal.count],
                ['Total Gross',      `₹${fmtN(confirmModal.gross)}`],
                ['Total Deductions', `₹${fmtN(confirmModal.deductions)}`],
                ['Net Payable',      `₹${fmtN(confirmModal.net)}`],
              ].map(([lbl, val], i, arr) => (
                <div key={lbl} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0',
                  borderBottom: i < arr.length-1 ? '1px solid #f0f0f4' : 'none', fontSize:13 }}>
                  <span style={{ color:'#6b7280' }}>{lbl}</span>
                  <span style={{ fontWeight:700, color:'#1f2937' }}>{val}</span>
                </div>
              ))}
            </div>
            <div style={{ background:'#ede9fe', borderRadius:8, padding:'10px 14px', marginBottom:20, fontSize:12, color:'#5b21b6', lineHeight:1.5 }}>
              After generation, payroll enters <strong>pending approval</strong>. Finance Head must approve before payslips are emailed.
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
              <button onClick={() => setConfirmModal(null)}
                style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={confirmGenerate}
                style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                Confirm &amp; Generate
              </button>
            </div>
          </div>
        </div>
      )}

      {showMarkAllConfirm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:3000,
          display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
          onClick={() => setShowMarkAllConfirm(false)}>
          <div style={{ background:'#fff', borderRadius:16, padding:28, width:420,
            boxShadow:'0 20px 60px rgba(0,0,0,.25)' }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize:16, fontWeight:700, color:'#1f2937', margin:'0 0 10px' }}>Mark All as Paid</h2>
            <p style={{ color:'#6b7280', fontSize:13, margin:'0 0 20px' }}>
              Mark all <strong>{pendingCount} pending employee(s)</strong> as paid for <strong>{selectedMonth}</strong>? This cannot be undone.
            </p>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
              <button onClick={() => setShowMarkAllConfirm(false)}
                style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={() => { setShowMarkAllConfirm(false); markAllPaid(); }}
                style={{ padding:'9px 20px', background:'#16a34a', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                Confirm &amp; Mark Paid
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Payroll</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Manage and process employee payroll</p>
        </div>
        <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          {/* Month selector with lock indicator */}
          <div style={{ position:'relative' }}>
            <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
              style={{ padding:'8px 36px 8px 12px', border:`1px solid ${isLocked?'#fca5a5':'#e5e7eb'}`, borderRadius:8, fontSize:13, outline:'none', color:'#374151', appearance:'none' }}>
              {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            {isLocked
              ? <Lock size={13} color="#ef4444" style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }}/>
              : <span style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', color:'#9ca3af', fontSize:10 }}>▼</span>
            }
          </div>

          {/* Approve button — only visible when pending approval exists */}
          {hasPendingApproval && (
            <button onClick={approvePayroll} disabled={approvalLoading}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 16px', background:'#059669', color:'#fff',
                border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:approvalLoading?0.7:1 }}>
              <ThumbsUp size={14}/> {approvalLoading ? 'Approving…' : 'Approve & Release'}
            </button>
          )}

          {/* NEFT Export */}
          <button onClick={exportNEFT}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 14px', background:'#fff',
              color:'#374151', border:'1px solid #e5e7eb', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:500 }}>
            <CreditCard size={14}/> Export NEFT
          </button>

          {/* Generate / Period Locked */}
          <button onClick={handleGenerateClick} disabled={genLoading || isLocked}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px',
              background: isLocked ? '#9ca3af' : '#6B3FDB', color:'#fff', border:'none', borderRadius:8,
              cursor: isLocked ? 'not-allowed' : 'pointer', fontSize:13, fontWeight:600, opacity:genLoading?0.7:1 }}>
            {isLocked
              ? <Lock size={14}/>
              : <RefreshCw size={14} style={{ animation:genLoading?'spin 1s linear infinite':undefined }}/>}
            {genLoading ? 'Generating…' : isLocked ? 'Period Locked' : 'Generate Payroll'}
          </button>
        </div>
      </div>

      {/* Approval Banner */}
      {hasPendingApproval && (
        <div style={{ background:'#ede9fe', border:'1px solid #c4b5fd', borderRadius:10, padding:'12px 16px',
          marginBottom:16, display:'flex', alignItems:'center', gap:10, fontSize:13, color:'#5b21b6' }}>
          <AlertCircle size={15}/>
          <span><strong>Payroll for {selectedMonth} is awaiting Finance Head approval.</strong> Click "Approve &amp; Release" to process and email payslips.</span>
        </div>
      )}

      {/* KPIs */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:16, marginBottom:24 }}>
        {kpis.map(k => (
          <div key={k.label} style={{ background:'#fff', borderRadius:12, padding:20, border:'1px solid #f0f0f4', boxShadow:'0 1px 3px rgba(0,0,0,.05)' }}>
            <div style={{ display:'flex', justifyContent:'space-between' }}>
              <div>
                <p style={{ fontSize:11, color:'#9ca3af', margin:'0 0 8px', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.5px' }}>{k.label}</p>
                <p style={{ fontSize:k.isText?20:28, fontWeight:700, color:'#1f2937', margin:0 }}>{loading?'…':k.value}</p>
              </div>
              <div style={{ background:k.color+'18', borderRadius:10, padding:10, height:'fit-content' }}>
                <k.icon size={20} color={k.color}/>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Trend Chart */}
      {trend.length > 0 && (
        <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:20, marginBottom:20 }}>
          <h2 style={{ fontSize:15, fontWeight:600, color:'#1f2937', margin:'0 0 16px' }}>Payroll Trend — Last 6 Months</h2>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4"/>
              <XAxis dataKey="month" tick={{ fontSize:11 }}/>
              <YAxis tickFormatter={v=>`₹${(v/100000).toFixed(0)}L`} tick={{ fontSize:11 }}/>
              <Tooltip formatter={v=>[fmtRupee(v)]}/>
              <Line type="monotone" dataKey="gross" stroke="#6B3FDB" strokeWidth={2} name="Gross" dot={false}/>
              <Line type="monotone" dataKey="net"   stroke="#10b981" strokeWidth={2} name="Net"   dot={false}/>
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Filters + Bulk Actions */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, gap:12, flexWrap:'wrap' }}>
        <div style={{ display:'flex', gap:12, flex:1, flexWrap:'wrap' }}>
          <div style={{ position:'relative', flex:1, minWidth:220 }}>
            <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search employee, department…"
              style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8,
                border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
          </div>
          {['All','paid','pending','processing','on_hold','pending_approval'].map(s => (
            <button key={s} onClick={()=>setStatusFilter(s)}
              style={{ padding:'7px 14px', borderRadius:8, border:'1px solid', fontSize:12, fontWeight:500,
                cursor:'pointer', textTransform:'capitalize',
                borderColor: statusFilter===s?'#6B3FDB':'#e5e7eb',
                background:  statusFilter===s?'#6B3FDB':'#fff',
                color:       statusFilter===s?'#fff':'#374151' }}>
              {s === 'All' ? 'All' : s.replace('_',' ')}
            </button>
          ))}
        </div>
        {pendingCount > 0 && (
          <button
            onClick={() => setShowMarkAllConfirm(true)}
            disabled={markAllLoading}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 14px', background:'#d1fae5',
              color:'#065f46', border:'1px solid #a7f3d0', borderRadius:8, cursor:'pointer', fontSize:12,
              fontWeight:600, whiteSpace:'nowrap', opacity:markAllLoading?0.7:1 }}>
            <CheckCircle size={13}/>
            {markAllLoading ? 'Processing…' : `Mark All Paid (${pendingCount})`}
          </button>
        )}
      </div>

      {/* Payroll Table */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading payroll data…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:60, textAlign:'center', color:'#9ca3af' }}>
            <FileText size={40} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }}/>
            <p style={{ margin:'0 0 16px' }}>No payroll records for {selectedMonth}</p>
            {!isLocked && (
              <button onClick={handleGenerateClick} disabled={genLoading}
                style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                Generate Payroll Now
              </button>
            )}
          </div>
        ) : (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ background:'#f9fafb' }}>
                  {['Employee','Dept','Gross','PF','ESI','PT','TDS','Total Ded.','Net Pay','Status','Actions'].map(h => (
                    <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((p, i) => {
                  const sc = STATUS_COLOR[p.status] || STATUS_COLOR.pending;
                  const isRerunning = rerunId === (p.employee_id||p.id);
                  return (
                    <tr key={p.id||i} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                      <td style={{ padding:'10px 14px' }}>
                        <p style={{ fontSize:13, fontWeight:600, color:'#1f2937', margin:0 }}>{p.name||p.employee_name||'—'}</p>
                        <p style={{ fontSize:11, color:'#9ca3af', margin:'1px 0 0' }}>{p.employee_id||''} · {p.designation||''}</p>
                      </td>
                      <td style={{ padding:'10px 14px', color:'#6b7280' }}>{p.department||'—'}</td>
                      <td style={{ padding:'10px 14px', fontWeight:600, color:'#1f2937' }}>₹{fmtN(p.gross)}</td>
                      <td style={{ padding:'10px 14px', color:'#374151' }}>₹{fmtN(p.employee_pf||p.pf)}</td>
                      <td style={{ padding:'10px 14px', color:'#374151' }}>₹{fmtN(p.employee_esi||p.esi)}</td>
                      <td style={{ padding:'10px 14px', color:'#374151' }}>₹{fmtN(p.pt||p.professional_tax)}</td>
                      <td style={{ padding:'10px 14px', color:'#374151' }}>₹{fmtN(p.tds)}</td>
                      <td style={{ padding:'10px 14px', color:'#ef4444', fontWeight:500 }}>₹{fmtN(p.total_deductions)}</td>
                      <td style={{ padding:'10px 14px', fontWeight:700, color:'#10b981' }}>₹{fmtN(p.net_pay)}</td>
                      <td style={{ padding:'10px 14px' }}>
                        <span style={{ background:sc.bg, color:sc.color, padding:'3px 10px', borderRadius:20,
                          fontSize:11, fontWeight:600, textTransform:'capitalize', whiteSpace:'nowrap' }}>
                          {(p.status||'pending').replace(/_/g,' ')}
                        </span>
                      </td>
                      <td style={{ padding:'10px 14px' }}>
                        <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                          <button onClick={()=>loadPayslip(p.employee_id||p.id)} title="View Payslip"
                            style={{ padding:'5px 8px', background:'#ede9fe', color:'#6B3FDB', border:'none',
                              borderRadius:6, cursor:'pointer', display:'flex', alignItems:'center', gap:3, fontSize:11, fontWeight:600 }}>
                            <Eye size={12}/> View
                          </button>
                          {p.status === 'pending' && (
                            <button onClick={()=>markPaid(p.employee_id)} title="Mark as Paid"
                              style={{ padding:'5px 8px', background:'#d1fae5', color:'#065f46', border:'none',
                                borderRadius:6, cursor:'pointer', display:'flex', alignItems:'center', gap:3, fontSize:11, fontWeight:600 }}>
                              <CheckCircle size={12}/> Pay
                            </button>
                          )}
                          <button onClick={()=>rerunEmployee(p.employee_id||p.id, p.name||p.employee_name)} title="Re-run payroll" disabled={isRerunning}
                            style={{ padding:'5px 8px', background:'#fef3c7', color:'#92400e', border:'none',
                              borderRadius:6, cursor:'pointer', display:'flex', alignItems:'center', gap:3, fontSize:11, fontWeight:600,
                              opacity:isRerunning?0.6:1 }}>
                            <RotateCcw size={12} style={{ animation:isRerunning?'spin 1s linear infinite':undefined }}/> Re-run
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background:'#f5f3ff', borderTop:'2px solid #e9e4ff' }}>
                  <td colSpan={2} style={{ padding:'10px 14px', fontWeight:700, color:'#1f2937' }}>TOTAL ({filtered.length} employees)</td>
                  <td style={{ padding:'10px 14px', fontWeight:700, color:'#1f2937' }}>₹{fmtN(filtered.reduce((s,p)=>s+Number(p.gross||0),0))}</td>
                  <td style={{ padding:'10px 14px', fontWeight:600 }}>₹{fmtN(filtered.reduce((s,p)=>s+Number(p.employee_pf||p.pf||0),0))}</td>
                  <td style={{ padding:'10px 14px', fontWeight:600 }}>₹{fmtN(filtered.reduce((s,p)=>s+Number(p.employee_esi||p.esi||0),0))}</td>
                  <td style={{ padding:'10px 14px', fontWeight:600 }}>₹{fmtN(filtered.reduce((s,p)=>s+Number(p.pt||p.professional_tax||0),0))}</td>
                  <td style={{ padding:'10px 14px', fontWeight:600 }}>₹{fmtN(filtered.reduce((s,p)=>s+Number(p.tds||0),0))}</td>
                  <td style={{ padding:'10px 14px', fontWeight:700, color:'#ef4444' }}>₹{fmtN(filtered.reduce((s,p)=>s+Number(p.total_deductions||0),0))}</td>
                  <td style={{ padding:'10px 14px', fontWeight:700, color:'#10b981' }}>₹{fmtN(filtered.reduce((s,p)=>s+Number(p.net_pay||0),0))}</td>
                  <td colSpan={2}/>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Payslip Modal */}
      {viewPayslip && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:2000,
          display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
          onClick={() => setViewPayslip(null)}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:600, maxHeight:'90vh',
            overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.25)' }} onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>
                Payslip — {viewPayslip.name || viewPayslip.employee_name}
              </h2>
              <button onClick={() => setViewPayslip(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:20, background:'#f9fafb', borderRadius:10, padding:16 }}>
              {[
                ['Employee ID', viewPayslip.employee?.id   || viewPayslip.employee_id],
                ['Department',  viewPayslip.employee?.department || viewPayslip.department],
                ['Designation', viewPayslip.employee?.designation || viewPayslip.designation],
                ['Month',       viewPayslip.payroll_period || viewPayslip.month || selectedMonth],
                ['PAN',         viewPayslip.employee?.pan  || viewPayslip.pan || '—'],
                ['Bank A/c',    viewPayslip.employee?.bank || (viewPayslip.bank_account ? `****${String(viewPayslip.bank_account).slice(-4)}` : '—')],
              ].map(([lbl,val]) => (
                <div key={lbl}>
                  <p style={{ fontSize:11, color:'#9ca3af', margin:0, fontWeight:500 }}>{lbl}</p>
                  <p style={{ fontSize:13, color:'#1f2937', margin:'2px 0 0', fontWeight:500 }}>{val||'—'}</p>
                </div>
              ))}
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:20 }}>
              <div>
                <h3 style={{ fontSize:13, fontWeight:700, color:'#1f2937', margin:'0 0 10px', paddingBottom:6, borderBottom:'2px solid #ede9fe' }}>Earnings</h3>
                {[
                  ['Basic',             viewPayslip.basic],
                  ['HRA',               viewPayslip.hra],
                  ['Conveyance',        viewPayslip.conveyance || 1600],
                  ['Medical Allowance', viewPayslip.medical    || 1250],
                  ['Special Allowance', viewPayslip.special_allowance],
                  ['Other Allowances',  viewPayslip.allowances],
                ].filter(([,v])=>Number(v||0)>0).map(([lbl,val]) => (
                  <div key={lbl} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13 }}>
                    <span style={{ color:'#6b7280' }}>{lbl}</span>
                    <span style={{ color:'#1f2937', fontWeight:500 }}>₹{fmtN(val)}</span>
                  </div>
                ))}
                <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', marginTop:6, borderTop:'1px solid #e9e4ff', fontWeight:700, fontSize:14 }}>
                  <span>Gross Salary</span>
                  <span style={{ color:'#10b981' }}>₹{fmtN(viewPayslip.gross)}</span>
                </div>
              </div>
              <div>
                <h3 style={{ fontSize:13, fontWeight:700, color:'#1f2937', margin:'0 0 10px', paddingBottom:6, borderBottom:'2px solid #fee2e2' }}>Deductions</h3>
                {[
                  ['PF (Employee)',  viewPayslip.employee_pf || viewPayslip.pf],
                  ['PF (Employer)', viewPayslip.employer_pf],
                  ['ESI',           viewPayslip.employee_esi || viewPayslip.esi],
                  ['Prof. Tax',     viewPayslip.professional_tax || viewPayslip.pt],
                  ['TDS',           viewPayslip.tds],
                  ['Loan EMI',      viewPayslip.loan_deduction],
                  ['Advance',       viewPayslip.advance_deduction],
                ].filter(([,v])=>Number(v||0)>0).map(([lbl,val]) => (
                  <div key={lbl} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13 }}>
                    <span style={{ color:'#6b7280' }}>{lbl}</span>
                    <span style={{ color:'#ef4444', fontWeight:500 }}>₹{fmtN(val)}</span>
                  </div>
                ))}
                <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', marginTop:6, borderTop:'1px solid #fee2e2', fontWeight:700, fontSize:14 }}>
                  <span>Total Deductions</span>
                  <span style={{ color:'#ef4444' }}>₹{fmtN(viewPayslip.total_deductions)}</span>
                </div>
              </div>
            </div>

            <div style={{ background:'linear-gradient(135deg,#6B3FDB,#6366f1)', borderRadius:12, padding:'16px 20px',
              display:'flex', justifyContent:'space-between', alignItems:'center', color:'#fff' }}>
              <span style={{ fontSize:16, fontWeight:600 }}>Net Pay (Take Home)</span>
              <span style={{ fontSize:24, fontWeight:800 }}>₹{fmtN(viewPayslip.net_pay)}</span>
            </div>

            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setViewPayslip(null)}
                style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Close</button>
              <button onClick={async () => {
                  try {
                    const r = await api.get(`/payroll/payslip-pdf/${viewPayslip.employee_id || viewPayslip.id}?month=${encodeURIComponent(selectedMonth)}`, { responseType: 'blob' });
                    const url = URL.createObjectURL(r.data);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `Payslip_${(viewPayslip.name || viewPayslip.employee_name || 'employee').replace(/\s+/g,'_')}_${selectedMonth.replace(' ','_')}.pdf`;
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch { showToast('PDF download failed — please try again', 'error'); }
                }}
                style={{ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8,
                cursor:'pointer', fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:6 }}>
                <Download size={14}/> Download PDF
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }`}</style>
    </div>
  );
}
