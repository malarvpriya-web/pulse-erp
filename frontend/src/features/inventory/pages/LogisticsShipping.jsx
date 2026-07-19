// frontend/src/features/inventory/pages/LogisticsShipping.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

function formatINR(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '₹0';
  return `₹${Math.round(num).toLocaleString('en-IN')}`;
}

// pending=gray | dispatched=blue | in_transit=purple | delivered=green | returned=red
const SHIP_STATUS = {
  pending:    { bg:'#f3f4f6', color:'#6b7280' },
  dispatched: { bg:'#dbeafe', color:'#2563eb' },
  in_transit: { bg:'#ede9fe', color:'#6B3FDB' },
  'in-transit':{ bg:'#ede9fe', color:'#6B3FDB' },
  delivered:  { bg:'#d1fae5', color:'#16a34a' },
  returned:   { bg:'#fee2e2', color:'#dc2626' },
};

// generated=blue | active=green | cancelled=red | expired=gray
const EWAY_STATUS = {
  generated:  { bg:'#dbeafe', color:'#2563eb' },
  active:     { bg:'#d1fae5', color:'#16a34a' },
  cancelled:  { bg:'#fee2e2', color:'#dc2626' },
  expired:    { bg:'#f3f4f6', color:'#6b7280' },
};

function ewayValidDays(km) {
  const k = parseInt(km) || 0;
  if (k > 300) return 5;
  if (k > 100) return 3;
  return 1;
}

/* ── TAB 1: Shipments ── */
function ShipmentsTab() {
  const toast = useToast();
  const [shipments, setShip] = useState([]);
  const [showNew, setNew]    = useState(false);
  const [tracking, setTrack] = useState(null);
  const [trackLoading, setTL]= useState(false);
  const [form, setForm]      = useState({
    reference_type:'sales_order', reference_id:'', courier_partner:'', tracking_number:'',
    dispatch_date:'', expected_delivery:'', weight_kg:'', freight_cost:'', to_address:'',
    direction:'outbound',
  });
  const [saving, setSaving]  = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/logistics/shipments');
      setShip(res.data?.data || res.data || []);
    } catch { setShip([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openTracking = async (shipment) => {
    setTrack(null); setTL(true);
    try {
      const res = await api.get(`/logistics/shipments/${shipment.id}/track`);
      setTrack({ shipment, events: res.data.tracking?.events || [] });
    } catch {
      setTrack({ shipment, events: [] });
    }
    setTL(false);
  };

  const markDelivered = async (s) => {
    try {
      await api.patch(`/logistics/shipments/${s.id}/deliver`, {});
      setShip(prev => prev.map(x => x.id===s.id ? {...x, status:'delivered', actual_delivery: new Date().toISOString().split('T')[0]} : x));
      toast.success('Marked as delivered');
    } catch(e) {
      toast.error(e?.response?.data?.error || 'Failed to mark delivered');
    }
  };

  const saveShipment = async () => {
    setSaving(true);
    try {
      await api.post('/logistics/shipments', form);
      setNew(false);
      setForm({ reference_type:'sales_order', reference_id:'', courier_partner:'', tracking_number:'', dispatch_date:'', expected_delivery:'', weight_kg:'', freight_cost:'', to_address:'', direction:'outbound' });
      load();
      toast.success('Shipment created');
    } catch(e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to create shipment');
      setNew(false);
      load();
    }
    setSaving(false);
  };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:14 }}>
        <button onClick={()=>setNew(n=>!n)}
          style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'7px 16px', cursor:'pointer', fontWeight:600, fontSize:13 }}>
          {showNew ? '✕ Cancel' : '+ New Shipment'}
        </button>
      </div>

      {showNew && (
        <div style={{ background:'#faf5ff', border:'1px solid #a78bfa', borderRadius:10, padding:18, marginBottom:16 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))', gap:10, marginBottom:12 }}>
            {[
              { label:'Direction',       key:'direction',       type:'select', options:['outbound','inbound'] },
              { label:'Reference Type',  key:'reference_type',  type:'select', options:['sales_order','purchase_order'] },
              { label:'Reference ID',    key:'reference_id',    placeholder:'SO/PO number' },
              { label:'Courier',         key:'courier_partner', placeholder:'BlueDart, DTDC…' },
              { label:'Tracking #',      key:'tracking_number', placeholder:'AWB / Docket #' },
              { label:'Dispatch Date',   key:'dispatch_date',   type:'date' },
              { label:'Expected Delivery',key:'expected_delivery',type:'date' },
              { label:'Weight (kg)',     key:'weight_kg',       placeholder:'12.5', type:'number' },
              { label:'Freight Cost ₹', key:'freight_cost',    placeholder:'850',  type:'number' },
            ].map(f=>(
              <div key={f.key}>
                <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:3 }}>{f.label}</label>
                {f.type==='select' ? (
                  <select value={form[f.key]} onChange={e=>setForm(fm=>({...fm,[f.key]:e.target.value}))}
                    style={{ width:'100%', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}>
                    {f.options.map(o=><option key={o}>{o}</option>)}
                  </select>
                ) : (
                  <input type={f.type||'text'} value={form[f.key]} onChange={e=>setForm(fm=>({...fm,[f.key]:e.target.value}))}
                    placeholder={f.placeholder||''}
                    style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
                )}
              </div>
            ))}
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:3 }}>Destination Address</label>
            <input value={form.to_address} onChange={e=>setForm(f=>({...f,to_address:e.target.value}))} placeholder="Customer / supplier address"
              style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
          </div>
          <button onClick={saveShipment} disabled={saving}
            style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'8px 22px', cursor:'pointer', fontWeight:700, fontSize:13 }}>
            {saving ? 'Saving…' : 'Create Shipment'}
          </button>
        </div>
      )}

      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
          <thead>
            <tr style={{ background:'#f5f3ff' }}>
              {['Tracking #','Courier','To','Dispatch','Expected','Actual','Weight','Cost','Status',''].map(h=>(
                <th key={h} style={{ padding:'9px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600, fontSize:12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shipments.map(s=>{
              const { bg, color } = SHIP_STATUS[s.status] || { bg:'#f3f4f6', color:'#6b7280' };
              const onTime = s.actual_delivery && s.expected_delivery && s.actual_delivery <= s.expected_delivery;
              return (
                <tr key={s.id} style={{ borderBottom:'1px solid #f0ebff' }}>
                  <td style={{ padding:'9px 12px', fontFamily:'monospace', fontSize:12, color:'#6B3FDB', fontWeight:600 }}>{s.tracking_number || '—'}</td>
                  <td style={{ padding:'9px 12px', color:'#374151' }}>{s.courier_partner}</td>
                  <td style={{ padding:'9px 12px', fontSize:12, color:'#6b7280', maxWidth:130, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.to_address}</td>
                  <td style={{ padding:'9px 12px', color:'#6b7280', fontSize:12 }}>{s.dispatch_date || '—'}</td>
                  <td style={{ padding:'9px 12px', color:'#6b7280', fontSize:12 }}>{s.expected_delivery || '—'}</td>
                  <td style={{ padding:'9px 12px', color: s.actual_delivery ? (onTime?'#16a34a':'#dc2626') : '#9ca3af', fontSize:12, fontWeight:s.actual_delivery?600:400 }}>
                    {s.actual_delivery || '—'}
                  </td>
                  <td style={{ padding:'9px 12px', color:'#6b7280', fontSize:12 }}>{s.weight_kg ? `${s.weight_kg}kg` : '—'}</td>
                  <td style={{ padding:'9px 12px', fontWeight:600 }}>{s.freight_cost ? formatINR(s.freight_cost) : '—'}</td>
                  <td style={{ padding:'9px 12px' }}>
                    <span style={{ padding:'2px 9px', borderRadius:10, fontSize:11, fontWeight:700, background:bg, color }}>{s.status}</span>
                  </td>
                  <td style={{ padding:'9px 4px', whiteSpace:'nowrap' }}>
                    {s.status !== 'delivered' && s.status !== 'returned' && (
                      <button onClick={()=>markDelivered(s)}
                        style={{ background:'#d1fae5', color:'#16a34a', border:'none', borderRadius:6, padding:'3px 8px', cursor:'pointer', fontSize:11, fontWeight:600, marginRight:4 }}>
                        Deliver
                      </button>
                    )}
                    <button onClick={()=>openTracking(s)} disabled={trackLoading}
                      style={{ background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:6, padding:'3px 8px', cursor:'pointer', fontSize:11, fontWeight:600 }}>
                      Track
                    </button>
                  </td>
                </tr>
              );
            })}
            {!shipments.length && (
              <tr><td colSpan={10} style={{ padding:24, textAlign:'center', color:'#9ca3af', fontSize:13 }}>No shipments yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {tracking && (
        <div style={{ position:'fixed', right:0, top:0, bottom:0, width:360, background:'#fff', boxShadow:'-4px 0 20px rgba(0,0,0,0.12)', zIndex:500, overflowY:'auto', padding:24 }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:16 }}>
            <div>
              <div style={{ fontWeight:700, color:'#6B3FDB', fontSize:13 }}>{tracking.shipment.tracking_number}</div>
              <div style={{ fontSize:12, color:'#6b7280' }}>{tracking.shipment.courier_partner}</div>
            </div>
            <button onClick={()=>setTrack(null)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:'#6b7280' }}>✕</button>
          </div>
          {tracking.events.length === 0 && (
            <p style={{ color:'#9ca3af', fontSize:13 }}>No tracking events available. Live tracking requires Shiprocket API credentials.</p>
          )}
          <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
            {tracking.events.map((ev, i)=>{
              const isLast = i === tracking.events.length - 1;
              const isDone = ev.status === 'delivered';
              return (
                <div key={i} style={{ display:'flex', gap:14 }}>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'center' }}>
                    <div style={{ width:12, height:12, borderRadius:'50%', background: isDone?'#16a34a':isLast?'#6B3FDB':'#c4b5fd', flexShrink:0, marginTop:2 }}/>
                    {!isLast && <div style={{ width:2, flex:1, background:'#e9e4ff', minHeight:30 }}/>}
                  </div>
                  <div style={{ paddingBottom:20 }}>
                    <div style={{ fontWeight:600, color:'#1f2937', fontSize:13 }}>{ev.event}</div>
                    <div style={{ fontSize:11, color:'#6b7280' }}>{ev.location}</div>
                    <div style={{ fontSize:10, color:'#9ca3af', marginTop:2 }}>
                      {new Date(ev.timestamp).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── TAB 2: E-Way Bills ── */
function EWayBillsTab() {
  const toast = useToast();
  const [bills, setBills]     = useState([]);
  const [showGen, setGen]     = useState(false);
  const [form, setForm]       = useState({
    eway_bill_number:'', from_gstin:'', to_gstin:'', vehicle_number:'',
    distance_km:'', taxable_value:'', transport_mode:'road', supply_type:'outward',
    shipment_id:'', goods_description:'',
  });
  const [saving, setSaving]   = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/logistics/eway-bills');
      setBills(res.data?.data || res.data || []);
    } catch { setBills([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-compute valid_until from distance
  const validDays = form.distance_km ? ewayValidDays(form.distance_km) : null;
  const validUntilPreview = validDays != null
    ? (() => { const d = new Date(); d.setDate(d.getDate() + validDays); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }); })()
    : null;

  const saveBill = async () => {
    if (!form.eway_bill_number) { toast.error('E-Way Bill number is required'); return; }
    setSaving(true);
    try {
      await api.post('/logistics/eway-bills', form);
      setGen(false);
      setForm({ eway_bill_number:'', from_gstin:'', to_gstin:'', vehicle_number:'', distance_km:'', taxable_value:'', transport_mode:'road', supply_type:'outward', shipment_id:'', goods_description:'' });
      load();
      toast.success('E-Way Bill recorded');
    } catch(e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to save E-Way Bill');
    }
    setSaving(false);
  };

  const cancelBill = async (id) => {
    try {
      await api.patch(`/logistics/eway-bills/${id}/cancel`, {});
      setBills(prev => prev.map(b => b.id===id ? {...b, status:'cancelled'} : b));
      toast.success('E-Way Bill cancelled');
    } catch(e) {
      toast.error(e?.response?.data?.error || 'Failed to cancel');
    }
  };

  return (
    <div>
      {/* Note banner */}
      <div style={{ background:'#fef9c3', border:'1px solid #fde047', borderRadius:8, padding:'10px 14px', marginBottom:14, display:'flex', alignItems:'center', gap:8 }}>
        <span style={{ fontSize:15 }}>⚡</span>
        <span style={{ fontSize:12, color:'#854d0e', fontWeight:500 }}>
          E-Way Bill is required for consignment value exceeding <strong>₹50,000</strong>. Enter the bill number from the GST portal manually.
        </span>
      </div>

      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:14 }}>
        <button onClick={()=>setGen(g=>!g)}
          style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'7px 16px', cursor:'pointer', fontWeight:600, fontSize:13 }}>
          {showGen ? '✕ Cancel' : '+ Generate E-Way Bill'}
        </button>
      </div>

      {showGen && (
        <div style={{ background:'#faf5ff', border:'1px solid #a78bfa', borderRadius:10, padding:18, marginBottom:16 }}>
          <h4 style={{ margin:'0 0 12px', color:'#4c1d95', fontSize:14 }}>Record E-Way Bill</h4>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:10, marginBottom:12 }}>
            {[
              { label:'E-Way Bill No. *', key:'eway_bill_number', placeholder:'EWB-1234567890' },
              { label:'Supplier GSTIN',   key:'from_gstin',       placeholder:'27AAACM0000A1ZP' },
              { label:'Recipient GSTIN',  key:'to_gstin',         placeholder:'29AABCN0000A1Z2' },
              { label:'Vehicle Number',   key:'vehicle_number',   placeholder:'MH04AB1234' },
              { label:'Distance (km)',    key:'distance_km',      placeholder:'980',  type:'number' },
              { label:'Invoice Value ₹', key:'taxable_value',    placeholder:'550000', type:'number' },
              { label:'Shipment ID',      key:'shipment_id',      placeholder:'(optional)', type:'number' },
            ].map(f=>(
              <div key={f.key}>
                <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:3 }}>{f.label}</label>
                <input type={f.type||'text'} value={form[f.key]} onChange={e=>setForm(fm=>({...fm,[f.key]:e.target.value}))}
                  placeholder={f.placeholder}
                  style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
              </div>
            ))}
            <div>
              <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:3 }}>Transport Mode</label>
              <select value={form.transport_mode} onChange={e=>setForm(fm=>({...fm,transport_mode:e.target.value}))}
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}>
                {['road','rail','air','ship'].map(m=><option key={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:3 }}>Supply Type</label>
              <select value={form.supply_type} onChange={e=>setForm(fm=>({...fm,supply_type:e.target.value}))}
                style={{ width:'100%', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}>
                <option value="outward">Outward</option>
                <option value="inward">Inward</option>
              </select>
            </div>
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:600, color:'#4c1d95', marginBottom:3 }}>Goods Description</label>
            <input value={form.goods_description} onChange={e=>setForm(f=>({...f,goods_description:e.target.value}))} placeholder="e.g. Electrical panels and components"
              style={{ width:'100%', boxSizing:'border-box', padding:'7px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
          </div>

          {/* Validity preview */}
          {validDays != null && (
            <div style={{ background:'#f0fdf4', border:'1px solid #86efac', borderRadius:7, padding:'8px 12px', marginBottom:12, fontSize:12, color:'#16a34a', fontWeight:500 }}>
              Valid for <strong>{validDays} day{validDays>1?'s':''}</strong> (distance {form.distance_km} km) — expires <strong>{validUntilPreview}</strong>
              <span style={{ color:'#6b7280', fontWeight:400, marginLeft:8 }}>
                (≤100km→1d · 101–300km→3d · &gt;300km→5d)
              </span>
            </div>
          )}

          <button onClick={saveBill} disabled={saving}
            style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'8px 22px', cursor:'pointer', fontWeight:700, fontSize:13 }}>
            {saving ? 'Saving…' : 'Save E-Way Bill'}
          </button>
        </div>
      )}

      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
          <thead>
            <tr style={{ background:'#f5f3ff' }}>
              {['E-Way No','Supplier GSTIN','Recipient GSTIN','Invoice Value','Vehicle','Valid Until','Status',''].map(h=>(
                <th key={h} style={{ padding:'9px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600, fontSize:12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bills.map(b => {
              const isExpired = b.expired || b.status === 'expired';
              const displayStatus = b.status === 'cancelled' ? 'cancelled' : isExpired ? 'expired' : (b.status || 'active');
              const { bg, color } = EWAY_STATUS[displayStatus] || { bg:'#f3f4f6', color:'#6b7280' };
              return (
                <tr key={b.id} style={{ borderBottom:'1px solid #f0ebff', background: isExpired ? '#fafafa' : '#fff' }}>
                  <td style={{ padding:'9px 12px', fontFamily:'monospace', fontWeight:700, color:'#4c1d95', fontSize:12, letterSpacing:1 }}>{b.eway_bill_number}</td>
                  <td style={{ padding:'9px 12px', fontFamily:'monospace', fontSize:11, color:'#6b7280' }}>{b.from_gstin || '—'}</td>
                  <td style={{ padding:'9px 12px', fontFamily:'monospace', fontSize:11, color:'#6b7280' }}>{b.to_gstin || '—'}</td>
                  <td style={{ padding:'9px 12px', fontWeight:600 }}>{b.taxable_value ? formatINR(b.taxable_value) : '—'}</td>
                  <td style={{ padding:'9px 12px', color:'#374151' }}>{b.vehicle_number || '—'}</td>
                  <td style={{ padding:'9px 12px', color: isExpired ? '#dc2626' : '#16a34a', fontWeight:600, fontSize:12 }}>
                    {b.valid_until ? new Date(b.valid_until).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                  </td>
                  <td style={{ padding:'9px 12px' }}>
                    <span style={{ padding:'2px 9px', borderRadius:10, fontSize:11, fontWeight:700, background:bg, color }}>{displayStatus}</span>
                  </td>
                  <td style={{ padding:'9px 12px' }}>
                    {b.status !== 'cancelled' && !isExpired && (
                      <button onClick={()=>cancelBill(b.id)}
                        style={{ background:'#fee2e2', color:'#dc2626', border:'none', borderRadius:6, padding:'3px 8px', cursor:'pointer', fontSize:11, fontWeight:600 }}>
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!bills.length && (
              <tr><td colSpan={8} style={{ padding:24, textAlign:'center', color:'#9ca3af', fontSize:13 }}>No e-way bills yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── MAIN ── */
export default function LogisticsShipping() {
  const [tab, setTab] = useState('Shipments');

  const tabStyle = (t) => ({
    padding:'9px 20px', border:'none', cursor:'pointer', fontWeight:600, fontSize:13,
    background: tab===t ? '#6B3FDB' : 'transparent',
    color:      tab===t ? '#fff'    : '#6B3FDB',
    borderBottom: tab===t ? '2px solid #6B3FDB' : '2px solid transparent',
  });

  return (
    <div style={{ padding:24, background:'#f5f3ff', minHeight:'100vh' }}>
      <div style={{ marginBottom:20 }}>
        <h2 style={{ margin:'0 0 4px', color:'#4c1d95', fontSize:22 }}>Logistics & Shipping</h2>
        <p style={{ margin:0, color:'#6b7280', fontSize:13 }}>Shipment tracking, courier management, and e-way bill recording</p>
      </div>
      <div style={{ display:'flex', gap:0, borderBottom:'2px solid #e9e4ff', background:'#fff', borderRadius:'10px 10px 0 0', padding:'0 8px' }}>
        {['Shipments','E-Way Bills'].map(t=><button key={t} style={tabStyle(t)} onClick={()=>setTab(t)}>{t}</button>)}
      </div>
      <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderTop:'none', borderRadius:'0 0 10px 10px', padding:20 }}>
        {tab==='Shipments'   && <ShipmentsTab />}
        {tab==='E-Way Bills' && <EWayBillsTab />}
      </div>
    </div>
  );
}
