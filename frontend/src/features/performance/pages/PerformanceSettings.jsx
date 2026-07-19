import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const PURPLE = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const SECTIONS = [
  {
    id: 'review_cycle',
    title: 'Review Cycle',
    icon: '🔄',
    fields: [
      { key: 'cycle_frequency', label: 'Review Frequency', type: 'select', options: ['Monthly','Quarterly','Half-Yearly','Annual'] },
      { key: 'self_review_days', label: 'Self-Review Window (days)', type: 'number', placeholder: '7' },
      { key: 'manager_review_days', label: 'Manager Review Window (days)', type: 'number', placeholder: '14' },
      { key: 'calibration_days', label: 'Calibration Period (days)', type: 'number', placeholder: '7' },
    ],
  },
  {
    id: 'rating',
    title: 'Rating Scale',
    icon: '⭐',
    fields: [
      { key: 'rating_scale', label: 'Rating Scale', type: 'select', options: ['1–5','1–10','A-B-C-D','Exceptional/Meets/Below'] },
      { key: 'min_rating_to_promote', label: 'Min Rating for Promotion', type: 'number', placeholder: '4' },
      { key: 'pip_trigger_rating', label: 'PIP Trigger Rating (below)', type: 'number', placeholder: '2' },
    ],
  },
  {
    id: 'goals',
    title: 'Goals & OKRs',
    icon: '🎯',
    fields: [
      { key: 'max_goals_per_cycle', label: 'Max Goals per Cycle', type: 'number', placeholder: '5' },
      { key: 'goal_weight_mandatory', label: 'Goal Weightage must total 100%', type: 'toggle' },
      { key: 'cascade_goals', label: 'Enable goal cascading from manager', type: 'toggle' },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    icon: '🔔',
    fields: [
      { key: 'notify_review_due', label: 'Notify when review is due', type: 'toggle' },
      { key: 'notify_goal_deadline', label: 'Notify 7 days before goal deadline', type: 'toggle' },
      { key: 'notify_rating_published', label: 'Notify employee on rating publish', type: 'toggle' },
    ],
  },
  {
    id: 'permissions',
    title: 'Permissions',
    icon: '🔒',
    fields: [
      { key: 'employee_can_view_rating', label: 'Employee can view their own rating', type: 'toggle' },
      { key: 'hr_can_edit_submitted', label: 'HR can edit submitted reviews', type: 'toggle' },
      { key: 'allow_skip_levels', label: 'Allow skip-level review', type: 'toggle' },
    ],
  },
];

export default function PerformanceSettings({ setPage }) {
  const [settings, setSettings] = useState({});
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.get('/settings/performance').then(r => {
      setSettings(r.data || {});
    }).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/settings/performance', settings);

      // Create an initial review cycle if none exists so pages don't crash
      try {
        const cyclesRes = await api.get('/performance/cycles');
        if (!cyclesRes.data?.length && settings.cycle_frequency) {
          const freq = settings.cycle_frequency;
          const year = new Date().getFullYear();
          const period = freq === 'Quarterly'   ? `Q1 ${year}`  :
                         freq === 'Half-Yearly'  ? `H1 ${year}`  :
                         freq === 'Monthly'      ? `Month 1 ${year}` :
                                                   `FY ${year}`;
          await api.post('/performance/cycles', {
            name:        `${freq} Review ${year}`,
            cycle_type:  freq.toLowerCase().replace('-', '_').replace(' ', '_'),
            review_period: period,
            start_date:  new Date().toISOString().slice(0, 10),
          });
        }
      } catch { /* cycle creation is best-effort */ }

      toast.success('Performance settings saved');
    } catch {
      toast.error('Failed to save settings');
    } finally { setSaving(false); }
  };

  const set = (key, val) => setSettings(s => ({ ...s, [key]: val }));

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontWeight: 800, fontSize: 22, color: '#1f2937', margin: 0 }}>Performance Settings</h2>
        <p style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>Configure review cycles, rating scales, goal policies, and notifications.</p>
      </div>

      {SECTIONS.map(section => (
        <div key={section.id} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, color: '#1f2937', margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{section.icon}</span>{section.title}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
            {section.fields.map(field => (
              <div key={field.key}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{field.label}</label>
                {field.type === 'toggle' ? (
                  <button
                    type="button"
                    onClick={() => set(field.key, !settings[field.key])}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    <div style={{
                      width: 42, height: 24, borderRadius: 12, flexShrink: 0, position: 'relative',
                      background: settings[field.key] ? PURPLE : '#d1d5db',
                      transition: 'background 0.2s',
                    }}>
                      <div style={{
                        position: 'absolute', top: 3,
                        left: settings[field.key] ? 21 : 3,
                        width: 18, height: 18, borderRadius: '50%', background: '#fff',
                        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                      }} />
                    </div>
                    <span style={{ fontSize: 13, fontWeight: settings[field.key] ? 600 : 400, color: settings[field.key] ? PURPLE : '#9ca3af' }}>
                      {settings[field.key] ? 'Enabled' : 'Disabled'}
                    </span>
                  </button>
                ) : field.type === 'select' ? (
                  <select value={settings[field.key] || ''} onChange={e => set(field.key, e.target.value)} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 13 }}>
                    <option value="">Select…</option>
                    {field.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input type={field.type} value={settings[field.key] ?? ''} onChange={e => set(field.key, e.target.value)} placeholder={field.placeholder} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 13, boxSizing: 'border-box' }} />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
        <button onClick={() => setPage?.('PerformanceReviews')} style={{ padding: '10px 24px', borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', color: '#374151', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ padding: '10px 24px', borderRadius: 8, background: saving ? '#d1d5db' : PURPLE, color: '#fff', fontWeight: 700, fontSize: 14, border: 'none', cursor: saving ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving…' : 'Save Settings'}</button>
      </div>
    </div>
  );
}
