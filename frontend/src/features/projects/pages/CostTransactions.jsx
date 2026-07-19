import { useEffect, useState, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const P = '#6B3FDB';
const LIGHT = '#f5f3ff';
const BORDER = '#e9e4ff';

const cr = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

const COST_TYPES = [
  'SALES_TRAVEL','APPLICATION_ENGINEERING','ENGINEERING','PROCUREMENT',
  'MATERIAL','INVENTORY','PRODUCTION','LABOUR','QUALITY','FAT',
  'TRANSPORT','INSTALLATION','COMMISSIONING','SERVICE','AMC','OTHER',
];

const TYPE_COLORS = {
  SALES_TRAVEL:'#d97706', APPLICATION_ENGINEERING:'#b45309', ENGINEERING:'#2563eb',
  PROCUREMENT:'#0d9488', MATERIAL:'#6B3FDB', INVENTORY:'#047857', PRODUCTION:'#0891b2',
  LABOUR:'#1d4ed8', QUALITY:'#6d28d9', FAT:'#4f46e5', TRANSPORT:'#0369a1',
  INSTALLATION:'#dc2626', COMMISSIONING:'#7c2d12', SERVICE:'#9f1239', AMC:'#065f46', OTHER:'#6b7280',
};

const EMPTY = {
  cost_type: '', amount: '', transaction_date: new Date().toISOString().slice(0, 10),
  description: '', po_number: '', project_id: '', customer_id: '', customer_name: '',
  cost_center_id: '', site_name: '', remarks: '',
};

function Badge({ label, color }) {
  return (
    <span style={{ background: `${color}18`, color, borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {label?.replace(/_/g, ' ')}
    </span>
  );
}

export default function CostTransactions({ setPage }) {
  const toast = useToast();
  const [rows, setRows]               = useState([]);
  const [total, setTotal]             = useState(0);
  const [loading, setLoading]         = useState(true);
  const [showForm, setShowForm]       = useState(false);
  const [form, setForm]               = useState(EMPTY);
  const [saving, setSaving]           = useState(false);
  const [editId, setEditId]           = useState(null);
  const [projects, setProjects]       = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  const [unallocated, setUnallocated] = useState(null);
  const [filters, setFilters]         = useState({ cost_type: '', project_id: '', from_date: '', to_date: '', unallocated: '' });
  const [page, setPageNum]            = useState(0);
  const [capturing, setCapturing]     = useState(false);
  const [captureMsg, setCaptureMsg]   = useState('');
  const [search, setSearch]           = useState('');
  const formRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: 200, offset: page * 200 };
      if (filters.cost_type)   params.cost_type   = filters.cost_type;
      if (filters.project_id)  params.project_id  = filters.project_id;
      if (filters.from_date)   params.from_date   = filters.from_date;
      if (filters.to_date)     params.to_date     = filters.to_date;
      if (filters.unallocated) params.unallocated = filters.unallocated;

      const res = await api.get('/project-cost-engine/transactions', { params });
      setRows(res.data.rows || res.data);
      setTotal(res.data.total || (res.data.rows || res.data).length);
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to load transactions'); setRows([]); }
    finally { setLoading(false); }
  }, [filters, page]);

  const loadRefs = useCallback(async () => {
    try {
      const [pr, cc] = await Promise.allSettled([
        api.get('/project-cost-engine/reference/projects'),
        api.get('/project-cost-engine/cost-centers'),
      ]);
      if (pr.status === 'fulfilled') setProjects(pr.value.data);
      if (cc.status === 'fulfilled') setCostCenters(cc.value.data);
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to load filter options'); }
  }, []);

  const loadUnallocated = useCallback(async () => {
    try {
      const res = await api.get('/project-cost-engine/unallocated');
      setUnallocated(res.data);
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to load unallocated costs'); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadRefs(); loadUnallocated(); }, [loadRefs, loadUnallocated]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.cost_type || !form.amount || parseFloat(form.amount) <= 0) return;
    setSaving(true);
    try {
      if (editId) {
        await api.put(`/project-cost-engine/transactions/${editId}`, form);
      } else {
        await api.post('/project-cost-engine/transactions', form);
      }
      setShowForm(false);
      setForm(EMPTY);
      setEditId(null);
      load();
      loadUnallocated();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleEdit = (row) => {
    setForm({
      cost_type: row.cost_type, amount: row.amount,
      transaction_date: row.transaction_date?.slice(0, 10) || EMPTY.transaction_date,
      description: row.description || '', po_number: row.po_number || '',
      project_id: row.project_id || '', customer_id: row.customer_id || '',
      customer_name: row.customer_name || '', cost_center_id: row.cost_center_id || '',
      site_name: row.site_name || '', remarks: row.remarks || '',
    });
    setEditId(row.id);
    setShowForm(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this cost transaction?')) return;
    try {
      await api.delete(`/project-cost-engine/transactions/${id}`);
      load();
      loadUnallocated();
    } catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const handleCapture = async () => {
    setCapturing(true);
    setCaptureMsg('');
    try {
      const res = await api.post('/project-cost-engine/capture-module-costs', { modules: ['all'] });
      setCaptureMsg(`✓ Captured ${res.data.captured_count} new cost entries from all modules.`);
      load();
      loadUnallocated();
    } catch (err) {
      setCaptureMsg(`✗ ${err.response?.data?.error || 'Capture failed'}`);
    } finally { setCapturing(false); }
  };

  const visibleRows = rows.filter(r =>
    !search ||
    r.cost_type?.toLowerCase().includes(search.toLowerCase()) ||
    r.description?.toLowerCase().includes(search.toLowerCase()) ||
    r.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
    r.po_number?.toLowerCase().includes(search.toLowerCase())
  );

  const totalAmount = visibleRows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const unallocatedCount = unallocated?.count || 0;

  return (
    <div style={{ padding: 24, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111' }}>Cost Transactions</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Unified cost ledger across all modules — {total} entries · {cr(totalAmount)} total
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={handleCapture} disabled={capturing}
            style={{ padding: '8px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 8, color: '#374151', fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
            {capturing ? 'Capturing…' : '⬇ Capture Module Costs'}
          </button>
          <button onClick={() => setPage?.('ProjectProfitabilityDashboard')}
            style={{ padding: '8px 14px', background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 8, color: P, fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
            ← Dashboard
          </button>
          <button onClick={() => { setForm(EMPTY); setEditId(null); setShowForm(true); }}
            style={{ padding: '8px 16px', background: P, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>
            + Add Cost
          </button>
        </div>
      </div>

      {captureMsg && (
        <div style={{ marginBottom: 16, padding: '10px 14px', background: captureMsg.startsWith('✓') ? '#f0fdf4' : '#fef2f2', border: `1px solid ${captureMsg.startsWith('✓') ? '#86efac' : '#fca5a5'}`, borderRadius: 8, color: captureMsg.startsWith('✓') ? '#059669' : '#dc2626', fontSize: 13 }}>
          {captureMsg}
        </div>
      )}

      {/* Unallocated Alert */}
      {unallocatedCount > 0 && (
        <div style={{ marginBottom: 16, padding: '10px 14px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, color: '#92400e', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>⚠️ <strong>{unallocatedCount} UNALLOCATED COSTS</strong> — {cr(unallocated?.total_unallocated)} not linked to a project, customer, PO, or cost centre.</span>
          <button onClick={() => setFilters(f => ({ ...f, unallocated: f.unallocated === 'true' ? '' : 'true' }))}
            style={{ padding: '4px 10px', background: '#92400e', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
            {filters.unallocated === 'true' ? 'Show All' : 'Show Unallocated'}
          </button>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <select value={filters.cost_type} onChange={e => setFilters(f => ({ ...f, cost_type: e.target.value }))}
          style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, background: '#fff', minWidth: 160 }}>
          <option value="">All Cost Types</option>
          {COST_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
        <select value={filters.project_id} onChange={e => setFilters(f => ({ ...f, project_id: e.target.value }))}
          style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, background: '#fff', minWidth: 180 }}>
          <option value="">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.project_code} — {p.project_name}</option>)}
        </select>
        <input type="date" value={filters.from_date} onChange={e => setFilters(f => ({ ...f, from_date: e.target.value }))}
          style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13 }} />
        <input type="date" value={filters.to_date} onChange={e => setFilters(f => ({ ...f, to_date: e.target.value }))}
          style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13 }} />
        <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, minWidth: 180 }} />
        <button onClick={() => { setFilters({ cost_type:'', project_id:'', from_date:'', to_date:'', unallocated:'' }); setSearch(''); }}
          style={{ padding: '7px 12px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 12, cursor: 'pointer' }}>
          Clear
        </button>
      </div>

      {/* Add/Edit Form */}
      {showForm && (
        <div ref={formRef} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{editId ? 'Edit Cost Transaction' : 'Add Cost Transaction'}</div>
            <button onClick={() => { setShowForm(false); setForm(EMPTY); setEditId(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#6b7280' }}>✕</button>
          </div>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>Cost Type *</label>
                <select value={form.cost_type} onChange={e => setForm(f => ({ ...f, cost_type: e.target.value }))} required
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13 }}>
                  <option value="">Select type…</option>
                  {COST_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>Amount (₹) *</label>
                <input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>Date *</label>
                <input type="date" value={form.transaction_date} onChange={e => setForm(f => ({ ...f, transaction_date: e.target.value }))} required
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>Project</label>
                <select value={form.project_id} onChange={e => {
                  const proj = projects.find(p => String(p.id) === e.target.value);
                  setForm(f => ({ ...f, project_id: e.target.value, customer_name: proj?.customer_name || f.customer_name }));
                }}
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13 }}>
                  <option value="">Select project…</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.project_code} — {p.project_name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>Customer Name</label>
                <input value={form.customer_name} onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>PO Number</label>
                <input value={form.po_number} onChange={e => setForm(f => ({ ...f, po_number: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>Cost Centre</label>
                <select value={form.cost_center_id} onChange={e => setForm(f => ({ ...f, cost_center_id: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13 }}>
                  <option value="">Select cost centre…</option>
                  {costCenters.map(cc => <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>Site Name</label>
                <input value={form.site_name} onChange={e => setForm(f => ({ ...f, site_name: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>Description</label>
                <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>Remarks</label>
                <input value={form.remarks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            </div>
            {/* Allocation check preview */}
            {(form.cost_type || form.amount) && (
              <div style={{ marginTop: 12, padding: '8px 12px', background: (!form.project_id || !form.customer_name || !form.po_number || !form.cost_center_id) ? '#fef3c7' : '#f0fdf4', borderRadius: 8, fontSize: 12 }}>
                {(!form.project_id || !form.customer_name || !form.po_number || !form.cost_center_id)
                  ? `⚠ UNALLOCATED: Missing — ${[!form.project_id && 'Project', !form.customer_name && 'Customer', !form.po_number && 'PO Number', !form.cost_center_id && 'Cost Centre'].filter(Boolean).join(', ')}`
                  : '✓ Fully allocated — Project, Customer, PO & Cost Centre linked'}
              </div>
            )}
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button type="submit" disabled={saving}
                style={{ padding: '9px 20px', background: P, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>
                {saving ? 'Saving…' : editId ? 'Update' : 'Add Transaction'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setForm(EMPTY); setEditId(null); }}
                style={{ padding: '9px 16px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Table */}
      <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#fafafa', borderBottom: `1px solid ${BORDER}` }}>
                  {['Date','Cost Type','Description','Customer','Project','PO','Cost Centre','Amount','Status',''].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: h === 'Amount' ? 'right' : 'left', color: '#374151', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r, i) => (
                  <tr key={r.id} style={{
                    background: r.is_unallocated ? '#fffbeb' : (i % 2 === 0 ? '#fff' : '#fafafa'),
                    borderBottom: '1px solid #f3f4f6',
                  }}>
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: '#374151' }}>
                      {r.transaction_date?.slice(0, 10)}
                    </td>
                    <td style={{ padding: '9px 12px' }}>
                      <Badge label={r.cost_type} color={TYPE_COLORS[r.cost_type] || '#6b7280'} />
                    </td>
                    <td style={{ padding: '9px 12px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#374151' }}>
                      {r.description || '—'}
                    </td>
                    <td style={{ padding: '9px 12px', color: '#374151' }}>{r.customer_name || '—'}</td>
                    <td style={{ padding: '9px 12px', color: P, fontWeight: 500 }}>{r.project_code_name || r.project_name || (r.project_id ? `#${r.project_id}` : '—')}</td>
                    <td style={{ padding: '9px 12px', color: '#374151' }}>{r.po_number || '—'}</td>
                    <td style={{ padding: '9px 12px', color: '#374151' }}>{r.cost_center_name || r.cost_center_code || '—'}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 600 }}>{cr(r.amount)}</td>
                    <td style={{ padding: '9px 12px' }}>
                      {r.is_unallocated ? (
                        <span title={r.unallocated_reason} style={{ background: '#fef3c7', color: '#92400e', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 600, cursor: 'help' }}>
                          UNALLOCATED
                        </span>
                      ) : (
                        <span style={{ background: '#f0fdf4', color: '#059669', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                          Allocated
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                      <button onClick={() => handleEdit(r)} style={{ marginRight: 6, padding: '3px 8px', background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 6, color: P, cursor: 'pointer', fontSize: 12 }}>Edit</button>
                      <button onClick={() => handleDelete(r.id)} style={{ padding: '3px 8px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, color: '#dc2626', cursor: 'pointer', fontSize: 12 }}>Del</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {visibleRows.length > 0 && (
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${BORDER}`, background: '#fafafa' }}>
                    <td colSpan={7} style={{ padding: '10px 12px', fontWeight: 600, fontSize: 13 }}>Total ({visibleRows.length} entries)</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: P, fontSize: 14 }}>{cr(totalAmount)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          )}
          {!loading && !visibleRows.length && (
            <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              No cost transactions found.{' '}
              {!showForm && <span>Click <strong>+ Add Cost</strong> or <strong>⬇ Capture Module Costs</strong> to begin.</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
