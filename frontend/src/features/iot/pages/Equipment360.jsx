/**
 * Equipment360.jsx — one unit, end to end.
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * Phase 4 left this as a PARTIAL: device telemetry, alerts and the customer /
 * project / AMC links were reachable from the Fleet Monitor's side panel, but
 * three things had no home at all —
 *
 *   1. AS-BUILT GENEALOGY. What this unit is made of, which production batch and
 *      order it came from, and what has been swapped since. The serial master
 *      existed in production's tables and IoT never looked at it.
 *   2. SERVICE PARTS. Which spares this unit has consumed, what they cost, who
 *      fitted them and under whose cover.
 *   3. LIFETIME COST. The sum of the above, which is the number that decides
 *      whether an AMC renewal is priced correctly.
 *
 * The page is organised around the §62 chain, top to bottom, so a reader can
 * follow one unit from the customer that owns it to the last component fitted:
 *
 *   Customer -> Project -> Site -> Equipment -> Serial -> As-built
 *            -> IoT device -> Telemetry -> Alerts -> Tickets -> Parts
 *            -> Inventory movement -> Genealogy event -> Financial posting
 *
 * WHERE A LINK IS ABSENT IT SAYS SO. A unit whose serial was never registered in
 * production shows "production genealogy NOT AVAILABLE for this unit" with the
 * serial quoted, not an empty panel a reader would take for "no components".
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Cpu, RefreshCw, AlertTriangle, Ban, Package, Ticket, Building2, FolderKanban,
  ShieldCheck, Wrench, History, IndianRupee, Plus, X, Save, ExternalLink,
  CircleAlert, Layers, Undo2,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';

const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const TH = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.04em' };
const TD = { padding: '9px 12px', borderBottom: '1px solid #f9f9fb', fontSize: 13, verticalAlign: 'top' };
const btn = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 5 };
const input = { width: '100%', padding: '7px 9px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' };
const label = { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.03em', display: 'block', marginBottom: 4 };

const fmt = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');
const fmtDT = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const money = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

const COVER_COLOR = { warranty: '#2563eb', amc: '#059669', goodwill: '#b45309', chargeable: '#6b7280' };

function errState(e) {
  const status = e?.response?.status;
  if (status === 403) return { kind: 'UNAUTHORIZED', message: e.response?.data?.message || 'You do not have access to this equipment.' };
  if (status === 404) return { kind: 'NOT_FOUND', message: 'Equipment not found in your company.' };
  return { kind: 'ERROR', message: e?.response?.data?.error || e?.message || 'The request failed.', status };
}

/** A link in the chain that could not be made, stated rather than left blank. */
function MissingLink({ children }) {
  return (
    <div style={{ background: '#fffbeb', border: '1px dashed #fde68a', borderRadius: 8, padding: 11, fontSize: 12, color: '#92400e', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <CircleAlert size={14} style={{ flex: 'none', marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

// ── issue-a-part dialog ───────────────────────────────────────────────────────
function IssuePartDialog({ equipmentId, tickets, onClose, onDone }) {
  const [parts, setParts] = useState([]);
  const [form, setForm] = useState({
    part_id: '', quantity: 1, ticket_id: '', cover: '',
    removed_serial: '', fitted_serial: '', reason: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    api.get('/iot/spare-parts', { params: { in_stock: 'true' } })
      .then(({ data }) => setParts(data.rows || []))
      .catch(() => setParts([]));
  }, []);

  const selected = parts.find((p) => String(p.id) === String(form.part_id));
  const lineCost = selected ? Number(selected.unit_cost) * Number(form.quantity || 0) : 0;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const { data } = await api.post(`/iot/equipment/${equipmentId}/service-parts`, {
        part_id: Number(form.part_id),
        quantity: Number(form.quantity),
        ticket_id: form.ticket_id ? Number(form.ticket_id) : null,
        cover: form.cover || null,
        removed_serial: form.removed_serial || null,
        fitted_serial: form.fitted_serial || null,
        reason: form.reason || null,
      });
      setResult(data);
      onDone?.();
    } catch (e) {
      setError(e?.response?.data?.detail || e?.response?.data?.error || e.message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)', zIndex: 1199 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(520px, 100vw)', background: '#fff',
        borderLeft: '1px solid #e5e7eb', boxShadow: '-8px 0 30px rgba(0,0,0,.12)', zIndex: 1200,
        overflowY: 'auto', padding: 18,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Record a part replacement</span>
          <button onClick={onClose} style={{ ...btn, border: 'none' }}><X size={16} /></button>
        </div>

        {result ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 9, padding: 12 }}>
              <div style={{ fontWeight: 700, color: '#166534', fontSize: 13 }}>
                {result.part.code} × {result.row.quantity} issued
              </div>
              <div style={{ fontSize: 12, color: '#166534', marginTop: 4 }}>
                Stock {result.part.stock_before} → {result.part.stock_after} · {money(result.row.total_cost)} · cover {result.row.cover}
              </div>
            </div>

            {/* What the one action actually wrote, named. The point of the §74
                work is that this list is not empty. */}
            <div style={CARD}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8 }}>What this recorded</div>
              {[
                ['Spare stock movement', result.chain.stock_movement],
                ['Inventory stock ledger', result.chain.stock_ledger],
                ['Serial genealogy event', result.chain.genealogy],
                ['Financial posting (draft journal)', result.chain.finance],
                ['Equipment history', result.chain.equipment_history],
                ['Ticket job costing', result.chain.ticket_costed],
              ].map(([name, ok]) => (
                <div key={name} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12 }}>
                  <span style={{ color: ok ? '#374151' : '#9ca3af' }}>{name}</span>
                  <span style={{ color: ok ? '#059669' : '#b45309', fontWeight: 600 }}>{ok ? 'written' : 'not linked'}</span>
                </div>
              ))}
            </div>

            {result.notes?.length > 0 && (
              <MissingLink>
                <b>Some links were not made:</b>
                <ul style={{ margin: '5px 0 0', paddingLeft: 16 }}>
                  {result.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </MissingLink>
            )}

            <button onClick={onClose} style={{ ...btn, padding: '8px 16px' }}>Close</button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <label style={label}>Spare part</label>
              <select style={input} value={form.part_id} onChange={set('part_id')}>
                <option value="">Select a part…</option>
                {parts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.part_code} — {p.name} ({p.stock_qty} {p.unit || 'nos'} in stock{p.low_stock ? ', LOW' : ''})
                  </option>
                ))}
              </select>
              {!parts.length && (
                <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>
                  No spare part with stock is available in this company.
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={label}>Quantity</label>
                <input style={input} type="number" min="0.001" step="any" value={form.quantity} onChange={set('quantity')} />
                {selected && Number(form.quantity) > Number(selected.stock_qty) && (
                  <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>
                    Only {selected.stock_qty} in stock — this will be refused.
                  </div>
                )}
              </div>
              <div>
                <label style={label}>Cover</label>
                <select style={input} value={form.cover} onChange={set('cover')}>
                  <option value="">Derive from the contract</option>
                  <option value="amc">AMC</option>
                  <option value="warranty">Warranty</option>
                  <option value="chargeable">Chargeable to customer</option>
                  <option value="goodwill">Goodwill</option>
                </select>
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                  Decides the expense account: warranty/AMC → Warranty Cost, otherwise Repairs &amp; Maintenance.
                </div>
              </div>
            </div>

            <div>
              <label style={label}>Service ticket</label>
              <select style={input} value={form.ticket_id} onChange={set('ticket_id')}>
                <option value="">Not linked to a ticket</option>
                {tickets.map((t) => (
                  <option key={t.ticket_id} value={t.ticket_id}>
                    {t.ticket_number} — {t.ticket_status}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={label}>Removed component serial</label>
                <input style={input} value={form.removed_serial} onChange={set('removed_serial')} placeholder="optional" />
              </div>
              <div>
                <label style={label}>Fitted component serial</label>
                <input style={input} value={form.fitted_serial} onChange={set('fitted_serial')} placeholder="optional" />
              </div>
            </div>

            <div>
              <label style={label}>Reason</label>
              <input style={input} value={form.reason} onChange={set('reason')} placeholder="e.g. fan seized, replaced on site" />
            </div>

            {selected && (
              <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 8, padding: 11, fontSize: 12, color: '#4c1d95' }}>
                <b>This will:</b> issue {form.quantity} × {selected.part_code} ({money(lineCost)}),
                decrement spare stock to {Number(selected.stock_qty) - Number(form.quantity || 0)},
                write an inventory movement, add a genealogy event on this unit's serial,
                post a draft journal entry and add the cost to the ticket.
              </div>
            )}

            {error && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 10, fontSize: 12, color: '#991b1b' }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={submit} disabled={busy || !form.part_id}
                style={{ ...btn, background: '#6B3FDB', color: '#fff', borderColor: '#6B3FDB', padding: '8px 16px', opacity: form.part_id ? 1 : 0.5 }}>
                <Save size={13} /> {busy ? 'Recording…' : 'Record replacement'}
              </button>
              <button onClick={onClose} style={{ ...btn, padding: '8px 16px' }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────
export default function Equipment360() {
  const [devices, setDevices] = useState([]);
  const [selected, setSelected] = useState(null);
  const [device, setDevice] = useState(null);
  const [gen, setGen] = useState(null);
  const [state, setState] = useState('LOADING');
  const [error, setError] = useState(null);
  const [showIssue, setShowIssue] = useState(false);

  // Deep link from the Fleet Monitor / Alert Centre: ?equipment=<id>
  useEffect(() => {
    const url = new URL(window.location.href);
    const id = url.searchParams.get('equipment') || url.searchParams.get('device');
    if (id) setSelected(Number(id));
  }, []);

  useEffect(() => {
    api.get('/iot/devices', { params: { limit: 300 } })
      .then(({ data }) => {
        const rows = data.rows || [];
        setDevices(rows);
        setSelected((s) => s ?? rows[0]?.id ?? null);
        if (!rows.length) setState('EMPTY');
      })
      .catch((e) => { setError(errState(e)); setState(errState(e).kind); });
  }, []);

  const load = useCallback(() => {
    if (!selected) return;
    setState('LOADING'); setError(null);
    Promise.all([
      api.get(`/iot/devices/${selected}`),
      api.get(`/iot/equipment/${selected}/genealogy`),
    ])
      .then(([d, g]) => { setDevice(d.data); setGen(g.data); setState('SUCCESS'); })
      .catch((e) => { const err = errState(e); setError(err); setState(err.kind); });
  }, [selected]);

  useEffect(() => { load(); }, [load]);

  const tickets = (device?.alerts || [])
    .filter((a) => a.ticket_id)
    .map((a) => ({ ticket_id: a.ticket_id, ticket_number: a.ticket_number, ticket_status: a.ticket_status }))
    .filter((t, i, arr) => arr.findIndex((x) => x.ticket_id === t.ticket_id) === i);

  const reverse = async (row) => {
    const reason = window.prompt(`Reverse the issue of ${row.part_code} × ${row.quantity}?\nThe original record is kept and marked; stock is returned.\n\nReason:`);
    if (reason == null) return;
    try { await api.post(`/iot/service-parts/${row.id}/reverse`, { reason }); load(); }
    catch (e) { window.alert(e?.response?.data?.error || e.message); }
  };

  return (
    <PageShell dock={
      <PageHero
        icon={Cpu}
        eyebrow="IoT"
        title="Equipment 360"
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={selected || ''} onChange={(e) => setSelected(Number(e.target.value))}
              style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 7, padding: '5px 8px', maxWidth: 230 }}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>{d.equipment_name} ({d.serial_number || d.id})</option>
              ))}
            </select>
            <button className="plh-cta" onClick={load}><RefreshCw size={13} /> Refresh</button>
          </div>
        }
      />
    }>
      <p style={{ margin: '0 0 14px', color: '#6b7280', fontSize: 13 }}>
        One unit from the customer that owns it to the last component fitted — identity, as-built genealogy,
        telemetry, incidents, service jobs, parts consumed and lifetime cost.
      </p>

      {state === 'LOADING' && <div style={{ ...CARD, color: '#9ca3af', textAlign: 'center', padding: 28 }}>Loading…</div>}

      {state === 'EMPTY' && (
        <div style={{ ...CARD, color: '#6b7280', textAlign: 'center', padding: 28, fontSize: 13 }}>
          No equipment records in this company yet.
        </div>
      )}

      {(state === 'ERROR' || state === 'UNAUTHORIZED' || state === 'NOT_FOUND') && (
        <div style={{ ...CARD, borderColor: '#fecaca', background: '#fef2f2', display: 'flex', gap: 10 }}>
          {state === 'UNAUTHORIZED' ? <Ban size={18} color="#b45309" /> : <AlertTriangle size={18} color="#dc2626" />}
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: '#991b1b' }}>Could not load this equipment</div>
            <div style={{ fontSize: 12, color: '#991b1b', marginTop: 3 }}>{error?.message}</div>
            <button onClick={load} style={{ ...btn, marginTop: 8 }}>Try again</button>
          </div>
        </div>
      )}

      {state === 'SUCCESS' && device && gen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* 1. identity and the business chain */}
          <div style={CARD}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#111827' }}>{device.equipment_name}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>
                  {device.model_number || '—'} · SN {device.serial_number || 'not recorded'}
                  {device.rating ? ` · ${device.rating}` : ''}
                  {device.profile?.device_type ? ` · ${device.profile.device_type}` : ''}
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>
                  {device.site_location || 'Site not recorded'} · installed {fmt(device.installation_date)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>Lifetime parts cost</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#111827' }}>
                  {money(gen.totals.lifetime_parts_cost)}
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>
                  {gen.totals.parts_issued} issue(s){gen.totals.reversals ? `, ${gen.totals.reversals} reversed` : ''}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14, paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
              {device.business?.customer_id
                ? <a href={`/crm/accounts?id=${device.business.customer_id}`} style={{ ...btn, textDecoration: 'none' }}><Building2 size={12} /> {device.business.customer_name}</a>
                : <span style={{ ...btn, cursor: 'default', color: '#9ca3af' }}><Building2 size={12} /> Customer not linked</span>}
              {device.business?.project_id
                ? <a href={`/projects/overview?id=${device.business.project_id}`} style={{ ...btn, textDecoration: 'none' }}><FolderKanban size={12} /> {device.business.project_name}</a>
                : <span style={{ ...btn, cursor: 'default', color: '#9ca3af' }}><FolderKanban size={12} /> Project not linked</span>}
              <span style={{ ...btn, cursor: 'default', color: String(device.amc_status).toLowerCase() === 'active' ? '#059669' : '#6b7280' }}>
                <ShieldCheck size={12} /> AMC: {device.amc_status || 'none'}
              </span>
              <span style={{ ...btn, cursor: 'default', color: String(device.warranty_status).toLowerCase() === 'active' ? '#2563eb' : '#6b7280' }}>
                Warranty: {device.warranty_status || 'none'}
              </span>
              <a href={`/iot/fleet-monitor?device=${device.id}`} style={{ ...btn, textDecoration: 'none' }}>
                Live telemetry <ExternalLink size={11} />
              </a>
            </div>
          </div>

          {/* 2. as-built genealogy */}
          <div style={CARD}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Layers size={15} color="#6d28d9" />
              <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>As-built genealogy</span>
            </div>

            {gen.serial ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, fontSize: 12 }}>
                  <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Serial</div><b>{gen.serial.serial_number}</b></div>
                  <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Product</div><b>{gen.serial.item_name || '—'}</b></div>
                  <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Batch</div><b>{gen.serial.batch_number || 'not batched'}</b></div>
                  <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Production order</div><b>{gen.serial.production_order_id || '—'}</b></div>
                  <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Manufactured</div><b>{fmt(gen.serial.manufactured_date)}</b></div>
                  <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Status</div><b>{gen.serial.status || '—'}</b></div>
                </div>

                {gen.production_events.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>
                      Serial history ({gen.production_events.length})
                    </div>
                    <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                      {gen.production_events.map((e) => (
                        <div key={e.id} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid #f9f9fb', fontSize: 12 }}>
                          <span style={{ width: 82, flex: 'none', color: '#6b7280' }}>{fmt(e.event_date)}</span>
                          <span style={{
                            flex: 'none', background: e.event_type === 'COMPONENT_REPLACED' ? '#ede9fe' : '#f3f4f6',
                            color: e.event_type === 'COMPONENT_REPLACED' ? '#5b21b6' : '#4b5563',
                            padding: '1px 7px', borderRadius: 7, fontSize: 10, fontWeight: 600, height: 'fit-content',
                          }}>{e.event_type}</span>
                          <span style={{ flex: 1, minWidth: 0, color: '#374151' }}>{e.description || '—'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <MissingLink>{gen.serial_note}</MissingLink>
            )}
          </div>

          {/* 3. service parts — the §74 chain, visible */}
          <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Package size={15} color="#6d28d9" />
                <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Parts consumed</span>
              </div>
              <button onClick={() => setShowIssue(true)} style={btn}>
                <Plus size={12} /> Record a replacement
              </button>
            </div>

            {gen.service_parts.length === 0 ? (
              <div style={{ padding: '0 16px 20px', color: '#9ca3af', fontSize: 13 }}>
                No parts have been recorded against this unit.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}>
                  <thead><tr>
                    <th style={TH}>Date</th><th style={TH}>Part</th><th style={TH}>Qty</th>
                    <th style={TH}>Cost</th><th style={TH}>Cover</th><th style={TH}>Ticket</th>
                    <th style={TH}>Chain</th><th style={TH} />
                  </tr></thead>
                  <tbody>
                    {gen.service_parts.map((r) => {
                      const isReversal = !!r.reversal_of_id;
                      const reversed = !!r.reversed_at;
                      return (
                        <tr key={r.id} style={{ opacity: reversed ? 0.5 : 1 }}>
                          <td style={{ ...TD, whiteSpace: 'nowrap', color: '#6b7280' }}>{fmtDT(r.issued_at)}</td>
                          <td style={TD}>
                            <div style={{ fontWeight: 600, color: '#111827', textDecoration: reversed ? 'line-through' : 'none' }}>
                              {r.part_code}
                            </div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.part_name}</div>
                            {(r.removed_serial || r.fitted_serial) && (
                              <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
                                {r.removed_serial ? `out ${r.removed_serial}` : ''}
                                {r.removed_serial && r.fitted_serial ? ' → ' : ''}
                                {r.fitted_serial ? `in ${r.fitted_serial}` : ''}
                              </div>
                            )}
                            {isReversal && <div style={{ fontSize: 10, color: '#b45309', marginTop: 2 }}>reversal of #{r.reversal_of_id}</div>}
                          </td>
                          <td style={TD}>{Number(r.quantity)} {r.unit || ''}</td>
                          <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{money(r.total_cost)}</td>
                          <td style={TD}>
                            <span style={{ background: `${COVER_COLOR[r.cover] || '#6b7280'}18`, color: COVER_COLOR[r.cover] || '#6b7280', padding: '2px 8px', borderRadius: 8, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
                              {r.cover}
                            </span>
                          </td>
                          <td style={TD}>
                            {r.ticket_id
                              ? <a href={`/servicedesk/tickets?id=${r.ticket_id}`} style={{ color: '#6B3FDB', textDecoration: 'none', fontSize: 12 }}>
                                  <Ticket size={11} style={{ verticalAlign: -1 }} /> {r.ticket_number || `#${r.ticket_id}`}
                                </a>
                              : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>
                          <td style={{ ...TD, fontSize: 11 }}>
                            {/* Which downstream rows this issue actually created. A
                                missing dot is a real gap, not a rendering quirk. */}
                            <div style={{ display: 'flex', gap: 5 }}>
                              {[
                                ['Inv', r.movement_id, 'spare stock movement'],
                                ['Led', r.stock_ledger_id, 'inventory stock ledger'],
                                ['Gen', r.serial_event_id, 'serial genealogy event'],
                                ['Fin', r.journal_entry_id, `journal ${r.entry_number || ''} ${r.journal_status || ''}`],
                              ].map(([tagName, id, title]) => (
                                <span key={tagName} title={id ? title : `${title}: not linked`}
                                  style={{
                                    padding: '1px 5px', borderRadius: 5, fontSize: 9, fontWeight: 700,
                                    background: id ? '#dcfce7' : '#f3f4f6', color: id ? '#166534' : '#9ca3af',
                                  }}>{tagName}</span>
                              ))}
                            </div>
                          </td>
                          <td style={{ ...TD, textAlign: 'right' }}>
                            {!isReversal && !reversed && (
                              <button onClick={() => reverse(r)} style={{ ...btn, fontSize: 11 }} title="Reverse this issue">
                                <Undo2 size={11} />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 4. incidents and service jobs */}
          <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Wrench size={15} color="#6d28d9" />
              <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Incidents and service jobs</span>
            </div>
            {device.alerts?.length ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 660 }}>
                  <thead><tr>
                    <th style={TH}>Opened</th><th style={TH}>Condition</th><th style={TH}>State</th>
                    <th style={TH}>Ticket</th><th style={TH}>Technician</th>
                  </tr></thead>
                  <tbody>
                    {device.alerts.slice(0, 20).map((a) => (
                      <tr key={a.id}>
                        <td style={{ ...TD, whiteSpace: 'nowrap', color: '#6b7280' }}>{fmtDT(a.opened_at)}</td>
                        <td style={TD}>
                          <div style={{ fontSize: 12 }}>{a.message}</div>
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>{a.severity}</div>
                        </td>
                        <td style={TD}><span style={{ fontSize: 12 }}>{a.state}</span></td>
                        <td style={TD}>
                          {a.ticket_id
                            ? <a href={`/servicedesk/tickets?id=${a.ticket_id}`} style={{ color: '#6B3FDB', textDecoration: 'none', fontSize: 12 }}>
                                {a.ticket_number || `#${a.ticket_id}`} · {a.ticket_status}
                              </a>
                            : <span style={{ color: '#d1d5db' }}>—</span>}
                        </td>
                        <td style={{ ...TD, fontSize: 12, color: a.technician_name ? '#374151' : '#9ca3af' }}>
                          {a.technician_name || 'not assigned'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ padding: '0 16px 20px', color: '#9ca3af', fontSize: 13 }}>No incidents recorded for this unit.</div>
            )}
          </div>

          {/* 5. device event history */}
          <div style={CARD}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <History size={15} color="#6d28d9" />
              <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Equipment history</span>
            </div>
            {device.events?.length ? (
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {device.events.map((e, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid #f9f9fb', fontSize: 12 }}>
                    <span style={{ width: 120, flex: 'none', color: '#6b7280' }}>{fmtDT(e.occurred_at)}</span>
                    <span style={{
                      flex: 'none', background: '#f3f4f6', color: '#4b5563', padding: '1px 7px',
                      borderRadius: 7, fontSize: 10, fontWeight: 600, height: 'fit-content',
                    }}>{e.event_type}</span>
                    <span style={{ flex: 1, minWidth: 0, color: '#6b7280' }}>
                      {e.detail ? Object.entries(e.detail).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(' · ') : e.source}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: '#9ca3af', fontSize: 13 }}>No events recorded yet.</div>
            )}
          </div>
        </div>
      )}

      {showIssue && selected && (
        <IssuePartDialog
          equipmentId={selected}
          tickets={tickets}
          onClose={() => { setShowIssue(false); load(); }}
          onDone={load}
        />
      )}
    </PageShell>
  );
}
