import { useState, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';
import {
  Settings2, Globe, Bell, Monitor,
  Check, Save, RefreshCw,
} from 'lucide-react';

const P  = '#6B3FDB';
const PL = '#f5f3ff';
const PB = '#e9e4ff';

const STORAGE_KEY = 'pulse_user_preferences';

const DEFAULTS = {
  language:           'en',
  timezone:           'Asia/Kolkata',
  date_format:        'DD/MM/YYYY',
  time_format:        '12h',
  currency_display:   'symbol',
  number_format:      'indian',
  notifications_inapp: true,
  notifications_email: false,
  notifications_sound: true,
  compact_sidebar:    false,
  rows_per_page:      25,
};

function loadPrefs(userId) {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}_${userId}`);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function savePrefs(userId, prefs) {
  try {
    localStorage.setItem(`${STORAGE_KEY}_${userId}`, JSON.stringify(prefs));
  } catch { /* quota exceeded — silently ignore */ }
}

// ── Row group ─────────────────────────────────────────────────────────────────
function Group({ title, icon: Icon, color = P, children }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12,
      overflow: 'hidden', marginBottom: 16,
    }}>
      <div style={{
        padding: '14px 20px', borderBottom: '1px solid #f9fafb',
        display: 'flex', alignItems: 'center', gap: 10,
        background: '#fafbff',
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: 7, background: PL,
          border: `1px solid ${PB}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={14} color={color} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>{title}</span>
      </div>
      <div style={{ padding: '4px 0' }}>{children}</div>
    </div>
  );
}

// ── Select row ────────────────────────────────────────────────────────────────
function SelectRow({ label, value, onChange, options }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 20px', borderBottom: '1px solid #f9fafb',
    }}>
      <span style={{ fontSize: 13, color: '#374151' }}>{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          padding: '6px 10px', borderRadius: 7, border: '1px solid #e2e8f0',
          fontSize: 12, color: '#1e293b', background: '#fff',
          outline: 'none', cursor: 'pointer', minWidth: 160,
          fontFamily: 'inherit',
        }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ── Toggle row ────────────────────────────────────────────────────────────────
function ToggleRow({ label, desc, checked, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 20px', borderBottom: '1px solid #f9fafb', gap: 12,
    }}>
      <div>
        <div style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{desc}</div>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        style={{
          width: 40, height: 22, borderRadius: 11, border: 'none',
          background: checked ? P : '#e2e8f0',
          cursor: 'pointer', position: 'relative', flexShrink: 0,
          transition: 'background 0.2s',
        }}
        role="switch"
        aria-checked={checked}
      >
        <div style={{
          width: 16, height: 16, borderRadius: '50%', background: '#fff',
          position: 'absolute', top: 3,
          left: checked ? 21 : 3,
          transition: 'left 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,.2)',
        }} />
      </button>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function UserPreferences() {
  const { user } = useAuth();
  const userId   = user?.id ?? 'guest';

  const [prefs,      setPrefs]      = useState(() => loadPrefs(userId));
  const [saved,      setSaved]      = useState(false);
  const [changed,    setChanged]    = useState(false);
  const [resetDone,  setResetDone]  = useState(false);

  // Fetch from backend on mount — silently updates over the localStorage cache.
  // localStorage provides instant paint; backend is authoritative for cross-device sync.
  useEffect(() => {
    let cancelled = false;
    api.get('/auth/preferences')
      .then(({ data }) => {
        if (cancelled) return;
        const merged = { ...DEFAULTS, ...(data.preferences ?? {}) };
        setPrefs(merged);
        savePrefs(userId, merged);   // refresh localStorage cache
      })
      .catch(() => { /* offline / unauthenticated — localStorage fallback already loaded */ });
    return () => { cancelled = true; };
  }, [userId]);

  const update = (key, val) => {
    setPrefs(prev => ({ ...prev, [key]: val }));
    setChanged(true);
    setSaved(false);
  };

  const handleSave = async () => {
    savePrefs(userId, prefs);   // localStorage first — instant
    setChanged(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    api.put('/auth/preferences', prefs).catch(() => {});  // backend sync (non-blocking)
  };

  const handleReset = () => {
    try { localStorage.removeItem(`${STORAGE_KEY}_${userId}`); } catch { /* ignore */ }
    setPrefs({ ...DEFAULTS });
    setChanged(false);
    setSaved(false);
    setResetDone(true);
    setTimeout(() => setResetDone(false), 2000);
    api.put('/auth/preferences', {}).catch(() => {});  // {} = "use defaults" on next load
  };

  return (
    <div style={{ minHeight: '100vh', background: '#f8f9fc', padding: '28px 32px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, background: PL,
            border: `1px solid ${PB}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Settings2 size={19} color={P} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#0f172a' }}>User Preferences</h1>
            <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
              Personal settings — stored locally on this device
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleReset}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8,
              border: resetDone ? '1px solid #10b981' : '1px solid #e2e8f0',
              background: resetDone ? '#f0fdf4' : '#fff',
              fontSize: 12, color: resetDone ? '#10b981' : '#64748b',
              cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s',
            }}
          >
            {resetDone ? <><Check size={13} /> Reset</> : <><RefreshCw size={13} /> Reset defaults</>}
          </button>
          <button
            onClick={handleSave}
            disabled={!changed}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', borderRadius: 8, border: 'none',
              background: saved ? '#10b981' : changed ? P : '#e2e8f0',
              color: changed || saved ? '#fff' : '#94a3b8',
              fontSize: 12, fontWeight: 600, cursor: changed ? 'pointer' : 'not-allowed',
              transition: 'background 0.2s', fontFamily: 'inherit',
            }}
          >
            {saved ? <><Check size={13} /> Saved</> : <><Save size={13} /> Save preferences</>}
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 680 }}>

        {/* Localization */}
        <Group title="Localization" icon={Globe}>
          <div style={{
            margin: '8px 20px 4px', padding: '8px 12px', borderRadius: 7,
            background: '#fffbeb', border: '1px solid #fde68a',
            fontSize: 11, color: '#92400e', lineHeight: 1.5,
          }}>
            Language, timezone &amp; display format preferences are saved here.
            App-wide date/currency formatters currently use India defaults (DD/MM/YYYY, ₹, Indian numbering)
            — per-user formatting will be applied globally in a future release.
          </div>
          <SelectRow
            label="Language"
            value={prefs?.language ?? 'en'}
            onChange={v => update('language', v)}
            options={[
              { value: 'en', label: 'English' },
              { value: 'hi', label: 'Hindi' },
              { value: 'ta', label: 'Tamil' },
              { value: 'te', label: 'Telugu' },
              { value: 'mr', label: 'Marathi' },
            ]}
          />
          <SelectRow
            label="Timezone"
            value={prefs?.timezone ?? 'Asia/Kolkata'}
            onChange={v => update('timezone', v)}
            options={[
              { value: 'Asia/Kolkata',   label: 'India (IST, UTC+5:30)' },
              { value: 'UTC',            label: 'UTC (Coordinated Universal Time)' },
              { value: 'Asia/Dubai',     label: 'Gulf (GST, UTC+4)' },
              { value: 'Asia/Singapore', label: 'Singapore (SGT, UTC+8)' },
              { value: 'America/New_York', label: 'Eastern (ET, UTC-5)' },
            ]}
          />
          <SelectRow
            label="Date format"
            value={prefs?.date_format ?? 'DD/MM/YYYY'}
            onChange={v => update('date_format', v)}
            options={[
              { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY (30/05/2026)' },
              { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (05/30/2026)' },
              { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (2026-05-30)' },
              { value: 'DD-MMM-YYYY', label: 'DD-MMM-YYYY (30-May-2026)' },
            ]}
          />
          <SelectRow
            label="Time format"
            value={prefs?.time_format ?? '12h'}
            onChange={v => update('time_format', v)}
            options={[
              { value: '12h', label: '12-hour (1:30 PM)' },
              { value: '24h', label: '24-hour (13:30)' },
            ]}
          />
          <SelectRow
            label="Number format"
            value={prefs?.number_format ?? 'indian'}
            onChange={v => update('number_format', v)}
            options={[
              { value: 'indian',      label: 'Indian (1,00,000)' },
              { value: 'international', label: 'International (100,000)' },
            ]}
          />
          <SelectRow
            label="Currency display"
            value={prefs?.currency_display ?? 'symbol'}
            onChange={v => update('currency_display', v)}
            options={[
              { value: 'symbol', label: '₹ Symbol' },
              { value: 'code',   label: 'INR Code' },
              { value: 'both',   label: '₹ INR (both)' },
            ]}
          />
        </Group>

        {/* Notifications */}
        <Group title="Notifications" icon={Bell}>
          <ToggleRow
            label="In-app notifications"
            desc="Show alerts inside Pulse ERP"
            checked={prefs?.notifications_inapp ?? true}
            onChange={v => update('notifications_inapp', v)}
          />
          <ToggleRow
            label="Email notifications"
            desc="Receive alerts via email"
            checked={prefs?.notifications_email ?? false}
            onChange={v => update('notifications_email', v)}
          />
          <ToggleRow
            label="Notification sounds"
            desc="Play sound for in-app alerts"
            checked={prefs?.notifications_sound ?? true}
            onChange={v => update('notifications_sound', v)}
          />
        </Group>

        {/* Display */}
        <Group title="Display" icon={Monitor}>
          <ToggleRow
            label="Compact sidebar"
            desc="Collapse sidebar by default on load"
            checked={prefs?.compact_sidebar ?? false}
            onChange={v => update('compact_sidebar', v)}
          />
          <SelectRow
            label="Table rows per page"
            value={String(prefs?.rows_per_page ?? 25)}
            onChange={v => update('rows_per_page', parseInt(v, 10))}
            options={[
              { value: '10',  label: '10 rows' },
              { value: '25',  label: '25 rows' },
              { value: '50',  label: '50 rows' },
              { value: '100', label: '100 rows' },
            ]}
          />
        </Group>

        {/* Storage note */}
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8, lineHeight: 1.6 }}>
          Preferences are saved to your account and sync across devices.
          A local copy is also cached in this browser for instant load.
        </div>
      </div>
    </div>
  );
}
