import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { getPosition } from '@/mobile/native';
import { useToast } from '@/context/ToastContext';
import { Plus, MapPin, CheckCircle, Circle, Camera, Zap, FileText, X, ChevronDown, ChevronUp, Award, Shield } from 'lucide-react';

const CARD  = { background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:'20px', marginBottom:16 };
const BTN   = (bg='#6B3FDB') => ({ background:bg, color:'#fff', border:'none', borderRadius:8, padding:'8px 16px', fontSize:13, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:6 });
const INP   = { width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
const LBL   = { display:'block', marginBottom:5, fontSize:11, fontWeight:700, color:'#374151', textTransform:'uppercase', letterSpacing:'.04em' };

const STATUS_COLOR = { pending:'#fef3c7', in_progress:'#dbeafe', signed_off:'#fce7f3', completed:'#d1fae5' };
const STATUS_TEXT  = { pending:'#92400e', in_progress:'#1e40af', signed_off:'#9d174d', completed:'#065f46' };

const EMPTY_FORM = {
  project_id:'', equipment_id:'', customer_name:'', site_name:'', site_address:'',
  engineer_id:'', engineer_name:'', fat_reference:'', sat_reference:'', scheduled_date:'', notes:''
};

export default function CommissioningWorkflow() {
  const { showToast } = useToast();
  const [workflows, setWorkflows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [activeSection, setActiveSection] = useState('checklist');
  const [signoffForm, setSignoffForm] = useState({ customer_sign_name:'', customer_feedback:'', customer_rating:5 });
  const [showSignoff, setShowSignoff] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/commissioning');
      setWorkflows(data);
    } catch { showToast('Failed to load workflows', 'error'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadDetail = async (id) => {
    try {
      const { data } = await api.get(`/commissioning/${id}`);
      setDetail(data);
      setSelected(id);
    } catch { showToast('Failed to load details', 'error'); }
  };

  const createWorkflow = async () => {
    if (!form.customer_name || !form.scheduled_date) return showToast('Customer name and date required', 'error');
    try {
      const { data } = await api.post('/commissioning', form);
      showToast('Commissioning workflow created');
      setShowCreate(false);
      setForm(EMPTY_FORM);
      load();
      loadDetail(data.id);
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };

  const handleCheckin = async () => {
    let pos;
    try { pos = await getPosition(); }             // native GPS on device, browser geo on web
    catch { return showToast('Could not get GPS location', 'error'); }
    try {
      await api.post(`/commissioning/${selected}/checkin`, {
        lat: pos.latitude, lng: pos.longitude,
        address: `GPS: ${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`
      });
      showToast('Checked in with GPS location');
      loadDetail(selected);
    } catch (err) { showToast(err.response?.data?.error || 'Check-in failed', 'error'); }
  };

  const toggleChecklistItem = async (itemId, current) => {
    try {
      await api.put(`/commissioning/${selected}/checklist/${itemId}`, { is_completed: !current });
      loadDetail(selected);
    } catch { showToast('Failed to update checklist', 'error'); }
  };

  const updateReading = async (readingId, measured_value, status) => {
    try {
      await api.put(`/commissioning/${selected}/readings/${readingId}`, { measured_value, status });
      loadDetail(selected);
    } catch { showToast('Failed to update reading', 'error'); }
  };

  const doSignoff = async () => {
    if (!signoffForm.customer_sign_name) return showToast('Customer name required', 'error');
    try {
      await api.post(`/commissioning/${selected}/signoff`, signoffForm);
      showToast('Customer sign-off recorded');
      setShowSignoff(false);
      loadDetail(selected);
    } catch (err) { showToast(err.response?.data?.error || 'Sign-off failed', 'error'); }
  };

  const issueCertificate = async () => {
    try {
      await api.post(`/commissioning/${selected}/issue-certificate`);
      showToast('Commissioning certificate issued!');
      loadDetail(selected);
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };

  const activateWarranty = async () => {
    try {
      await api.post(`/commissioning/${selected}/activate-warranty`, { warranty_months: 12 });
      showToast('Warranty activated for 12 months!');
      loadDetail(selected);
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };

  const Section = ({ id, title, icon, children }) => {
    const open = activeSection === id;
    return (
      <div style={{ border:'1px solid #f0f0f4', borderRadius:10, marginBottom:10, overflow:'hidden' }}>
        <button onClick={() => setActiveSection(open ? null : id)} style={{ width:'100%', padding:'12px 16px', background:open?'#f5f3ff':'#f9fafb', border:'none', cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:14, fontWeight:700, color:open?'#6B3FDB':'#374151' }}>
          <span style={{ display:'flex', alignItems:'center', gap:8 }}>{icon} {title}</span>
          {open ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
        </button>
        {open && <div style={{ padding:16 }}>{children}</div>}
      </div>
    );
  };

  if (selected && detail) {
    const pct = detail.progress?.pct || 0;
    const mandDone = detail.progress?.mandatory_done || 0;
    const mandTotal = detail.progress?.mandatory_total || 0;
    const byCategory = {};
    (detail.checklist || []).forEach(item => {
      if (!byCategory[item.category]) byCategory[item.category] = [];
      byCategory[item.category].push(item);
    });

    return (
      <div style={{ padding:'24px', margin:'0 auto' }}>
        <button onClick={() => { setSelected(null); setDetail(null); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#6B3FDB', fontSize:13, marginBottom:16, display:'flex', alignItems:'center', gap:4 }}>
          ← Back to commissioning list
        </button>

        {/* Header */}
        <div style={{ ...CARD, background:'linear-gradient(135deg,#f5f3ff,#ede9fe)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
            <div>
              <div style={{ fontSize:12, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:4 }}>{detail.workflow_number}</div>
              <h2 style={{ fontSize:20, fontWeight:800, margin:'0 0 4px' }}>{detail.customer_name}</h2>
              <div style={{ fontSize:13, color:'#374151' }}>{detail.site_name} {detail.site_address ? `• ${detail.site_address}` : ''}</div>
              <div style={{ fontSize:12, color:'#6b7280', marginTop:4 }}>Engineer: <strong>{detail.engineer_name || '—'}</strong> • Scheduled: {detail.scheduled_date ? new Date(detail.scheduled_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</div>
            </div>
            <div style={{ textAlign:'right' }}>
              <span style={{ background:STATUS_COLOR[detail.status]||'#f3f4f6', color:STATUS_TEXT[detail.status]||'#374151', padding:'5px 14px', borderRadius:9999, fontSize:12, fontWeight:700, textTransform:'capitalize', display:'inline-block', marginBottom:8 }}>
                {detail.status?.replace('_',' ')}
              </span>
              <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
                {detail.status === 'pending' && (
                  <button onClick={handleCheckin} style={BTN('#059669')}><MapPin size={14}/>GPS Check-In</button>
                )}
                {detail.status === 'in_progress' && (
                  <button onClick={() => setShowSignoff(true)} style={BTN('#d97706')}><FileText size={14}/>Customer Sign-Off</button>
                )}
                {detail.status === 'signed_off' && !detail.certificate_issued && (
                  <button onClick={issueCertificate} style={BTN('#6B3FDB')}><Award size={14}/>Issue Certificate</button>
                )}
                {detail.certificate_issued && !detail.warranty_activated && (
                  <button onClick={activateWarranty} style={BTN('#059669')}><Shield size={14}/>Activate Warranty</button>
                )}
              </div>
            </div>
          </div>

          {/* Progress Bar */}
          <div style={{ marginTop:16 }}>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'#374151', marginBottom:6, fontWeight:600 }}>
              <span>Checklist Progress</span>
              <span>{pct}% ({mandDone}/{mandTotal} mandatory)</span>
            </div>
            <div style={{ height:8, background:'#e9e4ff', borderRadius:9999, overflow:'hidden' }}>
              <div style={{ height:'100%', width:`${pct}%`, background:'linear-gradient(90deg,#6B3FDB,#a855f7)', borderRadius:9999, transition:'width .4s' }} />
            </div>
          </div>

          {/* GPS check-in info */}
          {detail.checkin_time && (
            <div style={{ marginTop:10, fontSize:12, color:'#059669', fontWeight:600 }}>
              ✓ Checked in at {new Date(detail.checkin_time).toLocaleTimeString('en-IN')} — {detail.checkin_address}
            </div>
          )}
          {detail.certificate_issued && (
            <div style={{ marginTop:6, fontSize:12, color:'#6B3FDB', fontWeight:600 }}>
              🏆 Certificate: {detail.certificate_number}
            </div>
          )}
          {detail.warranty_activated && (
            <div style={{ fontSize:12, color:'#059669', fontWeight:600 }}>
              🛡 Warranty activated {new Date(detail.warranty_activated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
            </div>
          )}
        </div>

        {/* Collapsible Sections */}

        {/* Checklist */}
        <Section id="checklist" title={`Checklist (${detail.progress?.done||0}/${detail.progress?.total||0})`} icon={<CheckCircle size={16}/>}>
          {Object.entries(byCategory).map(([cat, items]) => (
            <div key={cat} style={{ marginBottom:16 }}>
              <div style={{ fontSize:12, fontWeight:700, color:'#6b7280', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8, paddingBottom:6, borderBottom:'1px solid #f0f0f4' }}>{cat}</div>
              {items.map(item => (
                <div key={item.id} onClick={() => toggleChecklistItem(item.id, item.is_completed)}
                  style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'10px 8px', borderRadius:8, cursor:'pointer', background:item.is_completed?'#f0fdf4':'transparent', marginBottom:4, transition:'background .15s' }}>
                  <div style={{ color:item.is_completed?'#059669':'#d1d5db', flexShrink:0, marginTop:1 }}>
                    {item.is_completed ? <CheckCircle size={18}/> : <Circle size={18}/>}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, color:item.is_completed?'#059669':'#374151', fontWeight:item.is_mandatory?600:400, textDecoration:item.is_completed?'line-through':'none' }}>
                      {item.item_text} {item.is_mandatory && <span style={{ fontSize:10, color:'#dc2626', marginLeft:4 }}>*</span>}
                    </div>
                    {item.completed_by && <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>✓ by {item.completed_by}</div>}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </Section>

        {/* Readings */}
        <Section id="readings" title="Parameter Readings" icon={<Zap size={16}/>}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Parameter','Unit','Set Value','Measured Value','Status'].map(h => (
                  <th key={h} style={{ padding:'8px 10px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(detail.readings || []).map(r => (
                <tr key={r.id} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'8px 10px', fontWeight:600, color:'#374151' }}>{r.parameter}</td>
                  <td style={{ padding:'8px 10px', color:'#6b7280' }}>{r.unit || '—'}</td>
                  <td style={{ padding:'8px 10px', color:'#374151' }}>{r.set_value || '—'}</td>
                  <td style={{ padding:'8px 10px' }}>
                    <input type="text" defaultValue={r.measured_value || ''} onBlur={e => { if (e.target.value !== r.measured_value) updateReading(r.id, e.target.value, r.status); }}
                      style={{ ...INP, width:100, padding:'4px 8px', fontSize:12 }} placeholder="Enter reading" />
                  </td>
                  <td style={{ padding:'8px 10px' }}>
                    <select value={r.status} onChange={e => updateReading(r.id, r.measured_value, e.target.value)}
                      style={{ padding:'4px 8px', border:'1px solid #e5e7eb', borderRadius:6, fontSize:12, cursor:'pointer' }}>
                      {['ok','warning','fail','na'].map(s => <option key={s} value={s}>{s.toUpperCase()}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* Photos */}
        <Section id="photos" title={`Photos (${(detail.photos||[]).length})`} icon={<Camera size={16}/>}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:10, marginBottom:14 }}>
            {(detail.photos || []).map(p => (
              <div key={p.id} style={{ position:'relative' }}>
                <div style={{ aspectRatio:'4/3', background:'#f3f4f6', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', border:'1px solid #e5e7eb' }}>
                  <img src={p.file_path} alt={p.caption} style={{ width:'100%', height:'100%', objectFit:'cover', borderRadius:8 }} onError={e => { e.target.style.display='none'; }} />
                  <Camera size={24} color="#9ca3af" style={{ position:'absolute' }}/>
                </div>
                {p.caption && <div style={{ fontSize:11, color:'#6b7280', marginTop:4, textAlign:'center' }}>{p.caption}</div>}
                <div style={{ fontSize:10, color:'#9ca3af', textAlign:'center' }}>{p.phase}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize:12, color:'#9ca3af', fontStyle:'italic' }}>
            Photos are uploaded via the mobile commissioning app or through file upload.
          </div>
        </Section>

        {/* Customer Sign-off */}
        {(detail.customer_sign_name || detail.status === 'signed_off' || detail.status === 'completed') && (
          <Section id="signoff" title="Customer Sign-Off" icon={<FileText size={16}/>}>
            {detail.customer_sign_name ? (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, background:'#f0fdf4', padding:16, borderRadius:10 }}>
                {[['Customer Name', detail.customer_sign_name],['Rating', detail.customer_rating ? '⭐'.repeat(detail.customer_rating) : '—'],['Signed At', detail.customer_sign_time ? new Date(detail.customer_sign_time).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—']].map(([k,v]) => (
                  <div key={k}><div style={{ fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{k}</div><div style={{ fontSize:13, fontWeight:600, color:'#111', marginTop:2 }}>{v}</div></div>
                ))}
                {detail.customer_feedback && (
                  <div style={{ gridColumn:'1/-1', marginTop:8 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>Feedback</div>
                    <div style={{ fontSize:13, color:'#374151', marginTop:4 }}>{detail.customer_feedback}</div>
                  </div>
                )}
              </div>
            ) : <div style={{ color:'#9ca3af', fontSize:13 }}>No sign-off recorded yet</div>}
          </Section>
        )}

        {/* Sign-off Modal */}
        {showSignoff && (
          <>
            <div onClick={() => setShowSignoff(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', zIndex:900 }} />
            <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, padding:28, width:440, zIndex:901 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
                <h2 style={{ fontSize:17, fontWeight:700, margin:0 }}>Customer Sign-Off</h2>
                <button onClick={() => setShowSignoff(false)} style={{ background:'none', border:'none', cursor:'pointer' }}><X size={18}/></button>
              </div>
              <div style={{ marginBottom:14 }}>
                <label style={LBL}>Customer Representative Name *</label>
                <input type="text" value={signoffForm.customer_sign_name} onChange={e => setSignoffForm(p=>({...p,customer_sign_name:e.target.value}))} style={INP} placeholder="Full name of authorized representative" />
              </div>
              <div style={{ marginBottom:14 }}>
                <label style={LBL}>Customer Rating (1-5)</label>
                <div style={{ display:'flex', gap:8 }}>
                  {[1,2,3,4,5].map(n => (
                    <button key={n} onClick={() => setSignoffForm(p=>({...p,customer_rating:n}))}
                      style={{ width:40, height:40, borderRadius:9999, border:`2px solid ${signoffForm.customer_rating>=n?'#d97706':'#e5e7eb'}`, background:signoffForm.customer_rating>=n?'#fef3c7':'#fff', fontSize:18, cursor:'pointer' }}>⭐</button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom:20 }}>
                <label style={LBL}>Customer Feedback</label>
                <textarea value={signoffForm.customer_feedback} onChange={e => setSignoffForm(p=>({...p,customer_feedback:e.target.value}))} style={{ ...INP, height:80, resize:'vertical' }} placeholder="Any observations or comments..." />
              </div>
              <div style={{ background:'#fef3c7', borderRadius:8, padding:'10px 12px', fontSize:12, color:'#92400e', marginBottom:16 }}>
                ⚠ All mandatory checklist items must be completed before sign-off.
              </div>
              <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                <button onClick={() => setShowSignoff(false)} style={{ padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
                <button onClick={doSignoff} style={BTN('#d97706')}>Confirm Sign-Off</button>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding:'24px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#111', margin:0 }}>Commissioning Workflows</h1>
          <p style={{ fontSize:13, color:'#6b7280', margin:'4px 0 0' }}>GPS check-in → checklist → readings → sign-off → certificate → warranty</p>
        </div>
        <button onClick={() => setShowCreate(true)} style={BTN()}><Plus size={14}/>New Commissioning</button>
      </div>

      {/* Status Summary */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:20 }}>
        {[['pending','Pending','#fef3c7','#92400e'],['in_progress','In Progress','#dbeafe','#1e40af'],['signed_off','Signed Off','#fce7f3','#9d174d'],['completed','Completed','#d1fae5','#065f46']].map(([s,l,bg,c]) => {
          const cnt = workflows.filter(w => w.status === s).length;
          return (
            <div key={s} style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:10, padding:'14px 16px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div>
                <div style={{ fontSize:22, fontWeight:800, color:c }}>{cnt}</div>
                <div style={{ fontSize:12, color:'#6b7280' }}>{l}</div>
              </div>
              <span style={{ background:bg, color:c, padding:'4px 10px', borderRadius:9999, fontSize:11, fontWeight:700 }}>{s.replace('_',' ')}</span>
            </div>
          );
        })}
      </div>

      {/* Workflow List */}
      <div style={CARD}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
          <thead>
            <tr style={{ background:'#f9fafb' }}>
              {['Workflow #','Customer','Site','Engineer','Scheduled','Status','Progress','Action'].map(h => (
                <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {workflows.map(w => (
              <tr key={w.id} style={{ borderTop:'1px solid #f3f4f6', cursor:'pointer' }} onClick={() => loadDetail(w.id)}
                onMouseEnter={e => e.currentTarget.style.background='#f9fafb'} onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                <td style={{ padding:'10px 12px', fontWeight:700, color:'#6B3FDB' }}>{w.workflow_number}</td>
                <td style={{ padding:'10px 12px', fontWeight:600, color:'#111' }}>{w.customer_name}</td>
                <td style={{ padding:'10px 12px', color:'#6b7280' }}>{w.site_name || w.site_location || '—'}</td>
                <td style={{ padding:'10px 12px', color:'#374151' }}>{w.engineer_name || '—'}</td>
                <td style={{ padding:'10px 12px', color:'#6b7280' }}>{w.scheduled_date ? new Date(w.scheduled_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                <td style={{ padding:'10px 12px' }}>
                  <span style={{ background:STATUS_COLOR[w.status]||'#f3f4f6', color:STATUS_TEXT[w.status]||'#374151', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700, textTransform:'capitalize' }}>
                    {w.status?.replace('_',' ')}
                  </span>
                </td>
                <td style={{ padding:'10px 12px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ flex:1, height:6, background:'#e9e4ff', borderRadius:9999, overflow:'hidden', minWidth:60 }}>
                      <div style={{ height:'100%', width:`${w.certificate_issued?100:w.status==='signed_off'?80:w.status==='in_progress'?50:10}%`, background:'#6B3FDB', borderRadius:9999 }} />
                    </div>
                    {w.certificate_issued && <Award size={14} color="#d97706" title="Certificate issued"/>}
                    {w.warranty_activated && <Shield size={14} color="#059669" title="Warranty active"/>}
                  </div>
                </td>
                <td style={{ padding:'10px 12px' }}>
                  <button style={{ background:'#f5f3ff', color:'#6B3FDB', border:'1px solid #e9e4ff', borderRadius:6, padding:'4px 10px', fontSize:12, cursor:'pointer', fontWeight:600 }}>Open</button>
                </td>
              </tr>
            ))}
            {!workflows.length && (
              <tr><td colSpan={8} style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>No commissioning workflows yet. Create one to get started.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create Modal */}
      {showCreate && (
        <>
          <div onClick={() => setShowCreate(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', zIndex:900 }} />
          <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, padding:28, width:540, zIndex:901, maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, margin:0 }}>New Commissioning Workflow</h2>
              <button onClick={() => setShowCreate(false)} style={{ background:'none', border:'none', cursor:'pointer' }}><X size={18}/></button>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
              {[['customer_name','Customer Name *','text'],['site_name','Site Name','text'],['site_address','Site Address','text'],['engineer_name','Engineer Name','text'],['fat_reference','FAT Reference','text'],['sat_reference','SAT Reference','text'],['scheduled_date','Scheduled Date *','date']].map(([k,l,t]) => (
                <div key={k} style={{ gridColumn: k==='site_address'?'1/-1':'auto' }}>
                  <label style={LBL}>{l}</label>
                  <input type={t} value={form[k]} onChange={e => setForm(p=>({...p,[k]:e.target.value}))} style={INP} />
                </div>
              ))}
            </div>
            <div style={{ marginTop:14, marginBottom:20 }}>
              <label style={LBL}>Notes</label>
              <textarea value={form.notes} onChange={e => setForm(p=>({...p,notes:e.target.value}))} style={{ ...INP, height:60, resize:'vertical' }} placeholder="Special instructions or notes..." />
            </div>
            <div style={{ fontSize:12, color:'#6b7280', marginBottom:16, background:'#f0fdf4', padding:'10px 12px', borderRadius:8 }}>
              ✓ Default commissioning checklist (16 items) and parameter readings (10 readings) will be auto-created.
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setShowCreate(false)} style={{ padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={createWorkflow} style={BTN()}>Create Workflow</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
