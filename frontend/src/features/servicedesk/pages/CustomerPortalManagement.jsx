import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, Users, Package, Ticket, FileText, Eye, EyeOff, RefreshCw, X, Settings } from 'lucide-react';

const CARD = { background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:'20px', marginBottom:16 };
const STAT = { textAlign:'center', padding:'16px 24px' };
const BTN = (color='#6B3FDB') => ({ background:color, color:'#fff', border:'none', borderRadius:8, padding:'8px 16px', fontSize:13, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:6 });
const INP = { width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
const LBL = { display:'block', marginBottom:5, fontSize:11, fontWeight:700, color:'#374151', textTransform:'uppercase', letterSpacing:'.04em' };

const EMPTY_FORM = { customer_name:'', contact_person:'', email:'', phone:'', password:'', crm_account_id:'', project_ids:'' };

export default function CustomerPortalManagement() {
  const { showToast } = useToast();
  const [tab, setTab] = useState('accounts');
  const [accounts, setAccounts] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showCreateAccount, setShowCreateAccount] = useState(false);
  const [showAddEquipment, setShowAddEquipment] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [eqForm, setEqForm] = useState({ customer_portal_user_id:'', equipment_name:'', equipment_tag:'', model_number:'', serial_number:'', rating:'', installation_date:'', site_location:'', warranty_status:'active', warranty_expiry:'', amc_status:'none' });
  const [showPassword, setShowPassword] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [acct, eq, tix, dash] = await Promise.allSettled([
        api.get('/customer-portal/accounts'),
        api.get('/customer-portal/equipment'),
        api.get('/customer-portal/tickets'),
        api.get('/customer-portal/dashboard'),
      ]);
      if (acct.status === 'fulfilled') setAccounts(acct.value.data);
      if (eq.status === 'fulfilled') setEquipment(eq.value.data);
      if (tix.status === 'fulfilled') setTickets(tix.value.data);
      if (dash.status === 'fulfilled') setDashboard(dash.value.data);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createAccount = async () => {
    if (!form.customer_name || !form.email || !form.password) return showToast('Name, email and password required', 'error');
    try {
      await api.post('/customer-portal/accounts', { ...form, project_ids: form.project_ids ? form.project_ids.split(',').map(Number).filter(Boolean) : [] });
      showToast('Portal account created');
      setShowCreateAccount(false);
      setForm(EMPTY_FORM);
      load();
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };

  const toggleActive = async (id, current) => {
    try {
      await api.put(`/customer-portal/accounts/${id}`, { is_active: !current });
      showToast(`Account ${!current ? 'activated' : 'deactivated'}`);
      load();
    } catch (err) { showToast('Failed', 'error'); }
  };

  const addEquipment = async () => {
    if (!eqForm.equipment_name) return showToast('Equipment name required', 'error');
    try {
      await api.post('/customer-portal/equipment', eqForm);
      showToast('Equipment registered');
      setShowAddEquipment(false);
      setEqForm({ customer_portal_user_id:'', equipment_name:'', equipment_tag:'', model_number:'', serial_number:'', rating:'', installation_date:'', site_location:'', warranty_status:'active', warranty_expiry:'', amc_status:'none' });
      load();
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };

  const updateTicketStatus = async (id, status) => {
    try {
      await api.put(`/customer-portal/tickets/${id}`, { status });
      showToast('Ticket updated');
      load();
    } catch (err) { showToast('Failed', 'error'); }
  };

  const STATUS_COLOR = { open:'#fef3c7', in_progress:'#dbeafe', closed:'#d1fae5', resolved:'#d1fae5' };
  const STATUS_TEXT  = { open:'#92400e', in_progress:'#1e40af', closed:'#065f46', resolved:'#065f46' };

  return (
    <div style={{ padding:'24px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#111', margin:0 }}>Customer Portal</h1>
          <p style={{ fontSize:13, color:'#6b7280', margin:'4px 0 0' }}>Manage customer login accounts, equipment, and support tickets</p>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={() => setShowAddEquipment(true)} style={BTN('#059669')}><Package size={14}/>Register Equipment</button>
          <button onClick={() => setShowCreateAccount(true)} style={BTN()}><Plus size={14}/>Create Account</button>
        </div>
      </div>

      {/* Stats */}
      {dashboard && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:20 }}>
          {[
            { label:'Portal Accounts', value:dashboard.accounts?.total || 0, sub:`${dashboard.accounts?.active || 0} active`, color:'#6B3FDB' },
            { label:'Open Tickets', value:dashboard.tickets?.open || 0, sub:'awaiting response', color:'#dc2626' },
            { label:'Equipment Registered', value:Object.values(dashboard.equipment || {}).reduce((a,b)=>a+b,0), sub:'across all customers', color:'#059669' },
            { label:'Warranty Active', value:dashboard.equipment?.active || 0, sub:'in-warranty units', color:'#d97706' },
          ].map(s => (
            <div key={s.label} style={{ ...CARD, ...STAT, margin:0 }}>
              <div style={{ fontSize:28, fontWeight:800, color:s.color }}>{s.value}</div>
              <div style={{ fontSize:12, fontWeight:600, color:'#374151', marginTop:2 }}>{s.label}</div>
              <div style={{ fontSize:11, color:'#9ca3af' }}>{s.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:20, borderBottom:'2px solid #f0f0f4', paddingBottom:0 }}>
        {[['accounts','Accounts','👤'],['equipment','Equipment','📦'],['tickets','Portal Tickets','🎫']].map(([t,l,ic]) => (
          <button key={t} onClick={() => setTab(t)} style={{ padding:'10px 20px', border:'none', cursor:'pointer', background:'none', fontSize:13, fontWeight:tab===t?700:500, color:tab===t?'#6B3FDB':'#6b7280', borderBottom:tab===t?'2px solid #6B3FDB':'2px solid transparent', marginBottom:-2 }}>
            {ic} {l}
          </button>
        ))}
      </div>

      {/* Accounts Tab */}
      {tab === 'accounts' && (
        <div style={CARD}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Customer','Contact Person','Email','Phone','Status','Last Login','Actions'].map(h => (
                  <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => (
                <tr key={a.id} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'10px 12px', fontWeight:600, color:'#111' }}>{a.customer_name}</td>
                  <td style={{ padding:'10px 12px', color:'#374151' }}>{a.contact_person || '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#374151' }}>{a.email}</td>
                  <td style={{ padding:'10px 12px', color:'#374151' }}>{a.phone || '—'}</td>
                  <td style={{ padding:'10px 12px' }}>
                    <span style={{ background:a.is_active?'#d1fae5':'#fee2e2', color:a.is_active?'#065f46':'#991b1b', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700 }}>
                      {a.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td style={{ padding:'10px 12px', color:'#6b7280' }}>{a.last_login ? new Date(a.last_login).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'Never'}</td>
                  <td style={{ padding:'10px 12px' }}>
                    <button onClick={() => toggleActive(a.id, a.is_active)} style={{ background:'none', border:'1px solid #e5e7eb', borderRadius:6, padding:'4px 10px', fontSize:12, cursor:'pointer', color:'#374151' }}>
                      {a.is_active ? <><EyeOff size={12} style={{verticalAlign:'middle'}}/> Deactivate</> : <><Eye size={12} style={{verticalAlign:'middle'}}/> Activate</>}
                    </button>
                  </td>
                </tr>
              ))}
              {!accounts.length && (
                <tr><td colSpan={7} style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No portal accounts yet. Create one to get started.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Equipment Tab */}
      {tab === 'equipment' && (
        <div style={CARD}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Tag','Equipment','Customer','Model','Serial','Warranty','AMC','Site'].map(h => (
                  <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {equipment.map(e => (
                <tr key={e.id} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'10px 12px', fontWeight:700, color:'#6B3FDB' }}>{e.equipment_tag || `EQ-${e.id}`}</td>
                  <td style={{ padding:'10px 12px', fontWeight:600 }}>{e.equipment_name}</td>
                  <td style={{ padding:'10px 12px', color:'#6b7280' }}>{e.customer_name || '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#374151' }}>{e.model_number || '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#374151', fontFamily:'monospace', fontSize:12 }}>{e.serial_number || '—'}</td>
                  <td style={{ padding:'10px 12px' }}>
                    <span style={{ background:e.warranty_status==='active'?'#d1fae5':'#fee2e2', color:e.warranty_status==='active'?'#065f46':'#991b1b', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700 }}>
                      {e.warranty_status}
                    </span>
                    {e.warranty_expiry && <div style={{ fontSize:10, color:'#9ca3af', marginTop:2 }}>Exp: {new Date(e.warranty_expiry).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</div>}
                  </td>
                  <td style={{ padding:'10px 12px' }}>
                    <span style={{ background:e.amc_status==='active'?'#dbeafe':'#f3f4f6', color:e.amc_status==='active'?'#1e40af':'#6b7280', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700 }}>
                      {e.amc_status}
                    </span>
                  </td>
                  <td style={{ padding:'10px 12px', color:'#6b7280', maxWidth:150, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.site_location || '—'}</td>
                </tr>
              ))}
              {!equipment.length && (
                <tr><td colSpan={8} style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No equipment registered yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Tickets Tab */}
      {tab === 'tickets' && (
        <div style={CARD}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Ticket #','Customer','Subject','Priority','Status','Equipment','Created','Action'].map(h => (
                  <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickets.map(t => (
                <tr key={t.id} style={{ borderTop:'1px solid #f3f4f6' }}>
                  <td style={{ padding:'10px 12px', fontWeight:700, color:'#6B3FDB' }}>{t.ticket_number}</td>
                  <td style={{ padding:'10px 12px', fontWeight:500 }}>{t.customer_name}</td>
                  <td style={{ padding:'10px 12px', color:'#374151', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.subject}</td>
                  <td style={{ padding:'10px 12px' }}>
                    <span style={{ background:{high:'#fee2e2',medium:'#fef3c7',low:'#f0fdf4'}[t.priority]||'#f3f4f6', color:{high:'#991b1b',medium:'#92400e',low:'#166534'}[t.priority]||'#374151', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700, textTransform:'capitalize' }}>
                      {t.priority}
                    </span>
                  </td>
                  <td style={{ padding:'10px 12px' }}>
                    <span style={{ background:STATUS_COLOR[t.status]||'#f3f4f6', color:STATUS_TEXT[t.status]||'#374151', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700, textTransform:'capitalize' }}>
                      {t.status}
                    </span>
                  </td>
                  <td style={{ padding:'10px 12px', color:'#6b7280' }}>{t.equipment_name || '—'}</td>
                  <td style={{ padding:'10px 12px', color:'#6b7280' }}>{new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                  <td style={{ padding:'10px 12px' }}>
                    <select value={t.status} onChange={e => updateTicketStatus(t.id, e.target.value)}
                      style={{ padding:'4px 8px', border:'1px solid #e5e7eb', borderRadius:6, fontSize:12, cursor:'pointer', background:'#fff' }}>
                      {['open','in_progress','resolved','closed'].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
              {!tickets.length && (
                <tr><td colSpan={8} style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>No portal tickets raised yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Account Modal */}
      {showCreateAccount && (
        <>
          <div onClick={() => setShowCreateAccount(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', zIndex:900 }} />
          <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, padding:28, width:480, zIndex:901, maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, margin:0 }}>Create Portal Account</h2>
              <button onClick={() => setShowCreateAccount(false)} style={{ background:'none', border:'none', cursor:'pointer' }}><X size={18} /></button>
            </div>
            {[
              ['customer_name','Customer / Company Name','text',true],
              ['contact_person','Contact Person Name','text',false],
              ['email','Login Email','email',true],
              ['phone','Phone Number','text',false],
            ].map(([k,l,t,req]) => (
              <div key={k} style={{ marginBottom:14 }}>
                <label style={LBL}>{l}{req && ' *'}</label>
                <input type={t} value={form[k]} onChange={e => setForm(p=>({...p,[k]:e.target.value}))} style={INP} placeholder={l} />
              </div>
            ))}
            <div style={{ marginBottom:14 }}>
              <label style={LBL}>Password *</label>
              <div style={{ position:'relative' }}>
                <input type={showPassword?'text':'password'} value={form.password} onChange={e => setForm(p=>({...p,password:e.target.value}))} style={{ ...INP, paddingRight:36 }} placeholder="Min. 6 characters" />
                <button onClick={() => setShowPassword(p=>!p)} style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}>
                  {showPassword ? <EyeOff size={16}/> : <Eye size={16}/>}
                </button>
              </div>
            </div>
            <div style={{ marginBottom:20 }}>
              <label style={LBL}>Linked Project IDs (comma-separated)</label>
              <input type="text" value={form.project_ids} onChange={e => setForm(p=>({...p,project_ids:e.target.value}))} style={INP} placeholder="1,2,3" />
              <div style={{ fontSize:11, color:'#9ca3af', marginTop:4 }}>Customer will see equipment from these projects</div>
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setShowCreateAccount(false)} style={{ padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={createAccount} style={BTN()}>Create Account</button>
            </div>
          </div>
        </>
      )}

      {/* Add Equipment Modal */}
      {showAddEquipment && (
        <>
          <div onClick={() => setShowAddEquipment(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', zIndex:900 }} />
          <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, padding:28, width:520, zIndex:901, maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, margin:0 }}>Register Equipment</h2>
              <button onClick={() => setShowAddEquipment(false)} style={{ background:'none', border:'none', cursor:'pointer' }}><X size={18} /></button>
            </div>
            <div style={{ marginBottom:14 }}>
              <label style={LBL}>Customer Portal Account</label>
              <select value={eqForm.customer_portal_user_id} onChange={e => setEqForm(p=>({...p,customer_portal_user_id:e.target.value}))} style={{ ...INP, appearance:'auto' }}>
                <option value="">-- Select Customer --</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.customer_name}</option>)}
              </select>
            </div>
            {[
              ['equipment_name','Equipment Name *','text'],
              ['equipment_tag','Equipment Tag (e.g. SST-001)','text'],
              ['model_number','Model Number','text'],
              ['serial_number','Serial Number','text'],
              ['rating','Rating (e.g. 2000 kVA, 11kV)','text'],
              ['site_location','Site Location','text'],
              ['installation_date','Installation Date','date'],
              ['warranty_expiry','Warranty Expiry','date'],
            ].map(([k,l,t]) => (
              <div key={k} style={{ marginBottom:14 }}>
                <label style={LBL}>{l}</label>
                <input type={t} value={eqForm[k]||''} onChange={e => setEqForm(p=>({...p,[k]:e.target.value}))} style={INP} />
              </div>
            ))}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:14 }}>
              <div>
                <label style={LBL}>Warranty Status</label>
                <select value={eqForm.warranty_status} onChange={e => setEqForm(p=>({...p,warranty_status:e.target.value}))} style={{ ...INP, appearance:'auto' }}>
                  {['active','expired','void'].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label style={LBL}>AMC Status</label>
                <select value={eqForm.amc_status} onChange={e => setEqForm(p=>({...p,amc_status:e.target.value}))} style={{ ...INP, appearance:'auto' }}>
                  {['none','active','expired','pending'].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setShowAddEquipment(false)} style={{ padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={addEquipment} style={BTN('#059669')}>Register Equipment</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
