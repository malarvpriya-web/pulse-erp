import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Plus, RefreshCw, X, ShoppingCart, ChevronDown } from 'lucide-react';
import api from '@/services/api/client';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import './PurchaseOrders.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

const fmtFull = n =>
  `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const calcLine = line => {
  const base = (parseFloat(line.quantity) || 0) * (parseFloat(line.unit_price) || 0);
  const gst  = base * (parseFloat(line.gst_rate) || 0) / 100;
  return { ...line, taxable_amount: base, gst_amount: gst, amount: base + gst };
};

const STATUS_COLOR = {
  draft:    { bg: '#f3f4f6', color: '#6b7280' },
  sent:     { bg: '#eef2ff', color: '#4338ca' },
  approved: { bg: '#dbeafe', color: '#1d4ed8' },
  partial:  { bg: '#ede9fe', color: '#5b21b6' },
  received: { bg: '#f0fdf4', color: '#15803d' },
  cancelled:{ bg: '#fef2f2', color: '#dc2626' },
};
const sc = s => STATUS_COLOR[(s || '').toLowerCase()] || STATUS_COLOR.draft;


/**
 * Label for a component in the line-item picker.
 *
 * `/inventory/items` returns `item_name` and has no bare `name` property at
 * all, so reading `it.name` rendered EVERY option blank: the dropdown listed
 * the right number of components with nothing written on any of them, and the
 * chosen line stored `item_name: undefined`. The code was silently correct —
 * a missing key is not an error — which is why it survived.
 *
 * The code is included because two components routinely share a name and the
 * buyer has to be able to tell them apart before committing to an order.
 */
const itemLabel = it =>
  [it?.item_code, it?.item_name || it?.name].filter(Boolean).join(' — ')
  || `Item #${it?.id ?? '?'}`;

const emptyLine = () => ({ item_id: '', item_name: '', quantity: 1, unit_price: '', gst_rate: 18, taxable_amount: 0, gst_amount: 0, amount: 0 });
const emptyForm = () => ({
  supplier_id: '', supplier_name: '', order_date: new Date().toISOString().slice(0, 10),
  expected_date: '', notes: '', lines: [emptyLine()],
  // Where the spend is charged. Both optional: an order can belong to a
  // project, to a cost centre, to both, or to neither.
  project_id: '', cost_center_id: '',
});

export default function PurchaseOrders() {
  const { readOnly } = usePageAccess();
  const [pos,       setPos]       = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [chargeTargets, setChargeTargets] = useState({ projects: [], cost_centres: [] });
  const [invItems,  setInvItems]  = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [search,    setSearch]    = useState('');
  const [fStatus,   setFStatus]   = useState('');
  const [drawer,    setDrawer]    = useState(null);   // null | 'create' | po-obj
  const [detail,    setDetail]    = useState(null);
  const [form,      setForm]      = useState(emptyForm());
  const [submitting,setSubmitting]= useState(false);
  const [toast,     setToast]     = useState(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const params = {};
    if (fStatus) params.status = fStatus;
    if (search)  params.search = search;
    const [posRes, suppRes, itemsRes, chargeRes] = await Promise.allSettled([
      api.get('/procurement/purchase-orders', { params }),
      api.get('/procurement/vendors'),
      api.get('/inventory/items'),
      api.get('/procurement/charge-targets'),
    ]);
    if (!isMounted.current) return;
    const rawPos  = posRes.status  === 'fulfilled' ? (posRes.value.data.orders || posRes.value.data) : [];
    setPos(Array.isArray(rawPos) ? rawPos : []);

    const rawSupp = suppRes.status === 'fulfilled' ? (suppRes.value.data.vendors || suppRes.value.data.suppliers || suppRes.value.data) : [];
    setSuppliers(Array.isArray(rawSupp) ? rawSupp : []);

    const rawItems= itemsRes.status=== 'fulfilled' ? (itemsRes.value.data.items || itemsRes.value.data) : [];
    setInvItems(Array.isArray(rawItems) ? rawItems : []);

    // Empty arrays rather than undefined on failure, so the two selectors render
    // as "Not project work" / "No cost centre" instead of throwing on .map.
    const charge = chargeRes.status === 'fulfilled' ? chargeRes.value.data : null;
    setChargeTargets({
      projects:     Array.isArray(charge?.projects)     ? charge.projects     : [],
      cost_centres: Array.isArray(charge?.cost_centres) ? charge.cost_centres : [],
    });

    setLoading(false);
  }, [fStatus, search]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async po => {
    try {
      const r = await api.get(`/procurement/purchase-orders/${po.id}`);
      if (!isMounted.current) return;
      setDetail(r.data.order || r.data);
    } catch { if (!isMounted.current) return; setDetail(po); }
    setDrawer('detail');
  };

  const updateLine = (idx, field, value) => {
    setForm(f => {
      const lines = f.lines.map((l, i) => i === idx ? calcLine({ ...l, [field]: value }) : l);
      return { ...f, lines };
    });
  };

  const addLine = () => setForm(f => ({ ...f, lines: [...f.lines, emptyLine()] }));
  const removeLine = idx => setForm(f => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }));

  const totals = form.lines.reduce((acc, l) => ({
    taxable: acc.taxable + (l.taxable_amount || 0),
    gst:     acc.gst     + (l.gst_amount || 0),
    total:   acc.total   + (l.amount || 0),
  }), { taxable: 0, gst: 0, total: 0 });

  // ── Total cost of ownership advisory ────────────────────────────────────
  // A PO typed straight into this form has one vendor and no competition, so
  // nothing here could ever tell the buyer that another approved source costs
  // less to own. This asks the server, while the drawer is still open and the
  // decision is still reversible. Advisory only — it never blocks the save.
  const [tcoAdvice, setTcoAdvice] = useState(null);
  const [tcoBusy,   setTcoBusy]   = useState(false);
  const adviceReq = useRef(0);

  const costedLines = form.lines.filter(l => l.item_id && (parseFloat(l.quantity) || 0) > 0);
  // Serialised so the effect fires on a real change to what is being bought,
  // not on every keystroke elsewhere in the drawer.
  const adviceKey = drawer === 'create' && form.supplier_id
    ? JSON.stringify([form.supplier_id, costedLines.map(l => [l.item_id, l.quantity, l.unit_price])])
    : '';

  useEffect(() => {
    if (!adviceKey) { setTcoAdvice(null); return; }
    const seq = ++adviceReq.current;
    const t = setTimeout(async () => {
      setTcoBusy(true);
      try {
        const { data } = await api.post('/procurement/tco/advisory', {
          vendor_id: form.supplier_id,
          lines: costedLines.map(l => ({
            item_id: l.item_id, quantity: l.quantity, rate: l.unit_price,
          })),
        });
        // A superseded response must not overwrite a newer one — the buyer edits
        // faster than the round-trip.
        if (isMounted.current && seq === adviceReq.current) setTcoAdvice(data);
      } catch {
        if (isMounted.current && seq === adviceReq.current) setTcoAdvice(null);
      } finally {
        if (isMounted.current && seq === adviceReq.current) setTcoBusy(false);
      }
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adviceKey]);

  const handleCreate = async () => {
    if (!form.supplier_id && !form.supplier_name) return showToast('Select a supplier', 'error');
    setSubmitting(true);
    try {
      await api.post('/procurement/purchase-orders', { ...form, total_amount: totals.total });
      if (!isMounted.current) return;
      showToast('Purchase order created');
      setDrawer(null);
      setForm(emptyForm());
      load();
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e.response?.data?.error || 'Failed to create PO', 'error');
    } finally { if (isMounted.current) setSubmitting(false); }
  };

  const handleReceive = async po => {
    try {
      await api.put(`/procurement/purchase-orders/${po.id}/status`, { status: 'received' });
      if (!isMounted.current) return;
      showToast('PO marked as Received');
      setDrawer(null);
      load();
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e.response?.data?.error || 'Failed to update', 'error');
    }
  };

  const displayed = pos.filter(p => {
    const q = search.toLowerCase();
    return (!q || p.po_number?.toLowerCase().includes(q) || p.supplier_name?.toLowerCase().includes(q))
        && (!fStatus || p.status?.toLowerCase() === fStatus.toLowerCase());
  });

  return (
    <PageShell dock={
      <PageHero
        icon={ShoppingCart}
        eyebrow="Procurement"
        title="Purchase Orders"
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={load}><RefreshCw size={14} /></button>
          {!readOnly && (
            <button className="plh-cta" onClick={() => { setForm(emptyForm()); setDrawer('create'); }}>
              <Plus size={14} /> New PO
            </button>
          )}
        </>}
      />
    }>

      {toast && <div className={`po-toast po-toast-${toast.type}`}>{toast.msg}</div>}

      {readOnly && <ReadOnlyBanner />}


      {/* filters */}
      <div className="po-filters">
        <div className="po-search">
          <Search size={14} />
          <input placeholder="Search PO number or supplier…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="po-select" value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option value="">All Status</option>
          {['Draft','Sent','Partial','Received','Cancelled'].map(s => <option key={s}>{s}</option>)}
        </select>
        {(search || fStatus) && (
          <button className="po-clear-btn" onClick={() => { setSearch(''); setFStatus(''); }}>
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* table */}
      {loading ? (
        <div className="po-loading"><div className="po-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="po-empty">
          <ShoppingCart size={40} color="#d1d5db" />
          <p>No purchase orders found</p>
        </div>
      ) : (
        <div className="po-table-wrap">
          <table className="po-table">
            <thead>
              <tr>
                <th>PO #</th><th>Supplier</th><th>Order Date</th>
                <th>Expected</th><th>Amount</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(po => {
                const c = sc(po.status);
                return (
                  <tr key={po.id} className="po-row" onClick={() => openDetail(po)}>
                    <td className="po-mono">{po.po_number}</td>
                    <td className="po-supplier">{po.supplier_name}</td>
                    <td>{po.order_date ? new Date(po.order_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td>{po.expected_date ? new Date(po.expected_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td className="po-amount">{fmtFull(po.total_amount)}</td>
                    <td><span className="po-badge" style={{ background: c.bg, color: c.color }}>{po.status}</span></td>
                    <td onClick={e => e.stopPropagation()}>
                      {!readOnly && (po.status === 'sent' || po.status === 'partial' || po.status === 'approved') && (
                        <button className="po-recv-btn" onClick={() => handleReceive(po)}>Receive</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Create PO Drawer ── */}
      {drawer === 'create' && (
        <div className="po-overlay" onClick={() => setDrawer(null)}>
          <div className="po-drawer po-drawer-wide" onClick={e => e.stopPropagation()}>
            <div className="po-drawer-hd">
              <h3>New Purchase Order</h3>
              <button className="po-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="po-drawer-body">
              {/* supplier + dates */}
              <div className="po-row2">
                <div className="po-field">
                  <label>Supplier *</label>
                  <select value={form.supplier_id}
                    onChange={e => {
                      const sup = suppliers.find(s => String(s.id) === e.target.value);
                      setForm(f => ({ ...f, supplier_id: e.target.value, supplier_name: sup?.name || '' }));
                    }}>
                    <option value="">Select supplier…</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div className="po-field">
                  <label>Order Date</label>
                  <input type="date" value={form.order_date} onChange={e => setForm(f => ({ ...f, order_date: e.target.value }))} />
                </div>
              </div>
              {/* Where the spend is charged. purchase_orders carried project_id
                  with no screen offering it, and no cost centre at all, so an
                  order could only be attributed by calling the API directly. */}
              <div className="po-row2">
                <div className="po-field">
                  <label>Project</label>
                  <select value={form.project_id}
                    onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}>
                    <option value="">Not project work</option>
                    {chargeTargets.projects.map(p => (
                      <option key={p.id} value={p.id}>{p.code ? `${p.code} — ${p.name}` : p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="po-field">
                  <label>Cost Centre</label>
                  <select value={form.cost_center_id}
                    onChange={e => setForm(f => ({ ...f, cost_center_id: e.target.value }))}>
                    <option value="">No cost centre</option>
                    {chargeTargets.cost_centres.map(c => (
                      <option key={c.id} value={c.id}>{c.code ? `${c.code} — ${c.name}` : c.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="po-row2">
                <div className="po-field">
                  <label>Expected Delivery</label>
                  <input type="date" value={form.expected_date} onChange={e => setForm(f => ({ ...f, expected_date: e.target.value }))} />
                </div>
                <div className="po-field">
                  <label>Notes</label>
                  <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional" />
                </div>
              </div>

              {/* line items */}
              <div className="po-lines-hd">
                <span>Line Items</span>
                <button className="po-add-line-btn" onClick={addLine}><Plus size={13} /> Add Line</button>
              </div>
              <div className="po-lines-wrap">
                <table className="po-lines-table">
                  <thead>
                    <tr>
                      <th>Item</th><th>Qty</th><th>Rate (₹)</th><th>GST %</th>
                      <th>Taxable</th><th>GST Amt</th><th>Total</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.lines.map((line, idx) => (
                      <tr key={idx}>
                        <td>
                          <select value={line.item_id}
                            onChange={e => {
                              const it = invItems.find(i => String(i.id) === e.target.value);
                              updateLine(idx, 'item_id', e.target.value);
                              if (it) updateLine(idx, 'item_name', itemLabel(it));
                            }}
                            style={{ width: 150, padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12 }}>
                            <option value="">Select…</option>
                            {invItems.map(it => <option key={it.id} value={it.id}>{itemLabel(it)}</option>)}
                          </select>
                        </td>
                        <td><input type="number" min="1" value={line.quantity} onChange={e => updateLine(idx, 'quantity', e.target.value)} className="po-line-input" style={{ width: 60 }} /></td>
                        <td><input type="number" min="0" step="0.01" value={line.unit_price} onChange={e => updateLine(idx, 'unit_price', e.target.value)} className="po-line-input" style={{ width: 80 }} /></td>
                        <td>
                          <select value={line.gst_rate} onChange={e => updateLine(idx, 'gst_rate', e.target.value)} className="po-line-select">
                            {[0,5,12,18,28].map(r => <option key={r}>{r}</option>)}
                          </select>
                        </td>
                        <td className="po-line-amt">{fmtFull(line.taxable_amount)}</td>
                        <td className="po-line-amt">{fmtFull(line.gst_amount)}</td>
                        <td className="po-line-amt po-line-total">{fmtFull(line.amount)}</td>
                        <td>
                          {form.lines.length > 1 && (
                            <button onClick={() => removeLine(idx)} className="po-del-line"><X size={12} /></button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* totals */}
              <div className="po-totals">
                <div className="po-total-row"><span>Taxable Amount</span><span>{fmtFull(totals.taxable)}</span></div>
                <div className="po-total-row"><span>GST</span><span>{fmtFull(totals.gst)}</span></div>
                <div className="po-total-row po-grand-total"><span>Total</span><span>{fmtFull(totals.total)}</span></div>
              </div>

              {/* ── Total cost of ownership ────────────────────────────────
                  The invoice total above is not the cost. This shows what the
                  order costs to own, and whether another approved vendor costs
                  less — while the drawer is still open. */}
              {(tcoBusy || tcoAdvice?.totals) && (
                <div style={{
                  marginTop: 14, padding: '13px 16px', borderRadius: 10, fontSize: 13, lineHeight: 1.55,
                  background: tcoAdvice?.advisory ? '#fffbeb' : '#f9fafb',
                  border: `1px solid ${tcoAdvice?.advisory ? '#fde68a' : '#e5e7eb'}`,
                  color: tcoAdvice?.advisory ? '#92400e' : '#4b5563',
                }}>
                  {tcoBusy && !tcoAdvice && <span style={{ color: '#9ca3af' }}>Costing this order…</span>}

                  {tcoAdvice?.totals && (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontWeight: 700 }}>
                        <span>Total cost of ownership</span>
                        <span>{fmtFull(tcoAdvice.totals.chosen_tco_total)}</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 2 }}>
                        Purchase price plus freight, carrying, ordering, inspection and rejects, less credit terms,
                        plus delivery risk — over a {tcoAdvice.basis?.horizon_months}-month horizon.
                      </div>

                      {tcoAdvice.advisory ? (
                        <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid #fde68a' }}>
                          <strong>{tcoAdvice.advisory.message}</strong>
                          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                            {tcoAdvice.advisory.lines.map(l => (
                              <li key={l.item_id}>
                                {l.item_name || `Item #${l.item_id}`} — <strong>{l.better_vendor}</strong> saves {fmtFull(l.saving)}
                              </li>
                            ))}
                          </ul>
                          <div style={{ marginTop: 7, fontSize: 11.5, color: '#a16207' }}>
                            Advisory only — there are good reasons to buy from a dearer source. This does not block the order.
                          </div>
                        </div>
                      ) : (
                        <div style={{ marginTop: 8, color: '#15803d', fontWeight: 600 }}>
                          {tcoAdvice.lines?.some(l => l.alternative_count > 0)
                            ? 'No approved vendor offers a lower total cost for these components.'
                            : 'No alternative vendor is priced for these components, so there is nothing to compare against.'}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="po-drawer-ft">
              <button className="po-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
              <button className="po-btn-primary" onClick={handleCreate} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create PO'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Detail Drawer ── */}
      {drawer === 'detail' && detail && (
        <div className="po-overlay" onClick={() => { setDrawer(null); setDetail(null); }}>
          <div className="po-drawer po-drawer-wide" onClick={e => e.stopPropagation()}>
            <div className="po-drawer-hd">
              <div>
                <span className="po-mono">{detail.po_number}</span>
                <h3 style={{ margin: '4px 0 0', fontSize: 16 }}>{detail.supplier_name}</h3>
              </div>
              <button className="po-icon-btn" onClick={() => { setDrawer(null); setDetail(null); }}><X size={16} /></button>
            </div>
            <div className="po-drawer-body">
              <div className="po-detail-meta-row">
                <span className="po-badge" style={{ background: sc(detail.status).bg, color: sc(detail.status).color }}>{detail.status}</span>
                <span className="po-meta-item">Order: {detail.order_date ? new Date(detail.order_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</span>
                <span className="po-meta-item">Expected: {detail.expected_date ? new Date(detail.expected_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</span>
              </div>
              {detail.notes && <p className="po-detail-notes">{detail.notes}</p>}

              {(detail.lines || detail.items || []).length > 0 && (
                <div className="po-lines-wrap">
                  <table className="po-lines-table">
                    <thead>
                      <tr><th>Item</th><th>Qty</th><th>Rate</th><th>GST%</th><th>Total</th></tr>
                    </thead>
                    <tbody>
                      {(detail.lines || detail.items || []).map((l, i) => (
                        <tr key={i}>
                          <td>{l.item_name || l.name}</td>
                          <td>{l.quantity}</td>
                          <td>{fmtFull(l.unit_price)}</td>
                          <td>{l.gst_rate}%</td>
                          <td className="po-line-total">{fmtFull(l.amount || l.total_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="po-totals">
                <div className="po-grand-total po-total-row">
                  <span>Total Amount</span><span>{fmtFull(detail.total_amount)}</span>
                </div>
              </div>
            </div>
            <div className="po-drawer-ft">
              {(detail.status === 'sent' || detail.status === 'partial' || detail.status === 'approved') && (
                <button className="po-btn-primary" onClick={() => handleReceive(detail)}>
                  Mark as Received
                </button>
              )}
              <button className="po-btn-outline" onClick={() => { setDrawer(null); setDetail(null); }}>Close</button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
