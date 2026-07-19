import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, Search, Receipt, Link, Upload, CheckCircle, IndianRupee } from 'lucide-react';
import { STATUS_COLOR, fmt } from './travelUtils';

const EXPENSE_CATEGORIES = [
  { group:'Travel', items:['Flight','Train','Bus','Taxi / Cab','Fuel'] },
  { group:'Stay', items:['Hotel'] },
  { group:'Food & Entertainment', items:['Food / Meals','Customer Meeting'] },
  { group:'On-Site', items:['Site Expenses','Installation Materials','Tools'] },
  { group:'Other', items:['Communication','Miscellaneous'] },
];

const ALL_CATS = EXPENSE_CATEGORIES.flatMap(g => g.items);

const EMPTY = {
  category: 'Flight',
  amount: '',
  gst_amount: '',
  expense_date: '',
  description: '',
  receipt_ref: '',
  google_drive_link: '',
  customer_name: '',
  project_number: '',
  site_name: '',
  opportunity_ref: '',
  po_number: '',
};

const fmtDate = d => d ? d.slice(0,10) : '—';

export default function TravelExpenses() {
  const toast = useToast();
  const [expenses, setExpenses] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form,     setForm]     = useState(EMPTY);
  const [saving,   setSaving]   = useState(false);
  const [search,   setSearch]   = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [catFilter, setCatFilter] = useState('All');

  const load = () => {
    setLoading(true);
    api.get('/travel/expenses')
      .then(r => setExpenses(Array.isArray(r.data) ? r.data : []))
      .catch(() => setExpenses([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const fld = (key, val) => setForm(p => {
    const next = { ...p, [key]: val };
    // Auto-compute total when amount or GST changes
    if (key === 'amount' || key === 'gst_amount') {
      next.total = (Number(next.amount)||0) + (Number(next.gst_amount)||0);
    }
    return next;
  });

  const handleSave = async () => {
    if (!form.amount || !form.expense_date || !form.category) {
      toast.error('Category, Amount and Date are required.'); return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        amount: Number(form.amount) || 0,
        gst_amount: Number(form.gst_amount) || 0,
        total_amount: (Number(form.amount)||0) + (Number(form.gst_amount)||0),
      };
      await api.post('/travel/expenses/v2', payload);
      setShowForm(false); setForm(EMPTY); load();
      toast.success('Expense submitted for reimbursement');
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Save failed. Please try again.');
    } finally { setSaving(false); }
  };

  const filtered = expenses.filter(e => {
    const matchStatus = statusFilter === 'All' || e.status === statusFilter || e.reimbursement_status === statusFilter;
    const matchCat = catFilter === 'All' || e.category === catFilter;
    const matchSearch = !search || [e.category, e.description, e.customer_name, e.project_number, e.po_number]
      .some(v => (v||'').toLowerCase().includes(search.toLowerCase()));
    return matchStatus && matchCat && matchSearch;
  });

  const totalAmt = filtered.reduce((s,e) => s + Number(e.amount||0), 0);
  const totalGST = filtered.reduce((s,e) => s + Number(e.gst_amount||0), 0);
  const totalAll = filtered.reduce((s,e) => s + Number(e.total_amount||e.amount||0), 0);

  const inputStyle = { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
  const labelStyle = { display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:5 };

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Expense Reimbursement</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>
            {filtered.length} entries · Base {fmt(totalAmt)} · GST {fmt(totalGST)} · Total {fmt(totalAll)}
          </p>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Plus size={15}/> Add Expense
        </button>
      </div>

      {/* Summary cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:14, marginBottom:20 }}>
        {[
          { label:'Base Amount', value: fmt(totalAmt), color:'#6366f1' },
          { label:'GST Amount', value: fmt(totalGST), color:'#f59e0b' },
          { label:'Total Claim', value: fmt(totalAll), color:'#10b981' },
        ].map(k => (
          <div key={k.label} style={{ background:'#fff', borderRadius:12, padding:'16px 20px', border:'1px solid #f0f0f4' }}>
            <div style={{ fontSize:12, color:'#9ca3af', fontWeight:600, textTransform:'uppercase', marginBottom:6 }}>{k.label}</div>
            <div style={{ fontSize:22, fontWeight:700, color:k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display:'flex', gap:12, marginBottom:20, flexWrap:'wrap' }}>
        <div style={{ position:'relative', flex:1, minWidth:200 }}>
          <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search category, customer, project, PO..."
            style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
        </div>
        {['All','Pending','Approved','Rejected'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            style={{ padding:'7px 14px', borderRadius:8, border:'1px solid', fontSize:12, fontWeight:500, cursor:'pointer',
              borderColor: statusFilter===s ? '#6B3FDB' : '#e5e7eb',
              background:  statusFilter===s ? '#6B3FDB' : '#fff',
              color:       statusFilter===s ? '#fff'    : '#374151' }}>
            {s}
          </button>
        ))}
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
          style={{ padding:'7px 14px', borderRadius:8, border:'1px solid #e5e7eb', fontSize:12, outline:'none', background:'#fff' }}>
          <option value="All">All Categories</option>
          {ALL_CATS.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      {/* Table */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:60, textAlign:'center', color:'#9ca3af' }}>
            <IndianRupee size={36} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }}/>
            <p style={{ margin:'0 0 16px' }}>{search || statusFilter !== 'All' || catFilter !== 'All' ? 'No expenses match your filters' : 'No expense claims yet'}</p>
            {!search && statusFilter === 'All' && catFilter === 'All' && (
              <button onClick={() => setShowForm(true)} style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>Add First Expense</button>
            )}
          </div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Date','Category','Customer / Project','Base Amt','GST','Total','Drive','Status'].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => {
                const rs = e.reimbursement_status || e.status;
                const sc = STATUS_COLOR[rs] || { bg:'#f3f4f6', color:'#374151' };
                return (
                  <tr key={e.id} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                    <td style={{ padding:'10px 16px', color:'#6b7280' }}>{fmtDate(e.expense_date)}</td>
                    <td style={{ padding:'10px 16px' }}>
                      <div style={{ fontWeight:600, color:'#1f2937' }}>{e.category}</div>
                      {e.description && <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>{e.description}</div>}
                    </td>
                    <td style={{ padding:'10px 16px', color:'#6b7280', maxWidth:160 }}>
                      {e.customer_name && <div style={{ fontWeight:500, color:'#374151' }}>{e.customer_name}</div>}
                      {e.project_number && <div style={{ fontSize:11 }}>{e.project_number}</div>}
                      {e.po_number && <div style={{ fontSize:11, color:'#9ca3af' }}>PO: {e.po_number}</div>}
                    </td>
                    <td style={{ padding:'10px 16px', color:'#374151', fontWeight:500 }}>{fmt(e.amount)}</td>
                    <td style={{ padding:'10px 16px', color:'#f59e0b' }}>{fmt(e.gst_amount||0)}</td>
                    <td style={{ padding:'10px 16px', color:'#10b981', fontWeight:600 }}>{fmt(e.total_amount||e.amount)}</td>
                    <td style={{ padding:'10px 16px' }}>
                      {e.google_drive_link
                        ? <a href={e.google_drive_link} target="_blank" rel="noopener noreferrer" style={{ color:'#6366f1', textDecoration:'none', fontSize:11 }}>
                            <Link size={12} style={{ verticalAlign:'middle', marginRight:3 }}/>View
                          </a>
                        : <span style={{ color:'#d1d5db', fontSize:11 }}>—</span>}
                    </td>
                    <td style={{ padding:'10px 16px' }}>
                      <span style={{ background:sc.bg, color:sc.color, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600 }}>{rs}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Expense Modal */}
      {showForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:680, maxHeight:'92vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
              <h2 style={{ fontSize:18, fontWeight:700, color:'#1f2937', margin:0 }}>Add Expense Claim</h2>
              <button onClick={() => { setShowForm(false); setForm(EMPTY); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>

            {/* Commercial linkage */}
            <div style={{ fontSize:12, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:12 }}>Commercial Linkage</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:20 }}>
              {[
                ['Customer', 'customer_name', 'Customer name'],
                ['Project Number', 'project_number', 'PRJ-2026-0001'],
                ['Site Name', 'site_name', 'Site / location'],
                ['Opportunity Ref', 'opportunity_ref', 'Opportunity reference'],
                ['PO Number', 'po_number', 'Purchase order number'],
              ].map(([lbl, key, ph]) => (
                <div key={key}>
                  <label style={labelStyle}>{lbl}</label>
                  <input value={form[key]} onChange={e => fld(key, e.target.value)} placeholder={ph} style={inputStyle}/>
                </div>
              ))}
            </div>

            {/* Expense details */}
            <div style={{ fontSize:12, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:12 }}>Expense Details</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              <div>
                <label style={labelStyle}>Category *</label>
                <select value={form.category} onChange={e => fld('category', e.target.value)} style={inputStyle}>
                  {EXPENSE_CATEGORIES.map(g => (
                    <optgroup key={g.group} label={g.group}>
                      {g.items.map(c => <option key={c} value={c}>{c}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Expense Date *</label>
                <input type="date" value={form.expense_date} onChange={e => fld('expense_date', e.target.value)} style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Base Amount (₹) *</label>
                <input type="number" value={form.amount} onChange={e => fld('amount', e.target.value)} placeholder="0.00" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>GST Amount (₹)</label>
                <input type="number" value={form.gst_amount} onChange={e => fld('gst_amount', e.target.value)} placeholder="0.00" style={inputStyle}/>
              </div>

              {/* Total (computed) */}
              {(form.amount || form.gst_amount) && (
                <div style={{ gridColumn:'1/-1', background:'#f5f3ff', borderRadius:8, padding:'10px 14px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontSize:13, color:'#6b7280' }}>Total Claim</span>
                  <span style={{ fontSize:18, fontWeight:700, color:'#6B3FDB' }}>
                    {fmt((Number(form.amount)||0) + (Number(form.gst_amount)||0))}
                  </span>
                </div>
              )}

              <div style={{ gridColumn:'1/-1' }}>
                <label style={labelStyle}>Description</label>
                <input value={form.description} onChange={e => fld('description', e.target.value)} placeholder="Brief description of expense" style={inputStyle}/>
              </div>

              <div>
                <label style={labelStyle}>Bill / Receipt Ref</label>
                <input value={form.receipt_ref} onChange={e => fld('receipt_ref', e.target.value)} placeholder="Receipt number or ref" style={inputStyle}/>
              </div>

              <div>
                <label style={labelStyle}>Google Drive Bill Link</label>
                <div style={{ position:'relative' }}>
                  <Link size={13} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
                  <input value={form.google_drive_link} onChange={e => fld('google_drive_link', e.target.value)}
                    placeholder="https://drive.google.com/..."
                    style={{ ...inputStyle, paddingLeft:32 }}/>
                </div>
              </div>
            </div>

            <div style={{ display:'flex', gap:12, justifyContent:'flex-end', marginTop:24 }}>
              <button onClick={() => { setShowForm(false); setForm(EMPTY); }}
                style={{ padding:'9px 20px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13, color:'#374151' }}>Cancel</button>
              <button onClick={handleSave} disabled={saving}
                style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:saving?0.6:1 }}>
                {saving ? 'Submitting...' : 'Submit Claim'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
