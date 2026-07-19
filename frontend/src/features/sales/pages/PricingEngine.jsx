// frontend/src/features/sales/pages/PricingEngine.jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import { formatINR, Badge } from './salesUtils';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const PURPLE = '#6B3FDB';
const LIGHT = '#f5f3ff';
const BORDER = '#e9e4ff';

function Modal({ open, onClose, title, children, width = 540 }) {
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, width, maxWidth: '96vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: '20px 24px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#1a1a2e' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>×</button>
        </div>
        <div style={{ padding: 24 }}>{children}</div>
      </div>
    </div>
  );
}

function Drawer({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ background: '#fff', width: 420, maxWidth: '96vw', height: '100%', overflow: 'auto', boxShadow: '-8px 0 32px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '20px 24px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#6b7280' }}>×</button>
        </div>
        <div style={{ padding: 20, flex: 1, overflow: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

function FormField({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  );
}

function Input(props) {
  return <input {...props} style={{ width: '100%', padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box', ...props.style }} />;
}

function Select({ children, ...props }) {
  return <select {...props} style={{ width: '100%', padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, outline: 'none', background: '#fff', boxSizing: 'border-box', ...props.style }}>{children}</select>;
}

function Btn({ children, onClick, variant = 'primary', size = 'md', disabled = false, style: extra = {} }) {
  const styles = {
    primary: { background: PURPLE, color: '#fff', border: 'none' },
    outline: { background: '#fff', color: PURPLE, border: `1px solid ${PURPLE}` },
    success: { background: '#16a34a', color: '#fff', border: 'none' },
    danger: { background: '#dc2626', color: '#fff', border: 'none' },
    ghost: { background: 'transparent', color: '#6b7280', border: '1px solid #e5e7eb' }
  };
  const sizes = { sm: { padding: '4px 10px', fontSize: 12 }, md: { padding: '8px 16px', fontSize: 14 }, lg: { padding: '10px 20px', fontSize: 15 } };
  return (
    <button onClick={onClick} disabled={disabled} style={{ borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: disabled ? 0.6 : 1, ...styles[variant], ...sizes[size], ...extra }}>
      {children}
    </button>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <div onClick={onChange} style={{ width: 40, height: 22, borderRadius: 11, background: checked ? PURPLE : '#d1d5db', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
      <div style={{ width: 18, height: 18, borderRadius: 9, background: '#fff', position: 'absolute', top: 2, left: checked ? 20 : 2, transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }} />
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div style={{ background: LIGHT, borderRadius: 12, padding: '16px 20px', border: `1px solid ${BORDER}`, minWidth: 160 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: PURPLE }}>{value}</div>
      <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ─── Tab 1: Price Lists ──────────────────────────────────────────────────────

function PriceListsTab() {
  const [lists, setLists] = useState([]);
  const [pendingDeleteList, setPendingDeleteList] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [drawerList, setDrawerList] = useState(null);
  const [drawerItems, setDrawerItems] = useState([]);
  const [drawerSearch, setDrawerSearch] = useState('');
  const [drawerChanged, setDrawerChanged] = useState(false);
  const [form, setForm] = useState({ name: '', currency: 'INR', applicable_to: 'all', customer_ids: '', valid_from: '', valid_to: '', is_default: false });
  const [saving, setSaving] = useState(false);

  const abortRef = useRef(null);
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const [listsR, statsR] = await Promise.allSettled([
      api.get('/pricing/price-lists', { signal: controller.signal }),
      api.get('/pricing/price-lists/stats', { signal: controller.signal })
    ]);
    if (controller.signal.aborted) return;
    setLists(listsR.status === 'fulfilled' ? (listsR.value.data || []) : []);
    setStats(statsR.status === 'fulfilled' ? statsR.value.data : null);
    setLoading(false);
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const openDrawer = async (pl) => {
    setDrawerList(pl);
    setDrawerSearch('');
    setDrawerChanged(false);
    const [r] = await Promise.allSettled([api.get(`/pricing/price-lists/${pl.id}/items`)]);
    if (!isMounted.current) return;
    setDrawerItems(r.status === 'fulfilled' ? (r.value.data || []) : []);
  };

  const addDrawerItem = () => {
    setDrawerItems(prev => [...prev, { id: Date.now(), item_id: '', item_name: '', base_price: '', min_price: '', uom: 'Nos', _new: true }]);
    setDrawerChanged(true);
  };

  const updateDrawerItem = (idx, field, val) => {
    setDrawerItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: val } : it));
    setDrawerChanged(true);
  };

  const saveDrawerItems = async () => {
    await Promise.allSettled([api.post(`/pricing/price-lists/${drawerList.id}/items`, drawerItems.filter(i => i.item_id))]);
    if (!isMounted.current) return;
    setDrawerChanged(false);
    load();
  };

  const toggleActive = async (pl) => {
    await Promise.allSettled([api.put(`/pricing/price-lists/${pl.id}`, { is_active: !pl.is_active })]);
    if (!isMounted.current) return;
    load();
  };

  const setDefault = async (pl) => {
    await Promise.allSettled([api.put(`/pricing/price-lists/${pl.id}`, { is_default: true })]);
    if (!isMounted.current) return;
    load();
  };

  const deleteList = async () => {
    if (!pendingDeleteList) return;
    const pl = pendingDeleteList;
    setPendingDeleteList(null);
    await Promise.allSettled([api.delete(`/pricing/price-lists/${pl.id}`)]);
    if (!isMounted.current) return;
    load();
  };

  const openNew = () => { setEditItem(null); setForm({ name: '', currency: 'INR', applicable_to: 'all', customer_ids: '', valid_from: '', valid_to: '', is_default: false }); setShowModal(true); };
  const openEdit = (pl) => { setEditItem(pl); setForm({ name: pl.name, currency: pl.currency, applicable_to: pl.applicable_to, customer_ids: (pl.customer_ids || []).join(', '), valid_from: pl.valid_from || '', valid_to: pl.valid_to || '', is_default: pl.is_default }); setShowModal(true); };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const payload = { ...form, customer_ids: form.customer_ids ? form.customer_ids.split(',').map(s => s.trim()).filter(Boolean).map(Number) : [] };
    if (editItem) await Promise.allSettled([api.put(`/pricing/price-lists/${editItem.id}`, payload)]);
    else await Promise.allSettled([api.post('/pricing/price-lists', payload)]);
    if (!isMounted.current) return;
    setSaving(false);
    setShowModal(false);
    load();
  };

  const filtered = drawerItems.filter(it => !drawerSearch || it.item_name?.toLowerCase().includes(drawerSearch.toLowerCase()) || it.item_id?.toLowerCase().includes(drawerSearch.toLowerCase()));

  return (
    <div>
      <ConfirmDialog
        open={!!pendingDeleteList}
        title="Delete Price List"
        message={pendingDeleteList ? `Delete "${pendingDeleteList.name}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteList}
        onCancel={() => setPendingDeleteList(null)}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Price Lists</h2>
        <Btn onClick={openNew}>+ New Price List</Btn>
      </div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <StatCard label="Total Price Lists" value={stats?.total ?? lists.length} />
        <StatCard label="Default List" value={stats?.default_name ?? '—'} />
        <StatCard label="Active Lists" value={stats?.active ?? lists.filter(l => l.is_active).length} />
      </div>

      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: LIGHT }}>
              {['Name', 'Currency', 'Applicable To', 'Valid Period', 'Items', 'Default', 'Active', 'Actions'].map(h => (
                <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Loading...</td></tr>
            ) : lists.map((pl, i) => (
              <tr key={pl.id} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none' }}>
                <td style={{ padding: '12px 16px', fontWeight: 600, color: '#1a1a2e' }}>{pl.name}</td>
                <td style={{ padding: '12px 16px', color: '#374151' }}>{pl.currency}</td>
                <td style={{ padding: '12px 16px' }}>
                  <Badge color={pl.applicable_to === 'all' ? 'purple' : 'blue'}>{pl.applicable_to === 'all' ? 'All Customers' : `Specific (${(pl.customer_ids || []).length})`}</Badge>
                </td>
                <td style={{ padding: '12px 16px', fontSize: 13, color: '#6b7280' }}>{pl.valid_from || '—'} → {pl.valid_to || '—'}</td>
                <td style={{ padding: '12px 16px', color: '#374151' }}>{pl.item_count || 0}</td>
                <td style={{ padding: '12px 16px' }}>{pl.is_default && <Badge color="amber">Default</Badge>}</td>
                <td style={{ padding: '12px 16px' }}><Toggle checked={pl.is_active} onChange={() => toggleActive(pl)} /></td>
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Btn size="sm" variant="outline" onClick={() => openEdit(pl)}>Edit</Btn>
                    <Btn size="sm" variant="ghost" onClick={() => openDrawer(pl)}>Items</Btn>
                    {!pl.is_default && <Btn size="sm" variant="ghost" onClick={() => setDefault(pl)}>Set Default</Btn>}
                    <Btn size="sm" variant="danger" onClick={() => setPendingDeleteList(pl)}>Del</Btn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editItem ? 'Edit Price List' : 'New Price List'}>
        <FormField label="Name"><Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Standard Retail Price" /></FormField>
        <FormField label="Currency">
          <Select value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value }))}>
            <option value="INR">INR — Indian Rupee</option>
            <option value="USD">USD — US Dollar</option>
            <option value="EUR">EUR — Euro</option>
          </Select>
        </FormField>
        <FormField label="Applicable To">
          <Select value={form.applicable_to} onChange={e => setForm(p => ({ ...p, applicable_to: e.target.value }))}>
            <option value="all">All Customers</option>
            <option value="specific">Specific Customers</option>
          </Select>
        </FormField>
        {form.applicable_to === 'specific' && (
          <FormField label="Customer IDs (comma separated)">
            <Input value={form.customer_ids} onChange={e => setForm(p => ({ ...p, customer_ids: e.target.value }))} placeholder="101, 102, 103" />
          </FormField>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <FormField label="Valid From"><Input type="date" value={form.valid_from} onChange={e => setForm(p => ({ ...p, valid_from: e.target.value }))} /></FormField>
          <FormField label="Valid To"><Input type="date" value={form.valid_to} onChange={e => setForm(p => ({ ...p, valid_to: e.target.value }))} /></FormField>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 20 }}>
          <input type="checkbox" checked={form.is_default} onChange={e => setForm(p => ({ ...p, is_default: e.target.checked }))} />
          <span style={{ fontSize: 14, color: '#374151' }}>Set as default price list</span>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Btn variant="ghost" onClick={() => setShowModal(false)}>Cancel</Btn>
          <Btn onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
        </div>
      </Modal>

      <Drawer open={!!drawerList} onClose={() => setDrawerList(null)} title={drawerList ? `Items — ${drawerList.name}` : ''}>
        <Input value={drawerSearch} onChange={e => setDrawerSearch(e.target.value)} placeholder="Search items..." style={{ marginBottom: 16 }} />
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: LIGHT }}>
                {['Item ID', 'Item Name', 'Base Price', 'Min Price', 'UOM', 'Start ₹', 'Δ vs Start'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((it, i) => (
                <tr key={it.id} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none' }}>
                  <td style={{ padding: '6px 10px' }}><Input value={it.item_id} onChange={e => updateDrawerItem(i, 'item_id', e.target.value)} style={{ fontSize: 12, padding: '4px 6px' }} /></td>
                  <td style={{ padding: '6px 10px' }}><Input value={it.item_name} onChange={e => updateDrawerItem(i, 'item_name', e.target.value)} style={{ fontSize: 12, padding: '4px 6px' }} /></td>
                  <td style={{ padding: '6px 10px' }}><Input type="number" value={it.base_price} onChange={e => updateDrawerItem(i, 'base_price', e.target.value)} style={{ fontSize: 12, padding: '4px 6px', width: 80 }} /></td>
                  <td style={{ padding: '6px 10px' }}><Input type="number" value={it.min_price} onChange={e => updateDrawerItem(i, 'min_price', e.target.value)} style={{ fontSize: 12, padding: '4px 6px', width: 80 }} /></td>
                  <td style={{ padding: '6px 10px' }}><Input value={it.uom} onChange={e => updateDrawerItem(i, 'uom', e.target.value)} style={{ fontSize: 12, padding: '4px 6px', width: 60 }} /></td>
                  <td style={{ padding: '6px 10px', fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                    {it.original_price != null ? formatINR(it.original_price) : '—'}
                  </td>
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                    {it.original_price != null && parseFloat(it.base_price) !== parseFloat(it.original_price) ? (() => {
                      const delta = parseFloat(it.base_price) - parseFloat(it.original_price);
                      const pct = Math.abs((delta / parseFloat(it.original_price)) * 100).toFixed(1);
                      const up = delta > 0;
                      return <span style={{ fontWeight: 700, fontSize: 12, color: up ? '#dc2626' : '#16a34a' }}>{up ? '▲' : '▼'} {formatINR(Math.abs(delta))} ({pct}%)</span>;
                    })() : <span style={{ color: '#d1d5db', fontSize: 12 }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Btn size="sm" variant="ghost" onClick={addDrawerItem}>+ Add Item</Btn>
          {drawerChanged && <Btn size="sm" onClick={saveDrawerItems}>Save Changes</Btn>}
        </div>
      </Drawer>
    </div>
  );
}

// ─── Tab 2: Discount Rules ───────────────────────────────────────────────────

function ComputeWidget() {
  const [customerId, setCustomerId] = useState('');
  const [itemRows, setItemRows] = useState([{ item_id: '', qty: 1 }]);
  const [result, setResult] = useState(null);
  const [computeError, setComputeError] = useState('');
  const [computing, setComputing] = useState(false);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const compute = async () => {
    setComputing(true);
    setResult(null);
    setComputeError('');
    const [r] = await Promise.allSettled([api.get('/pricing/compute', { params: { customer_id: customerId, items: JSON.stringify(itemRows.filter(r => r.item_id)) } })]);
    if (!isMounted.current) return;
    if (r.status === 'fulfilled') {
      setResult(r.value.data);
    } else {
      setComputeError(r.reason?.response?.data?.error || r.reason?.message || 'Pricing computation failed.');
    }
    setComputing(false);
  };

  return (
    <div style={{ background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, marginBottom: 24 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: PURPLE, marginBottom: 12 }}>Test Pricing</div>
      <Input value={customerId} onChange={e => setCustomerId(e.target.value)} placeholder="Customer ID (optional)" style={{ marginBottom: 10 }} />
      {itemRows.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Input value={row.item_id} onChange={e => setItemRows(p => p.map((r, j) => j === i ? { ...r, item_id: e.target.value } : r))} placeholder="Item ID" />
          <Input type="number" value={row.qty} onChange={e => setItemRows(p => p.map((r, j) => j === i ? { ...r, qty: parseInt(e.target.value) || 1 } : r))} style={{ width: 70 }} min={1} />
          {itemRows.length > 1 && <Btn size="sm" variant="danger" onClick={() => setItemRows(p => p.filter((_, j) => j !== i))}>×</Btn>}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Btn size="sm" variant="ghost" onClick={() => setItemRows(p => [...p, { item_id: '', qty: 1 }])}>+ Item</Btn>
        <Btn size="sm" onClick={compute} disabled={computing}>{computing ? 'Computing...' : 'Compute'}</Btn>
      </div>
      {computeError && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#dc2626' }}>
          {computeError}
        </div>
      )}
      {result && (
        <div style={{ marginTop: 14 }}>
          <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 8, overflow: 'hidden', fontSize: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#f9f9ff' }}>{['Item', 'Qty', 'Unit ₹', 'Disc%', 'Total'].map(h => <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 700, color: '#6b7280', fontSize: 11 }}>{h}</th>)}</tr></thead>
              <tbody>
                {result.lines.map((l, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #f0f0f4' }}>
                    <td style={{ padding: '5px 10px' }}>{l.item_name}</td>
                    <td style={{ padding: '5px 10px' }}>{l.qty}</td>
                    <td style={{ padding: '5px 10px' }}>{formatINR(l.unit_price)}</td>
                    <td style={{ padding: '5px 10px', color: '#16a34a' }}>{l.discount_pct}%</td>
                    <td style={{ padding: '5px 10px', fontWeight: 600 }}>{formatINR(l.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#374151', display: 'flex', justifyContent: 'space-between' }}>
            <span>Subtotal: {formatINR(result.subtotal)}</span>
            <span style={{ color: '#16a34a' }}>Saved: {formatINR(result.total_discount)} ({result.savings_pct}%)</span>
            <span style={{ fontWeight: 700, color: PURPLE }}>Grand Total: {formatINR(result.grand_total)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function DiscountRulesTab() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [pendingDeleteRule, setPendingDeleteRule] = useState(null);
  const [form, setForm] = useState({ name: '', type: 'percentage', applies_to: 'all', min_order_value: 0, min_quantity: 1, discount_value: 0, tiered_slabs: [{ min_qty: 1, max_qty: '', discount_pct: 0 }], valid_from: '', valid_to: '', requires_approval: false, approval_threshold_pct: 10 });
  const [saving, setSaving] = useState(false);

  const abortRef = useRef(null);
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const [r] = await Promise.allSettled([api.get('/pricing/discount-rules', { signal: controller.signal })]);
    if (controller.signal.aborted) return;
    setRules(r.status === 'fulfilled' ? (r.value.data || []) : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const toggleActive = async (rule) => {
    await Promise.allSettled([api.put(`/pricing/discount-rules/${rule.id}`, { is_active: !rule.is_active })]);
    if (!isMounted.current) return;
    load();
  };

  const deleteRule = async () => {
    if (!pendingDeleteRule) return;
    const id = pendingDeleteRule;
    setPendingDeleteRule(null);
    await Promise.allSettled([api.delete(`/pricing/discount-rules/${id}`)]);
    if (!isMounted.current) return;
    load();
  };

  const openNew = () => {
    setEditItem(null);
    setForm({ name: '', type: 'percentage', applies_to: 'all', min_order_value: 0, min_quantity: 1, discount_value: 0, tiered_slabs: [{ min_qty: 1, max_qty: '', discount_pct: 0 }], valid_from: '', valid_to: '', requires_approval: false, approval_threshold_pct: 10 });
    setShowModal(true);
  };

  const openEdit = (rule) => {
    setEditItem(rule);
    setForm({ name: rule.name, type: rule.type, applies_to: rule.applies_to, min_order_value: rule.min_order_value, min_quantity: rule.min_quantity, discount_value: rule.discount_value, tiered_slabs: rule.tiered_slabs && rule.tiered_slabs.length > 0 ? rule.tiered_slabs : [{ min_qty: 1, max_qty: '', discount_pct: 0 }], valid_from: rule.valid_from || '', valid_to: rule.valid_to || '', requires_approval: rule.requires_approval, approval_threshold_pct: rule.approval_threshold_pct });
    setShowModal(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    if (editItem) await Promise.allSettled([api.put(`/pricing/discount-rules/${editItem.id}`, form)]);
    else await Promise.allSettled([api.post('/pricing/discount-rules', form)]);
    if (!isMounted.current) return;
    setSaving(false);
    setShowModal(false);
    load();
  };

  const addSlab = () => setForm(p => ({ ...p, tiered_slabs: [...p.tiered_slabs, { min_qty: '', max_qty: '', discount_pct: 0 }] }));
  const removeSlab = (i) => setForm(p => ({ ...p, tiered_slabs: p.tiered_slabs.filter((_, j) => j !== i) }));
  const updateSlab = (i, field, val) => setForm(p => ({ ...p, tiered_slabs: p.tiered_slabs.map((s, j) => j === i ? { ...s, [field]: val } : s) }));

  const typeColor = { percentage: 'green', fixed: 'blue', tiered: 'purple' };

  return (
    <div>
      <ConfirmDialog
        open={!!pendingDeleteRule}
        title="Delete Discount Rule"
        message="Delete this discount rule? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteRule}
        onCancel={() => setPendingDeleteRule(null)}
      />
      <ComputeWidget />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Discount Rules</h2>
        <Btn onClick={openNew}>+ New Rule</Btn>
      </div>

      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: LIGHT }}>
              {['Name', 'Type', 'Discount', 'Min Order Value', 'Approval', 'Active', 'Actions'].map(h => (
                <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Loading...</td></tr>
            ) : rules.map((r, i) => (
              <tr key={r.id} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none' }}>
                <td style={{ padding: '12px 16px', fontWeight: 600, color: '#1a1a2e' }}>{r.name}</td>
                <td style={{ padding: '12px 16px' }}><Badge color={typeColor[r.type] || 'grey'}>{r.type}</Badge></td>
                <td style={{ padding: '12px 16px', color: '#374151' }}>{r.type === 'tiered' ? `${(r.tiered_slabs || []).length} slabs` : r.type === 'fixed' ? formatINR(r.discount_value) : `${r.discount_value}%`}</td>
                <td style={{ padding: '12px 16px', color: '#6b7280' }}>{formatINR(r.min_order_value)}</td>
                <td style={{ padding: '12px 16px' }}>{r.requires_approval ? <Badge color="amber">Required</Badge> : <Badge color="grey">None</Badge>}</td>
                <td style={{ padding: '12px 16px' }}><Toggle checked={r.is_active} onChange={() => toggleActive(r)} /></td>
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Btn size="sm" variant="outline" onClick={() => openEdit(r)}>Edit</Btn>
                    <Btn size="sm" variant="danger" onClick={() => setPendingDeleteRule(r.id)}>Del</Btn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editItem ? 'Edit Discount Rule' : 'New Discount Rule'} width={580}>
        <FormField label="Rule Name"><Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Bulk Order Discount" /></FormField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <FormField label="Type">
            <Select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}>
              <option value="percentage">Percentage</option>
              <option value="fixed">Fixed Amount</option>
              <option value="tiered">Tiered</option>
            </Select>
          </FormField>
          <FormField label="Applies To">
            <Select value={form.applies_to} onChange={e => setForm(p => ({ ...p, applies_to: e.target.value }))}>
              <option value="all">All</option>
              <option value="specific">Specific</option>
            </Select>
          </FormField>
        </div>
        {form.type !== 'tiered' && (
          <FormField label={form.type === 'fixed' ? 'Fixed Amount (₹)' : 'Discount %'}>
            <Input type="number" value={form.discount_value} onChange={e => setForm(p => ({ ...p, discount_value: parseFloat(e.target.value) || 0 }))} />
          </FormField>
        )}
        {form.type === 'tiered' && (
          <FormField label="Tiered Slabs">
            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: LIGHT }}>{['Min Qty', 'Max Qty', 'Discount %', ''].map(h => <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280' }}>{h}</th>)}</tr></thead>
                <tbody>
                  {form.tiered_slabs.map((slab, i) => (
                    <tr key={i} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none' }}>
                      <td style={{ padding: '6px 8px' }}><Input type="number" value={slab.min_qty} onChange={e => updateSlab(i, 'min_qty', e.target.value)} style={{ fontSize: 12, padding: '4px 6px' }} /></td>
                      <td style={{ padding: '6px 8px' }}><Input type="number" value={slab.max_qty} onChange={e => updateSlab(i, 'max_qty', e.target.value)} placeholder="∞" style={{ fontSize: 12, padding: '4px 6px' }} /></td>
                      <td style={{ padding: '6px 8px' }}><Input type="number" value={slab.discount_pct} onChange={e => updateSlab(i, 'discount_pct', e.target.value)} style={{ fontSize: 12, padding: '4px 6px' }} /></td>
                      <td style={{ padding: '6px 8px' }}><Btn size="sm" variant="danger" onClick={() => removeSlab(i)}>×</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Btn size="sm" variant="ghost" onClick={addSlab}>+ Add Slab</Btn>
          </FormField>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <FormField label="Min Order Value (₹)"><Input type="number" value={form.min_order_value} onChange={e => setForm(p => ({ ...p, min_order_value: parseFloat(e.target.value) || 0 }))} /></FormField>
          <FormField label="Min Quantity"><Input type="number" value={form.min_quantity} onChange={e => setForm(p => ({ ...p, min_quantity: parseInt(e.target.value) || 1 }))} /></FormField>
          <FormField label="Valid From"><Input type="date" value={form.valid_from} onChange={e => setForm(p => ({ ...p, valid_from: e.target.value }))} /></FormField>
          <FormField label="Valid To"><Input type="date" value={form.valid_to} onChange={e => setForm(p => ({ ...p, valid_to: e.target.value }))} /></FormField>
        </div>
        <FormField label="Approval Threshold % (discount above this % needs approval)">
          <Input type="number" value={form.approval_threshold_pct} onChange={e => setForm(p => ({ ...p, approval_threshold_pct: parseFloat(e.target.value) || 10 }))} />
        </FormField>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 20 }}>
          <input type="checkbox" checked={form.requires_approval} onChange={e => setForm(p => ({ ...p, requires_approval: e.target.checked }))} />
          <span style={{ fontSize: 14, color: '#374151' }}>Always require approval for this rule</span>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Btn variant="ghost" onClick={() => setShowModal(false)}>Cancel</Btn>
          <Btn onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
        </div>
      </Modal>
    </div>
  );
}

// ─── Tab 3: Promotions ───────────────────────────────────────────────────────

function PromotionsTab() {
  const [promos, setPromos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [pendingDeletePromo, setPendingDeletePromo] = useState(null);
  const [form, setForm] = useState({ name: '', type: 'seasonal', discount_value: 0, valid_from: '', valid_to: '', max_usage: 1000, conditions: '{}' });
  const [saving, setSaving] = useState(false);

  const abortRef = useRef(null);
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const [r] = await Promise.allSettled([api.get('/pricing/promotions', { signal: controller.signal })]);
    if (controller.signal.aborted) return;
    setPromos(r.status === 'fulfilled' ? (r.value.data || []) : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const toggleActive = async (promo) => {
    await Promise.allSettled([api.put(`/pricing/promotions/${promo.id}`, { is_active: !promo.is_active })]);
    if (!isMounted.current) return;
    load();
  };

  const deletePromo = async () => {
    if (!pendingDeletePromo) return;
    const id = pendingDeletePromo;
    setPendingDeletePromo(null);
    await Promise.allSettled([api.delete(`/pricing/promotions/${id}`)]);
    if (!isMounted.current) return;
    load();
  };

  const openNew = () => {
    setEditItem(null);
    setForm({ name: '', type: 'seasonal', discount_value: 0, valid_from: '', valid_to: '', max_usage: 1000, conditions: '{}' });
    setShowModal(true);
  };

  const openEdit = (p) => {
    setEditItem(p);
    setForm({ name: p.name, type: p.type, discount_value: p.discount_value, valid_from: p.valid_from || '', valid_to: p.valid_to || '', max_usage: p.max_usage, conditions: JSON.stringify(p.conditions || {}) });
    setShowModal(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    let cond = {};
    try { cond = JSON.parse(form.conditions); } catch {}
    const payload = { ...form, conditions: cond };
    if (editItem) await Promise.allSettled([api.put(`/pricing/promotions/${editItem.id}`, payload)]);
    else await Promise.allSettled([api.post('/pricing/promotions', payload)]);
    if (!isMounted.current) return;
    setSaving(false);
    setShowModal(false);
    load();
  };

  const typeConfig = { seasonal: { color: 'purple', label: 'Seasonal' }, bogo: { color: 'green', label: 'BOGO' }, bundle: { color: 'blue', label: 'Bundle' } };

  return (
    <div>
      <ConfirmDialog
        open={!!pendingDeletePromo}
        title="Delete Promotion"
        message="Delete this promotion? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deletePromo}
        onCancel={() => setPendingDeletePromo(null)}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Promotions</h2>
        <Btn onClick={openNew}>+ New Promotion</Btn>
      </div>
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 20 }}>
          {promos.map(promo => {
            const tc = typeConfig[promo.type] || { color: 'grey', label: promo.type };
            const usagePct = promo.max_usage > 0 ? Math.min(100, (promo.usage_count / promo.max_usage) * 100) : 0;
            return (
              <div key={promo.id} style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 14, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 6 }}>{promo.name}</div>
                    <Badge color={tc.color}>{tc.label}</Badge>
                  </div>
                  <div style={{ background: LIGHT, color: PURPLE, borderRadius: 8, padding: '4px 10px', fontWeight: 800, fontSize: 16 }}>{promo.discount_value}% OFF</div>
                </div>
                <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 10 }}>
                  {promo.valid_from} → {promo.valid_to}
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>
                    <span>Usage</span>
                    <span>{promo.usage_count} / {promo.max_usage}</span>
                  </div>
                  <div style={{ background: '#f0f0f4', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                    <div style={{ background: usagePct > 80 ? '#ef4444' : PURPLE, height: '100%', width: `${usagePct}%`, borderRadius: 4, transition: 'width 0.4s' }} />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Toggle checked={promo.is_active} onChange={() => toggleActive(promo)} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Btn size="sm" variant="outline" onClick={() => openEdit(promo)}>Edit</Btn>
                    <Btn size="sm" variant="danger" onClick={() => setPendingDeletePromo(promo.id)}>Del</Btn>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editItem ? 'Edit Promotion' : 'New Promotion'}>
        <FormField label="Promotion Name"><Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Summer Sale" /></FormField>
        <FormField label="Type">
          <Select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}>
            <option value="seasonal">Seasonal</option>
            <option value="bogo">BOGO (Buy One Get One)</option>
            <option value="bundle">Bundle</option>
          </Select>
        </FormField>
        <FormField label="Discount Value (%)"><Input type="number" value={form.discount_value} onChange={e => setForm(p => ({ ...p, discount_value: parseFloat(e.target.value) || 0 }))} /></FormField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <FormField label="Valid From"><Input type="date" value={form.valid_from} onChange={e => setForm(p => ({ ...p, valid_from: e.target.value }))} /></FormField>
          <FormField label="Valid To"><Input type="date" value={form.valid_to} onChange={e => setForm(p => ({ ...p, valid_to: e.target.value }))} /></FormField>
        </div>
        <FormField label="Max Usage"><Input type="number" value={form.max_usage} onChange={e => setForm(p => ({ ...p, max_usage: parseInt(e.target.value) || 1000 }))} /></FormField>
        <FormField label="Conditions (JSON)">
          <textarea value={form.conditions} onChange={e => setForm(p => ({ ...p, conditions: e.target.value }))} style={{ width: '100%', padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, minHeight: 80, boxSizing: 'border-box', fontFamily: 'monospace' }} />
        </FormField>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Btn variant="ghost" onClick={() => setShowModal(false)}>Cancel</Btn>
          <Btn onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
        </div>
      </Modal>
    </div>
  );
}

// ─── Tab 4: Approvals ────────────────────────────────────────────────────────

function ApprovalsTab() {
  const [approvals, setApprovals] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [remarks, setRemarks] = useState({});

  const abortRef = useRef(null);
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const [appR, anaR] = await Promise.allSettled([
      api.get('/pricing/discount-approvals', { signal: controller.signal }),
      api.get('/pricing/analytics', { signal: controller.signal })
    ]);
    if (controller.signal.aborted) return;
    setApprovals(appR.status === 'fulfilled' ? (appR.value.data || []) : []);
    setAnalytics(anaR.status === 'fulfilled' ? anaR.value.data : null);
    setLoading(false);
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const decide = async (id, status) => {
    await Promise.allSettled([api.put(`/pricing/discount-approvals/${id}`, { status, reason: remarks[id] || '' })]);
    if (!isMounted.current) return;
    load();
  };

  const pending = approvals.filter(a => a.status === 'pending');
  const history = approvals.filter(a => a.status !== 'pending');

  const kpiCards = analytics ? [
    { label: 'Avg Discount Given', value: `${analytics.avg_discount_pct}%`, color: PURPLE },
    { label: 'Pending Approvals', value: analytics.pending_approvals, color: '#d97706' },
    { label: 'Monthly Impact', value: formatINR(analytics.monthly_discount_impact), color: '#dc2626' },
    { label: 'Approval Rate', value: `${analytics.approval_rate}%`, color: '#16a34a' }
  ] : [];

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Pending Approvals</h2>
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 28 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: LIGHT }}>
                {['Sales Rep', 'Rule', 'Order Value', 'Req. Discount', 'Net Impact', 'Requested At', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '12px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Loading...</td></tr>
              ) : pending.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No pending approvals</td></tr>
              ) : pending.map((a, i) => {
                const orderVal = a.order_value || 0;
                const netImpact = (orderVal * a.requested_discount_pct) / 100;
                return (
                  <tr key={a.id} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none', verticalAlign: 'top' }}>
                    <td style={{ padding: '12px 14px', fontWeight: 600, color: '#1a1a2e' }}>{a.requested_by}</td>
                    <td style={{ padding: '12px 14px', fontSize: 13, color: '#6b7280' }}>{a.rule_name}</td>
                    <td style={{ padding: '12px 14px' }}>{formatINR(orderVal)}</td>
                    <td style={{ padding: '12px 14px' }}>
                      <span style={{ color: PURPLE, fontWeight: 700 }}>{a.requested_discount_pct}%</span>
                    </td>
                    <td style={{ padding: '12px 14px', color: '#dc2626', fontWeight: 600 }}>-{formatINR(netImpact)}</td>
                    <td style={{ padding: '12px 14px', fontSize: 12, color: '#9ca3af' }}>{new Date(a.requested_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <Input value={remarks[a.id] || ''} onChange={e => setRemarks(p => ({ ...p, [a.id]: e.target.value }))} placeholder="Remarks..." style={{ fontSize: 12, padding: '4px 8px' }} />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <Btn size="sm" variant="success" onClick={() => decide(a.id, 'approved')}>Approve</Btn>
                          <Btn size="sm" variant="danger" onClick={() => decide(a.id, 'rejected')}>Reject</Btn>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>Approval History</h3>
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: LIGHT }}>
                {['Sales Rep', 'Rule', 'Discount %', 'Approved By', 'Status', 'Decision Date'].map(h => (
                  <th key={h} style={{ padding: '12px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>No history yet</td></tr>
              ) : history.map((a, i) => (
                <tr key={a.id} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none' }}>
                  <td style={{ padding: '12px 14px', fontWeight: 600, color: '#1a1a2e' }}>{a.requested_by}</td>
                  <td style={{ padding: '12px 14px', fontSize: 13, color: '#6b7280' }}>{a.rule_name}</td>
                  <td style={{ padding: '12px 14px', fontWeight: 700, color: PURPLE }}>{a.requested_discount_pct}%</td>
                  <td style={{ padding: '12px 14px', color: '#374151' }}>{a.approved_by || '—'}</td>
                  <td style={{ padding: '12px 14px' }}><Badge color={a.status === 'approved' ? 'green' : 'red'}>{a.status}</Badge></td>
                  <td style={{ padding: '12px 14px', fontSize: 12, color: '#9ca3af' }}>{a.approved_at ? new Date(a.approved_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ width: 260, flexShrink: 0 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#1a1a2e' }}>Analytics</h3>
        {analytics ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
              {kpiCards.map((k, i) => (
                <div key={i} style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: k.color }}>{k.value}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{k.label}</div>
                </div>
              ))}
            </div>
            <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 12 }}>Most Changed Items</div>
              {(analytics.top_discounted_items || []).length === 0 && (
                <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', padding: '12px 0' }}>No data available.</div>
              )}
              {(analytics.top_discounted_items || []).map((item, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                    <span style={{ color: '#374151', fontWeight: 500 }}>{item.item_name}</span>
                    <span style={{ color: PURPLE, fontWeight: 700 }}>{item.avg_discount_pct}%</span>
                  </div>
                  <div style={{ background: '#f0f0f4', borderRadius: 3, height: 4 }}>
                    <div style={{ background: PURPLE, height: '100%', width: `${Math.min(100, item.avg_discount_pct * 5)}%`, borderRadius: 3 }} />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '32px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
            Analytics unavailable.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tab 5: Price History ────────────────────────────────────────────────────

function PriceHistoryTab() {
  const [log, setLog]               = useState([]);
  const [lists, setLists]           = useState([]);
  const [loading, setLoading]       = useState(false);
  const [filterListId, setFilterListId] = useState('');
  const [itemFilter, setItemFilter] = useState('');

  const abortRef = useRef(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const params = {};
    if (filterListId) params.price_list_id = filterListId;
    const [logR, listsR] = await Promise.allSettled([
      api.get('/pricing/price-change-log', { params, signal: controller.signal }),
      api.get('/pricing/price-lists', { signal: controller.signal }),
    ]);
    if (controller.signal.aborted) return;
    setLog(logR.status === 'fulfilled' ? (logR.value.data || []) : []);
    setLists(listsR.status === 'fulfilled' ? (listsR.value.data || []) : []);
    setLoading(false);
  }, [filterListId]);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const filtered = log.filter(r =>
    !itemFilter ||
    r.item_name?.toLowerCase().includes(itemFilter.toLowerCase()) ||
    r.item_id?.toLowerCase().includes(itemFilter.toLowerCase())
  );

  const totalUp   = log.filter(r => parseFloat(r.new_price) > parseFloat(r.old_price)).length;
  const totalDown = log.filter(r => parseFloat(r.new_price) < parseFloat(r.old_price)).length;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Price Change Log</h2>
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <StatCard label="Total Changes" value={log.length} />
        <StatCard label="Price Increases" value={totalUp} sub="items marked ▲" />
        <StatCard label="Price Decreases" value={totalDown} sub="items marked ▼" />
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <Select value={filterListId} onChange={e => setFilterListId(e.target.value)} style={{ width: 220 }}>
          <option value="">All Price Lists</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <Input value={itemFilter} onChange={e => setItemFilter(e.target.value)} placeholder="Filter by item name or ID…" style={{ width: 260 }} />
        {(filterListId || itemFilter) && (
          <Btn size="sm" variant="ghost" onClick={() => { setFilterListId(''); setItemFilter(''); }}>Clear</Btn>
        )}
      </div>

      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: LIGHT }}>
              {['Date', 'Price List', 'Item', 'Old Price', 'New Price', 'Change', 'Changed By'].map(h => (
                <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
                No price changes recorded yet.<br />
                <span style={{ fontSize: 12 }}>Changes are logged automatically when you save price list items.</span>
              </td></tr>
            ) : filtered.map((row, i) => {
              const delta = parseFloat(row.new_price) - parseFloat(row.old_price);
              const deltaPct = parseFloat(row.old_price) > 0
                ? Math.abs((delta / parseFloat(row.old_price)) * 100).toFixed(1)
                : '0.0';
              const isUp = delta > 0;
              return (
                <tr key={row.id} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none' }}>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#6b7280', whiteSpace: 'nowrap' }}>
                    {new Date(row.changed_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                    <div style={{ fontSize: 11, color: '#d1d5db' }}>
                      {new Date(row.changed_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#374151' }}>
                    {row.price_list_name || `#${row.price_list_id}`}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ fontWeight: 600, color: '#1a1a2e', fontSize: 14 }}>{row.item_name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{row.item_id}</div>
                  </td>
                  <td style={{ padding: '12px 16px', color: '#6b7280', fontSize: 13 }}>{formatINR(row.old_price)}</td>
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: '#1a1a2e', fontSize: 13 }}>{formatINR(row.new_price)}</td>
                  <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                    <span style={{ fontWeight: 700, color: isUp ? '#dc2626' : '#16a34a', fontSize: 13 }}>
                      {isUp ? '▲' : '▼'} {formatINR(Math.abs(delta))}
                    </span>
                    <span style={{ fontSize: 11, color: isUp ? '#dc2626' : '#16a34a', marginLeft: 4, opacity: 0.8 }}>
                      ({deltaPct}%)
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#6b7280' }}>{row.changed_by || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function PricingEngine() {
  const [activeTab, setActiveTab] = useState(0);
  const tabs = ['Price Lists', 'Discount Rules', 'Promotions', 'Approvals', 'Price History'];

  return (
    <div style={{ padding: 32, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: '#1a1a2e' }}>Pricing Engine</div>
        <div style={{ fontSize: 14, color: '#9ca3af', marginTop: 4 }}>Manage price lists, discount rules, promotions and approvals</div>
      </div>

      <div style={{ display: 'flex', gap: 0, borderBottom: `2px solid ${BORDER}`, marginBottom: 28, marginTop: 20 }}>
        {tabs.map((t, i) => (
          <button key={t} onClick={() => setActiveTab(i)} style={{
            padding: '10px 24px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: activeTab === i ? 700 : 500,
            color: activeTab === i ? PURPLE : '#6b7280',
            borderBottom: activeTab === i ? `2px solid ${PURPLE}` : '2px solid transparent',
            marginBottom: -2, transition: 'all 0.15s'
          }}>{t}</button>
        ))}
      </div>

      {activeTab === 0 && <PriceListsTab />}
      {activeTab === 1 && <DiscountRulesTab />}
      {activeTab === 2 && <PromotionsTab />}
      {activeTab === 3 && <ApprovalsTab />}
      {activeTab === 4 && <PriceHistoryTab />}
    </div>
  );
}
