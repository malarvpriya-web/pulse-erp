// frontend/src/features/hr/pages/SuccessionSettings.jsx
import React, { useState, useEffect } from 'react';
import api from '@/services/api/client';

const INP = { width: '100%', boxSizing: 'border-box', padding: '7px 10px',
              border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 };
const LBL = { fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 };
const BTN = (v = 'primary', sm = false) => ({
  border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600,
  fontSize: sm ? 12 : 13, padding: sm ? '4px 10px' : '8px 18px',
  background: v === 'primary' ? '#6B3FDB' : v === 'ghost' ? 'none' : '#e9e4ff',
  color: v === 'primary' ? '#fff' : v === 'ghost' ? '#6b7280' : '#6B3FDB',
});

function Spinner() {
  return (
    <div style={{ textAlign: 'center', padding: 48 }}>
      <style>{`@keyframes _spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'inline-block', width: 36, height: 36, border: '3px solid #e9e4ff',
                    borderTopColor: '#6B3FDB', borderRadius: '50%', animation: '_spin .75s linear infinite' }} />
    </div>
  );
}

function Toggle({ checked, onChange, label, description }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer',
                    padding: '12px 0', borderBottom: '1px solid #f0ebff' }}>
      <div onClick={onChange}
        style={{ width: 44, height: 24, borderRadius: 12, flexShrink: 0, marginTop: 2,
                 background: checked ? '#6B3FDB' : '#d1d5db', position: 'relative',
                 transition: 'background .2s', cursor: 'pointer' }}>
        <div style={{ position: 'absolute', top: 2, left: checked ? 22 : 2, width: 20, height: 20,
                      borderRadius: '50%', background: '#fff', transition: 'left .2s',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
      </div>
      <div>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#1f2937' }}>{label}</div>
        {description && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{description}</div>}
      </div>
    </label>
  );
}

function Section({ title, description, children }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', padding: 24, marginBottom: 20 }}>
      <div style={{ marginBottom: 20 }}>
        <h3 style={{ margin: 0, color: '#4c1d95', fontSize: 15 }}>{title}</h3>
        {description && <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>{description}</p>}
      </div>
      {children}
    </div>
  );
}

const ALL_ROLES = ['super_admin', 'admin', 'chro', 'hr_admin', 'hr_manager', 'manager', 'department_head'];

const DEFAULTS = {
  zero_successor_alert:       true,
  single_successor_alert:     true,
  flight_risk_threshold:      'high',
  review_frequency:           'quarterly',
  notify_roles:               ['chro', 'hr_admin', 'hr_manager'],
  hiPo_threshold_potential:   4,
  hiPo_threshold_performance: 3,
};

export default function SuccessionSettings() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [msg,      setMsg]      = useState({ text: '', type: '' });
  const [dirty,    setDirty]    = useState(false);

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 3500);
  };

  useEffect(() => {
    api.get('/succession/settings')
      .then(r => { setSettings({ ...DEFAULTS, ...r.data }); })
      .catch(() => setSettings(DEFAULTS))
      .finally(() => setLoading(false));
  }, []);

  const update = (key, value) => {
    setSettings(s => ({ ...s, [key]: value }));
    setDirty(true);
  };

  const toggleRole = (role) => {
    const current = settings.notify_roles || [];
    const next    = current.includes(role) ? current.filter(r => r !== role) : [...current, role];
    update('notify_roles', next);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/succession/settings', settings);
      flash('Settings saved');
      setDirty(false);
    } catch (err) {
      flash(err.response?.data?.message || 'Failed to save', 'error');
    } finally { setSaving(false); }
  };

  if (loading) return <div style={{ padding: 24 }}><Spinner /></div>;

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                    marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>Succession Settings</h2>
          <p style={{ margin: 0, color: '#6b7280', fontSize: 13, marginTop: 4 }}>
            Configure alert thresholds, review frequency, and notification preferences
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {dirty && (
            <span style={{ fontSize: 12, color: '#d97706', fontWeight: 500 }}>
              Unsaved changes
            </span>
          )}
          <button onClick={save} disabled={saving || !dirty} style={{
            ...BTN('primary'),
            opacity: saving || !dirty ? 0.6 : 1,
          }}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      {msg.text && (
        <div style={{ marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14,
                      background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4',
                      color:      msg.type === 'error' ? '#dc2626' : '#16a34a',
                      border:     `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>
          {msg.text}
        </div>
      )}

      {/* ── Alerts ── */}
      <Section title="Succession Alerts"
        description="Automatically generate alerts when critical roles lack sufficient successors">
        <Toggle
          checked={settings.zero_successor_alert}
          onChange={() => update('zero_successor_alert', !settings.zero_successor_alert)}
          label="Zero Successor Alert"
          description="Alert when a critical role has no succession candidates defined at all" />
        <Toggle
          checked={settings.single_successor_alert}
          onChange={() => update('single_successor_alert', !settings.single_successor_alert)}
          label="Single Successor Alert"
          description="Alert when a critical role has only one succession candidate — single point of failure" />
      </Section>

      {/* ── Thresholds ── */}
      <Section title="Thresholds"
        description="Define when an employee is considered high potential or a flight risk">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 20, marginBottom: 20 }}>
          <div>
            <label style={LBL}>Flight Risk Threshold</label>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
              Highlight employees at or above this risk level in reports
            </div>
            <select value={settings.flight_risk_threshold}
              onChange={e => update('flight_risk_threshold', e.target.value)} style={INP}>
              <option value="low">Low (show all)</option>
              <option value="medium">Medium (medium + high)</option>
              <option value="high">High only</option>
            </select>
          </div>

          <div>
            <label style={LBL}>Review Frequency</label>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
              How often talent assessments should be reviewed
            </div>
            <select value={settings.review_frequency}
              onChange={e => update('review_frequency', e.target.value)} style={INP}>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="half-yearly">Half-Yearly</option>
              <option value="annually">Annually</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 20 }}>
          <div>
            <label style={LBL}>
              HiPo Threshold — Potential Score &ge; {settings.hiPo_threshold_potential}
            </label>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
              Minimum potential score to be classified as High Potential
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {[1, 2, 3, 4, 5].map(v => (
                <button key={v} type="button"
                  onClick={() => update('hiPo_threshold_potential', v)}
                  style={{ width: 36, height: 36, borderRadius: 6, border: 'none', cursor: 'pointer',
                           fontWeight: 700, fontSize: 13,
                           background: settings.hiPo_threshold_potential === v ? '#6B3FDB' : '#e9e4ff',
                           color: settings.hiPo_threshold_potential === v ? '#fff' : '#6B3FDB' }}>
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={LBL}>
              HiPo Threshold — Performance Score &ge; {settings.hiPo_threshold_performance}
            </label>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
              Minimum performance score to be classified as High Potential
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {[1, 2, 3, 4, 5].map(v => (
                <button key={v} type="button"
                  onClick={() => update('hiPo_threshold_performance', v)}
                  style={{ width: 36, height: 36, borderRadius: 6, border: 'none', cursor: 'pointer',
                           fontWeight: 700, fontSize: 13,
                           background: settings.hiPo_threshold_performance === v ? '#16a34a' : '#e9e4ff',
                           color: settings.hiPo_threshold_performance === v ? '#fff' : '#16a34a' }}>
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* ── Notifications ── */}
      <Section title="Notification Recipients"
        description="Roles that receive succession alerts and review reminders">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {ALL_ROLES.map(role => {
            const selected = (settings.notify_roles || []).includes(role);
            return (
              <button key={role} type="button" onClick={() => toggleRole(role)}
                style={{ padding: '7px 16px', borderRadius: 8, cursor: 'pointer',
                         fontWeight: 600, fontSize: 12, transition: 'all .15s',
                         border: selected ? 'none' : '1px solid #e9e4ff',
                         background: selected ? '#6B3FDB' : '#fff',
                         color: selected ? '#fff' : '#6b7280' }}>
                {role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
              </button>
            );
          })}
        </div>
        {(settings.notify_roles || []).length === 0 && (
          <div style={{ marginTop: 12, fontSize: 12, color: '#d97706', fontWeight: 500 }}>
            Warning: No roles selected — alerts will not be sent to anyone.
          </div>
        )}
      </Section>

      {/* ── Info box ── */}
      <div style={{ background: '#eff6ff', borderRadius: 10, padding: 16,
                    border: '1px solid #bfdbfe', fontSize: 13, color: '#1d4ed8' }}>
        <strong>Note:</strong> Succession alerts are generated automatically when:
        <ul style={{ margin: '6px 0 0 16px', lineHeight: 2 }}>
          <li>A critical role is created with no successor candidates</li>
          <li>The last succession candidate is removed from a critical role</li>
          <li>A candidate is added and the total drops to exactly one successor</li>
        </ul>
        Alerts can be reviewed in the Bench Strength tab's alert banner.
        The review frequency setting is informational — it does not trigger automatic notifications in this version.
      </div>
    </div>
  );
}
