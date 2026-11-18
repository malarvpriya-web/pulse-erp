// frontend/src/features/hr/succession/SuccessionSettings.jsx
// Succession Center → Settings: alert switches, thresholds and who is notified.
import React, { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { INP, LBL, BTN, Spinner, Flash, LoadError, useFlash, errText } from '../utils/successionUi';

// The whole row is one switch. It used to be a <label> with no input inside,
// and only the 44px track had the click handler, so clicking the label text did
// nothing; the track was a bare div that the keyboard could not reach.
function Toggle({ checked, onChange, label, description }) {
  return (
    <button type="button" role="switch" aria-checked={!!checked} onClick={onChange}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer', width: '100%',
               textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid #f0ebff',
               padding: '12px 0', font: 'inherit' }}>
      <div aria-hidden="true"
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
    </button>
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

const DEFAULTS = {
  zero_successor_alert:       true,
  single_successor_alert:     true,
  flight_risk_threshold:      'high',
  review_frequency:           'quarterly',
  notify_roles:               [],
  hiPo_threshold_potential:   4,
  hiPo_threshold_performance: 3,
};

export default function SuccessionSettings() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [roles,    setRoles]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [msg, flash]            = useFlash();
  const [dirty,    setDirty]    = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    // A failed load used to show the defaults as if they were saved, and Save
    // then wrote them over the real settings. Now it says so and cannot save.
    api.get('/succession/settings')
      .then(r => { setSettings({ ...DEFAULTS, ...r.data }); })
      .catch(err => setLoadError(errText(err, 'Could not load the saved settings')))
      .finally(() => setLoading(false));
    // The roles that can open Succession, with how many people hold each.
    api.get('/succession/settings/recipient-roles')
      .then(r => setRoles(Array.isArray(r.data) ? r.data : []))
      .catch(() => setRoles([]));
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
      const r = await api.put('/succession/settings', settings);
      // Show what the server stored, not what was sent.
      setSettings({ ...DEFAULTS, ...r.data });
      flash('Settings saved');
      setDirty(false);
    } catch (err) {
      flash(errText(err, 'Failed to save'), 'error');
    } finally { setSaving(false); }
  };

  if (loading) return <Spinner />;
  if (loadError) return <LoadError text={`${loadError}. Nothing can be saved until the settings load.`} />;

  const selected = settings.notify_roles || [];
  const recipientsText = selected.length
    ? `People holding ${selected.length === 1 ? 'this role' : 'any of these roles'} are notified.`
    : 'None selected: everyone who can open the Succession Center is notified.';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
          Alerts, thresholds and who is told when someone in a succession plan leaves.
        </p>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {dirty && <span style={{ fontSize: 12, color: '#b45309' }}>Unsaved changes</span>}
          <button type="button" style={BTN('primary')} onClick={save} disabled={saving || !dirty}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </span>
      </div>

      <Flash msg={msg} />

      {/* ── Alerts ── */}
      <Section title="Succession Alerts"
        description="Record an alert in the Planning tab when a critical role lacks successors">
        <Toggle
          checked={settings.zero_successor_alert}
          onChange={() => update('zero_successor_alert', !settings.zero_successor_alert)}
          label="Zero Successor Alert"
          description="Alert when a critical role has no succession candidates (people who have left do not count)" />
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
            <label style={LBL} htmlFor="st-risk">Flight Risk Threshold</label>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
              Highlight employees at or above this risk level in reports
            </div>
            <select id="st-risk" value={settings.flight_risk_threshold}
              onChange={e => update('flight_risk_threshold', e.target.value)} style={INP}>
              <option value="low">Low (show all)</option>
              <option value="medium">Medium (medium + high)</option>
              <option value="high">High only</option>
            </select>
          </div>

          <div>
            <label style={LBL} htmlFor="st-freq">Review Frequency</label>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
              How often talent assessments should be reviewed (for reference; nothing is scheduled)
            </div>
            <select id="st-freq" value={settings.review_frequency}
              onChange={e => update('review_frequency', e.target.value)} style={INP}>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="half-yearly">Half-Yearly</option>
              <option value="annually">Annually</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 20 }}>
          {[['hiPo_threshold_potential', 'Potential', '#6B3FDB'], ['hiPo_threshold_performance', 'Performance', '#16a34a']].map(([key, name, color]) => (
            <div key={key}>
              <span style={LBL}>HiPo Threshold — {name} Score &ge; {settings[key]}</span>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                Minimum {name.toLowerCase()} score to be classified as High Potential
              </div>
              <div role="radiogroup" aria-label={`HiPo ${name.toLowerCase()} threshold`} style={{ display: 'flex', gap: 4 }}>
                {[1, 2, 3, 4, 5].map(v => (
                  <button key={v} type="button" role="radio" aria-checked={settings[key] === v}
                    onClick={() => update(key, v)}
                    style={{ width: 36, height: 36, borderRadius: 6, border: 'none', cursor: 'pointer',
                             fontWeight: 700, fontSize: 13,
                             background: settings[key] === v ? color : '#e9e4ff',
                             color: settings[key] === v ? '#fff' : color }}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Notifications ── */}
      <Section title="Notification Recipients"
        description="Who is notified (in-app notification) when an employee who appears in Succession starts serving notice or leaves. Only roles that can open the Succession Center are offered.">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {roles.map(({ code, label, user_count }) => {
            const on = selected.includes(code);
            return (
              <button key={code} type="button" aria-pressed={on} onClick={() => toggleRole(code)}
                style={{ padding: '7px 16px', borderRadius: 8, cursor: 'pointer',
                         fontWeight: 600, fontSize: 12, transition: 'all .15s',
                         border: on ? '1px solid #6B3FDB' : '1px solid #e9e4ff',
                         background: on ? '#6B3FDB' : '#fff',
                         color: on ? '#fff' : '#6b7280' }}>
                {label} <span style={{ fontWeight: 400, opacity: 0.8 }}>({user_count} {user_count === 1 ? 'person' : 'people'})</span>
              </button>
            );
          })}
          {/* A stored code the server no longer offers is shown, so it can be removed. */}
          {selected.filter(c => !roles.some(r => r.code === c)).map(code => (
            <button key={code} type="button" aria-pressed onClick={() => toggleRole(code)}
              title="This role can no longer open Succession; click to remove it"
              style={{ padding: '7px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 12,
                       border: '1px dashed #dc2626', background: '#fef2f2', color: '#dc2626' }}>
              {code} (remove)
            </button>
          ))}
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: selected.length ? '#6b7280' : '#6d28d9', fontWeight: 500 }}>
          {recipientsText}
        </div>
      </Section>

      {/* ── Info box ── */}
      <div style={{ background: '#eff6ff', borderRadius: 10, padding: 16,
                    border: '1px solid #bfdbfe', fontSize: 13, color: '#1d4ed8' }}>
        <strong>What happens when:</strong>
        <ul style={{ margin: '6px 0 0 16px', lineHeight: 1.9 }}>
          <li>
            <strong>An employee who appears in Succession starts serving notice or leaves</strong> (by Exit Management,
            offboarding, a status change or deletion): one alert lists every place they appear (role holder, successor,
            pipeline, development plan, action owner, mentoring, pool, 9-box rating), and the recipients above get an
            in-app notification. Someone who has left is no longer counted anywhere and is marked &ldquo;Left&rdquo; where they
            still need replacing. No email is sent.
          </li>
          <li>
            <strong>A critical role has no successor, or only one</strong> (when that switch is on): an alert is recorded
            in the Planning tab&apos;s alert banner when the role reaches that state. For these alerts no message is sent.
          </li>
          <li>The thresholds decide who is listed as high potential on the Bench Strength tab and which rows the Talent Risk report highlights.</li>
          <li>Review frequency is informational only and triggers nothing.</li>
        </ul>
      </div>
    </div>
  );
}
