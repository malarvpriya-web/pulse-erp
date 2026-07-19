// frontend/src/features/hr/pages/LNDSettings.jsx
import { useState, useEffect } from 'react';
import { useToast } from '@/context/ToastContext';
import api from '@/services/api/client';

const inputStyle = { width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 };

function Section({ title, icon, children }) {
  return (
    <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:12, padding:20, marginBottom:16 }}>
      <h3 style={{ margin:'0 0 16px', color:'#4c1d95', fontSize:15, display:'flex', alignItems:'center', gap:8 }}>
        <span>{icon}</span> {title}
      </h3>
      {children}
    </div>
  );
}

function Toggle({ label, description, checked, onChange }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 0', borderBottom:'1px solid #f0ebff' }}>
      <div>
        <div style={{ fontWeight:600, fontSize:13, color:'#1f2937' }}>{label}</div>
        {description && <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>{description}</div>}
      </div>
      <div onClick={onChange} style={{ width:44, height:24, borderRadius:12, background: checked ? '#6B3FDB' : '#e5e7eb', cursor:'pointer', position:'relative', transition:'background 0.2s', flexShrink:0 }}>
        <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: checked ? 23 : 3, transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,0.2)' }} />
      </div>
    </div>
  );
}

export default function LNDSettings() {
  const toast = useToast();
  const [settings, setSettings] = useState({
    training_categories: ['Technical','Soft Skills','Safety','Compliance','Leadership','Onboarding'],
    default_pass_score: 70,
    reminder_days_before: 7,
    cert_expiry_reminder_days: 30,
    enable_email_notifications: true,
    enable_manager_notifications: true,
    mandatory_training_freq_days: 365,
    feedback_required: true,
    min_feedback_chars: 10,
    allow_self_enrollment: true,
    max_concurrent_enrollments: 5,
  });
  const [catInput, setCatInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get('/lnd-settings').then(r => {
      const d = r.data;
      setSettings({
        ...d,
        training_categories: Array.isArray(d.training_categories)
          ? d.training_categories
          : (typeof d.training_categories === 'string'
              ? JSON.parse(d.training_categories)
              : ['Technical','Soft Skills','Safety','Compliance','Leadership','Onboarding']),
      });
    }).catch(() => {});
  }, []);

  const save = async () => {
    setLoading(true);
    try {
      await api.put('/lnd-settings', settings);
      toast.success('L&D settings saved');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to save'); }
    finally { setLoading(false); }
  };

  const addCategory = () => {
    const cat = catInput.trim();
    if (!cat) return;
    if (settings.training_categories.includes(cat)) { toast.error('Category already exists'); return; }
    setSettings(s => ({ ...s, training_categories: [...s.training_categories, cat] }));
    setCatInput('');
  };

  const removeCategory = (cat) => setSettings(s => ({ ...s, training_categories: s.training_categories.filter(c => c !== cat) }));

  const set = (key, val) => setSettings(s => ({ ...s, [key]: val }));

  return (
    <div style={{ padding:24, background:'#f5f3ff', minHeight:'100vh', maxWidth:760 }}>
      <div style={{ marginBottom:20 }}>
        <h2 style={{ margin:0, color:'#4c1d95', fontSize:22 }}>⚙️ L&D Settings</h2>
        <p style={{ margin:0, color:'#6b7280', fontSize:13 }}>Configure training categories, defaults, notifications and policy rules</p>
      </div>

      {/* Training Categories */}
      <Section title="Training Categories" icon="📁">
        <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:12 }}>
          {settings.training_categories.map(cat => (
            <span key={cat} style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 12px', background:'#e9e4ff', color:'#6B3FDB', borderRadius:20, fontWeight:600, fontSize:12 }}>
              {cat}
              <button onClick={() => removeCategory(cat)} style={{ background:'none', border:'none', cursor:'pointer', color:'#6B3FDB', fontSize:14, lineHeight:1, padding:0 }}>✕</button>
            </span>
          ))}
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <input value={catInput} onChange={e => setCatInput(e.target.value)} onKeyDown={e => e.key==='Enter' && (e.preventDefault(), addCategory())}
            style={{ ...inputStyle, flex:1 }} placeholder="Add new category…" />
          <button onClick={addCategory} style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:7, padding:'8px 16px', cursor:'pointer', fontWeight:600 }}>Add</button>
        </div>
      </Section>

      {/* Score & Attempt Defaults */}
      <Section title="Assessment Defaults" icon="📝">
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Default Pass Score (%)</label>
            <input type="number" value={settings.default_pass_score} onChange={e => set('default_pass_score', parseInt(e.target.value)||70)} style={inputStyle} min={0} max={100} />
          </div>
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Max Concurrent Enrollments</label>
            <input type="number" value={settings.max_concurrent_enrollments} onChange={e => set('max_concurrent_enrollments', parseInt(e.target.value)||5)} style={inputStyle} min={1} />
          </div>
        </div>
      </Section>

      {/* Reminders & Deadlines */}
      <Section title="Reminders & Deadlines" icon="⏰">
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:16 }}>
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Remind Before Training (days)</label>
            <input type="number" value={settings.reminder_days_before} onChange={e => set('reminder_days_before', parseInt(e.target.value)||7)} style={inputStyle} min={1} />
          </div>
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Cert Expiry Reminder (days)</label>
            <input type="number" value={settings.cert_expiry_reminder_days} onChange={e => set('cert_expiry_reminder_days', parseInt(e.target.value)||30)} style={inputStyle} min={1} />
          </div>
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Mandatory Training Frequency (days)</label>
            <input type="number" value={settings.mandatory_training_freq_days} onChange={e => set('mandatory_training_freq_days', parseInt(e.target.value)||365)} style={inputStyle} min={1} />
          </div>
        </div>
      </Section>

      {/* Feedback Policy */}
      <Section title="Feedback Policy" icon="⭐">
        <Toggle
          label="Feedback Required on Completion"
          description="Employees must leave feedback when marking a training complete"
          checked={settings.feedback_required}
          onChange={() => set('feedback_required', !settings.feedback_required)}
        />
        {settings.feedback_required && (
          <div style={{ marginTop:12 }}>
            <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Minimum Feedback Characters</label>
            <input type="number" value={settings.min_feedback_chars} onChange={e => set('min_feedback_chars', parseInt(e.target.value)||10)} style={{ ...inputStyle, maxWidth:160 }} min={0} />
          </div>
        )}
      </Section>

      {/* Enrollment Policy */}
      <Section title="Enrollment Policy" icon="📋">
        <Toggle
          label="Allow Self-Enrollment"
          description="Employees can enroll in available programs themselves"
          checked={settings.allow_self_enrollment}
          onChange={() => set('allow_self_enrollment', !settings.allow_self_enrollment)}
        />
      </Section>

      {/* Notifications */}
      <Section title="Notifications" icon="🔔">
        <Toggle
          label="Email Notifications"
          description="Send email reminders for upcoming trainings and cert expiries"
          checked={settings.enable_email_notifications}
          onChange={() => set('enable_email_notifications', !settings.enable_email_notifications)}
        />
        <Toggle
          label="Manager Notifications"
          description="Notify managers when their team has overdue or expiring items"
          checked={settings.enable_manager_notifications}
          onChange={() => set('enable_manager_notifications', !settings.enable_manager_notifications)}
        />
      </Section>

      <div style={{ display:'flex', gap:12, alignItems:'center' }}>
        <button onClick={save} disabled={loading} style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'10px 28px', cursor:'pointer', fontWeight:700, fontSize:15 }}>
          {loading ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && <span style={{ color:'#16a34a', fontWeight:600, fontSize:13 }}>✅ Saved successfully</span>}
      </div>
    </div>
  );
}
