import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, RefreshCw, X, ArrowRightLeft } from 'lucide-react';
import api from '@/services/api/client';
import './StockMovements.css';

const SAMPLE_MOVES = [
  { id: 1, item_name: 'Steel Rods 12mm',    sku: 'SKU-005', movement_type: 'IN',  quantity: 500, reference: 'GRN-001', notes: 'Receipt against PO-001', created_at: '2024-11-01T09:00:00Z', created_by: 'Rajesh K' },
  { id: 2, item_name: 'Ball Bearings 20mm', sku: 'SKU-001', movement_type: 'OUT', quantity: 50,  reference: 'SO-102',  notes: 'Issued for production',   created_at: '2024-11-02T11:30:00Z', created_by: 'Priya S' },
  { id: 3, item_name: 'Packing Tape 48mm',  sku: 'SKU-003', movement_type: 'OUT', quantity: 30,  reference: 'ISS-007', notes: 'Dispatch packaging',        created_at: '2024-11-03T14:00:00Z', created_by: 'Anand M' },
  { id: 4, item_name: 'Lubricant Oil 5L',   sku: 'SKU-004', movement_type: 'IN',  quantity: 20,  reference: 'GRN-002', notes: 'Monthly restock',          created_at: '2024-11-05T10:00:00Z', created_by: 'Rajesh K' },
  { id: 5, item_name: 'Copper Wire 2.5mm',  sku: 'SKU-002', movement_type: 'IN',  quantity: 200, reference: 'GRN-003', notes: 'Received from Tata',        created_at: '2024-11-07T09:30:00Z', created_by: 'Priya S' },
  { id: 6, item_name: 'Steel Rods 12mm',    sku: 'SKU-005', movement_type: 'OUT', quantity: 80,  reference: 'WO-011',  notes: 'Work order issue',          created_at: '2024-11-08T15:00:00Z', created_by: 'Anand M' },
];

const SAMPLE_ITEMS = [
  { id: 1, name: 'Steel Rods 12mm',    sku: 'SKU-005' },
  { id: 2, name: 'Ball Bearings 20mm', sku: 'SKU-001' },
  { id: 3, name: 'Packing Tape 48mm',  sku: 'SKU-003' },
  { id: 4, name: 'Lubricant Oil 5L',   sku: 'SKU-004' },
  { id: 5, name: 'Copper Wire 2.5mm',  sku: 'SKU-002' },
];

const emptyAdj = () => ({
  item_id: '', item_name: '', adjustment_type: 'Addition',
  quantity: '', reason: '', notes: '', reference: '',
});

export default function StockMovements() {
  const [moves,     setMoves]     = useState([]);
  const [invItems,  setInvItems]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [fType,     setFType]     = useState('');
  const [drawer,    setDrawer]    = useState(false);
  const [form,      setForm]      = useState(emptyAdj());
  const [submitting,setSubmitting]= useState(false);
  const [toast,     setToast]     = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const params = {};
    if (fType)  params.type   = fType;
    if (search) params.search = search;
    const [movRes, itemsRes] = await Promise.allSettled([
      api.get('/inventory/stock/movement', { params }),
      api.get('/inventory/items'),
    ]);
    const rawMov = movRes.status   === 'fulfilled' ? (movRes.value.data.movements || movRes.value.data) : [];
    setMoves(Array.isArray(rawMov) && rawMov.length ? rawMov : SAMPLE_MOVES);

    const rawItems = itemsRes.status === 'fulfilled' ? (itemsRes.value.data.items || itemsRes.value.data) : [];
    setInvItems(Array.isArray(rawItems) && rawItems.length ? rawItems : SAMPLE_ITEMS);

    setLoading(false);
  }, [fType, search]);

  useEffect(() => { load(); }, [load]);

  const handleAdjust = async () => {
    if (!form.item_id || !form.quantity) return showToast('Item and quantity are required', 'error');
    setSubmitting(true);
    try {
      await api.post('/inventory/stock-adjustments', form);
      showToast('Stock adjustment saved');
      setDrawer(false);
      setForm(emptyAdj());
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to save adjustment', 'error');
    } finally { setSubmitting(false); }
  };

  const displayed = moves.filter(m => {
    const q = search.toLowerCase();
    return (!q || m.item_name?.toLowerCase().includes(q) || m.sku?.toLowerCase().includes(q) || m.reference?.toLowerCase().includes(q))
        && (!fType || m.movement_type === fType);
  });

  const inCount  = displayed.filter(m => m.movement_type === 'IN').length;
  const outCount = displayed.filter(m => m.movement_type === 'OUT').length;

  return (
    <div className="sm-root">

      {toast && <div className={`sm-toast sm-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="sm-header">
        <div>
          <h2 className="sm-title">Stock Movements</h2>
          <p className="sm-sub">
            {displayed.length} transactions &nbsp;·&nbsp;
            <span style={{ color: '#15803d' }}>▲ {inCount} IN</span> &nbsp;
            <span style={{ color: '#dc2626' }}>▼ {outCount} OUT</span>
          </p>
        </div>
        <div className="sm-header-r">
          <button className="sm-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="sm-btn-primary" onClick={() => { setForm(emptyAdj()); setDrawer(true); }}>
            <Plus size={14} /> Stock Adjustment
          </button>
        </div>
      </div>

      {/* filters */}
      <div className="sm-filters">
        <div className="sm-search">
          <Search size={14} />
          <input placeholder="Search item, SKU, reference…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="sm-tabs">
          {[{ label: 'All', val: '' }, { label: '▲ IN', val: 'IN' }, { label: '▼ OUT', val: 'OUT' }].map(t => (
            <button key={t.val} className={`sm-tab${fType === t.val ? ' sm-tab-active' : ''}`}
              onClick={() => setFType(t.val)}>{t.label}</button>
          ))}
        </div>
        {(search || fType) && (
          <button className="sm-clear-btn" onClick={() => { setSearch(''); setFType(''); }}>
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* table */}
      {loading ? (
        <div className="sm-loading"><div className="sm-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="sm-empty">
          <ArrowRightLeft size={40} color="#d1d5db" />
          <p>No movements found</p>
        </div>
      ) : (
        <div className="sm-table-wrap">
          <table className="sm-table">
            <thead>
              <tr>
                <th>Item</th><th>SKU</th><th>Type</th><th>Qty</th>
                <th>Reference</th><th>Notes</th><th>By</th><th>Date</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((m, i) => (
                <tr key={m.id || i}>
                  <td className="sm-item-name">{m.item_name}</td>
                  <td className="sm-mono">{m.sku}</td>
                  <td>
                    <span className="sm-badge" style={{
                      background: m.movement_type === 'IN' ? '#f0fdf4' : '#fef2f2',
                      color:      m.movement_type === 'IN' ? '#15803d' : '#dc2626',
                    }}>
                      {m.movement_type === 'IN' ? '▲ IN' : '▼ OUT'}
                    </span>
                  </td>
                  <td className="sm-qty" style={{ color: m.movement_type === 'IN' ? '#15803d' : '#dc2626' }}>
                    {m.movement_type === 'IN' ? '+' : '−'}{parseInt(m.quantity).toLocaleString('en-IN')}
                  </td>
                  <td className="sm-mono">{m.reference || '—'}</td>
                  <td className="sm-notes">{m.notes || '—'}</td>
                  <td>{m.created_by || '—'}</td>
                  <td>{m.created_at ? new Date(m.created_at).toLocaleDateString('en-IN') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Stock Adjustment Drawer */}
      {drawer && (
        <div className="sm-overlay" onClick={() => setDrawer(false)}>
          <div className="sm-drawer" onClick={e => e.stopPropagation()}>
            <div className="sm-drawer-hd">
              <h3>Stock Adjustment</h3>
              <button className="sm-icon-btn" onClick={() => setDrawer(false)}><X size={16} /></button>
            </div>
            <div className="sm-drawer-body">
              <div className="sm-field">
                <label>Item *</label>
                <select value={form.item_id}
                  onChange={e => {
                    const it = invItems.find(i => String(i.id) === e.target.value);
                    setForm(f => ({ ...f, item_id: e.target.value, item_name: it?.name || '' }));
                  }}>
                  <option value="">Select item…</option>
                  {invItems.map(it => <option key={it.id} value={it.id}>{it.name} ({it.sku})</option>)}
                </select>
              </div>
              <div className="sm-row2">
                <div className="sm-field">
                  <label>Adjustment Type</label>
                  <select value={form.adjustment_type} onChange={e => setForm(f => ({ ...f, adjustment_type: e.target.value }))}>
                    <option value="Addition">Addition (+)</option>
                    <option value="Deduction">Deduction (−)</option>
                    <option value="Transfer">Transfer</option>
                    <option value="Write-off">Write-off</option>
                  </select>
                </div>
                <div className="sm-field">
                  <label>Quantity *</label>
                  <input type="number" min="0.01" step="0.01" value={form.quantity}
                    onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} />
                </div>
              </div>
              <div className="sm-field">
                <label>Reference</label>
                <input value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} placeholder="e.g. ADJ-001" />
              </div>
              <div className="sm-field">
                <label>Reason</label>
                <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="Brief reason" />
              </div>
              <div className="sm-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Additional details" />
              </div>
            </div>
            <div className="sm-drawer-ft">
              <button className="sm-btn-outline" onClick={() => setDrawer(false)}>Cancel</button>
              <button className="sm-btn-primary" onClick={handleAdjust} disabled={submitting}>
                {submitting ? 'Saving…' : 'Save Adjustment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
