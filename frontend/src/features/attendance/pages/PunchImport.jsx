// Attendance → Punch Import. MODULE_FEATURE_CONNECTION_MANUAL.md §272.
//
// Device sync, manual CSV import and the Recent Punch Log over
// hr/biometric.routes.js (/biometric/devices, /devices/:id/sync, /logs,
// /logs/import), with today's attendance cards from /biometric/dashboard.
// It was the first tab of HR → Gate Pass & Visitors (BiometricAccess); the owner
// moved it here on 2026-11-12 so that page is about the gate only.
// Device setup itself is Attendance → Configuration → Settings → Devices.
import { useState, useEffect, useCallback } from 'react';
import { Fingerprint } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import PunchImportPanel from '../components/PunchImportPanel';
import { errText, fmtDay } from '@/features/hr/components/biometric/biometricShared';

export default function PunchImport() {
  const { hasPermission } = useAuth();
  const [dashStats, setDashStats] = useState(null);
  const [dashError, setDashError] = useState('');
  const [employees, setEmployees] = useState([]);
  const [msg, setMsg] = useState({ text: '', type: '' });

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
  const d = dashStats;
  const nonWorking = d?.non_working_day;
  const cards = [
    { label: 'Punched In', value: d?.punched_in_today, color: '#16a34a', hint: d ? `of ${d.expected} expected` : null },
    { label: 'Not Punched', value: nonWorking ? '—' : d?.not_yet_punched, color: '#6d28d9', hint: nonWorking || (d?.on_leave ? `${d.on_leave} on approved leave` : null) },
    { label: 'Late Arrivals', value: d?.late_arrivals, color: '#dc2626', hint: d ? `after ${d.rules.work_start.slice(0, 5)}${d.rules.grace_minutes ? ` + ${d.rules.grace_minutes} min` : ''}` : null },
    { label: 'Early Exits', value: d?.early_departures, color: '#7c5cf0', hint: d ? `last punch out before ${d.rules.work_end.slice(0, 5)}` : null },
  ];

  return (
    <PageShell dock={
      <PageHero icon={Fingerprint} eyebrow="Attendance" title="Punch Import"
        subtitle="Sync biometric devices, import punches from CSV, and review the punch log" />
    }>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10, marginBottom: 8 }} data-testid="bio-cards">
        {cards.map((s) => (
          <div key={s.label} style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value ?? '—'}</div>
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
      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 8, padding: 20, minWidth: 0 }}>
        <PunchImportPanel dashStats={d} employees={employees} flash={flash} onDataChanged={loadDashboard} canImport={canImport} />
      </div>
    </PageShell>
  );
}
