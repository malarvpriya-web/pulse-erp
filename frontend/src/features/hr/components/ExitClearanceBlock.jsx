// Exit Checklist → the clearance part of one leaver's checklist (owner decision
// 2026-11-17: "Exit clearance" and "Offboarding checklist" are ONE list).
//   Automatic checks  assets returned, travel advances, logins disabled —
//                     computed live by the server, never ticked by hand.
//                     "Disable logins" turns the leaver's Pulse logins off
//                     (PUT /exit/clearance access_revoked; withdrawing the
//                     exit turns them back on). It was only on Employee
//                     Profile's old 9-toggle card, removed 2026-11-17.
//   Sign-offs         HR, Finance, reporting manager (who signed is recorded)
// The company's own items are listed below this block by the Exit Checklist
// page. GET /exit/clearance/:id/status gives every blocker, including those
// items; the F&F payment is refused until all clear, and paying it closes the
// exit and moves the employee to Ex-Employees.
import { useCallback, useEffect, useState } from 'react';
import api from '@/services/api/client';

const AUTO = ['assets', 'travel_advances', 'it_access'];
const AUTO_LABEL = { assets: 'Company assets returned', travel_advances: 'Travel advances settled', it_access: 'Pulse logins disabled' };
const SIGNOFFS = [['noc_hr', 'hr', 'HR sign-off'], ['noc_finance', 'finance', 'Finance sign-off'], ['noc_manager', 'manager', 'Reporting manager sign-off']];

const box = { background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '12px 16px', marginBottom: 12 };
const row = { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 13 };
const pill = (ok) => ({ fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '2px 8px', background: ok ? '#dcfce7' : '#fee2e2', color: ok ? '#166534' : '#b91c1c' });

/** readOnly: show the checks and sign-offs without changing them (Employee Profile). */
export default function ExitClearanceBlock({ employee, onNotice, refreshKey = 0, readOnly = false }) {
  const id = employee?.id;
  const [status, setStatus] = useState(null);
  const [clearance, setClearance] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const [s, c] = await Promise.all([api.get(`/exit/clearance/${id}/status`), api.get(`/exit/clearance/${id}`)]);
      setStatus(s.data); setClearance(c.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'The clearance checks could not be loaded.');
    }
  }, [id]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const sign = async (field, value) => {
    if (saving) return;
    const before = clearance;
    setSaving(field);
    setClearance(c => ({ ...c, [field]: value }));
    try {
      await api.put(`/exit/clearance/${id}`, { ...before, [field]: value });
      await load();
    } catch (e) {
      setClearance(before);
      onNotice?.(e?.response?.data?.error || 'The sign-off was not saved.', 'error');
    } finally { setSaving(null); }
  };

  const disableLogins = async () => {
    if (saving) return;
    setSaving('access_revoked');
    try {
      await api.put(`/exit/clearance/${id}`, { ...clearance, access_revoked: true });
      onNotice?.('Pulse logins disabled.', 'success');
      await load();
    } catch (e) {
      onNotice?.(e?.response?.data?.error || 'The logins could not be disabled.', 'error');
    } finally { setSaving(null); }
  };

  if (error) return <div style={{ ...box, color: '#b91c1c' }} role="alert">{error} <button type="button" onClick={load} style={{ marginLeft: 8 }}>Retry</button></div>;
  if (!status || !clearance) return <div style={{ ...box, color: '#6b7280' }}>Loading clearance checks…</div>;
  const byKey = Object.fromEntries((status.blockers || []).map(b => [b.key, b]));
  const items = byKey.checklist;

  return (
    <div>
      <div style={box}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Automatic checks</div>
        {AUTO.map(k => (
          <div key={k} style={row}>
            <span style={pill(byKey[k]?.cleared)}>{byKey[k]?.cleared ? 'Done' : 'Open'}</span>
            <span style={{ flex: 1 }}>{AUTO_LABEL[k]}</span>
            {!byKey[k]?.cleared && byKey[k]?.detail?.length > 0 && <span style={{ fontSize: 11, color: '#6b7280' }}>{byKey[k].detail.join(', ')}</span>}
            {k === 'it_access' && !readOnly && !byKey[k]?.cleared && (
              <button type="button" className="pulse-btn-secondary" disabled={!!saving} onClick={disableLogins}
                style={{ fontSize: 12, padding: '3px 10px' }}>
                {saving === 'access_revoked' ? 'Disabling…' : 'Disable logins'}
              </button>
            )}
          </div>
        ))}
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
          Assets and advances follow the asset register and the travel advance ledger. Logins clear once disabled here or in User Management.
        </div>
      </div>
      <div style={box}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Sign-offs</div>
        {SIGNOFFS.map(([field, key, label]) => (
          <label key={field} style={{ ...row, cursor: readOnly ? 'default' : 'pointer' }}>
            <input type="checkbox" checked={!!clearance[field]} disabled={readOnly || saving === field}
              onChange={e => sign(field, e.target.checked)} style={{ width: 16, height: 16, accentColor: '#6B3FDB' }} />
            <span style={{ flex: 1 }}>{label}</span>
            <span style={pill(byKey[key]?.cleared)}>{byKey[key]?.cleared ? 'Signed' : 'Pending'}</span>
          </label>
        ))}
      </div>
      <div role="status" style={{ ...box, background: status.can_settle ? '#dcfce7' : '#ede9fe', color: status.can_settle ? '#166534' : '#5b21b6', fontSize: 13 }}>
        {status.can_settle
          ? 'Everything is clear. Paying the full & final settlement closes the exit and moves the employee to Ex-Employees.'
          : `Still open: ${(status.blockers || []).filter(b => !b.cleared).map(b => b.key === 'checklist' ? `${items.detail.length} checklist item(s)` : b.label).join(', ')}. The full & final settlement cannot be paid until these clear.`}
      </div>
    </div>
  );
}
