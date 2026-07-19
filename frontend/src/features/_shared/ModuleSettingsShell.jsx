import React from 'react';
import { ToggleLeft, ToggleRight, ChevronRight, Check } from 'lucide-react';

export function Toggle({ checked, onChange, color = '#7c3aed' }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
    >
      {checked
        ? <ToggleRight size={28} color={color} />
        : <ToggleLeft  size={28} color="#d1d5db" />}
    </button>
  );
}

export function SectionCard({ icon: Icon, color, label, children }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 }}>
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

export function Row({ label, desc, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #f9f9f9' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: '#1f2937' }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{desc}</div>}
      </div>
      <div style={{ flexShrink: 0, marginLeft: 20 }}>{children}</div>
    </div>
  );
}

export function LinkRow({ label, desc, onClick, color = '#7c3aed' }) {
  return (
    <button
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderTop: 'none', borderLeft: 'none', borderRight: 'none', borderBottom: '1px solid #f9f9f9', background: 'none', width: '100%', cursor: 'pointer', textAlign: 'left' }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: '#1f2937' }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{desc}</div>}
      </div>
      <ChevronRight size={16} color={color} />
    </button>
  );
}

export function SaveBar({ onSave, saved, color = '#7c3aed' }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20, paddingTop: 16, borderTop: '1px solid #f0f0f4' }}>
      <button
        onClick={onSave}
        style={{ background: saved ? '#16a34a' : color, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 22px', fontWeight: 600, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, transition: 'background 0.2s' }}
      >
        {saved && <Check size={15} />}
        {saved ? 'Saved' : 'Save Changes'}
      </button>
    </div>
  );
}

const INPUT = { border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px', fontSize: 13, background: '#fff' };
export const inputStyle = INPUT;
export const selectStyle = { ...INPUT };

export default function ModuleSettingsShell({ title, subtitle, icon: TitleIcon, color = '#7c3aed', sections, activeSection, onSectionChange, children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#f8f9fb', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f4', padding: '20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        {TitleIcon && (
          <div style={{ width: 42, height: 42, borderRadius: 10, background: `${color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <TitleIcon size={20} color={color} />
          </div>
        )}
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111827' }}>{title}</h1>
          {subtitle && <p style={{ margin: 0, fontSize: 13, color: '#6b7280', marginTop: 2 }}>{subtitle}</p>}
        </div>
      </div>

      <div style={{ display: 'flex', minHeight: 'calc(100vh - 82px)' }}>
        <aside style={{ width: 232, background: '#fff', borderRight: '1px solid #f0f0f4', padding: '16px 0', flexShrink: 0 }}>
          {sections.map(s => {
            const Icon = s.icon;
            const active = activeSection === s.id;
            return (
              <button
                key={s.id}
                onClick={() => onSectionChange(s.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 18px', border: 'none', background: active ? `${s.color}10` : 'transparent', cursor: 'pointer', borderLeft: `3px solid ${active ? s.color : 'transparent'}`, transition: 'all 0.15s' }}
              >
                <div style={{ width: 28, height: 28, borderRadius: 6, background: active ? `${s.color}20` : '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon size={14} color={active ? s.color : '#9ca3af'} />
                </div>
                <span style={{ fontSize: 13, fontWeight: active ? 600 : 400, color: active ? s.color : '#374151', textAlign: 'left' }}>{s.label}</span>
              </button>
            );
          })}
        </aside>

        <main style={{ flex: 1, padding: '28px 32px', overflowY: 'auto' }}>
          <div style={{ maxWidth: 720 }}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
