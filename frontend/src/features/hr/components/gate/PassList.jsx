// Gate passes — the register (mode 'register') or the caller's own (mode 'mine').
// Every button follows the per-row flags the server sends (can_edit,
// can_approve, can_mark_out, …), the same rules its routes enforce.
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { S, fmtStamp, errText } from '../biometric/biometricShared';
import { Field, Pager, EmptyRow, EmployeeSelect } from '../biometric/biometricUi';
import {
  PASS_STATUS, PASS_STATUS_ORDER, CATEGORIES, CATEGORY_LABEL, fmtQty, passTypeLabel, printPass, downloadCsv,
} from './gateShared';
import { Modal, ReasonDialog, EventList, Facts } from './gateUi';
import PassForm from './PassForm';

const EMPTY_FILTERS = { q: '', status: '', employee_id: '', category: '', from: '', to: '' };
const POPUP_BLOCKED = 'The print window was blocked by the browser. Allow pop-ups for Pulse and try again.';

/** Goods back through the gate, line by line. */
function ReturnDialog({ pass, items, onDone, onClose }) {
  const open = items.filter((it) => it.returned_quantity < it.quantity);
  const [qty, setQty] = useState(() => Object.fromEntries(open.map((it) => [it.id, ''])));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);
  const lines = open.map((it) => ({ item_id: it.id, quantity: Number(qty[it.id] || 0) })).filter((l) => l.quantity > 0);
  const allBack = () => setQty(Object.fromEntries(open.map((it) => [it.id, String(Math.round((it.quantity - it.returned_quantity) * 1000) / 1000)])));
  const save = async () => {
    setBusy(true); setErrors([]);
    try {
      const res = await api.put(`/gate-passes/${pass.id}/return`, { items: lines, note });
      onDone(res.data);
    } catch (err) { setErrors(err.response?.data?.errors || [errText(err, 'Could not record the return')]); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={`Record returned goods — ${pass.pass_number}`} onClose={onClose} busy={busy} width={620} footer={(
      <>
        <button type="button" onClick={onClose} disabled={busy} style={S.secondary}>Back</button>
        <button type="button" onClick={save} disabled={!lines.length || busy} style={{ ...S.primary, opacity: lines.length && !busy ? 1 : 0.5 }}>{busy ? 'Saving…' : 'Record return'}</button>
      </>
    )}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }} data-testid="return-table">
        <thead><tr style={{ background: '#f5f3ff' }}>{['Item', 'Out', 'Back', 'Still out', 'Returned now'].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
        <tbody>
          {open.map((it) => {
            const left = Math.round((it.quantity - it.returned_quantity) * 1000) / 1000;
            return (
              <tr key={it.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                <td style={S.td}>{it.description}</td>
                <td style={S.td}>{fmtQty(it.quantity)} {it.unit}</td>
                <td style={S.td}>{fmtQty(it.returned_quantity)}</td>
                <td style={S.td}>{fmtQty(left)}</td>
                <td style={{ ...S.td, width: 120 }}>
                  <input type="number" min="0" max={left} step="any" aria-label={`Returned now: ${it.description}`} value={qty[it.id]}
                    onChange={(e) => setQty((q) => ({ ...q, [it.id]: e.target.value }))} style={S.input} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" onClick={allBack} style={{ ...S.secondary, padding: '5px 12px', marginTop: 8 }}>Everything is back</button>
      <div style={{ marginTop: 12 }}>
        <label style={S.label} htmlFor="ret-note">Note</label>
        <input id="ret-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} style={S.input} placeholder="Optional, e.g. condition on return" />
      </div>
      {errors.length > 0 && <ul role="alert" style={{ margin: '10px 0 0', paddingLeft: 18, color: '#b91c1c', fontSize: 13 }}>{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
    </Modal>
  );
}

/** One pass: details, goods, history. */
function PassDetail({ id, onClose, onAction }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.get(`/gate-passes/${id}`).then((r) => { if (live) setD(r.data); }).catch((err) => { if (live) setError(errText(err, 'Could not load the pass')); });
    return () => { live = false; };
  }, [id]);
  const material = d?.pass_type === 'material';
  return (
    <Modal title={d ? `${material ? 'Material pass' : 'Gate pass'} ${d.pass_number}` : 'Gate pass'} onClose={onClose} width={720}>
      {error && <div role="alert" style={{ color: '#b91c1c' }}>{error}</div>}
      {!d && !error && <div style={{ color: '#6b7280' }}>Loading…</div>}
      {d && (
        <>
          <div style={{ marginBottom: 12 }}>
            <span style={S.pill((PASS_STATUS[d.effective_status] || {}).color || '#6b7280')}>{(PASS_STATUS[d.effective_status] || {}).label || d.effective_status}</span>
            {d.awaiting && <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>Awaiting {d.awaiting.kind === 'hr' ? 'HR' : `${d.awaiting.name} (${d.awaiting.label})`}</span>}
          </div>
          <Facts rows={[
            [d.visitor_id ? 'Host (approves)' : material ? 'Responsible' : 'Employee', `${d.employee_name || d.visitor_name || '—'}${d.emp_code ? ` (${d.emp_code})` : ''}`],
            ['Department', d.department],
            ['Type', passTypeLabel(d)],
            [material ? 'Purpose' : 'Reason', d.purpose],
            ['Destination', d.destination],
            ['Vehicle', d.vehicle_number],
            ['Carried by', d.carried_by],
            [material ? 'Leaves from' : 'Leaves at', d.valid_from ? fmtStamp(d.valid_from) : null],
            [material ? 'Valid until' : 'Due back', d.valid_to ? fmtStamp(d.valid_to) : null],
            ['Goods due back', d.expected_return_at ? fmtStamp(d.expected_return_at) : null],
            ['Visitor', d.visitor_id ? `${d.visitor_ref_name}${d.visitor_ref_company ? ` (${d.visitor_ref_company})` : ''}${d.visitor_pass_number ? ` · ${d.visitor_pass_number}` : ''}` : null],
            ['Requested by', d.requested_by_name && d.requested_by !== d.employee_id ? d.requested_by_name : null],
            ['Approved', d.approved_at ? `${fmtStamp(d.approved_at)} · ${d.approved_by_name || ''}` : null],
            ['Went out', d.out_at ? `${fmtStamp(d.out_at)} · ${d.out_by_name || ''}` : null],
            ['Came back', d.in_at ? `${fmtStamp(d.in_at)} · ${d.in_by_name || ''}` : null],
            ['Closed', d.close_reason],
            ['Cancelled', d.cancel_reason ? `${d.cancel_reason}${d.cancelled_by_name ? ` · ${d.cancelled_by_name}` : ''}` : null],
            ['Note', d.approver_note],
          ]} />
          {material && (
            <div style={{ marginTop: 16, overflowX: 'auto' }}>
              <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 13, marginBottom: 6 }}>Goods</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }} data-testid="detail-items">
                <thead><tr style={{ background: '#f5f3ff' }}>{['#', 'Item', 'Code', 'Qty', ...(d.returnable ? ['Returned'] : [])].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {d.items.map((it, i) => (
                    <tr key={it.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                      <td style={S.td}>{i + 1}</td>
                      <td style={S.td}>{it.description}{it.remarks && <div style={{ fontSize: 11, color: '#6b7280' }}>{it.remarks}</div>}</td>
                      <td style={S.td}>{it.item_code || '—'}</td>
                      <td style={S.td}>{fmtQty(it.quantity)} {it.unit}</td>
                      {d.returnable && <td style={S.td}>{fmtQty(it.returned_quantity)}{it.last_returned_at && <div style={{ fontSize: 11, color: '#6b7280' }}>{fmtStamp(it.last_returned_at)}</div>}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 13, marginBottom: 6 }}>History</div>
            <EventList events={d.events} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            {d.can_print && <button type="button" style={S.secondary} onClick={() => onAction('print', d)}>Print</button>}
            {d.can_edit && <button type="button" style={S.secondary} onClick={() => onAction('edit', d)}>Edit</button>}
          </div>
        </>
      )}
    </Modal>
  );
}

export default function PassList({ mode, passType = '', employees = [], flash, onChanged = () => {}, canCreate, canPickEmployee, canExport }) {
  const register = mode === 'register';
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], total: 0, page_size: 25, counts: {} });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState({});
  const [form, setForm] = useState(null);            // { passType, initial }
  const [dialog, setDialog] = useState(null);        // { kind, pass, items? }
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, page_size: 25, scope: register ? 'all' : 'mine' };
      if (passType) params.pass_type = passType;
      for (const [k, v] of Object.entries(filters)) if (v !== '') params[k] = v;
      const res = await api.get('/gate-passes', { params });
      setData(res.data?.rows ? res.data : { rows: [], total: 0, page_size: 25, counts: {} });
      setLoadError(res.data?.message || '');
    } catch (err) {
      setData({ rows: [], total: 0, page_size: 25, counts: {} });
      setLoadError(errText(err, 'Could not load gate passes'));
    } finally { setLoading(false); }
  }, [filters, page, passType, register]);
  useEffect(() => { load(); }, [load]);

  const refresh = () => { load(); onChanged(); };
  const setFilter = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const clearFilters = () => { setFilters(EMPTY_FILTERS); setPage(1); };
  const filtered = Object.values(filters).some((v) => v !== '');
  const counts = data.counts || {};

  const call = async (gp, verb, body, done) => {
    setBusy((b) => ({ ...b, [gp.id]: true }));
    try {
      await api.put(`/gate-passes/${gp.id}/${verb}`, body || {});
      flash(done);
      refresh();
      return null;
    } catch (err) {
      const msg = errText(err, 'That did not work');
      load();
      return msg;
    } finally { setBusy((b) => ({ ...b, [gp.id]: false })); }
  };
  const quick = async (gp, verb, done) => { const err = await call(gp, verb, {}, done); if (err) flash(err, 'error'); };

  const openWithItems = async (gp, kind) => {
    try {
      const res = await api.get(`/gate-passes/${gp.id}`);
      if (kind === 'print') { if (!printPass(res.data, res.data.items)) flash(POPUP_BLOCKED, 'error'); return; }
      if (kind === 'edit') { setForm({ passType: res.data.pass_type, initial: res.data }); return; }
      setDialog({ kind, pass: res.data, items: res.data.items });
    } catch (err) { flash(errText(err, 'Could not load the pass'), 'error'); }
  };

  const onDetailAction = (kind, d) => {
    setDetailId(null);
    if (kind === 'print') { if (!printPass(d, d.items)) flash(POPUP_BLOCKED, 'error'); }
    if (kind === 'edit') setForm({ passType: d.pass_type, initial: d });
  };

  const exportCsv = async () => {
    const params = { ...(passType ? { pass_type: passType } : {}) };
    for (const [k, v] of Object.entries(filters)) if (v !== '') params[k] = v;
    const err = await downloadCsv('/gate-passes/export', params, 'gate-passes.csv');
    if (err) flash(err, 'error');
  };

  const showType = !passType;
  const statusLine = PASS_STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${PASS_STATUS[s].label.toLowerCase()}`).join(' · ');
  const cols = ['Pass No.', register ? 'Employee' : null, showType ? 'Type' : null, passType === 'material' ? 'Goods' : 'Reason', 'When', 'Status', 'Actions'].filter(Boolean);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }} data-testid="pass-counts">{statusLine || 'No passes yet'}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canExport && <button type="button" onClick={exportCsv} style={S.secondary}>Export CSV</button>}
          {canCreate && (passType === '' || passType === 'person') && (
            <button type="button" onClick={() => setForm({ passType: 'person', initial: null })} style={S.primary}>+ {register ? 'New gate pass' : 'Request gate pass'}</button>
          )}
          {canCreate && (passType === '' || passType === 'material') && (
            <button type="button" onClick={() => setForm({ passType: 'material', initial: null })} style={S.primary}>+ {register ? 'New material pass' : 'Request material pass'}</button>
          )}
        </div>
      </div>

      <div style={S.filterBar} data-testid="pass-filters">
        <Field label="Search" width={200}><input type="search" placeholder={passType === 'material' ? 'Pass no., item, destination' : 'Pass no., name, reason'} value={filters.q} onChange={(e) => setFilter('q', e.target.value)} style={S.input} /></Field>
        <Field label="Status" width={170}>
          <select aria-label="Status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)} style={S.input}>
            <option value="">All statuses</option>
            {PASS_STATUS_ORDER.map((k) => <option key={k} value={k}>{PASS_STATUS[k].label}{counts[k] != null ? ` (${counts[k]})` : ''}</option>)}
          </select>
        </Field>
        {passType !== 'material' && (
          <Field label="Type" width={150}>
            <select aria-label="Type of pass" value={filters.category} onChange={(e) => setFilter('category', e.target.value)} style={S.input}>
              <option value="">All types</option>
              {CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        )}
        {register && <Field label="Employee" width={180}><EmployeeSelect employees={employees} value={filters.employee_id} onChange={(v) => setFilter('employee_id', v)} placeholder="All employees" /></Field>}
        <Field label="Between" width={140}><input type="date" aria-label="From date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter('from', e.target.value)} style={S.input} /></Field>
        <Field label="and" width={140}><input type="date" aria-label="To date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} style={S.input} /></Field>
        <button type="button" onClick={clearFilters} disabled={!filtered} style={{ ...S.secondary, padding: '7px 12px', opacity: filtered ? 1 : 0.5 }}>Clear filters</button>
      </div>
      {loadError && <div role="alert" style={{ color: '#b91c1c', fontSize: 13, marginBottom: 8 }}>{loadError}</div>}

      <div style={{ overflowX: 'auto', opacity: loading ? 0.6 : 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }} data-testid="pass-table">
          <thead><tr style={{ background: '#f5f3ff' }}>{cols.map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {data.rows.length === 0 && !loading && <EmptyRow cols={cols.length} filtered={filtered} onClear={clearFilters} what="gate passes" />}
            {data.rows.map((gp) => {
              const st = PASS_STATUS[gp.effective_status] || { label: gp.effective_status, color: '#6b7280' };
              const material = gp.pass_type === 'material';
              const b = busy[gp.id];
              return (
                <tr key={gp.id} style={{ borderBottom: '1px solid #f0ebff', background: gp.effective_status === 'overdue' ? '#fff7f7' : undefined }}>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    <button type="button" onClick={() => setDetailId(gp.id)} style={{ border: 'none', background: 'none', padding: 0, fontWeight: 700, color: '#6B3FDB', cursor: 'pointer', font: 'inherit' }}>{gp.pass_number || `#${gp.id}`}</button>
                  </td>
                  {register && (
                    <td style={S.td}>
                      <div style={{ fontWeight: 600 }}>{gp.employee_name || gp.visitor_name || '—'}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{[gp.emp_code, gp.department].filter(Boolean).join(' · ')}</div>
                    </td>
                  )}
                  {showType && <td style={{ ...S.td, fontSize: 12 }}>{material ? (gp.returnable ? 'Goods · returnable' : 'Goods · non-returnable') : CATEGORY_LABEL[gp.category] || '—'}</td>}
                  <td style={{ ...S.td, color: '#4b5563', fontSize: 12, maxWidth: 280 }}>
                    {gp.purpose || '—'}
                    {gp.visitor_id && <div style={{ color: '#6d28d9' }}>Visitor: {gp.visitor_ref_name}{gp.visitor_ref_company ? ` (${gp.visitor_ref_company})` : ''}</div>}
                    {material && <div style={{ color: '#6b7280' }}>{gp.items_count} item{gp.items_count === 1 ? '' : 's'}{gp.destination ? ` → ${gp.destination}` : ''}</div>}
                    {material && gp.returnable && gp.qty_total > 0 && ['out', 'overdue', 'completed'].includes(gp.effective_status) && (
                      <div style={{ color: '#6b7280' }}>Returned {fmtQty(gp.qty_returned)} of {fmtQty(gp.qty_total)}</div>
                    )}
                  </td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap', fontSize: 12 }}>
                    {gp.out_at ? <div>Out {fmtStamp(gp.out_at)}</div> : gp.valid_from ? <div>From {fmtStamp(gp.valid_from)}</div> : null}
                    {gp.in_at ? <div>In {fmtStamp(gp.in_at)}</div>
                      : material && gp.returnable && gp.expected_return_at ? <div>Due {fmtStamp(gp.expected_return_at)}</div>
                        : gp.valid_to ? <div>{material ? 'Until' : 'Due'} {fmtStamp(gp.valid_to)}</div> : null}
                  </td>
                  <td style={S.td}>
                    <span style={S.pill(st.color)}>{st.label}</span>
                    {gp.awaiting && (
                      <div style={{ fontSize: 11, color: '#6b7280' }} data-testid={`awaiting-${gp.id}`}>
                        Awaiting {gp.awaiting.kind === 'hr' ? 'HR' : `${gp.awaiting.name} (${gp.awaiting.label})`}
                      </div>
                    )}
                  </td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    {gp.can_approve && <button type="button" disabled={b} onClick={() => quick(gp, 'approve', `${gp.pass_number} approved`)} style={S.small('#16a34a')}>Approve</button>}
                    {gp.can_reject && <button type="button" disabled={b} onClick={() => setDialog({ kind: 'reject', pass: gp })} style={S.small('#fee2e2', '#b91c1c')}>Reject</button>}
                    {gp.can_mark_out && <button type="button" disabled={b} onClick={() => setDialog({ kind: 'out', pass: gp })} style={S.small('#d97706')}>{material && !gp.returnable ? 'Dispatch' : 'Mark out'}</button>}
                    {gp.can_mark_in && <button type="button" disabled={b} onClick={() => quick(gp, 'in', `${gp.pass_number}: back in`)} style={S.small('#0f766e')}>Mark in</button>}
                    {gp.can_return && <button type="button" disabled={b} onClick={() => openWithItems(gp, 'return')} style={S.small('#0f766e')}>Record return</button>}
                    {gp.can_close && <button type="button" disabled={b} onClick={() => setDialog({ kind: 'close', pass: gp })} style={S.small('#e9e4ff', '#6B3FDB')}>Close</button>}
                    {gp.can_edit && <button type="button" disabled={b} onClick={() => openWithItems(gp, 'edit')} style={S.small('#e9e4ff', '#6B3FDB')}>Edit</button>}
                    {gp.can_cancel && <button type="button" disabled={b} onClick={() => setDialog({ kind: 'cancel', pass: gp })} style={S.small('#fee2e2', '#b91c1c')}>{gp.is_mine && gp.effective_status === 'pending' ? 'Withdraw' : 'Cancel'}</button>}
                    {gp.can_print && <button type="button" onClick={() => openWithItems(gp, 'print')} style={S.small('#e9e4ff', '#6B3FDB')}>Print</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager page={data.page || page} pageSize={data.page_size || 25} total={data.total} onPage={setPage} />

      {form && (
        <PassForm passType={form.passType} initial={form.initial} canPickEmployee={canPickEmployee} employees={employees}
          onCancel={() => setForm(null)}
          onSaved={(row) => { setForm(null); flash(form.initial ? `${row.pass_number} updated` : `${row.pass_number} submitted — ${row.awaiting?.kind === 'hr' ? 'HR' : row.awaiting?.name || 'the approver'} has been notified`); refresh(); }} />
      )}
      {detailId && <PassDetail id={detailId} onClose={() => setDetailId(null)} onAction={onDetailAction} />}
      {dialog?.kind === 'reject' && (
        <ReasonDialog title={`Reject ${dialog.pass.pass_number}?`} confirmText="Reject pass" onClose={() => setDialog(null)}
          onConfirm={async (reason) => { const err = await call(dialog.pass, 'cancel', { reason }, `${dialog.pass.pass_number} rejected`); if (!err) setDialog(null); return err; }} />
      )}
      {dialog?.kind === 'cancel' && (
        <ReasonDialog title={`${dialog.pass.is_mine && dialog.pass.effective_status === 'pending' ? 'Withdraw' : 'Cancel'} ${dialog.pass.pass_number}?`} confirmText="Yes, cancel it" onClose={() => setDialog(null)}
          onConfirm={async (reason) => { const err = await call(dialog.pass, 'cancel', { reason }, `${dialog.pass.pass_number} cancelled`); if (!err) setDialog(null); return err; }} />
      )}
      {dialog?.kind === 'close' && (
        <ReasonDialog title={`Close ${dialog.pass.pass_number} without a full return?`} confirmText="Close pass" onClose={() => setDialog(null)}
          intro={dialog.pass.pass_type === 'material' ? 'What came back stays recorded. Say what happened to the rest (consumed, sold, lost…).' : 'For someone not returning today. Say why.'}
          onConfirm={async (reason) => { const err = await call(dialog.pass, 'close', { reason }, `${dialog.pass.pass_number} closed`); if (!err) setDialog(null); return err; }} />
      )}
      {dialog?.kind === 'out' && <OutDialog pass={dialog.pass} onClose={() => setDialog(null)} call={call} />}
      {dialog?.kind === 'return' && (
        <ReturnDialog pass={dialog.pass} items={dialog.items} onClose={() => setDialog(null)}
          onDone={(row) => { setDialog(null); flash(row.effective_status === 'completed' ? `${row.pass_number}: all goods back — completed` : `${row.pass_number}: return recorded`); refresh(); }} />
      )}
    </div>
  );
}

/** Mark out / dispatch: the vehicle actually used can be recorded at the gate. */
function OutDialog({ pass, onClose, call }) {
  const [vehicle, setVehicle] = useState(pass.vehicle_number || '');
  const nrgp = pass.pass_type === 'material' && !pass.returnable;
  return (
    <ReasonDialog title={`${nrgp ? 'Dispatch' : 'Mark out'} ${pass.pass_number}`} label="Note" optional danger={false}
      confirmText={nrgp ? 'Dispatch — completes the pass' : 'Record exit now'} onClose={onClose}
      intro={`Records the exit at the current time${nrgp ? '. Non-returnable goods complete the pass.' : '.'}`}
      extra={(
        <div style={{ marginBottom: 12 }}>
          <label style={S.label} htmlFor="out-vehicle">Vehicle number</label>
          <input id="out-vehicle" maxLength={30} value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())} style={S.input} placeholder="Optional" />
        </div>
      )}
      onConfirm={async (note) => {
        const err = await call(pass, 'out', { vehicle_number: vehicle, note }, `${pass.pass_number}: ${nrgp ? 'dispatched' : 'out'}`);
        if (!err) onClose();
        return err;
      }} />
  );
}
