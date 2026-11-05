// Gate Passes tab — create, filter, approve / cancel / complete, print one pass.
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { S, fmtStamp, errText, esc, printDocument } from './biometricShared';
import { Field, Pager, EmptyRow, EmployeeSelect } from './biometricUi';

// Effective status, as GET /gate-passes computes it (stored status + the clock).
const GATE_STATUS = {
  pending:   { label: 'Pending',   color: '#6d28d9' },
  approved:  { label: 'Approved (not started)', color: '#2563eb' },
  active:    { label: 'Active',    color: '#16a34a' },
  expired:   { label: 'Expired',   color: '#6b7280' },
  completed: { label: 'Completed', color: '#0f766e' },
  cancelled: { label: 'Cancelled', color: '#dc2626' },
};

// Who a pending pass waits for — the server's rule (shared/gatePassApprover.js).
const APPROVER_LABEL = { department_head: 'Department head', reporting_manager: 'Reporting manager', hr: 'HR' };

const EMPTY_FORM = { kind: 'employee', employee_id: '', visitor_name: '', purpose: '', valid_from: '', valid_to: '' };
const EMPTY_FILTERS = { q: '', status: '', employee_id: '', from: '', to: '' };

/** datetime-local ('YYYY-MM-DDTHH:mm', no zone) → ISO with the browser's offset. */
const toIso = (local) => (local ? new Date(local).toISOString() : '');

/** Client-side mirror of validateGatePass, so the common mistakes never round-trip. */
function formProblems(f) {
  const out = [];
  if (f.kind === 'employee' && !f.employee_id) out.push('Choose the employee this pass is for.');
  if (f.kind === 'visitor' && !f.visitor_name.trim()) out.push('Enter the visitor’s name.');
  const from = f.valid_from ? new Date(f.valid_from) : null;
  const to = f.valid_to ? new Date(f.valid_to) : null;
  if (from && to && to <= from) out.push('Valid To must be after Valid From.');
  else if (to && to <= new Date()) out.push('Valid To is already in the past.');
  return out;
}

function printPass(gp) {
  const st = GATE_STATUS[gp.effective_status] || { label: gp.effective_status };
  const live = ['active', 'approved'].includes(gp.effective_status);
  const who = gp.employee_name
    ? `${gp.employee_name}${gp.emp_code ? ` (${gp.emp_code})` : ''}`
    : gp.visitor_name || '—';
  const row = (k, v) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
  return printDocument(`Gate Pass ${gp.pass_number}`, `
    <div class="card">
      <h1>Gate Pass ${esc(gp.pass_number)}</h1>
      <div class="sub">Issued ${esc(fmtStamp(gp.approved_at || gp.created_at))}</div>
      <table>
        ${row('Issued to', who)}
        ${gp.employee_name && gp.visitor_name ? row('Note', gp.visitor_name) : ''}
        ${gp.department ? row('Department', gp.department) : ''}
        ${row('Reason', gp.purpose || '—')}
        ${row('Valid from', gp.valid_from ? fmtStamp(gp.valid_from) : 'Open')}
        ${row('Valid to', gp.valid_to ? fmtStamp(gp.valid_to) : 'Open')}
        ${row('Approved by', gp.approved_by_name || '—')}
      </table>
      <span class="stamp ${live ? 'ok' : 'bad'}">${esc(st.label.toUpperCase())}</span>
      <div class="sign"><span>Security</span><span>Authorised signatory</span></div>
    </div>`);
}

export default function GatePassesTab({ employees, flash, canWrite, onDataChanged }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], total: 0, page_size: 25, counts: {} });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState({});
  const [cancelFor, setCancelFor] = useState(null);
  const [cancelReason, setCancelReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, page_size: 25 };
      for (const [k, v] of Object.entries(filters)) if (v !== '') params[k] = v;
      const res = await api.get('/gate-passes', { params });
      setData(res.data?.rows ? res.data : { rows: [], total: 0, page_size: 25, counts: {} });
      setLoadError('');
    } catch (err) {
      setData({ rows: [], total: 0, page_size: 25, counts: {} });
      setLoadError(errText(err, 'Could not load gate passes'));
    } finally { setLoading(false); }
  }, [filters, page]);
  useEffect(() => { load(); }, [load]);

  const setFilter = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const clearFilters = () => { setFilters(EMPTY_FILTERS); setPage(1); };
  const filtered = Object.values(filters).some((v) => v !== '');

  const closeForm = () => { setShowForm(false); setForm(EMPTY_FORM); setFormErrors([]); };

  const submit = async (e) => {
    e.preventDefault();
    const problems = formProblems(form);
    setFormErrors(problems);
    if (problems.length) return;
    setSaving(true);
    try {
      await api.post('/gate-passes', {
        employee_id: form.kind === 'employee' ? form.employee_id : '',
        visitor_name: form.kind === 'visitor' ? form.visitor_name.trim() : '',
        purpose: form.purpose.trim(),
        valid_from: toIso(form.valid_from),
        valid_to: toIso(form.valid_to),
      });
      flash('Gate pass created — pending approval');
      closeForm(); load(); onDataChanged();
    } catch (err) {
      setFormErrors(err.response?.data?.errors || [errText(err, 'Could not create the gate pass')]);
    } finally { setSaving(false); }
  };

  const transition = async (gp, verb, body = {}, done) => {
    setBusy((b) => ({ ...b, [gp.id]: true }));
    try {
      await api.put(`/gate-passes/${gp.id}/${verb}`, body);
      flash(done);
      load(); onDataChanged();
      return true;
    } catch (err) {
      flash(errText(err, `Could not ${verb} the pass`), 'error');
      load();
      return false;
    } finally { setBusy((b) => ({ ...b, [gp.id]: false })); }
  };

  const confirmCancel = async () => {
    if (!cancelReason.trim()) return;
    const ok = await transition(cancelFor, 'cancel', { reason: cancelReason.trim() }, `Gate pass cancelled`);
    if (ok) { setCancelFor(null); setCancelReason(''); }
  };

  const counts = data.counts || {};

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0, color: '#4c1d95' }}>Gate Pass Management</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            {['pending', 'active', 'approved', 'expired', 'completed', 'cancelled'].filter((s) => counts[s]).map((s) => `${counts[s]} ${GATE_STATUS[s].label.split(' ')[0].toLowerCase()}`).join(' · ') || 'No passes yet'}
          </p>
        </div>
        {canWrite && (
          <button type="button" onClick={() => (showForm ? closeForm() : setShowForm(true))} style={S.primary}>
            {showForm ? '✕ Cancel' : '+ New Gate Pass'}
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={submit} noValidate data-testid="gate-form" style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid #e9e4ff' }}>
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 13 }}>
            {[['employee', 'Employee'], ['visitor', 'Visitor / non-employee']].map(([k, l]) => (
              <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                <input type="radio" name="gp-kind" checked={form.kind === k} onChange={() => setForm((f) => ({ ...f, kind: k }))} /> {l}
              </label>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12 }}>
            {form.kind === 'employee' ? (
              <div>
                <label style={S.label} htmlFor="gp-employee">Employee *</label>
                <EmployeeSelect id="gp-employee" employees={employees} value={form.employee_id} onChange={(v) => setForm((f) => ({ ...f, employee_id: v }))} />
              </div>
            ) : (
              <div>
                <label style={S.label} htmlFor="gp-visitor">Visitor name *</label>
                <input id="gp-visitor" maxLength={200} value={form.visitor_name} onChange={(e) => setForm((f) => ({ ...f, visitor_name: e.target.value }))} style={S.input} />
              </div>
            )}
            <div>
              <label style={S.label} htmlFor="gp-reason">Reason</label>
              <input id="gp-reason" maxLength={1000} value={form.purpose} onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))} style={S.input} />
            </div>
            <div>
              <label style={S.label} htmlFor="gp-from">Valid From</label>
              <input id="gp-from" type="datetime-local" value={form.valid_from} onChange={(e) => setForm((f) => ({ ...f, valid_from: e.target.value }))} style={S.input} />
            </div>
            <div>
              <label style={S.label} htmlFor="gp-to">Valid To</label>
              <input id="gp-to" type="datetime-local" min={form.valid_from || undefined} value={form.valid_to} onChange={(e) => setForm((f) => ({ ...f, valid_to: e.target.value }))} style={S.input} />
            </div>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: '#6b7280' }}>Leave both dates empty for an open-ended pass.</p>
          {formErrors.length > 0 && (
            <ul role="alert" style={{ margin: '10px 0 0', paddingLeft: 18, color: '#b91c1c', fontSize: 13 }}>
              {formErrors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button type="submit" disabled={saving} style={{ ...S.primary, opacity: saving ? 0.6 : 1 }}>{saving ? 'Creating…' : 'Create Gate Pass'}</button>
            <button type="button" onClick={closeForm} style={S.secondary}>Cancel</button>
          </div>
        </form>
      )}

      <div style={S.filterBar} data-testid="gate-filters">
        <Field label="Search" width={200}><input type="search" placeholder="Pass no., name, reason" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} style={S.input} /></Field>
        <Field label="Status" width={170}>
          <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} style={S.input} aria-label="Status">
            <option value="">All statuses</option>
            {Object.entries(GATE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}{counts[k] != null ? ` (${counts[k]})` : ''}</option>)}
          </select>
        </Field>
        <Field label="Employee" width={180}><EmployeeSelect employees={employees} value={filters.employee_id} onChange={(v) => setFilter('employee_id', v)} placeholder="All employees" /></Field>
        <Field label="Valid between" width={140}><input type="date" aria-label="From date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter('from', e.target.value)} style={S.input} /></Field>
        <Field label="and" width={140}><input type="date" aria-label="To date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} style={S.input} /></Field>
        <button type="button" onClick={clearFilters} disabled={!filtered} style={{ ...S.secondary, padding: '7px 12px', opacity: filtered ? 1 : 0.5 }}>Clear filters</button>
      </div>
      {loadError && <div role="alert" style={{ color: '#b91c1c', fontSize: 13, marginBottom: 8 }}>{loadError}</div>}

      <div style={{ overflowX: 'auto', opacity: loading ? 0.6 : 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }} data-testid="gate-table">
          <thead><tr style={{ background: '#f5f3ff' }}>
            {['Pass No.', 'Issued to', 'Reason', 'Valid From', 'Valid To', 'Status', 'Action'].map((h) => <th key={h} style={S.th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {data.rows.length === 0 && !loading && <EmptyRow cols={7} filtered={filtered} onClear={clearFilters} what="gate passes" />}
            {data.rows.map((gp) => {
              const st = GATE_STATUS[gp.effective_status] || { label: gp.effective_status, color: '#6b7280' };
              const s = gp.effective_status;
              return (
                <tr key={gp.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                  <td style={{ ...S.td, fontWeight: 700, color: '#6B3FDB', whiteSpace: 'nowrap' }}>{gp.pass_number || '—'}</td>
                  <td style={S.td}>
                    <div style={{ fontWeight: 600 }}>{gp.employee_name || gp.visitor_name || '—'}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>
                      {gp.employee_name ? [gp.emp_code, gp.visitor_name].filter(Boolean).join(' · ') : 'Visitor'}
                    </div>
                  </td>
                  <td style={{ ...S.td, color: '#6b7280', fontSize: 12 }}>
                    {gp.purpose || '—'}
                    {s === 'cancelled' && gp.cancel_reason && <div style={{ color: '#dc2626' }}>Cancelled: {gp.cancel_reason}</div>}
                  </td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap', fontSize: 12 }}>{gp.valid_from ? fmtStamp(gp.valid_from) : 'Open'}</td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap', fontSize: 12 }}>{gp.valid_to ? fmtStamp(gp.valid_to) : 'Open'}</td>
                  <td style={S.td}>
                    <span style={S.pill(st.color)}>{st.label}</span>
                    {s === 'completed' && gp.completed_at && <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtStamp(gp.completed_at)}</div>}
                    {s === 'pending' && (
                      <div style={{ fontSize: 11, color: '#6b7280' }} data-testid={`awaiting-${gp.id}`}>
                        Awaiting {gp.approver_kind === 'hr' ? 'HR' : `${gp.approver_name} (${APPROVER_LABEL[gp.approver_kind] || 'approver'})`}
                      </div>
                    )}
                  </td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    {gp.can_approve && (
                      <button type="button" disabled={busy[gp.id]} onClick={() => transition(gp, 'approve', {}, `Gate pass approved`)} style={S.small('#16a34a')}>Approve</button>
                    )}
                    {canWrite && ['active', 'expired'].includes(s) && ['approved', 'active'].includes(gp.status) && (
                      <button type="button" disabled={busy[gp.id]} onClick={() => transition(gp, 'complete', {}, 'Gate pass marked completed')} style={S.small('#0f766e')}>Mark returned</button>
                    )}
                    {gp.can_cancel && (
                      <button type="button" disabled={busy[gp.id]} onClick={() => { setCancelFor(gp); setCancelReason(''); }} style={S.small('#fee2e2', '#b91c1c')}>Cancel</button>
                    )}
                    {gp.pass_number && s !== 'cancelled' && (
                      <button type="button" onClick={() => { if (!printPass(gp)) flash('The print window was blocked by the browser. Allow pop-ups for Pulse and try again.', 'error'); }}
                        style={S.small('#e9e4ff', '#6B3FDB')}>Print</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager page={data.page || page} pageSize={data.page_size || 25} total={data.total} onPage={setPage} />

      {cancelFor && (
        <div role="dialog" aria-modal="true" aria-label="Cancel gate pass" style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, width: '100%', maxWidth: 420 }}>
            <h4 style={{ margin: '0 0 8px', color: '#4c1d95' }}>Cancel {cancelFor.pass_number || 'gate pass'}?</h4>
            <label style={S.label} htmlFor="gp-cancel-reason">Reason *</label>
            <textarea id="gp-cancel-reason" rows={3} maxLength={500} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} style={{ ...S.input, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" onClick={() => setCancelFor(null)} style={S.secondary}>Keep pass</button>
              <button type="button" disabled={!cancelReason.trim() || busy[cancelFor.id]} onClick={confirmCancel} style={{ ...S.primary, background: '#dc2626', opacity: cancelReason.trim() ? 1 : 0.5 }}>Cancel pass</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
