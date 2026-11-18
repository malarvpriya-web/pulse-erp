// Attendance → Punch Machines (§272, §278).
//
// Everyone except field staff punches on a machine (owner, 2026-11-18). This
// is the ONE place machines are handled:
//   · Machines    add / edit / test / Sync now / remove / punch log
//                 (DeviceManagement, embedded — it used to be a separate
//                 Settings → Devices tab with a second device list here)
//   · Automatic sync  on/off and interval; jobs/deviceSync.cron.js syncs every
//                 machine that has an IP address on that schedule
//   · CSV import and the Recent Punch Log (PunchImportPanel)
// Today's cards come from /biometric/dashboard.
import { useState, useEffect, useCallback } from 'react';
import { Fingerprint, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import PunchImportPanel from '../components/PunchImportPanel';
import DeviceManagement from '../components/DeviceManagement';
import { errText, fmtDay } from '@/features/hr/components/biometric/biometricShared';

const BOX = { background: '#fff', border: '1px solid #e9e4ff', borderRadius: 8, padding: 20, minWidth: 0, marginBottom: 16 };

function AutoSyncCard({ canEdit, flash }) {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get('/attendance/device-settings').then((r) => setCfg(r.data)).catch(() => setCfg({ auto_sync: true, sync_interval_minutes: 15 }));
  }, []);
  if (!cfg) return null;
  const save = async (next) => {
    setSaving(true);
    try {
      const { data } = await api.put('/attendance/device-settings', next);
      setCfg(data);
      flash(data.auto_sync ? `Automatic sync on — every ${data.sync_interval_minutes} minutes` : 'Automatic sync off — use Sync now on each machine');
    } catch (e) { flash(errText(e, 'Could not save'), 'error'); }
    finally { setSaving(false); }
  };
  return (
    <div style={{ ...BOX, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }} data-testid="auto-sync">
      <RefreshCw size={18} color="#6B3FDB" />
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#1f2937' }}>Automatic sync</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          Pulls punches from every machine that has an IP address. A machine without an address is skipped until you enter it.
        </div>
      </div>
      <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <input type="checkbox" checked={!!cfg.auto_sync} disabled={!canEdit || saving}
          onChange={(e) => save({ ...cfg, auto_sync: e.target.checked })} /> {cfg.auto_sync ? 'On' : 'Off'}
      </label>
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: '#374151' }}>
        every
        <select value={cfg.sync_interval_minutes} disabled={!canEdit || saving || !cfg.auto_sync}
          onChange={(e) => save({ ...cfg, sync_interval_minutes: Number(e.target.value) })}
          style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }}>
          {[5, 10, 15, 30, 60, 120].map((m) => <option key={m} value={m}>{m} min</option>)}
        </select>
      </label>
    </div>
  );
}

export default function PunchImport() {
  const { hasPermission } = useAuth();
  const [dashStats, setDashStats] = useState(null);
  const [dashError, setDashError] = useState('');
  const [employees, setEmployees] = useState([]);
  const [msg, setMsg] = useState({ text: '', type: '' });
  const [panelKey, setPanelKey] = useState(0);

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
      <PageHero icon={Fingerprint} eyebrow="Attendance" title="Punch Machines"
        subtitle="Office staff punch on the machine — add machines, sync them (automatically or now), import a CSV, see every punch" />
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
        {d ? `Today, ${fmtDay(d.date)} · machine and CSV punches · current employees only` : dashError}
      </div>
      {msg.text && (
        <div role={msg.type === 'error' ? 'alert' : 'status'} style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14, background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a', border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{msg.text}</div>
      )}

      <h3 style={{ fontSize: 15, color: '#4c1d95', margin: '8px 0 10px' }}>Machines</h3>
      <div style={BOX}>
        <DeviceManagement embedded onChanged={() => { loadDashboard(); setPanelKey((k) => k + 1); }} />
      </div>
      <AutoSyncCard canEdit={canImport} flash={flash} />

      <h3 style={{ fontSize: 15, color: '#4c1d95', margin: '8px 0 10px' }}>CSV import & punch log</h3>
      <div style={BOX}>
        <PunchImportPanel key={panelKey} dashStats={d} employees={employees} flash={flash}
          onDataChanged={loadDashboard} canImport={canImport} showDevices={false} />
      </div>
    </PageShell>
  );
}
