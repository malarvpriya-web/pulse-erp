import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, Search, Plane, Train, Bus } from 'lucide-react';
import { fmt } from './travelUtils';

const MODE_ICON = { Flight: Plane, Train, Bus, Car: Bus, Other: Plane };
const BOOKING_STATUS = {
  Confirmed:       { bg:'#d1fae5', color:'#065f46' },
  Pending:         { bg:'#fef3c7', color:'#92400e' },
  pending_booking: { bg:'#ede9fe', color:'#5b21b6' },
  Cancelled:       { bg:'#fee2e2', color:'#991b1b' },
};
const STATUS_LABEL = { pending_booking: 'Pending Booking' };
const EMPTY = { destination:'', from_date:'', to_date:'', mode:'Flight', airline_train:'', booking_ref:'', cost:'', notes:'' };

export default function TravelBookings() {
  const toast = useToast();
  const [bookings, setBookings] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form,     setForm]     = useState(EMPTY);
  const [saving,   setSaving]   = useState(false);
  const [search,   setSearch]   = useState('');

  const load = () => {
    setLoading(true);
    api.get('/travel/bookings')
      .then(r => setBookings(Array.isArray(r.data) ? r.data : []))
      .catch(() => setBookings([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    if (!form.destination || !form.from_date) return;
    setSaving(true);
    try {
      await api.post('/travel/bookings', { ...form, cost: Number(form.cost) || 0 });
      setShowForm(false); setForm(EMPTY); load();
      toast.success('Travel booking saved successfully');
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Save failed. Please try again.');
    } finally { setSaving(false); }
  };

  const filtered = bookings.filter(b =>
    !search || [b?.destination, b?.mode, b?.booking_ref, b?.employee_name, b?.request_number]
      .some(v => (v ?? '').toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Travel Bookings</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>{bookings.length} bookings</p>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Plus size={15}/> New Booking
        </button>
      </div>

      <div style={{ position:'relative', marginBottom:16, maxWidth:340 }}>
        <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search destination, ref, request..."
          style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
      </div>

      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        {loading ? <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div> :
         filtered.length === 0 ? (
          <div style={{ padding:60, textAlign:'center', color:'#9ca3af' }}>
            <Plane size={36} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }}/>
            <p style={{ margin:'0 0 4px', fontWeight:600 }}>No bookings yet</p>
            <p style={{ margin:'0 0 16px', fontSize:12 }}>Approved travel requests automatically appear here as pending bookings.</p>
            <button onClick={() => setShowForm(true)} style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>Add First Booking</button>
          </div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Request #','Mode','Employee','Destination','Travel Date','Return','Booking Ref','Vendor','Cost','Status'].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((b, i) => {
                const sc = BOOKING_STATUS[b?.status] ?? BOOKING_STATUS.Pending;
                const ModeIcon = MODE_ICON[b?.mode] ?? Plane;
                return (
                  <tr key={b?.id ?? i} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                    <td style={{ padding:'10px 16px', color:'#6b7280', fontFamily:'monospace', fontSize:12 }}>
                      {b?.request_number ?? '—'}
                    </td>
                    <td style={{ padding:'10px 16px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:6, color:'#6B3FDB' }}>
                        <ModeIcon size={14}/><span style={{ fontSize:12 }}>{b?.mode ?? 'TBD'}</span>
                      </div>
                    </td>
                    <td style={{ padding:'10px 16px', fontWeight:500, color:'#1f2937' }}>{b?.employee_name ?? '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#374151' }}>{b?.destination ?? '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#374151' }}>{(b?.from_date ?? '').toString().slice(0,10) || '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#374151' }}>{(b?.to_date ?? '').toString().slice(0,10) || '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#6b7280', fontFamily:'monospace', fontSize:12 }}>{b?.booking_ref ?? '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#6b7280', fontSize:12 }}>{b?.airline_train ?? '—'}</td>
                    <td style={{ padding:'10px 16px', fontWeight:600, color:'#1f2937' }}>{fmt(b?.amount ?? 0)}</td>
                    <td style={{ padding:'10px 16px' }}>
                      <span style={{ background:sc.bg, color:sc.color, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600 }}>
                        {STATUS_LABEL[b?.status] ?? b?.status ?? 'Pending'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:500, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>New Booking</h2>
              <button onClick={() => setShowForm(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
              {[
                { label:'Destination *', key:'destination', placeholder:'e.g. Mumbai', full:true },
                { label:'Travel Date *', key:'from_date', type:'date' },
                { label:'Return Date',   key:'to_date',   type:'date' },
                { label:'Booking Ref',   key:'booking_ref', placeholder:'PNR / Confirmation #' },
                { label:'Cost (₹)',      key:'cost', type:'number', placeholder:'0' },
                { label:'Airline / Train / Vendor', key:'airline_train', placeholder:'IndiGo, Rajdhani...' },
                { label:'Notes',         key:'notes', placeholder:'Seat preference, special requests...', full:true },
              ].map(f => (
                <div key={f.key} style={{ gridColumn:f.full?'1/-1':'auto' }}>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>{f.label}</label>
                  <input type={f.type||'text'} value={form[f.key]} onChange={e => setForm(p=>({...p,[f.key]:e.target.value}))} placeholder={f.placeholder}
                    style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                </div>
              ))}
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Mode</label>
                <select value={form.mode} onChange={e => setForm(p=>({...p,mode:e.target.value}))}
                  style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none' }}>
                  {['Flight','Train','Bus','Car','Other'].map(m => <option key={m}>{m}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setShowForm(false)} style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving||!form.destination||!form.from_date}
                style={{ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:(saving||!form.destination||!form.from_date)?0.6:1 }}>
                {saving?'Saving...':'Save Booking'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
