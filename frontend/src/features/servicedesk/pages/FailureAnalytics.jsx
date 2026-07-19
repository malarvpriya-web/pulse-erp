import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, AlertTriangle, MapPin, Package, Cpu, Zap } from 'lucide-react';

const CARD = { background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:'20px', marginBottom:16 };
const BTN  = (bg='#6B3FDB') => ({ background:bg, color:'#fff', border:'none', borderRadius:8, padding:'8px 16px', fontSize:13, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:6 });
const INP  = { width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
const LBL  = { display:'block', marginBottom:5, fontSize:11, fontWeight:700, color:'#374151', textTransform:'uppercase', letterSpacing:'.04em' };

const EMPTY_FORM = {
  ticket_id:'', customer_name:'', zone:'', product_name:'', model_number:'', fault_code:'',
  fault_description:'', root_cause:'', root_cause_category:'', component_failed:'', vendor_component:'',
  resolution:'', resolution_time_hrs:'', is_repeat_failure:false, engineer_name:'',
  failure_date:new Date().toISOString().split('T')[0], resolved_date:''
};

export default function FailureAnalytics() {
  const { showToast } = useToast();
  const [tab, setTab] = useState('dashboard');
  const [failures, setFailures] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [byZone, setByZone] = useState([]);
  const [byProduct, setByProduct] = useState([]);
  const [byComponent, setByComponent] = useState([]);
  const [byFault, setByFault] = useState([]);
  const [byEngineer, setByEngineer] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, records, zone, product, comp, fault, eng] = await Promise.allSettled([
        api.get('/failure-analytics/dashboard'),
        api.get('/failure-analytics'),
        api.get('/failure-analytics/analysis/by-zone'),
        api.get('/failure-analytics/analysis/by-product'),
        api.get('/failure-analytics/analysis/by-component'),
        api.get('/failure-analytics/analysis/by-fault-code'),
        api.get('/failure-analytics/analysis/by-engineer'),
      ]);
      if (dash.status === 'fulfilled') setDashboard(dash.value.data);
      if (records.status === 'fulfilled') setFailures(records.value.data);
      if (zone.status === 'fulfilled') setByZone(zone.value.data);
      if (product.status === 'fulfilled') setByProduct(product.value.data);
      if (comp.status === 'fulfilled') setByComponent(comp.value.data);
      if (fault.status === 'fulfilled') setByFault(fault.value.data);
      if (eng.status === 'fulfilled') setByEngineer(eng.value.data);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const logFailure = async () => {
    if (!form.product_name) return showToast('Product name required', 'error');
    try {
      await api.post('/failure-analytics', form);
      showToast('Failure record logged');
      setShowLog(false);
      setForm(EMPTY_FORM);
      load();
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };

  const kpis = dashboard?.kpis || {};

  const HBar = ({ label, value, max, color = '#6B3FDB', sub }) => (
    <div style={{ marginBottom:10 }}>
      <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>
        <span>{label}</span>
        <span style={{ color }}>{value} {sub ? <span style={{ color:'#9ca3af', fontWeight:400 }}>{sub}</span> : ''}</span>
      </div>
      <div style={{ height:8, background:'#f0f0f4', borderRadius:9999, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${max ? (value / max) * 100 : 0}%`, background:color, borderRadius:9999, transition:'width .4s' }} />
      </div>
    </div>
  );

  const maxZone = Math.max(...byZone.map(z => parseInt(z.total_failures)), 1);
  const maxProduct = Math.max(...byProduct.map(p => parseInt(p.total_failures)), 1);
  const maxComp = Math.max(...byComponent.map(c => parseInt(c.failure_count)), 1);
  const maxFault = Math.max(...byFault.map(f => parseInt(f.frequency)), 1);

  return (
    <div style={{ padding:'24px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#111', margin:0 }}>Failure Analytics Engine</h1>
          <p style={{ fontSize:13, color:'#6b7280', margin:'4px 0 0' }}>Track failures by zone, product, component & engineer — product improvement intelligence</p>
        </div>
        <button onClick={() => setShowLog(true)} style={BTN('#dc2626')}><Plus size={14}/>Log Failure</button>
      </div>

      {/* KPI Cards */}
      {dashboard && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:12, marginBottom:20 }}>
          {[
            { label:'Total Failures', value:parseInt(kpis.total||0), color:'#dc2626' },
            { label:'Repeat Failures', value:parseInt(kpis.repeat_failures||0), color:'#d97706' },
            { label:'Avg Resolution', value:kpis.avg_resolution_hrs ? `${parseFloat(kpis.avg_resolution_hrs).toFixed(1)}h` : '—', color:'#6B3FDB' },
            { label:'Zones Affected', value:parseInt(kpis.zones_affected||0), color:'#059669' },
            { label:'Products Affected', value:parseInt(kpis.products_affected||0), color:'#374151' },
          ].map(s => (
            <div key={s.label} style={{ ...CARD, textAlign:'center', margin:0, padding:'16px 20px' }}>
              <div style={{ fontSize:24, fontWeight:800, color:s.color }}>{s.value}</div>
              <div style={{ fontSize:11, color:'#6b7280', marginTop:4, fontWeight:600 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:20, borderBottom:'2px solid #f0f0f4' }}>
        {[['dashboard','Dashboard'],['zone','By Zone'],['product','By Product'],['component','By Component'],['fault','By Fault Code'],['engineer','By Engineer'],['records','All Records']].map(([t,l]) => (
          <button key={t} onClick={() => setTab(t)} style={{ padding:'10px 16px', border:'none', cursor:'pointer', background:'none', fontSize:13, fontWeight:tab===t?700:500, color:tab===t?'#6B3FDB':'#6b7280', borderBottom:tab===t?'2px solid #6B3FDB':'2px solid transparent', marginBottom:-2 }}>
            {l}
          </button>
        ))}
      </div>

      {/* Dashboard */}
      {tab === 'dashboard' && dashboard && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <div style={CARD}>
            <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 16px', display:'flex', alignItems:'center', gap:8 }}>
              <MapPin size={15} color="#dc2626"/>Failures by Zone
            </h3>
            {dashboard.by_zone?.map(z => (
              <HBar key={z.zone} label={z.zone} value={parseInt(z.cnt)} max={Math.max(...(dashboard.by_zone||[]).map(x=>parseInt(x.cnt)),1)} color="#dc2626" />
            ))}
            {!dashboard.by_zone?.length && <div style={{ color:'#9ca3af', fontSize:13 }}>No zone data yet</div>}
          </div>
          <div style={CARD}>
            <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 16px', display:'flex', alignItems:'center', gap:8 }}>
              <Package size={15} color="#d97706"/>Failures by Product
            </h3>
            {dashboard.by_product?.map(p => (
              <HBar key={p.product_name} label={p.product_name} value={parseInt(p.cnt)} max={Math.max(...(dashboard.by_product||[]).map(x=>parseInt(x.cnt)),1)} color="#d97706" />
            ))}
            {!dashboard.by_product?.length && <div style={{ color:'#9ca3af', fontSize:13 }}>No product data yet</div>}
          </div>
          <div style={CARD}>
            <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 16px', display:'flex', alignItems:'center', gap:8 }}>
              <Cpu size={15} color="#6B3FDB"/>Failures by Component
            </h3>
            {dashboard.by_component?.map(c => (
              <HBar key={c.component_failed} label={c.component_failed} value={parseInt(c.cnt)} max={Math.max(...(dashboard.by_component||[]).map(x=>parseInt(x.cnt)),1)} color="#6B3FDB" />
            ))}
            {!dashboard.by_component?.length && <div style={{ color:'#9ca3af', fontSize:13 }}>No component data yet</div>}
          </div>
          <div style={CARD}>
            <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 16px', display:'flex', alignItems:'center', gap:8 }}>
              <Zap size={15} color="#059669"/>Monthly Trend
            </h3>
            {(dashboard.monthly_trend || []).length > 0 ? (
              <div style={{ display:'flex', alignItems:'flex-end', gap:4, height:80 }}>
                {dashboard.monthly_trend.map((m, i) => {
                  const max = Math.max(...dashboard.monthly_trend.map(x => parseInt(x.failures)), 1);
                  const h = Math.max(4, (parseInt(m.failures) / max) * 70);
                  return (
                    <div key={i} title={`${m.month}: ${m.failures} failures`} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                      <div style={{ fontSize:9, color:'#9ca3af' }}>{parseInt(m.failures)}</div>
                      <div style={{ width:'100%', height:h, background:'#dc2626', borderRadius:'2px 2px 0 0', opacity:.8 }} />
                      <div style={{ fontSize:9, color:'#9ca3af', transform:'rotate(-30deg)', transformOrigin:'top' }}>{m.month?.slice(5)}</div>
                    </div>
                  );
                })}
              </div>
            ) : <div style={{ color:'#9ca3af', fontSize:13 }}>No trend data yet</div>}
          </div>
        </div>
      )}

      {/* By Zone */}
      {tab === 'zone' && (
        <div style={CARD}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead><tr style={{ background:'#f9fafb' }}>{['Zone','Total Failures','Repeat Failures','Avg Resolution (hrs)','Products Affected'].map(h=><th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>)}</tr></thead>
            <tbody>
              {byZone.map(z => (
                <tr key={z.zone} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'10px 12px', fontWeight:700, color:'#111' }}>{z.zone}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <div style={{ height:6, width:Math.max(20,(parseInt(z.total_failures)/maxZone)*100)+'px', background:'#dc2626', borderRadius:9999 }} />
                      <span style={{ fontWeight:700, color:'#dc2626' }}>{z.total_failures}</span>
                    </div>
                  </td>
                  <td style={{ padding:'10px 12px', textAlign:'center', color:'#d97706', fontWeight:700 }}>{z.repeat_failures}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center', color:'#374151' }}>{z.avg_resolution_hrs ? `${parseFloat(z.avg_resolution_hrs).toFixed(1)}h` : '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#6b7280', fontSize:12 }}>{(z.products_affected||[]).join(', ') || '—'}</td>
                </tr>
              ))}
              {!byZone.length && <tr><td colSpan={5} style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No zone data</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* By Product */}
      {tab === 'product' && (
        <div style={CARD}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead><tr style={{ background:'#f9fafb' }}>{['Product','Model','Total Failures','Repeat','Avg Resolution','Fault Codes'].map(h=><th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>)}</tr></thead>
            <tbody>
              {byProduct.map((p,i) => (
                <tr key={i} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'10px 12px', fontWeight:700, color:'#111' }}>{p.product_name}</td>
                  <td style={{ padding:'10px 12px', color:'#6b7280', fontFamily:'monospace', fontSize:12 }}>{p.model_number || '—'}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center', fontWeight:700, color:'#d97706' }}>{p.total_failures}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center', color:'#dc2626', fontWeight:600 }}>{p.repeat_failures}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center', color:'#374151' }}>{p.avg_resolution_hrs ? `${parseFloat(p.avg_resolution_hrs).toFixed(1)}h` : '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#6b7280', fontSize:12 }}>{(p.fault_codes||[]).slice(0,3).join(', ')}{(p.fault_codes||[]).length>3?' …':''}</td>
                </tr>
              ))}
              {!byProduct.length && <tr><td colSpan={6} style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No product failure data</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* By Component */}
      {tab === 'component' && (
        <div style={CARD}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead><tr style={{ background:'#f9fafb' }}>{['Component','Vendor / Make','Failure Count','Avg Resolution','Found In Products'].map(h=><th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>)}</tr></thead>
            <tbody>
              {byComponent.map((c,i) => (
                <tr key={i} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'10px 12px', fontWeight:700, color:'#111' }}>{c.component_failed}</td>
                  <td style={{ padding:'10px 12px', color:'#6b7280' }}>{c.vendor_component || '—'}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center' }}>
                    <span style={{ background:'#fee2e2', color:'#991b1b', padding:'2px 10px', borderRadius:9999, fontSize:12, fontWeight:700 }}>{c.failure_count}</span>
                  </td>
                  <td style={{ padding:'10px 12px', textAlign:'center', color:'#374151' }}>{c.avg_resolution_hrs ? `${parseFloat(c.avg_resolution_hrs).toFixed(1)}h` : '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#6b7280', fontSize:12 }}>{(c.in_products||[]).join(', ') || '—'}</td>
                </tr>
              ))}
              {!byComponent.length && <tr><td colSpan={5} style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No component failure data</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* By Fault Code */}
      {tab === 'fault' && (
        <div style={CARD}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead><tr style={{ background:'#f9fafb' }}>{['Fault Code','Description','Frequency','Repeat','Avg Resolution','Root Cause Categories'].map(h=><th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>)}</tr></thead>
            <tbody>
              {byFault.map((f,i) => (
                <tr key={i} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'10px 12px', fontWeight:700, color:'#6B3FDB', fontFamily:'monospace' }}>{f.fault_code}</td>
                  <td style={{ padding:'10px 12px', color:'#374151' }}>{f.fault_description || '—'}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center', fontWeight:700, color:'#dc2626' }}>{f.frequency}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center', color:'#d97706', fontWeight:600 }}>{f.repeat_count}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center', color:'#374151' }}>{f.avg_resolution_hrs ? `${parseFloat(f.avg_resolution_hrs).toFixed(1)}h` : '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#6b7280', fontSize:12 }}>{(f.root_cause_categories||[]).join(', ') || '—'}</td>
                </tr>
              ))}
              {!byFault.length && <tr><td colSpan={6} style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No fault code data</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* By Engineer */}
      {tab === 'engineer' && (
        <div style={CARD}>
          <h3 style={{ fontSize:14, fontWeight:700, margin:'0 0 12px', color:'#374151' }}>Engineers ranked by resolution speed</h3>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead><tr style={{ background:'#f9fafb' }}>{['#','Engineer','Total Resolved','Avg Resolution (hrs)','Best Resolution','Repeat Failures Handled'].map(h=><th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>)}</tr></thead>
            <tbody>
              {byEngineer.map((e,i) => (
                <tr key={i} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'10px 12px', fontWeight:700, color:'#9ca3af' }}>{i+1}</td>
                  <td style={{ padding:'10px 12px', fontWeight:700, color:'#111' }}>{e.engineer_name}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center', color:'#6B3FDB', fontWeight:700 }}>{e.total_resolved}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center' }}>
                    <span style={{ background:parseFloat(e.avg_resolution_hrs||99)<=24?'#d1fae5':parseFloat(e.avg_resolution_hrs||99)<=48?'#fef3c7':'#fee2e2', color:parseFloat(e.avg_resolution_hrs||99)<=24?'#065f46':parseFloat(e.avg_resolution_hrs||99)<=48?'#92400e':'#991b1b', padding:'2px 8px', borderRadius:9999, fontSize:12, fontWeight:700 }}>
                      {e.avg_resolution_hrs ? `${parseFloat(e.avg_resolution_hrs).toFixed(1)}h` : '—'}
                    </span>
                  </td>
                  <td style={{ padding:'10px 12px', textAlign:'center', color:'#059669', fontWeight:600 }}>{e.best_resolution_hrs ? `${parseFloat(e.best_resolution_hrs).toFixed(1)}h` : '—'}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center', color:'#d97706', fontWeight:600 }}>{e.repeat_failures_handled}</td>
                </tr>
              ))}
              {!byEngineer.length && <tr><td colSpan={6} style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No engineer data yet</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Records */}
      {tab === 'records' && (
        <div style={CARD}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
            <thead><tr style={{ background:'#f9fafb' }}>{['Date','Customer','Zone','Product','Fault','Component','Engineer','Resolution (hrs)','Repeat'].map(h=><th key={h} style={{ padding:'8px 10px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>)}</tr></thead>
            <tbody>
              {failures.map(f => (
                <tr key={f.id} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'8px 10px', color:'#6b7280' }}>{f.failure_date ? new Date(f.failure_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                  <td style={{ padding:'8px 10px', color:'#374151' }}>{f.customer_name || '—'}</td>
                  <td style={{ padding:'8px 10px', color:'#374151' }}>{f.zone || '—'}</td>
                  <td style={{ padding:'8px 10px', fontWeight:600, color:'#111' }}>{f.product_name}</td>
                  <td style={{ padding:'8px 10px', color:'#6B3FDB', fontFamily:'monospace', fontSize:11 }}>{f.fault_code || '—'}</td>
                  <td style={{ padding:'8px 10px', color:'#374151' }}>{f.component_failed || '—'}</td>
                  <td style={{ padding:'8px 10px', color:'#374151' }}>{f.engineer_name || '—'}</td>
                  <td style={{ padding:'8px 10px', textAlign:'center' }}>{f.resolution_time_hrs ? `${parseFloat(f.resolution_time_hrs).toFixed(1)}h` : '—'}</td>
                  <td style={{ padding:'8px 10px', textAlign:'center' }}>
                    {f.is_repeat_failure && <span style={{ background:'#fee2e2', color:'#991b1b', padding:'1px 6px', borderRadius:9999, fontSize:10, fontWeight:700 }}>REPEAT</span>}
                  </td>
                </tr>
              ))}
              {!failures.length && <tr><td colSpan={9} style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No failure records yet. Log your first failure to start tracking.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Log Failure Modal */}
      {showLog && (
        <>
          <div onClick={() => setShowLog(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', zIndex:900 }} />
          <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, padding:28, width:580, zIndex:901, maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, margin:0 }}>Log Failure Record</h2>
              <button onClick={() => setShowLog(false)} style={{ background:'none', border:'none', cursor:'pointer' }}><X size={18}/></button>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
              {[
                ['customer_name','Customer Name','text'],['zone','Zone','text'],
                ['product_name','Product Name *','text'],['model_number','Model Number','text'],
                ['fault_code','Fault Code','text'],['engineer_name','Engineer Name','text'],
                ['failure_date','Failure Date','date'],['resolved_date','Resolved Date','date'],
                ['resolution_time_hrs','Resolution Time (hrs)','number'],['component_failed','Component Failed','text'],
                ['vendor_component','Vendor / Make','text'],['root_cause_category','Root Cause Category','text'],
              ].map(([k,l,t]) => (
                <div key={k}>
                  <label style={LBL}>{l}</label>
                  <input type={t} value={form[k]} onChange={e => setForm(p=>({...p,[k]:e.target.value}))} style={INP} />
                </div>
              ))}
              <div style={{ gridColumn:'1/-1' }}>
                <label style={LBL}>Fault Description</label>
                <textarea value={form.fault_description} onChange={e => setForm(p=>({...p,fault_description:e.target.value}))} style={{ ...INP, height:60, resize:'vertical' }} />
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={LBL}>Root Cause</label>
                <textarea value={form.root_cause} onChange={e => setForm(p=>({...p,root_cause:e.target.value}))} style={{ ...INP, height:60, resize:'vertical' }} />
              </div>
              <div style={{ gridColumn:'1/-1' }}>
                <label style={LBL}>Resolution</label>
                <textarea value={form.resolution} onChange={e => setForm(p=>({...p,resolution:e.target.value}))} style={{ ...INP, height:60, resize:'vertical' }} />
              </div>
              <div style={{ gridColumn:'1/-1', display:'flex', alignItems:'center', gap:8 }}>
                <input type="checkbox" id="repeat" checked={form.is_repeat_failure} onChange={e => setForm(p=>({...p,is_repeat_failure:e.target.checked}))} />
                <label htmlFor="repeat" style={{ fontSize:13, fontWeight:600, color:'#374151', cursor:'pointer' }}>This is a repeat failure (same issue recurred)</label>
              </div>
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setShowLog(false)} style={{ padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={logFailure} style={BTN('#dc2626')}>Log Failure</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
