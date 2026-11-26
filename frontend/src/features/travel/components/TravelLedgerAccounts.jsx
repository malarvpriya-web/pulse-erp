import { useState, useEffect, useCallback } from 'react';
import { BookOpen } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import { Field, ErrorBox, inputStyle, btn, apiError } from './travelUi';

/**
 * Travel ledger accounts — the accounts travel money posts to (26 Nov 26).
 *
 * Paying a claim and paying out / refunding an advance post journal entries
 * (backend travelGl.service.js). Which accounts is Finance's decision, so
 * nothing posts — and payment is refused — until Finance saves them here.
 * Shown at the top of Travel Audit; read-only for anyone but Finance / admin.
 */
const ROLES = [
  { key: 'travel_expense_account_code', label: 'Travel expense', type: 'Expense', required: true, hint: 'Claims are charged here (e.g. Travelling & Conveyance)' },
  { key: 'advance_receivable_account_code', label: 'Employee advances', type: 'Asset', required: true, hint: 'Advances paid out sit here until claims or a refund settle them' },
  { key: 'payment_account_code', label: 'Paid from (bank / cash)', type: 'Asset', required: true, hint: 'The bank or cash account Finance pays from' },
  { key: 'gst_input_account_code', label: 'Input GST', type: 'Asset', required: false, hint: 'Optional — verified GST on bills; without it GST is part of the travel cost' },
];

export default function LedgerAccounts() {
  const toast = useToast();
  const [m, setM] = useState(null);
  const [codes, setCodes] = useState({});
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.get('/travel-audit/gl-mapping').then(r => { setM(r.data); setCodes(r.data.codes || {}); }).catch(() => setM(null));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!m) return null;

  const save = async () => {
    setSaving(true); setErr('');
    try { await api.put('/travel-audit/gl-mapping', codes); toast.success('Travel ledger accounts saved'); setEditing(false); load(); }
    catch (e) { setErr([apiError(e), ...(e?.response?.data?.problems || [])].join(' — ')); }
    finally { setSaving(false); }
  };
  const ok = m.status === 'approved';
  const chart = Array.isArray(m.chart_accounts) ? m.chart_accounts : [];
  const nameOf = (code) => chart.find(a => a.code === code)?.name || '';

  return (
    <div style={{ background: '#fff', border: `1px solid ${ok ? '#f0f0f4' : '#fecaca'}`, borderRadius: 12, padding: '14px 18px', marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <BookOpen size={18} color={ok ? '#6B3FDB' : '#b91c1c'} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#1f2937' }}>Travel ledger accounts</div>
            <div style={{ fontSize: 12, color: ok ? '#6b7280' : '#b91c1c' }}>
              {ok ? `Claims and advances post to the books${m.approved_at ? ` · set ${fmtDate(m.approved_at)}` : ''}`
                : m.status === 'invalid' ? `Needs attention — ${(m.problems || []).join('; ')}. Paying claims and advances is blocked.`
                : 'Not set — paying claims and advances is blocked until Finance chooses these accounts.'}
            </div>
          </div>
        </div>
        {m.can_edit && !editing && <button style={btn(ok ? undefined : 'primary')} onClick={() => setEditing(true)}>{ok ? 'Change' : 'Choose accounts'}</button>}
      </div>

      {!editing && ok && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginTop: 12, fontSize: 12 }}>
          {ROLES.map(r => <div key={r.key}><span style={{ color: '#9ca3af' }}>{r.label}:</span> <b>{codes[r.key] ? `${codes[r.key]} ${nameOf(codes[r.key])}` : '—'}</b></div>)}
        </div>
      )}

      {editing && (
        <div style={{ marginTop: 14 }}>
          <ErrorBox>{err}</ErrorBox>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
            {ROLES.map(r => (
              <Field key={r.key} label={r.label} required={r.required} hint={r.hint}>
                <select value={codes[r.key] || ''} onChange={e => setCodes(c => ({ ...c, [r.key]: e.target.value }))} style={inputStyle} aria-label={r.label}>
                  <option value="">— {r.required ? 'Choose' : 'None'} —</option>
                  {chart.filter(a => a.account_type === r.type).map(a => (
                    <option key={a.code} value={a.code}>{a.code} — {a.name}</option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
            <button style={btn()} onClick={() => { setEditing(false); setCodes(m.codes || {}); setErr(''); }} disabled={saving}>Cancel</button>
            <button style={btn('primary')} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save accounts'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
