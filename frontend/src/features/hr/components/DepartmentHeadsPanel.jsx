import { Fragment, useState, useEffect, useCallback } from "react";
import { Users, History, ChevronDown, ChevronUp } from "lucide-react";
import api from "@/services/api/client";
import { useAuth } from "@/context/AuthContext";

/**
 * Department Heads — who reviews probations for each department, per company.
 *
 * Lives on HR → Exit & Probation → Probation; no menu entry of its own.
 * Reading needs `hr:view` and changing needs `hr:edit` — the server enforces
 * both (GET/PUT/DELETE /department-heads); this panel only hides the controls
 * a viewer could not use. Department heads hold no `hr` permission, so they
 * never reach this page at all.
 *
 * Reassigning or removing a head always asks for a reason; the server ends the
 * previous assignment with it and keeps the full history.
 */
export default function DepartmentHeadsPanel() {
  const { hasPermission } = useAuth();
  const canEdit = !!hasPermission?.('hr', 'edit');

  const [open, setOpen] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);       // { departmentId, mode: 'assign' | 'remove', headId, reason }
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [history, setHistory] = useState({});          // departmentId -> rows | 'loading' | { error }

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get('/department-heads');
      // A panel must never take the Probation page down with it: an
      // unexpected payload is shown as a load error, not rendered.
      if (!Array.isArray(d?.departments) || !Array.isArray(d?.eligible_heads)) {
        setData(null);
        setError('Could not load department heads.');
        return;
      }
      setData(d);
      setError(null);
    } catch (err) {
      setError(err?.response?.status === 403
        ? 'You do not have access to department heads.'
        : err?.response?.data?.error || 'Could not load department heads.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggleHistory = async (departmentId) => {
    if (history[departmentId]) {
      setHistory((h) => { const n = { ...h }; delete n[departmentId]; return n; });
      return;
    }
    setHistory((h) => ({ ...h, [departmentId]: 'loading' }));
    try {
      const { data: d } = await api.get(`/department-heads/${departmentId}/history`);
      setHistory((h) => ({ ...h, [departmentId]: d.history }));
    } catch (err) {
      setHistory((h) => ({ ...h, [departmentId]: { error: err?.response?.data?.error || 'Could not load history.' } }));
    }
  };

  const save = async (dept) => {
    const isRemove = editing.mode === 'remove';
    const needsReason = isRemove || (dept.head && String(dept.head.employee_id) !== String(editing.headId));
    if (!isRemove && !editing.headId) { setMessage({ type: 'error', text: 'Choose a head.' }); return; }
    if (needsReason && !editing.reason.trim()) {
      setMessage({ type: 'error', text: isRemove ? 'A reason is required to remove a head.' : 'A reason is required to change the head.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const { data: d } = isRemove
        ? await api.delete(`/department-heads/${dept.department_id}`, { data: { reason: editing.reason.trim() } })
        : await api.put(`/department-heads/${dept.department_id}`, {
          head_employee_id: Number(editing.headId),
          ...(editing.reason.trim() ? { reason: editing.reason.trim() } : {}),
        });
      setMessage({
        type: 'success',
        text: isRemove ? `Head removed from ${dept.department}.`
          : d?.changed === false ? 'No change — that person is already the head.'
          : `Head saved for ${dept.department}.`,
      });
      setEditing(null);
      setHistory((h) => { const n = { ...h }; delete n[dept.department_id]; return n; });
      await load();
    } catch (err) {
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Could not save.' });
    } finally {
      setSaving(false);
    }
  };

  const fmt = (ts) => (ts ? new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

  return (
    <section className="prob-dh" aria-label="Department heads">
      <button type="button" className="prob-dh-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Users size={14} /> Department Heads
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div className="prob-dh-body">
          <p className="prob-dh-help">
            The head of each department reviews its probations. Only current employees with an active Pulse login can be chosen.
          </p>
          {message && <div role={message.type === 'error' ? 'alert' : 'status'} className={`prob-dh-msg is-${message.type}`}>{message.text}</div>}
          {error ? (
            <div role="alert" className="prob-dh-msg is-error">{error}</div>
          ) : !data ? (
            <div className="prob-dh-help">Loading…</div>
          ) : (
            <table className="prob-dh-table">
              <thead>
                <tr><th>Department</th><th>Head</th><th>Since</th><th>Employees</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {data.departments.map((d) => {
                  const isEditing = editing?.departmentId === d.department_id;
                  const hist = history[d.department_id];
                  return (
                    <Fragment key={d.department_id}>
                      <tr data-department={d.department}>
                        <td>{d.department}</td>
                        <td>
                          {d.head ? (
                            <>
                              {d.head.name} <span className="prob-dh-muted">{d.head.office_id}</span>
                              {!d.head.is_current && <span className="prob-dh-flag">No longer active</span>}
                              {d.head.is_current && !d.head.has_login && <span className="prob-dh-flag">No login</span>}
                            </>
                          ) : <span className="prob-dh-muted">Not assigned</span>}
                        </td>
                        <td>{d.head ? fmt(d.head.assigned_at) : '—'}</td>
                        <td>{d.employee_count}</td>
                        <td className="prob-dh-actions">
                          <button type="button" className="prob-hist-action-btn" onClick={() => toggleHistory(d.department_id)}
                            aria-label={`History for ${d.department}`}>
                            <History size={12} /> History
                          </button>
                          {canEdit && !isEditing && (
                            <>
                              <button type="button" className="prob-hist-action-btn"
                                onClick={() => { setMessage(null); setEditing({ departmentId: d.department_id, mode: 'assign', headId: d.head ? String(d.head.employee_id) : '', reason: '' }); }}>
                                {d.head ? 'Change' : 'Assign'}
                              </button>
                              {d.head && (
                                <button type="button" className="prob-hist-action-btn"
                                  onClick={() => { setMessage(null); setEditing({ departmentId: d.department_id, mode: 'remove', headId: '', reason: '' }); }}>
                                  Remove
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                      {isEditing && (
                        <tr className="prob-dh-edit">
                          <td colSpan={5}>
                            {editing.mode === 'assign' && (
                              <label>
                                Head
                                <select aria-label={`Head for ${d.department}`} value={editing.headId}
                                  onChange={(e) => setEditing((x) => ({ ...x, headId: e.target.value }))}>
                                  <option value="">— Choose an employee —</option>
                                  {data.eligible_heads.map((e) => (
                                    <option key={e.employee_id} value={String(e.employee_id)}>
                                      {e.name}{e.office_id ? ` (${e.office_id})` : ''}{e.department ? ` — ${e.department}` : ''}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                            <label>
                              Reason{(editing.mode === 'remove' || d.head) ? ' (required)' : ' (optional)'}
                              <input type="text" aria-label={`Reason for ${d.department}`} value={editing.reason} maxLength={500}
                                onChange={(e) => setEditing((x) => ({ ...x, reason: e.target.value }))} />
                            </label>
                            <button type="button" className="prob-modal-send" disabled={saving} onClick={() => save(d)}>
                              {saving ? 'Saving…' : editing.mode === 'remove' ? 'Remove head' : 'Save'}
                            </button>
                            <button type="button" className="prob-modal-cancel" onClick={() => setEditing(null)}>Cancel</button>
                          </td>
                        </tr>
                      )}
                      {hist && (
                        <tr className="prob-dh-history">
                          <td colSpan={5}>
                            {hist === 'loading' ? 'Loading history…'
                              : hist.error ? <span role="alert">{hist.error}</span>
                              : hist.length === 0 ? 'No heads have been assigned yet.'
                              : (
                                <ul aria-label={`Assignment history for ${d.department}`}>
                                  {hist.map((h) => (
                                    <li key={h.assignment_id}>
                                      <strong>{h.head_name}</strong> — from {fmt(h.assigned_at)}{h.assigned_by ? ` (by ${h.assigned_by})` : ''}
                                      {h.ended_at
                                        ? <> to {fmt(h.ended_at)}{h.ended_by ? ` (by ${h.ended_by})` : ''}{h.end_reason ? ` — ${h.end_reason}` : ''}</>
                                        : ' — current'}
                                    </li>
                                  ))}
                                </ul>
                              )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

