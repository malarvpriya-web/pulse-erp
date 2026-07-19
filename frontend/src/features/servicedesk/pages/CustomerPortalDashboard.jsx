/**
 * Phase 51 — Customer Self-Service Portal Dashboard
 * Full customer-facing experience: equipment view, ticket management, documents, AMC history
 * Uses portal-specific JWT (type: customer_portal) — separate from ERP auth
 */
import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Package, Ticket, FileText, Calendar, AlertCircle, CheckCircle, Clock, Star, Plus, X, ChevronRight, Download, Shield, Wrench } from 'lucide-react';
import '@/components/dashboard/dashkit.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
const portalApi = axios.create({ baseURL: API_BASE });

// Attach portal token (different from ERP token)
portalApi.interceptors.request.use(cfg => {
  const token = localStorage.getItem('portal_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

const CARD = { background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:'20px', marginBottom:16 };
const BTN = (bg='#6B3FDB') => ({ background:bg, color:'#fff', border:'none', borderRadius:8, padding:'8px 16px', fontSize:13, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:6 });
const INP = { width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
const LBL = { display:'block', marginBottom:5, fontSize:11, fontWeight:700, color:'#374151', textTransform:'uppercase', letterSpacing:'.04em' };

// ── Login Screen ──────────────────────────────────────────────────────────────
function PortalLogin({ companyId, onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const login = async (e) => {
    e.preventDefault();
    if (!email || !password) return setError('Email and password required');
    setLoading(true); setError('');
    try {
      const { data } = await axios.post(`${API_BASE}/v1/customer-portal/auth/login`, { email, password, company_id: companyId });
      localStorage.setItem('portal_token', data.token);
      localStorage.setItem('portal_user', JSON.stringify({ customer_name: data.customer_name, contact_person: data.contact_person, email: data.email }));
      onLogin(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(135deg,#f5f3ff 0%,#ede9fe 100%)', display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ background:'#fff', borderRadius:20, padding:40, width:400, boxShadow:'0 20px 60px rgba(107,63,219,.15)' }}>
        <div style={{ textAlign:'center', marginBottom:28 }}>
          <div style={{ width:56, height:56, borderRadius:16, background:'linear-gradient(135deg,#6B3FDB,#a855f7)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px' }}>
            <Shield size={28} color="#fff" />
          </div>
          <h1 style={{ fontSize:22, fontWeight:800, color:'#111', margin:0 }}>Customer Portal</h1>
          <p style={{ fontSize:13, color:'#6b7280', margin:'6px 0 0' }}>Sign in to view your equipment and support tickets</p>
        </div>
        <form onSubmit={login}>
          <div style={{ marginBottom:16 }}>
            <label style={LBL}>Email Address</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={INP} placeholder="your@email.com" autoFocus />
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={LBL}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} style={INP} placeholder="••••••••" />
          </div>
          {error && <div style={{ background:'#fee2e2', color:'#991b1b', borderRadius:8, padding:'8px 12px', fontSize:13, marginBottom:12 }}>{error}</div>}
          <button type="submit" disabled={loading} style={{ ...BTN(), width:'100%', justifyContent:'center', padding:'12px', fontSize:14 }}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
        <p style={{ textAlign:'center', fontSize:12, color:'#9ca3af', marginTop:20 }}>Contact your service provider to get portal access</p>
      </div>
    </div>
  );
}

// ── Main Portal Dashboard ──────────────────────────────────────────────────────
export default function CustomerPortalDashboard({ companyId: propCompanyId }) {
  const companyId = propCompanyId || parseInt(new URLSearchParams(window.location.search).get('company') || '1');
  const savedUser = (() => { try { return JSON.parse(localStorage.getItem('portal_user') || 'null'); } catch { return null; } })();
  const hasToken = !!localStorage.getItem('portal_token');

  const [user, setUser] = useState(savedUser);
  const [loggedIn, setLoggedIn] = useState(hasToken && !!savedUser);
  const [tab, setTab] = useState('equipment');
  const [equipment, setEquipment] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [selectedEquip, setSelectedEquip] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showRaiseTicket, setShowRaiseTicket] = useState(false);
  const [ticketForm, setTicketForm] = useState({ equipment_id:'', subject:'', description:'', priority:'medium', category:'' });
  const [toastMsg, setToastMsg] = useState('');

  const toast = (msg) => { setToastMsg(msg); setTimeout(() => setToastMsg(''), 3000); };

  const load = useCallback(async () => {
    if (!loggedIn) return;
    setLoading(true);
    try {
      const [eq, tix, docs] = await Promise.allSettled([
        portalApi.get('/v1/customer-portal/portal/equipment'),
        portalApi.get('/v1/customer-portal/portal/tickets'),
        portalApi.get('/v1/customer-portal/portal/documents'),
      ]);
      if (eq.status === 'fulfilled') setEquipment(eq.value.data);
      if (tix.status === 'fulfilled') setTickets(tix.value.data);
      if (docs.status === 'fulfilled') setDocuments(docs.value.data);
    } finally { setLoading(false); }
  }, [loggedIn]);

  useEffect(() => { load(); }, [load]);

  const handleLogin = (data) => {
    setUser({ customer_name: data.customer_name, contact_person: data.contact_person, email: data.email });
    setLoggedIn(true);
  };

  const logout = () => {
    localStorage.removeItem('portal_token');
    localStorage.removeItem('portal_user');
    setLoggedIn(false);
    setUser(null);
  };

  const loadEquipDetail = async (id) => {
    try {
      const { data } = await portalApi.get(`/v1/customer-portal/portal/equipment/${id}`);
      setSelectedEquip(data);
    } catch { toast('Failed to load equipment details'); }
  };

  const raiseTicket = async () => {
    if (!ticketForm.subject) return toast('Subject is required');
    try {
      await portalApi.post('/v1/customer-portal/portal/tickets', ticketForm);
      toast('Ticket raised successfully!');
      setShowRaiseTicket(false);
      setTicketForm({ equipment_id:'', subject:'', description:'', priority:'medium', category:'' });
      load();
    } catch (err) { toast(err.response?.data?.error || 'Failed to raise ticket'); }
  };

  const rateTicket = async (id, rating) => {
    try {
      await portalApi.post(`/v1/customer-portal/portal/tickets/${id}/rate`, { rating });
      toast('Rating submitted!');
      load();
    } catch { toast('Failed to submit rating'); }
  };

  if (!loggedIn) return <PortalLogin companyId={companyId} onLogin={handleLogin} />;

  const openTickets = tickets.filter(t => !['closed','resolved'].includes(t.status));
  const expiring = equipment.filter(e => {
    if (!e.warranty_expiry) return false;
    const days = (new Date(e.warranty_expiry) - new Date()) / (1000 * 60 * 60 * 24);
    return days > 0 && days <= 90;
  });

  return (
    <div style={{ minHeight:'100vh', background:'#f8f7ff' }}>
      {/* Header */}
      <div style={{ background:'linear-gradient(135deg,#6B3FDB,#a855f7)', padding:'16px 28px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <Shield size={24} color="#fff" />
          <div>
            <div style={{ fontSize:16, fontWeight:700, color:'#fff' }}>Customer Portal</div>
            <div style={{ fontSize:12, color:'rgba(255,255,255,.7)' }}>Welcome, {user?.customer_name}</div>
          </div>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <button onClick={() => setShowRaiseTicket(true)} style={{ background:'rgba(255,255,255,.2)', color:'#fff', border:'1px solid rgba(255,255,255,.3)', borderRadius:8, padding:'7px 14px', fontSize:13, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}>
            <Plus size={14}/>Raise Ticket
          </button>
          <button onClick={logout} style={{ background:'rgba(255,255,255,.15)', color:'#fff', border:'1px solid rgba(255,255,255,.2)', borderRadius:8, padding:'7px 14px', fontSize:13, cursor:'pointer' }}>
            Sign Out
          </button>
        </div>
      </div>

      {/* Toast */}
      {toastMsg && (
        <div style={{ position:'fixed', top:20, right:20, background:'#111', color:'#fff', borderRadius:10, padding:'12px 20px', fontSize:13, zIndex:9999, boxShadow:'0 4px 20px rgba(0,0,0,.3)' }}>
          {toastMsg}
        </div>
      )}

      <div style={{ maxWidth:1100, margin:'0 auto', padding:'16px 18px 20px' }}>
        {/* Summary Cards */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:12 }}>
          {[
            { icon:<Package size={18}/>, label:'Equipment', value:equipment.length, color:'#6B3FDB', bg:'#f5f3ff' },
            { icon:<Ticket size={18}/>, label:'Open Tickets', value:openTickets.length, color:'#dc2626', bg:'#fee2e2' },
            { icon:<FileText size={18}/>, label:'Documents', value:documents.length, color:'#059669', bg:'#ecfdf5' },
            { icon:<AlertCircle size={18}/>, label:'Warranty Expiring', value:expiring.length, color:'#d97706', bg:'#fffbeb' },
          ].map((s, i) => (
            <div key={s.label} className="dk-anim" style={{ background:'#fff', borderRadius:11, border:'1px solid #f0f0f4', padding:'12px 14px', display:'flex', gap:11, alignItems:'center', '--dk-i': i }}>
              <div style={{ width:34, height:34, borderRadius:10, background:s.bg, display:'flex', alignItems:'center', justifyContent:'center', color:s.color, flexShrink:0 }}>
                {s.icon}
              </div>
              <div>
                <div style={{ fontSize:20, fontWeight:800, color:'#111' }}>{s.value}</div>
                <div style={{ fontSize:11.5, color:'#6b7280' }}>{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', gap:4, marginBottom:20, borderBottom:'2px solid #f0f0f4', paddingBottom:0 }}>
          {[['equipment','My Equipment','📦'],['tickets','Support Tickets','🎫'],['documents','Documents','📄'],['amc','AMC & Service','🔧']].map(([t,l,ic]) => (
            <button key={t} onClick={() => setTab(t)} style={{ padding:'10px 20px', border:'none', cursor:'pointer', background:'none', fontSize:13, fontWeight:tab===t?700:500, color:tab===t?'#6B3FDB':'#6b7280', borderBottom:tab===t?'2px solid #6B3FDB':'2px solid transparent', marginBottom:-2 }}>
              {ic} {l}
            </button>
          ))}
        </div>

        {/* Equipment Tab */}
        {tab === 'equipment' && (
          <div>
            {selectedEquip ? (
              <div>
                <button onClick={() => setSelectedEquip(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#6B3FDB', fontSize:13, marginBottom:16, display:'flex', alignItems:'center', gap:4 }}>
                  ← Back to equipment list
                </button>
                <div style={CARD}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20 }}>
                    <div>
                      <div style={{ fontSize:11, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'.04em', marginBottom:4 }}>{selectedEquip.equipment_tag}</div>
                      <h2 style={{ fontSize:20, fontWeight:700, margin:0 }}>{selectedEquip.equipment_name}</h2>
                      <div style={{ fontSize:13, color:'#6b7280', marginTop:4 }}>{selectedEquip.model_number} • S/N: {selectedEquip.serial_number}</div>
                    </div>
                    <div style={{ display:'flex', gap:8 }}>
                      <span style={{ background:selectedEquip.warranty_status==='active'?'#d1fae5':'#fee2e2', color:selectedEquip.warranty_status==='active'?'#065f46':'#991b1b', padding:'4px 12px', borderRadius:9999, fontSize:12, fontWeight:700 }}>
                        Warranty: {selectedEquip.warranty_status}
                      </span>
                      <span style={{ background:selectedEquip.amc_status==='active'?'#dbeafe':'#f3f4f6', color:selectedEquip.amc_status==='active'?'#1e40af':'#6b7280', padding:'4px 12px', borderRadius:9999, fontSize:12, fontWeight:700 }}>
                        AMC: {selectedEquip.amc_status}
                      </span>
                    </div>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16, marginBottom:24, background:'#f9fafb', padding:16, borderRadius:10 }}>
                    {[
                      ['Rating', selectedEquip.rating],
                      ['Installation Date', selectedEquip.installation_date ? new Date(selectedEquip.installation_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'],
                      ['Site Location', selectedEquip.site_location],
                      ['Warranty Expiry', selectedEquip.warranty_expiry ? new Date(selectedEquip.warranty_expiry).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'],
                      ['Last Service', selectedEquip.last_service_date ? new Date(selectedEquip.last_service_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'],
                      ['Next Service Due', selectedEquip.next_service_date ? new Date(selectedEquip.next_service_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'],
                    ].map(([k,v]) => (
                      <div key={k}><div style={{ fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase', letterSpacing:'.04em' }}>{k}</div><div style={{ fontSize:13, fontWeight:600, color:'#111', marginTop:2 }}>{v || '—'}</div></div>
                    ))}
                  </div>

                  {/* Service History */}
                  <h3 style={{ fontSize:15, fontWeight:700, marginBottom:12 }}>Service History</h3>
                  {(selectedEquip.service_history || []).length ? (
                    <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                      <thead><tr style={{ background:'#f9fafb' }}>{['Ticket #','Subject','Status','Date','Resolved'].map(h=><th key={h} style={{ padding:'8px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280' }}>{h}</th>)}</tr></thead>
                      <tbody>
                        {selectedEquip.service_history.map(t => (
                          <tr key={t.id} style={{ borderTop:'1px solid #f3f4f6' }}>
                            <td style={{ padding:'8px 12px', fontWeight:700, color:'#6B3FDB' }}>{t.ticket_number}</td>
                            <td style={{ padding:'8px 12px' }}>{t.subject}</td>
                            <td style={{ padding:'8px 12px' }}>
                              <span style={{ background:{open:'#fef3c7',closed:'#d1fae5',resolved:'#d1fae5'}[t.status]||'#f3f4f6', color:{open:'#92400e',closed:'#065f46',resolved:'#065f46'}[t.status]||'#374151', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700, textTransform:'capitalize' }}>{t.status}</span>
                            </td>
                            <td style={{ padding:'8px 12px', color:'#6b7280' }}>{new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                            <td style={{ padding:'8px 12px', color:'#6b7280' }}>{t.resolved_at ? new Date(t.resolved_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <div style={{ color:'#9ca3af', fontSize:13, padding:'16px 0' }}>No service history yet</div>}

                  {/* Documents */}
                  {(selectedEquip.documents || []).length > 0 && (
                    <>
                      <h3 style={{ fontSize:15, fontWeight:700, margin:'20px 0 12px' }}>Documents</h3>
                      <div style={{ display:'flex', flexWrap:'wrap', gap:10 }}>
                        {selectedEquip.documents.map(d => (
                          <a key={d.id} href={d.external_url || d.file_path} target="_blank" rel="noreferrer"
                            style={{ background:'#f5f3ff', border:'1px solid #e9e4ff', borderRadius:8, padding:'8px 14px', fontSize:12, fontWeight:600, color:'#6B3FDB', textDecoration:'none', display:'flex', alignItems:'center', gap:6 }}>
                            <Download size={12}/>{d.document_name}
                          </a>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))', gap:14 }}>
                {equipment.map(eq => (
                  <div key={eq.id} style={{ ...CARD, margin:0, cursor:'pointer', transition:'box-shadow .15s' }}
                    onMouseEnter={e => e.currentTarget.style.boxShadow='0 4px 20px rgba(107,63,219,.12)'}
                    onMouseLeave={e => e.currentTarget.style.boxShadow='none'}
                    onClick={() => loadEquipDetail(eq.id)}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12 }}>
                      <div style={{ fontSize:18, fontWeight:700, color:'#6B3FDB' }}>{eq.equipment_tag || `EQ-${eq.id}`}</div>
                      <span style={{ background:eq.warranty_status==='active'?'#d1fae5':'#fee2e2', color:eq.warranty_status==='active'?'#065f46':'#991b1b', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700 }}>
                        {eq.warranty_status === 'active' ? '✓ In Warranty' : 'Warranty Expired'}
                      </span>
                    </div>
                    <div style={{ fontSize:15, fontWeight:600, color:'#111', marginBottom:4 }}>{eq.equipment_name}</div>
                    <div style={{ fontSize:12, color:'#6b7280', marginBottom:12 }}>{eq.model_number} {eq.serial_number ? `• S/N: ${eq.serial_number}` : ''}</div>
                    <div style={{ fontSize:12, color:'#9ca3af', display:'flex', alignItems:'center', gap:6 }}>
                      <Package size={11}/>{eq.site_location || 'Site location not set'}
                    </div>
                    <div style={{ marginTop:12, display:'flex', justifyContent:'flex-end' }}>
                      <span style={{ fontSize:12, color:'#6B3FDB', fontWeight:600, display:'flex', alignItems:'center', gap:4 }}>View Details<ChevronRight size={14}/></span>
                    </div>
                  </div>
                ))}
                {!equipment.length && (
                  <div style={{ gridColumn:'1/-1', textAlign:'center', padding:60, color:'#9ca3af' }}>
                    <Package size={40} style={{ marginBottom:12, opacity:.3 }}/>
                    <p>No equipment registered yet. Contact your service provider.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tickets Tab */}
        {tab === 'tickets' && (
          <div>
            <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:14 }}>
              <button onClick={() => setShowRaiseTicket(true)} style={BTN()}><Plus size={14}/>Raise New Ticket</button>
            </div>
            <div style={CARD}>
              {tickets.length ? (
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead><tr style={{ background:'#f9fafb' }}>{['Ticket #','Subject','Priority','Status','Equipment','Created','Rating'].map(h=><th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6b7280', textTransform:'uppercase' }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {tickets.map(t => (
                      <tr key={t.id} style={{ borderTop:'1px solid #f3f4f6' }}>
                        <td style={{ padding:'10px 12px', fontWeight:700, color:'#6B3FDB' }}>{t.ticket_number}</td>
                        <td style={{ padding:'10px 12px', color:'#111', maxWidth:240, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.subject}</td>
                        <td style={{ padding:'10px 12px' }}>
                          <span style={{ background:{high:'#fee2e2',medium:'#fef3c7',low:'#f0fdf4'}[t.priority]||'#f3f4f6', color:{high:'#991b1b',medium:'#92400e',low:'#166534'}[t.priority]||'#374151', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700, textTransform:'capitalize' }}>{t.priority}</span>
                        </td>
                        <td style={{ padding:'10px 12px' }}>
                          <span style={{ background:{open:'#fef3c7',in_progress:'#dbeafe',resolved:'#d1fae5',closed:'#d1fae5'}[t.status]||'#f3f4f6', color:{open:'#92400e',in_progress:'#1e40af',resolved:'#065f46',closed:'#065f46'}[t.status]||'#374151', padding:'2px 8px', borderRadius:9999, fontSize:11, fontWeight:700, textTransform:'capitalize' }}>{t.status.replace('_',' ')}</span>
                        </td>
                        <td style={{ padding:'10px 12px', color:'#6b7280' }}>{t.equipment_name || '—'}</td>
                        <td style={{ padding:'10px 12px', color:'#6b7280' }}>{new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                        <td style={{ padding:'10px 12px' }}>
                          {['resolved','closed'].includes(t.status) && !t.customer_rating ? (
                            <div style={{ display:'flex', gap:3 }}>
                              {[1,2,3,4,5].map(s => (
                                <button key={s} onClick={() => rateTicket(t.id, s)} style={{ background:'none', border:'none', cursor:'pointer', fontSize:16, color:'#d97706' }}>⭐</button>
                              ))}
                            </div>
                          ) : t.customer_rating ? (
                            <span style={{ color:'#d97706', fontWeight:700 }}>{'⭐'.repeat(t.customer_rating)} ({t.customer_rating}/5)</span>
                          ) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>
                  <Ticket size={40} style={{ marginBottom:12, opacity:.3 }}/>
                  <p>No support tickets yet. Click "Raise New Ticket" if you need assistance.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Documents Tab */}
        {tab === 'documents' && (
          <div style={CARD}>
            {documents.length ? (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(250px,1fr))', gap:12 }}>
                {documents.map(d => (
                  <a key={d.id} href={d.external_url || d.file_path} target="_blank" rel="noreferrer" style={{ display:'block', background:'#f9fafb', border:'1px solid #f0f0f4', borderRadius:10, padding:'16px', textDecoration:'none', transition:'border-color .15s' }}
                    onMouseEnter={e => e.currentTarget.style.borderColor='#6B3FDB'} onMouseLeave={e => e.currentTarget.style.borderColor='#f0f0f4'}>
                    <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                      <div style={{ width:36, height:36, borderRadius:8, background:'#f5f3ff', display:'flex', alignItems:'center', justifyContent:'center', color:'#6B3FDB' }}>
                        <FileText size={18}/>
                      </div>
                      <div style={{ fontSize:11, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'.04em' }}>{d.document_type || 'Document'}</div>
                    </div>
                    <div style={{ fontSize:13, fontWeight:600, color:'#111', marginBottom:4 }}>{d.document_name}</div>
                    {d.equipment_name && <div style={{ fontSize:11, color:'#9ca3af' }}>Equipment: {d.equipment_name}</div>}
                    <div style={{ display:'flex', alignItems:'center', gap:4, marginTop:10, color:'#6B3FDB', fontSize:12, fontWeight:600 }}>
                      <Download size={12}/>Download
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <div style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>
                <FileText size={40} style={{ marginBottom:12, opacity:.3 }}/>
                <p>No documents available yet. Your service provider will share documents here.</p>
              </div>
            )}
          </div>
        )}

        {/* AMC & Service History Tab */}
        {tab === 'amc' && (
          <div style={CARD}>
            <p style={{ textAlign:'center', color:'#9ca3af', fontSize:13 }}>AMC visit history will appear here as your service provider logs visits.</p>
          </div>
        )}
      </div>

      {/* Raise Ticket Modal */}
      {showRaiseTicket && (
        <>
          <div onClick={() => setShowRaiseTicket(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', zIndex:900 }} />
          <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, padding:28, width:480, zIndex:901, maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, margin:0 }}>Raise Support Ticket</h2>
              <button onClick={() => setShowRaiseTicket(false)} style={{ background:'none', border:'none', cursor:'pointer' }}><X size={18}/></button>
            </div>
            <div style={{ marginBottom:14 }}>
              <label style={LBL}>Equipment (optional)</label>
              <select value={ticketForm.equipment_id} onChange={e => setTicketForm(p=>({...p,equipment_id:e.target.value}))} style={{ ...INP, appearance:'auto' }}>
                <option value="">-- Select Equipment --</option>
                {equipment.map(e => <option key={e.id} value={e.id}>{e.equipment_tag} — {e.equipment_name}</option>)}
              </select>
            </div>
            <div style={{ marginBottom:14 }}>
              <label style={LBL}>Subject *</label>
              <input type="text" value={ticketForm.subject} onChange={e => setTicketForm(p=>({...p,subject:e.target.value}))} style={INP} placeholder="Brief description of the issue" />
            </div>
            <div style={{ marginBottom:14 }}>
              <label style={LBL}>Description</label>
              <textarea value={ticketForm.description} onChange={e => setTicketForm(p=>({...p,description:e.target.value}))} style={{ ...INP, height:100, resize:'vertical' }} placeholder="Detailed description, error codes, observations..." />
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:20 }}>
              <div>
                <label style={LBL}>Priority</label>
                <select value={ticketForm.priority} onChange={e => setTicketForm(p=>({...p,priority:e.target.value}))} style={{ ...INP, appearance:'auto' }}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              <div>
                <label style={LBL}>Category</label>
                <select value={ticketForm.category} onChange={e => setTicketForm(p=>({...p,category:e.target.value}))} style={{ ...INP, appearance:'auto' }}>
                  <option value="">-- Category --</option>
                  {['Breakdown','Preventive','Query','Spare Parts','AMC Visit','New Installation'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setShowRaiseTicket(false)} style={{ padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={raiseTicket} style={BTN()}>Submit Ticket</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
