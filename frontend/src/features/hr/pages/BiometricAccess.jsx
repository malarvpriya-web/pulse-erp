// frontend/src/features/hr/pages/BiometricAccess.jsx
//
// HR → Biometric & Access Control. Three tabs over hr/biometric.routes.js —
// connections in MODULE_FEATURE_CONNECTION_MANUAL.md §197:
//   Attendance Import  /biometric/devices, /devices/:id/sync, /logs, /logs/import
//   Gate Passes        /gate-passes (+ /:id/approve | cancel | complete)
//   Visitors           /visitors (+ /:id/checkout | badge)
// and the stat cards over /biometric/dashboard.
//
// ⚠ What the previous version did that this one must not:
//   · loaded each list with `if (res.data?.length) setX(res.data)`, so an empty
//     answer never cleared the table — a filter could never show "none";
//   · reported "Device synced successfully" for any 2xx and "Sync failed" with
//     no reason for anything else (the server's reason was in `error`, which it
//     never read);
//   · printed the whole page for one gate pass, and "printed" a visitor badge
//     with a flash reading "(demo)".
import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import AttendanceImportTab from '../components/biometric/AttendanceImportTab';
import GatePassesTab from '../components/biometric/GatePassesTab';
import VisitorsTab from '../components/biometric/VisitorsTab';
import { errText, fmtDay } from '../components/biometric/biometricShared';

function tabStyle(active) {
  return { padding: '8px 20px', border: 'none', cursor: 'pointer', borderRadius: '6px 6px 0 0', fontWeight: 600, fontSize: 14, background: active ? '#6B3FDB' : '#e9e4ff', color: active ? '#fff' : '#6B3FDB' };
}

export default function BiometricAccess() {
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState('attendance');
  const [dashStats, setDashStats] = useState(null);
  const [dashError, setDashError] = useState('');
  const [employees, setEmployees] = useState([]);
  const [msg, setMsg] = useState({ text: '', type: '' });

  // Stable, so the tabs' loaders (which depend on it) do not re-run per render.
  const flash = useCallback((text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg((m) => (m.text === text ? { text: '', type: '' } : m)), 5000);
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const res = await api.get('/biometric/dashboard');
      setDashStats(res.data); setDashError('');
    } catch (err) { setDashStats(null); setDashError(errText(err, 'Could not load today’s figures')); }
  }, []);

  useEffect(() => {
    loadDashboard();
    api.get('/biometric/employees/options')
      .then((res) => setEmployees(Array.isArray(res.data) ? res.data : []))
      .catch(() => setEmployees([]));
  }, [loadDashboard]);

  const canImport = hasPermission('attendance', 'edit');
  const canWriteHr = hasPermission('hr', 'add') || hasPermission('hr', 'edit');
  const d = dashStats;
  const nonWorking = d?.non_working_day;

  const cards = [
    { label: 'Punched In', value: d?.punched_in_today, color: '#16a34a', icon: '✅', hint: d ? `of ${d.expected} expected` : null },
    { label: 'Not Punched', value: nonWorking ? '—' : d?.not_yet_punched, color: '#6d28d9', icon: '⏳', hint: nonWorking || (d?.on_leave ? `${d.on_leave} on approved leave` : null) },
    { label: 'Late Arrivals', value: d?.late_arrivals, color: '#dc2626', icon: '🕐', hint: d ? `after ${d.rules.work_start.slice(0, 5)}${d.rules.grace_minutes ? ` + ${d.rules.grace_minutes} min` : ''}` : null },
    { label: 'Early Exits', value: d?.early_departures, color: '#7c5cf0', icon: '🏃', hint: d ? `last punch out before ${d.rules.work_end.slice(0, 5)}` : null },
    { label: 'Visitors Inside', value: d?.visitors_inside, color: '#6B3FDB', icon: '🪪', hint: d?.visitors_overdue ? `${d.visitors_overdue} since an earlier day` : null },
  ];

  return (
    <PageShell dock={
      <PageHero
        icon={ShieldCheck}
        eyebrow="Human Resources"
        title="🔒 Biometric & Access Control"
        subtitle="Attendance import, gate passes, visitor management and device monitoring"
      />
    }>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10, marginBottom: 8 }} data-testid="bio-cards">
        {cards.map((s) => (
          <div key={s.label} style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 18 }}>{s.icon}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color, marginTop: 4 }}>{s.value ?? '—'}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{s.label}</div>
            {s.hint && <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{s.hint}</div>}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 16 }}>
        {d ? `Today, ${fmtDay(d.date)} · device and CSV punches · current employees only` : dashError}
      </div>

      {msg.text && (
        <div role={msg.type === 'error' ? 'alert' : 'status'} style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14, background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a', border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{msg.text}</div>
      )}

      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e9e4ff', flexWrap: 'wrap' }} role="tablist">
        {[['attendance', 'Attendance Import'], ['passes', 'Gate Passes'], ['visitors', 'Visitor Management']].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} style={tabStyle(tab === k)} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 8px 8px 8px', padding: 20, minWidth: 0 }}>
        {tab === 'attendance' && (
          <AttendanceImportTab dashStats={d} employees={employees} flash={flash} onDataChanged={loadDashboard} canImport={canImport} />
        )}
        {tab === 'passes' && <GatePassesTab employees={employees} flash={flash} canWrite={canWriteHr} onDataChanged={loadDashboard} />}
        {tab === 'visitors' && <VisitorsTab employees={employees} flash={flash} canWrite={canWriteHr} onDataChanged={loadDashboard} />}
      </div>
    </PageShell>
  );
}
