import { useState, useEffect } from 'react';
import { Plus, RefreshCw, AlertCircle, X, BarChart2, Sliders, CheckCircle } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, Cell, ReferenceLine
} from 'recharts';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';

const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'];
const inp = { background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '8px 12px', fontSize: 13, width: '100%', color: 'var(--color-text-primary)' };

export default function CalibrationCenter() {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid these controls from anyone holding hr as a
  // secondary role. See AuthContext.
  const { hasAnyRole } = useAuth();
  const isHR = hasAnyRole('hr', 'super_admin', 'admin');

  const [tab, setTab]           = useState('bell-curve');
  const [sessions, setSessions] = useState([]);
  const [bellData, setBellData] = useState({ distribution: [], total: 0, weighted_avg: 0 });
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [dept, setDept]         = useState('');
  const [form, setForm]         = useState({ session_name: '', session_date: '', department: '', notes: '' });
  const [deptList, setDeptList] = useState([]);

  async function loadBell() {
    try {
      const res = await api.get(`/performance/calibration/bell-curve${dept ? `?department=${dept}` : ''}`);
      setBellData(res.data || { distribution: [], total: 0, weighted_avg: 0 });
    } catch (e) { setError(e.message); }
  }

  async function loadSessions() {
    try {
      const res = await api.get('/performance/calibration/sessions');
      setSessions(res.data || []);
    } catch (e) { setError(e.message); }
  }

  async function load() {
    setLoading(true);
    await Promise.allSettled([loadBell(), loadSessions()]);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);
  useEffect(() => { if (tab === 'bell-curve') loadBell(); }, [dept, tab]);
  useEffect(() => {
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  async function createSession() {
    if (!form.session_name) return;
    setSaving(true);
    try {
      await api.post('/performance/calibration/sessions', form);
      setShowForm(false);
      setForm({ session_name: '', session_date: '', department: '', notes: '' });
      loadSessions();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function finalizeSession(id) {
    try { await api.post(`/performance/calibration/sessions/${id}/finalize`); loadSessions(); }
    catch (e) { setError(e.message); }
  }

  const dist   = bellData.distribution || [];
  const avgVal = bellData.weighted_avg || 0;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Calibration Center</h1>
        {isHR && tab === 'sessions' && (
          <button onClick={() => setShowForm(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <Plus size={15} /> New Session
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid var(--color-border-tertiary)' }}>
        {[{ key: 'bell-curve', label: 'Bell Curve' }, { key: 'sessions', label: 'Sessions' }].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '8px 20px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13,
            fontWeight: tab === t.key ? 600 : 400,
            color: tab === t.key ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            borderBottom: tab === t.key ? '2px solid var(--color-primary)' : '2px solid transparent',
            marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {error && (
        <div style={{ background: '#ef444418', color: '#ef4444', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={15} /> {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}><X size={14} /></button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}><RefreshCw size={18} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-primary)' }} /></div>
      ) : tab === 'bell-curve' ? (
        <div>
          {/* Summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Total Employees Rated', value: bellData.total },
              { label: 'Weighted Avg Rating', value: avgVal.toFixed(2) },
              { label: 'Rating Bands', value: dist.length },
            ].map(k => (
              <div key={k.label} style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '16px 20px' }}>
                <p style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--color-text-primary)' }}>{k.value}</p>
                <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0 }}>{k.label}</p>
              </div>
            ))}
          </div>

          {/* Dept filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <label style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>Filter by Department:</label>
            <select style={{ ...inp, width: 200 }} value={dept} onChange={e => setDept(e.target.value)}>
              <option value="">All Departments</option>
              {deptList.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          {dist.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
              <BarChart2 size={36} style={{ marginBottom: 12, opacity: 0.4 }} />
              <p style={{ margin: 0 }}>No completed reviews with ratings yet</p>
            </div>
          ) : (
            <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <BarChart2 size={15} /> Rating Distribution (Bell Curve)
                <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 400, color: 'var(--color-text-secondary)' }}>
                  Avg: <strong>{avgVal.toFixed(2)}</strong>
                </span>
              </h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={dist} margin={{ top: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" />
                  <XAxis dataKey="rating_band" tick={{ fontSize: 12 }} label={{ value: 'Rating', position: 'insideBottom', offset: -4, fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} label={{ value: 'Employees', angle: -90, position: 'insideLeft', fontSize: 12 }} />
                  <Tooltip formatter={(v, n, { payload }) => [v, 'Employees']} labelFormatter={l => `Rating: ${l}`} />
                  <ReferenceLine x={avgVal.toFixed(1)} stroke="#8b5cf6" strokeDasharray="4 4" label={{ value: 'Avg', fill: '#8b5cf6', fontSize: 11 }} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {dist.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>

              {/* Percentage breakdown */}
              <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                {dist.map((d, i) => (
                  <div key={i} style={{ background: `${COLORS[i % COLORS.length]}18`, padding: '6px 12px', borderRadius: 8, fontSize: 12 }}>
                    <strong style={{ color: COLORS[i % COLORS.length] }}>Rating {d.rating_band}</strong>: {d.count} ({d.percentage}%)
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div>
          {showForm && (
            <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 16px' }}>New Calibration Session</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Session Name *</label><input style={inp} value={form.session_name} onChange={e => setForm(f => ({ ...f, session_name: e.target.value }))} placeholder="e.g. Q4 2026 Calibration" /></div>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Session Date</label><input type="date" style={inp} value={form.session_date} onChange={e => setForm(f => ({ ...f, session_date: e.target.value }))} /></div>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Department</label>
                  <select style={inp} value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))}>
                    <option value="">All Departments</option>
                    {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Notes</label><input style={inp} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button onClick={createSession} disabled={saving} style={{ padding: '8px 20px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{saving ? 'Creating...' : 'Create Session'}</button>
                <button onClick={() => setShowForm(false)} style={{ padding: '8px 20px', background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          {sessions.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
              <Sliders size={36} style={{ marginBottom: 12, opacity: 0.4 }} />
              <p style={{ margin: 0 }}>No calibration sessions yet</p>
              {isHR && <p style={{ margin: '4px 0 0', fontSize: 13 }}>Create a session to begin calibrating ratings</p>}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {sessions.map(s => {
                const statusColor = s.status === 'completed' ? '#10b981' : s.status === 'in_progress' ? '#3b82f6' : '#f59e0b';
                return (
                  <div key={s.id} style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 14 }}>{s.session_name}</p>
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', gap: 16 }}>
                        {s.session_date && <span>Date: {s.session_date?.slice(0, 10)}</span>}
                        {s.department && <span>Dept: {s.department}</span>}
                        <span>Adjustments: {s.adjustment_count}</span>
                        {s.facilitator_name && <span>Facilitator: {s.facilitator_name}</span>}
                      </div>
                    </div>
                    <span style={{ background: `${statusColor}18`, color: statusColor, padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>{s.status}</span>
                    {isHR && s.status !== 'completed' && (
                      <button onClick={() => finalizeSession(s.id)} style={{ padding: '6px 14px', background: '#10b98118', color: '#10b981', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <CheckCircle size={12} /> Finalize
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
