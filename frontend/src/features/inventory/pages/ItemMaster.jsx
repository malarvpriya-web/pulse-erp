import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, RefreshCw, X, Package, Edit2 } from 'lucide-react';
import api from '@/services/api/client';
import './ItemMaster.css';

const CATEGORIES = ['Raw Materials', 'Finished Goods', 'Packaging', 'Consumables', 'Spares', 'WIP'];
const UNITS = ['pcs', 'kg', 'ltr', 'mtr', 'box', 'rolls', 'cans', 'set'];

const SAMPLE_ITEMS = [
  { id: 1, sku: 'SKU-001', name: 'Ball Bearings 20mm', category: 'Spares',        unit: 'pcs',  current_stock: 5,   reorder_level: 20,  unit_price: 45,   is_active: true },
  { id: 2, sku: 'SKU-002', name: 'Copper Wire 2.5mm',  category: 'Raw Materials', unit: 'kg',   current_stock: 280, reorder_level: 100, unit_price: 620,  is_active: true },
  { id: 3, sku: 'SKU-003', name: 'Packing Tape 48mm',  category: 'Packaging',     unit: 'rolls',current_stock: 12,  reorder_level: 50,  unit_price: 35,   is_active: true },
  { id: 4, sku: 'SKU-004', name: 'Lubricant Oil 5L',   category: 'Consumables',   unit: 'cans', current_stock: 2,   reorder_level: 10,  unit_price: 850,  is_active: true },
  { id: 5, sku: 'SKU-005', name: 'Steel Rods 12mm',    category: 'Raw Materials', unit: 'kg',   current_stock: 600, reorder_level: 200, unit_price: 92,   is_active: true },
  { id: 6, sku: 'SKU-006', name: 'Carton Box 40x30',   category: 'Packaging',     unit: 'pcs',  current_stock: 850, reorder_level: 300, unit_price: 28,   is_active: true },
];

const emptyForm = () => ({
  sku: '', name: '', category: '', unit: 'pcs',
  current_stock: '', reorder_level: '', unit_price: '',
  description: '', is_active: true,
});

const stockStatus = (current, reorder) => {
  const r = parseFloat(reorder) || 1;
  const c = parseFloat(current) || 0;
  const pct = c / r;
  if (pct <= 0)   return { label: 'Out',      color: '#7f1d1d', bg: '#fef2f2' };
  if (pct <= 0.3) return { label: 'Critical', color: '#dc2626', bg: '#fee2e2' };
  if (pct <= 0.8) return { label: 'Low',      color: '#92400e', bg: '#fef3c7' };
  return           { label: 'OK',       color: '#15803d', bg: '#f0fdf4' };
};

export default function ItemMaster({ setPage }) {
  const [items,     setItems]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [fCat,      setFCat]      = useState('');
  const [drawer,    setDrawer]    = useState(null);  // null | 'add' | item-obj
  const [form,      setForm]      = useState(emptyForm());
  const [submitting,setSubmitting]= useState(false);
  const [toast,     setToast]     = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (fCat)   params.category = fCat;
      if (search) params.search   = search;
      const r = await api.get('/inventory/items', { params });
      const raw = r.data.items || r.data;
      setItems(Array.isArray(raw) && raw.length ? raw : SAMPLE_ITEMS);
    } catch {
      setItems(SAMPLE_ITEMS);
    } finally {
      setLoading(false);
    }
  }, [fCat, search]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(emptyForm()); setDrawer('add'); };
  const openEdit = (item) => {
    setForm({ ...emptyForm(), ...item });
    setDrawer(item);
  };

  const handleSubmit = async () => {
    if (!form.name || !form.sku) return showToast('SKU and Name are required', 'error');
    setSubmitting(true);
    try {
      if (drawer === 'add') {
        await api.post('/inventory/items', form);
        showToast('Item created');
      } else {
        await api.put(`/inventory/items/${drawer.id}`, form);
        showToast('Item updated');
      }
      setDrawer(null);
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to save item', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const displayed = items.filter(it => {
    const q = search.toLowerCase();
    return (!q || it.name?.toLowerCase().includes(q) || it.sku?.toLowerCase().includes(q))
        && (!fCat || it.category === fCat);
  });

  return (
    <div className="im-root">

      {toast && <div className={`im-toast im-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="im-header">
        <div>
          <h2 className="im-title">Item Master</h2>
          <p className="im-sub">{displayed.length} item{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="im-header-r">
          <button className="im-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="im-btn-primary" onClick={openAdd}><Plus size={14} /> Add Item</button>
        </div>
      </div>

      {/* filters */}
      <div className="im-filters">
        <div className="im-search">
          <Search size={14} />
          <input placeholder="Search by name or SKU…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="im-select" value={fCat} onChange={e => setFCat(e.target.value)}>
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c}>{c}</option>)}
        </select>
        {(search || fCat) && (
          <button className="im-clear-btn" onClick={() => { setSearch(''); setFCat(''); }}>
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* table */}
      {loading ? (
        <div className="im-loading"><div className="im-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="im-empty">
          <Package size={40} color="#d1d5db" />
          <p>No items found</p>
        </div>
      ) : (
        <div className="im-table-wrap">
          <table className="im-table">
            <thead>
              <tr>
                <th>SKU</th><th>Name</th><th>Category</th><th>Unit</th>
                <th>Stock</th><th>Reorder Lvl</th><th>Unit Price</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(it => {
                const ss = stockStatus(it.current_stock, it.reorder_level);
                return (
                  <tr key={it.id} className="im-row" onClick={() => openEdit(it)}>
                    <td className="im-mono">{it.sku}</td>
                    <td className="im-name">{it.name}</td>
                    <td>{it.category}</td>
                    <td>{it.unit}</td>
                    <td>
                      <span style={{ fontWeight: 600 }}>{it.current_stock}</span>
                      <div className="im-stock-bar-track">
                        <div className="im-stock-bar" style={{
                          width: `${Math.min(100, Math.round((parseFloat(it.current_stock)||0) / (parseFloat(it.reorder_level)||1) * 100))}%`,
                          background: ss.color,
                        }} />
                      </div>
                    </td>
                    <td>{it.reorder_level}</td>
                    <td>₹{parseFloat(it.unit_price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td>
                      <span className="im-badge" style={{ background: ss.bg, color: ss.color }}>{ss.label}</span>
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className="im-edit-btn" onClick={() => openEdit(it)}><Edit2 size={13} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / Edit Drawer */}
      {drawer !== null && (
        <div className="im-overlay" onClick={() => setDrawer(null)}>
          <div className="im-drawer" onClick={e => e.stopPropagation()}>
            <div className="im-drawer-hd">
              <h3>{drawer === 'add' ? 'Add New Item' : 'Edit Item'}</h3>
              <button className="im-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="im-drawer-body">
              <div className="im-row2">
                <div className="im-field">
                  <label>SKU *</label>
                  <input value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))} placeholder="e.g. SKU-001" />
                </div>
                <div className="im-field">
                  <label>Category</label>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                    <option value="">Select…</option>
                    {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div className="im-field">
                <label>Item Name *</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Full item name" />
              </div>
              <div className="im-field">
                <label>Description</label>
                <textarea rows={3} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional description" />
              </div>
              <div className="im-row2">
                <div className="im-field">
                  <label>Unit of Measure</label>
                  <select value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}>
                    {UNITS.map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
                <div className="im-field">
                  <label>Unit Price (₹)</label>
                  <input type="number" min="0" step="0.01" value={form.unit_price} onChange={e => setForm(f => ({ ...f, unit_price: e.target.value }))} />
                </div>
              </div>
              <div className="im-row2">
                <div className="im-field">
                  <label>Opening Stock</label>
                  <input type="number" min="0" value={form.current_stock} onChange={e => setForm(f => ({ ...f, current_stock: e.target.value }))} />
                </div>
                <div className="im-field">
                  <label>Reorder Level</label>
                  <input type="number" min="0" value={form.reorder_level} onChange={e => setForm(f => ({ ...f, reorder_level: e.target.value }))} />
                </div>
              </div>
            </div>
            <div className="im-drawer-ft">
              <button className="im-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
              <button className="im-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saving…' : drawer === 'add' ? 'Create Item' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
