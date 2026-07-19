import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, RefreshCw, X, Hash, Eye, Clock, ChevronDown } from 'lucide-react';
import api from '@/services/api/client';

const STATUS_OPTIONS = ['in_stock', 'dispatched', 'in_service', 'returned', 'scrapped'];

const STATUS_STYLE = {
  in_stock:   { bg: '#f0fdf4', color: '#15803d', label: 'In Stock' },
  dispatched: { bg: '#eff6ff', color: '#1d4ed8', label: 'Dispatched' },
  in_service: { bg: '#fef3c7', color: '#92400e', label: 'In Service' },
  returned:   { bg: '#f5f3ff', color: '#6d28d9', label: 'Returned' },
  scrapped:   { bg: '#fef2f2', color: '#dc2626', label: 'Scrapped' },
};

const EVENT_TYPES = [
  'service', 'repair', 'inspection', 'transfer', 'status_change',
  'warranty_claim', 'calibration', 'installation', 'decommission', 'note',
];

export default function SerialTracking() {
  const [serials,    setSerials]    = useState([]);
  const [stats,      setStats]      = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [fStatus,    setFStatus]    = useState('');
  const [drawer,     setDrawer]     = useState(null);   // null | 'add' | serial-obj
  const [detail,     setDetail]     = useState(null);   // serial-obj with events
  const [evDrawer,   setEvDrawer]   = useState(false);
  const [form,       setForm]       = useState(emptyForm());
  const [evForm,     setEvForm]     = useState({ event_type: 'service', description: '' });
  const [items,      setItems]      = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);

  function emptyForm() {
    return {
      serial_number: '', item_id: '', batch_id: '', warehouse_id: '',
      status: 'in_stock', current_location: '',
      manufactured_date: '', warranty_expiry: '', notes: '',
    };
  }

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3200);
  };

  const loadStats = useCallback(async () => {
    try {
      const r = await api.get('/inventory/serials/stats/summary');
      setStats(r.data);
    } catch { /* non-blocking */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (search)  params.search = search;
      if (fStatus) params.status = fStatus;
      const r = await api.get('/inventory/serials', { params });
      setSerials(Array.isArray(r.data) ? r.data : []);
    } catch {
      setSerials([]);
    } finally {
      setLoading(false);
    }
  }, [search, fStatus]);

  const loadItems = async () => {
    try {
      const r = await api.get('/inventory/items');
      setItems(Array.isArray(r.data) ? r.data : (r.data?.items || []));
    } catch { setItems([]); }
  };

  useEffect(() => { load(); loadStats(); }, [load, loadStats]);

  const openAdd = () => { loadItems(); setForm(emptyForm()); setDrawer('add'); };
  const openEdit = (s) => {
    loadItems();
    setForm({
      serial_number:    s.serial_number    ?? '',
      item_id:          String(s.item_id   ?? ''),
      batch_id:         String(s.batch_id  ?? ''),
      warehouse_id:     String(s.warehouse_id ?? ''),
      status:           s.status           ?? 'in_stock',
      current_location: s.current_location ?? '',
      manufactured_date: s.manufactured_date ? s.manufactured_date.split('T')[0] : '',
      warranty_expiry:  s.warranty_expiry  ? s.warranty_expiry.split('T')[0] : '',
      notes:            s.notes            ?? '',
    });
    setDrawer(s);
  };

  const openDetail = async (s) => {
    try {
      const r = await api.get(`/inventory/serials/${s.id}`);
      setDetail(r.data);
    } catch { setDetail(s); }
  };

  const handleSubmit = async () => {
    if (!form.serial_number || !form.item_id) return showToast('Serial number and item are required', 'error');
    setSubmitting(true);
    try {
      const payload = {
        ...form,
        item_id:      form.item_id      ? parseInt(form.item_id) : null,
        batch_id:     form.batch_id     ? parseInt(form.batch_id) : null,
        warehouse_id: form.warehouse_id ? parseInt(form.warehouse_id) : null,
        manufactured_date: form.manufactured_date || null,
        warranty_expiry:   form.warranty_expiry   || null,
      };
      if (drawer === 'add') {
        await api.post('/inventory/serials', payload);
        showToast('Serial number created');
      } else {
        await api.put(`/inventory/serials/${drawer.id}`, payload);
        showToast('Serial number updated');
      }
      setDrawer(null);
      load();
      loadStats();
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to save', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddEvent = async () => {
    if (!evForm.event_type || !detail) return;
    setSubmitting(true);
    try {
      await api.post(`/inventory/serials/${detail.id}/events`, evForm);
      showToast('Event recorded');
      setEvDrawer(false);
      const r = await api.get(`/inventory/serials/${detail.id}`);
      setDetail(r.data);
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const st = (s) => STATUS_STYLE[s] || { bg: '#f3f4f6', color: '#374151', label: s };

  return (
    <div style={{ padding: '24px', fontFamily: 'Inter, sans-serif' }}>

      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          background: toast.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color: toast.type === 'error' ? '#dc2626' : '#15803d',
          border: `1px solid ${toast.type === 'error' ? '#fca5a5' : '#86efac'}`,
          borderRadius: 8, padding: '10px 18px', fontWeight: 500, fontSize: 13,
        }}>{toast.msg}</div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111827' }}>Serial Number Tracking</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>{serials.length} serialised units</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={{ padding: '8px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer' }}>
            <RefreshCw size={14} />
          </button>
          <button onClick={openAdd} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <Plus size={14} /> Add Serial
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
          {[
            { label: 'Total Units', value: stats.total,        color: '#1d4ed8' },
            { label: 'In Stock',    value: stats.in_stock,     color: '#15803d' },
            { label: 'In Service',  value: stats.in_service,   color: '#92400e' },
            { label: 'Warranty Expiring (30d)', value: stats.warranty_expiring_30d, color: '#dc2626' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '14px 18px' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color }}>{value ?? 0}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px', background: '#fff', flex: 1 }}>
          <Search size={14} color="#9ca3af" />
          <input
            placeholder="Search serial number, item name, item code…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ border: 'none', outline: 'none', fontSize: 13, width: '100%', color: '#374151' }}
          />
        </div>
        <select
          value={fStatus}
          onChange={e => setFStatus(e.target.value)}
          style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px', fontSize: 13, background: '#fff', cursor: 'pointer' }}
        >
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{st(s).label}</option>)}
        </select>
        {(search || fStatus) && (
          <button onClick={() => { setSearch(''); setFStatus(''); }}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 12 }}>
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      ) : serials.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <Hash size={40} strokeWidth={1} />
          <p style={{ marginTop: 12 }}>No serial numbers found</p>
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                {['Serial #', 'Item', 'Manufacturer', 'Batch', 'Warehouse / Location', 'Mfg Date', 'Warranty Expiry', 'Status', ''].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {serials.map((s, i) => {
                const style = st(s.status);
                const today = new Date();
                const warrantyDate = s.warranty_expiry ? new Date(s.warranty_expiry) : null;
                const warrantyExpired = warrantyDate && warrantyDate < today;
                return (
                  <tr key={s.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa', cursor: 'pointer' }}
                    onClick={() => openDetail(s)}>
                    <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontWeight: 600, color: '#111827' }}>{s.serial_number}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ fontWeight: 500 }}>{s.item_name}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{s.item_code}</div>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#6b7280' }}>{s.manufacturer || '—'}</td>
                    <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12 }}>{s.batch_number || '—'}</td>
                    <td style={{ padding: '10px 12px', color: '#374151' }}>
                      {s.warehouse_name || s.current_location || '—'}
                    </td>
                    <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>
                      {s.manufactured_date ? new Date(s.manufactured_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: warrantyExpired ? '#dc2626' : '#374151', fontWeight: warrantyExpired ? 600 : 400 }}>
                      {warrantyDate ? warrantyDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                      {warrantyExpired && <span style={{ marginLeft: 4, fontSize: 10, background: '#fef2f2', color: '#dc2626', padding: '1px 4px', borderRadius: 3 }}>EXPIRED</span>}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ background: style.bg, color: style.color, padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 500 }}>{style.label}</span>
                    </td>
                    <td style={{ padding: '10px 12px' }} onClick={e => e.stopPropagation()}>
                      <button onClick={() => openEdit(s)}
                        style={{ padding: '4px 8px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: '#fff', cursor: 'pointer' }}>
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail Panel */}
      {detail && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}
          onClick={() => setDetail(null)}>
          <div style={{ width: 560, background: '#fff', height: '100%', overflow: 'auto', padding: 24 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{detail.serial_number}</h3>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>{detail.item_name} ({detail.item_code})</p>
              </div>
              <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            {/* Info Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
              {[
                { label: 'Status',    value: <span style={{ background: st(detail.status).bg, color: st(detail.status).color, padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>{st(detail.status).label}</span> },
                { label: 'Manufacturer', value: detail.manufacturer || '—' },
                { label: 'Batch',     value: detail.batch_number || '—' },
                { label: 'Warehouse', value: detail.warehouse_name || '—' },
                { label: 'Location',  value: detail.current_location || '—' },
                { label: 'Mfg Date',  value: detail.manufactured_date ? new Date(detail.manufactured_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—' },
                { label: 'Warranty Expiry', value: detail.warranty_expiry ? new Date(detail.warranty_expiry).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—' },
                { label: 'Notes',     value: detail.notes || '—' },
              ].map(({ label, value }) => (
                <div key={label} style={{ background: '#f9fafb', borderRadius: 6, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 13, color: '#111827', fontWeight: 500 }}>{value}</div>
                </div>
              ))}
            </div>

            {/* Events */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Service / Event History</h4>
              <button onClick={() => setEvDrawer(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
                <Plus size={12} /> Add Event
              </button>
            </div>

            {(detail.events || []).length === 0 ? (
              <p style={{ color: '#9ca3af', fontSize: 13 }}>No events recorded yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(detail.events || []).map(ev => (
                  <div key={ev.id} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'capitalize' }}>{ev.event_type.replace(/_/g, ' ')}</span>
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>{new Date(ev.event_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>
                    </div>
                    {ev.description && <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>{ev.description}</p>}
                    {ev.performed_by_name && <p style={{ margin: '4px 0 0', fontSize: 11, color: '#9ca3af' }}>By: {ev.performed_by_name}</p>}
                  </div>
                ))}
              </div>
            )}

            {/* Add Event inline */}
            {evDrawer && (
              <div style={{ marginTop: 16, border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, background: '#f9fafb' }}>
                <h5 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600 }}>Record Event</h5>
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 4 }}>Event Type</label>
                  <select value={evForm.event_type} onChange={e => setEvForm(f => ({ ...f, event_type: e.target.value }))}
                    style={{ width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13 }}>
                    {EVENT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 4 }}>Description</label>
                  <textarea rows={3} value={evForm.description} onChange={e => setEvForm(f => ({ ...f, description: e.target.value }))}
                    style={{ width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
                    placeholder="Notes about this event…" />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setEvDrawer(false)} style={{ flex: 1, padding: '8px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                  <button onClick={handleAddEvent} disabled={submitting} style={{ flex: 1, padding: '8px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    {submitting ? 'Saving…' : 'Save Event'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add / Edit Drawer */}
      {drawer !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}
          onClick={() => setDrawer(null)}>
          <div style={{ width: 480, background: '#fff', height: '100%', overflow: 'auto', padding: 24 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{drawer === 'add' ? 'Add Serial Number' : 'Edit Serial Number'}</h3>
              <button onClick={() => setDrawer(null)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            {[
              { label: 'Serial Number *', key: 'serial_number', type: 'text', placeholder: 'e.g. MT-HVDC-001' },
            ].map(({ label, key, type, placeholder }) => (
              <div key={key} style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 4 }}>{label}</label>
                <input type={type} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            ))}

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 4 }}>Item *</label>
              <select value={form.item_id} onChange={e => setForm(f => ({ ...f, item_id: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13 }}>
                <option value="">Select item…</option>
                {items.map(it => <option key={it.id} value={it.id}>{it.item_code} — {it.item_name}</option>)}
              </select>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 4 }}>Status</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13 }}>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{st(s).label}</option>)}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 4 }}>Manufactured Date</label>
                <input type="date" value={form.manufactured_date} onChange={e => setForm(f => ({ ...f, manufactured_date: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 4 }}>Warranty Expiry</label>
                <input type="date" value={form.warranty_expiry} onChange={e => setForm(f => ({ ...f, warranty_expiry: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 4 }}>Current Location</label>
              <input type="text" value={form.current_location} onChange={e => setForm(f => ({ ...f, current_location: e.target.value }))}
                placeholder="e.g. Bin R1-S2-L1 or Site: Rajasthan Plant"
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
              <textarea rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button onClick={() => setDrawer(null)}
                style={{ flex: 1, padding: '10px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleSubmit} disabled={submitting}
                style={{ flex: 1, padding: '10px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                {submitting ? 'Saving…' : drawer === 'add' ? 'Create Serial' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
