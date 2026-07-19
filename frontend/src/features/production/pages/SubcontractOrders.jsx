// frontend/src/features/production/pages/SubcontractOrders.jsx
//
// Subcontracting / job-work orders. Create an order (finished item + component
// materials to send), issue materials to the vendor (stock out), and receive
// finished goods back (stock in). Drives /subcontracting.
import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';

const PURPLE = '#6B3FDB', HEAD = '#4c1d95', INK = '#374151', MUT = '#6b7280';
const card = { background: '#fff', border: '1px solid #ede9fe', borderRadius: 12, padding: 16 };
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: MUT, fontWeight: 700, textTransform: 'uppercase', borderBottom: '2px solid #ede9fe', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', fontSize: 13, color: INK, borderBottom: '1px solid #f3f0ff', whiteSpace: 'nowrap' };
const btnP = { background: PURPLE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 13 };
const btnS = { background: '#ede9fe', color: PURPLE, border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12 };
const inp = { padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 };
const STATUS = {
  draft: ['#f3f4f6', INK], issued: ['#dbeafe', '#2563eb'], materials_issued: ['#fef3c7', '#d97706'],
  partially_received: ['#e0f2fe', '#0369a1'], received: ['#dcfce7', '#16a34a'], closed: ['#dcfce7', '#15803d'], cancelled: ['#fee2e2', '#dc2626'],
};
const chip = (s) => { const [bg, fg] = STATUS[s] || ['#f3f4f6', INK]; return { background: bg, color: fg, padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700, textTransform: 'capitalize' }; };

function KPI({ label, value, tint = PURPLE }) {
  return <div style={{ ...card, flex: '1 1 130px', minWidth: 120 }}>
    <div style={{ fontSize: 24, fontWeight: 800, color: tint, lineHeight: 1 }}>{value}</div>
    <div style={{ fontSize: 12, color: MUT, marginTop: 6 }}>{label}</div>
  </div>;
}

export default function SubcontractOrders() {
  const toast = useToast();
  const [orders, setOrders] = useState([]);
  const [dash, setDash] = useState(null);
  const [items, setItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [filter, setFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [detail, setDetail] = useState(null); // {order, materials, transactions}
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({ item_id: '', vendor_id: '', quantity_ordered: '', service_charge_per_unit: '', expected_date: '', notes: '' });
  const [mats, setMats] = useState([]); // {item_id, qty_per_unit}
  const [recvQty, setRecvQty] = useState('');

  const load = useCallback(async () => {
    try {
      const [o, d] = await Promise.allSettled([
        api.get('/subcontracting/orders', { params: filter ? { status: filter } : {} }),
        api.get('/subcontracting/dashboard'),
      ]);
      if (o.status === 'fulfilled') setOrders(o.value.data || []);
      if (d.status === 'fulfilled') setDash(d.value.data);
    } catch { /* */ }
  }, [filter]);
  const loadRefs = useCallback(async () => {
    try {
      const [it, vn] = await Promise.allSettled([api.get('/mrp/item-planning'), api.get('/subcontracting/vendors')]);
      if (it.status === 'fulfilled') setItems(it.value.data || []);
      if (vn.status === 'fulfilled') setVendors(vn.value.data || []);
    } catch { /* */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadRefs(); }, [loadRefs]);

  const itemById = (id) => items.find(i => String(i.id) === String(id));

  const addMat = () => setMats(m => [...m, { item_id: '', qty_per_unit: '' }]);
  const setMat = (i, k, v) => setMats(m => m.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const rmMat = (i) => setMats(m => m.filter((_, j) => j !== i));

  const submit = async () => {
    if (!form.item_id || !form.quantity_ordered) return toast.error('Finished item and quantity required');
    const fi = itemById(form.item_id);
    setBusy(true);
    try {
      await api.post('/subcontracting/orders', {
        item_id: Number(form.item_id), item_name: fi?.item_name, uom: fi?.unit_of_measure,
        vendor_id: form.vendor_id ? Number(form.vendor_id) : null,
        quantity_ordered: Number(form.quantity_ordered),
        service_charge_per_unit: Number(form.service_charge_per_unit || 0),
        expected_date: form.expected_date || null, notes: form.notes || null,
        materials: mats.filter(m => m.item_id && m.qty_per_unit).map(m => {
          const it = itemById(m.item_id);
          return { item_id: Number(m.item_id), item_name: it?.item_name, uom: it?.unit_of_measure, qty_per_unit: Number(m.qty_per_unit), unit_cost: Number(it?.standard_cost || 0) };
        }),
      });
      toast.success('Subcontract order created');
      setShowCreate(false); setForm({ item_id: '', vendor_id: '', quantity_ordered: '', service_charge_per_unit: '', expected_date: '', notes: '' }); setMats([]);
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Create failed'); }
    finally { setBusy(false); }
  };

  const openDetail = async (id) => {
    try { setDetail((await api.get(`/subcontracting/orders/${id}`)).data); setRecvQty(''); }
    catch { toast.error('Failed to load order'); }
  };
  const act = async (path, body, ok) => {
    setBusy(true);
    try {
      await api.post(`/subcontracting/orders/${detail.order.id}/${path}`, body || {});
      toast.success(ok); await openDetail(detail.order.id); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Action failed'); }
    finally { setBusy(false); }
  };

  const o = detail?.order;

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', color: HEAD, fontSize: 22 }}>🔧 Subcontracting</h2>
          <p style={{ margin: 0, color: MUT, fontSize: 13 }}>Job-work orders — issue materials to a vendor and receive finished goods back</p>
        </div>
        <button style={btnP} onClick={() => setShowCreate(v => !v)}>{showCreate ? 'Close' : '+ New Order'}</button>
      </div>

      {dash && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <KPI label="Total Orders" value={dash.total} />
          <KPI label="Open" value={dash.open} tint="#2563eb" />
          <KPI label="At Vendor" value={dash.at_vendor} tint="#d97706" />
          <KPI label="Completed" value={dash.completed} tint="#16a34a" />
          <KPI label="Open Value" value={`₹${Number(dash.open_value || 0).toLocaleString('en-IN')}`} tint="#7c3aed" />
        </div>
      )}

      {/* CREATE */}
      {showCreate && (
        <div style={{ ...card, marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 12px', color: HEAD, fontSize: 15 }}>New Subcontract Order</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: MUT }}>Finished Item *
              <select value={form.item_id} onChange={e => setForm(f => ({ ...f, item_id: e.target.value }))} style={{ ...inp, display: 'block', marginTop: 3, width: 200 }}>
                <option value="">Select…</option>{items.map(i => <option key={i.id} value={i.id}>{i.item_name}</option>)}
              </select></label>
            <label style={{ fontSize: 12, color: MUT }}>Vendor
              <select value={form.vendor_id} onChange={e => setForm(f => ({ ...f, vendor_id: e.target.value }))} style={{ ...inp, display: 'block', marginTop: 3, width: 180 }}>
                <option value="">Select…</option>{vendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
              </select></label>
            <label style={{ fontSize: 12, color: MUT }}>Quantity *
              <input type="number" value={form.quantity_ordered} onChange={e => setForm(f => ({ ...f, quantity_ordered: e.target.value }))} style={{ ...inp, display: 'block', marginTop: 3, width: 90 }} /></label>
            <label style={{ fontSize: 12, color: MUT }}>Service ₹/unit
              <input type="number" value={form.service_charge_per_unit} onChange={e => setForm(f => ({ ...f, service_charge_per_unit: e.target.value }))} style={{ ...inp, display: 'block', marginTop: 3, width: 100 }} /></label>
            <label style={{ fontSize: 12, color: MUT }}>Expected Date
              <input type="date" value={form.expected_date} onChange={e => setForm(f => ({ ...f, expected_date: e.target.value }))} style={{ ...inp, display: 'block', marginTop: 3 }} /></label>
          </div>
          <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: HEAD }}>Components to send (per finished unit)</span>
            <button style={btnS} onClick={addMat}>+ Add Material</button>
          </div>
          {mats.map((m, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
              <select value={m.item_id} onChange={e => setMat(i, 'item_id', e.target.value)} style={{ ...inp, flex: '1 1 200px' }}>
                <option value="">Material…</option>{items.map(it => <option key={it.id} value={it.id}>{it.item_name}</option>)}
              </select>
              <input type="number" placeholder="Qty/unit" value={m.qty_per_unit} onChange={e => setMat(i, 'qty_per_unit', e.target.value)} style={{ ...inp, width: 100 }} />
              <span style={{ fontSize: 12, color: MUT }}>{itemById(m.item_id)?.unit_of_measure || ''}</span>
              <button style={{ ...btnS, background: '#fee2e2', color: '#dc2626' }} onClick={() => rmMat(i)}>✕</button>
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            <button style={{ ...btnP, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Create Order'}</button>
          </div>
        </div>
      )}

      {/* LIST */}
      <div style={{ ...card, marginBottom: detail ? 16 : 0 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
          <select value={filter} onChange={e => setFilter(e.target.value)} style={{ ...inp, fontSize: 12 }}>
            <option value="">All statuses</option>
            {Object.keys(STATUS).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['SC #', 'Item', 'Vendor', 'Ordered', 'Received', 'Status', 'Expected', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {orders.map(r => (
                <tr key={r.id} style={{ cursor: 'pointer', background: detail?.order?.id === r.id ? '#faf8ff' : 'transparent' }} onClick={() => openDetail(r.id)}>
                  <td style={{ ...td, fontWeight: 700, color: PURPLE }}>{r.sc_number}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{r.item_name}</td>
                  <td style={td}>{r.vendor_name || '—'}</td>
                  <td style={td}>{Number(r.quantity_ordered)}</td>
                  <td style={td}>{Number(r.quantity_received)}</td>
                  <td style={td}><span style={chip(r.status)}>{r.status.replace('_', ' ')}</span></td>
                  <td style={td}>{r.expected_date ? fmtDate(r.expected_date) : '—'}</td>
                  <td style={td}><button style={btnS} onClick={(e) => { e.stopPropagation(); openDetail(r.id); }}>View</button></td>
                </tr>
              ))}
              {orders.length === 0 && <tr><td style={{ ...td, color: MUT }} colSpan={8}>No subcontract orders.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* DETAIL */}
      {o && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0, color: HEAD, fontSize: 16 }}>{o.sc_number} · {o.item_name} <span style={chip(o.status)}>{o.status.replace('_', ' ')}</span></h3>
            <button style={btnS} onClick={() => setDetail(null)}>Close</button>
          </div>
          <div style={{ display: 'flex', gap: 18, margin: '10px 0', fontSize: 13, flexWrap: 'wrap', color: INK }}>
            <span>Vendor: <b>{o.vendor_name || '—'}</b></span>
            <span>Ordered: <b>{Number(o.quantity_ordered)}</b></span>
            <span>Received: <b>{Number(o.quantity_received)}</b></span>
            <span>Service ₹/unit: <b>{Number(o.service_charge_per_unit)}</b></span>
            <span>Material ₹/unit: <b>{Number(o.material_cost_per_unit)}</b></span>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
            {['draft', 'issued'].includes(o.status) && <button style={btnP} disabled={busy} onClick={() => act('issue', { challan_no: `CH-${o.id}` }, 'Materials issued to vendor')}>Issue Materials</button>}
            {['materials_issued', 'partially_received'].includes(o.status) && (
              <>
                <input type="number" placeholder="Recv qty" value={recvQty} onChange={e => setRecvQty(e.target.value)} style={{ ...inp, width: 100 }} />
                <button style={btnP} disabled={busy || !recvQty} onClick={() => act('receive', { quantity: Number(recvQty), challan_no: `RC-${o.id}` }, 'Finished goods received')}>Receive</button>
              </>
            )}
            {['received', 'partially_received'].includes(o.status) && <button style={btnS} disabled={busy} onClick={() => act('close', {}, 'Order closed')}>Close</button>}
            {['draft', 'issued'].includes(o.status) && <button style={{ ...btnS, background: '#fee2e2', color: '#dc2626' }} disabled={busy} onClick={() => act('cancel', {}, 'Order cancelled')}>Cancel</button>}
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 340px' }}>
              <h4 style={{ margin: '0 0 6px', color: HEAD, fontSize: 13 }}>Materials to Send</h4>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Item', 'Qty/unit', 'Required', 'Issued'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {detail.materials.map(m => (
                    <tr key={m.id}><td style={td}>{m.item_name}</td><td style={td}>{Number(m.qty_per_unit)} {m.uom}</td><td style={td}>{Number(m.qty_required)}</td><td style={{ ...td, fontWeight: 600, color: Number(m.qty_issued) > 0 ? '#16a34a' : MUT }}>{Number(m.qty_issued)}</td></tr>
                  ))}
                  {detail.materials.length === 0 && <tr><td style={{ ...td, color: MUT }} colSpan={4}>No materials.</td></tr>}
                </tbody>
              </table>
            </div>
            <div style={{ flex: '1 1 340px' }}>
              <h4 style={{ margin: '0 0 6px', color: HEAD, fontSize: 13 }}>Transactions</h4>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Type', 'Item', 'Qty', 'Challan', 'Date'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {detail.transactions.map(t => (
                    <tr key={t.id}><td style={td}><span style={{ background: t.txn_type === 'material_issue' ? '#fef3c7' : '#dcfce7', color: t.txn_type === 'material_issue' ? '#d97706' : '#16a34a', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>{t.txn_type === 'material_issue' ? 'issue' : 'receipt'}</span></td>
                      <td style={td}>{t.item_name}</td><td style={td}>{Number(t.quantity)}</td><td style={td}>{t.challan_no || '—'}</td><td style={td}>{fmtDate(t.txn_date)}</td></tr>
                  ))}
                  {detail.transactions.length === 0 && <tr><td style={{ ...td, color: MUT }} colSpan={5}>No transactions yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
