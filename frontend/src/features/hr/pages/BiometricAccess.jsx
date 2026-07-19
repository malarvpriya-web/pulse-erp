// frontend/src/features/hr/pages/BiometricAccess.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';

const STATUS_COLORS = { online:'#16a34a', offline:'#6b7280', error:'#dc2626' };
const GATE_STATUS_COLORS = { active:'#16a34a', approved:'#2563eb', pending:'#d97706', expired:'#6b7280', cancelled:'#dc2626' };

function tabStyle(active) {
  return { padding: '8px 20px', border: 'none', cursor: 'pointer', borderRadius: '6px 6px 0 0', fontWeight: 600, fontSize: 14, background: active ? '#6B3FDB' : '#e9e4ff', color: active ? '#fff' : '#6B3FDB' };
}

function relativeTime(iso) {
  if (!iso) return '—';
  const diff = (new Date() - new Date(iso)) / 60000;
  if (diff < 2) return 'Just now';
  if (diff < 60) return `${Math.floor(diff)}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

export default function BiometricAccess() {
  const { user } = useAuth();
  const [tab, setTab]             = useState('attendance');
  const [devices, setDevices]     = useState([]);
  const [punches, setPunches]     = useState([]);
  const [gatePasses, setGatePasses] = useState([]);
  const [visitors, setVisitors]   = useState([]);
  const [dashStats, setDashStats] = useState(null);
  const [syncing, setSyncing]     = useState({});
  const [importPreview, setImportPreview] = useState([]);
  const [csvRaw, setCsvRaw]       = useState('');
  const [_importError, setImportError]   = useState('');
  const [showGateForm, setShowGateForm] = useState(false);
  const [showVisitorForm, setShowVisitorForm] = useState(false);
  const [gateForm, setGateForm]   = useState({ employee_id:'', visitor_name:'', purpose:'', valid_from:'', valid_to:'' });
  const [visitorForm, setVisitorForm] = useState({ name:'', company:'', phone:'', email:'', host_employee_id:'', purpose:'', id_type:'Aadhaar', id_number:'' });
  const [msg, setMsg]             = useState({ text:'', type:'' });
  const [loading, setLoading]     = useState(false);
  const fileRef = useRef(null);

  const flash = (text, type = 'success') => { setMsg({ text, type }); setTimeout(() => setMsg({ text:'', type:'' }), 3500); };

  const loadAll = useCallback(async () => {
    const [devRes, punchRes, gateRes, visRes, dashRes] = await Promise.allSettled([
      api.get('/biometric/devices'),
      api.get(`/biometric/logs?date=${new Date().toISOString().split('T')[0]}&limit=50`),
      api.get('/gate-passes'),
      api.get('/visitors'),
      api.get('/biometric/dashboard'),
    ]);
    if (devRes.status === 'fulfilled' && devRes.value.data?.length)   setDevices(devRes.value.data);
    if (punchRes.status === 'fulfilled' && punchRes.value.data?.length) setPunches(punchRes.value.data);
    if (gateRes.status === 'fulfilled' && gateRes.value.data?.length) setGatePasses(gateRes.value.data);
    if (visRes.status === 'fulfilled' && visRes.value.data?.length)   setVisitors(visRes.value.data);
    if (dashRes.status === 'fulfilled') setDashStats(dashRes.value.data);
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  const syncDevice = async (deviceId) => {
    setSyncing(s => ({ ...s, [deviceId]: true }));
    try {
      await api.post(`/biometric/devices/${deviceId}/sync`);
      flash(`Device synced successfully`);
      loadAll();
    } catch (err) { flash(err.response?.data?.message || 'Sync failed', 'error'); }
    finally { setSyncing(s => ({ ...s, [deviceId]: false })); }
  };

  const handleCsvFile = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const raw = ev.target.result; setCsvRaw(raw); setImportError('');
      const lines = raw.trim().split('\n');
      const header = lines[0].toLowerCase().split(',').map(h => h.trim());
      const preview = [];
      for (let i = 1; i < Math.min(lines.length, 6); i++) {
        const cols = lines[i].split(',').map(c => c.trim());
        const row = {}; header.forEach((h, j) => { row[h] = cols[j]; });
        preview.push(row);
      }
      setImportPreview(preview);
    };
    reader.readAsText(file);
  };

  const confirmImport = async () => {
    if (!csvRaw) return;

    try {
      const r = await api.post('/biometric/logs/import', { csv_data: csvRaw });
      flash(`Imported ${r.data.imported} records`);
      setImportPreview([]); setCsvRaw(''); if (fileRef.current) fileRef.current.value = '';
      loadAll();
    } catch (err) { flash(err.response?.data?.message || 'Import failed', 'error'); }
    finally { setLoading(false); }
  };

  const approveGatePass = async (id) => {
    try {
      await api.put(`/gate-passes/${id}/approve`, { approved_by: user?.employee_id });
      flash('Gate pass approved'); loadAll();
    } catch { flash('Approval failed', 'error'); }
  };

  const addGatePass = async (e) => {
    e.preventDefault(); try {
      await api.post('/gate-passes', gateForm);
      flash('Gate pass created'); setShowGateForm(false);
      setGateForm({ employee_id:'', visitor_name:'', purpose:'', valid_from:'', valid_to:'' }); loadAll();
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
    finally { setLoading(false); }
  };

  const addVisitor = async (e) => {
    e.preventDefault(); try {
      await api.post('/visitors', visitorForm);
      flash('Visitor checked in'); setShowVisitorForm(false);
      setVisitorForm({ name:'', company:'', phone:'', email:'', host_employee_id:'', purpose:'', id_type:'Aadhaar', id_number:'' }); loadAll();
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
    finally { setLoading(false); }
  };

  const checkOutVisitor = async (id) => {
    try {
      await api.put(`/visitors/${id}/checkout`); flash('Visitor checked out'); loadAll();
    } catch { flash('Checkout failed', 'error'); }
  };

  const punchPieData = [
    { name: 'Punched In',  value: dashStats?.punched_in_today ?? 0 },
    { name: 'Not Punched', value: dashStats?.not_yet_punched ?? 0 },
  ];

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>🔒 Biometric & Access Control</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>Attendance import, gate passes, visitor management and device monitoring</p>
      </div>

      {/* today's stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10, marginBottom: 20 }}>
        {[
          { label:'Punched In',     value:dashStats?.punched_in_today ?? 0,  color:'#16a34a', icon:'✅' },
          { label:'Not Punched',    value:dashStats?.not_yet_punched ?? 0,   color:'#d97706', icon:'⏳' },
          { label:'Late Arrivals',  value:dashStats?.late_arrivals ?? 0,     color:'#dc2626', icon:'🕐' },
          { label:'Early Exits',    value:dashStats?.early_departures ?? 0,  color:'#f97316', icon:'🏃' },
          { label:'Visitors Inside',value:dashStats?.visitors_inside ?? 0,   color:'#6B3FDB', icon:'🪪' },
        ].map(s => (
          <div key={s.label} style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 18 }}>{s.icon}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color, marginTop: 4 }}>{s.value}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {msg.text && <div style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14, background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a', border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{msg.text}</div>}

      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e9e4ff', flexWrap: 'wrap' }}>
        {[['attendance','Attendance Import'],['passes','Gate Passes'],['visitors','Visitor Management']].map(([k,l]) => (
          <button key={k} style={tabStyle(tab===k)} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 8px 8px 8px', padding: 20 }}>

        {/* ── ATTENDANCE IMPORT ── */}
        {tab === 'attendance' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 20, alignItems: 'start' }}>
              <div>
                <h4 style={{ color: '#4c1d95', margin: '0 0 14px' }}>Registered Biometric Devices</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                  {devices.map(d => (
                    <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: '#f5f3ff', borderRadius: 10, border: '1px solid #e9e4ff', flexWrap: 'wrap', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 10, height: 10, borderRadius: '50%', background: STATUS_COLORS[d.status], flexShrink: 0 }} />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{d.device_name}</div>
                          <div style={{ fontSize: 12, color: '#6b7280' }}>{d.location} · {d.ip_address}:{d.port} · {d.device_type}</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                        <div style={{ textAlign: 'right', fontSize: 12 }}>
                          <div style={{ color: '#6b7280' }}>Last sync: {relativeTime(d.last_sync)}</div>
                          <div style={{ color: '#6B3FDB', fontWeight: 600 }}>{d.total_punches_today} punches today</div>
                        </div>
                        <button onClick={() => syncDevice(d.id)} disabled={syncing[d.id] || d.status === 'offline'}
                          style={{ background: d.status === 'offline' ? '#e5e7eb' : '#6B3FDB', color: d.status === 'offline' ? '#9ca3af' : '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', cursor: d.status === 'offline' ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap' }}>
                          {syncing[d.id] ? '⏳ Syncing…' : '↻ Sync Now'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* CSV import */}
                <h4 style={{ color: '#4c1d95', margin: '0 0 10px' }}>Manual CSV Import</h4>
                <div style={{ background: '#f5f3ff', border: '2px dashed #a78bfa', borderRadius: 10, padding: 20, textAlign: 'center', marginBottom: 14 }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
                  <p style={{ margin: '0 0 8px', color: '#4c1d95', fontWeight: 600 }}>Drop CSV file or click to upload</p>
                  <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>Expected format: <code>employee_id, punch_time, punch_type</code><br />Compatible with ZKTeco / HID device exports</p>
                  <input ref={fileRef} type="file" accept=".csv" onChange={handleCsvFile} style={{ display: 'none' }} id="csv-upload" />
                  <label htmlFor="csv-upload"
                    style={{ display: 'inline-block', background: '#6B3FDB', color: '#fff', padding: '8px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                    Select CSV File
                  </label>
                </div>

                {importPreview.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 600, color: '#4c1d95', marginBottom: 8, fontSize: 13 }}>Preview (first 5 rows):</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead><tr style={{ background: '#f5f3ff' }}>
                          {Object.keys(importPreview[0]).map(k => <th key={k} style={{ padding: '5px 10px', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', textAlign: 'left' }}>{k}</th>)}
                        </tr></thead>
                        <tbody>
                          {importPreview.map((row, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid #f0ebff' }}>
                              {Object.values(row).map((v, j) => <td key={j} style={{ padding: '5px 10px' }}>{v}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <button onClick={confirmImport} disabled={loading}
                      style={{ marginTop: 10, background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 20px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                      {loading ? 'Importing…' : '✓ Confirm Import'}
                    </button>
                  </div>
                )}
              </div>

              {/* punch donut */}
              <div style={{ background: '#f5f3ff', borderRadius: 12, padding: 16, border: '1px solid #e9e4ff', minWidth: 200, textAlign: 'center' }}>
                <h4 style={{ margin: '0 0 10px', color: '#4c1d95', fontSize: 13 }}>Today's Attendance</h4>
                <div style={{ height: 160 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={punchPieData} cx="50%" cy="50%" innerRadius={45} outerRadius={70} dataKey="value">
                        <Cell fill="#6B3FDB" />
                        <Cell fill="#e9e4ff" />
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#6B3FDB' }}>{dashStats?.punched_in_today ?? 0}</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>of {dashStats?.total_employees ?? 0} punched in</div>
              </div>
            </div>

            {/* recent punch log */}
            <h4 style={{ color: '#4c1d95', margin: '24px 0 12px' }}>Recent Punch Log — Today</h4>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: '#f5f3ff' }}>
                  {['Employee','Department','Time','Type','Device'].map(h => <th key={h} style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600 }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {punches.map(p => (
                    <tr key={p.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 600 }}>{p.employee_name}</td>
                      <td style={{ padding: '8px 12px', color: '#6b7280' }}>{p.department}</td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{new Date(p.punch_time).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' })}</td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: p.punch_type === 'in' ? '#d1fae5' : '#fef3c7', color: p.punch_type === 'in' ? '#16a34a' : '#d97706' }}>
                          {p.punch_type.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px', color: '#6b7280', fontSize: 12 }}>{p.device_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── GATE PASSES ── */}
        {tab === 'passes' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: '#4c1d95' }}>Gate Pass Management</h3>
              <button onClick={() => setShowGateForm(f => !f)}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
                {showGateForm ? '✕ Cancel' : '+ New Gate Pass'}
              </button>
            </div>

            {showGateForm && (
              <form onSubmit={addGatePass} style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid #e9e4ff' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
                  {[['employee_id','Employee ID','number'],['visitor_name','Name / Purpose','text'],['purpose','Reason','text']].map(([key, label, type]) => (
                    <div key={key}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>{label}</label>
                      <input type={type} value={gateForm[key]} onChange={e => setGateForm(f => ({ ...f, [key]: e.target.value }))}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                    </div>
                  ))}
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Valid From</label>
                    <input type="datetime-local" value={gateForm.valid_from} onChange={e => setGateForm(f => ({ ...f, valid_from: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Valid To</label>
                    <input type="datetime-local" value={gateForm.valid_to} onChange={e => setGateForm(f => ({ ...f, valid_to: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                </div>
                <button type="submit" disabled={loading} style={{ marginTop: 14, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 600 }}>
                  {loading ? 'Creating…' : 'Create Gate Pass'}
                </button>
              </form>
            )}

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ background: '#f5f3ff' }}>
                {['Pass No.','Employee','Name/Purpose','Reason','Valid From','Valid To','Status','Action'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600 }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {gatePasses.map(gp => (
                  <tr key={gp.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 700, color: '#6B3FDB' }}>{gp.pass_number || '—'}</td>
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>{gp.employee_name}</td>
                    <td style={{ padding: '8px 12px', color: '#6b7280' }}>{gp.visitor_name}</td>
                    <td style={{ padding: '8px 12px', color: '#6b7280', fontSize: 12 }}>{gp.purpose}</td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', fontSize: 12 }}>{gp.valid_from ? new Date(gp.valid_from).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', fontSize: 12 }}>{gp.valid_to ? new Date(gp.valid_to).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: (GATE_STATUS_COLORS[gp.status] || '#6b7280') + '20', color: GATE_STATUS_COLORS[gp.status] || '#6b7280' }}>{gp.status}</span>
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      {gp.status === 'pending' && (
                        <button onClick={() => approveGatePass(gp.id)}
                          style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 11, marginRight: 4 }}>Approve</button>
                      )}
                      {gp.pass_number && (
                        <button onClick={() => window.print()}
                          style={{ background: '#e9e4ff', color: '#6B3FDB', border: 'none', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 11 }}>Print</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── VISITORS ── */}
        {tab === 'visitors' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, color: '#4c1d95' }}>Visitor Management</h3>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>{visitors.filter(v => !v.check_out_time).length} visitors currently inside</p>
              </div>
              <button onClick={() => setShowVisitorForm(f => !f)}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
                {showVisitorForm ? '✕ Cancel' : '+ New Visitor'}
              </button>
            </div>

            {showVisitorForm && (
              <form onSubmit={addVisitor} style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid #e9e4ff' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
                  {[['name','Visitor Name *','text'],['company','Company','text'],['phone','Phone','text'],['email','Email','email'],['host_employee_id','Host Employee ID','number'],['purpose','Purpose','text'],['id_number','ID Number','text']].map(([key, label, type]) => (
                    <div key={key}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>{label}</label>
                      <input type={type} required={key==='name'} value={visitorForm[key]} onChange={e => setVisitorForm(f => ({ ...f, [key]: e.target.value }))}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                    </div>
                  ))}
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>ID Type</label>
                    <select value={visitorForm.id_type} onChange={e => setVisitorForm(f => ({ ...f, id_type: e.target.value }))}
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
                      {['Aadhaar','PAN','Passport','DL','Voter ID','Other'].map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                  <button type="submit" disabled={loading} style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 600 }}>
                    {loading ? 'Checking in…' : 'Check In'}
                  </button>
                  <button type="button" onClick={() => flash('Badge printed (demo)')}
                    style={{ background: '#e9e4ff', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
                    🖨️ Print Badge
                  </button>
                </div>
              </form>
            )}

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ background: '#f5f3ff' }}>
                {['Visitor','Company','Phone','Host','Purpose','Check In','Check Out','Action'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600 }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {visitors.map(v => (
                  <tr key={v.id} style={{ borderBottom: '1px solid #f0ebff', background: !v.check_out_time ? '#fafffe' : '#fff' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                      {v.name}
                      {v.badge_printed && <span style={{ marginLeft: 6, fontSize: 10, background: '#dbeafe', color: '#2563eb', padding: '1px 5px', borderRadius: 8, fontWeight: 600 }}>Badge ✓</span>}
                    </td>
                    <td style={{ padding: '8px 12px', color: '#6b7280' }}>{v.company || '—'}</td>
                    <td style={{ padding: '8px 12px', color: '#6b7280' }}>{v.phone}</td>
                    <td style={{ padding: '8px 12px' }}>{v.host_name || '—'}</td>
                    <td style={{ padding: '8px 12px', color: '#6b7280', fontSize: 12 }}>{v.purpose}</td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(v.check_in_time).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' })}</td>
                    <td style={{ padding: '8px 12px', color: v.check_out_time ? '#6b7280' : '#16a34a', fontWeight: v.check_out_time ? 400 : 600, fontSize: 12 }}>
                      {v.check_out_time ? new Date(v.check_out_time).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }) : 'Inside'}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      {!v.check_out_time && (
                        <button onClick={() => checkOutVisitor(v.id)}
                          style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 11 }}>Check Out</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      </div>
    </div>
  );
}
