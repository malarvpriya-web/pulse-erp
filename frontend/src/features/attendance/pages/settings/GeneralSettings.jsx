import React, { useState, useEffect, useCallback } from 'react';
import {
  Settings, Clock, MapPin, Camera, Cpu, Shield, GitBranch,
  IndianRupee, Layers, FileText, ChevronRight, Check, Save,
  Globe, ToggleLeft, ToggleRight, Users, AlertCircle, RefreshCw,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };

const SECTIONS = [
  { id: 'general',   label: 'General Settings',     icon: Settings,   color: '#6B3FDB' },
  { id: 'shift',     label: 'Shift Settings',        icon: Clock,      color: '#0369a1' },
  { id: 'geo',       label: 'Geo Settings',          icon: MapPin,     color: '#10b981' },
  { id: 'face',      label: 'Face Attendance',       icon: Camera,     color: '#f59e0b' },
  { id: 'device',    label: 'Device Settings',       icon: Cpu,        color: '#ef4444' },
  { id: 'policy',    label: 'Policy Settings',       icon: Shield,     color: '#8b5cf6' },
  { id: 'approval',  label: 'Approval Matrix',       icon: GitBranch,  color: '#06b6d4' },
  { id: 'payroll',   label: 'Payroll Sync Settings', icon: IndianRupee, color: '#f97316' },
  { id: 'workcentre',label: 'Work Centre Settings',  icon: Layers,     color: '#84cc16' },
  { id: 'reports',   label: 'Reports & Export',      icon: FileText,   color: '#a78bfa' },
];

const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const TIMEZONES = ['Asia/Kolkata','Asia/Dubai','Asia/Singapore','UTC','Europe/London','America/New_York'];
const ATTENDANCE_MODES = [
  { value: 'manual',    label: 'Manual',    desc: 'HR manually marks attendance' },
  { value: 'biometric', label: 'Biometric', desc: 'Fingerprint / face device auto-sync' },
  { value: 'mobile',    label: 'Mobile App',desc: 'Employee self-service mobile punch' },
  { value: 'hybrid',    label: 'Hybrid',    desc: 'Mix of manual + biometric' },
];

const WORKFLOW_TYPES = [
  { id: 'regularization',  label: 'Regularization Approval',   desc: 'Attendance correction requests' },
  { id: 'overtime',        label: 'Overtime Approval',         desc: 'OT record approvals' },
  { id: 'attendance_lock', label: 'Attendance Lock / Freeze',  desc: 'Month-end payroll freeze' },
];

function Toggle({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)}
      style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>
      {checked
        ? <ToggleRight size={28} color={P} />
        : <ToggleLeft  size={28} color="#d1d5db" />}
    </button>
  );
}

function SectionCard({ icon: Icon, color, label, children }) {
  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, paddingBottom: 14, borderBottom: '1px solid #f0f0f4' }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: `${color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={18} color={color} />
        </div>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1f2937' }}>{label}</h2>
      </div>
      {children}
    </div>
  );
}

function Row({ label, desc, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #f9f9f9' }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: '#1f2937' }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{desc}</div>}
      </div>
      <div style={{ flexShrink: 0, marginLeft: 16 }}>{children}</div>
    </div>
  );
}

export default function GeneralSettings() {
  const toast = useToast();
  const [activeSection, setActiveSection] = useState('general');
  const [general, setGeneral] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [geoSettings, setGeoSettings] = useState({ geo_mandatory: false, default_radius: 200, block_outside: true });
  const [deviceSettings, setDeviceSettings] = useState({ auto_sync: true, sync_interval_minutes: 15, duplicate_window_minutes: 5, offline_sync: true });
  const [reportSettings, setReportSettings] = useState({ auto_monthly_report: true, report_email: '', export_format: 'xlsx', include_photos: false });
  const [wc, setWc] = useState({ track_work_centres: false, require_wc_for_factory: true, units_produced_tracking: false, include_in_reports: true });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    Promise.allSettled([
      api.get('/attendance/general-settings'),
      api.get('/attendance/workflow-config'),
      api.get('/attendance/geo-settings'),
      api.get('/attendance/device-settings'),
      api.get('/attendance/report-settings'),
      api.get('/attendance/workcentre-settings'),
    ]).then(([gRes, wRes, geoRes, devRes, repRes, wcRes]) => {
      if (gRes.status === 'fulfilled' && gRes.value.data) setGeneral(gRes.value.data);
      if (wRes.status === 'fulfilled' && Array.isArray(wRes.value.data)) setWorkflows(wRes.value.data);
      if (geoRes.status === 'fulfilled' && geoRes.value.data) setGeoSettings(g => ({ ...g, ...geoRes.value.data }));
      if (devRes.status === 'fulfilled' && devRes.value.data) setDeviceSettings(d => ({ ...d, ...devRes.value.data }));
      if (repRes.status === 'fulfilled' && repRes.value.data) setReportSettings(r => ({ ...r, ...repRes.value.data }));
      if (wcRes.status === 'fulfilled' && wcRes.value.data) setWc(w => ({ ...w, ...wcRes.value.data }));
    }).finally(() => setSettingsLoading(false));
  }, []);

  const saveGeneral = async () => {
    setSaving(true);
    try {
      await api.put('/attendance/general-settings', general);
      setSaved('general');
      toast.success('General settings saved');
      setTimeout(() => setSaved(''), 3000);
    } catch (e) { toast.error(e?.response?.data?.error || 'Failed to save general settings'); } finally { setSaving(false); }
  };

  const saveGeo = async () => {
    setSaving(true);
    try {
      await api.put('/attendance/geo-settings', geoSettings);
      setSaved('geo');
      toast.success('Geo settings saved');
      setTimeout(() => setSaved(''), 3000);
    } catch (e) { toast.error(e?.response?.data?.error || 'Failed to save geo settings'); } finally { setSaving(false); }
  };

  const saveDevice = async () => {
    setSaving(true);
    try {
      await api.put('/attendance/device-settings', deviceSettings);
      setSaved('device');
      toast.success('Device settings saved');
      setTimeout(() => setSaved(''), 3000);
    } catch (e) { toast.error(e?.response?.data?.error || 'Failed to save device settings'); } finally { setSaving(false); }
  };

  const saveReport = async () => {
    setSaving(true);
    try {
      await api.put('/attendance/report-settings', reportSettings);
      setSaved('report');
      toast.success('Report settings saved');
      setTimeout(() => setSaved(''), 3000);
    } catch (e) { toast.error(e?.response?.data?.error || 'Failed to save report settings'); } finally { setSaving(false); }
  };

  const saveWc = async () => {
    setSaving(true);
    try {
      await api.put('/attendance/workcentre-settings', wc);
      setSaved('workcentre');
      toast.success('Work centre settings saved');
      setTimeout(() => setSaved(''), 3000);
    } catch (e) { toast.error(e?.response?.data?.error || 'Failed to save work centre settings'); } finally { setSaving(false); }
  };

  const toggleWorkingDay = (day) => {
    setGeneral(g => ({
      ...g,
      working_days: g.working_days.includes(day)
        ? g.working_days.filter(d => d !== day)
        : [...g.working_days, day],
    }));
  };

  const saveWorkflow = async (type, levels) => {
    try {
      await api.put(`/attendance/workflow-config/${type}`, { levels });
      setWorkflows(prev => prev.map(w => w.workflow_type === type ? { ...w, levels } : w));
      toast.success('Workflow config saved');
      setSaved(type); setTimeout(() => setSaved(''), 3000);
    } catch (e) { toast.error(e?.response?.data?.error || 'Failed to save workflow config'); }
  };

  const inp = { border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none' };

  const renderSection = () => {
    switch (activeSection) {
      case 'general': return (
        <SectionCard icon={Settings} color="#6B3FDB" label="General Settings">
          {settingsLoading ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
              <RefreshCw size={20} style={{ marginBottom: 8 }} />
              <p style={{ margin: 0, fontSize: 13 }}>Loading settings…</p>
            </div>
          ) : !general ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
              <AlertCircle size={20} color="#d1d5db" style={{ marginBottom: 8 }} />
              <p style={{ margin: 0, fontSize: 13 }}>Could not load settings. Refresh the page.</p>
            </div>
          ) : (<>
          <Row label="Working Days" desc="Days considered as working days for attendance">
            <div style={{ display: 'flex', gap: 5 }}>
              {DAYS.map(d => (
                <button key={d} onClick={() => toggleWorkingDay(d)}
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid', fontSize: 11, fontWeight: 500, cursor: 'pointer',
                    background: (general.working_days || []).includes(d) ? P : '#f5f3ff',
                    borderColor: (general.working_days || []).includes(d) ? P : '#e9e4ff',
                    color: (general.working_days || []).includes(d) ? '#fff' : '#4b5563' }}>
                  {d.slice(0,3).toUpperCase()}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Timezone" desc="Default timezone for attendance calculations">
            <select value={general.timezone || 'Asia/Kolkata'} onChange={e => setGeneral(g => ({ ...g, timezone: e.target.value }))}
              style={{ ...inp, minWidth: 180 }}>
              {TIMEZONES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Row>
          <Row label="Attendance Mode" desc="How attendance is recorded">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ATTENDANCE_MODES.map(m => (
                <label key={m.value} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="radio" name="att_mode" value={m.value}
                    checked={general.attendance_mode === m.value}
                    onChange={() => setGeneral(g => ({ ...g, attendance_mode: m.value }))}
                    style={{ accentColor: P }} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{m.label}</span>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>{m.desc}</span>
                </label>
              ))}
            </div>
          </Row>
          <Row label="Auto Check-Out" desc="Automatically check out employees at end of day">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle checked={!!general.auto_checkout} onChange={v => setGeneral(g => ({ ...g, auto_checkout: v }))} />
              {general.auto_checkout && (
                <input type="time" value={general.auto_checkout_time || '21:00'}
                  onChange={e => setGeneral(g => ({ ...g, auto_checkout_time: e.target.value }))}
                  style={inp} />
              )}
            </div>
          </Row>
          <Row label="Half Day Hours" desc="Minimum hours for a half-day record">
            <input type="number" step="0.5" min="1" max="9" value={general.half_day_hours || 4.5}
              onChange={e => setGeneral(g => ({ ...g, half_day_hours: parseFloat(e.target.value) }))}
              style={{ ...inp, width: 80 }} />
          </Row>
          <Row label="Full Day Hours" desc="Minimum hours for a full-day record">
            <input type="number" step="0.5" min="4" max="12" value={general.full_day_hours || 9}
              onChange={e => setGeneral(g => ({ ...g, full_day_hours: parseFloat(e.target.value) }))}
              style={{ ...inp, width: 80 }} />
          </Row>
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={saveGeneral} disabled={saving}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
              {saved === 'general' ? <><Check size={14} /> Saved</> : <><Save size={14} /> Save Changes</>}
            </button>
          </div>
          </>)}
        </SectionCard>
      );

      case 'shift': return (
        <SectionCard icon={Clock} color="#0369a1" label="Shift Settings">
          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13, color: '#0369a1' }}>
            Shift configuration is managed in the <strong>Shift Management</strong> module. Use the settings here to configure global shift behaviour.
          </div>
          <Row label="Shift Overlap Prevention" desc="Block assigning an employee to overlapping shifts">
            <Toggle checked={true} onChange={() => {}} />
          </Row>
          <Row label="Grace Period (default, minutes)" desc="Minutes late before marking Late (used when shift has no override)">
            <input type="number" min="0" max="60"
              value={general?.default_grace_minutes ?? 10}
              onChange={e => setGeneral(g => ({ ...g, default_grace_minutes: parseInt(e.target.value) }))}
              style={{ ...inp, width: 80 }} />
          </Row>
          <Row label="OT Multiplier" desc="Default overtime pay multiplier (e.g. 1.5 = time-and-a-half)">
            <input type="number" min="1" max="3" step="0.25"
              value={general?.ot_multiplier ?? 1.5}
              onChange={e => setGeneral(g => ({ ...g, ot_multiplier: parseFloat(e.target.value) }))}
              style={{ ...inp, width: 80 }} />
          </Row>
          <Row label="Night Shift Allowance" desc="Auto-apply night shift multiplier (from OT policy)">
            <Toggle checked={true} onChange={() => {}} />
          </Row>
          <Row label="Shift Rotation" desc="Enable shift rotation schedules">
            <Toggle checked={false} onChange={() => {}} />
          </Row>
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={saveGeneral} disabled={saving}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderRadius: 8, border: 'none', background: '#0369a1', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
              {saved === 'general' ? <><Check size={14} /> Saved</> : <><Save size={14} /> Save Shift Settings</>}
            </button>
          </div>
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>Quick Actions</div>
            {[
              { label: 'Manage Shifts', desc: 'Create, edit, delete, assign shifts' },
              { label: 'View Shift Calendar', desc: 'Monthly shift calendar for employees' },
              { label: 'Shift Efficiency Report', desc: 'Shift fill rate and hours analytics' },
            ].map(l => (
              <div key={l.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderRadius: 8, border: '1px solid #f0f0f4', marginBottom: 8, background: '#f9fafb' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{l.label}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{l.desc}</div>
                </div>
                <ChevronRight size={14} color="#9ca3af" />
              </div>
            ))}
          </div>
        </SectionCard>
      );

      case 'geo': return (
        <SectionCard icon={MapPin} color="#10b981" label="Geo Settings">
          <Row label="Geo-Attendance Mandatory" desc="Require GPS validation for all clock-ins">
            <Toggle checked={geoSettings.geo_mandatory} onChange={v => setGeoSettings(g => ({ ...g, geo_mandatory: v }))} />
          </Row>
          <Row label="Block Outside Radius" desc="Reject clock-in attempts outside defined zones">
            <Toggle checked={geoSettings.block_outside} onChange={v => setGeoSettings(g => ({ ...g, block_outside: v }))} />
          </Row>
          <Row label="Default Radius (meters)" desc="Default geofence radius when creating new zones">
            <input type="number" min="50" max="10000" step="50" value={geoSettings.default_radius}
              onChange={e => setGeoSettings(g => ({ ...g, default_radius: parseInt(e.target.value) }))}
              style={{ ...inp, width: 100 }} />
          </Row>
          <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: 14, marginTop: 12, fontSize: 13, color: '#15803d' }}>
            <strong>Field Engineers</strong> with geo-exception enabled can punch from any location.
            Their GPS coordinates are logged for audit purposes.
          </div>
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button onClick={saveGeo} disabled={saving}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderRadius: 8, border: 'none', background: '#10b981', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', marginLeft: 'auto' }}>
              {saved === 'geo' ? <><Check size={14} /> Saved</> : <><Save size={14} /> Save Geo Settings</>}
            </button>
          </div>
        </SectionCard>
      );

      case 'face': return (
        <SectionCard icon={Camera} color="#f59e0b" label="Face Attendance Settings">
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13, color: '#d97706' }}>
            Full face attendance configuration is in the <strong>Face Attendance</strong> module. Configure thresholds, anti-spoof settings, and view suspicious attempt logs there.
          </div>
          <Row label="Enable Face Attendance" desc="Allow face recognition as an attendance method"><Toggle checked={false} onChange={() => {}} /></Row>
          <Row label="Selfie Validation" desc="Require a selfie photo for mobile attendance"><Toggle checked={true} onChange={() => {}} /></Row>
          <Row label="Anti-Spoof Detection" desc="Block photo/screen-based spoof attempts"><Toggle checked={true} onChange={() => {}} /></Row>
          <div style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
              Open Face Attendance Module →
            </button>
          </div>
        </SectionCard>
      );

      case 'device': return (
        <SectionCard icon={Cpu} color="#ef4444" label="Device Settings">
          <Row label="Auto Sync" desc="Automatically sync punch records from biometric devices">
            <Toggle checked={deviceSettings.auto_sync} onChange={v => setDeviceSettings(d => ({ ...d, auto_sync: v }))} />
          </Row>
          <Row label="Sync Interval (minutes)" desc="How often to pull records from devices">
            <input type="number" min="5" max="60" value={deviceSettings.sync_interval_minutes}
              onChange={e => setDeviceSettings(d => ({ ...d, sync_interval_minutes: parseInt(e.target.value) }))}
              style={{ ...inp, width: 80 }} />
          </Row>
          <Row label="Duplicate Punch Window (minutes)" desc="Ignore duplicate punches within this window">
            <input type="number" min="1" max="30" value={deviceSettings.duplicate_window_minutes}
              onChange={e => setDeviceSettings(d => ({ ...d, duplicate_window_minutes: parseInt(e.target.value) }))}
              style={{ ...inp, width: 80 }} />
          </Row>
          <Row label="Offline Sync" desc="Queue and sync records when device reconnects">
            <Toggle checked={deviceSettings.offline_sync} onChange={v => setDeviceSettings(d => ({ ...d, offline_sync: v }))} />
          </Row>
          <div style={{ background: '#fff7f0', border: '1px solid #fed7aa', borderRadius: 8, padding: 14, marginTop: 12, fontSize: 13, color: '#c2410c' }}>
            Supported devices: <strong>ZKTeco, eSSL, Matrix, Suprema</strong>. Register and manage devices in the <strong>Devices</strong> module.
          </div>
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button onClick={saveDevice} disabled={saving}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderRadius: 8, border: 'none', background: '#ef4444', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', marginLeft: 'auto' }}>
              {saved === 'device' ? <><Check size={14} /> Saved</> : <><Save size={14} /> Save Device Settings</>}
            </button>
          </div>
        </SectionCard>
      );

      case 'policy': return (
        <SectionCard icon={Shield} color="#8b5cf6" label="Policy Settings">
          <div style={{ background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13, color: '#6B3FDB' }}>
            Attendance policies (late, OT, break, field, factory) are configured in the <strong>Policies</strong> module with full JSONB rule editors.
          </div>
          {[
            { label: 'Late Arrival Policy', desc: 'Grace period, late mark, auto-deductions' },
            { label: 'Overtime Policy', desc: 'OT multipliers, max hours, approval requirement' },
            { label: 'Break Policy', desc: 'Lunch/tea break duration and tracking' },
            { label: 'Field Engineer Policy', desc: 'Geo-attendance, offline punch, travel allowance' },
            { label: 'Factory Policy', desc: 'Biometric mandatory, shift lock, gate-pass' },
          ].map(p => (
            <div key={p.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 0', borderBottom: '1px solid #f9f9f9' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{p.label}</div>
                <div style={{ fontSize: 12, color: '#9ca3af' }}>{p.desc}</div>
              </div>
              <span style={{ background: '#faf5ff', color: '#6B3FDB', borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>Configure →</span>
            </div>
          ))}
        </SectionCard>
      );

      case 'approval': return (
        <SectionCard icon={GitBranch} color="#06b6d4" label="Approval Matrix">
          <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
            Configure multi-level approval workflows for attendance regularization, overtime, and payroll freeze.
          </p>
          {WORKFLOW_TYPES.map(wt => {
            const existing = workflows.find(w => w.workflow_type === wt.id);
            const levels = existing?.levels || [];
            return (
              <div key={wt.id} style={{ padding: 16, borderRadius: 10, border: '1px solid #e0f2fe', background: '#f0f9ff', marginBottom: 12 }}>
                <div style={{ display: 'flex', justify: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{wt.label}</div>
                    <div style={{ fontSize: 12, color: '#9ca3af' }}>{wt.desc}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Employee →</span>
                  {['Reporting Manager (L1)', 'HR Admin (L2)', 'Department Head (L3)'].slice(0, levels.length || 2).map((l, i) => (
                    <React.Fragment key={i}>
                      <span style={{ background: '#06b6d415', color: '#0891b2', borderRadius: 12, padding: '3px 10px', fontSize: 12, fontWeight: 500 }}>{l}</span>
                      {i < (levels.length || 2) - 1 && <span style={{ color: '#9ca3af' }}>→</span>}
                    </React.Fragment>
                  ))}
                  <button style={{ marginLeft: 8, border: 'none', background: '#06b6d4', color: '#fff', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer' }}>Edit</button>
                </div>
              </div>
            );
          })}
          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: 12, fontSize: 12, color: '#0369a1', marginTop: 8 }}>
            <AlertCircle size={12} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Reporting manager is auto-detected from the <strong>reporting_manager_id</strong> field on each employee record.
          </div>
        </SectionCard>
      );

      case 'payroll': return (
        <SectionCard icon={IndianRupee} color="#f97316" label="Payroll Sync Settings">
          <Row label="Payroll Sync Day" desc="Day of month to freeze attendance for payroll">
            <input type="number" min="1" max="31" defaultValue={1} style={{ ...inp, width: 80 }} />
          </Row>
          <Row label="Allow Manual Override" desc="Allow HR to unfreeze and re-sync attendance">
            <Toggle checked={true} onChange={() => {}} />
          </Row>
          <Row label="Include OT in Sync" desc="Include overtime hours in payroll sync data">
            <Toggle checked={true} onChange={() => {}} />
          </Row>
          <Row label="Auto-Calculate OT" desc="Recalculate OT before payroll sync">
            <Toggle checked={false} onChange={() => {}} />
          </Row>
          <Row label="Payroll System Integration" desc="External payroll system to push sync data to">
            <select style={inp}>
              <option>Pulse Payroll (Internal)</option>
              <option>GreytHR</option>
              <option>Keka</option>
              <option>CSV Export</option>
            </select>
          </Row>
          <div style={{ background: '#fff7f0', border: '1px solid #fed7aa', borderRadius: 8, padding: 14, marginTop: 12, fontSize: 13, color: '#c2410c' }}>
            Once attendance is frozen for a month, records are marked <strong>immutable</strong>. Only a Super Admin can unfreeze.
          </div>
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderRadius: 8, border: 'none', background: '#f97316', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', marginLeft: 'auto' }}>
              <Save size={14} /> Save Payroll Settings
            </button>
          </div>
        </SectionCard>
      );

      case 'workcentre': return (
        <SectionCard icon={Layers} color="#84cc16" label="Work Centre Settings">
          <Row label="Track Work Centres" desc="Enable work-centre level attendance for manufacturing">
            <Toggle checked={wc.track_work_centres} onChange={v => setWc(w => ({ ...w, track_work_centres: v }))} />
          </Row>
          <Row label="Require Work Centre for Factory Staff" desc="Factory employees must log to a work centre">
            <Toggle checked={wc.require_wc_for_factory} onChange={v => setWc(w => ({ ...w, require_wc_for_factory: v }))} />
          </Row>
          <Row label="Units Produced Tracking" desc="Track units produced per employee per shift">
            <Toggle checked={!!wc.units_produced_tracking} onChange={v => setWc(w => ({ ...w, units_produced_tracking: v }))} />
          </Row>
          <Row label="Work Centre Reporting" desc="Include work centre data in monthly attendance reports">
            <Toggle checked={wc.include_in_reports !== false} onChange={v => setWc(w => ({ ...w, include_in_reports: v }))} />
          </Row>
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button onClick={saveWc} disabled={saving}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderRadius: 8, border: 'none', background: '#84cc16', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', marginLeft: 'auto' }}>
              {saved === 'workcentre' ? <><Check size={14} /> Saved</> : <><Save size={14} /> Save Work Centre Settings</>}
            </button>
          </div>
        </SectionCard>
      );

      case 'reports': return (
        <SectionCard icon={FileText} color="#a78bfa" label="Reports & Export Settings">
          <Row label="Auto Monthly Report" desc="Automatically generate monthly attendance report on 1st">
            <Toggle checked={reportSettings.auto_monthly_report} onChange={v => setReportSettings(r => ({ ...r, auto_monthly_report: v }))} />
          </Row>
          <Row label="Export Format" desc="Default format for downloaded attendance reports">
            <select value={reportSettings.export_format} onChange={e => setReportSettings(r => ({ ...r, export_format: e.target.value }))} style={inp}>
              <option value="xlsx">Excel (.xlsx)</option>
              <option value="csv">CSV (.csv)</option>
              <option value="pdf">PDF Report</option>
            </select>
          </Row>
          <Row label="Include Photos in Report" desc="Embed selfie photos in exported reports">
            <Toggle checked={reportSettings.include_photos} onChange={v => setReportSettings(r => ({ ...r, include_photos: v }))} />
          </Row>
          <Row label="Report Recipient Email" desc="Auto-email monthly reports to this address">
            <input type="email" value={reportSettings.report_email}
              onChange={e => setReportSettings(r => ({ ...r, report_email: e.target.value }))}
              style={{ ...inp, minWidth: 220 }} placeholder="hr@company.com" />
          </Row>
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button onClick={saveReport} disabled={saving}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderRadius: 8, border: 'none', background: '#a78bfa', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', marginLeft: 'auto' }}>
              {saved === 'report' ? <><Check size={14} /> Saved</> : <><Save size={14} /> Save Report Settings</>}
            </button>
          </div>
        </SectionCard>
      );

      default: return null;
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif', margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1f2937' }}>General Settings</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Centralized configuration for all attendance module features</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 20, alignItems: 'start' }}>
        {/* Sidebar nav */}
        <div style={CARD}>
          <nav>
            {SECTIONS.map(s => (
              <button key={s.id} onClick={() => setActiveSection(s.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none',
                  background: activeSection === s.id ? `${s.color}12` : 'transparent',
                  color: activeSection === s.id ? s.color : '#374151',
                  fontWeight: activeSection === s.id ? 700 : 400, fontSize: 13, cursor: 'pointer', marginBottom: 2, textAlign: 'left' }}>
                <s.icon size={15} color={activeSection === s.id ? s.color : '#9ca3af'} />
                {s.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Content area */}
        <div>
          {saved && (
            <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 14px', marginBottom: 14, color: '#15803d', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Check size={14} /> Settings saved successfully
            </div>
          )}
          {renderSection()}
        </div>
      </div>
    </div>
  );
}
