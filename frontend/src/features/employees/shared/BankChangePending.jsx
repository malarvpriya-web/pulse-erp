// frontend/src/features/employees/shared/BankChangePending.jsx
//
// The bank-detail change waiting for a second HR person, shown on the
// employee's own Edit page (§266 — replaces the separate HR → Bank Detail
// Approvals page; the same requests are also in the Approval Center).
//   employee_bank:edit, not the person who entered it   Approve / Reject (reason)
//   the person who entered it (or a reviewer)            Withdraw
// A super admin may approve their own entry (§261); the server decides.
// After an approval the form's bank fields are set to the approved values, so
// a later Save does not send the old account back as a "change".
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { fmtDate } from '@/utils/dateFormatter';
import { openEmployeeFile } from './employeeFiles';

const FIELDS = [['account_holder_name', 'Account-holder name'], ['account_number', 'Account number'], ['ifsc_code', 'IFSC'], ['bank_name', 'Bank'], ['branch_name', 'Branch']];
// A propose-only viewer gets 'attached' instead of the path (no access to the file).
const openable = (v) => !!v && v !== 'attached';
const btn = (bg, fg = '#fff') => ({ padding: '6px 12px', background: bg, color: fg, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 });

export default function BankChangePending({ employeeId, onApproved, onMessage, onPendingChange }) {
  const { hasPermission } = useAuth();
  const allowed = typeof hasPermission === 'function'
    && (hasPermission('employee_bank', 'edit') || hasPermission('employee_bank', 'add'));
  const [req, setReq] = useState(null);
  const [reason, setReason] = useState(null);     // null = reject box closed
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!allowed || !employeeId) return;
    try {
      const { data } = await api.get('/employees/bank-change-requests', { params: { status: 'pending', employee_id: employeeId } });
      const found = Array.isArray(data) && data.length ? data[0] : null;
      setReq(found); onPendingChange?.(!!found);
    } catch { setReq(null); onPendingChange?.(false); }
  }, [allowed, employeeId, onPendingChange]);
  useEffect(() => { load(); }, [load]);

  if (!req) return null;

  const act = async (action, body) => {
    setBusy(true);
    try {
      await api.post(`/employees/bank-change-requests/${req.id}/${action}`, body || {});
      if (action === 'approve') {
        onApproved?.({
          account_number: req.proposed_account_number, ifsc_code: req.proposed_ifsc_code,
          bank_name: req.proposed_bank_name, branch_name: req.proposed_branch_name,
          account_holder_name: req.proposed_account_holder_name, source: req.source,
        });
        onMessage?.('ok', req.source === 'verify'
          ? 'Bank details verified. Accounts has been notified.'
          : 'Bank details approved and saved on the record. Accounts has been notified.');
      } else {
        onMessage?.('ok', action === 'reject' ? 'Bank-detail change rejected — the record is unchanged.' : 'Bank-detail change withdrawn — the record is unchanged.');
      }
      setReq(null); setReason(null); onPendingChange?.(false);
    } catch (err) {
      onMessage?.('error', err.response?.data?.error || 'The decision was not saved');
    } finally { setBusy(false); }
  };

  return (
    <div data-testid="bank-change-pending" style={{ gridColumn: '1/-1', border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 10, padding: 12 }}>
      <div style={{ fontWeight: 700, color: '#92400e', fontSize: 13 }}>
        {req.source === 'verify' ? 'Verification waiting for a second HR person' : 'Bank-detail change waiting for a second HR person'}
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
        Entered by {req.requested_by_name || 'unknown'} on {fmtDate(req.requested_at)}. Salary keeps going to the account on record until it is approved.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
        <thead><tr style={{ textAlign: 'left' }}>
          {['', 'On record', 'Proposed'].map(h => <th key={h} style={{ padding: '4px 8px', color: '#92400e' }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {FIELDS.map(([k, label]) => {
            const changed = (req.fields_changed || []).includes(k);
            return (
              <tr key={k} style={{ fontWeight: changed ? 700 : 400 }}>
                <td style={{ padding: '4px 8px' }}>{label}{changed ? ' •' : ''}</td>
                <td style={{ padding: '4px 8px', fontFamily: k === 'account_number' ? 'monospace' : 'inherit' }}>{req[`current_${k}`] || '—'}</td>
                <td style={{ padding: '4px 8px', fontFamily: k === 'account_number' ? 'monospace' : 'inherit' }}>{req[`proposed_${k}`] || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {req.holder_name_matches === false && (
        <div role="alert" style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>
          The name on the account does not match the employee&apos;s name. Check the proof before approving.
        </div>
      )}
      {!String(req.proposed_account_holder_name || '').trim() && (
        <div style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>No account-holder name recorded.</div>
      )}
      <div style={{ fontSize: 12, marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>Proof:</span>
        {!req.proof_cheque_file && !req.proof_statement_file && <span style={{ color: '#b45309' }}>none attached</span>}
        {[['proof_cheque_file', 'Cancelled cheque'], ['proof_statement_file', 'Bank statement']].map(([k, label]) => (
          req[k] ? (openable(req[k])
            ? <button key={k} type="button" style={btn('#ede9fe', '#6B3FDB')}
                onClick={() => openEmployeeFile(req[k]).catch(() => onMessage?.('error', `The ${label.toLowerCase()} could not be opened`))}>Open {label.toLowerCase()}</button>
            : <span key={k}>{label} attached</span>) : null
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {req.can_decide && <button type="button" onClick={() => act('approve')} disabled={busy} style={btn('#16a34a')}>Approve</button>}
        {req.can_decide && reason === null && <button type="button" onClick={() => setReason('')} disabled={busy} style={btn('#dc2626')}>Reject</button>}
        {req.can_withdraw && !req.can_decide && <button type="button" onClick={() => act('withdraw')} disabled={busy} style={btn('#f3f4f6', '#374151')}>Withdraw</button>}
        {!req.can_decide && <span style={{ fontSize: 12, color: '#6b7280' }}>Entered by you — another HR person approves it here or in the Approval Center.</span>}
      </div>
      {reason !== null && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <label htmlFor={`bank-reject-${req.id}`} style={{ fontSize: 12, fontWeight: 600, alignSelf: 'center' }}>Reason *</label>
          <input id={`bank-reject-${req.id}`} value={reason} maxLength={500} onChange={e => setReason(e.target.value)}
            style={{ flex: '1 1 220px', padding: '6px 10px', borderRadius: 7, border: '1px solid #fecaca' }} />
          <button type="button" onClick={() => act('reject', { reason: reason.trim() })} disabled={busy || !reason.trim()} style={btn('#dc2626')}>Confirm rejection</button>
          <button type="button" onClick={() => setReason(null)} style={btn('#fff', '#374151')}>Cancel</button>
        </div>
      )}
    </div>
  );
}
