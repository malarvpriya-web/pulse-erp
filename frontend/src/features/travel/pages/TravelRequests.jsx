import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { Plus, X, Search, ChevronDown, CheckCircle, Clock, AlertCircle } from 'lucide-react';
import { STATUS_COLOR, fmt } from './travelUtils';

const fmtDate = (d) => { if (!d) return '—'; const s = String(d); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.split('-').reverse().join('/'); const dt = new Date(d); return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }); };

const TRAVEL_TYPES = [
  'Sales Visit', 'Customer Meeting', 'Tender Discussion', 'Site Survey',
  'Application Engineering', 'Design Discussion', 'FAT Support', 'Installation',
  'Commissioning', 'Service Visit', 'AMC Visit', 'Training', 'Internal Meeting',
];

const TRAVEL_MODES = ['Flight','Train','Bus','Car','Cab','Two-Wheeler','Other'];
const EMPTY_FORM = {
  destination:'', purpose:'', travel_type:'Sales Visit', from_date:'', to_date:'',
  budget:'', mode:'Flight', hotel_required:false, advance_required:false, notes:'',
  customer_name:'', project_number:'', site_name:'', opportunity_ref:'', po_number:'',
  service_ticket_id:'', employee_name:'', department:'',
};

export default function TravelRequests() {
  const [requests, setRequests] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form,     setForm]     = useState(EMPTY_FORM);
  const [saving,   setSaving]   = useState(false);
  const [search,   setSearch]   = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [error,    setError]    = useState('');
  const [selected, setSelected] = useState(null); // detail view
  const [deptList, setDeptList] = useState([]);

  const load = () => {
    setLoading(true);
    api.get('/travel/requests', { params: { limit: 200 } })
      .then(r => setRequests(Array.isArray(r.data) ? r.data : []))
      .catch(() => setRequests([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  const filtered = requests.filter(r => {
    const matchStatus = statusFilter === 'All' || r.status === statusFilter;
    const matchSearch = !search || [r.destination, r.purpose, r.employee_name, r.customer_name, r.project_number, r.po_number].some(v => (v||'').toLowerCase().includes(search.toLowerCase()));
    return matchStatus && matchSearch;
  });

  const fld = (key, val) => setForm(p => ({...p, [key]: val}));

  const handleSubmit = async () => {
    if (!form.destination || !form.purpose || !form.from_date || !form.to_date) {
      setError('Destination, Purpose, From Date and To Date are required.'); return;
    }
    setSaving(true); setError('');
    try {
      await api.post('/travel/requests/v2', {
        ...form,
        budget: Number(form.budget) || 0,
      });
      setShowForm(false); setForm(EMPTY_FORM); load();
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to submit request.');
    } finally { setSaving(false); }
  };

  const approvalLabel = (level) => {
    if (!level || level === 0) return { label: 'Awaiting RM', color: '#f59e0b' };
    if (level === 1) return { label: 'Awaiting Dept Head', color: '#f59e0b' };
    if (level === 2) return { label: 'Awaiting Management', color: '#f59e0b' };
    return { label: 'Fully Approved', color: '#10b981' };
  };

  const inputStyle = { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
  const labelStyle = { display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:5 };

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Travel Requests</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>{requests.length} total requests</p>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Plus size={15}/> New Request
        </button>
      </div>

      {/* Filters */}
      <div style={{ display:'flex', gap:12, marginBottom:20, flexWrap:'wrap' }}>
        <div style={{ position:'relative', flex:1, minWidth:200 }}>
          <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search destination, customer, PO, project..."
            style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
        </div>
        {['All','Pending','Approved','Rejected','Completed'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            style={{ padding:'7px 14px', borderRadius:8, border:'1px solid', fontSize:12, fontWeight:500, cursor:'pointer',
              borderColor: statusFilter===s ? '#6B3FDB' : '#e5e7eb',
              background:  statusFilter===s ? '#6B3FDB' : '#fff',
              color:       statusFilter===s ? '#fff'    : '#374151' }}>
            {s}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>No requests found.</div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['#','Employee','Type','Destination','Customer / Project','Purpose','Dates','Budget','Status'].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const sc = STATUS_COLOR[r.status] || { bg:'#f3f4f6', color:'#374151' };
                const al = approvalLabel(r.approval_level);
                return (
                  <tr key={r.id} onClick={() => setSelected(r)} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa', cursor:'pointer' }}>
                    <td style={{ padding:'10px 16px', fontWeight:600, color:'#6B3FDB' }}>TR-{String(r?.id ?? '').padStart(3,'0')}</td>
                    <td style={{ padding:'10px 16px', fontWeight:500, color:'#1f2937' }}>{r?.employee_name ?? '—'}</td>
                    <td style={{ padding:'10px 16px' }}>
                      {r?.travel_type
                        ? <span style={{ background:'#f5f3ff', color:'#6B3FDB', padding:'2px 7px', borderRadius:8, fontSize:11, fontWeight:600, whiteSpace:'nowrap' }}>{r.travel_type}</span>
                        : <span style={{ color:'#d1d5db', fontSize:12 }}>—</span>}
                    </td>
                    <td style={{ padding:'10px 16px', color:'#1f2937' }}>{r?.destination ?? '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#6b7280', maxWidth:160 }}>
                      {r?.customer_name ? <div style={{ fontWeight:500, color:'#374151' }}>{r.customer_name}</div> : null}
                      {r?.project_number ? <div style={{ fontSize:11 }}>{r.project_number}</div> : null}
                      {r?.po_number ? <div style={{ fontSize:11, color:'#9ca3af' }}>PO: {r.po_number}</div> : null}
                    </td>
                    <td style={{ padding:'10px 16px', color:'#6b7280', maxWidth:140, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r?.purpose ?? '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#374151', whiteSpace:'nowrap' }}>
                      {fmtDate(r?.from_date)} → {fmtDate(r?.to_date)}
                    </td>
                    <td style={{ padding:'10px 16px', color:'#374151' }}>{fmt(r?.budget ?? 0)}</td>
                    <td style={{ padding:'10px 16px' }}>
                      <span style={{ background:sc.bg, color:sc.color, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600 }}>{r?.status ?? 'pending'}</span>
                      {r?.status === 'Pending' && (
                        <div style={{ fontSize:10, color:al.color, marginTop:3 }}>{al.label}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail modal */}
      {selected && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}
             onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:620, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:18, fontWeight:700, color:'#1f2937', margin:0 }}>TR-{String(selected.id).padStart(3,'0')}</h2>
              <button onClick={() => setSelected(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, fontSize:13 }}>
              {[
                ['Employee', selected?.employee_name ?? '—'],
                ['Department', selected?.department],
                ['Travel Type', selected?.travel_type],
                ['Destination', selected?.destination ?? '—'],
                ['Purpose', selected?.purpose ?? '—'],
                ['Travel Date', fmtDate(selected?.from_date)],
                ['Return Date', fmtDate(selected?.to_date)],
                ['Budget', fmt(selected?.budget ?? 0)],
                ['Mode', selected?.mode ?? 'Not specified'],
                ['Customer', selected?.customer_name],
                ['Project #', selected?.project_number],
                ['Site', selected?.site_name],
                ['Opportunity Ref', selected?.opportunity_ref],
                ['PO Number', selected?.po_number],
                ['Hotel Required', selected?.hotel_required ? 'Yes' : 'No'],
                ['Advance Required', selected?.advance_required ? 'Yes' : 'No'],
                ['Finance Posted', selected?.finance_posted ? 'Yes' : 'No'],
              ].filter(([, v]) => v).map(([label, value]) => (
                <div key={label}>
                  <div style={{ fontSize:11, color:'#9ca3af', fontWeight:600, textTransform:'uppercase', marginBottom:2 }}>{label}</div>
                  <div style={{ fontWeight:500, color:'#1f2937' }}>{value}</div>
                </div>
              ))}
            </div>
            {selected.notes && (
              <div style={{ marginTop:16, padding:12, background:'#f9fafb', borderRadius:8, fontSize:13, color:'#374151' }}>
                <div style={{ fontSize:11, color:'#9ca3af', fontWeight:600, marginBottom:4 }}>NOTES</div>
                {selected.notes}
              </div>
            )}
            {/* Approval levels */}
            <div style={{ marginTop:20 }}>
              <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:10 }}>APPROVAL WORKFLOW</div>
              {['Reporting Manager','Department Head','Management'].map((lvl, i) => {
                const done = (selected.approval_level || 0) > i;
                const active = (selected.approval_level || 0) === i && selected.status === 'Pending';
                return (
                  <div key={lvl} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                    <div style={{
                      width:24, height:24, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                      background: done ? '#10b981' : active ? '#f59e0b' : '#e5e7eb',
                    }}>
                      {done ? <CheckCircle size={14} color="#fff"/> : active ? <Clock size={14} color="#fff"/> : <span style={{ fontSize:11, color:'#9ca3af' }}>{i+1}</span>}
                    </div>
                    <span style={{ fontSize:13, color: done ? '#10b981' : active ? '#f59e0b' : '#9ca3af', fontWeight: active ? 600 : 400 }}>{lvl}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* New Request Modal */}
      {showForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:680, maxHeight:'92vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
              <h2 style={{ fontSize:18, fontWeight:700, color:'#1f2937', margin:0 }}>New Travel Request</h2>
              <button onClick={() => { setShowForm(false); setError(''); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            {error && <div style={{ background:'#fee2e2', color:'#991b1b', padding:'10px 14px', borderRadius:8, marginBottom:16, fontSize:13 }}>{error}</div>}

            {/* Section: Employee */}
            <div style={{ fontSize:12, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:12 }}>Employee Details</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:20 }}>
              <div>
                <label style={labelStyle}>Employee Name</label>
                <input value={form.employee_name} onChange={e => fld('employee_name', e.target.value)} placeholder="Your name" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Department</label>
                <select value={form.department} onChange={e => fld('department', e.target.value)} style={inputStyle}>
                  <option value="">-- Select Department --</option>
                  {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>

            {/* Section: Commercial Linkage */}
            <div style={{ fontSize:12, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:12 }}>Commercial Linkage</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:20 }}>
              {[
                { label:'Customer', key:'customer_name', placeholder:'Customer name' },
                { label:'Project Number', key:'project_number', placeholder:'e.g. PRJ-2026-0001' },
                { label:'Site Name', key:'site_name', placeholder:'Site / location' },
                { label:'Opportunity Ref', key:'opportunity_ref', placeholder:'Opportunity reference' },
                { label:'PO Number', key:'po_number', placeholder:'Purchase order number' },
              ].map(f => (
                <div key={f.key}>
                  <label style={labelStyle}>{f.label}</label>
                  <input value={form[f.key]} onChange={e => fld(f.key, e.target.value)} placeholder={f.placeholder} style={inputStyle}/>
                </div>
              ))}
            </div>

            {/* Section: Travel Details */}
            <div style={{ fontSize:12, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:12 }}>Travel Details</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              <div>
                <label style={labelStyle}>Travel Type *</label>
                <select value={form.travel_type} onChange={e => fld('travel_type', e.target.value)} style={inputStyle}>
                  {TRAVEL_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Service Ticket ID</label>
                <input value={form.service_ticket_id} onChange={e => fld('service_ticket_id', e.target.value)} placeholder="ST-2026-001 (if applicable)" style={inputStyle}/>
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={labelStyle}>Destination *</label>
                <input value={form.destination} onChange={e => fld('destination', e.target.value)} placeholder="e.g. Mumbai, Chennai — Customer Factory" style={inputStyle}/>
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={labelStyle}>Purpose / Objective *</label>
                <input value={form.purpose} onChange={e => fld('purpose', e.target.value)} placeholder="Describe what you'll accomplish on this trip..." style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Start Date *</label>
                <input type="date" value={form.from_date} onChange={e => fld('from_date', e.target.value)} style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>End Date *</label>
                <input type="date" value={form.to_date} onChange={e => fld('to_date', e.target.value)} style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Estimated Cost (₹)</label>
                <input type="number" value={form.budget} onChange={e => fld('budget', e.target.value)} placeholder="0" style={inputStyle}/>
              </div>
              <div>
                <label style={labelStyle}>Travel Mode</label>
                <select value={form.mode} onChange={e => fld('mode', e.target.value)} style={inputStyle}>
                  {TRAVEL_MODES.map(m => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div style={{ display:'flex', flexDirection:'column', justifyContent:'flex-end', gap:10 }}>
                {[['hotel_required','Hotel Required'],['advance_required','Advance Required']].map(([key,lbl]) => (
                  <label key={key} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, color:'#374151', cursor:'pointer' }}>
                    <input type="checkbox" checked={form[key]} onChange={e => fld(key, e.target.checked)} style={{ accentColor:'#6B3FDB', width:14, height:14 }}/>
                    {lbl}
                  </label>
                ))}
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={labelStyle}>Notes</label>
                <textarea value={form.notes} onChange={e => fld('notes', e.target.value)} rows={3}
                  placeholder="Itinerary, special requirements..."
                  style={{ ...inputStyle, resize:'vertical' }}/>
              </div>
            </div>

            <div style={{ display:'flex', gap:12, justifyContent:'flex-end', marginTop:24 }}>
              <button onClick={() => { setShowForm(false); setError(''); }}
                style={{ padding:'9px 20px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13, color:'#374151' }}>Cancel</button>
              <button onClick={handleSubmit} disabled={saving}
                style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:saving?0.6:1 }}>
                {saving ? 'Submitting...' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
