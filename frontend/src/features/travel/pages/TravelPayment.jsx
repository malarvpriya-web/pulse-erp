import { useState, useEffect, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import { Banknote, Search, Download, X, FileText, Wallet, CheckCircle2 } from 'lucide-react';
import { STATUS_COLOR, fmt } from './travelUtils';

/**
 * Payment — the final leg of the reimbursement chain.
 *
 * Only 'Mgmt Approved' claims can be paid; the backend rejects anything else,
 * so this page loads that queue by default rather than letting finance click
 * into a guaranteed 400. Paying auto-adjusts any disbursed advance on the same
 * travel request (oldest first) and pays only the balance — the adjustment is
 * computed server-side, which is why it's previewed here but never posted.
 */

const PAY_MODES = ['NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Cash'];
const PAGE_SIZES = [10, 25, 50, 100];
const PAYABLE_STATUS = 'Mgmt Approved';

const inputStyle = { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
const th = { padding:'10px 12px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' };
const td = { padding:'10px 12px', color:'#374151', whiteSpace:'nowrap' };

export default function TravelPayment() {
  const toast = useToast();
  const [claims, setClaims]   = useState([]);
  const [advances, setAdvances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [payFor, setPayFor]   = useState(null);
  const [saving, setSaving]   = useState(false);
  const [form, setForm] = useState({ payment_ref:'', payment_date:new Date().toISOString().slice(0,10), payment_mode:'NEFT' });

  const [draft,   setDraft]   = useState({ status: PAYABLE_STATUS });
  const [applied, setApplied] = useState({ status: PAYABLE_STATUS });
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const load = useCallback((filters) => {
    setLoading(true);
    Promise.all([
      api.get('/reimbursement/claims', { params: { status: filters.status === 'All' ? undefined : filters.status, limit: 200 } })
        .then(r => (Array.isArray(r.data) ? r.data : []))
        .catch(() => []),
      api.get('/travel/advances').then(r => (Array.isArray(r.data) ? r.data : [])).catch(() => []),
    ]).then(([c, a]) => { setClaims(c); setAdvances(a); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(applied);
    // Intentionally mount-only: later fetches go through the Load button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoad = () => { setApplied(draft); setPage(1); load(draft); };

  // Mirrors the server's adjustment rule so finance sees the net before posting:
  // disbursed advances on the same travel request, oldest first, capped at the
  // claim total. Display only — the server recomputes and is authoritative.
  const previewAdjustment = useCallback((claim) => {
    const total = Number(claim?.total_amount || 0);
    if (!claim?.travel_request_id) return { adjusted: 0, net: total };
    const pool = advances
      .filter(a => a.travel_request_id === claim.travel_request_id
                && ['Disbursed', 'Partially Settled'].includes(a.status))
      .sort((x, y) => new Date(x.created_at || 0) - new Date(y.created_at || 0));
    let adjusted = 0;
    for (const a of pool) {
      const outstanding = Number(a.amount || 0) - Number(a.settled_amount || 0);
      if (outstanding <= 0 || adjusted >= total) continue;
      adjusted += Math.min(outstanding, total - adjusted);
    }
    return { adjusted, net: total - adjusted };
  }, [advances]);

  const filtered = useMemo(() => claims.filter(c =>
    !search || [c?.claim_number, c?.employee_full_name, c?.employee_name, c?.vendor_name, c?.project_number]
      .some(v => (v||'').toLowerCase().includes(search.toLowerCase()))
  ), [claims, search]);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page > maxPage) setPage(maxPage);
  }, [filtered.length, pageSize, page]);

  const total = filtered.length;
  const from  = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to    = Math.min(page * pageSize, total);
  const pageRows = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]);

  const queueValue = filtered.reduce((s, c) => s + previewAdjustment(c).net, 0);

  const openPay = (c) => {
    setForm({ payment_ref:'', payment_date:new Date().toISOString().slice(0,10), payment_mode:'NEFT' });
    setPayFor(c);
  };

  const handlePay = async () => {
    if (!payFor) return;
    if (!form.payment_ref.trim()) { toast.error('Payment reference is required'); return; }
    setSaving(true);
    try {
      const r = await api.put(`/reimbursement/claims/${payFor.id}/pay`, form);
      toast.success(r.data?.message || 'Payment posted');
      setPayFor(null); load(applied);
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Payment failed');
    } finally { setSaving(false); }
  };

  const exportExcel = () => {
    if (!filtered.length) { toast.error('Nothing to export'); return; }
    const rowsOut = filtered.map(c => {
      const { adjusted, net } = previewAdjustment(c);
      return {
        Claim:          c.claim_number || '',
        Name:           c.employee_full_name || c.employee_name || '',
        'Expense date': fmtDate(c.expense_date),
        Status:         c.status || '',
        Category:       c.expense_category || c.category || '',
        Ref:            c.project_number || '',
        Amount:         Number(c.amount || 0),
        GST:            Number(c.gst_amount || 0),
        Total:          Number(c.total_amount || 0),
        'Adv Adjusted': adjusted,
        Payable:        net,
        'Paid on':      fmtDate(c.payment_date),
        'Paid Ref':     c.payment_ref || '',
      };
    });
    const ws = XLSX.utils.json_to_sheet(rowsOut);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Payments');
    XLSX.writeFile(wb, `travel_payments_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const COLS = ['Claim','Name','Expense date','Status','Category','Ref','Amount','GST','Total','Adv Adjusted','Payable','Paid on','Paid Ref','Actions'];
  const preview = payFor ? previewAdjustment(payFor) : null;

  return (
    <div style={{ padding:24, background:'var(--color-bg-page)', minHeight:'100vh' }}>
      <div style={{ marginBottom:20 }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Payment</h1>
        <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>
          {total} claim{total === 1 ? '' : 's'} in the queue · {fmt(queueValue)} net payable after advance adjustment
        </p>
      </div>

      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:16, marginBottom:16, display:'flex', gap:14, alignItems:'flex-end', flexWrap:'wrap' }}>
        <div style={{ minWidth:200 }}>
          <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Status</label>
          <select value={draft.status} onChange={e => setDraft({ status:e.target.value })} style={inputStyle}>
            <option value={PAYABLE_STATUS}>Ready to pay (Mgmt Approved)</option>
            <option value="Paid">Paid</option>
            <option value="All">All statuses</option>
          </select>
        </div>
        <button onClick={handleLoad} disabled={loading}
          style={{ padding:'9px 22px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:loading?'wait':'pointer', fontSize:13, fontWeight:600, opacity:loading?.6:1 }}>
          {loading ? 'Loading…' : 'Load'}
        </button>
        <div style={{ flex:1 }}/>
        <div style={{ position:'relative', minWidth:260 }}>
          <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search claim, employee, vendor..."
            style={{ ...inputStyle, paddingLeft:32 }}/>
        </div>
        <button onClick={exportExcel}
          style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'9px 16px', background:'#fff', color:'#374151', border:'1px solid #e5e7eb', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Download size={14}/> Excel
        </button>
      </div>

      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        {loading ? <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div> : (
          <>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead>
                  <tr style={{ background:'#f9fafb' }}>{COLS.map(h => <th key={h} style={th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 ? (
                    <tr>
                      <td colSpan={COLS.length} style={{ padding:60, textAlign:'center', color:'#9ca3af' }}>
                        <Wallet size={36} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }}/>
                        No data available in table
                      </td>
                    </tr>
                  ) : pageRows.map((c, i) => {
                    const sc = STATUS_COLOR[c.status] || STATUS_COLOR.Pending;
                    const { adjusted, net } = previewAdjustment(c);
                    return (
                      <tr key={c.id||i} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                        <td style={{ ...td, fontWeight:500, color:'#1f2937' }}>{c.claim_number||'—'}</td>
                        <td style={td}>{c.employee_full_name || c.employee_name || '—'}</td>
                        <td style={td}>{fmtDate(c.expense_date)}</td>
                        <td style={td}>
                          <span style={{ background:sc.bg, color:sc.color, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600 }}>{c.status||'—'}</span>
                        </td>
                        <td style={td}>{c.expense_category || c.category || '—'}</td>
                        <td style={td}>{c.project_number || '—'}</td>
                        <td style={td}>{fmt(c.amount)}</td>
                        <td style={td}>{Number(c.gst_amount) ? fmt(c.gst_amount) : '—'}</td>
                        <td style={{ ...td, fontWeight:600, color:'#1f2937' }}>{fmt(c.total_amount)}</td>
                        <td style={{ ...td, color: adjusted > 0 ? '#92400e' : '#9ca3af' }}>{adjusted > 0 ? `− ${fmt(adjusted)}` : '—'}</td>
                        <td style={{ ...td, fontWeight:700, color:'#065f46' }}>{fmt(net)}</td>
                        <td style={td}>{fmtDate(c.payment_date)}</td>
                        <td style={td}>{c.payment_ref || '—'}</td>
                        <td style={td}>
                          {c.status === PAYABLE_STATUS ? (
                            <button onClick={() => openPay(c)}
                              style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'5px 10px', background:'#065f46', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:600 }}>
                              <Banknote size={12}/> Pay
                            </button>
                          ) : c.status === 'Paid' ? (
                            <span style={{ display:'inline-flex', alignItems:'center', gap:4, color:'#065f46', fontSize:12, fontWeight:600 }}>
                              <CheckCircle2 size={12}/> Paid
                            </span>
                          ) : <span style={{ color:'#9ca3af' }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 14px', borderTop:'1px solid #f0f0f4', flexWrap:'wrap', gap:10 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, color:'#6b7280' }}>
                <span>Show</span>
                <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
                  style={{ ...inputStyle, width:'auto', padding:'5px 8px' }}>
                  {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <span>entries</span>
              </div>
              <div style={{ fontSize:13, color:'#6b7280' }}>Showing {from} to {to} of {total} entries</div>
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                  style={{ padding:'6px 14px', border:'1px solid #e5e7eb', borderRadius:6, background:'#fff', cursor:page<=1?'not-allowed':'pointer', fontSize:13, opacity:page<=1?.5:1 }}>Previous</button>
                <button onClick={() => setPage(p => (p * pageSize >= total ? p : p + 1))} disabled={to >= total}
                  style={{ padding:'6px 14px', border:'1px solid #e5e7eb', borderRadius:6, background:'#fff', cursor:to>=total?'not-allowed':'pointer', fontSize:13, opacity:to>=total?.5:1 }}>Next</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Pay modal */}
      {payFor && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:460, boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>Post Payment</h2>
              <button onClick={() => setPayFor(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>

            <div style={{ background:'#f9fafb', borderRadius:8, padding:'12px 14px', fontSize:13, marginBottom:16, color:'#374151' }}>
              <div><strong>{payFor.claim_number}</strong> · {payFor.employee_full_name || payFor.employee_name || '—'}</div>
              {payFor.description && <div style={{ marginTop:4 }}>{payFor.description}</div>}
              <div style={{ marginTop:10, display:'grid', gap:4 }}>
                <div style={{ display:'flex', justifyContent:'space-between' }}>
                  <span>Claim total</span><span>{fmt(payFor.total_amount)}</span>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', color: preview.adjusted > 0 ? '#92400e' : '#9ca3af' }}>
                  <span>Advance adjusted</span><span>{preview.adjusted > 0 ? `− ${fmt(preview.adjusted)}` : '—'}</span>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', fontWeight:700, color:'#065f46', borderTop:'1px solid #e5e7eb', paddingTop:4, marginTop:2 }}>
                  <span>Net payable</span><span>{fmt(preview.net)}</span>
                </div>
              </div>
              {payFor.google_drive_link && (
                <a href={payFor.google_drive_link} target="_blank" rel="noreferrer" style={{ color:'#6B3FDB', fontSize:12, display:'inline-flex', alignItems:'center', gap:4, marginTop:8 }}>
                  <FileText size={12}/> Bill
                </a>
              )}
            </div>

            <div style={{ display:'grid', gap:14 }}>
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Payment Reference *</label>
                <input value={form.payment_ref} onChange={e => setForm(p => ({ ...p, payment_ref:e.target.value }))}
                  placeholder="UTR / cheque no." style={inputStyle}/>
              </div>
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Payment Date</label>
                <input type="date" value={form.payment_date} onChange={e => setForm(p => ({ ...p, payment_date:e.target.value }))} style={inputStyle}/>
              </div>
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Payment Mode</label>
                <select value={form.payment_mode} onChange={e => setForm(p => ({ ...p, payment_mode:e.target.value }))} style={inputStyle}>
                  {PAY_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setPayFor(null)} style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={handlePay} disabled={saving || !form.payment_ref.trim()}
                style={{ padding:'9px 18px', background:'#065f46', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:(saving||!form.payment_ref.trim())?.6:1 }}>
                {saving ? 'Posting...' : `Pay ${fmt(preview.net)}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
