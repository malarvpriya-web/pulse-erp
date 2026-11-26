/**
 * travelUi.jsx — the small pieces every Travel Desk page shares (26 Nov 26):
 * a centred dialog, labelled fields, one status badge for every status the
 * module writes, a "give a reason" dialog for rejects / cancels / returns,
 * and pickers over the real customer / project / ticket / opportunity / trip
 * records (GET /travel/lookups/:kind) — these replaced free-text boxes that
 * never linked a trip or claim to anything.
 */
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import api from '@/services/api/client';
import MasterSelect from '@/components/core/MasterSelect';

export const inputStyle = {
  width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8,
  fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fff',
};
export const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 };
export const sectionStyle = { fontSize: 12, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '4px 0 12px' };
export const th = { padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 12 };
export const td = { padding: '10px 14px', color: '#374151', verticalAlign: 'top' };
export const btn = (kind = 'secondary') => ({
  padding: kind === 'small' ? '4px 10px' : '9px 18px', borderRadius: 8, cursor: 'pointer',
  fontSize: kind === 'small' ? 11 : 13, fontWeight: 600,
  ...(kind === 'primary' ? { background: '#6B3FDB', color: '#fff', border: 'none' }
    : kind === 'danger' ? { background: '#fff', color: '#b91c1c', border: '1px solid #fecaca' }
    : kind === 'success' ? { background: '#16a34a', color: '#fff', border: 'none' }
    : kind === 'small' ? { background: '#f5f3ff', color: '#6B3FDB', border: 'none' }
    : { background: '#fff', color: '#374151', border: '1px solid #e5e7eb' }),
});

const TONES = {
  grey:   { bg: '#f3f4f6', color: '#374151' },
  purple: { bg: '#ede9fe', color: '#5b21b6' },
  blue:   { bg: '#dbeafe', color: '#1e40af' },
  green:  { bg: '#d1fae5', color: '#065f46' },
  red:    { bg: '#fee2e2', color: '#991b1b' },
  amber:  { bg: '#fef3c7', color: '#92400e' },
};
const STATUS_TONE = {
  Draft: 'grey', Pending: 'purple', Submitted: 'blue', Approved: 'green', Rejected: 'red', Cancelled: 'grey',
  'Pending Manager': 'blue', 'Pending Finance': 'purple', 'Finance Rejected': 'red', Disbursed: 'green',
  'Partially Settled': 'amber', Settled: 'grey',
  'Manager Approved': 'blue', 'Manager Rejected': 'red', 'Accounts Verified': 'blue', 'Accounts Rejected': 'red',
  'Mgmt Approved': 'purple', 'Mgmt Rejected': 'red', Paid: 'green', Closed: 'grey',
  Confirmed: 'green', Returned: 'amber', Completed: 'green',
};
export function StatusBadge({ status }) {
  const t = TONES[STATUS_TONE[status] || 'grey'];
  return (
    <span style={{ background: t.bg, color: t.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {status || '—'}
    </span>
  );
}

export function Dialog({ title, subtitle, width = 640, onClose, children, footer }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div role="dialog" aria-modal="true" aria-label={title}
           style={{ background: '#fff', width, maxWidth: '100%', maxHeight: 'calc(100vh - 48px)', borderRadius: 14, display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '20px 24px 12px', borderBottom: '1px solid #f3f4f6' }}>
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>{title}</h2>
            {subtitle && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{subtitle}</div>}
          </div>
          <button aria-label="Close" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
        </div>
        <div style={{ padding: '16px 24px', overflowY: 'auto', flex: 1 }}>{children}</div>
        {footer && <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 24px', borderTop: '1px solid #f3f4f6', flexWrap: 'wrap' }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, required, children, full, hint }) {
  return (
    <div style={full ? { gridColumn: '1/-1' } : undefined}>
      <label style={labelStyle}>{label}{required && ' *'}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export const grid2 = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 };

export function ErrorBox({ children }) {
  if (!children) return null;
  return <div role="alert" style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>{children}</div>;
}

/** Detail grid of label/value pairs; empty values are skipped. */
export function Facts({ items }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, fontSize: 13 }}>
      {items.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
        <div key={k}>
          <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>{k}</div>
          <div style={{ fontWeight: 500, color: '#1f2937', wordBreak: 'break-word' }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * "Give a reason" dialog for reject / cancel / send-back. The reason is
 * required (the server refuses an empty one) unless `optional`.
 */
export function ReasonDialog({ title, label = 'Reason', confirmLabel = 'Confirm', danger = true, optional = false, onCancel, onConfirm }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    if (!optional && !text.trim()) { setErr('Please write a reason'); return; }
    setBusy(true); setErr('');
    try { await onConfirm(text.trim()); }
    catch (e) { setErr(e?.response?.data?.error || e?.message || 'Action failed'); setBusy(false); }
  };
  return (
    <Dialog title={title} width={460} onClose={onCancel} footer={<>
      <button style={btn()} onClick={onCancel} disabled={busy}>Back</button>
      <button style={btn(danger ? 'danger' : 'primary')} onClick={go} disabled={busy}>{busy ? 'Saving…' : confirmLabel}</button>
    </>}>
      <ErrorBox>{err}</ErrorBox>
      <label style={labelStyle}>{label}{!optional && ' *'}</label>
      <textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} style={{ ...inputStyle, resize: 'vertical' }} />
    </Dialog>
  );
}

/**
 * A picker over one of the travel lookups. `kind` is customers | projects |
 * tickets | opportunities | employees | trips; `forWhat` narrows trips
 * (claim | advance | booking | visit). onRows hands the loaded rows back so a
 * page can read the chosen trip's details.
 */
export function LookupSelect({ kind, forWhat, value, onChange, onRows, placeholder, disabled, ariaLabel }) {
  const endpoint = `/travel/lookups/${kind}${kind === 'trips' && forWhat ? `?for=${forWhat}` : ''}`;
  return (
    <MasterSelect
      endpoint={endpoint}
      label={{ customers: 'Customer', projects: 'Project', tickets: 'Service ticket', opportunities: 'Opportunity', employees: 'Employee', trips: 'Trip' }[kind]}
      value={value ?? ''}
      onChange={(v) => onChange(v === '' || v == null ? '' : v)}
      onListChange={onRows}
      optionValue="id"
      optionLabel={(r) => r.name}
      allowAdd={false}
      searchable
      disabled={disabled}
      placeholder={placeholder || '— None —'}
      selectStyle={inputStyle}
      ariaLabel={ariaLabel}
    />
  );
}

export const apiError = (e, fallback = 'Something went wrong') => e?.response?.data?.error || e?.message || fallback;

/**
 * Hand a decision to another employee (trip, advance's manager step, claim's
 * manager step). Searches the same delegate list the Approval Center uses;
 * `onPick(employeeId)` performs the delegate call.
 */
export function DelegateDialog({ title = 'Delegate this approval', onCancel, onPick }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState([]);
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.get('/approvals/delegates', { params: { q } })
        .then(r => { if (live) setList(Array.isArray(r.data) ? r.data : []); })
        .catch(() => { if (live) setList([]); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const go = async () => {
    if (!pick) { setErr('Choose who should decide'); return; }
    setBusy(true); setErr('');
    try { await onPick(pick.id, pick.name); }
    catch (e) { setErr(apiError(e, 'Could not delegate')); setBusy(false); }
  };
  return (
    <Dialog title={title} width={460} onClose={onCancel} footer={<>
      <button style={btn()} onClick={onCancel} disabled={busy}>Back</button>
      <button style={btn('primary')} onClick={go} disabled={busy || !pick}>{busy ? 'Saving…' : `Delegate${pick ? ' to ' + pick.name : ''}`}</button>
    </>}>
      <ErrorBox>{err}</ErrorBox>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search a colleague by name" style={inputStyle} aria-label="Search colleague" />
      <div style={{ maxHeight: 240, overflowY: 'auto', marginTop: 10, border: '1px solid #f0f0f4', borderRadius: 8 }}>
        {list.length === 0 && <div style={{ padding: 14, fontSize: 12, color: '#9ca3af' }}>No matches</div>}
        {list.map(p => (
          <button key={p.id} onClick={() => setPick(p)}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', borderBottom: '1px solid #f9fafb', cursor: 'pointer', fontSize: 13,
              background: pick?.id === p.id ? '#f5f3ff' : '#fff', color: '#1f2937' }}>
            {p.name}{p.department && <span style={{ color: '#9ca3af', fontSize: 11 }}> · {p.department}</span>}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
