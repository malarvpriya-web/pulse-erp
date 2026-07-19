/**
 * Product Setup — the master every "Product" dropdown in the app reads.
 *
 * Backed by product_lines + product_ratings (see 20260716000007). The previous
 * version of this page managed `products`, whose live table never had the 17
 * columns the page and its routes assumed, so the grid was permanently empty.
 *
 * A product is a line plus an optional voltage: 'ASTRA' + '415V' renders
 * 'ASTRA - 415V', while 'ACB' has no voltage and renders as itself. display_name
 * is generated in the DB, so the grid never re-derives it.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Package, Plus, Edit2, Trash2, X, Search, RefreshCw, ChevronUp, ChevronDown, AlertTriangle } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const VOLTAGE_CLASSES = ['LV', 'MV', 'HV'];
const PAGE_SIZE = 10;

const EMPTY_PRODUCT = { line_name: '', voltage: '', voltage_class: 'LV', description: '', is_active: true };
const EMPTY_RATING  = { rating: '', description: '', is_active: true };

const s = {
  inp:      { padding: '7px 11px', border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 7, fontSize: 13, outline: 'none', background: '#fff', width: '100%', boxSizing: 'border-box' },
  label:    { display: 'flex', flexDirection: 'column', gap: 4 },
  labelTxt: { fontSize: 12, fontWeight: 600, color: '#374151' },
  grid2:    { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  sectionH: { fontSize: 14, fontWeight: 700, color: '#111827', margin: 0 },
};

function Field({ label, required, hint, children }) {
  return (
    <label style={s.label}>
      <span style={s.labelTxt}>
        {label}{required && <span style={{ color: 'var(--color-danger, #dc2626)' }}> *</span>}
      </span>
      {children}
      {hint && <span style={{ fontSize: 11, color: 'var(--color-text-secondary, #6b7280)' }}>{hint}</span>}
    </label>
  );
}

// ── Sortable column header ────────────────────────────────────────────────────
function SortTh({ label, col, sort, onSort, width }) {
  const active = sort.col === col;
  return (
    <th style={{ cursor: 'pointer', userSelect: 'none', ...(width ? { width } : {}) }}
        onClick={() => onSort(col)}
        title={`Sort by ${label}`}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        {active
          ? (sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
          : <ChevronUp size={12} style={{ opacity: 0.25 }} />}
      </span>
    </th>
  );
}

// ── Pagination — each grid gets its own instance and its own page state ───────
function Pagination({ total, page, pageSize, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from  = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to    = Math.min(page * pageSize, total);

  // Window the numbers so a long master doesn't render 40 buttons.
  const nums = [];
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  for (let i = start; i <= Math.min(pages, start + 4); i++) nums.push(i);

  const btn = (extra = {}) => ({
    padding: '5px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
    border: '1px solid var(--color-border, #e5e7eb)', background: '#fff',
    color: '#374151', ...extra,
  });

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: '1px solid var(--color-border-tertiary, #f3f4f6)', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: 'var(--color-text-secondary, #6b7280)' }}>
        Showing {from} to {to} of {total} entries
      </span>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button onClick={() => onPage(page - 1)} disabled={page <= 1}
                style={btn({ opacity: page <= 1 ? 0.45 : 1, cursor: page <= 1 ? 'not-allowed' : 'pointer' })}>
          Previous
        </button>
        {nums.map(n => (
          <button key={n} onClick={() => onPage(n)}
                  style={btn(n === page
                    ? { background: 'var(--color-primary, #6B3FDB)', color: '#fff', borderColor: 'var(--color-primary, #6B3FDB)', fontWeight: 700 }
                    : {})}>
            {n}
          </button>
        ))}
        <button onClick={() => onPage(page + 1)} disabled={page >= pages}
                style={btn({ opacity: page >= pages ? 0.45 : 1, cursor: page >= pages ? 'not-allowed' : 'pointer' })}>
          Next
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ active }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700,
      background: active ? 'var(--color-success-bg, #dcfce7)' : '#f3f4f6',
      color: active ? 'var(--color-success, #15803d)' : '#9ca3af',
    }}>
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

// ── Modal shell ───────────────────────────────────────────────────────────────
function Modal({ title, children, onClose, onSave, saving, saveLabel }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: 560, maxWidth: '100%', maxHeight: '92vh', overflowY: 'auto', padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4 }}><X size={18} /></button>
        </div>
        {children}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 18, marginTop: 4, borderTop: '1px solid var(--color-border-tertiary, #f3f4f6)' }}>
          <button className="pulse-btn-secondary" onClick={onClose}>Cancel</button>
          <button className="pulse-btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProductSetup() {
  const [rows,     setRows]     = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [loadErr,  setLoadErr]  = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [msg,      setMsg]      = useState(null);

  const [search,   setSearch]   = useState('');
  const [sort,     setSort]     = useState({ col: 'display_name', dir: 'asc' });
  const [page,     setPage]     = useState(1);

  const [selectedId, setSelectedId] = useState(null);
  const [prodModal,  setProdModal]  = useState(null);   // null | 'create' | 'edit'
  const [prodForm,   setProdForm]   = useState(EMPTY_PRODUCT);
  const [pendingDeleteProduct, setPendingDeleteProduct] = useState(null);

  const [ratings,     setRatings]     = useState([]);
  const [ratingsBusy, setRatingsBusy] = useState(false);
  const [ratingsErr,  setRatingsErr]  = useState(null);
  const [ratingSort,  setRatingSort]  = useState({ col: 'rating', dir: 'asc' });
  const [ratingPage,  setRatingPage]  = useState(1);
  const [ratingModal, setRatingModal] = useState(null); // null | 'create' | 'edit'
  const [ratingForm,  setRatingForm]  = useState(EMPTY_RATING);
  const [editRatingId, setEditRatingId] = useState(null);
  const [pendingDeleteRating, setPendingDeleteRating] = useState(null);

  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const toast = useCallback((text, type = 'ok') => {
    setMsg({ text, type });
    setTimeout(() => { if (isMounted.current) setMsg(null); }, 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const r = await api.get('/admin/product-lines?show_all=1');
      if (isMounted.current) setRows(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      if (isMounted.current) {
        setRows([]);
        setLoadErr(e.response?.data?.error || e.message || 'Could not load the product master');
      }
    } finally { if (isMounted.current) setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadRatings = useCallback(async (productId) => {
    if (!productId) { setRatings([]); return; }
    setRatingsBusy(true);
    setRatingsErr(null);
    try {
      const r = await api.get(`/admin/product-lines/${productId}/ratings?show_all=1`);
      if (isMounted.current) setRatings(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      if (isMounted.current) {
        setRatings([]);
        setRatingsErr(e.response?.data?.error || e.message || 'Could not load ratings');
      }
    } finally { if (isMounted.current) setRatingsBusy(false); }
  }, []);

  useEffect(() => { setRatingPage(1); loadRatings(selectedId); }, [selectedId, loadRatings]);

  const selected = useMemo(() => rows.find(r => r.id === selectedId) || null, [rows, selectedId]);

  // ── Master grid: search → sort → page ──────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = !q ? rows : rows.filter(r =>
      [r.display_name, r.description, r.voltage_class].some(v => (v || '').toLowerCase().includes(q))
    );
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) =>
      (a[sort.col] || '').localeCompare(b[sort.col] || '', undefined, { numeric: true }) * dir
    );
  }, [rows, search, sort]);

  useEffect(() => { setPage(1); }, [search]);

  const pageRows = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page]
  );

  const sortedRatings = useMemo(() => {
    const dir = ratingSort.dir === 'asc' ? 1 : -1;
    return [...ratings].sort((a, b) =>
      (a[ratingSort.col] || '').localeCompare(b[ratingSort.col] || '', undefined, { numeric: true }) * dir
    );
  }, [ratings, ratingSort]);

  const ratingPageRows = useMemo(
    () => sortedRatings.slice((ratingPage - 1) * PAGE_SIZE, ratingPage * PAGE_SIZE),
    [sortedRatings, ratingPage]
  );

  const toggleSort = (setter) => (col) =>
    setter(prev => ({ col, dir: prev.col === col && prev.dir === 'asc' ? 'desc' : 'asc' }));

  // ── Product writes ─────────────────────────────────────────────────────────
  const openCreate = () => { setProdForm(EMPTY_PRODUCT); setProdModal('create'); };
  const openEdit = () => {
    if (!selected) return;
    setProdForm({
      line_name: selected.line_name || '',
      voltage: selected.voltage || '',
      voltage_class: selected.voltage_class || 'LV',
      description: selected.description || '',
      is_active: selected.is_active !== false,
    });
    setProdModal('edit');
  };

  const saveProduct = async () => {
    if (!prodForm.line_name.trim()) return toast('Product name is required', 'err');
    setSaving(true);
    try {
      if (prodModal === 'create') {
        const r = await api.post('/admin/product-lines', prodForm);
        toast('Product created');
        setSelectedId(r.data?.id ?? null);
      } else {
        await api.put(`/admin/product-lines/${selectedId}`, prodForm);
        toast('Product updated');
      }
      setProdModal(null);
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
    finally { setSaving(false); }
  };

  const deleteProduct = async () => {
    const row = pendingDeleteProduct;
    setPendingDeleteProduct(null);
    if (!row) return;
    try {
      await api.delete(`/admin/product-lines/${row.id}`);
      toast('Product deleted');
      if (selectedId === row.id) setSelectedId(null);
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
  };

  // ── Rating writes ──────────────────────────────────────────────────────────
  const openRatingCreate = () => { setRatingForm(EMPTY_RATING); setEditRatingId(null); setRatingModal('create'); };
  const openRatingEdit = (row) => {
    setRatingForm({ rating: row.rating || '', description: row.description || '', is_active: row.is_active !== false });
    setEditRatingId(row.id);
    setRatingModal('edit');
  };

  const saveRating = async () => {
    if (!ratingForm.rating.trim()) return toast('Rating is required', 'err');
    setSaving(true);
    try {
      if (ratingModal === 'create') {
        await api.post(`/admin/product-lines/${selectedId}/ratings`, ratingForm);
        toast('Rating added');
      } else {
        await api.put(`/admin/product-ratings/${editRatingId}`, ratingForm);
        toast('Rating updated');
      }
      setRatingModal(null);
      loadRatings(selectedId);
      load();                       // keep the master's rating count honest
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
    finally { setSaving(false); }
  };

  const deleteRating = async () => {
    const row = pendingDeleteRating;
    setPendingDeleteRating(null);
    if (!row) return;
    try {
      await api.delete(`/admin/product-ratings/${row.id}`);
      toast('Rating deleted');
      loadRatings(selectedId);
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
  };

  const iconBtn = (tone) => ({
    padding: '5px 8px', border: 'none', borderRadius: 6, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600,
    background: tone === 'danger' ? 'var(--color-danger-bg, #fee2e2)' : '#f3f4f6',
    color: tone === 'danger' ? 'var(--color-danger, #dc2626)' : '#374151',
  });
  const disabledBtn = { opacity: 0.45, cursor: 'not-allowed' };

  return (
    <div className="pulse-page">
      <ConfirmDialog
        open={!!pendingDeleteProduct}
        title="Delete Product"
        message={pendingDeleteProduct
          ? `Delete "${pendingDeleteProduct.display_name}"? Projects already linked to it keep their link, but it will no longer be offered in Product dropdowns.`
          : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteProduct}
        onCancel={() => setPendingDeleteProduct(null)}
      />
      <ConfirmDialog
        open={!!pendingDeleteRating}
        title="Delete Rating"
        message={pendingDeleteRating ? `Delete rating "${pendingDeleteRating.rating}"?` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteRating}
        onCancel={() => setPendingDeleteRating(null)}
      />

      {/* Header */}
      <div className="pulse-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: '#f3efff', color: 'var(--color-primary, #6B3FDB)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Package size={20} />
          </div>
          <div>
            <h1 className="pulse-page-title">Product Setup</h1>
            <p className="pulse-page-subtitle">
              The product master. Every Product dropdown in the app reads this list — changes are audit-logged.
            </p>
          </div>
        </div>
        <button className="pulse-btn-secondary" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {msg && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          background: msg.type === 'ok' ? 'var(--color-success-bg, #dcfce7)' : 'var(--color-danger-bg, #fee2e2)',
          color: msg.type === 'ok' ? 'var(--color-success, #15803d)' : 'var(--color-danger, #dc2626)',
        }}>
          {msg.text}
        </div>
      )}

      {/* ── Product master ────────────────────────────────────────────────── */}
      <div className="pulse-card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 14px 12px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="pulse-btn-primary" onClick={openCreate}><Plus size={14} /> New</button>
            <button onClick={openEdit} disabled={!selected}
                    style={{ ...iconBtn(), padding: '9px 14px', ...(selected ? {} : disabledBtn) }}>
              <Edit2 size={13} /> Edit
            </button>
            <button onClick={() => selected && setPendingDeleteProduct(selected)} disabled={!selected}
                    style={{ ...iconBtn('danger'), padding: '9px 14px', ...(selected ? {} : disabledBtn) }}>
              <Trash2 size={13} /> Delete
            </button>
          </div>
          <div className="pulse-search-wrap" style={{ marginBottom: 0 }}>
            <Search size={14} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…" />
          </div>
        </div>

        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : loadErr ? (
          <div style={{ padding: 32, textAlign: 'center' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--color-danger, #dc2626)', fontSize: 13, marginBottom: 12 }}>
              <AlertTriangle size={15} /> {loadErr}
            </div>
            <div><button className="pulse-btn-secondary" onClick={load}>Retry</button></div>
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <SortTh label="Product"     col="display_name" sort={sort} onSort={toggleSort(setSort)} />
                    <SortTh label="Description" col="description"  sort={sort} onSort={toggleSort(setSort)} />
                    <th style={{ width: 90 }}>Ratings</th>
                    <th style={{ width: 90 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 ? (
                    <tr><td colSpan={4} className="empty-state">No data available in table</td></tr>
                  ) : pageRows.map(row => {
                    const isSel = row.id === selectedId;
                    return (
                      <tr key={row.id}
                          onClick={() => setSelectedId(isSel ? null : row.id)}
                          style={{ cursor: 'pointer', background: isSel ? '#f3efff' : undefined }}>
                        <td style={{ fontWeight: 600 }}>{row.display_name}</td>
                        <td style={{ color: row.description ? undefined : '#9ca3af' }}>{row.description || '—'}</td>
                        <td style={{ color: 'var(--color-text-secondary, #6b7280)' }}>{row.rating_count}</td>
                        <td><StatusBadge active={row.is_active !== false} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination total={filtered.length} page={page} pageSize={PAGE_SIZE} onPage={setPage} />
          </>
        )}
      </div>

      {/* ── Ratings sub-grid ──────────────────────────────────────────────── */}
      <div className="pulse-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 14px 12px', flexWrap: 'wrap' }}>
          <div>
            <h2 style={s.sectionH}>Product Ratings</h2>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--color-text-secondary, #6b7280)' }}>
              {selected
                ? <>Ratings for <strong>{selected.display_name}</strong></>
                : 'Select a product above to see its ratings'}
            </p>
          </div>
          <button className="pulse-btn-primary" onClick={openRatingCreate} disabled={!selected}
                  style={selected ? {} : disabledBtn}>
            <Plus size={14} /> New Rating
          </button>
        </div>

        {ratingsBusy ? (
          <div className="empty-state">Loading…</div>
        ) : ratingsErr ? (
          <div style={{ padding: 32, textAlign: 'center' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--color-danger, #dc2626)', fontSize: 13, marginBottom: 12 }}>
              <AlertTriangle size={15} /> {ratingsErr}
            </div>
            <div><button className="pulse-btn-secondary" onClick={() => loadRatings(selectedId)}>Retry</button></div>
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 200 }}>Product</th>
                    <SortTh label="Rating"      col="rating"      sort={ratingSort} onSort={toggleSort(setRatingSort)} width={180} />
                    <SortTh label="Description" col="description" sort={ratingSort} onSort={toggleSort(setRatingSort)} />
                    <th style={{ width: 90 }}>Status</th>
                    <th style={{ width: 100 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {ratingPageRows.length === 0 ? (
                    <tr><td colSpan={5} className="empty-state">No data available in table</td></tr>
                  ) : ratingPageRows.map(row => (
                    <tr key={row.id}>
                      <td style={{ color: 'var(--color-text-secondary, #6b7280)' }}>{row.product}</td>
                      <td style={{ fontWeight: 600 }}>{row.rating}</td>
                      <td style={{ color: row.description ? undefined : '#9ca3af' }}>{row.description || '—'}</td>
                      <td><StatusBadge active={row.is_active !== false} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => openRatingEdit(row)} title="Edit" style={iconBtn()}><Edit2 size={13} /></button>
                          <button onClick={() => setPendingDeleteRating(row)} title="Delete" style={iconBtn('danger')}><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination total={sortedRatings.length} page={ratingPage} pageSize={PAGE_SIZE} onPage={setRatingPage} />
          </>
        )}
      </div>

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {prodModal && (
        <Modal
          title={prodModal === 'create' ? 'New Product' : 'Edit Product'}
          onClose={() => setProdModal(null)}
          onSave={saveProduct}
          saving={saving}
          saveLabel={prodModal === 'create' ? 'Create Product' : 'Save Changes'}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={s.grid2}>
              <Field label="Product Name" required hint="e.g. ASTRA, ACB, MV-VAJRA">
                <input value={prodForm.line_name} onChange={e => setProdForm(f => ({ ...f, line_name: e.target.value }))}
                       placeholder="e.g. ASTRA" style={s.inp} />
              </Field>
              <Field label="Voltage" hint="Leave blank if the product has no voltage variant">
                <input value={prodForm.voltage} onChange={e => setProdForm(f => ({ ...f, voltage: e.target.value }))}
                       placeholder="e.g. 415V" style={s.inp} />
              </Field>
            </div>
            <div style={s.grid2}>
              <Field label="Voltage Class" required hint="The LV/MV/HV rollup Project Master reads">
                <select value={prodForm.voltage_class} onChange={e => setProdForm(f => ({ ...f, voltage_class: e.target.value }))} style={s.inp}>
                  {VOLTAGE_CLASSES.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </Field>
              <Field label="Status">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={prodForm.is_active}
                         onChange={e => setProdForm(f => ({ ...f, is_active: e.target.checked }))}
                         style={{ width: 16, height: 16, cursor: 'pointer' }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: prodForm.is_active ? 'var(--color-success, #15803d)' : '#6b7280' }}>
                    {prodForm.is_active ? 'Active' : 'Inactive'}
                  </span>
                </label>
              </Field>
            </div>
            <Field label="Description">
              <input value={prodForm.description} onChange={e => setProdForm(f => ({ ...f, description: e.target.value }))}
                     placeholder="Short description" style={s.inp} />
            </Field>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary, #6b7280)', background: '#f9fafb', border: '1px solid var(--color-border-tertiary, #f3f4f6)', borderRadius: 8, padding: '8px 11px' }}>
              Shown everywhere as{' '}
              <strong style={{ color: '#111827' }}>
                {prodForm.line_name.trim()
                  ? (prodForm.voltage.trim() ? `${prodForm.line_name.trim()} - ${prodForm.voltage.trim()}` : prodForm.line_name.trim())
                  : '—'}
              </strong>
            </div>
          </div>
        </Modal>
      )}

      {ratingModal && (
        <Modal
          title={ratingModal === 'create' ? `New Rating — ${selected?.display_name ?? ''}` : 'Edit Rating'}
          onClose={() => setRatingModal(null)}
          onSave={saveRating}
          saving={saving}
          saveLabel={ratingModal === 'create' ? 'Add Rating' : 'Save Changes'}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Rating" required hint="e.g. 100kVAR, 630A">
              <input value={ratingForm.rating} onChange={e => setRatingForm(f => ({ ...f, rating: e.target.value }))}
                     placeholder="e.g. 100kVAR" style={s.inp} />
            </Field>
            <Field label="Description">
              <input value={ratingForm.description} onChange={e => setRatingForm(f => ({ ...f, description: e.target.value }))}
                     placeholder="Short description" style={s.inp} />
            </Field>
            <Field label="Status">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={ratingForm.is_active}
                       onChange={e => setRatingForm(f => ({ ...f, is_active: e.target.checked }))}
                       style={{ width: 16, height: 16, cursor: 'pointer' }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: ratingForm.is_active ? 'var(--color-success, #15803d)' : '#6b7280' }}>
                  {ratingForm.is_active ? 'Active' : 'Inactive'}
                </span>
              </label>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
