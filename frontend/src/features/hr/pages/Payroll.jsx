import { useState, useEffect, useCallback, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  IndianRupee, Users, Download, Eye, X, CheckCircle, AlertCircle,
  FileText, TrendingUp, RefreshCw, Search, Lock, ThumbsUp, CreditCard,
  RotateCcw, Wallet,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { localDay } from '@/utils/dateFormatter';
import { useAuth } from '@/context/AuthContext';
import { heldGrant } from '@/config/menuCatalog';

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
  pending:          { bg:'#ede9fe', color:'#5b21b6' },
  processing:       { bg:'#dbeafe', color:'#1e40af' },
  on_hold:          { bg:'#fee2e2', color:'#991b1b' },
  pending_approval: { bg:'#ede9fe', color:'#5b21b6' },
};

export default function Payroll({ setPage, embedded = false }) {
  // Each action is shown to whoever its API accepts (PC-01). Payment is read
  // from the grant itself: hasPermission() is true for admin on everything,
  // but only finance_manager holds payroll_payment:approve (Q1).
  const { hasPermission, permissions } = useAuth();
  const may = (m, a) => typeof hasPermission === 'function' && hasPermission(m, a);
  const canGenerate = may('payroll', 'add');
  const canApprove  = may('payroll', 'approve');
  const canPay      = heldGrant(permissions, 'payroll_payment', 'approve');
  // The NEFT export carries full account numbers, which only employee_bank:view
  // holders receive from the server (PC-02a PD-16); for anyone else it would be
  // a file of masked numbers.
  const canExportBank = may('employee_bank', 'view');
  const [payrolls,        setPayrolls]        = useState([]);
  const [summary,         setSummary]         = useState({});
  const [trend,           setTrend]           = useState([]);
  const [loading,         setLoading]         = useState(false);
  const [genLoading,      setGenLoading]      = useState(false);
  const [approvalLoading, setApprovalLoading] = useState(false);
  // Record payment (PC-02a PD-1): one employee at a time, with the bank's
  // transaction reference (UTR) and value date. There is no bulk "Mark All
  // Paid" — it could not carry per-payment evidence; bulk confirmation comes
  // with Finance salary batches.
  const [payDialog,       setPayDialog]       = useState(null);
  const [rerunId,         setRerunId]         = useState(null);
  const [search,          setSearch]          = useState('');
  const [statusFilter,    setStatusFilter]    = useState('All');
  const [selectedMonth,   setSelectedMonth]   = useState(getCurrentFYMonth());
  const [toast,           setToast]           = useState(null);
  const [viewPayslip,     setViewPayslip]     = useState(null);
  const [confirmModal,    setConfirmModal]    = useState(null);
  const [eligibility,     setEligibility]     = useState(null);
  const [showIneligible,  setShowIneligible]  = useState(false);
  const [readiness,       setReadiness]       = useState(null);
  // Which reads failed. allSettled used to drop them silently, so a 403/500 on
  // the list rendered "No payroll records" with a Generate button.
  const [loadErrors,      setLoadErrors]      = useState([]);

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
    // The api client returns the axios response, whose body is the
    // {success, data} envelope — so the rows are at .data.data. Reading
    // .data here made the table always empty and "Total Employees" always 0.
    const body = (res) => (res.status === 'fulfilled' ? res.value?.data?.data : undefined);
    Promise.allSettled([
      api.get('/payroll', { params: { month, year, limit: 500 } }),
      api.get('/payroll/summary', { params: { month, year } }),
      api.get('/payroll/trend'),
      api.get('/payroll/eligibility', { params: { month, year } }),
      api.get('/payroll/release-readiness', { params: { month, year } }),
    ]).then(([listRes, summaryRes, trendRes, eligRes, readyRes]) => {
      if (!isMounted.current) return;
      const why = (r) => r.reason?.response?.data?.message || r.reason?.response?.data?.error || r.reason?.message || 'request failed';
      setLoadErrors([
        [listRes, 'Payroll records'], [summaryRes, 'Summary'], [eligRes, 'Eligibility'], [readyRes, 'Release prerequisites'],
      ].filter(([r]) => r.status === 'rejected').map(([r, what]) => ({ what, message: why(r) })));
      const list = body(listRes), trendRows = body(trendRes);
      setPayrolls(Array.isArray(list) ? list : []);
      setSummary(body(summaryRes) || {});
      setTrend(Array.isArray(trendRows) ? trendRows.filter(t => t.gross != null) : []);
      setEligibility(body(eligRes) || null);
      setReadiness(body(readyRes) || null);
    }).finally(() => { if (isMounted.current) setLoading(false); });
  }, [selectedMonth]);

  useEffect(() => { load(); }, [load]);

  // Period is locked once any record has been paid or is in processing
  const isLocked          = summary.is_locked || payrolls.some(p => p.status === 'paid' || p.status === 'processing');
  const hasPendingApproval = payrolls.some(p => p.status === 'pending');
  const blockingOf        = (p) => (p.validation_issues || []).filter(i => i.severity === 'error');

  // Eligibility is evaluated on today's master data; the table lists the SAVED
  // run. They differ when revisions change after the draft was generated, so
  // name the gap instead of showing two unexplained counts.
  const inRun             = new Set(payrolls.map(p => p.employee_id));
  const eligibleNotInRun  = (eligibility?.employees || []).filter(e => e.eligible && !inRun.has(e.employee_id));
  const eligibleIds       = new Set((eligibility?.employees || []).filter(e => e.eligible).map(e => e.employee_id));
  const inRunNotEligible  = eligibility ? payrolls.filter(p => !eligibleIds.has(p.employee_id)) : [];

  // Show confirm modal with pre-computed totals before generating
  const handleGenerateClick = () => {
    if (isLocked) {
      showToast('This period is locked. Use the per-row Re-run button for corrections.', 'error');
      return;
    }
    const gross      = summary.total_gross       || payrolls.reduce((s,p) => s+Number(p.gross||0),           0);
    const deductions = summary.total_deductions  || payrolls.reduce((s,p) => s+Number(p.total_deductions||0),0);
    const net        = summary.total_net         || payrolls.reduce((s,p) => s+Number(p.net_pay||0),         0);
    const count      = eligibility?.summary?.eligible ?? (summary.total_employees || payrolls.length);
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
      const errCount = res?.data?.data?.errors?.length || 0;
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
      const gate = e?.response?.data?.release_blockers;
      if (gate?.length) { showToast(`${e.response.data.message}. See "Release prerequisites" above.`, 'error'); return; }
      const blocked = e?.response?.data?.blocked;
      showToast(blocked?.length
        ? `${e.response.data.message} — ${blocked.map(b => `${b.employee_code}: ${b.issues.map(i => i.message).join(', ')}`).join(' | ')}`
        : (e?.response?.data?.message || 'Approval failed — Finance Head role required'), 'error');
    } finally { if (isMounted.current) setApprovalLoading(false); }
  };

  const openPay = (p) => setPayDialog({
    employee_id: p.employee_id, name: p.name || p.employee_name || p.employee_code, net_pay: p.net_pay,
    reference: '', value_date: localDay(), payment_mode: 'neft', error: null, saving: false,
  });

  const submitPay = async () => {
    if (!payDialog || payDialog.saving) return;
    const reference = payDialog.reference.trim();
    if (!reference) { setPayDialog(d => ({ ...d, error: 'Enter the bank transaction reference (UTR).' })); return; }
    if (!payDialog.value_date) { setPayDialog(d => ({ ...d, error: 'Enter the value date of the transfer.' })); return; }
    setPayDialog(d => ({ ...d, saving: true, error: null }));
    try {
      const { month, year } = parseSelectedMonth(selectedMonth);
      const res = await api.post(`/payroll/${payDialog.employee_id}/mark-paid`, {
        month, year, reference, value_date: payDialog.value_date, payment_mode: payDialog.payment_mode,
      });
      if (!isMounted.current) return;
      setPayDialog(null);
      showToast(res?.data?.data?.already_paid ? 'Already recorded as paid with this reference' : 'Payment recorded — awaiting bank reconciliation');
      load();
    } catch (e) {
      if (!isMounted.current) return;
      // Nothing was recorded: the payment, its journal and the TDS row commit together or not at all.
      setPayDialog(d => d && ({ ...d, saving: false, error: e?.response?.data?.message || 'The payment could not be recorded' }));
    }
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
    const payable = filtered.filter(p => p.status === 'approved');
    if (!payable.length) { showToast('No approved records to export — approve payroll first', 'error'); return; }
    const rows = [
      ['Employee Name','Employee ID','Bank Account','IFSC Code','Net Pay (INR)','Payment Date'],
      ...payable.map(p => [
        `"${p.name || p.employee_name || ''}"`,
        p.employee_code || '',
        p.bank_account || '',
        p.ifsc_code || '',
        p.net_pay || 0,
        localDay(),
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
    const matchSearch = !search || [p.name, p.employee_code, p.department, p.designation]
      .some(v => (v||'').toLowerCase().includes(search.toLowerCase()));
    return matchStatus && matchSearch;
  });

  const kpis = [
    { label:'Employees in Run', value: summary.total_employees ?? payrolls.length,                                                                       icon:Users,       color:'#6366f1' },
    { label:'Total Gross',      value: fmtRupee(summary.total_gross      || payrolls.reduce((s,p)=>s+Number(p.gross||0),0)),                             icon:IndianRupee,  color:'#10b981', isText:true },
    { label:'Total Deductions', value: fmtRupee(summary.total_deductions || payrolls.reduce((s,p)=>s+Number(p.total_deductions||0),0)),                  icon:TrendingUp,  color:'#7c5cf0', isText:true },
    { label:'Net Payable',      value: fmtRupee(summary.total_net        || payrolls.reduce((s,p)=>s+Number(p.net_pay||0),0)),                           icon:CheckCircle, color:'#8b5cf6', isText:true },
  ];

  return (
    <PageShell embedded={embedded} dock={embedded ? null :
      <PageHero
        icon={Wallet}
        eyebrow="Human Resources"
        title="Payroll"
        subtitle="Manage and process employee payroll"
      />
    }>

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

      {payDialog && (
        <div role="dialog" aria-label="Record payment" style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:3000,
          display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
          onClick={() => !payDialog.saving && setPayDialog(null)}>
          <div style={{ background:'#fff', borderRadius:16, padding:28, width:440,
            boxShadow:'0 20px 60px rgba(0,0,0,.25)' }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize:16, fontWeight:700, color:'#1f2937', margin:'0 0 6px' }}>Record payment</h2>
            <p style={{ color:'#6b7280', fontSize:13, margin:'0 0 16px' }}>
              <strong>{payDialog.name}</strong> · {selectedMonth} · net ₹{fmtN(payDialog.net_pay)}. Enter the reference from the bank's
              confirmation. Recording it books the salary-clearing journal; reconciliation with the bank statement is a separate step in Finance.
            </p>
            <label htmlFor="pay-utr" style={{ fontSize:12, fontWeight:600, color:'#374151' }}>Bank transaction reference (UTR) *</label>
            <input id="pay-utr" value={payDialog.reference} autoFocus maxLength={35}
              onChange={e => setPayDialog(d => ({ ...d, reference: e.target.value, error: null }))}
              style={{ width:'100%', padding:'8px 10px', border:'1px solid #d1d5db', borderRadius:8, margin:'4px 0 12px', fontFamily:'monospace' }} />
            <div style={{ display:'flex', gap:12 }}>
              <div style={{ flex:1 }}>
                <label htmlFor="pay-value-date" style={{ fontSize:12, fontWeight:600, color:'#374151' }}>Value date *</label>
                <input id="pay-value-date" type="date" value={payDialog.value_date} max={localDay()}
                  onChange={e => setPayDialog(d => ({ ...d, value_date: e.target.value, error: null }))}
                  style={{ width:'100%', padding:'8px 10px', border:'1px solid #d1d5db', borderRadius:8, marginTop:4 }} />
              </div>
              <div style={{ flex:1 }}>
                <label htmlFor="pay-mode" style={{ fontSize:12, fontWeight:600, color:'#374151' }}>Mode</label>
                <select id="pay-mode" value={payDialog.payment_mode} onChange={e => setPayDialog(d => ({ ...d, payment_mode: e.target.value }))}
                  style={{ width:'100%', padding:'8px 10px', border:'1px solid #d1d5db', borderRadius:8, marginTop:4 }}>
                  {[['neft','NEFT'],['rtgs','RTGS'],['imps','IMPS'],['bank_transfer','Bank transfer'],['cheque','Cheque']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
            {payDialog.error && <p role="alert" style={{ color:'#b91c1c', fontSize:12, margin:'12px 0 0' }}>{payDialog.error}</p>}
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setPayDialog(null)} disabled={payDialog.saving}
                style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={submitPay} disabled={payDialog.saving}
                style={{ padding:'9px 20px', background:'#16a34a', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:payDialog.saving?0.7:1 }}>
                {payDialog.saving ? 'Recording…' : 'Record payment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, flexWrap:'wrap', gap:12 }}>
        <div>


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
          {hasPendingApproval && canApprove && (
            <button onClick={approvePayroll} disabled={approvalLoading || readiness?.ready === false}
              title={readiness?.ready === false ? 'Approval is blocked until the release prerequisites are met' : 'Approve this draft for payment'}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 16px', background:'#059669', color:'#fff',
                border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:(approvalLoading || readiness?.ready === false)?0.5:1 }}>
              <ThumbsUp size={14}/> {approvalLoading ? 'Approving…' : 'Approve & Release'}
            </button>
          )}

          {/* NEFT Export — bank-detail permission only (PD-16) */}
          {canExportBank && <button onClick={exportNEFT}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 14px', background:'#fff',
              color:'#374151', border:'1px solid #e5e7eb', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:500 }}>
            <CreditCard size={14}/> Export NEFT
          </button>}

          {/* Generate / Period Locked */}
          {canGenerate && <button onClick={handleGenerateClick} disabled={genLoading || isLocked}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px',
              background: isLocked ? '#9ca3af' : '#6B3FDB', color:'#fff', border:'none', borderRadius:8,
              cursor: isLocked ? 'not-allowed' : 'pointer', fontSize:13, fontWeight:600, opacity:genLoading?0.7:1 }}>
            {isLocked
              ? <Lock size={14}/>
              : <RefreshCw size={14} style={{ animation:genLoading?'spin 1s linear infinite':undefined }}/>}
            {genLoading ? 'Generating…' : isLocked ? 'Period Locked' : 'Generate Payroll'}
          </button>}
        </div>
      </div>

      {loadErrors.length > 0 && (
        <div role="alert" style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:10, padding:'12px 16px', marginBottom:16, fontSize:12, color:'#991b1b' }}>
          <strong style={{ fontSize:13 }}>Some payroll data for {selectedMonth} could not be loaded</strong> — figures below may be incomplete.
          <ul style={{ margin:'6px 0 0', paddingLeft:18 }}>
            {loadErrors.map(e => <li key={e.what}>{e.what}: {e.message}</li>)}
          </ul>
        </div>
      )}

      {/* Approval Banner */}
      {hasPendingApproval && (
        <div style={{ background:'#ede9fe', border:'1px solid #c4b5fd', borderRadius:10, padding:'12px 16px',
          marginBottom:16, display:'flex', alignItems:'center', gap:10, fontSize:13, color:'#5b21b6' }}>
          <AlertCircle size={15}/>
          <span><strong>Payroll for {selectedMonth} is a draft awaiting Finance approval.</strong> Payslips are released, payable and emailable only after "Approve &amp; Release".</span>
        </div>
      )}

      {/* Eligibility — the ONE rule (backend payrollEligibility.js) */}
      {eligibility && (
        <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:10, padding:'12px 16px', marginBottom:16, fontSize:13, color:'#374151' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap' }}>
            <span>
              <strong>{eligibility.summary.eligible}</strong> of <strong>{eligibility.summary.active_headcount}</strong> active employees are eligible for {eligibility.period}
              {eligibility.summary.not_eligible > 0 && <> · <span style={{ color:'#b45309' }}>{eligibility.summary.not_eligible} not eligible</span></>}
            </span>
            {eligibility.summary.not_eligible > 0 && (
              <button onClick={() => setShowIneligible(v => !v)} style={{ background:'none', border:'none', color:'#6B3FDB', cursor:'pointer', fontSize:12, fontWeight:600 }}>
                {showIneligible ? 'Hide reasons' : 'Show reasons'}
              </button>
            )}
          </div>
          {payrolls.length > 0 && (eligibleNotInRun.length > 0 || inRunNotEligible.length > 0) && (
            <div style={{ marginTop:8, fontSize:12, color:'#b45309' }}>
              The saved draft for {selectedMonth} has <strong>{payrolls.length}</strong> record(s), listed below.
              {eligibleNotInRun.length > 0 && <> {eligibleNotInRun.length} eligible employee(s) are not in it ({eligibleNotInRun.map(e => e.employee_code).join(', ')}).</>}
              {inRunNotEligible.length > 0 && <> {inRunNotEligible.length} record(s) are for employees no longer eligible ({inRunNotEligible.map(p => p.employee_code).join(', ')}).</>}
              {!isLocked && <> Generate Payroll again to bring the draft up to date.</>}
            </div>
          )}
          {showIneligible && (
            <ul style={{ margin:'10px 0 0', paddingLeft:18, fontSize:12, color:'#6b7280' }}>
              {eligibility.employees.filter(e => !e.eligible && ['active','probation','notice'].includes(String(e.status).toLowerCase())).map(e => (
                <li key={e.employee_id}><strong>{e.employee_code}</strong> {e.name}: {e.reasons.map(r => r.message).join('; ')}</li>
              ))}
            </ul>
          )}
          {(summary.cycle?.errors?.length > 0 || summary.settings_conflicts?.length > 0) && (
            <div style={{ marginTop:10, fontSize:12, color:'#b91c1c' }}>
              {summary.cycle?.errors?.map(e => <div key={e}>Pay cycle: {e}</div>)}
              {summary.settings_conflicts?.length > 0 && <div>Payroll Settings and the Setup Wizard disagree on: {summary.settings_conflicts.map(c => c.key).join(', ')} — Payroll Settings values are used. Save Payroll Settings once to align them.</div>}
            </div>
          )}
        </div>
      )}

      {/* Release gate — what blocks APPROVAL (backend payrollReleaseGate.js) */}
      {readiness && !readiness.ready && (
        <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:10, padding:'12px 16px', marginBottom:16, fontSize:12, color:'#7f1d1d' }}>
          <div style={{ fontWeight:700, fontSize:13, marginBottom:6 }}>
            Release prerequisites — approval, payment and payslip release are blocked for {readiness.period} ({readiness.blockers.length})
          </div>
          <ul style={{ margin:0, paddingLeft:18 }}>
            {readiness.blockers.map((b, i) => <li key={i} style={{ marginBottom:3 }}><strong>{b.code}</strong>{b.key ? ` · ${b.key}` : ''} — {b.message}</li>)}
          </ul>
          <div style={{ marginTop:6, color:'#6b7280' }}>
            A rule blocker is cleared when an authorised payroll administrator records the confirmed rule with its notification reference (POST /payroll/statutory-rules — there is no screen for this yet). Drafts can still be generated and reviewed.
          </div>
        </div>
      )}

      {/* KPIs */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))', gap:16, marginBottom:24 }}>
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
          {['All','pending','approved','paid'].map(s => (
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
      </div>

      {/* Payroll Table */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading payroll data…</div>
        ) : filtered.length === 0 && payrolls.length > 0 ? (
          <div style={{ padding:40, textAlign:'center', color:'#6b7280', fontSize:13 }}>
            None of the {payrolls.length} record(s) for {selectedMonth} match the current search or status filter.
          </div>
        ) : filtered.length === 0 && loadErrors.some(e => e.what === 'Payroll records') ? (
          <div style={{ padding:40, textAlign:'center', color:'#991b1b', fontSize:13 }}>
            Payroll records for {selectedMonth} could not be loaded, so it is not known whether a draft exists. See the error above.
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:60, textAlign:'center', color:'#9ca3af' }}>
            <FileText size={40} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }}/>
            <p style={{ margin:'0 0 16px' }}>No payroll records for {selectedMonth}</p>
            {!isLocked && eligibility?.summary?.eligible === 0 ? (
              <div style={{ fontSize:13, color:'#92400e', maxWidth:520, margin:'0 auto' }}>
                Payroll cannot be generated yet: none of the {eligibility.summary.active_headcount} active employees is eligible for {eligibility.period}.
                Each needs a salary structure and revision — the reasons are under "Show reasons" above.
                {typeof setPage === 'function' && (
                  <div style={{ marginTop:12 }}>
                    <button onClick={() => setPage('PayrollCenter', { tab: 'structures' })}
                      style={{ padding:'8px 16px', background:'#fff', color:'#6B3FDB', border:'1px solid #c4b5fd', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                      Open Salary Structures &amp; Assignments
                    </button>
                  </div>
                )}
              </div>
            ) : !isLocked && canGenerate && (
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
                        <p style={{ fontSize:11, color:'#9ca3af', margin:'1px 0 0' }}>{p.employee_code||'—'} · {p.designation||''}</p>
                        {blockingOf(p).length > 0 && (
                          <p title={blockingOf(p).map(i => i.message).join('\n')} style={{ fontSize:11, color:'#b91c1c', margin:'2px 0 0', fontWeight:600 }}>
                            ⚠ {blockingOf(p).length} data issue(s) — blocks approval
                          </p>
                        )}
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
                          {p.status === 'approved' && canPay && (
                            <button onClick={()=>openPay(p)} title="Record payment (needs the bank reference)"
                              style={{ padding:'5px 8px', background:'#d1fae5', color:'#065f46', border:'none',
                                borderRadius:6, cursor:'pointer', display:'flex', alignItems:'center', gap:3, fontSize:11, fontWeight:600 }}>
                              <CheckCircle size={12}/> Pay
                            </button>
                          )}
                          {p.status === 'pending' && canGenerate && <button onClick={()=>rerunEmployee(p.employee_id||p.id, p.name||p.employee_name)} title="Re-run payroll" disabled={isRerunning}
                            style={{ padding:'5px 8px', background:'#ede9fe', color:'#5b21b6', border:'none',
                              borderRadius:6, cursor:'pointer', display:'flex', alignItems:'center', gap:3, fontSize:11, fontWeight:600,
                              opacity:isRerunning?0.6:1 }}>
                            <RotateCcw size={12} style={{ animation:isRerunning?'spin 1s linear infinite':undefined }}/> Re-run
                          </button>}
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
                ['Employee Code', viewPayslip.employee_code || viewPayslip.employee?.code],
                ['Status',      viewPayslip.preview ? 'Preview — not generated' : (viewPayslip.status || '—')],
                ['Department',  viewPayslip.employee?.department || viewPayslip.department],
                ['Designation', viewPayslip.employee?.designation || viewPayslip.designation],
                ['Month',       viewPayslip.payroll_period || viewPayslip.month || selectedMonth],
                ['PAN',         viewPayslip.employee?.pan  || viewPayslip.pan || '—'],
                ['Bank A/c',    viewPayslip.employee?.bank || (viewPayslip.bank_account ? `****${String(viewPayslip.bank_account).slice(-4)}` : '—')],
                ['UAN',         viewPayslip.employee?.uan || '—'],
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
                {(viewPayslip.earnings || []).map(({ label: lbl, amount: val }) => (
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
                {(viewPayslip.deductions || []).map(({ label: lbl, amount: val }) => (
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

            {viewPayslip.contract?.annual_ctc != null && (
              <div style={{ marginTop:12, fontSize:12, color:'#4b5563' }}>
                Contract: annual CTC <strong>₹{fmtN(viewPayslip.contract.annual_ctc)}</strong> (salary revision effective {String(viewPayslip.contract.effective_from).slice(0, 10)}).
                This is the annual contract figure — not this month's cost.
              </div>
            )}
            {(viewPayslip.employer_contributions_list || []).length > 0 && (
              <div style={{ marginTop:16, background:'#f9fafb', borderRadius:10, padding:'12px 16px' }}>
                <h3 style={{ fontSize:13, fontWeight:700, color:'#1f2937', margin:'0 0 8px' }}>Employer Contributions <span style={{ fontWeight:400, color:'#6b7280' }}>(employer cost — not deducted from pay)</span></h3>
                {viewPayslip.employer_contributions_list.map(c => (
                  <div key={c.label} style={{ display:'flex', justifyContent:'space-between', padding:'3px 0', fontSize:13 }}>
                    <span style={{ color:'#6b7280' }}>{c.label}</span><span style={{ color:'#374151', fontWeight:500 }}>₹{fmtN(c.amount)}</span>
                  </div>
                ))}
                <div style={{ display:'flex', justifyContent:'space-between', padding:'6px 0 0', marginTop:4, borderTop:'1px solid #e5e7eb', fontSize:13, fontWeight:700 }}>
                  <span title="Gross earned this month + employer PF/ESI/LWF. Not a contractual CTC.">Employer cost this month</span><span>₹{fmtN(viewPayslip.ctc_monthly)}</span>
                </div>
              </div>
            )}

            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setViewPayslip(null)}
                style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Close</button>
              <button onClick={async () => {
                  try {
                    const { month: pm, year: py } = parseSelectedMonth(selectedMonth);
                    const r = await api.get(`/payroll/payslip-pdf/${viewPayslip.employee_id || viewPayslip.employee?.id}`, { params: { month: pm, year: py }, responseType: 'blob' });
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
    </PageShell>
  );
}
