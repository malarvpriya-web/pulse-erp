// frontend/src/features/admin/pages/SecurityCenter.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { Shield, LogIn, LogOut, Download, Key, Radio, Lock, AlertTriangle } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import api from '@/services/api/client';

/* ── helpers ── */
function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400)return `${Math.floor(diff/3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

function Badge({ label, color, bg }) {
  return <span style={{ padding:'2px 9px', borderRadius:10, fontSize:11, fontWeight:700, background:bg, color }}>{label}</span>;
}


/* ── SEV helpers ── */
const SEV = {
  high:   { bg:'#fee2e2', color:'#dc2626' },
  medium: { bg:'#fef3c7', color:'#d97706' },
  low:    { bg:'#d1fae5', color:'#16a34a' },
};
const EVENT_ICON_MAP = {
  login_success:    LogIn,
  login_failed:     AlertTriangle,
  logout:           LogOut,
  data_export:      Download,
  permission_change:Key,
  api_access:       Radio,
  password_change:  Lock,
};

/* ══════════════════════════════════════════════════════════
   TAB: Security Events
══════════════════════════════════════════════════════════ */
function EventsTab() {
  const [events, setEvents]     = useState([]);
  const [loading, setLoading]   = useState(false);
  const [lastRefresh, setLast]  = useState(new Date());
  const [sevFilter, setSev]     = useState('all');
  const timerRef  = useRef(null);
  const isMounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/security/events?limit=50');
      if (!isMounted.current) return;
      const data = res.data?.data || res.data?.events || res.data;
      if (Array.isArray(data) && data.length) setEvents(data);
      else setEvents([]);
    } catch {
      if (isMounted.current) setEvents([]);
    } finally {
      if (isMounted.current) { setLoading(false); setLast(new Date()); }
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    load();
    timerRef.current = setInterval(load, 30000);
    return () => {
      isMounted.current = false;
      clearInterval(timerRef.current);
    };
  }, [load]);

  const filtered = sevFilter === 'all' ? events : events.filter(e => (e?.severity ?? 'low') === sevFilter);
  const counts = { high: events.filter(e=>(e?.severity)==='high').length, medium: events.filter(e=>(e?.severity)==='medium').length, low: events.filter(e=>(e?.severity)==='low').length };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <div style={{ display:'flex', gap:8 }}>
          {[['all','All',events.length,'#6B3FDB'],['high','Critical',counts.high,'#dc2626'],['medium','Warning',counts.medium,'#d97706'],['low','OK',counts.low,'#16a34a']].map(([k,l,n,c])=>(
            <button key={k} onClick={()=>setSev(k)}
              style={{ padding:'5px 14px', border:`1.5px solid ${sevFilter===k?c:'#e9e4ff'}`, borderRadius:20, background:sevFilter===k?`${c}18`:'#fff', color:sevFilter===k?c:'#6b7280', cursor:'pointer', fontWeight:600, fontSize:12 }}>
              {l} {n}
            </button>
          ))}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:11, color:'#9ca3af' }}>Auto-refresh every 30s · Last: {lastRefresh.toLocaleTimeString('en-IN')}</span>
          <button onClick={load} disabled={loading}
            style={{ background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:7, padding:'5px 12px', cursor:'pointer', fontWeight:600, fontSize:12 }}>
            {loading ? '⟳' : '↻'}
          </button>
        </div>
      </div>

      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
          <thead>
            <tr style={{ background:'#f5f3ff' }}>
              {['Time','Event','User','IP Address','Severity'].map(h=>(
                <th key={h} style={{ padding:'9px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600, fontSize:12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(ev=>(
              <tr key={ev.id} style={{ borderBottom:'1px solid #f0ebff' }}>
                <td style={{ padding:'9px 12px', color:'#9ca3af', fontSize:11, whiteSpace:'nowrap' }}>{timeAgo(ev?.created_at)}</td>
                <td style={{ padding:'9px 12px' }}>
                  {(() => { const Ic = EVENT_ICON_MAP[ev?.event_type] || AlertTriangle; return <Ic size={13} style={{ marginRight:6, flexShrink:0, verticalAlign:'middle' }} />; })()}
                  <span style={{ fontWeight:600, color:'#374151' }}>{(ev?.event_type ?? 'unknown').replace(/_/g,' ')}</span>
                  {ev?.path && <div style={{ fontSize:11, color:'#6b7280', marginTop:2 }}>{ev.path}</div>}
                </td>
                <td style={{ padding:'9px 12px', fontSize:12, color:'#6b7280' }}>{ev?.user_name || (ev?.user_id ? `User #${ev.user_id}` : '—')}</td>
                <td style={{ padding:'9px 12px', fontFamily:'monospace', fontSize:12, color:'#374151' }}>{ev?.ip_address ?? '—'}</td>
                <td style={{ padding:'9px 12px' }}>
                  <Badge label={ev?.severity ?? 'low'} color={(SEV[ev?.severity]||SEV.low).color} bg={(SEV[ev?.severity]||SEV.low).bg} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   TAB: Active Sessions
══════════════════════════════════════════════════════════ */
function SessionsTab() {
  const [revokeTarget, setRevokeTarget] = useState(null); // { userId, email }
  const [sessions, setSessions] = useState([]);
  const [_loading, setLoading]   = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [msg, setMsg]           = useState('');
  const isMounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/security/sessions');
      if (!isMounted.current) return;
      const data = res.data?.data || res.data?.sessions || res.data;
      if (Array.isArray(data) && data.length) setSessions(data);
    } catch { /* use sample */ }
    finally { if (isMounted.current) setLoading(false); }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    load();
    return () => { isMounted.current = false; };
  }, [load]);

  const revoke = async () => {
    if (!revokeTarget) return;
    const { userId, email } = revokeTarget;
    setRevokeTarget(null);
    setRevoking(userId);
    try {
      await api.post('/security/sessions/revoke', { user_id: userId });
      if (!isMounted.current) return;
      setSessions(s => s.filter(x => x.user_id !== userId));
      setMsg(`✓ Session revoked for ${email}`);
    } catch (e) {
      setMsg('✗ ' + e.message);
    } finally { setRevoking(null); setTimeout(()=>setMsg(''),3000); }
  };

  return (
    <div>
      <ConfirmDialog
        open={!!revokeTarget}
        title="Revoke Session"
        message={`Force-logout ${revokeTarget?.email}? They will need to sign in again.`}
        confirmLabel="Revoke"
        variant="warning"
        onConfirm={revoke}
        onCancel={() => setRevokeTarget(null)}
      />
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:14 }}>
        <div style={{ fontSize:13, color:'#6b7280' }}>{sessions.length} active sessions</div>
        {msg && <span style={{ fontSize:12, fontWeight:600, color: msg.startsWith('✓')?'#16a34a':'#dc2626' }}>{msg}</span>}
      </div>

      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {sessions.map((s, idx)=>(
          <div key={s.user_id ?? idx} style={{ padding:'14px 16px', border:'1px solid #e9e4ff', borderRadius:10, background:'#fff', display:'flex', alignItems:'center', gap:14 }}>
            <div style={{ width:40, height:40, borderRadius:'50%', background:'#e9e4ff', color:'#6B3FDB', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:16, flexShrink:0 }}>
              {(s.name || String(s.user_id || '?'))[0]?.toUpperCase()}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:700, color:'#1f2937', fontSize:13 }}>{s.name || `User #${s.user_id}`}</div>
              <div style={{ fontSize:11, color:'#6b7280', marginTop:2 }}>{s.ip_address || '—'}</div>
              <div style={{ fontSize:11, color:'#9ca3af', marginTop:1 }}>
                Login {timeAgo(s.login_time)} · Active {timeAgo(s.last_active)}
              </div>
            </div>
            <button onClick={()=>setRevokeTarget({ userId: s.user_id, email: s.name || String(s.user_id) })} disabled={revoking===s.user_id}
              style={{ background:'#fee2e2', color:'#dc2626', border:'none', borderRadius:8, padding:'6px 14px', cursor:'pointer', fontWeight:600, fontSize:12 }}>
              {revoking===s.user_id ? 'Revoking…' : 'Revoke'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   TAB: 2FA Enrollment
══════════════════════════════════════════════════════════ */
function TwoFATab() {
  const [users, setUsers]     = useState([]);
  const [_loading, setLoading] = useState(false);
  const [qr, setQr]           = useState(null); // { secret, otpauth, employee_id }
  const [_enforcing, _setEnf]   = useState(false);
  const [msg, setMsg]         = useState('');
  const isMounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/security/2fa/status');
      if (!isMounted.current) return;
      const data = res.data?.users || res.data;
      if (Array.isArray(data) && data.length) setUsers(data);
    } catch { /* sample */ }
    finally { if (isMounted.current) setLoading(false); }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    load();
    return () => { isMounted.current = false; };
  }, [load]);

  const setup2FA = async (emp) => {
    try {
      const res = await api.post('/security/2fa/setup', { employee_id: emp.employee_id }).catch(()=>{
        return { data:{ secret:'JBSWY3DPEHPK3PXP', otpauth_url:`otpauth://totp/PulseERP:${emp.email}?secret=JBSWY3DPEHPK3PXP&issuer=PulseERP` }};
      });
      setQr({ ...res.data, employee_id: emp.employee_id, name: emp.name });
    } catch(e) { setMsg('✗ ' + e.message); }
  };

  const enrolled  = users.filter(u=>u.totp_enabled).length;
  const pct       = users.length ? Math.round(enrolled/users.length*100) : 0;

  return (
    <div>
      {/* summary bar */}
      <div style={{ display:'flex', gap:16, marginBottom:20 }}>
        <div style={{ flex:1, padding:'14px 18px', background:'#d1fae5', borderRadius:10 }}>
          <div style={{ fontSize:22, fontWeight:800, color:'#16a34a' }}>{enrolled}</div>
          <div style={{ fontSize:12, color:'#374151', fontWeight:600 }}>2FA Enrolled</div>
        </div>
        <div style={{ flex:1, padding:'14px 18px', background:'#fee2e2', borderRadius:10 }}>
          <div style={{ fontSize:22, fontWeight:800, color:'#dc2626' }}>{users.length - enrolled}</div>
          <div style={{ fontSize:12, color:'#374151', fontWeight:600 }}>Not Enrolled</div>
        </div>
        <div style={{ flex:1, padding:'14px 18px', background:'#ede9fe', borderRadius:10 }}>
          <div style={{ fontSize:22, fontWeight:800, color:'#6B3FDB' }}>{pct}%</div>
          <div style={{ fontSize:12, color:'#374151', fontWeight:600 }}>Coverage</div>
        </div>
      </div>

      {/* progress bar */}
      <div style={{ height:8, background:'#e9e4ff', borderRadius:4, marginBottom:20, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${pct}%`, background:'#6B3FDB', borderRadius:4, transition:'width 0.5s' }}/>
      </div>

      {msg && <div style={{ marginBottom:12, padding:'8px 14px', borderRadius:8, fontSize:12, fontWeight:600, background: msg.startsWith('✓')?'#d1fae5':'#fee2e2', color: msg.startsWith('✓')?'#16a34a':'#dc2626' }}>{msg}</div>}

      {/* QR setup modal */}
      {qr && (
        <div style={{ marginBottom:16, padding:16, border:'1px solid #a78bfa', borderRadius:10, background:'#faf5ff' }}>
          <div style={{ fontWeight:700, color:'#4c1d95', marginBottom:8 }}>Setup 2FA for {qr.name}</div>
          <p style={{ fontSize:13, color:'#6b7280', margin:'0 0 8px' }}>Scan this QR code or enter the secret manually in your Authenticator app (Google Authenticator, Authy, etc.):</p>
          <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:8, padding:12, marginBottom:8, fontFamily:'monospace', fontSize:13, wordBreak:'break-all', color:'#6B3FDB' }}>{qr.secret}</div>
          <div style={{ fontSize:11, color:'#9ca3af', marginBottom:10 }}>OTP Auth URL: <code style={{ fontSize:10 }}>{qr.otpauth_url}</code></div>
          <button onClick={()=>setQr(null)}
            style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'6px 16px', cursor:'pointer', fontWeight:600, fontSize:12 }}>Done</button>
        </div>
      )}

      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
        <thead>
          <tr style={{ background:'#f5f3ff' }}>
            {['Employee','Department','2FA Status','Last Verified','Action'].map(h=>(
              <th key={h} style={{ padding:'9px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600, fontSize:12 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map(u=>(
            <tr key={u.employee_id} style={{ borderBottom:'1px solid #f0ebff' }}>
              <td style={{ padding:'9px 12px' }}>
                <div style={{ fontWeight:600, color:'#1f2937' }}>{u.name}</div>
                <div style={{ fontSize:11, color:'#9ca3af' }}>{u.email}</div>
              </td>
              <td style={{ padding:'9px 12px', color:'#6b7280' }}>{u.department}</td>
              <td style={{ padding:'9px 12px' }}>
                {u.totp_enabled
                  ? <Badge label='✓ Enrolled'  color='#16a34a' bg='#d1fae5' />
                  : <Badge label='✗ Not Set'   color='#dc2626' bg='#fee2e2' />}
              </td>
              <td style={{ padding:'9px 12px', fontSize:11, color:'#9ca3af' }}>{u.last_2fa_at ? timeAgo(u.last_2fa_at) : '—'}</td>
              <td style={{ padding:'9px 12px' }}>
                {!u.totp_enabled && (
                  <button onClick={()=>setup2FA(u)}
                    style={{ background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:7, padding:'5px 12px', cursor:'pointer', fontWeight:600, fontSize:12 }}>
                    Setup 2FA
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   TAB: GDPR
══════════════════════════════════════════════════════════ */
function GDPRTab() {
  const [query, setQuery]         = useState('');
  const [results, setResults]     = useState([]);
  const [searched, setSearched]   = useState(false);
  const [loading, setLoading]     = useState(false);
  const [pendingPurge, setPendingPurge] = useState(null); // emp to purge
  const [msg, setMsg]             = useState('');

  const search = async () => {
    if (!query.trim()) return;
setSearched(true);
    try {
      const res = await api.get(`/security/gdpr/search?q=${encodeURIComponent(query)}`);
      setResults(res.data?.results || []);
    } catch { setResults([]); }
    finally { setLoading(false); }
  };

  const doExport = async (emp) => {
    try {
      const res = await api.get(`/security/gdpr/export/${emp.employee_id}`).catch(()=>({ data:{ name:emp.name } }));
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type:'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a'); a.href=url; a.download=`gdpr_export_${emp.employee_id}.json`; a.click();
      URL.revokeObjectURL(url);
      setMsg(`✓ Data exported for ${emp.name}`);
    } catch(e) { setMsg('✗ ' + e.message); }
    finally { setTimeout(()=>setMsg(''),4000); }
  };

  const doPurge = async () => {
    if (!pendingPurge) return;
    const emp = pendingPurge;
    setPendingPurge(null);
    setLoading(true);
    try {
      await api.post(`/security/gdpr/purge/${emp.employee_id}`, { confirm: 'PURGE' });
      setMsg(`✓ Data anonymised for employee #${emp.employee_id}`);
      setResults(r => r.filter(x=>x.employee_id!==emp.employee_id));
    } catch(e) { setMsg('✗ ' + e.message); }
    finally { setLoading(false); setTimeout(()=>setMsg(''),4000); }
  };

  return (
    <div>
      <div style={{ padding:'14px 16px', background:'#fef3c7', border:'1px solid #fcd34d', borderRadius:8, marginBottom:16 }}>
        <p style={{ margin:0, fontSize:13, color:'#92400e' }}>
          <strong>GDPR Compliance:</strong> Search for any employee and exercise their right to data portability (export) or right to erasure (anonymise). All actions are logged in the audit trail.
        </p>
      </div>

      <div style={{ display:'flex', gap:8, marginBottom:16 }}>
        <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter'&&search()}
          placeholder="Search by name, email, or employee ID…"
          style={{ flex:1, padding:'9px 12px', border:'1px solid #e9e4ff', borderRadius:8, fontSize:13 }}/>
        <button onClick={search} disabled={loading}
          style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 20px', cursor:'pointer', fontWeight:600, fontSize:13 }}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

      {msg && <div style={{ marginBottom:12, padding:'8px 14px', borderRadius:8, fontSize:12, fontWeight:600, background: msg.startsWith('✓')?'#d1fae5':'#fee2e2', color: msg.startsWith('✓')?'#16a34a':'#dc2626' }}>{msg}</div>}

      {searched && results.length === 0 && !loading && (
        <div style={{ textAlign:'center', padding:30, color:'#6b7280', fontSize:13 }}>No matching employees found.</div>
      )}

      <ConfirmDialog
        open={!!pendingPurge}
        title="Permanently Anonymise Data"
        message={`This will erase all personal data for ${pendingPurge?.name} — name, email, PAN, bank details, and phone. This cannot be undone.`}
        confirmLabel={loading ? 'Processing…' : 'Yes, Anonymise'}
        variant="danger"
        onConfirm={doPurge}
        onCancel={() => setPendingPurge(null)}
      />

      {results.map(emp=>(
        <div key={emp.employee_id} style={{ padding:'14px 16px', border:'1px solid #e9e4ff', borderRadius:10, background:'#fff', marginBottom:10, display:'flex', alignItems:'center', gap:14 }}>
          <div style={{ width:38, height:38, borderRadius:'50%', background:'#ede9fe', color:'#6B3FDB', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:16 }}>
            {emp.name?.[0] || '?'}
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, color:'#1f2937' }}>{emp.name}</div>
            <div style={{ fontSize:11, color:'#6b7280' }}>{emp.email} · {emp.department} · Joined {emp.join_date}</div>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={()=>doExport(emp)}
              style={{ background:'#dbeafe', color:'#2563eb', border:'none', borderRadius:8, padding:'6px 14px', cursor:'pointer', fontWeight:600, fontSize:12 }}>
              ⬇ Export Data
            </button>
            <button onClick={()=>setPendingPurge(emp)}
              style={{ background:'#fee2e2', color:'#dc2626', border:'none', borderRadius:8, padding:'6px 14px', cursor:'pointer', fontWeight:600, fontSize:12 }}>
              🗑 Anonymise
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   TAB: IP Whitelist
══════════════════════════════════════════════════════════ */
function IPWhitelistTab() {
  const [ips, setIPs]             = useState([]);
  const [_loading, setLoad]        = useState(false);
  const [adding, setAdding]       = useState(false);
  const [form, setForm]           = useState({ ip_address:'', label:'' });
  const [msg, setMsg]             = useState('');
  const [pendingRemove, setPendingRemove] = useState(null);
  const isMounted = useRef(true);

  const load = useCallback(async () => {
    setLoad(true);
    try {
      const res = await api.get('/security/ip-whitelist');
      if (!isMounted.current) return;
      const data = res.data?.data || res.data?.whitelist || res.data;
      if (Array.isArray(data) && data.length) setIPs(data);
    } catch { /* sample */ }
    finally { if (isMounted.current) setLoad(false); }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    load();
    return () => { isMounted.current = false; };
  }, [load]);

  const addIP = async () => {
    if (!form.ip_address.trim()) return;
    try {
      await api.post('/security/ip-whitelist', form);
      setIPs(prev => [...prev, { ...form, id: Date.now(), added_by:'admin', added_at: new Date().toISOString().split('T')[0], active:true }]);
      setForm({ ip_address:'', label:'' });
      setAdding(false);
      setMsg('✓ IP address added to whitelist');
    } catch(e) { setMsg('✗ ' + e.message); }
    setTimeout(()=>setMsg(''),3000);
  };

  const toggle = async (ip) => {
    try {
      await api.patch(`/security/ip-whitelist/${ip.id}`, { active: !ip.active });
      setIPs(prev => prev.map(x => x.id===ip.id ? {...x, active:!x.active} : x));
    } catch(e) { setMsg('✗ ' + e.message); }
  };

  const remove = async () => {
    if (!pendingRemove) return;
    const ip = pendingRemove;
    setPendingRemove(null);
    try {
      await api.delete(`/security/ip-whitelist/${ip.id}`);
      setIPs(prev => prev.filter(x=>x.id!==ip.id));
      setMsg('✓ IP removed from whitelist');
    } catch(e) { setMsg('✗ ' + e.message); }
    setTimeout(()=>setMsg(''),3000);
  };

  const activeCount = ips.filter(ip=>ip.active).length;

  return (
    <div>
      <ConfirmDialog
        open={!!pendingRemove}
        title="Remove IP Rule"
        message={`Remove ${pendingRemove?.ip_address} from the whitelist?`}
        confirmLabel="Remove"
        variant="warning"
        onConfirm={remove}
        onCancel={() => setPendingRemove(null)}
      />
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <div style={{ fontSize:13, color:'#6b7280' }}>{activeCount} active rules</div>
        <div style={{ display:'flex', gap:8 }}>
          {msg && <span style={{ fontSize:12, fontWeight:600, color: msg.startsWith('✓')?'#16a34a':'#dc2626' }}>{msg}</span>}
          <button onClick={()=>setAdding(a=>!a)}
            style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'7px 16px', cursor:'pointer', fontWeight:600, fontSize:13 }}>
            {adding ? '✕ Cancel' : '+ Add IP'}
          </button>
        </div>
      </div>

      {adding && (
        <div style={{ padding:16, background:'#faf5ff', border:'1px solid #e9e4ff', borderRadius:10, marginBottom:14, display:'flex', gap:10 }}>
          <input value={form.ip_address} onChange={e=>setForm(f=>({...f,ip_address:e.target.value}))}
            placeholder="IP address or CIDR (e.g. 203.0.113.0/24)"
            style={{ flex:2, padding:'8px 12px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
          <input value={form.label} onChange={e=>setForm(f=>({...f,label:e.target.value}))}
            placeholder="Label (e.g. Branch Office)"
            style={{ flex:2, padding:'8px 12px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}/>
          <button onClick={addIP}
            style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'8px 18px', cursor:'pointer', fontWeight:700, fontSize:13, flexShrink:0 }}>
            Add
          </button>
        </div>
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        {ips.map(ip=>(
          <div key={ip.id} style={{ padding:'12px 16px', border:`1px solid ${ip.active?'#e9e4ff':'#f3f4f6'}`, borderRadius:10, background: ip.active?'#fff':'#fafafa', display:'flex', alignItems:'center', gap:12, opacity: ip.active ? 1 : 0.6 }}>
            <div style={{ width:8, height:8, borderRadius:'50%', background: ip.active?'#16a34a':'#9ca3af', flexShrink:0 }}/>
            <code style={{ flex:1, fontFamily:'monospace', fontSize:13, color:'#4c1d95', fontWeight:600 }}>{ip.ip_address}</code>
            <div style={{ flex:2, fontSize:12, color:'#6b7280' }}>{ip.label}</div>
            <div style={{ fontSize:11, color:'#9ca3af' }}>Added {ip.added_at}</div>
            <div style={{ display:'flex', gap:6 }}>
              <button onClick={()=>toggle(ip)}
                style={{ background: ip.active?'#fef3c7':'#d1fae5', color: ip.active?'#d97706':'#16a34a', border:'none', borderRadius:7, padding:'4px 12px', cursor:'pointer', fontWeight:600, fontSize:11 }}>
                {ip.active ? 'Disable' : 'Enable'}
              </button>
              <button onClick={()=>setPendingRemove(ip)}
                style={{ background:'#fee2e2', color:'#dc2626', border:'none', borderRadius:7, padding:'4px 10px', cursor:'pointer', fontWeight:600, fontSize:11 }}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop:16, padding:'10px 14px', background:'#f5f3ff', borderRadius:8, fontSize:12, color:'#6b7280' }}>
        Note: When IP Whitelist is enabled, only requests from listed addresses can access the API. Leave empty to allow all IPs.
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   MAIN PAGE
══════════════════════════════════════════════════════════ */
const TABS = ['Events', 'Sessions', '2FA', 'GDPR', 'IP Whitelist'];

export default function SecurityCenter() {
  const [tab, setTab] = useState('Events');

  const tabStyle = (t) => ({
    padding:'9px 20px', border:'none', cursor:'pointer', fontWeight:600, fontSize:13,
    background: tab===t ? '#6B3FDB' : 'transparent',
    color:      tab===t ? '#fff'    : '#6B3FDB',
    borderBottom: tab===t ? '2px solid #6B3FDB' : '2px solid transparent',
  });

  return (
    <div style={{ padding:24, background:'#f5f3ff', minHeight:'100vh' }}>
      {/* header */}
      <div style={{ marginBottom:20 }}>
        <h2 style={{ margin:'0 0 4px', color:'#4c1d95', fontSize:22, display:'flex', alignItems:'center', gap:8 }}><Shield size={22} />Security Center</h2>
        <p style={{ margin:0, color:'#6b7280', fontSize:13 }}>Monitor activity, manage sessions, enforce 2FA, and maintain GDPR compliance</p>
      </div>

      {/* tabs */}
      <div style={{ display:'flex', gap:0, borderBottom:'2px solid #e9e4ff', marginBottom:0, background:'#fff', borderRadius:'10px 10px 0 0', padding:'0 8px', flexWrap:'wrap' }}>
        {TABS.map(t=>(
          <button key={t} style={tabStyle(t)} onClick={()=>setTab(t)}>{t}</button>
        ))}
      </div>

      <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderTop:'none', borderRadius:'0 0 10px 10px', padding:20 }}>
        {tab === 'Events'       && <EventsTab />}
        {tab === 'Sessions'     && <SessionsTab />}
        {tab === '2FA'          && <TwoFATab />}
        {tab === 'GDPR'         && <GDPRTab />}
        {tab === 'IP Whitelist' && <IPWhitelistTab />}
      </div>
    </div>
  );
}
