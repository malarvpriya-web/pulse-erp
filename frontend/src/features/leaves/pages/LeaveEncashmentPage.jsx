import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, CheckCircle, XCircle, RefreshCw, IndianRupee, Info } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';

const fmt    = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const cur    = v => v != null ? `₹${Number(v).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—';
const YEAR   = new Date().getFullYear();
const YEARS  = [YEAR-2,YEAR-1,YEAR];

const STATUS_COLOR = {
  pending:  { bg:'#fef3c7', color:'#92400e' },
  approved: { bg:'#d1fae5', color:'#065f46' },
  paid:     { bg:'#dbeafe', color:'#1e40af' },
  cancelled:{ bg:'#fee2e2', color:'#991b1b' },
};
const sc = s => STATUS_COLOR[(s||'').toLowerCase()] || STATUS_COLOR.pending;

function CreateModal({ employees, leaveTypes, year, onSave, onClose }) {
  const [form, setForm]     = useState({ employee_id:'', leave_type_id:'', year, days_encashed:'', reason:'' });
  const [eligible, setEligible] = useState([]);
  const [err, setErr]       = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!form.employee_id) { setEligible([]); return; }
    api.get(`/leave-encashment/eligible/${form.employee_id}`, { params: { year:form.year } })
      .then(r => setEligible(Array.isArray(r.data) ? r.data.filter(e => e.max_encashable_now > 0) : []))
      .catch(() => setEligible([]));
  }, [form.employee_id, form.year]);

  const selectedElig = eligible.find(e => String(e.leave_type_id) === String(form.leave_type_id));

  const handleSave = async () => {
    if (!form.employee_id)   { setErr('Select an employee'); return; }
    if (!form.leave_type_id) { setErr('Select a leave type'); return; }
    if (!form.days_encashed || Number(form.days_encashed) <= 0) { setErr('Enter days to encash'); return; }
    if (selectedElig && Number(form.days_encashed) > selectedElig.max_encashable_now) {
      setErr(`Maximum encashable: ${selectedElig.max_encashable_now} days`); return;
    }
    setSaving(true); setErr('');
    try {
      await onSave(form);
      onClose();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || 'Failed');
    } finally { setSaving(false); }
  };

  const inp = { width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:7, fontSize:13, outline:'none', boxSizing:'border-box' };

  return (
    <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center' }}
      onClick={onClose}>
      <div style={{ background:'#fff',borderRadius:14,padding:28,width:520,maxWidth:'95vw' }} onClick={e=>e.stopPropagation()}>
        <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20 }}>
          <h3 style={{ margin:0,fontSize:16,fontWeight:700,color:'#1f2937' }}>Process Leave Encashment</h3>
          <button onClick={onClose} style={{ background:'none',border:'none',cursor:'pointer',color:'#6b7280',fontSize:20 }}>×</button>
        </div>

        <div style={{ background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:8,padding:'10px 14px',marginBottom:16,fontSize:12,color:'#1e40af',display:'flex',gap:8 }}>
          <Info size={14} style={{ flexShrink:0,marginTop:1 }}/>
          <span>Amount is calculated as: Days × (Basic Salary ÷ 26). 10% TDS will be deducted. Only encashable leave types are shown.</span>
        </div>

        <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14 }}>
          <div>
            <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>Employee *</label>
            <select value={form.employee_id} onChange={e=>setForm(f=>({...f,employee_id:e.target.value,leave_type_id:''}))} style={inp}>
              <option value="">Select employee…</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name} {e.employee_code?`(${e.employee_code})`:''}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>Year *</label>
            <select value={form.year} onChange={e=>setForm(f=>({...f,year:e.target.value}))} style={inp}>
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom:14 }}>
          <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>Leave Type *</label>
          {form.employee_id && eligible.length === 0 ? (
            <div style={{ padding:'10px 14px',background:'#fef9c3',borderRadius:7,fontSize:12,color:'#713f12' }}>
              No encashable leave balance available for this employee in {form.year}.
            </div>
          ) : (
            <select value={form.leave_type_id} onChange={e=>setForm(f=>({...f,leave_type_id:e.target.value}))} style={inp} disabled={!form.employee_id}>
              <option value="">Select leave type…</option>
              {eligible.map(e => <option key={e.leave_type_id} value={e.leave_type_id}>{e.leave_name} (max {e.max_encashable_now}d)</option>)}
            </select>
          )}
        </div>

        {selectedElig && (
          <div style={{ background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:8,padding:'10px 14px',marginBottom:14,fontSize:12 }}>
            <div style={{ display:'flex',gap:16 }}>
              <span>Balance: <strong>{selectedElig.balance_days}d</strong></span>
              <span>Already encashed: <strong>{selectedElig.already_encashed_this_year}d</strong></span>
              <span>Max encashable now: <strong style={{color:'#10b981'}}>{selectedElig.max_encashable_now}d</strong></span>
            </div>
          </div>
        )}

        <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14 }}>
          <div>
            <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>Days to Encash *</label>
            <input type="number" min="1" max={selectedElig?.max_encashable_now||999} value={form.days_encashed}
              onChange={e=>setForm(f=>({...f,days_encashed:e.target.value}))} style={inp} placeholder="e.g. 5"/>
          </div>
        </div>

        <div style={{ marginBottom:16 }}>
          <label style={{ fontSize:12,fontWeight:600,color:'#374151',display:'block',marginBottom:4 }}>Reason</label>
          <input value={form.reason} onChange={e=>setForm(f=>({...f,reason:e.target.value}))} style={inp} placeholder="e.g. Year-end encashment"/>
        </div>

        {err && <div style={{ color:'#ef4444',fontSize:12,marginBottom:12 }}>{err}</div>}

        <div style={{ display:'flex',gap:10,justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ padding:'8px 18px',border:'1px solid #e5e7eb',borderRadius:8,background:'#fff',fontSize:13,cursor:'pointer',color:'#6b7280' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding:'8px 18px',background:'#10b981',color:'#fff',border:'none',borderRadius:8,fontWeight:600,fontSize:13,cursor:'pointer',opacity:saving?0.6:1 }}>
            {saving ? 'Processing…' : 'Create Encashment'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LeaveEncashmentPage() {
  const { user } = useAuth();
  const toast    = useToast();

  const [records,   setRecords]   = useState([]);
  const [employees, setEmployees] = useState([]);
  const [leaveTypes,setLeaveTypes]= useState([]);
  const [loading,   setLoading]   = useState(false);
  const [acting,    setActing]    = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [fYear,     setFYear]     = useState(YEAR);
  const [fStatus,   setFStatus]   = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current=true; return ()=>{mounted.current=false;}; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { year:fYear };
      if (fStatus) params.status = fStatus;
      const r = await api.get('/leave-encashment', { params });
      if (mounted.current) setRecords(Array.isArray(r.data) ? r.data : []);
    } catch { if (mounted.current) setRecords([]); }
    finally { if (mounted.current) setLoading(false); }
  }, [fYear, fStatus]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/employees').then(r => setEmployees((r.data||[]).filter(e=>!['left','terminated'].includes((e.status||'').toLowerCase())))).catch(()=>{});
    api.get('/leaves/types', { params: { applicable: 1 } }).then(r => setLeaveTypes(r.data||[])).catch(()=>{});
  }, []);

  const createEncashment = async (form) => {
    await api.post('/leave-encashment', form);
    toast.success('Encashment record created');
    load();
  };

  const act = async (id, action) => {
    setActing(id);
    try {
      await api.post(`/leave-encashment/${action}/${id}`, action==='reject' ? { reason:'Rejected by HR' } : {});
      toast.success(action === 'approve' ? 'Encashment approved — balance deducted' : 'Encashment cancelled');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Action failed');
    } finally { if (mounted.current) setActing(null); }
  };

  const totals = records.reduce((acc, r) => {
    if (r.status === 'approved' || r.status === 'paid') {
      acc.days += Number(r.days_encashed||0);
      acc.gross += Number(r.gross_amount||0);
      acc.tds   += Number(r.tds_amount||0);
      acc.net   += Number(r.net_amount||0);
    }
    return acc;
  }, { days:0, gross:0, tds:0, net:0 });

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      {showModal && (
        <CreateModal employees={employees} leaveTypes={leaveTypes} year={fYear}
          onSave={createEncashment} onClose={() => setShowModal(false)} />
      )}

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:24, flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Leave Encashment</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Process leave encashment for employees — includes TDS calculation</p>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={load} style={{ display:'flex',alignItems:'center',gap:5,padding:'8px 14px',border:'1px solid #e5e7eb',borderRadius:8,background:'#fff',fontSize:13,cursor:'pointer' }}>
            <RefreshCw size={13}/> Refresh
          </button>
          <button onClick={() => setShowModal(true)}
            style={{ display:'flex',alignItems:'center',gap:6,padding:'8px 18px',background:'#10b981',color:'#fff',border:'none',borderRadius:8,fontWeight:600,fontSize:13,cursor:'pointer' }}>
            <Plus size={14}/> New Encashment
          </button>
        </div>
      </div>

      {/* Summary cards */}
      {records.length > 0 && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:14, marginBottom:20 }}>
          {[
            { label:`${fYear} Total Days`, value:`${totals.days.toFixed(1)} days`, color:'#6366f1' },
            { label:'Gross Encashment', value:cur(totals.gross), color:'#10b981' },
            { label:'TDS Deducted', value:cur(totals.tds), color:'#ef4444' },
            { label:'Net Payable', value:cur(totals.net), color:'#1d4ed8' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', padding:'16px 18px' }}>
              <div style={{ fontSize:11, color:'#6b7280', fontWeight:600, marginBottom:6, textTransform:'uppercase', letterSpacing:0.5 }}>{label}</div>
              <div style={{ fontSize:18, fontWeight:800, color }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'center' }}>
        <select value={fYear} onChange={e=>setFYear(e.target.value)}
          style={{ padding:'7px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13 }}>
          {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        {[['','All'],['pending','Pending'],['approved','Approved'],['paid','Paid'],['cancelled','Cancelled']].map(([v,l]) => (
          <button key={v} onClick={() => setFStatus(v)}
            style={{ padding:'6px 14px', borderRadius:20, border:`1.5px solid ${fStatus===v?'#10b981':'#e5e7eb'}`, background:fStatus===v?'#d1fae5':'#fff', color:fStatus===v?'#065f46':'#6b7280', fontSize:12, fontWeight:600, cursor:'pointer' }}>
            {l}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e5e7eb', overflow:'auto' }}>
        {loading ? (
          <div style={{ padding:48, textAlign:'center', color:'#9ca3af' }}>Loading…</div>
        ) : records.length === 0 ? (
          <div style={{ padding:48, textAlign:'center', color:'#9ca3af' }}>
            <IndianRupee size={36} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }}/>
            <p style={{ margin:0 }}>No encashment records for {fYear}</p>
          </div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Employee','Dept','Leave Type','Year','Days','Rate/Day','Gross','TDS','Net','Status','Actions'].map(h => (
                  <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap', fontSize:12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => {
                const s = sc(r.status);
                return (
                  <tr key={r.id} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                    <td style={{ padding:'10px 12px', fontWeight:500 }}>{r.employee_name||'—'}</td>
                    <td style={{ padding:'10px 12px', color:'#6b7280', fontSize:12 }}>{r.department||'—'}</td>
                    <td style={{ padding:'10px 12px' }}>
                      <span style={{ background:'#eef2ff',color:'#4338ca',padding:'2px 8px',borderRadius:12,fontSize:11,fontWeight:600 }}>{r.leave_name||'—'}</span>
                    </td>
                    <td style={{ padding:'10px 12px', color:'#6b7280' }}>{r.year}</td>
                    <td style={{ padding:'10px 12px', fontWeight:700 }}>{r.days_encashed}</td>
                    <td style={{ padding:'10px 12px', color:'#6b7280', fontSize:12 }}>{cur(r.rate_per_day)}</td>
                    <td style={{ padding:'10px 12px', fontWeight:600 }}>{cur(r.gross_amount)}</td>
                    <td style={{ padding:'10px 12px', color:'#ef4444', fontSize:12 }}>{cur(r.tds_amount)}</td>
                    <td style={{ padding:'10px 12px', fontWeight:700, color:'#10b981' }}>{cur(r.net_amount)}</td>
                    <td style={{ padding:'10px 12px' }}>
                      <span style={{ ...s, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700 }}>
                        {(r.status||'').charAt(0).toUpperCase()+(r.status||'').slice(1)}
                      </span>
                    </td>
                    <td style={{ padding:'10px 12px' }}>
                      {r.status === 'pending' ? (
                        <div style={{ display:'flex', gap:5 }}>
                          <button onClick={() => act(r.id,'approve')} disabled={acting===r.id}
                            style={{ display:'flex',alignItems:'center',gap:3,padding:'4px 9px',background:'#d1fae5',color:'#065f46',border:'none',borderRadius:6,cursor:'pointer',fontSize:11,fontWeight:600,opacity:acting===r.id?0.5:1 }}>
                            <CheckCircle size={11}/> Approve
                          </button>
                          <button onClick={() => act(r.id,'reject')} disabled={acting===r.id}
                            style={{ display:'flex',alignItems:'center',gap:3,padding:'4px 9px',background:'#fee2e2',color:'#991b1b',border:'none',borderRadius:6,cursor:'pointer',fontSize:11,fontWeight:600,opacity:acting===r.id?0.5:1 }}>
                            <XCircle size={11}/> Cancel
                          </button>
                        </div>
                      ) : (
                        <span style={{ fontSize:12, color:'#9ca3af' }}>{r.approved_by_name ? `By ${r.approved_by_name}` : '—'}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
