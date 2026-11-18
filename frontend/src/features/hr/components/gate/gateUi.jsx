// Small UI pieces shared by the gate-pass and visitor lists.
import { useState, useEffect, useRef, useCallback } from 'react';
import { S, fmtStamp } from '../biometric/biometricShared';
import { EVENT_LABEL } from './gateShared';

/** A centred dialog. Escape and the backdrop close it unless `busy`. */
export function Modal({ title, onClose, children, width = 520, busy = false, footer }) {
  const box = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    box.current?.querySelector('input,select,textarea,button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 2000, padding: '5vh 16px', overflowY: 'auto' }}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={title}
        style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: width, boxShadow: '0 20px 50px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #f0ebff' }}>
          <h4 style={{ margin: 0, color: '#4c1d95', fontSize: 16 }}>{title}</h4>
          <button type="button" aria-label="Close" onClick={onClose} disabled={busy}
            style={{ border: 'none', background: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
        {footer && <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '12px 18px', borderTop: '1px solid #f0ebff' }}>{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Ask for a reason (cancel, reject, close…). `optional` turns the field into a
 * note. `extra` renders above the reason (e.g. a vehicle number field).
 */
export function ReasonDialog({ title, label = 'Reason *', confirmText, danger = true, optional = false, onConfirm, onClose, intro, extra }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = optional || text.trim().length > 0;
  const go = async () => {
    if (!ok) return;
    setBusy(true); setError('');
    const err = await onConfirm(text.trim());
    setBusy(false);
    if (err) setError(err);
  };
  return (
    <Modal title={title} onClose={onClose} busy={busy} width={440} footer={(
      <>
        <button type="button" onClick={onClose} disabled={busy} style={S.secondary}>Back</button>
        <button type="button" onClick={go} disabled={!ok || busy}
          style={{ ...S.primary, background: danger ? '#dc2626' : '#6B3FDB', opacity: ok && !busy ? 1 : 0.5 }}>{busy ? 'Saving…' : confirmText}</button>
      </>
    )}>
      {intro && <p style={{ margin: '0 0 12px', fontSize: 13, color: '#4b5563' }}>{intro}</p>}
      {extra}
      <label style={S.label} htmlFor="reason-text">{label}</label>
      <textarea id="reason-text" rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} style={{ ...S.input, resize: 'vertical' }} />
      {error && <div role="alert" style={{ color: '#b91c1c', fontSize: 13, marginTop: 8 }}>{error}</div>}
    </Modal>
  );
}

/** The history panel: who did what, when. */
export function EventList({ events }) {
  if (!events?.length) return <div style={{ fontSize: 13, color: '#6b7280' }}>No history yet.</div>;
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="history">
      {events.map((ev) => (
        <li key={ev.id} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid #f5f3ff', fontSize: 13 }}>
          <span style={{ whiteSpace: 'nowrap', color: '#6b7280', minWidth: 120 }}>{fmtStamp(ev.created_at)}</span>
          <span>
            <strong>{EVENT_LABEL[ev.action] || ev.action}</strong>
            {ev.actor_name && <span style={{ color: '#6b7280' }}> · {ev.actor_name}</span>}
            {ev.note && <div style={{ color: '#4b5563' }}>{ev.note}</div>}
            {ev.data?.fields?.length > 0 && <div style={{ color: '#6b7280', fontSize: 12 }}>Changed: {ev.data.fields.join(', ').replaceAll('_', ' ')}</div>}
            {ev.data?.items?.length > 0 && (
              <div style={{ color: '#6b7280', fontSize: 12 }}>{ev.data.items.map((i) => `${i.description} × ${i.quantity} ${i.unit}`).join('; ')}</div>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** label / value rows in a detail view. */
export function Facts({ rows }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 36%) 1fr', gap: '6px 12px', margin: 0, fontSize: 13 }}>
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ color: '#6b7280' }}>{k}</dt>
          <dd style={{ margin: 0, color: '#1f2937', wordBreak: 'break-word' }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A KPI tile for the register's summary row. */
export function Tile({ label, value, color, hint, onClick, active }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick}
      style={{ textAlign: 'left', background: active ? '#f5f3ff' : '#fff', border: `1px solid ${active ? '#6B3FDB' : '#e9e4ff'}`, borderRadius: 10, padding: '12px 14px', cursor: onClick ? 'pointer' : 'default', font: 'inherit' }}>
      <div style={{ fontSize: 22, fontWeight: 800, color }}>{value ?? '—'}</div>
      <div style={{ fontSize: 12, color: '#4b5563', marginTop: 2 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{hint}</div>}
    </Tag>
  );
}

/** The page tab look shared by the gate pages. */
export function tabStyle(active) {
  return { padding: '8px 20px', border: 'none', cursor: 'pointer', borderRadius: '6px 6px 0 0', fontWeight: 600, fontSize: 14, background: active ? '#6B3FDB' : '#e9e4ff', color: active ? '#fff' : '#6B3FDB' };
}

/** A transient success / error banner: [flash(text, type), bannerElement]. */
export function useFlash() {
  const [msg, setMsg] = useState({ text: '', type: '' });
  const flash = useCallback((text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg((m) => (m.text === text ? { text: '', type: '' } : m)), 6000);
  }, []);
  const banner = msg.text ? (
    <div role={msg.type === 'error' ? 'alert' : 'status'} style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14, background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a', border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{msg.text}</div>
  ) : null;
  return [flash, banner];
}

