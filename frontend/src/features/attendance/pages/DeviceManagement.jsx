import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Cpu, Plus, RefreshCw, Wifi, WifiOff, AlertTriangle, Activity,
  Clock, MapPin, Shield, AlertCircle, Trash2, Edit2, Zap, List,
  X, ChevronLeft, ChevronRight, CheckCircle, XCircle,
} from 'lucide-react';
import api from '@/services/api/client';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };

const DEVICE_TYPES = [
  { id: 'fingerprint', label: 'Fingerprint',    icon: '👆' },
  { id: 'face',        label: 'Face Only',       icon: '📷' },
  { id: 'face+finger', label: 'Face + Finger',   icon: '🔐' },
  { id: 'card_reader', label: 'Card Reader',     icon: '💳' },
  { id: 'iris',        label: 'Iris',            icon: '👁️' },
];
const VENDORS    = ['ZKTeco', 'eSSL', 'Matrix', 'Suprema', 'Hikvision', 'Realtime', 'Other'];
const DIRECTIONS = [
  { id: 'in',   label: 'In Only'  },
  { id: 'out',  label: 'Out Only' },
  { id: 'both', label: 'Both'     },
];

const EMPTY_DEVICE = {
  device_name: '', device_type: 'fingerprint', location: '',
  ip_address: '', port: 4370, vendor: 'ZKTeco',
  serial_number: '', attendance_direction: 'both',
};

function statusColor(s) {
  if (s === 'online')  return '#10b981';
  if (s === 'offline') return '#9ca3af';
  return '#ef4444';
}
function statusIcon(s) {
  if (s === 'online')  return <Wifi size={14} color="#10b981" />;
  if (s === 'offline') return <WifiOff size={14} color="#9ca3af" />;
  return <AlertTriangle size={14} color="#ef4444" />;
}
function timeSince(iso) {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* ─── Register / Edit form modal ─────────────────────────────── */
function DeviceForm({ device, onSave, onClose }) {
  const [form, setForm] = useState(device || EMPTY_DEVICE);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.device_name.trim() || !form.ip_address.trim()) {
      setErr('Device name and IP address are required'); return;
    }
    setSaving(true); setErr('');
    try {
      const res = form.id
        ? await api.put(`/biometric/devices/${form.id}`, form)
        : await api.post('/biometric/devices', form);
      onSave(res.data);
    } catch (e) {
      setErr(e.response?.data?.message || 'Failed to save device');
    } finally { setSaving(false); }
  };

  const inp = {
    border: '1px solid #e9e4ff', borderRadius: 8, padding: '8px 12px',
    fontSize: 14, width: '100%', outline: 'none', boxSizing: 'border-box',
  };
  const lbl = { fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 560, padding: 28, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{form.id ? 'Edit Device' : 'Register Device'}</h2>
          <button onClick={onClose} style={{ border: 'none', background: '#f5f3ff', borderRadius: 8, padding: 6, cursor: 'pointer' }}><X size={16} /></button>
        </div>
        {err && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: 10, marginBottom: 14, color: '#dc2626', fontSize: 13 }}>{err}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={lbl}>DEVICE NAME *</label>
            <input style={inp} value={form.device_name} onChange={e => set('device_name', e.target.value)} placeholder="e.g. Main Gate – IN" />
          </div>
          <div>
            <label style={lbl}>VENDOR</label>
            <select style={inp} value={form.vendor || ''} onChange={e => set('vendor', e.target.value)}>
              <option value="">Select vendor…</option>
              {VENDORS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>DEVICE TYPE</label>
            <select style={inp} value={form.device_type} onChange={e => set('device_type', e.target.value)}>
              {DEVICE_TYPES.map(t => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>IP ADDRESS *</label>
            <input style={inp} value={form.ip_address} onChange={e => set('ip_address', e.target.value)} placeholder="192.168.1.101" />
          </div>
          <div>
            <label style={lbl}>PORT</label>
            <input style={inp} type="number" value={form.port} onChange={e => set('port', parseInt(e.target.value) || 4370)} />
          </div>
          <div>
            <label style={lbl}>SERIAL NUMBER</label>
            <input style={inp} value={form.serial_number || ''} onChange={e => set('serial_number', e.target.value)} placeholder="e.g. SN-ZK-20241001" />
          </div>
          <div>
            <label style={lbl}>ATTENDANCE DIRECTION</label>
            <select style={inp} value={form.attendance_direction || 'both'} onChange={e => set('attendance_direction', e.target.value)}>
              {DIRECTIONS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={lbl}>LOCATION / BRANCH</label>
            <input style={inp} value={form.location || ''} onChange={e => set('location', e.target.value)} placeholder="e.g. Main Entrance, Factory Block A" />
          </div>
        </div>

        <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 14, padding: '10px 12px', background: '#f9fafb', borderRadius: 8 }}>
          Default port 4370 is the ZKTeco standard. eSSL uses 4370 as well. Suprema BioStar uses 51212.
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 14, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 14, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : form.id ? 'Update Device' : 'Register Device'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Punch log modal ─────────────────────────────────────────── */
function PunchLogModal({ device, onClose }) {
  const [punches, setPunches] = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage]       = useState(0);
  const [date, setDate]       = useState(new Date().toISOString().split('T')[0]);
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit, offset: page * limit });
      if (date) params.set('date', date);
      const res = await api.get(`/biometric/devices/${device.id}/punches?${params}`);
      setPunches(res.data.punches || []);
      setTotal(res.data.total || 0);
    } catch { setPunches([]); setTotal(0); }
    finally { setLoading(false); }
  }, [device.id, page, date]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [date]);

  const pages = Math.ceil(total / limit);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Punch Log — {device.device_name}</h2>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#9ca3af' }}>{device.ip_address}:{device.port} · {device.location || 'No location'}</p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '6px 10px', fontSize: 13 }} />
            <button onClick={onClose} style={{ border: 'none', background: '#f5f3ff', borderRadius: 8, padding: 6, cursor: 'pointer' }}><X size={16} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
          ) : punches.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
              No punch records for {date}. Import CSV data or sync from the device.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 4 }}>
              <thead>
                <tr style={{ background: '#f9fafb', position: 'sticky', top: 0 }}>
                  {['Employee', 'Emp Code', 'Department', 'Time', 'Type'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {punches.map((p, i) => (
                  <tr key={p.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '9px 12px', fontWeight: 500 }}>{p.employee_name || '—'}</td>
                    <td style={{ padding: '9px 12px', color: '#6b7280', fontFamily: 'monospace', fontSize: 12 }}>{p.emp_code || p.employee_id}</td>
                    <td style={{ padding: '9px 12px', color: '#6b7280' }}>{p.department || '—'}</td>
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                      {new Date(p.punch_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>
                    <td style={{ padding: '9px 12px' }}>
                      <span style={{
                        padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                        background: p.punch_type === 'in' ? '#d1fae5' : '#fef3c7',
                        color: p.punch_type === 'in' ? '#065f46' : '#92400e',
                      }}>
                        {(p.punch_type || 'IN').toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {pages > 1 && (
          <div style={{ padding: '12px 24px', borderTop: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span style={{ color: '#6b7280' }}>Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setPage(p => p - 1)} disabled={page === 0}
                style={{ border: '1px solid #e9e4ff', borderRadius: 6, padding: '4px 10px', cursor: page === 0 ? 'not-allowed' : 'pointer', opacity: page === 0 ? 0.4 : 1 }}>
                <ChevronLeft size={14} />
              </button>
              <button onClick={() => setPage(p => p + 1)} disabled={page >= pages - 1}
                style={{ border: '1px solid #e9e4ff', borderRadius: 6, padding: '4px 10px', cursor: page >= pages - 1 ? 'not-allowed' : 'pointer', opacity: page >= pages - 1 ? 0.4 : 1 }}>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Test connection result banner ──────────────────────────── */
function TestResult({ result, onDismiss }) {
  if (!result) return null;
  const ok = result.reachable;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
      borderRadius: 8, marginBottom: 16, fontSize: 13,
      background: ok ? '#f0fdf4' : '#fef2f2',
      border: `1px solid ${ok ? '#86efac' : '#fca5a5'}`,
      color: ok ? '#15803d' : '#dc2626',
    }}>
      {ok ? <CheckCircle size={15} /> : <XCircle size={15} />}
      <span style={{ flex: 1 }}>
        {ok
          ? `Connected to ${result.ip_address}:${result.port} — ${result.latency_ms}ms response`
          : `Cannot reach ${result.ip_address}:${result.port} — ${result.error}`}
      </span>
      <button onClick={onDismiss} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0 }}><X size={13} /></button>
    </div>
  );
}

/* ─── Main component ─────────────────────────────────────────── */
export default function DeviceManagement() {
  const [devices, setDevices]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [showForm, setShowForm]     = useState(false);
  const [editDevice, setEditDevice] = useState(null);
  const [syncing, setSyncing]       = useState({});
  const [testing, setTesting]       = useState({});
  const [deleting, setDeleting]     = useState({});
  const [testResult, setTestResult] = useState(null);
  const [punchLogDevice, setPunchLogDevice] = useState(null);
  const [msg, setMsg]               = useState('');
  const [confirmDelete, setConfirmDelete]   = useState(null);
  const intervalRef = useRef(null);

  const flash = (text) => { setMsg(text); setTimeout(() => setMsg(''), 4000); };

  const load = useCallback(async () => {
    try {
      const res = await api.get('/biometric/devices');
      setDevices(Array.isArray(res.data) ? res.data : []);
    } catch { setDevices([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 30000);
    return () => clearInterval(intervalRef.current);
  }, [load]);

  const handleSync = async (device) => {
    setSyncing(s => ({ ...s, [device.id]: true }));
    try {
      const res = await api.post(`/biometric/devices/${device.id}/sync`);
      const data = res.data;
      setDevices(prev => prev.map(d => d.id === device.id
        ? { ...d, last_sync: new Date().toISOString(), status: data.status || d.status }
        : d
      ));
      flash(data.message || `Synced: ${device.device_name}`);
    } catch (e) {
      const data = e.response?.data;
      if (data?.status) {
        setDevices(prev => prev.map(d => d.id === device.id ? { ...d, status: data.status } : d));
      }
      flash(data?.message || 'Sync failed');
    } finally {
      setSyncing(s => ({ ...s, [device.id]: false }));
    }
  };

  const handleTest = async (device) => {
    setTesting(s => ({ ...s, [device.id]: true }));
    setTestResult(null);
    try {
      const res = await api.post(`/biometric/devices/${device.id}/test`);
      const data = res.data;
      setDevices(prev => prev.map(d => d.id === device.id ? { ...d, status: data.status } : d));
      setTestResult(data);
    } catch (e) {
      setTestResult({ reachable: false, ip_address: device.ip_address, port: device.port, error: e.response?.data?.message || 'Request failed' });
    } finally {
      setTesting(s => ({ ...s, [device.id]: false }));
    }
  };

  const handleDelete = async (device) => {
    setDeleting(s => ({ ...s, [device.id]: true }));
    try {
      await api.delete(`/biometric/devices/${device.id}`);
      setDevices(prev => prev.filter(d => d.id !== device.id));
      flash(`${device.device_name} removed`);
    } catch (e) {
      flash(e.response?.data?.message || 'Delete failed');
    } finally {
      setDeleting(s => ({ ...s, [device.id]: false }));
      setConfirmDelete(null);
    }
  };

  const handleSave = (saved) => {
    setDevices(prev => {
      const exists = prev.find(d => d.id === saved.id);
      return exists ? prev.map(d => d.id === saved.id ? { ...saved, total_punches_today: d.total_punches_today } : d) : [...prev, { ...saved, total_punches_today: 0 }];
    });
    setShowForm(false); setEditDevice(null);
    flash('Device saved');
  };

  const online       = devices.filter(d => d.status === 'online').length;
  const offline      = devices.filter(d => d.status === 'offline').length;
  const errors       = devices.filter(d => d.status === 'error').length;
  const totalPunches = devices.reduce((s, d) => s + (parseInt(d.total_punches_today) || 0), 0);

  const dirLabel = (dir) => DIRECTIONS.find(d => d.id === dir)?.label || dir || 'Both';
  const typeLabel = (t) => DEVICE_TYPES.find(x => x.id === t)?.label || t;

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif', margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1f2937' }}>Device Management</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Biometric device registration, health monitoring, and punch sync · Auto-refreshes every 30s</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => { setLoading(true); load(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 10, border: '1px solid #e9e4ff', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => { setEditDevice(null); setShowForm(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 18px', borderRadius: 10, border: 'none', background: P, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
            <Plus size={16} /> Register Device
          </button>
        </div>
      </div>

      {/* Flash message */}
      {msg && (
        <div style={{
          background: msg.includes('fail') || msg.includes('unreachable') || msg.includes('error') ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${msg.includes('fail') || msg.includes('unreachable') || msg.includes('error') ? '#fca5a5' : '#86efac'}`,
          borderRadius: 8, padding: '10px 14px', marginBottom: 16,
          color: msg.includes('fail') || msg.includes('unreachable') || msg.includes('error') ? '#dc2626' : '#15803d',
          fontSize: 13,
        }}>{msg}</div>
      )}

      {/* Test connection result */}
      <TestResult result={testResult} onDismiss={() => setTestResult(null)} />

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
        {[
          { label: 'Online',        value: online,       color: '#10b981', icon: Wifi },
          { label: 'Offline',       value: offline,      color: '#9ca3af', icon: WifiOff },
          { label: 'Error',         value: errors,       color: '#ef4444', icon: AlertTriangle },
          { label: 'Punches Today', value: totalPunches, color: P,         icon: Activity },
        ].map(k => (
          <div key={k.label} style={{ ...CARD, padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: `${k.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <k.icon size={18} color={k.color} />
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#1f2937' }}>{k.value}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Vendor info bar */}
      <div style={{ background: '#f5f3ff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#4b5563' }}>
        <Shield size={13} color={P} style={{ verticalAlign: 'middle', marginRight: 6 }} />
        <strong>Supported vendors:</strong> ZKTeco, eSSL, Matrix, Suprema, Hikvision, Realtime
        &nbsp;·&nbsp; Default port: 4370 (ZKTeco / eSSL standard)
        &nbsp;·&nbsp; Communication: TCP/IP — Test Connection pings the real device socket
        &nbsp;·&nbsp; <span style={{ color: '#d97706', fontWeight: 600 }}>SDK: node-zklib required for live punch sync</span>
      </div>

      {/* Device list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading devices…</div>
      ) : devices.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60 }}>
          <Cpu size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#9ca3af', margin: 0, fontSize: 14 }}>No devices registered yet.</p>
          <button onClick={() => setShowForm(true)}
            style={{ marginTop: 14, background: P, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            Register First Device
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {devices.map(d => (
            <div key={d.id} style={{ ...CARD, padding: '16px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>

                {/* Status indicator */}
                <div style={{ width: 46, height: 46, borderRadius: 12, background: `${statusColor(d.status)}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {statusIcon(d.status)}
                </div>

                {/* Device info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#111827' }}>{d.device_name}</h3>
                    <span style={{ background: `${statusColor(d.status)}18`, color: statusColor(d.status), borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                      {d.status}
                    </span>
                    {d.vendor && <span style={{ background: '#f5f3ff', color: P, borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 500 }}>{d.vendor}</span>}
                    {d.attendance_direction && d.attendance_direction !== 'both' && (
                      <span style={{ background: '#fef3c7', color: '#92400e', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 500 }}>
                        {dirLabel(d.attendance_direction)}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 14, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
                    <span><Cpu size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />{typeLabel(d.device_type)}</span>
                    {d.location && <span><MapPin size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />{d.location}</span>}
                    <span style={{ fontFamily: 'monospace' }}>IP: {d.ip_address}:{d.port}</span>
                    {d.serial_number && <span style={{ fontFamily: 'monospace' }}>S/N: {d.serial_number}</span>}
                    <span><Clock size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />Last sync: {timeSince(d.last_sync)}</span>
                    <span><Activity size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />{parseInt(d.total_punches_today) || 0} punches today</span>
                  </div>
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button onClick={() => handleSync(d)} disabled={syncing[d.id]}
                    title="Sync device"
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 12, cursor: syncing[d.id] ? 'not-allowed' : 'pointer', color: P, fontWeight: 500, opacity: syncing[d.id] ? 0.6 : 1 }}>
                    <RefreshCw size={12} /> {syncing[d.id] ? 'Syncing…' : 'Sync'}
                  </button>
                  <button onClick={() => handleTest(d)} disabled={testing[d.id]}
                    title="Test TCP connection to device"
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 12, cursor: testing[d.id] ? 'not-allowed' : 'pointer', color: '#0369a1', fontWeight: 500, opacity: testing[d.id] ? 0.6 : 1 }}>
                    <Zap size={12} /> {testing[d.id] ? 'Pinging…' : 'Test Conn'}
                  </button>
                  <button onClick={() => setPunchLogDevice(d)}
                    title="View punch log"
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 12, cursor: 'pointer', color: '#374151', fontWeight: 500 }}>
                    <List size={12} /> Punch Log
                  </button>
                  <button onClick={() => { setEditDevice(d); setShowForm(true); }}
                    title="Edit device"
                    style={{ border: 'none', background: '#f0f9ff', borderRadius: 8, padding: '6px 9px', cursor: 'pointer', color: '#0369a1' }}>
                    <Edit2 size={13} />
                  </button>
                  <button onClick={() => setConfirmDelete(d)}
                    title="Delete device"
                    style={{ border: 'none', background: '#fef2f2', borderRadius: 8, padding: '6px 9px', cursor: 'pointer', color: '#dc2626' }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Offline/Error advisory */}
      {devices.some(d => d.status !== 'online') && (
        <div style={{ ...CARD, marginTop: 16, background: '#fffbeb', border: '1px solid #fde68a', padding: '14px 18px' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <AlertCircle size={16} color="#d97706" style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#92400e', marginBottom: 3 }}>Offline / Error Devices</div>
              <div style={{ fontSize: 12, color: '#92400e' }}>
                Use <strong>Test Conn</strong> to verify TCP reachability. Offline devices queue punches internally — sync after connectivity is restored.
                Error devices need manual intervention: check IP, port, network ACLs, and device power.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SDK notice */}
      <div style={{ ...CARD, marginTop: 16, background: '#f0f9ff', border: '1px solid #bae6fd', padding: '14px 18px' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Cpu size={15} color="#0369a1" style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#0c4a6e', marginBottom: 3 }}>Live Punch Sync — SDK Required</div>
            <div style={{ fontSize: 12, color: '#0369a1' }}>
              Test Connection pings the real device socket. Punch record import requires installing{' '}
              <code style={{ background: '#e0f2fe', padding: '1px 5px', borderRadius: 4 }}>node-zklib</code> (ZKTeco / eSSL) or the vendor's Node.js SDK.
              CSV import is available in HR → Biometric Access as a manual alternative.
            </div>
          </div>
        </div>
      </div>

      {/* Delete confirm dialog */}
      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 28, width: 380, maxWidth: '90vw' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, color: '#111827' }}>Remove Device?</h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>
              <strong>{confirmDelete.device_name}</strong> ({confirmDelete.ip_address}) will be permanently removed.
              Punch logs already imported will remain in the attendance records.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDelete(null)}
                style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={() => handleDelete(confirmDelete)} disabled={deleting[confirmDelete.id]}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, opacity: deleting[confirmDelete.id] ? 0.6 : 1 }}>
                {deleting[confirmDelete.id] ? 'Removing…' : 'Remove Device'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <DeviceForm
          device={editDevice}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditDevice(null); }}
        />
      )}

      {punchLogDevice && (
        <PunchLogModal device={punchLogDevice} onClose={() => setPunchLogDevice(null)} />
      )}
    </div>
  );
}
