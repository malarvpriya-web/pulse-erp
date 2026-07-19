import { useState, useEffect, useRef } from 'react';
import { Save, Settings, RefreshCw, AlertCircle } from 'lucide-react';
import api from '@/services/api/client';

const CAMPAIGN_TYPES = ['email', 'social', 'event', 'content', 'paid', 'referral'];
const PRIORITIES     = ['low', 'medium', 'high', 'critical'];
const MONTHS         = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const DEFAULTS = {
  default_campaign_type:    'email',
  fiscal_year_start:        'April',
  budget_alert_threshold:   80,
  auto_assign_tasks:        false,
  default_pursuit_priority: 'medium',
};

function SectionHeader({ icon: Icon, title, subtitle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
      <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(107,63,219,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={18} style={{ color: '#6B3FDB' }} />
      </div>
      <div>
        <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-text-primary)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>{subtitle}</div>
      </div>
    </div>
  );
}

function FieldRow({ label, hint, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, alignItems: 'flex-start', padding: '14px 0', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const selectStyle = {
  padding: '7px 10px', border: '0.5px solid var(--color-border-tertiary)',
  borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)',
  color: 'var(--color-text-primary)', width: '100%', maxWidth: 260,
};

const inputStyle = {
  padding: '7px 10px', border: '0.5px solid var(--color-border-tertiary)',
  borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)',
  color: 'var(--color-text-primary)', width: 120,
};

export default function MarketingSettings() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [saved,    setSaved]    = useState(DEFAULTS);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');
  const successTimer = useRef(null);

  const isDirty = JSON.stringify(settings) !== JSON.stringify(saved);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await api.get('/marketing/settings');
        const d = { ...DEFAULTS, ...(res.data || {}) };
        setSettings(d);
        setSaved(d);
      } catch { /* keep defaults */ }
      finally { setLoading(false); }
    })();
  }, []);

  const set = (key, val) => {
    setSettings(prev => ({ ...prev, [key]: val }));
    setSuccess('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await api.put('/marketing/settings', settings);
      setSaved(settings);
      setSuccess('Settings saved successfully.');
      clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setSuccess(''), 3000);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to save settings. Please try again.');
    } finally { setSaving(false); }
  };

  const handleReset = () => {
    setSettings(saved);
    setError('');
    setSuccess('');
  };

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
        {[1,2,3,4].map(i => (
          <div key={i} style={{ height: 52, background: 'var(--color-background-secondary)', borderRadius: 8, marginBottom: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />
        ))}
      </div>
    );
  }

  return (
    <div style={{ padding: 24, background: 'var(--color-background-primary)', maxWidth: 860 }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>Marketing Settings</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Configure defaults and automation for the marketing module</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isDirty && (
            <button onClick={handleReset}
              style={{ padding: '8px 16px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, background: 'var(--color-background-secondary)', cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={14} /> Reset
            </button>
          )}
          <button onClick={handleSave} disabled={saving || !isDirty}
            style={{ padding: '8px 18px', border: 'none', borderRadius: 8, background: isDirty ? '#6B3FDB' : 'var(--color-border-tertiary)', cursor: isDirty ? 'pointer' : 'default', fontSize: 13, fontWeight: 600, color: isDirty ? '#fff' : 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6, transition: 'background 0.2s' }}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Banners */}
      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 8, background: '#fee2e2', color: '#dc2626', fontSize: 13, marginBottom: 16, border: '0.5px solid #fca5a5' }}>
          <AlertCircle size={15} /> {error}
        </div>
      )}
      {success && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 8, background: '#d1fae5', color: '#16a34a', fontSize: 13, marginBottom: 16, border: '0.5px solid #6ee7b7' }}>
          {success}
        </div>
      )}
      {isDirty && !error && !success && (
        <div style={{ padding: '8px 14px', borderRadius: 8, background: '#fef3c7', color: '#92400e', fontSize: 12, marginBottom: 16, border: '0.5px solid #fde68a' }}>
          You have unsaved changes.
        </div>
      )}

      {/* Section: Campaign Defaults */}
      <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: '20px 24px', marginBottom: 20 }}>
        <SectionHeader icon={Settings} title="Campaign Defaults" subtitle="Applied when creating new campaigns" />

        <FieldRow label="Default Campaign Type" hint="Pre-selected type when adding a new campaign">
          <select value={settings.default_campaign_type} onChange={e => set('default_campaign_type', e.target.value)} style={selectStyle}>
            {CAMPAIGN_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
          </select>
        </FieldRow>

        <FieldRow label="Fiscal Year Start" hint="Month in which the marketing fiscal year begins">
          <select value={settings.fiscal_year_start} onChange={e => set('fiscal_year_start', e.target.value)} style={selectStyle}>
            {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </FieldRow>
      </div>

      {/* Section: Budget & Alerts */}
      <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: '20px 24px', marginBottom: 20 }}>
        <SectionHeader icon={AlertCircle} title="Budget & Alerts" subtitle="Controls for budget utilization warnings" />

        <FieldRow label="Budget Alert Threshold (%)" hint="Warn when campaign spend exceeds this % of budget">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="number" min={1} max={100} step={1}
              value={settings.budget_alert_threshold}
              onChange={e => set('budget_alert_threshold', Math.min(100, Math.max(1, parseInt(e.target.value) || 1)))}
              style={inputStyle} />
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>%</span>
            <div style={{ flex: 1, maxWidth: 180, height: 6, background: 'var(--color-border-tertiary)', borderRadius: 3 }}>
              <div style={{ height: '100%', width: `${settings.budget_alert_threshold}%`, background: settings.budget_alert_threshold >= 90 ? '#dc2626' : settings.budget_alert_threshold >= 70 ? '#d97706' : '#16a34a', borderRadius: 3 }} />
            </div>
          </div>
        </FieldRow>
      </div>

      {/* Section: Task Automation */}
      <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: '20px 24px', marginBottom: 20 }}>
        <SectionHeader icon={RefreshCw} title="Task Automation" subtitle="Controls for automatic task creation and assignment" />

        <FieldRow label="Auto-assign Tasks" hint="Automatically assign tasks to campaign owner when campaign is created">
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <div
              onClick={() => set('auto_assign_tasks', !settings.auto_assign_tasks)}
              style={{ position: 'relative', width: 40, height: 22, borderRadius: 11, background: settings.auto_assign_tasks ? '#6B3FDB' : 'var(--color-border-tertiary)', transition: 'background 0.2s', cursor: 'pointer', flexShrink: 0 }}>
              <div style={{ position: 'absolute', top: 2, left: settings.auto_assign_tasks ? 20 : 2, width: 18, height: 18, borderRadius: 9, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.2s' }} />
            </div>
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{settings.auto_assign_tasks ? 'Enabled' : 'Disabled'}</span>
          </label>
        </FieldRow>

        <FieldRow label="Default Pursuit Priority" hint="Priority pre-selected when adding to pursuit list">
          <select value={settings.default_pursuit_priority} onChange={e => set('default_pursuit_priority', e.target.value)} style={selectStyle}>
            {PRIORITIES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
          </select>
        </FieldRow>
      </div>

      {/* Footer save */}
      {isDirty && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
          <button onClick={handleReset}
            style={{ padding: '8px 16px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, background: 'var(--color-background-secondary)', cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)' }}>
            Discard
          </button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '8px 18px', border: 'none', borderRadius: 8, background: '#6B3FDB', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      )}
    </div>
  );
}
