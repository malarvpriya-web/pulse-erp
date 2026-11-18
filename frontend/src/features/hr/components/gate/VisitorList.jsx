// Visitors — the gate register (mode 'register') or the visitors the caller
// hosts (mode 'mine'). Buttons follow the server's per-row flags.
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import { S, fmtStamp, errText } from '../biometric/biometricShared';
import { Field, Pager, EmptyRow, EmployeeSelect } from '../biometric/biometricUi';
import { VISITOR_STATUS, PASS_STATUS, printBadge, downloadCsv } from './gateShared';
import { Modal, ReasonDialog, EventList, Facts } from './gateUi';
import VisitorForm from './VisitorForm';
import PassForm from './PassForm';

const EMPTY_FILTERS = { q: '', host_employee_id: '', status: '', from: '', to: '' };
const STATUS_FILTERS = [['pending_approval', 'Awaiting security'], ['approved', 'Approved — not arrived'], ['inside', 'Inside'], ['overstay', 'Inside since an earlier day'],
  ['no_show', 'No-show'], ['checked_out', 'Checked out'], ['rejected', 'Entry refused'], ['cancelled', 'Cancelled']];

/** The stored photo, fetched with the session (the file route needs auth). */
function Photo({ url }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!url) return undefined;
    let live = true; let obj = null;
    const name = String(url).split('/').pop();
    api.get(`/files/${encodeURIComponent(name)}`, { params: { disposition: 'inline' }, responseType: 'blob' })
      .then((r) => { if (live) { obj = URL.createObjectURL(r.data); setSrc(obj); } })
      .catch(() => { if (live) setSrc(null); });
    return () => { live = false; if (obj) URL.revokeObjectURL(obj); };
  }, [url]);
  if (!url) return null;
  return src
    ? <img src={src} alt="Visitor" style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 10, border: '1px solid #e9e4ff' }} />
    : <div style={{ width: 120, height: 120, borderRadius: 10, background: '#f5f3ff' }} />;
}

function VisitorDetail({ id, onClose, onChanged, flash }) {
  const [v, setV] = useState(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const load = useCallback(() => api.get(`/visitors/${id}`).then((r) => setV(r.data)).catch((err) => setError(errText(err, 'Could not load the visitor'))), [id]);
  useEffect(() => { load(); }, [load]);

  const upload = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { flash('The photo must be an image (JPG, PNG, WebP or GIF).', 'error'); return; }
    if (file.size > 5 * 1024 * 1024) { flash('The photo must be 5 MB or smaller.', 'error'); return; }
    const body = new FormData();
    body.append('photo_file', file);
    setUploading(true);
    try { await api.put(`/visitors/${id}/photo`, body); await load(); onChanged(); flash('Photo saved'); }
    catch (err) { flash(errText(err, 'Could not save the photo'), 'error'); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const st = v ? VISITOR_STATUS[v.effective_status] || { label: v.effective_status, color: '#6b7280' } : null;
  return (
    <Modal title={v ? `Visitor — ${v.name}` : 'Visitor'} onClose={onClose} width={680}>
      {error && <div role="alert" style={{ color: '#b91c1c' }}>{error}</div>}
      {!v && !error && <div style={{ color: '#6b7280' }}>Loading…</div>}
      {v && (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <Photo url={v.photo_url} />
              {v.can_photo && (
                <div style={{ marginTop: 6 }}>
                  <input ref={fileRef} type="file" accept="image/*" capture="user" aria-label="Visitor photo" style={{ display: 'none' }} onChange={(e) => upload(e.target.files?.[0])} />
                  <button type="button" disabled={uploading} onClick={() => fileRef.current?.click()} style={{ ...S.secondary, padding: '5px 10px', fontSize: 12 }}>
                    {uploading ? 'Saving…' : v.photo_url ? 'Replace photo' : 'Add photo'}
                  </button>
                </div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ marginBottom: 10 }}>
                <span style={S.pill(st.color)}>{st.label}</span>
                {v.overstay && <span style={{ ...S.pill('#dc2626'), marginLeft: 6 }}>Inside since an earlier day</span>}
              </div>
              <Facts rows={[
                ['Visitor pass', v.pass_number],
                ['Entry approved', v.approved_at ? `${fmtStamp(v.approved_at)}${v.approved_by_name ? ` · ${v.approved_by_name}` : ''}` : null],
                ['Entry refused', v.rejected_at ? `${v.reject_reason || ''}${v.rejected_by_name ? ` · ${v.rejected_by_name}` : ''}` : null],
                ['Company', v.company], ['Phone', v.phone], ['Email', v.email],
                ['People', v.visitor_count > 1 ? String(v.visitor_count) : null],
                ['Host', v.host_name ? `${v.host_name}${v.host_department ? ` · ${v.host_department}` : ''}` : null],
                ['Purpose', v.purpose], ['Vehicle', v.vehicle_number],
                ['ID', v.id_type ? `${v.id_type}${v.id_number ? ` · ${v.id_number}` : ''}` : null],
                ['Expected', v.expected_at ? fmtStamp(v.expected_at) : null],
                ['Pre-registered by', v.pre_registered_by_name],
                ['Checked in', v.check_in_time ? `${fmtStamp(v.check_in_time)}${v.checked_in_by_name ? ` · ${v.checked_in_by_name}` : ''}` : null],
                ['Checked out', v.check_out_time ? `${fmtStamp(v.check_out_time)}${v.checked_out_by_name ? ` · ${v.checked_out_by_name}` : ''}` : null],
                ['Cancelled', v.cancel_reason],
              ]} />
            </div>
          </div>
          {v.goods_passes?.length > 0 && (
            <div style={{ marginTop: 16 }} data-testid="visitor-goods">
              <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 13, marginBottom: 6 }}>Goods passes</div>
              {v.goods_passes.map((g) => (
                <div key={g.id} style={{ fontSize: 13, padding: '4px 0' }}>
                  <strong>{g.pass_number}</strong> · {g.purpose} · <span style={S.pill((PASS_STATUS[g.effective_status] || {}).color || '#6b7280')}>{(PASS_STATUS[g.effective_status] || {}).label || g.effective_status}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 13, marginBottom: 6 }}>History</div>
            <EventList events={v.events} />
          </div>
        </>
      )}
    </Modal>
  );
}

export default function VisitorList({ mode, employees = [], flash, onChanged = () => {}, canCheckIn, canPreRegister, canPickHost, canExport, canLookup, canSecurity = false }) {
  const register = mode === 'register';
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], total: 0, page_size: 25, counts: {}, inside_total: 0 });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState({});
  const [form, setForm] = useState(null);          // { mode, initial }
  const [cancelFor, setCancelFor] = useState(null);
  const [rejectFor, setRejectFor] = useState(null);
  const [goodsFor, setGoodsFor] = useState(null);
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, page_size: 25, scope: register ? 'all' : 'mine' };
      for (const [k, v] of Object.entries(filters)) if (v !== '') params[k] = v;
      const res = await api.get('/visitors', { params });
      setData(res.data?.rows ? res.data : { rows: [], total: 0, page_size: 25, counts: {}, inside_total: 0 });
      setLoadError('');
    } catch (err) {
      setData({ rows: [], total: 0, page_size: 25, counts: {}, inside_total: 0 });
      setLoadError(errText(err, 'Could not load visitors'));
    } finally { setLoading(false); }
  }, [filters, page, register]);
  useEffect(() => { load(); }, [load]);

  const refresh = () => { load(); onChanged(); };
  const setFilter = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const clearFilters = () => { setFilters(EMPTY_FILTERS); setPage(1); };
  const filtered = Object.values(filters).some((v) => v !== '');
  const c = data.counts || {};

  const put = async (v, verb, body, done) => {
    setBusy((b) => ({ ...b, [v.id]: true }));
    try { await api.put(`/visitors/${v.id}/${verb}`, body || {}); flash(done); refresh(); return null; }
    catch (err) { load(); return errText(err, 'That did not work'); }
    finally { setBusy((b) => ({ ...b, [v.id]: false })); }
  };
  const badge = async (v) => {
    if (!printBadge(v)) { flash('The print window was blocked by the browser. Allow pop-ups for Pulse and try again.', 'error'); return; }
    try { await api.put(`/visitors/${v.id}/badge`); load(); }
    catch (err) { flash(errText(err, 'Badge printed, but it could not be recorded'), 'error'); }
  };
  const exportCsv = async () => {
    const params = {};
    for (const [k, v] of Object.entries(filters)) if (v !== '') params[k] = v;
    const err = await downloadCsv('/visitors/export', params, 'visitors.csv');
    if (err) flash(err, 'error');
  };

  const summary = [
    c.pending_approval ? `${c.pending_approval} awaiting security` : null,
    c.inside ? `${c.inside} inside` : null,
    c.overstay ? `${c.overstay} since an earlier day` : null,
    c.approved ? `${c.approved} approved, not arrived` : null,
  ].filter(Boolean).join(' · ');
  const cols = ['Visitor', 'Company', register ? 'Host' : null, 'Purpose', 'Expected / In', 'Out', 'Status', 'Actions'].filter(Boolean);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }} data-testid="inside-count">{summary || 'Nobody inside or expected'}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canExport && <button type="button" onClick={exportCsv} style={S.secondary}>Export CSV</button>}
          {canPreRegister && <button type="button" onClick={() => setForm({ mode: 'preregister', initial: null })} style={register ? S.secondary : S.primary}>+ Pre-register visitor</button>}
          {canCheckIn && <button type="button" onClick={() => setForm({ mode: 'checkin', initial: null })} style={S.primary}>+ Register walk-in</button>}
        </div>
      </div>

      <div style={S.filterBar} data-testid="visitor-filters">
        <Field label="Search" width={200}><input type="search" placeholder="Name, company, phone, host" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} style={S.input} /></Field>
        {register && <Field label="Host" width={180}><EmployeeSelect employees={employees} value={filters.host_employee_id} onChange={(v) => setFilter('host_employee_id', v)} placeholder="All hosts" /></Field>}
        <Field label="Status" width={170}>
          <select aria-label="Visitor status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)} style={S.input}>
            <option value="">All</option>
            {STATUS_FILTERS.map(([k, l]) => <option key={k} value={k}>{l}{c[k] != null ? ` (${c[k]})` : ''}</option>)}
          </select>
        </Field>
        <Field label="From" width={140}><input type="date" aria-label="Visit from" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter('from', e.target.value)} style={S.input} /></Field>
        <Field label="to" width={140}><input type="date" aria-label="Visit to" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} style={S.input} /></Field>
        <button type="button" onClick={clearFilters} disabled={!filtered} style={{ ...S.secondary, padding: '7px 12px', opacity: filtered ? 1 : 0.5 }}>Clear filters</button>
      </div>
      {loadError && <div role="alert" style={{ color: '#b91c1c', fontSize: 13, marginBottom: 8 }}>{loadError}</div>}

      <div style={{ overflowX: 'auto', opacity: loading ? 0.6 : 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }} data-testid="visitor-table">
          <thead><tr style={{ background: '#f5f3ff' }}>{cols.map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {data.rows.length === 0 && !loading && <EmptyRow cols={cols.length} filtered={filtered} onClear={clearFilters} what="visitors" />}
            {data.rows.map((v) => {
              const st = VISITOR_STATUS[v.effective_status] || { label: v.effective_status, color: '#6b7280' };
              const b = busy[v.id];
              return (
                <tr key={v.id} style={{ borderBottom: '1px solid #f0ebff', background: v.overstay ? '#fff7f7' : v.effective_status === 'inside' ? '#fafffe' : undefined }}>
                  <td style={{ ...S.td, fontWeight: 600 }}>
                    <button type="button" onClick={() => setDetailId(v.id)} style={{ border: 'none', background: 'none', padding: 0, fontWeight: 700, color: '#6B3FDB', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>{v.name}</button>
                    {v.visitor_count > 1 && <span style={{ marginLeft: 4, fontSize: 11, color: '#6b7280' }}>+{v.visitor_count - 1}</span>}
                    {v.badge_printed && <span style={{ marginLeft: 6, fontSize: 10, background: '#ede9fe', color: '#6B3FDB', padding: '1px 5px', borderRadius: 8, fontWeight: 600 }} title="A badge was printed for this visit">Badge ✓</span>}
                    <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>{[v.phone, v.email].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td style={{ ...S.td, color: '#6b7280' }}>{v.company || '—'}</td>
                  {register && <td style={S.td}>{v.host_name || '—'}</td>}
                  <td style={{ ...S.td, color: '#6b7280', fontSize: 12 }}>{v.purpose || '—'}</td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap', fontSize: 12 }}>{v.check_in_time ? fmtStamp(v.check_in_time) : v.expected_at ? `Expected ${fmtStamp(v.expected_at)}` : '—'}</td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap', fontSize: 12 }}>{v.check_out_time ? fmtStamp(v.check_out_time) : '—'}</td>
                  <td style={S.td}>
                    <span style={S.pill(st.color)}>{st.label}</span>
                    {v.overstay && <div style={{ fontSize: 11, color: '#dc2626' }}>since an earlier day</div>}
                    {v.pass_number && <div style={{ fontSize: 11, color: '#6b7280' }}>{v.pass_number}</div>}
                  </td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    {v.can_approve && <button type="button" disabled={b} onClick={async () => { const err = await put(v, 'approve', {}, `${v.name}: entry approved`); if (err) flash(err, 'error'); }} style={S.small('#16a34a')}>Approve entry</button>}
                    {v.can_reject && <button type="button" disabled={b} onClick={() => setRejectFor(v)} style={S.small('#fee2e2', '#b91c1c')}>Refuse</button>}
                    {(v.can_check_in || v.can_approve_check_in) && <button type="button" disabled={b} onClick={() => setForm({ mode: 'arrive', initial: v })} style={S.small(v.can_check_in ? '#16a34a' : '#0f766e')}>{v.can_check_in ? 'Check in' : 'Approve & check in'}</button>}
                    {v.can_goods && <button type="button" disabled={b} onClick={() => setGoodsFor(v)} style={S.small('#d97706')}>Goods out</button>}
                    {v.checkout_blocked && <span title={v.checkout_blocked} style={{ fontSize: 11, color: '#b45309', marginRight: 6 }}>Goods pass open</span>}
                    {v.can_check_out && <button type="button" disabled={b} onClick={async () => { const err = await put(v, 'checkout', {}, `${v.name} checked out`); if (err) flash(err, 'error'); }} style={S.small('#dc2626')}>Check out</button>}
                    {v.can_badge && <button type="button" onClick={() => badge(v)} style={S.small('#e9e4ff', '#6B3FDB')}>Badge</button>}
                    {v.can_edit && <button type="button" disabled={b} onClick={() => setForm({ mode: 'edit', initial: v })} style={S.small('#e9e4ff', '#6B3FDB')}>Edit</button>}
                    {v.can_cancel && <button type="button" disabled={b} onClick={() => setCancelFor(v)} style={S.small('#fee2e2', '#b91c1c')}>Cancel</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager page={data.page || page} pageSize={data.page_size || 25} total={data.total} onPage={setPage} />

      {form && (
        <VisitorForm mode={form.mode} initial={form.initial} canPickHost={canPickHost} employees={employees} canLookup={canLookup} canApproveNow={canSecurity && canCheckIn}
          onCancel={() => setForm(null)}
          onSaved={(row) => {
            setForm(null);
            const arrived = row.effective_status === 'inside';
            flash({ checkin: arrived ? `${row.name} checked in — pass ${row.pass_number}${row.host_name ? `, ${row.host_name} has been notified` : ''}` : `${row.name} registered — waiting for security to approve entry`, arrive: `${row.name} checked in${row.host_name ? ` — ${row.host_name} has been notified` : ''}`,
              preregister: `${row.name} pre-registered`, edit: `${row.name} updated` }[form.mode]);
            refresh();
          }} />
      )}
      {rejectFor && (
        <ReasonDialog title={`Refuse entry to ${rejectFor.name}?`} confirmText="Refuse entry" onClose={() => setRejectFor(null)}
          intro="The host is told, with your reason."
          onConfirm={async (reason) => { const err = await put(rejectFor, 'reject', { reason }, `${rejectFor.name}: entry refused`); if (!err) setRejectFor(null); return err; }} />
      )}
      {goodsFor && (
        <PassForm passType="material" visitor={goodsFor} canPickEmployee={false} employees={[]}
          onCancel={() => setGoodsFor(null)}
          onSaved={(row) => { setGoodsFor(null); flash(row.effective_status === 'approved' ? `${row.pass_number} approved — security releases the goods at the gate` : `${row.pass_number} raised — ${row.awaiting?.name || 'the host'} has been asked to approve`); refresh(); }} />
      )}
      {cancelFor && (
        <ReasonDialog title={`Cancel ${cancelFor.name}'s visit?`} confirmText="Cancel visit" onClose={() => setCancelFor(null)}
          onConfirm={async (reason) => { const err = await put(cancelFor, 'cancel', { reason }, `${cancelFor.name}'s visit cancelled`); if (!err) setCancelFor(null); return err; }} />
      )}
      {detailId && <VisitorDetail id={detailId} onClose={() => setDetailId(null)} onChanged={load} flash={flash} />}
    </div>
  );
}
