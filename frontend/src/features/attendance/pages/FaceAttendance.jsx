import { useState, useEffect, useCallback } from 'react';
import {
  Camera, Shield, AlertTriangle, Check, Save, Eye, EyeOff,
  RefreshCw, Lock, Sliders, Info, Cpu, UserCheck, UserX,
  Trash2, Bell, ChevronDown, Filter,
} from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };

const DEFAULTS = {
  enabled: false,
  selfie_required: false,
  liveness_detection: true,
  anti_spoof: true,
  allow_glasses: true,
  allow_mask: false,
  capture_photo_on_punch: false,
  anti_spoof_threshold: 0.7,
  confidence_threshold: 0.85,
  allowed_devices: 'all',
  max_attempts: 3,
  lock_duration_minutes: 15,
};

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      style={{
        border: 'none', background: 'none',
        cursor: disabled ? 'default' : 'pointer',
        padding: 0, display: 'flex', alignItems: 'center',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div style={{
        width: 44, height: 24, borderRadius: 12,
        background: checked ? P : '#d1d5db',
        position: 'relative', transition: 'background 0.2s',
      }}>
        <div style={{
          width: 18, height: 18, borderRadius: '50%', background: '#fff',
          position: 'absolute', top: 3,
          left: checked ? 23 : 3, transition: 'left 0.2s',
        }} />
      </div>
    </button>
  );
}

function ThresholdSlider({ label, desc, value, onChange }) {
  const pct   = Math.round((value ?? 0) * 100);
  const color = pct >= 80 ? '#10b981' : pct >= 60 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, color: '#1f2937' }}>{label}</div>
          <div style={{ fontSize: 12, color: '#9ca3af' }}>{desc}</div>
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color }}>{pct}%</div>
      </div>
      <input
        type="range" min={0} max={1} step={0.01} value={value ?? 0}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: color }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
        <span>Low (0%)</span><span>High (100%)</span>
      </div>
    </div>
  );
}

function StatCard({ label, value, color, icon: Icon, sub }) {
  return (
    <div style={{ ...CARD, padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        background: `${color}18`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Icon size={18} color={color} />
      </div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 700, color: '#1f2937' }}>{value}</div>
        <div style={{ fontSize: 11, color: '#6b7280' }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  );
}

const ACTION_LABELS = {
  face_failed: { label: 'Low Confidence',   bg: '#fff7ed', fg: '#c2410c' },
  face_spoof:  { label: 'Spoof Detected',   bg: '#fef2f2', fg: '#dc2626' },
  face_locked: { label: 'Account Locked',   bg: '#f0f9ff', fg: '#0369a1' },
};

export default function FaceAttendance() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [stats, setStats]       = useState({ successful_today: 0, failed_today: 0, spoof_attempts: 0, locked_accounts: 0 });
  const [enrollment, setEnrollment] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [activeTab, setActiveTab] = useState('settings');
  const [enrollingId, setEnrollingId]   = useState(null);
  const [deletingId, setDeletingId]     = useState(null);
  const [enrollFilter, setEnrollFilter] = useState('all');
  const [attemptFilters, setAttemptFilters] = useState({ from_date: '', to_date: '', action: '' });
  const [pendingHandleDeleteFaceData, setPendingHandleDeleteFaceData] = useState(null);

  // Initial load: settings + today stats in parallel
  useEffect(() => {
    Promise.allSettled([
      api.get('/attendance/face-settings'),
      api.get('/attendance/face-stats'),
    ]).then(([sRes, stRes]) => {
      if (sRes.status === 'fulfilled' && sRes.value?.data)
        setSettings({ ...DEFAULTS, ...sRes.value.data });
      if (stRes.status === 'fulfilled' && stRes.value?.data)
        setStats(stRes.value.data);
    }).finally(() => setLoading(false));
  }, []);

  const fetchEnrollment = useCallback(() => {
    const qs = enrollFilter !== 'all' ? `?status=${enrollFilter}` : '';
    api.get(`/attendance/face-enrollment${qs}`)
      .then(r => setEnrollment(r.data))
      .catch(() => {});
  }, [enrollFilter]);

  const fetchAttempts = useCallback(() => {
    const p = new URLSearchParams();
    if (attemptFilters.from_date) p.set('from_date', attemptFilters.from_date);
    if (attemptFilters.to_date)   p.set('to_date',   attemptFilters.to_date);
    if (attemptFilters.action)    p.set('action',     attemptFilters.action);
    api.get(`/attendance/face-attempts?${p}`)
      .then(r => setAttempts(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
  }, [attemptFilters]);

  // Tab-driven data loading
  useEffect(() => {
    if (activeTab === 'security') fetchEnrollment();
    if (activeTab === 'logs')     fetchAttempts();
  }, [activeTab, fetchEnrollment, fetchAttempts]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/attendance/face-settings', settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch { /* non-blocking */ } finally { setSaving(false); }
  };

  const handleEnroll = async (employeeId) => {
    setEnrollingId(employeeId);
    try {
      await api.post('/attendance/face-enroll', { employee_id: employeeId });
      fetchEnrollment();
    } catch { /* non-blocking */ } finally { setEnrollingId(null); }
  };

  const handleDeleteFaceData = async () => {
    if (!pendingHandleDeleteFaceData) return;
    const employeeId = pendingHandleDeleteFaceData;
    setPendingHandleDeleteFaceData(null);
    setDeletingId(employeeId);
    try {
      await api.delete(`/attendance/face-data/${employeeId}`);
      fetchEnrollment();
    } catch { /* non-blocking */ } finally { setDeletingId(null); }
  };

  const set = (k, v) => setSettings(s => ({ ...s, [k]: v }));

  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif', margin: '0 auto' }}>

      <ConfirmDialog
        open={!!pendingHandleDeleteFaceData}
        title="Delete Face Enrollment"
        message="Delete face enrollment record for this employee? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeleteFaceData}
        onCancel={() => setPendingHandleDeleteFaceData(null)}
      />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1f2937' }}>Face Attendance</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Biometric face recognition — configuration, enrollment &amp; security audit
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 12, color: '#9ca3af' }}>{today}</div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 14px', borderRadius: 10,
            background: settings.enabled ? '#f0fdf4' : '#f3f4f6',
            border: `1px solid ${settings.enabled ? '#86efac' : '#e5e7eb'}`,
          }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: settings.enabled ? '#10b981' : '#9ca3af' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: settings.enabled ? '#15803d' : '#6b7280' }}>
              {settings.enabled ? 'Face Attendance ON' : 'Face Attendance OFF'}
            </span>
          </div>
        </div>
      </div>

      {/* Hardware readiness banner */}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'flex-start',
        background: '#fffbeb', border: '1px solid #fde68a',
        borderRadius: 10, padding: '14px 16px', marginBottom: 20,
      }}>
        <Cpu size={18} color="#d97706" style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 3 }}>
            Hardware Integration Required
          </div>
          <div style={{ fontSize: 12, color: '#92400e', lineHeight: 1.6 }}>
            Face capture runs on registered biometric devices (ZKTeco, eSSL, Suprema, etc.).
            Devices POST punches to <code style={{ background: '#fef3c7', padding: '1px 5px', borderRadius: 4 }}>
              POST /api/v1/attendance/face-validate
            </code> after local matching.
            Register devices at <strong>Attendance → Devices</strong>.
            Thresholds and policies set here apply to every inbound punch.
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
        <StatCard label="Successful Today"  value={stats.successful_today} color="#10b981" icon={Check}
          sub="Face punches above confidence threshold" />
        <StatCard label="Failed Today"      value={stats.failed_today}     color="#f59e0b" icon={EyeOff}
          sub="Includes spoof attempts" />
        <StatCard label="Spoof Attempts"    value={stats.spoof_attempts}   color="#ef4444" icon={AlertTriangle}
          sub="Liveness check failures" />
        <StatCard label="Locked Accounts"  value={stats.locked_accounts}  color="#0369a1" icon={Lock}
          sub="Currently locked out" />
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 20,
        background: '#f5f3ff', padding: 4, borderRadius: 10, width: 'fit-content',
      }}>
        {[
          { id: 'settings', label: 'Settings',             icon: Sliders },
          { id: 'security', label: 'Security & Enrollment', icon: Shield },
          { id: 'logs',     label: 'Suspicious Attempts',  icon: Eye },
        ].map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', borderRadius: 7, border: 'none',
              background: activeTab === t.id ? '#fff' : 'transparent',
              color: activeTab === t.id ? P : '#6b7280',
              fontWeight: activeTab === t.id ? 600 : 400,
              fontSize: 13, cursor: 'pointer',
              boxShadow: activeTab === t.id ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
            }}>
            <t.icon size={14} />{t.label}
          </button>
        ))}
      </div>

      {/* ── SETTINGS TAB ─────────────────────────────────────────────────── */}
      {activeTab === 'settings' && (
        loading ? (
          <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
            <RefreshCw size={24} color="#d1d5db" style={{ marginBottom: 12 }} />
            <p style={{ margin: 0, fontSize: 13 }}>Loading face attendance settings…</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

            {/* Left: toggles + controls */}
            <div style={CARD}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700 }}>Feature Toggles</h3>

              {[
                { key: 'enabled',               label: 'Enable Face Attendance',      desc: 'Master toggle for face-based clock-in' },
                { key: 'selfie_required',        label: 'Selfie Validation',           desc: 'Require a live selfie for mobile punch' },
                { key: 'liveness_detection',     label: 'Liveness Detection',          desc: 'Reject photos, screens, and printed images' },
                { key: 'anti_spoof',             label: 'Anti-Spoof Detection',        desc: 'Block video replay and mask attacks' },
                { key: 'allow_glasses',          label: 'Allow Glasses',               desc: 'Accept punches with eyeglasses on' },
                { key: 'allow_mask',             label: 'Allow Mask',                  desc: 'Accept punches with face mask (post-COVID)' },
                { key: 'capture_photo_on_punch', label: 'Capture Photo on Punch',      desc: 'Save snapshot at each punch for audit trail' },
              ].map(row => (
                <div key={row.key} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '11px 0', borderBottom: '1px solid #f9f9f9',
                }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{row.label}</div>
                    <div style={{ fontSize: 12, color: '#9ca3af' }}>{row.desc}</div>
                  </div>
                  <Toggle checked={!!settings[row.key]} onChange={v => set(row.key, v)} />
                </div>
              ))}

              {/* Allowed devices */}
              <div style={{ padding: '12px 0', borderBottom: '1px solid #f9f9f9' }}>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>Allowed Devices</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['all', 'mobile_only', 'camera_only'].map(opt => (
                    <button key={opt} onClick={() => set('allowed_devices', opt)}
                      style={{
                        padding: '5px 12px', borderRadius: 8, fontSize: 12, fontWeight: 500,
                        cursor: 'pointer',
                        border: `1px solid ${settings.allowed_devices === opt ? P : '#e9e4ff'}`,
                        background: settings.allowed_devices === opt ? `${P}10` : '#fff',
                        color: settings.allowed_devices === opt ? P : '#6b7280',
                      }}>
                      {opt.replace(/_/g, ' ')}
                    </button>
                  ))}
                </div>
              </div>

              {/* Max attempts */}
              <div style={{ padding: '12px 0', borderBottom: '1px solid #f9f9f9' }}>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Max Failed Attempts</div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>Lock account after N consecutive failures</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[1, 2, 3, 5, 10].map(n => (
                    <button key={n} onClick={() => set('max_attempts', n)}
                      style={{
                        width: 36, height: 36, borderRadius: 8, fontSize: 13, fontWeight: 600,
                        cursor: 'pointer',
                        border: `1px solid ${settings.max_attempts === n ? P : '#e9e4ff'}`,
                        background: settings.max_attempts === n ? P : '#fff',
                        color: settings.max_attempts === n ? '#fff' : '#374151',
                      }}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Lock duration */}
              <div style={{ padding: '12px 0' }}>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Lock Duration (minutes)</div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>How long to lock after max failures reached</div>
                <input
                  type="number" min="1" max="1440"
                  value={settings.lock_duration_minutes ?? 15}
                  onChange={e => set('lock_duration_minutes', parseInt(e.target.value) || 15)}
                  style={{
                    border: '1px solid #e9e4ff', borderRadius: 8,
                    padding: '7px 10px', fontSize: 13, width: 100, outline: 'none',
                  }}
                />
              </div>
            </div>

            {/* Right: thresholds + save */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={CARD}>
                <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700 }}>Confidence Thresholds</h3>
                <p style={{ margin: '0 0 20px', fontSize: 12, color: '#9ca3af' }}>
                  Higher = stricter matching. Recommended: Confidence 85%, Anti-Spoof 70%
                </p>
                <ThresholdSlider
                  label="Face Confidence Threshold"
                  desc="Minimum match confidence to accept a punch"
                  value={settings.confidence_threshold}
                  onChange={v => set('confidence_threshold', v)}
                />
                <ThresholdSlider
                  label="Anti-Spoof Threshold"
                  desc="Minimum liveness score to pass spoof detection"
                  value={settings.anti_spoof_threshold}
                  onChange={v => set('anti_spoof_threshold', v)}
                />
                <div style={{
                  background: '#f5f3ff', border: '1px solid #e9e4ff',
                  borderRadius: 8, padding: 12, marginTop: 4,
                  fontSize: 12, color: '#4b5563', lineHeight: 1.7,
                }}>
                  <Info size={12} color={P} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                  <strong>Confidence &lt; {Math.round((settings.confidence_threshold ?? 0.85) * 100)}%</strong>
                  {' '}→ Punch rejected, employee must use alternate method<br />
                  <strong>Liveness &lt; {Math.round((settings.anti_spoof_threshold ?? 0.7) * 100)}%</strong>
                  {' '}→ Rejected &amp; logged as spoof attempt (subset of Failed)
                </div>
              </div>

              {/* Device API info card */}
              <div style={{ ...CARD, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <h4 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: '#374151' }}>
                  Device API Endpoint
                </h4>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                  Configure your biometric device to POST punches to:
                </div>
                <code style={{
                  display: 'block', background: '#1e293b', color: '#e2e8f0',
                  padding: '10px 14px', borderRadius: 8, fontSize: 11, lineHeight: 1.6,
                }}>
                  POST /api/v1/attendance/face-validate<br />
                  {'{'} device_id, employee_id, confidence,<br />
                  {'  '}liveness_score, timestamp {'}'}
                </code>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
                  Returns 200 on success, 403 on rejection, 423 if account locked
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={handleSave} disabled={saving}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 22px', borderRadius: 8, border: 'none',
                    background: saved ? '#10b981' : P, color: '#fff',
                    fontWeight: 600, fontSize: 14,
                    cursor: saving ? 'not-allowed' : 'pointer',
                    opacity: saving ? 0.7 : 1,
                    transition: 'background 0.2s',
                  }}>
                  {saved
                    ? <><Check size={14} /> Saved</>
                    : saving
                      ? <><RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> Saving…</>
                      : <><Save size={14} /> Save Settings</>}
                </button>
              </div>
            </div>
          </div>
        )
      )}

      {/* ── SECURITY & ENROLLMENT TAB ─────────────────────────────────────── */}
      {activeTab === 'security' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Enrollment stats row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
            {[
              { label: 'Enrolled Employees',   value: enrollment?.enrolled    ?? '—', color: '#10b981', icon: UserCheck },
              { label: 'Unenrolled Employees',  value: enrollment?.unenrolled  ?? '—', color: '#f59e0b', icon: UserX },
              {
                label: 'Enrollment Coverage',
                value: enrollment ? `${enrollment.enrollment_pct}%` : '—',
                color: (enrollment?.enrollment_pct ?? 0) >= 80 ? '#10b981' : '#f59e0b',
                icon: Shield,
              },
            ].map(k => (
              <StatCard key={k.label} label={k.label} value={k.value} color={k.color} icon={k.icon} />
            ))}
          </div>

          {/* Enrollment filter + refresh */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {['all', 'enrolled', 'unenrolled'].map(f => (
                <button key={f} onClick={() => { setEnrollFilter(f); }}
                  style={{
                    padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 500,
                    cursor: 'pointer',
                    border: `1px solid ${enrollFilter === f ? P : '#e5e7eb'}`,
                    background: enrollFilter === f ? `${P}10` : '#fff',
                    color: enrollFilter === f ? P : '#6b7280',
                  }}>
                  {f === 'all' ? 'All Employees' : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            <button onClick={fetchEnrollment}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 14px', borderRadius: 8, border: '1px solid #e5e7eb',
                background: '#fff', color: '#374151', fontSize: 12, cursor: 'pointer',
              }}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>

          {/* Employee enrollment table */}
          <div style={CARD}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Employee Enrollment Status</h3>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>
                {enrollment ? `${enrollment.employees.length} employees shown` : 'Loading…'}
              </div>
            </div>

            {!enrollment ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
                <RefreshCw size={24} color="#d1d5db" style={{ marginBottom: 10 }} />
                <p style={{ margin: 0, fontSize: 13 }}>Loading enrollment data…</p>
              </div>
            ) : enrollment.employees.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
                <UserX size={36} color="#d1d5db" style={{ marginBottom: 10 }} />
                <p style={{ margin: 0, fontSize: 13 }}>No employees found</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #f0f0f4' }}>
                      {['Employee', 'Department', 'Designation', 'Status', 'Enrolled On', 'Enrolled By', 'Actions'].map(h => (
                        <th key={h} style={{
                          padding: '8px 10px', textAlign: 'left',
                          fontWeight: 600, color: '#6b7280',
                          fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {enrollment.employees.map(emp => {
                      const isEnrolled = emp.enrollment_status === 'enrolled';
                      return (
                        <tr key={emp.employee_id} style={{ borderBottom: '1px solid #f9f9f9' }}
                          onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                          onMouseLeave={e => e.currentTarget.style.background = ''}>
                          <td style={{ padding: '10px' }}>
                            <div style={{ fontWeight: 600, color: '#1f2937' }}>{emp.employee_name}</div>
                            {emp.email && <div style={{ fontSize: 11, color: '#9ca3af' }}>{emp.email}</div>}
                          </td>
                          <td style={{ padding: '10px', color: '#374151' }}>{emp.department || '—'}</td>
                          <td style={{ padding: '10px', color: '#374151' }}>{emp.designation || '—'}</td>
                          <td style={{ padding: '10px' }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5,
                              padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                              background: isEnrolled ? '#f0fdf4' : '#f9fafb',
                              color: isEnrolled ? '#15803d' : '#6b7280',
                              border: `1px solid ${isEnrolled ? '#86efac' : '#e5e7eb'}`,
                            }}>
                              {isEnrolled ? <Check size={10} /> : <UserX size={10} />}
                              {isEnrolled ? 'Enrolled' : 'Unenrolled'}
                            </span>
                          </td>
                          <td style={{ padding: '10px', color: '#374151', fontSize: 12 }}>
                            {emp.enrolled_at
                              ? new Date(emp.enrolled_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                              : '—'}
                          </td>
                          <td style={{ padding: '10px', color: '#374151', fontSize: 12 }}>
                            {emp.enrolled_by_name || '—'}
                          </td>
                          <td style={{ padding: '10px' }}>
                            <div style={{ display: 'flex', gap: 6 }}>
                              {!isEnrolled ? (
                                <button
                                  onClick={() => handleEnroll(emp.employee_id)}
                                  disabled={enrollingId === emp.employee_id}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 5,
                                    padding: '5px 10px', borderRadius: 7, border: `1px solid ${P}`,
                                    background: `${P}10`, color: P,
                                    fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                    opacity: enrollingId === emp.employee_id ? 0.6 : 1,
                                  }}>
                                  <UserCheck size={11} />
                                  {enrollingId === emp.employee_id ? 'Enrolling…' : 'Mark Enrolled'}
                                </button>
                              ) : (
                                <button
                                  onClick={() => setPendingHandleDeleteFaceData(emp.employee_id)}
                                  disabled={deletingId === emp.employee_id}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 5,
                                    padding: '5px 10px', borderRadius: 7,
                                    border: '1px solid #fca5a5',
                                    background: '#fef2f2', color: '#dc2626',
                                    fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                    opacity: deletingId === emp.employee_id ? 0.6 : 1,
                                  }}>
                                  <Trash2 size={11} />
                                  {deletingId === emp.employee_id ? 'Removing…' : 'Remove'}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Security policy status grid */}
          <div style={CARD}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700 }}>Active Security Policies</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              {[
                { title: 'Liveness Detection',      active: settings.liveness_detection,     color: '#10b981', desc: 'Rejects photos, screens, and printed images' },
                { title: 'Anti-Spoof Detection',     active: settings.anti_spoof,             color: '#10b981', desc: 'Blocks video replay and mask attacks' },
                { title: 'Selfie Audit Trail',       active: settings.selfie_required,        color: '#0369a1', desc: 'Stores selfie at each mobile punch' },
                { title: 'Capture Photo on Punch',   active: settings.capture_photo_on_punch, color: '#0369a1', desc: 'Saves snapshot for dispute resolution' },
                { title: 'Allow Glasses',            active: settings.allow_glasses,          color: '#10b981', desc: 'Accepts punches with eyeglasses' },
                { title: 'Allow Mask',               active: settings.allow_mask,             color: '#f59e0b', desc: 'Accepts punches with face mask' },
                { title: 'Account Lockout',          active: settings.max_attempts > 0,       color: '#10b981', desc: `After ${settings.max_attempts} failures → ${settings.lock_duration_minutes}min lock` },
                { title: 'Duplicate Punch Block',    active: true,                            color: '#10b981', desc: 'Prevents identical punch within 2 minutes' },
                { title: 'Company-Scoped Isolation', active: true,                            color: '#10b981', desc: 'All data isolated per company' },
              ].map(item => (
                <div key={item.title} style={{
                  display: 'flex', gap: 10, padding: 12, borderRadius: 10,
                  border: '1px solid #f0f0f4', background: '#fafafa',
                }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: item.active ? item.color : '#d1d5db',
                    flexShrink: 0, marginTop: 5,
                  }} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#1f2937' }}>{item.title}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{item.desc}</div>
                    <div style={{
                      fontSize: 11, fontWeight: 600, marginTop: 4,
                      color: item.active ? item.color : '#9ca3af',
                    }}>
                      {item.active ? '✓ Active' : '○ Inactive'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── SUSPICIOUS ATTEMPTS TAB ───────────────────────────────────────── */}
      {activeTab === 'logs' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Filter bar */}
          <div style={{
            ...CARD, padding: 16,
            display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap',
          }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>FROM DATE</div>
              <input
                type="date"
                value={attemptFilters.from_date}
                onChange={e => setAttemptFilters(f => ({ ...f, from_date: e.target.value }))}
                style={{
                  border: '1px solid #e5e7eb', borderRadius: 8,
                  padding: '7px 10px', fontSize: 13, outline: 'none',
                }}
              />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>TO DATE</div>
              <input
                type="date"
                value={attemptFilters.to_date}
                onChange={e => setAttemptFilters(f => ({ ...f, to_date: e.target.value }))}
                style={{
                  border: '1px solid #e5e7eb', borderRadius: 8,
                  padding: '7px 10px', fontSize: 13, outline: 'none',
                }}
              />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>TYPE</div>
              <div style={{ position: 'relative' }}>
                <select
                  value={attemptFilters.action}
                  onChange={e => setAttemptFilters(f => ({ ...f, action: e.target.value }))}
                  style={{
                    border: '1px solid #e5e7eb', borderRadius: 8,
                    padding: '7px 32px 7px 10px', fontSize: 13, outline: 'none',
                    appearance: 'none', background: '#fff', cursor: 'pointer',
                  }}>
                  <option value="">All Types</option>
                  <option value="face_failed">Low Confidence</option>
                  <option value="face_spoof">Spoof Detected</option>
                  <option value="face_locked">Account Locked</option>
                </select>
                <ChevronDown size={13} style={{ position: 'absolute', right: 10, top: 10, pointerEvents: 'none', color: '#9ca3af' }} />
              </div>
            </div>
            <button onClick={fetchAttempts}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 16px', borderRadius: 8, border: 'none',
                background: P, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>
              <Filter size={13} /> Apply Filter
            </button>
            {(attemptFilters.from_date || attemptFilters.to_date || attemptFilters.action) && (
              <button
                onClick={() => { setAttemptFilters({ from_date: '', to_date: '', action: '' }); }}
                style={{
                  padding: '8px 14px', borderRadius: 8,
                  border: '1px solid #e5e7eb', background: '#fff',
                  color: '#6b7280', fontSize: 13, cursor: 'pointer',
                }}>
                Clear
              </button>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                background: '#fef2f2', color: '#dc2626',
                borderRadius: 12, padding: '3px 10px', fontSize: 12, fontWeight: 600,
              }}>
                {attempts.length} records
              </span>
            </div>
          </div>

          {/* Attempts table */}
          <div style={CARD}>
            {attempts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
                <Shield size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
                <p style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>No suspicious attempts found</p>
                <p style={{ margin: '4px 0 0', fontSize: 12 }}>Adjust the date range or type filter above</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #f0f0f4' }}>
                      {['Time', 'Employee', 'Department', 'Type', 'Confidence', 'Liveness', 'Device', 'IP Address', 'Reason'].map(h => (
                        <th key={h} style={{
                          padding: '8px 10px', textAlign: 'left',
                          fontWeight: 600, color: '#6b7280',
                          fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em',
                          whiteSpace: 'nowrap',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map(log => {
                      const style = ACTION_LABELS[log.action] || { label: log.action, bg: '#f9fafb', fg: '#374151' };
                      const ad = log.after_data || {};
                      const conf    = ad.confidence    !== undefined ? `${Math.round(ad.confidence    * 100)}%` : '—';
                      const live    = ad.liveness_score !== undefined ? `${Math.round(ad.liveness_score * 100)}%` : '—';
                      const deviceId = ad.device_id || '—';
                      const reason  = ad.reason || '—';
                      return (
                        <tr key={log.id}
                          style={{ borderBottom: '1px solid #f9f9f9', background: log.action === 'face_spoof' ? '#fff9f9' : '' }}
                          onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                          onMouseLeave={e => e.currentTarget.style.background = log.action === 'face_spoof' ? '#fff9f9' : ''}>
                          <td style={{ padding: '10px', whiteSpace: 'nowrap', color: '#374151' }}>
                            {new Date(log.performed_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td style={{ padding: '10px', fontWeight: 600, color: '#1f2937' }}>
                            {log.employee_name || `Employee #${log.employee_id}`}
                          </td>
                          <td style={{ padding: '10px', color: '#374151' }}>{log.department || '—'}</td>
                          <td style={{ padding: '10px' }}>
                            <span style={{
                              background: style.bg, color: style.fg,
                              borderRadius: 10, padding: '3px 9px',
                              fontSize: 11, fontWeight: 600,
                            }}>
                              {style.label}
                            </span>
                          </td>
                          <td style={{ padding: '10px', fontWeight: 600, color: conf === '—' ? '#9ca3af' : '#ef4444' }}>
                            {conf}
                          </td>
                          <td style={{ padding: '10px', fontWeight: 600, color: live === '—' ? '#9ca3af' : '#f59e0b' }}>
                            {live}
                          </td>
                          <td style={{ padding: '10px', color: '#6b7280', fontSize: 12 }}>{deviceId}</td>
                          <td style={{ padding: '10px', color: '#6b7280', fontSize: 12 }}>{log.ip_address || '—'}</td>
                          <td style={{ padding: '10px', color: '#6b7280', fontSize: 12 }}>
                            {reason.replace(/_/g, ' ')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
