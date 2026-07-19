import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, RefreshCw, X, Package, Edit2, Store, Boxes, ArrowDownToLine, ArrowUpFromLine, SlidersHorizontal, History, Trash2, Columns3, Download, ChevronUp, ChevronDown } from 'lucide-react';
import api from '@/services/api/client';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import {
  getCategories, createCategory,
  getItemVendorPrices, createItemVendorPrice, updateItemVendorPrice, deleteItemVendorPrice,
} from '../services/inventoryService';
import './ItemMaster.css';

const ITEM_TYPES = ['Raw Materials', 'Finished Goods', 'Packaging', 'Consumables', 'Spares', 'WIP'];
const UNITS = ['pcs', 'kg', 'ltr', 'mtr', 'box', 'rolls', 'cans', 'set', 'nos', 'pair', 'sheet', 'coil'];
const ABC_CLASSES = ['A', 'B', 'C'];
const ABC_BADGE = { A: ['#d1fae5', '#16a34a'], B: ['#fef3c7', '#d97706'], C: ['#f3f4f6', '#6b7280'] };
const thP = { padding: '8px 10px', textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap' };
const tdP = { padding: '7px 10px', whiteSpace: 'nowrap' };

function toCSV(filename, header, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const emptyForm = () => ({
  item_code:       '',
  item_name:       '',
  item_type:       '',
  product_model:   '',
  category_id:     '',
  abc_class:       '',
  unit_of_measure: 'pcs',
  reorder_level:   '',
  safety_stock:    '',
  standard_cost:   '',
  lead_time_days:  7,
  hsn_code:        '',
  gst_rate:        '',
  manufacturer:    '',
  description:     '',
  is_active:       true,
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

export default function ItemMaster({ setPage: _setPage }) {
  const { readOnly } = usePageAccess();
  const [items,      setItems]      = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [fType,      setFType]      = useState('');
  const [drawer,     setDrawer]     = useState(null);
  const [form,       setForm]       = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);
  const [categories, setCategories] = useState([]);
  const [fCat,       setFCat]       = useState('');
  const [vendors,    setVendors]    = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [prices,     setPrices]     = useState([]);
  const [priceForm,  setPriceForm]  = useState(null);
  const [store,      setStore]      = useState(() => localStorage.getItem('im_store') || '');
  const [stockItem,  setStockItem]  = useState(null);   // item whose Stock drawer is open
  const [stockMode,  setStockMode]  = useState(null);   // 'receipt' | 'issue' | 'adjust' | null
  const [stockForm,  setStockForm]  = useState({ quantity: '', rate: '', reference: '', notes: '', adjustment_type: 'Addition' });
  const [txns,       setTxns]       = useState([]);
  const [txnLoading, setTxnLoading] = useState(false);
  const [stockBusy,  setStockBusy]  = useState(false);
  const [sortKey,    setSortKey]    = useState('item_code');
  const [sortDir,    setSortDir]    = useState('asc');
  const [colMenu,    setColMenu]    = useState(false);
  const [hiddenCols, setHiddenCols] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('im_hidden_cols') || '[]')); }
    catch { return new Set(); }
  });
  const [perPage,    setPerPage]    = useState(25);
  const [page,       setPage]       = useState(1);
  const [confirmDel, setConfirmDel] = useState(null);

  const toggleCol = (key) => setHiddenCols(prev => {
    const n = new Set(prev);
    n.has(key) ? n.delete(key) : n.add(key);
    localStorage.setItem('im_hidden_cols', JSON.stringify([...n]));
    return n;
  });

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const changeStore = (id) => {
    setStore(id);
    if (id) localStorage.setItem('im_store', id);
    else    localStorage.removeItem('im_store');
  };

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadCategories = useCallback(async () => {
    setCategories(await getCategories({ active_only: 'true' }));
  }, []);

  useEffect(() => {
    loadCategories();
    api.get('/inventory/warehouses').then(r => setWarehouses(r.data?.warehouses || r.data || [])).catch(() => {});
    api.get('/vendors').then(r => setVendors(r.data?.vendors || r.data || [])).catch(() => {});
  }, [loadCategories]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (fType)  params.item_type    = fType;
      if (fCat)   params.category_id   = fCat;
      if (search) params.search        = search;
      if (store)  params.warehouse_id  = store;
      const r = await api.get('/inventory/items', { params });
      const raw = r.data.items || r.data;
      setItems(Array.isArray(raw) ? raw : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [fType, fCat, search, store]);

  useEffect(() => { load(); }, [load]);

  // Any filter / sort / page-size change returns to the first page
  useEffect(() => { setPage(1); }, [search, fType, fCat, store, perPage, sortKey, sortDir]);

  const loadPrices = useCallback(async (itemId) => {
    setPrices(itemId ? await getItemVendorPrices(itemId) : []);
  }, []);

  const openAdd = () => { setForm(emptyForm()); setPrices([]); setPriceForm(null); setDrawer('add'); };
  const openEdit = (item) => {
    setForm({
      item_code:       item.item_code       ?? '',
      item_name:       item.item_name       ?? '',
      item_type:       item.item_type       ?? '',
      product_model:   item.product_model   ?? '',
      category_id:     item.category_id      ?? '',
      abc_class:       item.abc_class        ?? '',
      unit_of_measure: item.unit_of_measure ?? 'pcs',
      reorder_level:   item.reorder_level   ?? '',
      safety_stock:    item.safety_stock    ?? '',
      standard_cost:   item.standard_cost   ?? '',
      lead_time_days:  item.lead_time_days  ?? 7,
      hsn_code:        item.hsn_code        ?? '',
      gst_rate:        item.gst_rate        ?? '',
      manufacturer:    item.manufacturer    ?? '',
      description:     item.description     ?? '',
      is_active:       item.is_active       ?? true,
    });
    setPriceForm(null);
    setDrawer(item);
    loadPrices(item.id);
  };

  const handleAddCategory = async () => {
    const name = window.prompt('New category name');
    if (!name || !name.trim()) return;
    try {
      const cat = await createCategory({ name: name.trim() });
      await loadCategories();
      setForm(f => ({ ...f, category_id: cat.id }));
      showToast('Category added');
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to add category', 'error');
    }
  };

  const emptyPrice = () => ({
    vendor_id: '', warehouse_id: '', unit_price: '', moq: '', discount_pct: '',
    lead_time_days: '', vendor_sku: '', is_preferred: false, notes: '',
  });

  const savePrice = async () => {
    if (!priceForm?.vendor_id) return showToast('Select a vendor', 'error');
    const itemId = drawer?.id;
    try {
      if (priceForm.id) await updateItemVendorPrice(priceForm.id, priceForm);
      else await createItemVendorPrice(itemId, priceForm);
      setPriceForm(null);
      loadPrices(itemId);
      showToast('Vendor price saved');
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to save price', 'error');
    }
  };

  const removePrice = async (id) => {
    try {
      await deleteItemVendorPrice(id);
      loadPrices(drawer?.id);
      showToast('Price removed');
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to remove price', 'error');
    }
  };

  const handleSubmit = async () => {
    if (!form.item_name || !form.item_code) return showToast('Item Code and Name are required', 'error');
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

  const storeName = store
    ? (warehouses.find(w => String(w.id) === String(store))?.warehouse_name
       || warehouses.find(w => String(w.id) === String(store))?.name || 'Store')
    : '';

  // ── Stock actions (Receipt / Issue / Update Stock / Transactions) ──
  const emptyStockForm = () => ({ quantity: '', rate: '', reference: '', notes: '', adjustment_type: 'Addition' });

  const loadTxns = useCallback(async (itemId) => {
    setTxnLoading(true);
    try {
      const params = { item_id: itemId, limit: 25 };
      if (store) params.warehouse_id = store;
      const r = await api.get('/inventory/stock/movement', { params });
      const raw = r.data.movements || r.data;
      setTxns(Array.isArray(raw) ? raw : []);
    } catch {
      setTxns([]);
    } finally {
      setTxnLoading(false);
    }
  }, [store]);

  const openStock = (item) => {
    setStockItem(item);
    setStockMode(null);
    setStockForm(emptyStockForm());
    loadTxns(item.id);
  };

  const closeStock = () => { setStockItem(null); setStockMode(null); setTxns([]); };

  const submitStock = async () => {
    const qty = parseFloat(stockForm.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return showToast('Enter a valid quantity', 'error');
    if (!store) return showToast('Select a store first', 'error');
    setStockBusy(true);
    try {
      if (stockMode === 'receipt' || stockMode === 'issue') {
        await api.post('/inventory/stock/movement', {
          item_id:       stockItem.id,
          warehouse_id:  store,
          movement_type: stockMode === 'receipt' ? 'IN' : 'OUT',
          quantity:      qty,
          rate:          parseFloat(stockForm.rate) || 0,
          reference:     stockForm.reference,
          notes:         stockForm.notes,
        });
      } else if (stockMode === 'adjust') {
        await api.post('/inventory/stock-adjustments', {
          item_id:         stockItem.id,
          warehouse_id:    store,
          quantity:        qty,
          adjustment_type: stockForm.adjustment_type,
          reason:          stockForm.reference,
          notes:           stockForm.notes,
        });
      }
      showToast(stockMode === 'receipt' ? 'Stock received' : stockMode === 'issue' ? 'Stock issued' : 'Stock adjusted');
      setStockMode(null);
      setStockForm(emptyStockForm());
      await Promise.all([loadTxns(stockItem.id), load()]);
    } catch (e) {
      showToast(e.response?.data?.error || 'Stock action failed', 'error');
    } finally {
      setStockBusy(false);
    }
  };

  // Live on-hand for the open Stock drawer — recomputed from the latest grid rows
  const stockOnHand = stockItem
    ? Number(items.find(i => i.id === stockItem.id)?.current_stock ?? stockItem.current_stock ?? 0)
    : 0;

  const doDelete = async () => {
    if (!confirmDel) return;
    try {
      await api.delete(`/inventory/items/${confirmDel.id}`);
      showToast('Item deleted');
      setConfirmDel(null);
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to delete item', 'error');
    }
  };

  // ── Column model — drives header, cells, sorting, visibility and export ──
  const COLUMNS = [
    { key: 'item_code', label: 'Item Code', cls: 'im-mono', render: it => it.item_code },
    { key: 'item_name', label: 'Name', cls: 'im-name', render: it => it.item_name },
    { key: 'product_model', label: 'Model',
      render: it => it.product_model || <span style={{ color: '#9ca3af' }}>NA</span>,
      csv:    it => it.product_model || 'NA' },
    { key: 'category_name', label: 'Category', render: it => it.category_name || '—' },
    { key: 'abc_class', label: 'ABC', render: it => it.abc_class
        ? <span className="im-badge" style={{ background: ABC_BADGE[it.abc_class][0], color: ABC_BADGE[it.abc_class][1] }}>{it.abc_class}</span>
        : <span style={{ color: '#9ca3af' }}>—</span> },
    { key: 'item_type', label: 'Type', render: it => it.item_type },
    { key: 'vendor_price_count', label: 'Vendors', num: true, align: 'center',
      render: it => Number(it.vendor_price_count) > 0
        ? <span className="im-badge" style={{ background: '#ede9fe', color: '#6B3FDB' }}>{it.vendor_price_count}</span>
        : <span style={{ color: '#9ca3af' }}>—</span> },
    { key: 'unit_of_measure', label: 'UOM', render: it => it.unit_of_measure },
    { key: 'current_stock', label: store ? 'On Hand' : 'On Hand · all', num: true,
      title: store ? storeName : 'Summed across all stores',
      render: it => Number(it.current_stock || 0).toLocaleString('en-IN'),
      csv:    it => Number(it.current_stock || 0) },
    { key: 'reorder_level', label: 'Reorder', num: true, render: it => it.reorder_level },
    { key: 'standard_cost', label: 'Cost (₹)', num: true,
      render: it => `₹${parseFloat(it.standard_cost || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      csv:    it => parseFloat(it.standard_cost || 0) },
    { key: 'status', label: 'Status',
      render: it => { const ss = stockStatus(it.current_stock, it.reorder_level);
        return <span className="im-badge" style={{ background: ss.bg, color: ss.color }}>{ss.label}</span>; },
      csv:    it => stockStatus(it.current_stock, it.reorder_level).label },
  ];
  const visibleCols = COLUMNS.filter(c => !hiddenCols.has(c.key));

  // Status sorts by stock health (current ÷ reorder), not the label text
  const sortValue = (it, key) => {
    if (key === 'status') {
      const r = parseFloat(it.reorder_level) || 1;
      return (parseFloat(it.current_stock) || 0) / r;
    }
    return COLUMNS.find(c => c.key === key)?.num
      ? Number(it[key] || 0)
      : String(it[key] ?? '').toLowerCase();
  };

  const displayed = items.filter(it => {
    const q = search.toLowerCase();
    return (!q || it.item_name?.toLowerCase().includes(q) || it.item_code?.toLowerCase().includes(q))
        && (!fType || it.item_type === fType);
  });

  const sorted = [...displayed].sort((a, b) => {
    const av = sortValue(a, sortKey), bv = sortValue(b, sortKey);
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ?  1 : -1;
    return 0;
  });

  const totalPages = perPage === 0 ? 1 : Math.max(1, Math.ceil(sorted.length / perPage));
  const curPage    = Math.min(page, totalPages);
  const pageRows   = perPage === 0 ? sorted : sorted.slice((curPage - 1) * perPage, curPage * perPage);

  const exportCsv = () => {
    const stamp = new Date().toISOString().split('T')[0];
    toCSV(`item-master-${stamp}.csv`,
      visibleCols.map(c => c.label),
      sorted.map(it => visibleCols.map(c => (c.csv ? c.csv(it) : (it[c.key] ?? '')))));
    showToast(`Exported ${sorted.length} item${sorted.length !== 1 ? 's' : ''}`);
  };

  return (
    <div className="im-root">

      {toast && <div className={`im-toast im-toast-${toast.type}`}>{toast.msg}</div>}

      {readOnly && <ReadOnlyBanner />}

      <div className="im-header">
        <div>
          <h2 className="im-title">Item Master</h2>
          <p className="im-sub">{displayed.length} item{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="im-header-r">
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 10px', borderRadius: 8,
            border: `1px solid ${store ? '#ddd6fe' : '#fde68a'}`,
            background: store ? '#faf9ff' : '#fffbeb',
          }} title="Stock balances and stock actions are scoped to this store">
            <Store size={14} color={store ? '#6B3FDB' : '#d97706'} />
            <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>Store:</span>
            <select value={store} onChange={e => changeStore(e.target.value)}
              style={{ border: 'none', background: 'transparent', fontSize: 13, fontWeight: 600,
                       color: store ? '#1f2937' : '#b45309', cursor: 'pointer', outline: 'none', maxWidth: 180 }}>
              <option value="">Not selected</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.warehouse_name || w.name}</option>)}
            </select>
          </div>
          <button className="im-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          {!readOnly && <button className="im-btn-primary" onClick={openAdd}><Plus size={14} /> Add Item</button>}
        </div>
      </div>

      {/* filters */}
      <div className="im-filters">
        <div className="im-search">
          <Search size={14} />
          <input placeholder="Search by name or item code…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="im-select" value={fType} onChange={e => setFType(e.target.value)}>
          <option value="">All Types</option>
          {ITEM_TYPES.map(c => <option key={c}>{c}</option>)}
        </select>
        <select className="im-select" value={fCat} onChange={e => setFCat(e.target.value)}>
          <option value="">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {(search || fType || fCat) && (
          <button className="im-clear-btn" onClick={() => { setSearch(''); setFType(''); setFCat(''); }}>
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* grid toolbar — column visibility, export, rows per page */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, position: 'relative' }}>
        <div style={{ position: 'relative' }}>
          <button className="im-btn-outline" onClick={() => setColMenu(o => !o)} title="Show / hide columns">
            <Columns3 size={14} /> Columns{hiddenCols.size ? ` (${visibleCols.length}/${COLUMNS.length})` : ''}
          </button>
          {colMenu && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setColMenu(false)} />
              <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 41, background: '#fff',
                            border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,.12)',
                            padding: 8, minWidth: 190 }}>
                {COLUMNS.map(c => (
                  <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                                              fontSize: 13, cursor: 'pointer', borderRadius: 6 }}>
                    <input type="checkbox" checked={!hiddenCols.has(c.key)} onChange={() => toggleCol(c.key)} />
                    {c.label}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <button className="im-btn-outline" onClick={exportCsv} disabled={sorted.length === 0} title="Export to Excel (CSV)">
          <Download size={14} /> Excel
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#6b7280' }}>
          <span>Rows</span>
          <select className="im-select" value={perPage} onChange={e => setPerPage(Number(e.target.value))} style={{ minWidth: 78 }}>
            {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
            <option value={0}>All</option>
          </select>
          {perPage !== 0 && totalPages > 1 && (
            <>
              <button className="im-icon-btn" disabled={curPage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>‹</button>
              <span style={{ minWidth: 74, textAlign: 'center' }}>{curPage} / {totalPages}</span>
              <button className="im-icon-btn" disabled={curPage >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>›</button>
            </>
          )}
        </div>
      </div>

      {/* table */}
      {loading ? (
        <div className="im-loading"><div className="im-spinner" /></div>
      ) : sorted.length === 0 ? (
        <div className="im-empty">
          <Package size={40} color="#d1d5db" />
          <p>No items found</p>
        </div>
      ) : (
        <div className="im-table-wrap">
          <table className="im-table">
            <thead>
              <tr>
                {visibleCols.map(c => (
                  <th key={c.key} title={c.title} onClick={() => toggleSort(c.key)}
                      style={{ cursor: 'pointer', userSelect: 'none', textAlign: c.align || undefined }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      {c.label}
                      {sortKey === c.key && (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </span>
                  </th>
                ))}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(it => (
                <tr key={it.id} className="im-row" style={readOnly ? { cursor: 'default' } : undefined} onClick={() => { if (!readOnly) openEdit(it); }}>
                  {visibleCols.map(c => (
                    <td key={c.key} className={c.cls} style={{ textAlign: c.align || undefined }}>{c.render(it)}</td>
                  ))}
                  <td onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="im-edit-btn" title="Stock actions & transactions" onClick={() => openStock(it)}><Boxes size={13} /></button>
                      {!readOnly && <button className="im-edit-btn" title="Edit item" onClick={() => openEdit(it)}><Edit2 size={13} /></button>}
                      {!readOnly && <button className="im-edit-btn" title="Delete item" onClick={() => setConfirmDel(it)}><Trash2 size={13} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
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

              {/* Row 1: Item Code + Type */}
              <div className="im-row2">
                <div className="im-field">
                  <label>Item Code *</label>
                  <input value={form.item_code} onChange={e => setForm(f => ({ ...f, item_code: e.target.value }))} placeholder="e.g. RM-001" />
                </div>
                <div className="im-field">
                  <label>Item Type</label>
                  <select value={form.item_type} onChange={e => setForm(f => ({ ...f, item_type: e.target.value }))}>
                    <option value="">Select…</option>
                    {ITEM_TYPES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              {/* Item Name */}
              <div className="im-field">
                <label>Item Name *</label>
                <input value={form.item_name} onChange={e => setForm(f => ({ ...f, item_name: e.target.value }))} placeholder="Full item name" />
              </div>

              {/* Category + ABC Class */}
              <div className="im-row2">
                <div className="im-field">
                  <label>Category</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <select style={{ flex: 1 }} value={form.category_id} onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}>
                      <option value="">Select…</option>
                      {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button type="button" className="im-btn-outline" style={{ padding: '0 10px' }} onClick={handleAddCategory} title="Add category"><Plus size={14} /></button>
                  </div>
                </div>
                <div className="im-field">
                  <label>ABC Class <span style={{ color: '#9ca3af', fontWeight: 400 }}>(blank = auto)</span></label>
                  <select value={form.abc_class} onChange={e => setForm(f => ({ ...f, abc_class: e.target.value }))}>
                    <option value="">Auto (by consumption)</option>
                    {ABC_CLASSES.map(c => <option key={c} value={c}>Class {c}</option>)}
                  </select>
                </div>
              </div>

              {/* Row 2: HSN + GST */}
              <div className="im-row2">
                <div className="im-field">
                  <label>HSN Code</label>
                  <input value={form.hsn_code} onChange={e => setForm(f => ({ ...f, hsn_code: e.target.value }))} placeholder="e.g. 85044090" />
                </div>
                <div className="im-field">
                  <label>GST Rate (%)</label>
                  <input type="number" min="0" max="28" step="0.1" value={form.gst_rate} onChange={e => setForm(f => ({ ...f, gst_rate: e.target.value }))} placeholder="18" />
                </div>
              </div>

              {/* Manufacturer + Product Model */}
              <div className="im-row2">
                <div className="im-field">
                  <label>Manufacturer / Brand</label>
                  <input value={form.manufacturer} onChange={e => setForm(f => ({ ...f, manufacturer: e.target.value }))} placeholder="e.g. Infineon, ABB, Epcos" />
                </div>
                <div className="im-field">
                  <label>Product Model</label>
                  <input value={form.product_model} onChange={e => setForm(f => ({ ...f, product_model: e.target.value }))} placeholder="e.g. FF450R12ME4 (blank shows NA)" />
                </div>
              </div>

              {/* Row 3: UOM + Standard Cost */}
              <div className="im-row2">
                <div className="im-field">
                  <label>Unit of Measure</label>
                  <select value={form.unit_of_measure} onChange={e => setForm(f => ({ ...f, unit_of_measure: e.target.value }))}>
                    {UNITS.map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
                <div className="im-field">
                  <label>Standard Cost (₹)</label>
                  <input type="number" min="0" step="0.01" value={form.standard_cost} onChange={e => setForm(f => ({ ...f, standard_cost: e.target.value }))} />
                </div>
              </div>

              {/* Row 4: Reorder + Safety Stock */}
              <div className="im-row2">
                <div className="im-field">
                  <label>Reorder Level</label>
                  <input type="number" min="0" value={form.reorder_level} onChange={e => setForm(f => ({ ...f, reorder_level: e.target.value }))} />
                </div>
                <div className="im-field">
                  <label>Safety Stock</label>
                  <input type="number" min="0" value={form.safety_stock} onChange={e => setForm(f => ({ ...f, safety_stock: e.target.value }))} />
                </div>
              </div>

              {/* Lead Time */}
              <div className="im-field">
                <label>Lead Time (days)</label>
                <input type="number" min="0" value={form.lead_time_days} onChange={e => setForm(f => ({ ...f, lead_time_days: e.target.value }))} />
              </div>

              {/* Description */}
              <div className="im-field">
                <label>Description</label>
                <textarea rows={3} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional description" />
              </div>

              {/* Active toggle */}
              <div className="im-field im-field-inline">
                <label>Active</label>
                <input type="checkbox" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
              </div>

              {/* ── Vendor Prices (compare per store) ── */}
              <div style={{ borderTop: '1px solid #e5e7eb', margin: '18px 0 8px', paddingTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>Vendor Prices</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>Compare vendors &amp; prices per store</div>
                  </div>
                  {drawer !== 'add' && !readOnly && !priceForm && (
                    <button type="button" className="im-btn-outline" onClick={() => setPriceForm(emptyPrice())}>
                      <Plus size={13} /> Add Vendor Price
                    </button>
                  )}
                </div>

                {drawer === 'add' ? (
                  <div style={{ fontSize: 12, color: '#9ca3af', background: '#f9fafb', borderRadius: 8, padding: '12px 14px' }}>
                    Create the component first, then reopen it to add vendor prices to compare.
                  </div>
                ) : (
                  <>
                    {prices.length === 0 && !priceForm && (
                      <div style={{ fontSize: 12, color: '#9ca3af', background: '#f9fafb', borderRadius: 8, padding: '12px 14px' }}>
                        No vendor prices yet. Add a few to compare and pick the best.
                      </div>
                    )}

                    {prices.length > 0 && (() => {
                      const nets = prices.map(p => parseFloat(p.net_price ?? p.unit_price) || Infinity);
                      const best = Math.min(...nets);
                      return (
                        <div style={{ overflowX: 'auto', border: '1px solid #eef0f4', borderRadius: 8, marginBottom: 10 }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                            <thead>
                              <tr style={{ background: '#f9fafb', color: '#374151' }}>
                                <th style={thP}>Vendor</th><th style={thP}>Store</th>
                                <th style={{ ...thP, textAlign: 'right' }}>Net Price</th>
                                <th style={{ ...thP, textAlign: 'right' }}>MOQ</th>
                                <th style={{ ...thP, textAlign: 'right' }}>Lead</th>
                                <th style={thP}></th><th style={thP}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {prices.map((p, i) => {
                                const net = parseFloat(p.net_price ?? p.unit_price) || 0;
                                const isBest = net === best && net !== Infinity;
                                return (
                                  <tr key={p.id} style={{ borderTop: '1px solid #f3f4f6', background: isBest ? '#f0fdf4' : (i % 2 ? '#fafafa' : '#fff') }}>
                                    <td style={tdP}>
                                      {p.vendor_name}
                                      {p.is_preferred && <span className="im-badge" style={{ background: '#ede9fe', color: '#6B3FDB', marginLeft: 6 }}>Preferred</span>}
                                    </td>
                                    <td style={tdP}>{p.warehouse_name || 'All stores'}</td>
                                    <td style={{ ...tdP, textAlign: 'right', fontWeight: isBest ? 700 : 500, color: isBest ? '#15803d' : '#1f2937' }}>
                                      ₹{net.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                      {isBest && <span style={{ marginLeft: 4, fontSize: 10 }}>▼ best</span>}
                                    </td>
                                    <td style={{ ...tdP, textAlign: 'right' }}>{p.moq || '—'}</td>
                                    <td style={{ ...tdP, textAlign: 'right' }}>{p.lead_time_days ? `${p.lead_time_days}d` : '—'}</td>
                                    <td style={tdP}>{!readOnly && <button type="button" className="im-edit-btn" onClick={() => setPriceForm({ ...p, warehouse_id: p.warehouse_id ?? '' })}><Edit2 size={12} /></button>}</td>
                                    <td style={tdP}>{!readOnly && <button type="button" className="im-edit-btn" onClick={() => removePrice(p.id)}><X size={12} /></button>}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}

                    {priceForm && (
                      <div style={{ border: '1px solid #ddd6fe', background: '#faf9ff', borderRadius: 8, padding: 12 }}>
                        <div className="im-row2">
                          <div className="im-field">
                            <label>Vendor *</label>
                            <select value={priceForm.vendor_id} onChange={e => setPriceForm(p => ({ ...p, vendor_id: e.target.value }))}>
                              <option value="">Select vendor…</option>
                              {vendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                            </select>
                          </div>
                          <div className="im-field">
                            <label>Store</label>
                            <select value={priceForm.warehouse_id} onChange={e => setPriceForm(p => ({ ...p, warehouse_id: e.target.value }))}>
                              <option value="">All stores</option>
                              {warehouses.map(w => <option key={w.id} value={w.id}>{w.warehouse_name || w.name}</option>)}
                            </select>
                          </div>
                        </div>
                        <div className="im-row2">
                          <div className="im-field">
                            <label>Unit Price (₹) *</label>
                            <input type="number" min="0" step="0.01" value={priceForm.unit_price} onChange={e => setPriceForm(p => ({ ...p, unit_price: e.target.value }))} />
                          </div>
                          <div className="im-field">
                            <label>Discount (%)</label>
                            <input type="number" min="0" max="100" step="0.1" value={priceForm.discount_pct} onChange={e => setPriceForm(p => ({ ...p, discount_pct: e.target.value }))} />
                          </div>
                        </div>
                        <div className="im-row2">
                          <div className="im-field">
                            <label>MOQ</label>
                            <input type="number" min="0" value={priceForm.moq} onChange={e => setPriceForm(p => ({ ...p, moq: e.target.value }))} />
                          </div>
                          <div className="im-field">
                            <label>Lead Time (days)</label>
                            <input type="number" min="0" value={priceForm.lead_time_days} onChange={e => setPriceForm(p => ({ ...p, lead_time_days: e.target.value }))} />
                          </div>
                        </div>
                        <div className="im-row2">
                          <div className="im-field">
                            <label>Vendor SKU / Part No.</label>
                            <input value={priceForm.vendor_sku || ''} onChange={e => setPriceForm(p => ({ ...p, vendor_sku: e.target.value }))} placeholder="Optional" />
                          </div>
                          <div className="im-field im-field-inline" style={{ alignItems: 'center' }}>
                            <label>Preferred vendor</label>
                            <input type="checkbox" checked={!!priceForm.is_preferred} onChange={e => setPriceForm(p => ({ ...p, is_preferred: e.target.checked }))} />
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
                          <button type="button" className="im-btn-outline" onClick={() => setPriceForm(null)}>Cancel</button>
                          <button type="button" className="im-btn-primary" onClick={savePrice}>{priceForm.id ? 'Update Price' : 'Add Price'}</button>
                        </div>
                      </div>
                    )}
                  </>
                )}
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

      <ConfirmDialog
        open={!!confirmDel}
        variant="danger"
        title="Delete item"
        message={confirmDel ? `Delete "${confirmDel.item_name}" (${confirmDel.item_code})? It will be removed from the master; existing stock history is retained.` : ''}
        confirmLabel="Delete"
        onConfirm={doDelete}
        onCancel={() => setConfirmDel(null)}
      />

      {/* Stock Drawer — Receipt / Issue / Update Stock / Transactions */}
      {stockItem && (
        <div className="im-overlay" onClick={closeStock}>
          <div className="im-drawer" onClick={e => e.stopPropagation()}>
            <div className="im-drawer-hd">
              <h3>Stock — {stockItem.item_name}</h3>
              <button className="im-icon-btn" onClick={closeStock}><X size={16} /></button>
            </div>
            <div className="im-drawer-body">

              {/* Store context + on-hand */}
              {store ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              background: '#faf9ff', border: '1px solid #ede9fe', borderRadius: 8, padding: '12px 14px' }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>On hand · {storeName}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#1f2937' }}>
                      {stockOnHand.toLocaleString('en-IN')} <span style={{ fontSize: 13, fontWeight: 500, color: '#6b7280' }}>{stockItem.unit_of_measure}</span>
                    </div>
                  </div>
                  <Store size={22} color="#6B3FDB" />
                </div>
              ) : (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: '#b45309' }}>
                  No store selected — showing transactions across all stores. Pick a store in the header to receive, issue, or adjust stock.
                </div>
              )}

              {/* Action buttons */}
              {!readOnly && (
                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  <button type="button" className="im-btn-outline" disabled={!store}
                    onClick={() => { setStockMode('receipt'); setStockForm(emptyStockForm()); }}
                    style={{ flex: 1, justifyContent: 'center', opacity: store ? 1 : 0.55, ...(stockMode === 'receipt' ? { borderColor: '#6B3FDB', color: '#6B3FDB' } : {}) }}>
                    <ArrowDownToLine size={14} /> Receipt
                  </button>
                  <button type="button" className="im-btn-outline" disabled={!store}
                    onClick={() => { setStockMode('issue'); setStockForm(emptyStockForm()); }}
                    style={{ flex: 1, justifyContent: 'center', opacity: store ? 1 : 0.55, ...(stockMode === 'issue' ? { borderColor: '#6B3FDB', color: '#6B3FDB' } : {}) }}>
                    <ArrowUpFromLine size={14} /> Issue
                  </button>
                  <button type="button" className="im-btn-outline" disabled={!store}
                    onClick={() => { setStockMode('adjust'); setStockForm(emptyStockForm()); }}
                    style={{ flex: 1, justifyContent: 'center', opacity: store ? 1 : 0.55, ...(stockMode === 'adjust' ? { borderColor: '#6B3FDB', color: '#6B3FDB' } : {}) }}>
                    <SlidersHorizontal size={14} /> Update Stock
                  </button>
                </div>
              )}

              {/* Inline mini-form */}
              {stockMode && (
                <div style={{ border: '1px solid #ddd6fe', background: '#faf9ff', borderRadius: 8, padding: 12, marginTop: 12 }}>
                  {stockMode === 'adjust' && (
                    <div className="im-field">
                      <label>Adjustment Type</label>
                      <select value={stockForm.adjustment_type} onChange={e => setStockForm(f => ({ ...f, adjustment_type: e.target.value }))}>
                        <option value="Addition">Addition (+)</option>
                        <option value="Deduction">Deduction (−)</option>
                        <option value="Write-off">Write-off (−)</option>
                      </select>
                    </div>
                  )}
                  <div className="im-row2">
                    <div className="im-field">
                      <label>Quantity *</label>
                      <input type="number" min="0.01" step="0.01" value={stockForm.quantity}
                        onChange={e => setStockForm(f => ({ ...f, quantity: e.target.value }))} />
                    </div>
                    {stockMode === 'receipt' && (
                      <div className="im-field">
                        <label>Rate (₹)</label>
                        <input type="number" min="0" step="0.01" value={stockForm.rate}
                          onChange={e => setStockForm(f => ({ ...f, rate: e.target.value }))} />
                      </div>
                    )}
                  </div>
                  <div className="im-field">
                    <label>{stockMode === 'adjust' ? 'Reason' : 'Reference'}</label>
                    <input value={stockForm.reference} onChange={e => setStockForm(f => ({ ...f, reference: e.target.value }))}
                      placeholder={stockMode === 'receipt' ? 'e.g. GRN / PO no.' : stockMode === 'issue' ? 'e.g. WO / project' : 'e.g. cycle count'} />
                  </div>
                  <div className="im-field">
                    <label>Notes</label>
                    <textarea rows={2} value={stockForm.notes} onChange={e => setStockForm(f => ({ ...f, notes: e.target.value }))} />
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" className="im-btn-outline" onClick={() => setStockMode(null)}>Cancel</button>
                    <button type="button" className="im-btn-primary" onClick={submitStock} disabled={stockBusy}>
                      {stockBusy ? 'Saving…' : stockMode === 'receipt' ? 'Receive Stock' : stockMode === 'issue' ? 'Issue Stock' : 'Apply Adjustment'}
                    </button>
                  </div>
                </div>
              )}

              {/* Transactions history */}
              <div style={{ borderTop: '1px solid #e5e7eb', margin: '18px 0 8px', paddingTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                  <History size={15} color="#6b7280" />
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>Transactions</span>
                  <span style={{ fontSize: 12, color: '#9ca3af' }}>{store ? `· ${storeName}` : '· all stores'}</span>
                </div>
                {txnLoading ? (
                  <div style={{ fontSize: 13, color: '#9ca3af', padding: '10px 0' }}>Loading…</div>
                ) : txns.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9ca3af', background: '#f9fafb', borderRadius: 8, padding: '12px 14px' }}>
                    No transactions yet for this item{store ? ' in this store' : ''}.
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto', border: '1px solid #eef0f4', borderRadius: 8 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                      <thead>
                        <tr style={{ background: '#f9fafb', color: '#374151' }}>
                          <th style={thP}>Date</th><th style={thP}>Type</th>
                          <th style={{ ...thP, textAlign: 'right' }}>Qty</th>
                          <th style={{ ...thP, textAlign: 'right' }}>Balance</th>
                          <th style={thP}>Remarks</th>
                        </tr>
                      </thead>
                      <tbody>
                        {txns.map((t, i) => (
                          <tr key={t.id || i} style={{ borderTop: '1px solid #f3f4f6', background: i % 2 ? '#fafafa' : '#fff' }}>
                            <td style={tdP}>{t.transaction_date ? new Date(t.transaction_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                            <td style={tdP}>
                              <span className="im-badge" style={{ background: t.movement_type === 'IN' ? '#f0fdf4' : '#fef2f2', color: t.movement_type === 'IN' ? '#15803d' : '#dc2626' }}>
                                {t.movement_type === 'IN' ? '▲ IN' : '▼ OUT'}
                              </span>
                              <span style={{ marginLeft: 6, color: '#9ca3af' }}>{t.transaction_type}</span>
                            </td>
                            <td style={{ ...tdP, textAlign: 'right', fontWeight: 600, color: t.movement_type === 'IN' ? '#15803d' : '#dc2626' }}>
                              {t.movement_type === 'IN' ? '+' : '−'}{Number(t.quantity).toLocaleString('en-IN')}
                            </td>
                            <td style={{ ...tdP, textAlign: 'right' }}>{t.balance_qty != null ? Number(t.balance_qty).toLocaleString('en-IN') : '—'}</td>
                            <td style={tdP}>{t.reference || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

            </div>
            <div className="im-drawer-ft">
              <button className="im-btn-outline" onClick={closeStock}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
