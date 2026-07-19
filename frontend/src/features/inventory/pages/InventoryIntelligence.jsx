// frontend/src/features/inventory/pages/InventoryIntelligence.jsx
import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend } from 'recharts';
import { useToast } from '@/context/ToastContext';


const fmt = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const fmtK = (n) => { const v = parseFloat(n || 0); return v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; };
const tabStyle = (active) => ({ padding: '8px 20px', border: 'none', background: active ? '#6B3FDB' : 'transparent', color: active ? '#fff' : '#6b7280', cursor: 'pointer', borderRadius: 8, fontWeight: active ? 600 : 400, fontSize: 14 });
const cardStyle = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 16 };
const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#6b7280', background: '#fafafa', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' };
const tdStyle = { padding: '10px 16px', fontSize: 13, color: '#111827', borderBottom: '1px solid #f8f8fc' };
const CAT_COLORS = { A: '#6B3FDB', B: '#0891b2', C: '#059669' };
const STATUS_COLORS = { draft: { bg: '#fef3c7', color: '#92400e' }, 'in-transit': { bg: '#dbeafe', color: '#1e40af' }, received: { bg: '#d1fae5', color: '#065f46' }, cancelled: { bg: '#fee2e2', color: '#991b1b' } };

export default function InventoryIntelligence() {
  const toast = useToast();
  const [tab, setTab] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const [selected, setSelected] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [abcData, setAbcData] = useState(null);
  const [slowMovers, setSlowMovers] = useState([]);
  const [landedCosts, setLandedCosts] = useState([]);
  const [abcSubTab, setAbcSubTab] = useState(0);
  const [showNewTransfer, setShowNewTransfer] = useState(false);
  const [showNewLanded, setShowNewLanded] = useState(false);
  const [showReorderSetup, setShowReorderSetup] = useState(false);
  const [ruleItems, setRuleItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [savingRules, setSavingRules] = useState(false);
  const [abcRunning, setAbcRunning] = useState(false);
  const [transferForm, setTransferForm] = useState({ from_warehouse_id: '', to_warehouse_id: '', items: [{ item_id: '', item_name: '', qty: '', unit: 'nos' }] });
  const [landedForm, setLandedForm] = useState({ po_id: '', freight_cost: 0, customs_duty: 0, insurance: 0, other_charges: 0, allocation_method: 'value' });

  const load = useCallback(async () => {
    const [r1, r2, r3, r4, r5] = await Promise.allSettled([
      api.get('/inventory/reorder-alerts'),
      api.get('/inventory/warehouse-transfers'),
      api.get('/inventory/abc-analysis'),
      api.get('/inventory/slow-movers'),
      api.get('/inventory/landed-costs')
    ]);
    setAlerts(r1.status === 'fulfilled' ? (r1.value.data || []) : []);
    setTransfers(r2.status === 'fulfilled' ? (r2.value.data || []) : []);
    setAbcData(r3.status === 'fulfilled' ? r3.value.data : null);
    setSlowMovers(r4.status === 'fulfilled' ? (r4.value.data || []) : []);
    setLandedCosts(r5.status === 'fulfilled' ? (r5.value.data || []) : []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const generatePOs = async () => {
    const ids = selected.length > 0 ? selected : alerts.map(a => a.id);
    try {
      const res = await api.post('/inventory/reorder-alerts/generate-pos', { item_ids: ids });
      const created = res.data.purchase_orders?.length || 0;
      const failed = res.data.failed_count || 0;
      if (failed > 0) {
        toast.success(`${created} PR(s) created; ${failed} item(s) failed — check backend logs`);
      } else {
        toast.success(`${created} purchase request(s) created successfully`);
      }
      setSelected([]);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to generate purchase requests');
    }
  };

  const runAbc = async () => {
    setAbcRunning(true);
    try {
      const res = await api.post('/inventory/abc-analysis/run');
      setAbcData(res.data);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'ABC analysis run failed');
      setAbcData(null);
    } finally { setAbcRunning(false); }
  };

  const dispatchTransfer = async (id) => {
    try {
      await api.put(`/inventory/warehouse-transfers/${id}/dispatch`);
      toast.success('Transfer dispatched');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to dispatch transfer');
    }
  };

  const receiveTransfer = async (id) => {
    try {
      await api.put(`/inventory/warehouse-transfers/${id}/receive`);
      toast.success('Transfer received');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to receive transfer');
    }
  };

  const createTransfer = async () => {
    try {
      await api.post('/inventory/warehouse-transfers', transferForm);
      setShowNewTransfer(false);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to create transfer');
    }
  };

  const createLandedCost = async () => {
    try {
      await api.post('/inventory/landed-costs', landedForm);
      setShowNewLanded(false);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to save landed cost');
    }
  };

  const allocateLanded = async (id) => {
    try {
      const res = await api.post(`/inventory/landed-costs/${id}/allocate`);
      toast.success(`Costs allocated to ${res.data.allocated_items?.length || 0} item(s)`);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to allocate landed costs');
    }
  };

  const openRuleSetup = async () => {
    setShowReorderSetup(true);
    try {
      const [itemsRes, vendorsRes] = await Promise.allSettled([
        api.get('/inventory/items'),
        api.get('/inventory/vendors-list').catch(() => api.get('/procurement/vendors')),
      ]);
      const rawItems = itemsRes.status === 'fulfilled' ? (itemsRes.value.data?.items || itemsRes.value.data || []) : [];
      setRuleItems(rawItems.map(it => ({
        id: it.id,
        item_code: it.item_code,
        item_name: it.item_name,
        reorder_level: it.reorder_level ?? 0,
        lead_time_days: it.lead_time_days ?? 7,
        preferred_vendor_id: it.preferred_vendor_id ?? '',
      })));
      const rawVendors = vendorsRes.status === 'fulfilled'
        ? (vendorsRes.value.data?.vendors || vendorsRes.value.data?.data || vendorsRes.value.data || [])
        : [];
      setVendors(rawVendors);
    } catch (err) {
      toast.error('Failed to load items for rule setup');
    }
  };

  const saveRule = async (item) => {
    setSavingRules(true);
    try {
      await api.put(`/inventory/items/${item.id}`, {
        reorder_level: item.reorder_level,
        lead_time_days: item.lead_time_days,
        preferred_vendor_id: item.preferred_vendor_id || null,
      });
      toast.success(`Rules saved for ${item.item_name}`);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to save rule');
    } finally {
      setSavingRules(false);
    }
  };

  const toggleSelect = (id) => setSelected(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  const abcPieData = abcData?.stats ? Object.entries(abcData.stats).map(([cat, s]) => ({ name: `Category ${cat}`, value: s.value, count: s.count })) : [];

  return (
    <div style={{ padding: '24px', background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#111827', margin: 0 }}>Inventory Intelligence</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Reorder alerts, transfers, ABC analysis & landed costs</p>
      </div>

      <div style={{ display: 'flex', gap: 4, background: '#f0ebff', padding: 4, borderRadius: 10, marginBottom: 24, width: 'fit-content' }}>
        {['Reorder Alerts', 'Warehouse Transfers', 'ABC Analysis', 'Landed Costs'].map((t, i) => (
          <button key={i} style={tabStyle(tab === i)} onClick={() => setTab(i)}>{t}</button>
        ))}
      </div>

      {tab === 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={generatePOs} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                Auto-Generate POs {selected.length > 0 ? `(${selected.length})` : '(All)'}
              </button>
              <button onClick={openRuleSetup} style={{ padding: '8px 16px', background: '#fff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                Configure Rules
              </button>
            </div>
            <span style={{ fontSize: 13, color: '#6b7280' }}>{alerts.length} items below reorder point</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12, marginBottom: 16 }}>
            {alerts.map((a, i) => {
              const stockPct = a.reorder_point > 0 ? (a.current_stock / a.reorder_point) * 100 : 0;
              return (
                <div key={i} style={{ background: '#fff', border: `2px solid ${selected.includes(a.id) ? '#6B3FDB' : '#f0f0f4'}`, borderRadius: 12, padding: 16, cursor: 'pointer' }} onClick={() => toggleSelect(a.id)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{a.item_name}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{a.item_code} · {a.warehouse_name}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {selected.includes(a.id) && <span style={{ padding: '2px 8px', background: '#6B3FDB', color: '#fff', borderRadius: 4, fontSize: 11 }}>Selected</span>}
                      <span style={{ padding: '2px 8px', background: '#fef3c7', color: '#92400e', borderRadius: 4, fontSize: 11 }}>{a.lead_time_days}d lead</span>
                    </div>
                  </div>

                  <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>Current Stock</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: '#dc2626' }}>{a.current_stock.toLocaleString('en-IN')}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>Reorder Point</div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{a.reorder_point.toLocaleString('en-IN')}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>Shortfall</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#ef4444' }}>-{a.shortfall.toLocaleString('en-IN')}</div>
                    </div>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <div style={{ height: 6, background: '#fee2e2', borderRadius: 4 }}>
                      <div style={{ width: `${Math.min(stockPct, 100)}%`, height: '100%', background: stockPct < 30 ? '#dc2626' : '#f59e0b', borderRadius: 4 }} />
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>{stockPct.toFixed(0)}% of reorder point</div>
                  </div>

                  <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                      Suggest PO: <strong>{a.reorder_qty.toLocaleString('en-IN')}</strong> units via {a.vendor_name || 'No vendor'}
                    </div>
                    {a.auto_create_po && <span style={{ padding: '2px 6px', background: '#d1fae5', color: '#065f46', borderRadius: 4, fontSize: 10 }}>Auto PO</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 1 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button onClick={() => setShowNewTransfer(true)} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
              + New Transfer
            </button>
          </div>

          {showNewTransfer && (
            <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>New Warehouse Transfer</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {[['From Warehouse ID', 'from_warehouse_id'], ['To Warehouse ID', 'to_warehouse_id']].map(([label, key]) => (
                  <div key={key}>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{label}</label>
                    <input type="number" value={transferForm[key]} onChange={e => setTransferForm(p => ({ ...p, [key]: e.target.value }))}
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Items</div>
                {transferForm.items.map((item, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 8, marginBottom: 8 }}>
                    <input placeholder="Item Name" value={item.item_name} onChange={e => { const items = [...transferForm.items]; items[idx].item_name = e.target.value; setTransferForm(p => ({ ...p, items })); }}
                      style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }} />
                    <input type="number" placeholder="Qty" value={item.qty} onChange={e => { const items = [...transferForm.items]; items[idx].qty = e.target.value; setTransferForm(p => ({ ...p, items })); }}
                      style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }} />
                    <input placeholder="Unit" value={item.unit} onChange={e => { const items = [...transferForm.items]; items[idx].unit = e.target.value; setTransferForm(p => ({ ...p, items })); }}
                      style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }} />
                    <button onClick={() => { const items = transferForm.items.filter((_, ii) => ii !== idx); setTransferForm(p => ({ ...p, items })); }}
                      style={{ padding: '8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 8, cursor: 'pointer' }}>✕</button>
                  </div>
                ))}
                <button onClick={() => setTransferForm(p => ({ ...p, items: [...p.items, { item_id: '', item_name: '', qty: '', unit: 'nos' }] }))}
                  style={{ padding: '6px 12px', background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
                  + Add Item
                </button>
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button onClick={createTransfer} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Create Transfer</button>
                <button onClick={() => setShowNewTransfer(false)} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Transfer #', 'From', 'To', 'Items', 'Status', 'Transfer Date', 'Received', 'Actions'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {transfers.map((t, i) => {
                  const sc = STATUS_COLORS[t.status] || { bg: '#f5f3ff', color: '#6B3FDB' };
                  return (
                    <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{t.transfer_number}</td>
                      <td style={tdStyle}>{t.from_warehouse}</td>
                      <td style={tdStyle}>{t.to_warehouse}</td>
                      <td style={tdStyle}>{Array.isArray(t.items) ? t.items.map(item => `${item.item_name} (${item.qty} ${item.unit})`).join(', ') : '-'}</td>
                      <td style={tdStyle}><span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: sc.bg, color: sc.color }}>{t.status}</span></td>
                      <td style={tdStyle}>{t.transfer_date ? new Date(t.transfer_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '-'}</td>
                      <td style={tdStyle}>{t.received_date ? new Date(t.received_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '-'}</td>
                      <td style={tdStyle}>
                        {t.status === 'draft' && <button onClick={() => dispatchTransfer(t.id)} style={{ padding: '4px 10px', background: '#dbeafe', color: '#1e40af', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, marginRight: 4 }}>Dispatch</button>}
                        {t.status === 'in-transit' && <button onClick={() => receiveTransfer(t.id)} style={{ padding: '4px 10px', background: '#d1fae5', color: '#065f46', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Receive</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 2 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 4, background: '#f0ebff', padding: 4, borderRadius: 8 }}>
              <button style={{ padding: '6px 16px', border: 'none', background: abcSubTab === 0 ? '#6B3FDB' : 'transparent', color: abcSubTab === 0 ? '#fff' : '#6b7280', borderRadius: 6, cursor: 'pointer', fontSize: 13 }} onClick={() => setAbcSubTab(0)}>ABC Categories</button>
              <button style={{ padding: '6px 16px', border: 'none', background: abcSubTab === 1 ? '#6B3FDB' : 'transparent', color: abcSubTab === 1 ? '#fff' : '#6b7280', borderRadius: 6, cursor: 'pointer', fontSize: 13 }} onClick={() => setAbcSubTab(1)}>Slow Movers</button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {abcData?.last_computed && <span style={{ fontSize: 12, color: '#6b7280' }}>Last run: {new Date(abcData.last_computed).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>}
              <button onClick={runAbc} disabled={abcRunning} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                {abcRunning ? 'Running...' : 'Run Analysis'}
              </button>
            </div>
          </div>

          {abcSubTab === 0 && abcData && (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
                {['A', 'B', 'C'].map(cat => {
                  const s = abcData.stats?.[cat] || { count: 0, value: 0 };
                  return (
                    <div key={cat} style={{ background: '#fff', border: `2px solid ${CAT_COLORS[cat]}`, borderRadius: 12, padding: 20 }}>
                      <div style={{ fontSize: 32, fontWeight: 800, color: CAT_COLORS[cat] }}>Category {cat}</div>
                      <div style={{ fontSize: 24, fontWeight: 700, color: '#111827', marginTop: 4 }}>{s.count} items</div>
                      <div style={{ fontSize: 16, color: '#6b7280', marginTop: 2 }}>{fmtK(s.value)} annual value</div>
                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>{cat === 'A' ? 'Top 70% value → high control' : cat === 'B' ? '20% value → moderate control' : 'Bottom 10% → minimal control'}</div>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, marginBottom: 16 }}>
                <div style={{ ...cardStyle, padding: 16, marginBottom: 0 }}>
                  <h4 style={{ margin: '0 0 12px', fontSize: 14 }}>Value Distribution</h4>
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={abcPieData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name }) => name}>
                        {abcPieData.map((_, i) => <Cell key={i} fill={Object.values(CAT_COLORS)[i]} />)}
                      </Pie>
                      <Tooltip formatter={(v) => fmtK(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>

                <div style={cardStyle}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>{['#', 'Item Code', 'Item Name', 'Annual Value', 'Cumulative %', 'Category'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                    <tbody>
                      {(abcData.items || []).map((item, i) => (
                        <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                          <td style={{ ...tdStyle, color: '#9ca3af' }}>{i + 1}</td>
                          <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>{item.item_code}</td>
                          <td style={tdStyle}>{item.item_name}</td>
                          <td style={{ ...tdStyle, fontWeight: 600 }}>{fmtK(item.annual_consumption_value)}</td>
                          <td style={tdStyle}>{parseFloat(item.cumulative_pct).toFixed(1)}%</td>
                          <td style={tdStyle}>
                            <span style={{ padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, background: `${CAT_COLORS[item.category]}20`, color: CAT_COLORS[item.category] }}>{item.category}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {abcSubTab === 1 && (
            <div style={cardStyle}>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f4', background: '#fef3c7', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18 }}>⚠️</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: '#92400e' }}>Slow Moving Inventory</div>
                  <div style={{ fontSize: 12, color: '#b45309' }}>Items with no movement in last 90 days — {fmt(slowMovers.reduce((s, i) => s + parseFloat(i.stock_value || 0), 0))} at risk</div>
                </div>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Item Code', 'Item Name', 'Stock', 'Unit Cost', 'Stock Value', 'Last Movement'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                <tbody>
                  {slowMovers.map((s, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>{s.item_code}</td>
                      <td style={tdStyle}>{s.item_name}</td>
                      <td style={tdStyle}>{s.current_stock?.toLocaleString('en-IN')}</td>
                      <td style={tdStyle}>{fmt(s.unit_cost)}</td>
                      <td style={{ ...tdStyle, fontWeight: 600, color: '#dc2626' }}>{fmt(s.stock_value)}</td>
                      <td style={tdStyle}>{s.last_movement_date ? new Date(s.last_movement_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'Never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 3 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button onClick={() => setShowNewLanded(true)} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
              + New Landed Cost
            </button>
          </div>

          {showNewLanded && (
            <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>New Landed Cost Entry</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {[
                  { label: 'PO ID', key: 'po_id', type: 'number' },
                  { label: 'Freight Cost', key: 'freight_cost', type: 'number' },
                  { label: 'Customs Duty', key: 'customs_duty', type: 'number' },
                  { label: 'Insurance', key: 'insurance', type: 'number' },
                  { label: 'Other Charges', key: 'other_charges', type: 'number' }
                ].map(f => (
                  <div key={f.key}>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{f.label}</label>
                    <input type={f.type} value={landedForm[f.key]} onChange={e => setLandedForm(p => ({ ...p, [f.key]: e.target.value }))}
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                ))}
                <div>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Allocation Method</label>
                  <select value={landedForm.allocation_method} onChange={e => setLandedForm(p => ({ ...p, allocation_method: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                    <option value="value">By Value</option>
                    <option value="qty">By Quantity</option>
                    <option value="weight">By Weight</option>
                  </select>
                </div>
              </div>
              <div style={{ marginTop: 12, padding: '12px 16px', background: '#f0ebff', borderRadius: 8, fontSize: 13 }}>
                Total Landed Cost: <strong>{fmt(Object.keys(landedForm).filter(k => ['freight_cost','customs_duty','insurance','other_charges'].includes(k)).reduce((s, k) => s + parseFloat(landedForm[k] || 0), 0))}</strong>
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button onClick={createLandedCost} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Save & Preview Allocation</button>
                <button onClick={() => setShowNewLanded(false)} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['PO Number', 'Vendor', 'Freight', 'Customs', 'Insurance', 'Other', 'Total', 'Method', 'Status', 'Actions'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {landedCosts.map((lc, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>{lc.po_number || `PO-${lc.po_id}`}</td>
                    <td style={tdStyle}>{lc.vendor_name || '-'}</td>
                    <td style={tdStyle}>{fmt(lc.freight_cost)}</td>
                    <td style={tdStyle}>{fmt(lc.customs_duty)}</td>
                    <td style={tdStyle}>{fmt(lc.insurance)}</td>
                    <td style={tdStyle}>{fmt(lc.other_charges)}</td>
                    <td style={{ ...tdStyle, fontWeight: 700, color: '#6B3FDB' }}>{fmt(lc.total_landed_cost)}</td>
                    <td style={tdStyle}>{lc.allocation_method}</td>
                    <td style={tdStyle}><span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: lc.status === 'allocated' ? '#d1fae5' : '#fef3c7', color: lc.status === 'allocated' ? '#065f46' : '#92400e' }}>{lc.status}</span></td>
                    <td style={tdStyle}>
                      {lc.status !== 'allocated' && (
                        <button onClick={() => allocateLanded(lc.id)} style={{ padding: '4px 10px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Allocate</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {showReorderSetup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '90vw', maxWidth: 860, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Configure Reorder Rules</h2>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Set reorder level, lead time, and preferred vendor per item</p>
              </div>
              <button onClick={() => setShowReorderSetup(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0 }}>
                  <tr>
                    {['Code', 'Item Name', 'Reorder Level', 'Lead Time (days)', 'Preferred Vendor', ''].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ruleItems.map((item, i) => (
                    <tr key={item.id} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>{item.item_code}</td>
                      <td style={tdStyle}>{item.item_name}</td>
                      <td style={tdStyle}>
                        <input type="number" min="0" value={item.reorder_level}
                          onChange={e => setRuleItems(prev => prev.map((it, ii) => ii === i ? { ...it, reorder_level: e.target.value } : it))}
                          style={{ width: 80, padding: '4px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13 }} />
                      </td>
                      <td style={tdStyle}>
                        <input type="number" min="1" value={item.lead_time_days}
                          onChange={e => setRuleItems(prev => prev.map((it, ii) => ii === i ? { ...it, lead_time_days: e.target.value } : it))}
                          style={{ width: 80, padding: '4px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13 }} />
                      </td>
                      <td style={tdStyle}>
                        <select value={item.preferred_vendor_id || ''}
                          onChange={e => setRuleItems(prev => prev.map((it, ii) => ii === i ? { ...it, preferred_vendor_id: e.target.value } : it))}
                          style={{ padding: '4px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, minWidth: 140 }}>
                          <option value="">— No vendor —</option>
                          {vendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name || v.name}</option>)}
                        </select>
                      </td>
                      <td style={tdStyle}>
                        <button onClick={() => saveRule(item)} disabled={savingRules}
                          style={{ padding: '4px 12px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
                          Save
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ruleItems.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading items…</div>
              )}
            </div>
            <div style={{ padding: '16px 24px', borderTop: '1px solid #f0f0f4', display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowReorderSetup(false)} style={{ padding: '8px 20px', background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
