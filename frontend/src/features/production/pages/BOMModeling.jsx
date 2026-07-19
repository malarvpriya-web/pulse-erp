// frontend/src/features/production/pages/BOMModeling.jsx
//
// BOM modeling: mark a BOM as phantom (blow-through in MRP) and manage its
// co-/by-product outputs. Drives /mfg.
import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/context/ToastContext';
import api from '@/services/api/client';

const PURPLE = '#6B3FDB', HEAD = '#4c1d95', INK = '#374151', MUT = '#6b7280';
const card = { background: '#fff', border: '1px solid #ede9fe', borderRadius: 12, padding: 16 };
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: MUT, fontWeight: 700, textTransform: 'uppercase', borderBottom: '2px solid #ede9fe' };
const td = { padding: '8px 10px', fontSize: 13, color: INK, borderBottom: '1px solid #f3f0ff' };
const btnP = { background: PURPLE, color: '#fff', border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontWeight: 700, fontSize: 13 };
const btnS = { background: '#ede9fe', color: PURPLE, border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12 };
const inp = { padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 };

export default function BOMModeling() {
  const toast = useToast();
  const [boms, setBoms] = useState([]);
  const [items, setItems] = useState([]);
  const [sel, setSel] = useState(null);
  const [outputs, setOutputs] = useState([]);
  const [form, setForm] = useState({ item_id: '', output_type: 'co', qty_per_parent: '', cost_share_pct: '' });

  const loadBoms = useCallback(async () => { try { setBoms((await api.get('/mfg/boms')).data || []); } catch { /* */ } }, []);
  const loadItems = useCallback(async () => { try { setItems((await api.get('/mrp/item-planning')).data || []); } catch { /* */ } }, []);
  useEffect(() => { loadBoms(); loadItems(); }, [loadBoms, loadItems]);

  const openBom = async (b) => {
    setSel(b);
    try { setOutputs((await api.get(`/mfg/boms/${b.id}/outputs`)).data || []); } catch { setOutputs([]); }
  };
  const togglePhantom = async (b, val) => {
    try {
      const { data } = await api.patch(`/mfg/boms/${b.id}/phantom`, { is_phantom: val });
      setBoms(list => list.map(x => x.id === b.id ? { ...x, is_phantom: data.is_phantom } : x));
      if (sel?.id === b.id) setSel(s => ({ ...s, is_phantom: data.is_phantom }));
      toast.success(`${b.product_name} phantom ${val ? 'enabled' : 'disabled'}`);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const addOutput = async () => {
    if (!form.item_id || !form.qty_per_parent) return toast.error('Item and qty/parent required');
    const it = items.find(i => String(i.id) === String(form.item_id));
    try {
      await api.post(`/mfg/boms/${sel.id}/outputs`, {
        item_id: Number(form.item_id), item_name: it?.item_name, uom: it?.unit_of_measure,
        output_type: form.output_type, qty_per_parent: Number(form.qty_per_parent), cost_share_pct: Number(form.cost_share_pct || 0),
      });
      setForm({ item_id: '', output_type: 'co', qty_per_parent: '', cost_share_pct: '' });
      openBom(sel); loadBoms(); toast.success('Output added');
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const delOutput = async (oid) => { try { await api.delete(`/mfg/outputs/${oid}`); openBom(sel); loadBoms(); } catch { toast.error('Delete failed'); } };

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ margin: '0 0 4px', color: HEAD, fontSize: 22 }}>🧩 BOM Modeling — Phantom &amp; Co-Products</h2>
        <p style={{ margin: 0, color: MUT, fontSize: 13 }}>Phantom BOMs blow through in MRP (never planned); co-/by-products are stocked in on completion and supply MRP demand</p>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {/* BOM list */}
        <div style={{ ...card, flex: '1 1 420px' }}>
          <h3 style={{ margin: '0 0 10px', color: HEAD, fontSize: 15 }}>BOMs</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Product', 'Ver', 'Phantom', 'Outputs', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {boms.map(b => (
                  <tr key={b.id} style={{ background: sel?.id === b.id ? '#faf8ff' : 'transparent' }}>
                    <td style={{ ...td, fontWeight: 600 }}>{b.product_name}<div style={{ fontSize: 11, color: MUT }}>{b.bom_number}</div></td>
                    <td style={td}>v{b.version}</td>
                    <td style={td}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!b.is_phantom} onChange={e => togglePhantom(b, e.target.checked)} />
                        {b.is_phantom ? <span style={{ color: '#d97706', fontWeight: 700, fontSize: 12 }}>Phantom</span> : <span style={{ color: MUT, fontSize: 12 }}>No</span>}
                      </label>
                    </td>
                    <td style={td}>{b.output_count > 0 ? <span style={{ background: '#ede9fe', color: PURPLE, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>{b.output_count}</span> : '—'}</td>
                    <td style={td}><button style={btnS} onClick={() => openBom(b)}>Manage</button></td>
                  </tr>
                ))}
                {boms.length === 0 && <tr><td style={{ ...td, color: MUT }} colSpan={5}>No BOMs.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* Outputs panel */}
        <div style={{ ...card, flex: '1 1 420px' }}>
          {!sel ? <div style={{ color: MUT, fontSize: 13 }}>Select a BOM to manage its co-/by-product outputs.</div> : (
            <>
              <h3 style={{ margin: '0 0 4px', color: HEAD, fontSize: 15 }}>{sel.product_name} — Outputs</h3>
              <p style={{ margin: '0 0 12px', fontSize: 12, color: MUT }}>Primary output is the BOM product itself. Add additional co-products (main outputs) or by-products (secondary).</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
                <select value={form.item_id} onChange={e => setForm(f => ({ ...f, item_id: e.target.value }))} style={{ ...inp, flex: '1 1 150px' }}>
                  <option value="">Item…</option>{items.map(i => <option key={i.id} value={i.id}>{i.item_name}</option>)}
                </select>
                <select value={form.output_type} onChange={e => setForm(f => ({ ...f, output_type: e.target.value }))} style={inp}>
                  <option value="co">Co-product</option><option value="by">By-product</option>
                </select>
                <input type="number" placeholder="Qty/parent" value={form.qty_per_parent} onChange={e => setForm(f => ({ ...f, qty_per_parent: e.target.value }))} style={{ ...inp, width: 90 }} />
                <input type="number" placeholder="Cost %" value={form.cost_share_pct} onChange={e => setForm(f => ({ ...f, cost_share_pct: e.target.value }))} style={{ ...inp, width: 80 }} />
                <button style={btnP} onClick={addOutput}>Add</button>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Item', 'Type', 'Qty/parent', 'Cost %', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {outputs.map(o => (
                    <tr key={o.id}>
                      <td style={{ ...td, fontWeight: 600 }}>{o.item_name}</td>
                      <td style={td}><span style={{ background: o.output_type === 'by' ? '#fef3c7' : '#e0f2fe', color: o.output_type === 'by' ? '#d97706' : '#0369a1', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>{o.output_type === 'by' ? 'by-product' : 'co-product'}</span></td>
                      <td style={td}>{Number(o.qty_per_parent)}</td>
                      <td style={td}>{Number(o.cost_share_pct)}%</td>
                      <td style={td}><button style={{ ...btnS, background: '#fee2e2', color: '#dc2626' }} onClick={() => delOutput(o.id)}>✕</button></td>
                    </tr>
                  ))}
                  {outputs.length === 0 && <tr><td style={{ ...td, color: MUT }} colSpan={5}>No additional outputs.</td></tr>}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
