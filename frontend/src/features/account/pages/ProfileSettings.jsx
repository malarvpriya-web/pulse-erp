import { useState, useEffect, useCallback } from 'react';
import { User, Shield, Bell, Globe, Eye, EyeOff, Check, AlertCircle } from 'lucide-react';
import ModuleSettingsShell, {
  SectionCard, Row, SaveBar, Toggle, inputStyle,
} from '@/features/_shared/ModuleSettingsShell';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';

const SECTIONS = [
  { id: 'account',       label: 'Account',       icon: User,   color: '#6B3FDB' },
  { id: 'security',      label: 'Security',      icon: Shield, color: '#dc2626' },
  { id: 'notifications', label: 'Notifications', icon: Bell,   color: '#d97706' },
  { id: 'preferences',   label: 'Preferences',   icon: Globe,  color: '#0369a1' },
];

const TIMEZONES = [
  'Asia/Kolkata', 'UTC', 'America/New_York', 'America/Chicago',
  'America/Denver', 'America/Los_Angeles', 'Europe/London',
  'Europe/Paris', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Shanghai',
  'Asia/Singapore', 'Australia/Sydney', 'Pacific/Auckland',
];

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ta', label: 'Tamil' },
  { value: 'te', label: 'Telugu' },
  { value: 'mr', label: 'Marathi' },
];

const NOTIF_TYPES = [
  { key: 'email_leave',       label: 'Leave approvals',       desc: 'Email when a leave request is approved or rejected' },
  { key: 'email_payslip',     label: 'Payslip available',     desc: 'Email when your payslip is generated' },
  { key: 'email_attendance',  label: 'Attendance alerts',     desc: 'Email for late check-ins and missed punches' },
  { key: 'inapp_approvals',   label: 'In-app approvals',      desc: 'Bell notification for pending approvals' },
  { key: 'inapp_mentions',    label: 'In-app mentions',       desc: 'Bell notification when someone mentions you' },
  { key: 'inapp_tasks',       label: 'Task assignments',      desc: 'Bell notification when a task is assigned to you' },
];

function Alert({ type, msg }) {
  if (!msg) return null;
  const isErr = type === 'error';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
      borderRadius: 8, marginBottom: 16, fontSize: 13,
      background: isErr ? '#fef2f2' : '#f0fdf4',
      color: isErr ? '#b91c1c' : '#15803d',
      border: `1px solid ${isErr ? '#fecaca' : '#bbf7d0'}`,
    }}>
      {isErr ? <AlertCircle size={15} /> : <Check size={15} />}
      {msg}
    </div>
  );
}

// ── Account section ────────────────────────────────────────────────────────────
function AccountSection({ profile, onRefresh }) {
  const { updateUser } = useAuth();
  const [name, setName]   = useState('');
  const [saved, setSaved] = useState(false);
  const [msg, setMsg]     = useState({ type: '', text: '' });

  useEffect(() => { setName(profile?.name ?? ''); }, [profile]);

  const save = async () => {
    if (!name.trim()) return;
    try {
      const res = await api.put('/auth/profile', { name });
      // Push the new name into AuthContext so the topbar/avatar update immediately
      // instead of continuing to show the login id.
      updateUser({ name: res.data?.user?.name ?? name.trim() });
      setSaved(true);
      setMsg({ type: 'success', text: 'Display name updated.' });
      onRefresh();
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setMsg({ type: 'error', text: err.response?.data?.error || 'Failed to save.' });
    }
  };

  const displayName = profile?.name || profile?.email?.split('@')[0] || 'User';
  const initials    = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <SectionCard icon={User} color="#6B3FDB" label="Account">
      <Alert type={msg.type} msg={msg.text} />

      {/* Avatar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24, padding: '16px 0', borderBottom: '1px solid #f0f0f4' }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%', flexShrink: 0,
          background: 'linear-gradient(135deg, #6B3FDB, #5B35D5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, fontWeight: 700, color: '#fff', letterSpacing: 1,
        }}>
          {initials}
        </div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 16, color: '#111827' }}>{displayName}</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{profile?.email}</div>
          {profile?.role && (
            <div style={{
              display: 'inline-block', marginTop: 4, fontSize: 11, fontWeight: 600,
              background: '#f5f3ff', color: '#6B3FDB', borderRadius: 4, padding: '2px 8px',
            }}>
              {profile.role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
            </div>
          )}
        </div>
      </div>

      {/* Editable name */}
      <Row label="Display name" desc="Shown in the topbar and across the app">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          style={{ ...inputStyle, width: 220 }}
          placeholder="Your full name"
        />
      </Row>

      {/* Read-only fields */}
      <Row label="Email address" desc="Contact your admin to change your email">
        <span style={{ fontSize: 13, color: '#6b7280' }}>{profile?.email || '—'}</span>
      </Row>
      <Row label="Department" desc="">
        <span style={{ fontSize: 13, color: '#6b7280' }}>{profile?.department || '—'}</span>
      </Row>
      {profile?.last_login && (
        <Row label="Last sign-in" desc="">
          <span style={{ fontSize: 13, color: '#6b7280' }}>
            {new Date(profile.last_login).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        </Row>
      )}

      <SaveBar onSave={save} saved={saved} color="#6B3FDB" />
    </SectionCard>
  );
}

// ── Security section ───────────────────────────────────────────────────────────
function SecuritySection() {
  const [form, setForm]     = useState({ current: '', next: '', confirm: '' });
  const [show, setShow]     = useState({ current: false, next: false, confirm: false });
  const [saved, setSaved]   = useState(false);
  const [msg, setMsg]       = useState({ type: '', text: '' });

  const toggle = field => setShow(s => ({ ...s, [field]: !s[field] }));

  const save = async () => {
    setMsg({ type: '', text: '' });
    if (!form.current || !form.next || !form.confirm) {
      return setMsg({ type: 'error', text: 'All fields are required.' });
    }
    if (form.next.length < 8) {
      return setMsg({ type: 'error', text: 'New password must be at least 8 characters.' });
    }
    if (form.next !== form.confirm) {
      return setMsg({ type: 'error', text: 'New passwords do not match.' });
    }
    try {
      await api.put('/auth/profile/password', {
        current_password: form.current,
        new_password: form.next,
      });
      setSaved(true);
      setMsg({ type: 'success', text: 'Password changed successfully.' });
      setForm({ current: '', next: '', confirm: '' });
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setMsg({ type: 'error', text: err.response?.data?.error || 'Failed to change password.' });
    }
  };

  const PasswordInput = ({ field, label, desc }) => (
    <Row label={label} desc={desc}>
      <div style={{ position: 'relative', width: 220 }}>
        <input
          type={show[field] ? 'text' : 'password'}
          value={form[field]}
          onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
          style={{ ...inputStyle, width: '100%', paddingRight: 32 }}
          placeholder="••••••••"
          autoComplete={field === 'current' ? 'current-password' : 'new-password'}
        />
        <button
          onClick={() => toggle(field)}
          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0 }}
          type="button"
        >
          {show[field] ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </Row>
  );

  return (
    <SectionCard icon={Shield} color="#dc2626" label="Security">
      <Alert type={msg.type} msg={msg.text} />
      <PasswordInput field="current" label="Current password"  desc="Your existing password" />
      <PasswordInput field="next"    label="New password"      desc="At least 8 characters" />
      <PasswordInput field="confirm" label="Confirm new password" desc="Re-enter new password" />
      <SaveBar onSave={save} saved={saved} color="#dc2626" />
    </SectionCard>
  );
}

// ── Notifications section ──────────────────────────────────────────────────────
function NotificationsSection({ profile, onRefresh }) {
  const defaults = NOTIF_TYPES.reduce((acc, t) => ({ ...acc, [t.key]: true }), {});
  const [prefs, setPrefs] = useState(defaults);
  const [saved, setSaved] = useState(false);
  const [msg, setMsg]     = useState({ type: '', text: '' });

  useEffect(() => {
    if (profile?.preferences?.notifications) {
      setPrefs(p => ({ ...p, ...profile.preferences.notifications }));
    }
  }, [profile]);

  const save = async () => {
    try {
      await api.put('/auth/profile', { preferences: { notifications: prefs } });
      setSaved(true);
      setMsg({ type: 'success', text: 'Notification preferences saved.' });
      onRefresh();
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setMsg({ type: 'error', text: err.response?.data?.error || 'Failed to save.' });
    }
  };

  return (
    <SectionCard icon={Bell} color="#d97706" label="Notifications">
      <Alert type={msg.type} msg={msg.text} />
      {NOTIF_TYPES.map(t => (
        <Row key={t.key} label={t.label} desc={t.desc}>
          <Toggle
            checked={prefs[t.key] ?? true}
            onChange={v => setPrefs(p => ({ ...p, [t.key]: v }))}
            color="#d97706"
          />
        </Row>
      ))}
      <SaveBar onSave={save} saved={saved} color="#d97706" />
    </SectionCard>
  );
}

// ── Preferences section ────────────────────────────────────────────────────────
function PreferencesSection({ profile, onRefresh }) {
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [language, setLanguage] = useState('en');
  const [saved, setSaved]       = useState(false);
  const [msg, setMsg]           = useState({ type: '', text: '' });

  useEffect(() => {
    if (profile?.preferences) {
      if (profile.preferences.timezone) setTimezone(profile.preferences.timezone);
      if (profile.preferences.language) setLanguage(profile.preferences.language);
    }
  }, [profile]);

  const save = async () => {
    try {
      await api.put('/auth/profile', { preferences: { timezone, language } });
      setSaved(true);
      setMsg({ type: 'success', text: 'Preferences saved.' });
      onRefresh();
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setMsg({ type: 'error', text: err.response?.data?.error || 'Failed to save.' });
    }
  };

  return (
    <SectionCard icon={Globe} color="#0369a1" label="Preferences">
      <Alert type={msg.type} msg={msg.text} />
      <Row label="Timezone" desc="Used for displaying times and scheduling">
        <select
          value={timezone}
          onChange={e => setTimezone(e.target.value)}
          style={{ ...inputStyle, width: 220 }}
        >
          {TIMEZONES.map(tz => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </select>
      </Row>
      <Row label="Language" desc="Interface display language">
        <select
          value={language}
          onChange={e => setLanguage(e.target.value)}
          style={{ ...inputStyle, width: 220 }}
        >
          {LANGUAGES.map(l => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
      </Row>
      <SaveBar onSave={save} saved={saved} color="#0369a1" />
    </SectionCard>
  );
}

// ── Page root ──────────────────────────────────────────────────────────────────
export default function ProfileSettings() {
  const { user } = useAuth();
  const [activeSection, setActiveSection] = useState('account');
  const [profile, setProfile] = useState(null);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await api.get('/auth/profile');
      setProfile(res.data.user);
    } catch {
      // fall back to auth context data
      setProfile(user);
    }
  }, [user]);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  return (
    <ModuleSettingsShell
      title="Profile Settings"
      subtitle="Manage your account, security, and preferences"
      icon={User}
      color="#6B3FDB"
      sections={SECTIONS}
      activeSection={activeSection}
      onSectionChange={setActiveSection}
    >
      {activeSection === 'account'       && <AccountSection       profile={profile} onRefresh={fetchProfile} />}
      {activeSection === 'security'      && <SecuritySection />}
      {activeSection === 'notifications' && <NotificationsSection profile={profile} onRefresh={fetchProfile} />}
      {activeSection === 'preferences'   && <PreferencesSection   profile={profile} onRefresh={fetchProfile} />}
    </ModuleSettingsShell>
  );
}
