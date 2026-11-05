// frontend/src/features/hr/pages/BankChangeApprovals.jsx
//
// HR → Bank Detail Approvals (§204) — the checker side of the bank-detail
// maker-checker. New or changed bank details entered on Add / Edit Employee
// wait here until a DIFFERENT HR person approves them; only then do they reach
// the employee record and is Accounts notified.
//   employee_bank:view   open the page, see full numbers
//   employee_bank:edit   approve / reject (reason required) — never one's own entry
//   the person who entered a change may withdraw it
//   employee_bank:add only (propose-only, §206): sees ONLY its own requests,
//   numbers masked, no decisions — the server filters, this page just says so
import { useState, useEffect, useCallback } from 'react';
import { Landmark } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell, EmptyState } from '@/components/pulse-ui';
import { fmtDate } from '@/utils/dateFormatter';

const STATUSES = [['pending', 'Awaiting approval'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn'], ['all', 'All']];
const FIELDS = [['account_number', 'Account number'], ['ifsc_code', 'IFSC'], ['bank_name', 'Bank'], ['branch_name', 'Branch']];
const btn = (bg, fg = '#fff') => ({ padding: '6px 12px', background: bg, color: fg, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 });

export default function BankChangeApprovals() {
  const { hasPermission } = useAuth();
  const reviewer = hasPermission('employee_bank', 'edit');
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [rejecting, setRejecting] = useState(null);   // { id, reason }
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/employees/bank-change-requests', { params: { status } });
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setRows([]);
      setError(err.response?.data?.error || 'Could not load bank-detail changes');
    } finally { setLoading(false); }
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const act = async (row, action, body) => {
    setBusy(row.id); setMsg(null);
    try {
      await api.post(`/employees/bank-change-requests/${row.id}/${action}`, body || {});
      setMsg({ type: 'ok', text: action === 'approve'
        ? `${row.employee_name}: bank details approved and saved. Accounts has been notified.`
        : `${row.employee_name}: change ${action === 'reject' ? 'rejected' : 'withdrawn'} — the employee record is unchanged.` });
      setRejecting(null);
      load();
    } catch (err) {
      setMsg({ type: 'error', text: err.response?.data?.error || 'The decision was not saved' });
    } finally { setBusy(null); }
  };

  return (
    <PageShell dock={
      <PageHero icon={Landmark} eyebrow="Human Resources" title="Bank Detail Approvals"
        subtitle="New and changed employee bank details take effect only after a second HR person approves them." />
    }>
      <div role="tablist" aria-label="Status" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 16 }}>
        {STATUSES.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={status === k} onClick={() => setStatus(k)}
            style={{ ...btn(status === k ? '#6B3FDB' : '#ede9fe', status === k ? '#fff' : '#6B3FDB'), padding: '8px 14px' }}>{l}</button>
        ))}
      </div>

      {!reviewer && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          You see only the bank-detail requests you entered. Another HR person approves them.
        </div>
      )}

      {msg && <div role="status" style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a' }}>{msg.text}</div>}

      {loading ? <div style={{ color: '#6b7280', fontSize: 13 }}>Loading…</div>
        : error ? <EmptyState title="Bank-detail changes could not be loaded" subtitle={error} action={<button onClick={load} style={btn('#6B3FDB')}>Retry</button>} />
        : rows.length === 0 ? <EmptyState icon={Landmark} title="Nothing here" subtitle={status === 'pending' ? 'No bank-detail change is waiting for approval.' : 'No changes with this status.'} />
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {rows.map(r => (
              <div key={r.id} data-testid="bcr-row" style={{ border: '1px solid #e9e4ff', borderRadius: 10, padding: 14, background: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{r.employee_name} <span style={{ color: '#6b7280', fontWeight: 400 }}>· {r.employee_code}</span></div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                      {r.source === 'create' ? 'New employee' : r.source === 'verify' ? 'Verification of the details on record (no change)' : 'Change'} requested by {r.requested_by_name || 'unknown'} on {fmtDate(r.requested_at)}
                      {r.status !== 'pending' && ` · ${r.status} by ${r.decided_by_name || 'unknown'} on ${fmtDate(r.decided_at)}`}
                    </div>
                    {r.decision_reason && <div style={{ fontSize: 12, color: '#dc2626' }}>Reason: {r.decision_reason}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'start', flexWrap: 'wrap' }}>
                    {r.can_decide && <button onClick={() => act(r, 'approve')} disabled={busy === r.id} style={btn('#16a34a')}>Approve</button>}
                    {r.can_decide && <button onClick={() => setRejecting({ id: r.id, reason: '' })} disabled={busy === r.id} style={btn('#dc2626')}>Reject</button>}
                    {r.can_withdraw && !r.can_decide && <button onClick={() => act(r, 'withdraw')} disabled={busy === r.id} style={btn('#f3f4f6', '#374151')}>Withdraw</button>}
                    {r.status === 'pending' && !r.can_decide && <span style={{ fontSize: 11, color: '#6b7280' }}>Entered by you — another HR person approves</span>}
                  </div>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 10 }}>
                  <thead><tr style={{ background: '#f5f3ff', textAlign: 'left' }}>
                    {['', 'On record', 'Proposed'].map(h => <th key={h} style={{ padding: '6px 10px', color: '#4c1d95' }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {FIELDS.map(([k, label]) => {
                      const changed = (r.fields_changed || []).includes(k);
                      return (
                        <tr key={k} style={{ borderTop: '1px solid #f0ebff', fontWeight: changed ? 700 : 400 }}>
                          <td style={{ padding: '6px 10px' }}>{label}{changed ? ' •' : ''}</td>
                          <td style={{ padding: '6px 10px', fontFamily: k === 'account_number' ? 'monospace' : 'inherit' }}>{r[`current_${k}`] || '—'}</td>
                          <td style={{ padding: '6px 10px', fontFamily: k === 'account_number' ? 'monospace' : 'inherit' }}>{r[`proposed_${k}`] || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {r.status === 'pending' && !r.bank_verified_at && r.current_account_number && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>The details on record were entered before approvals began and have not been verified.</div>
                )}
                {rejecting?.id === r.id && (
                  <div style={{ marginTop: 10, padding: 10, background: '#fef2f2', borderRadius: 8 }}>
                    <label htmlFor={`bcr-reason-${r.id}`} style={{ fontSize: 12, fontWeight: 600 }}>Reason for rejection *</label>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                      <input id={`bcr-reason-${r.id}`} value={rejecting.reason} onChange={e => setRejecting({ id: r.id, reason: e.target.value })}
                        style={{ flex: '1 1 240px', padding: '7px 10px', borderRadius: 7, border: '1px solid #fecaca' }} />
                      <button onClick={() => act(r, 'reject', { reason: rejecting.reason.trim() })} disabled={!rejecting.reason.trim() || busy === r.id} style={btn('#dc2626')}>Confirm rejection</button>
                      <button onClick={() => setRejecting(null)} style={btn('#fff', '#374151')}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </PageShell>
  );
}
