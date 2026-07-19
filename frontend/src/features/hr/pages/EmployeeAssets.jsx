// frontend/src/features/hr/pages/EmployeeAssets.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const P = '#6B3FDB';

const STATUS_STYLE = {
  allocated: { bg: '#dbeafe', color: '#1e40af' },
  returned:  { bg: '#d1fae5', color: '#065f46' },
  lost:      { bg: '#fee2e2', color: '#991b1b' },
  damaged:   { bg: '#fef3c7', color: '#92400e' },
};
function Badge({ status }) {
  const s = STATUS_STYLE[status?.toLowerCase()] || { bg: '#f3f4f6', color: '#6b7280' };
  return <span style={{ background: s.bg, color: s.color, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, textTransform: 'capitalize' }}>{status || '—'}</span>;
}

const ASSET_TYPES = ['Laptop', 'Desktop', 'Mobile', 'Tablet', 'Monitor', 'Keyboard', 'Mouse', 'Headset', 'Vehicle', 'Tools', 'Other'];
const EMPTY_FORM  = { employee_id: '', asset_type: 'Laptop', asset_name: '', asset_tag: '', serial_number: '', brand: '', model: '', allocated_date: new Date().toISOString().split('T')[0], condition_in: 'good', notes: '' };

export default function EmployeeAssets() {
  const [assets,      setAssets]      = useState([]);
  const [employees,   setEmployees]   = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [msg,         setMsg]         = useState({ text: '', type: '' });
  const [showForm,    setShowForm]    = useState(false);
  const [form,        setForm]        = useState(EMPTY_FORM);
  const [saving,      setSaving]      = useState(false);
  const [filterEmp,   setFilterEmp]   = useState('');
  const [filterStatus,setFilterStatus]= useState('');
  const [filterType,  setFilterType]  = useState('');
  const [returnModal, setReturnModal] = useState(null);
  const [returnForm,  setReturnForm]  = useState({ return_date: new Date().toISOString().split('T')[0], condition_out: 'good', notes: '' });
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);
  const abortRef = useRef(null);

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 4000);
  };

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError('');
    try {
      const [aRes, eRes] = await Promise.all([
        api.get('/employee-assets', { signal: ctrl.signal }),
        api.get('/employees?status=active,probation', { signal: ctrl.signal }),
      ]);
      setAssets(aRes.data || []);
      setEmployees(eRes.data?.employees || eRes.data?.data || eRes.data || []);
    } catch (e) {
      if (e.name !== 'AbortError') setError('Failed to load asset data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  // Filtered view
  const filtered = assets.filter(a => {
    if (filterEmp    && !String(a.employee_id).includes(filterEmp) && !a.employee_name?.toLowerCase().includes(filterEmp.toLowerCase())) return false;
    if (filterStatus && a.status?.toLowerCase() !== filterStatus.toLowerCase()) return false;
    if (filterType   && a.asset_type?.toLowerCase() !== filterType.toLowerCase()) return false;
    return true;
  });

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.employee_id) return flash('Select an employee', 'error');
    if (!form.asset_name)  return flash('Asset name is required', 'error');
    setSaving(true);
    try {
      await api.post('/employee-assets', form);
      flash('Asset allocated successfully');
      setShowForm(false);
      setForm(EMPTY_FORM);
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to allocate asset', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleReturn(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/employee-assets/${returnModal.id}/return`, returnForm);
      flash('Asset returned successfully');
      setReturnModal(null);
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to process return', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/employee-assets/${id}`);
      flash('Deleted');
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Delete failed', 'error');
    }
  }

  // Summary counts
  const totalAllocated = assets.filter(a => a.status === 'allocated').length;
  const totalReturned  = assets.filter(a => a.status === 'returned').length;
  const totalLost      = assets.filter(a => a.status === 'lost').length;

  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box' };

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Asset Record"
        message="Delete this asset record?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      {/* Toast */}
      {msg.text && (
        <div style={{ position: 'fixed', top: 20, right: 24, background: msg.type === 'error' ? '#fee2e2' : '#d1fae5', color: msg.type === 'error' ? '#991b1b' : '#065f46', padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 9999, boxShadow: '0 4px 12px rgba(0,0,0,.15)' }}>{msg.text}</div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>Employee Assets</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>IT assets, tools and equipment allocated to employees</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={load} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>↻ Refresh</button>
          <button onClick={() => { setShowForm(true); setForm(EMPTY_FORM); }} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>+ Allocate Asset</button>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Assets', value: assets.length, accent: P },
          { label: 'Currently Allocated', value: totalAllocated, accent: '#2563eb' },
          { label: 'Returned', value: totalReturned, accent: '#059669' },
          { label: 'Lost / Damaged', value: totalLost, accent: '#dc2626' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 20px', minWidth: 140 }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: k.accent }}>{k.value}</div>
          </div>
        ))}
      </div>

      {error && <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 16px', color: '#991b1b', fontSize: 13, marginBottom: 16 }}>{error}</div>}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input placeholder="Search employee…" value={filterEmp} onChange={e => setFilterEmp(e.target.value)}
          style={{ ...inp, width: 200 }} />
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...inp, width: 140 }}>
          <option value="">All Statuses</option>
          <option value="allocated">Allocated</option>
          <option value="returned">Returned</option>
          <option value="lost">Lost</option>
          <option value="damaged">Damaged</option>
        </select>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ ...inp, width: 160 }}>
          <option value="">All Asset Types</option>
          {ASSET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {(filterEmp || filterStatus || filterType) && (
          <button onClick={() => { setFilterEmp(''); setFilterStatus(''); setFilterType(''); }}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#6b7280' }}>Clear</button>
        )}
      </div>

      {/* Table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        {loading
          ? <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Loading assets…</div>
          : !filtered.length
            ? <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No asset records found</div>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['Employee', 'Asset Name', 'Type', 'Tag / Serial', 'Brand / Model', 'Allocated', 'Condition', 'Status', 'Actions'].map(h => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: 'left', color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(a => (
                      <tr key={a.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '10px 14px', fontWeight: 600, color: '#374151' }}>{a.employee_name || `EMP-${a.employee_id}`}</td>
                        <td style={{ padding: '10px 14px', color: '#374151' }}>{a.asset_name}</td>
                        <td style={{ padding: '10px 14px', color: '#6b7280' }}>{a.asset_type}</td>
                        <td style={{ padding: '10px 14px', color: '#6b7280', fontFamily: 'monospace', fontSize: 12 }}>
                          {a.asset_tag && <div>{a.asset_tag}</div>}
                          {a.serial_number && <div style={{ color: '#9ca3af' }}>{a.serial_number}</div>}
                        </td>
                        <td style={{ padding: '10px 14px', color: '#6b7280' }}>
                          {a.brand && <div>{a.brand}</div>}
                          {a.model && <div style={{ color: '#9ca3af', fontSize: 11 }}>{a.model}</div>}
                        </td>
                        <td style={{ padding: '10px 14px', color: '#374151', whiteSpace: 'nowrap' }}>
                          {a.allocated_date ? new Date(a.allocated_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                          {a.return_date && <div style={{ fontSize: 11, color: '#6b7280' }}>Returned: {new Date(a.return_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</div>}
                        </td>
                        <td style={{ padding: '10px 14px', color: '#6b7280' }}>
                          {a.condition_in && <span>In: {a.condition_in}</span>}
                          {a.condition_out && <span style={{ marginLeft: 6 }}>Out: {a.condition_out}</span>}
                        </td>
                        <td style={{ padding: '10px 14px' }}><Badge status={a.status} /></td>
                        <td style={{ padding: '10px 14px' }}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {a.status === 'allocated' && (
                              <button onClick={() => setReturnModal(a)}
                                style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #059669', background: 'transparent', color: '#059669', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Return</button>
                            )}
                            <button onClick={() => setPendingHandleDelete(a.id)}
                              style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #fca5a5', background: 'transparent', color: '#dc2626', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      </div>

      {/* Allocate Asset Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>Allocate Asset</h2>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' }}>×</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Employee *</label>
                  <select value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))} style={inp} required>
                    <option value="">— Select employee —</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name || ''} ({e.office_id || e.id})</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Asset Type *</label>
                  <select value={form.asset_type} onChange={e => setForm(f => ({ ...f, asset_type: e.target.value }))} style={inp}>
                    {ASSET_TYPES.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Asset Name *</label>
                  <input value={form.asset_name} onChange={e => setForm(f => ({ ...f, asset_name: e.target.value }))} style={inp} placeholder="e.g. Dell Laptop" required />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Asset Tag</label>
                  <input value={form.asset_tag} onChange={e => setForm(f => ({ ...f, asset_tag: e.target.value }))} style={inp} placeholder="e.g. IT-0042" />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Serial Number</label>
                  <input value={form.serial_number} onChange={e => setForm(f => ({ ...f, serial_number: e.target.value }))} style={inp} placeholder="SN-XXXXXX" />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Brand</label>
                  <input value={form.brand} onChange={e => setForm(f => ({ ...f, brand: e.target.value }))} style={inp} placeholder="Dell, Apple…" />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Model</label>
                  <input value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} style={inp} placeholder="XPS 15, MacBook Pro…" />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Allocated Date</label>
                  <input type="date" value={form.allocated_date} onChange={e => setForm(f => ({ ...f, allocated_date: e.target.value }))} style={inp} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Condition (In)</label>
                  <select value={form.condition_in} onChange={e => setForm(f => ({ ...f, condition_in: e.target.value }))} style={inp}>
                    {['new', 'good', 'fair', 'poor'].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
                  <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 64, resize: 'vertical' }} placeholder="Any special instructions or remarks…" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setShowForm(false)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
                <button type="submit" disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
                  {saving ? 'Saving…' : 'Allocate Asset'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Return Modal */}
      {returnModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Process Return</h2>
              <button onClick={() => setReturnModal(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' }}>×</button>
            </div>
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
              <strong>{returnModal.asset_name}</strong> — {returnModal.employee_name}
            </div>
            <form onSubmit={handleReturn}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Return Date</label>
                  <input type="date" value={returnForm.return_date} onChange={e => setReturnForm(f => ({ ...f, return_date: e.target.value }))} style={inp} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Condition on Return</label>
                  <select value={returnForm.condition_out} onChange={e => setReturnForm(f => ({ ...f, condition_out: e.target.value }))} style={inp}>
                    {['new', 'good', 'fair', 'poor', 'damaged', 'lost'].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
                  <textarea value={returnForm.notes} onChange={e => setReturnForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 56, resize: 'vertical' }} placeholder="Condition remarks, damage notes…" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setReturnModal(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
                <button type="submit" disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
                  {saving ? 'Processing…' : 'Confirm Return'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
