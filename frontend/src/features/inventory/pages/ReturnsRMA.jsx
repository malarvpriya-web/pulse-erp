// frontend/src/features/inventory/pages/ReturnsRMA.jsx
//
// Customer returns: raise against what an order actually shipped, receive line
// by line with an explicit disposition, close with the credit note.
//
// The disposition is the whole point. A return that is scrapped must NOT walk
// back into available stock — that is how rejected material finds its way onto
// the shop floor — so only a 'restock' line that passed QC goes back into stock;
// every other disposition quarantines the lot. Those rules live in the API
// (POST /scm/returns/:id/receive). This screen used to raise returns without
// lines (always refused), receive with an empty body, and send a disposition at
// close that the API dropped; it now speaks the API's actual contract, shows
// every server refusal, and reports success only once the server confirms it.
import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  KPI, Panel, Pill, DataTable, useFetch,
  card, btnP, btnS, input, INK, MUT, BAD, fmt, inr,
} from '@/features/_shared/scmKit';

const DISPOSITIONS = [
  { v: 'restock', l: 'Restock — back to available stock (QC pass only)' },
  { v: 'repair',  l: 'Repair — quarantine, not restocked' },
  { v: 'scrap',   l: 'Scrap — quarantine, never restock' },
  { v: 'replace', l: 'Replace — quarantine; replacement issued separately' },
];

// The server's refusal, as it said it — never a generic "failed".
const serverError = (e) => {
  const d = e?.response?.data;
  if (d?.error) return d.code ? `${d.error} (${d.code})` : d.error;
  return e?.message || 'Request failed';
};

function ErrorBox({ text }) {
  if (!text) return null;
  return (
    <div role="alert" style={{ color: BAD, fontSize: 12, margin: '8px 0', padding: '6px 10px',
                               border: `1px solid ${BAD}33`, borderRadius: 8, background: '#fef2f2' }}>
      {text}
    </div>
  );
}

/* ── Raise ─────────────────────────────────────────────────────────────────── */
function RaiseReturn({ orderOptions, onRaised }) {
  const toast = useToast();
  const [orderId, setOrderId] = useState('');
  const [eligible, setEligible] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [qty, setQty] = useState({});          // item_id → quantity (non-serial)
  const [serials, setSerials] = useState({});  // serial id → true
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const pickOrder = async (id) => {
    setOrderId(id); setEligible(null); setQty({}); setSerials({}); setError(null); setLoadError(null);
    if (!id) return;
    try {
      const { data } = await api.get('/scm/returns/eligible', { params: { sales_order_id: Number(id) } });
      setEligible(data);
    } catch (e) { setLoadError(serverError(e)); }
  };

  const items = eligible?.items || [];
  const lines = [];
  const problems = [];
  for (const it of items) {
    const bySerial = it.serial_tracked && it.serials?.length;
    if (bySerial) {
      const chosen = it.serials.filter(s => serials[s.id]);
      if (chosen.length > it.requestable_qty) problems.push(`${it.item_name}: ${chosen.length} chosen, only ${it.requestable_qty} returnable.`);
      for (const s of chosen) lines.push({ item_id: it.item_id, serial_id: s.id, quantity: 1 });
    } else if (qty[it.item_id] !== undefined && qty[it.item_id] !== '') {
      const q = Number(qty[it.item_id]);
      if (!(q > 0)) problems.push(`${it.item_name}: quantity must be greater than zero.`);
      else if (q > it.requestable_qty) problems.push(`${it.item_name}: ${q} requested, only ${it.requestable_qty} returnable.`);
      else lines.push({ item_id: it.item_id, quantity: q });
    }
  }

  const raise = async () => {
    setError(null);
    if (!orderId) { setError('Pick the order being returned against.'); return; }
    if (problems.length) { setError(problems.join(' ')); return; }
    if (!lines.length) { setError('Enter a quantity for at least one item.'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/scm/returns', { sales_order_id: Number(orderId), reason: reason || null, lines });
      toast?.success?.(`Return ${data.rma_number} raised`);
      setReason(''); await pickOrder('');
      onRaised();
    } catch (e) { setError(serverError(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>Raise a return</div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ fontSize: 12, color: MUT }}>Against order
          <select aria-label="Against order" value={orderId} onChange={e => pickOrder(e.target.value)}
                  style={{ ...input, display: 'block', marginTop: 2, minWidth: 260 }}>
            <option value="">Select a sales order…</option>
            {orderOptions.map(o => (
              <option key={o.id} value={o.id}>{o.order_number} — {o.customer_name}</option>))}
          </select>
        </label>
        <label style={{ fontSize: 12, color: MUT, flex: '1 1 240px' }}>Reason
          <input aria-label="Reason" value={reason} onChange={e => setReason(e.target.value)}
                 style={{ ...input, display: 'block', marginTop: 2, width: '100%' }} />
        </label>
      </div>
      <ErrorBox text={loadError} />
      {eligible && !items.length && (
        <div style={{ fontSize: 12, color: MUT, marginTop: 10 }}>
          Nothing on this order left stock through a dispatched pick list, so there is nothing to return against it.
        </div>
      )}
      {items.length > 0 && (
        <table style={{ width: '100%', fontSize: 12, marginTop: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: MUT, textAlign: 'left' }}>
              <th>Item</th><th style={{ textAlign: 'right' }}>Shipped</th><th style={{ textAlign: 'right' }}>Returned</th>
              <th style={{ textAlign: 'right' }}>On open returns</th><th style={{ textAlign: 'right' }}>Returnable</th><th>Return</th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.item_id}>
                <td>{it.item_name}</td>
                <td style={{ textAlign: 'right' }}>{fmt(it.shipped_qty, 2)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(it.restocked_qty, 2)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(it.open_requested_qty, 2)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(it.requestable_qty, 2)}</td>
                <td>
                  {it.serial_tracked && it.serials?.length ? (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {it.serials.map(s => (
                        <label key={s.id} style={{ fontSize: 12 }}>
                          <input type="checkbox" checked={!!serials[s.id]} disabled={it.requestable_qty <= 0}
                                 onChange={e => setSerials({ ...serials, [s.id]: e.target.checked })} /> {s.serial_number}
                        </label>))}
                    </div>
                  ) : (
                    <input type="number" min={0} max={it.requestable_qty} step="any" aria-label={`Quantity of ${it.item_name}`}
                           value={qty[it.item_id] ?? ''} disabled={it.requestable_qty <= 0}
                           onChange={e => setQty({ ...qty, [it.item_id]: e.target.value })}
                           style={{ ...input, width: 100 }} />
                  )}
                </td>
              </tr>))}
          </tbody>
        </table>
      )}
      <ErrorBox text={error} />
      <button style={{ ...btnP, marginTop: 10 }} onClick={raise} disabled={busy || !orderId}>
        {busy ? 'Raising…' : 'Raise return'}
      </button>
    </div>
  );
}

/* ── Receive ───────────────────────────────────────────────────────────────── */
function ReceiptForm({ ret, onDone, onCancel }) {
  const toast = useToast();
  // A return may be received in parts (Phase 3G); each line once.
  const lines = (Array.isArray(ret.items) ? ret.items : []).filter(l => l.received_qty == null);
  const wh = useFetch('/scm/returns/eligible', { params: { sales_order_id: ret.sales_order_id }, enabled: !!ret.sales_order_id });
  const warehouses = wh.data?.warehouses || [];
  const [state, setState] = useState(() => Object.fromEntries(lines.map(l => [l.id,
    { received_qty: String(Number(l.quantity)), disposition: '', qc_result: '', warehouse_id: '' }])));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (id, patch) => setState(s => ({ ...s, [id]: { ...s[id], ...patch } }));

  const submit = async () => {
    setError(null);
    const problems = [];
    const body = lines.map(l => {
      const v = state[l.id];
      const q = Number(v.received_qty);
      if (!Number.isFinite(q) || q < 0 || q > Number(l.quantity)) problems.push(`${l.item_name || `Line ${l.id}`}: received quantity must be between 0 and ${Number(l.quantity)}.`);
      if (!v.disposition) problems.push(`${l.item_name || `Line ${l.id}`}: choose a disposition.`);
      if (!v.qc_result) problems.push(`${l.item_name || `Line ${l.id}`}: record the QC result.`);
      return { id: l.id, received_qty: q, disposition: v.disposition, qc_result: v.qc_result,
               ...(v.disposition === 'restock' && v.warehouse_id ? { warehouse_id: Number(v.warehouse_id) } : {}) };
    });
    if (problems.length) { setError(problems.join(' ')); return; }
    setBusy(true);
    try {
      const { data } = await api.post(`/scm/returns/${ret.id}/receive`, { lines: body });
      const back = (data.restocked || []).reduce((s, r) => s + Number(r.qty || 0), 0);
      toast?.success?.(back > 0
        ? `Received — ${+back.toFixed(4)} unit(s) back in stock`
        : 'Received — nothing restocked (quarantined or failed QC)');
      onDone();
    } catch (e) { setError(serverError(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, marginTop: 16 }} aria-label={`Receive ${ret.rma_number}`}>
      <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>Receive {ret.rma_number}</div>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: MUT, textAlign: 'left' }}>
            <th>Item</th><th style={{ textAlign: 'right' }}>On return</th><th>Received</th><th>Disposition</th><th>QC</th><th>Warehouse</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(l => {
            const v = state[l.id];
            const serial = l.serial_id != null;
            return (
              <tr key={l.id}>
                <td>{l.item_name || `Item ${l.item_id}`}{serial ? ` · ${l.serial_number || `serial ${l.serial_id}`}` : ''}</td>
                <td style={{ textAlign: 'right' }}>{fmt(l.quantity, 2)}</td>
                <td>
                  <input type="number" min={0} max={Number(l.quantity)} step="any" aria-label={`Received quantity, line ${l.id}`}
                         value={v.received_qty} onChange={e => set(l.id, { received_qty: e.target.value })}
                         style={{ ...input, width: 90 }} />
                </td>
                <td>
                  <select aria-label={`Disposition, line ${l.id}`} value={v.disposition}
                          onChange={e => set(l.id, { disposition: e.target.value })} style={{ ...input, fontSize: 12 }}>
                    <option value="">Choose…</option>
                    {DISPOSITIONS.map(d => (
                      <option key={d.v} value={d.v} disabled={serial && d.v === 'restock'}>{d.l}</option>))}
                  </select>
                  {serial && <div style={{ fontSize: 11, color: MUT }}>Serialised units stay out of usable stock until inspected.</div>}
                </td>
                <td>
                  <select aria-label={`QC result, line ${l.id}`} value={v.qc_result}
                          onChange={e => set(l.id, { qc_result: e.target.value })} style={{ ...input, fontSize: 12 }}>
                    <option value="">Choose…</option>
                    <option value="pass">Pass</option>
                    <option value="fail">Fail</option>
                  </select>
                </td>
                <td>
                  <select aria-label={`Warehouse, line ${l.id}`} value={v.warehouse_id} disabled={v.disposition !== 'restock'}
                          onChange={e => set(l.id, { warehouse_id: e.target.value })} style={{ ...input, fontSize: 12 }}>
                    <option value="">Where it shipped from</option>
                    {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </td>
              </tr>);
          })}
        </tbody>
      </table>
      <ErrorBox text={error || wh.error} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button style={btnP} onClick={submit} disabled={busy || !lines.length}>{busy ? 'Recording…' : 'Record receipt'}</button>
        <button style={btnS} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

/* ── Close ─────────────────────────────────────────────────────────────────── */
function CloseForm({ ret, onDone, onCancel }) {
  const toast = useToast();
  const notes = useFetch('/finance/credit-notes', { params: { limit: 200 } });
  // Only an issued note can be linked (a draft can still change or be cancelled).
  const list = (notes.data?.data || []).filter(n => n.status === 'issued');
  const [creditNote, setCreditNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null); setBusy(true);
    try {
      await api.post(`/scm/returns/${ret.id}/close`, creditNote ? { credit_note_id: Number(creditNote) } : {});
      toast?.success?.(`Return ${ret.rma_number} closed`);
      onDone();
    } catch (e) { setError(serverError(e)); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ ...card, marginTop: 16 }} aria-label={`Close ${ret.rma_number}`}>
      <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>Close {ret.rma_number}</div>
      <label style={{ fontSize: 12, color: MUT }}>Credit note
        <select aria-label="Credit note" value={creditNote} onChange={e => setCreditNote(e.target.value)}
                style={{ ...input, display: 'block', marginTop: 2, minWidth: 260 }}>
          <option value="">No credit note</option>
          {list.map(n => (
            <option key={n.id} value={n.id}>
              {n.credit_note_number} — {n.original_invoice_number || 'no invoice'} · {n.status}
            </option>))}
        </select>
      </label>
      <ErrorBox text={error || notes.error} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button style={btnP} onClick={submit} disabled={busy}>{busy ? 'Closing…' : 'Close return'}</button>
        <button style={btnS} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

/* ── Withdraw ──────────────────────────────────────────────────────────────── */
// The one way to end a return with nothing received (the customer kept the
// goods, the RMA was raised in error). Needs approval rights on the server.
function WithdrawForm({ ret, onDone, onCancel }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null);
    if (!reason.trim()) { setError('Give the reason nothing will come back.'); return; }
    setBusy(true);
    try {
      await api.post(`/scm/returns/${ret.id}/withdraw`, { reason: reason.trim() });
      toast?.success?.(`Return ${ret.rma_number} withdrawn`);
      onDone();
    } catch (e) { setError(serverError(e)); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ ...card, marginTop: 16 }} aria-label={`Withdraw ${ret.rma_number}`}>
      <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>Withdraw {ret.rma_number}</div>
      <div style={{ fontSize: 12, color: MUT, marginBottom: 8 }}>
        Closes the return with nothing received: no stock moves and no credit note is linked.
      </div>
      <label style={{ fontSize: 12, color: MUT }}>Reason
        <input aria-label="Withdrawal reason" value={reason} onChange={e => setReason(e.target.value)}
               style={{ ...input, display: 'block', marginTop: 2, width: '100%' }} />
      </label>
      <ErrorBox text={error} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button style={btnP} onClick={submit} disabled={busy}>{busy ? 'Withdrawing…' : 'Withdraw return'}</button>
        <button style={btnS} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

export default function ReturnsRMA() {
  const returns = useFetch('/scm/returns');
  const orders  = useFetch('/sales/orders', { params: { limit: 200 } });
  const [receiving, setReceiving] = useState(null);
  const [closing, setClosing] = useState(null);
  const [withdrawing, setWithdrawing] = useState(null);

  const rows = returns.data?.returns || (Array.isArray(returns.data) ? returns.data : []);
  const orderOptions = (orders.data?.orders || orders.data?.data || (Array.isArray(orders.data) ? orders.data : [])).slice(0, 200);
  const open = rows.filter(r => !['closed', 'cancelled'].includes(String(r.status || '').toLowerCase()));
  const lineCount = (d) => rows.reduce((s, r) => s + (r.items || []).filter(i => i.disposition === d).length, 0);
  const done = () => { setReceiving(null); setClosing(null); setWithdrawing(null); returns.refetch(); };
  const openOnly = (setter) => (r) => { setReceiving(null); setClosing(null); setWithdrawing(null); setter(r); };

  return (
    <PageShell dock={
      <PageHero
        icon={Undo2}
        eyebrow="Fulfilment"
        title="Returns & RMA"
        subtitle="Raise against what shipped, receive line by line — the disposition decides what happens to the stock"
      />
    }>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <KPI label="Returns" value={fmt(rows.length)} />
        <KPI label="Open" value={fmt(open.length)} tint="#b45309" />
        <KPI label="Lines restocked" value={fmt(rows.reduce((s, r) => s + (r.items || []).filter(i => Number(i.restocked_qty) > 0).length, 0))} tint="#15803d" />
        <KPI label="Lines scrapped" value={fmt(lineCount('scrap'))} tint="#b91c1c" />
        <KPI label="Value returned" value={inr(rows.reduce((s, r) => s + Number(r.total_value || 0), 0))} />
      </div>

      <RaiseReturn orderOptions={orderOptions} onRaised={returns.refetch} />

      <Panel loading={returns.loading} error={returns.error} empty={!rows.length}
             emptyHint="No customer returns recorded.">
        <DataTable rows={rows} columns={[
          { key: 'rma_number', label: 'RMA', render: r => r.rma_number || `#${r.id}` },
          { key: 'order_number', label: 'Order', render: r => r.order_number || r.sales_order_id },
          { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
          { key: 'quantity', label: 'Qty', align: 'right', render: r => fmt(r.quantity, 2) },
          { key: 'reason', label: 'Reason', render: r => <span style={{ fontSize: 12 }}>{r.reason || '—'}</span> },
          { key: 'status', label: 'Status', render: r => (
            <Pill tone={r.status === 'closed' ? 'ok' : r.status === 'received' ? 'calm' : 'warn'}>
              {r.closed_without_receipt ? 'withdrawn' : String(r.status || '').replace('_', ' ')}
            </Pill>) },
          { key: 'disposition', label: 'Dispositions', render: r => {
            const ds = [...new Set((r.items || []).map(i => i.disposition).filter(Boolean))];
            return ds.length ? ds.map(d => <Pill key={d} tone={d === 'scrap' ? 'bad' : d === 'restock' ? 'ok' : 'warn'}>{d}</Pill>) : '—';
          } },
          { key: 'credit_note_number', label: 'Credit note', render: r => r.credit_note_number || '—' },
          { key: 'created_at', label: 'Raised', render: r => fmtDate(r.created_at) },
          { key: 'act', label: '', render: r => {
            const st = String(r.status || '').toLowerCase();
            if (st === 'closed') return null;
            // Close only once every line is received; a return with nothing
            // received can instead be withdrawn.
            if (st === 'received') return <button style={btnS} onClick={() => openOnly(setClosing)(r)}>Close</button>;
            return (
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={btnS} onClick={() => openOnly(setReceiving)(r)}>Receive</button>
                {st === 'requested' && <button style={btnS} onClick={() => openOnly(setWithdrawing)(r)}>Withdraw</button>}
              </div>
            );
          } },
        ]} />
      </Panel>

      {receiving && <ReceiptForm key={receiving.id} ret={receiving} onDone={done} onCancel={() => setReceiving(null)} />}
      {closing && <CloseForm key={closing.id} ret={closing} onDone={done} onCancel={() => setClosing(null)} />}
      {withdrawing && <WithdrawForm key={withdrawing.id} ret={withdrawing} onDone={done} onCancel={() => setWithdrawing(null)} />}
    </PageShell>
  );
}
