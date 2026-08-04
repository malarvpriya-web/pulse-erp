import { useState, useEffect, useCallback } from 'react';
import { Plus, RefreshCw, X, ArrowRightLeft } from 'lucide-react';
import api from '@/services/api/client';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import { PageLayout, PageHeader, TableContainer, FormCard, FormSection, EmptyState } from '@/components/pulse-ui';
import './StockMovements.css';


const emptyAdj = () => ({
  item_id: '', item_name: '', adjustment_type: 'Addition',
  quantity: '', reason: '', notes: '', reference: '',
});

export default function StockMovements() {
  const { readOnly } = usePageAccess();
  const [moves,     setMoves]     = useState([]);
  const [invItems,  setInvItems]  = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [search,    setSearch]    = useState('');
  const [fType,     setFType]     = useState('');
  const [drawer,    setDrawer]    = useState(false);
  const [form,      setForm]      = useState(emptyAdj());
  const [submitting,setSubmitting]= useState(false);
  const [toast,     setToast]     = useState(null);
  const [pendingAdj,setPendingAdj]= useState([]);
  const [actingId,  setActingId]  = useState(null);

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
    setMoves(Array.isArray(rawMov) ? rawMov : []);

    const rawItems = itemsRes.status === 'fulfilled' ? (itemsRes.value.data.items || itemsRes.value.data) : [];
    setInvItems(Array.isArray(rawItems) ? rawItems : []);

    setLoading(false);
  }, [fType, search]);

  const loadPending = useCallback(async () => {
    try {
      const res = await api.get('/inventory/stock-adjustments', { params: { status: 'pending' } });
      setPendingAdj(Array.isArray(res.data) ? res.data : []);
    } catch { /* silent — approval queue is a secondary view */ }
  }, []);

  useEffect(() => { load(); loadPending(); }, [load, loadPending]);

  const handleAdjust = async () => {
    if (!form.item_id || !form.quantity) return showToast('Item and quantity are required', 'error');
    setSubmitting(true);
    try {
      await api.post('/inventory/stock-adjustments', form);
      showToast('Adjustment submitted — awaiting approval before stock is affected');
      setDrawer(false);
      setForm(emptyAdj());
      load();
      loadPending();
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to save adjustment', 'error');
    } finally { setSubmitting(false); }
  };

  const handleApprove = async (id) => {
    setActingId(id);
    try {
      await api.post(`/inventory/stock-adjustments/${id}/approve`);
      showToast('Adjustment approved — stock updated');
      load();
      loadPending();
    } catch (e) {
      showToast(e.response?.data?.error || 'Approval failed', 'error');
    } finally { setActingId(null); }
  };

  const handleReject = async (id) => {
    setActingId(id);
    try {
      await api.post(`/inventory/stock-adjustments/${id}/reject`);
      showToast('Adjustment rejected');
      loadPending();
    } catch (e) {
      showToast(e.response?.data?.error || 'Rejection failed', 'error');
    } finally { setActingId(null); }
  };

  const displayed = moves.filter(m => {
    const q = search.toLowerCase();
    return (!q || m.item_name?.toLowerCase().includes(q) || m.sku?.toLowerCase().includes(q) || m.reference?.toLowerCase().includes(q))
        && (!fType || m.movement_type === fType);
  });

  const inCount  = displayed.filter(m => m.movement_type === 'IN').length;
  const outCount = displayed.filter(m => m.movement_type === 'OUT').length;

  const typeFilters = [
    { label: 'All', val: '' }, { label: '▲ IN', val: 'IN' }, { label: '▼ OUT', val: 'OUT' },
  ];

  return (
    <PageLayout>
      {toast && <div className={`sm-toast sm-toast-${toast.type}`}>{toast.msg}</div>}

      <PageHeader
        description={
          <>
            {displayed.length} transactions &nbsp;·&nbsp;
            <span style={{ color: '#15803d' }}>▲ {inCount} IN</span> &nbsp;
            <span style={{ color: '#dc2626' }}>▼ {outCount} OUT</span>
          </>
        }
        actions={
          <>
            <button className="pl-icon-btn" onClick={load}><RefreshCw size={14} /> Refresh</button>
            {!readOnly && (
              <button className="pulse-btn-primary" onClick={() => { setForm(emptyAdj()); setDrawer(true); }}>
                <Plus size={14} /> Stock Adjustment
              </button>
            )}
          </>
        }
        search={{ value: search, onChange: setSearch, placeholder: 'Search item, SKU, reference…' }}
        filters={
          <div style={{ display: 'flex', gap: 6 }}>
            {typeFilters.map(t => (
              <button
                key={t.val}
                type="button"
                className={`pl-icon-btn${fType === t.val ? ' pl-active' : ''}`}
                onClick={() => setFType(t.val)}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />

      {readOnly && <ReadOnlyBanner />}

      {pendingAdj.length > 0 && (
        <div className="pl-card" style={{ marginBottom: 16, borderColor: '#fde68a', background: '#fffbeb' }}>
          <div style={{ padding: '10px 14px', fontWeight: 600, fontSize: 13, color: '#92400e' }}>
            {pendingAdj.length} adjustment{pendingAdj.length === 1 ? '' : 's'} awaiting approval
          </div>
          <div className="pl-table-scroll">
            <table>
              <thead>
                <tr><th>Number</th><th>Type</th><th>Warehouse</th><th>Reason</th><th>Date</th><th></th></tr>
              </thead>
              <tbody>
                {pendingAdj.map(a => (
                  <tr key={a.id}>
                    <td className="sm-mono">{a.adjustment_number}</td>
                    <td>{a.adjustment_type === 'increase' ? '▲ Increase' : '▼ Decrease'}</td>
                    <td>{a.warehouse_id}</td>
                    <td className="sm-notes">{a.reason || '—'}</td>
                    <td>{a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {!readOnly && (
                        <>
                          <button className="pulse-btn-primary" style={{ marginRight: 6, padding: '4px 10px', fontSize: 12 }}
                            disabled={actingId === a.id} onClick={() => handleApprove(a.id)}>
                            {actingId === a.id ? '…' : 'Approve'}
                          </button>
                          <button className="pulse-btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }}
                            disabled={actingId === a.id} onClick={() => handleReject(a.id)}>
                            Reject
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <TableContainer
        loading={loading}
        isEmpty={displayed.length === 0}
        emptyState={<EmptyState icon={ArrowRightLeft} title="No movements found" />}
        rowCount={displayed.length}
      >
        <table>
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
                <td>{m.created_at ? new Date(m.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableContainer>

      {/* Stock Adjustment Drawer */}
      {drawer && (
        <div className="sm-overlay" onClick={() => setDrawer(false)}>
          <div className="sm-drawer" onClick={e => e.stopPropagation()}>
            <div className="sm-drawer-hd">
              <h3>Stock Adjustment</h3>
              <button className="pl-icon-btn" onClick={() => setDrawer(false)}><X size={16} /></button>
            </div>
            <div className="sm-drawer-body">
              <FormCard
                footer={
                  <>
                    <button className="pulse-btn-secondary" onClick={() => setDrawer(false)}>Cancel</button>
                    <button className="pulse-btn-primary" onClick={handleAdjust} disabled={submitting}>
                      {submitting ? 'Saving…' : 'Save Adjustment'}
                    </button>
                  </>
                }
              >
                <FormSection title="Adjustment Details" collapsible={false}>
                  <div className="pulse-field">
                    <label>Item *</label>
                    <select value={form.item_id}
                      onChange={e => {
                        const it = invItems.find(i => String(i.id) === e.target.value);
                        setForm(f => ({ ...f, item_id: e.target.value, item_name: it?.item_name || '' }));
                      }}>
                      <option value="">Select item…</option>
                      {invItems.map(it => <option key={it.id} value={it.id}>{it.item_name} ({it.item_code})</option>)}
                    </select>
                  </div>
                  <div className="sm-row2">
                    <div className="pulse-field">
                      <label>Adjustment Type</label>
                      <select value={form.adjustment_type} onChange={e => setForm(f => ({ ...f, adjustment_type: e.target.value }))}>
                        <option value="Addition">Addition (+)</option>
                        <option value="Deduction">Deduction (−)</option>
                        <option value="Transfer">Transfer</option>
                        <option value="Write-off">Write-off</option>
                      </select>
                    </div>
                    <div className="pulse-field">
                      <label>Quantity *</label>
                      <input type="number" min="0.01" step="0.01" value={form.quantity}
                        onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} />
                    </div>
                  </div>
                  <div className="pulse-field">
                    <label>Reference</label>
                    <input value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} placeholder="e.g. ADJ-001" />
                  </div>
                  <div className="pulse-field">
                    <label>Reason</label>
                    <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="Brief reason" />
                  </div>
                  <div className="pulse-field">
                    <label>Notes</label>
                    <textarea rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Additional details" />
                  </div>
                </FormSection>
              </FormCard>
            </div>
          </div>
        </div>
      )}
    </PageLayout>
  );
}
