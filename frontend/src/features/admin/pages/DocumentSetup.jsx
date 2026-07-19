import { useState, useEffect, useRef, useCallback } from 'react';
import { FileText, Plus, Edit2, Trash2, X, Check, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const EMPTY = { doc_type: '', doc_name: '', max_size_mb: 10 };

export default function DocumentSetup() {
  const [rows,       setRows]       = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editRow,    setEditRow]    = useState(null);
  const [form,         setForm]         = useState(EMPTY);
  const [msg,          setMsg]          = useState(null);
  const [pendingRemove, setPendingRemove] = useState(null);
  const isMounted = useRef(true);

  const toast = useCallback((text, type = 'ok') => {
    setMsg({ text, type });
    setTimeout(() => { if (isMounted.current) setMsg(null); }, 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/admin/document-setup');
      if (isMounted.current) setRows(Array.isArray(r.data) ? r.data : []);
    } catch { if (isMounted.current) setRows([]); }
    finally  { if (isMounted.current) setLoading(false); }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    load();
    return () => { isMounted.current = false; };
  }, [load]);

  const create = async () => {
    if (!form.doc_type.trim() || !form.doc_name.trim()) return toast('Doc type and name are required', 'err');
    const mb = parseFloat(form.max_size_mb);
    if (isNaN(mb) || mb <= 0) return toast('Max size must be a positive number', 'err');
    setSaving(true);
    try {
      await api.post('/admin/document-setup', { ...form, max_size_mb: mb });
      toast('Document type created');
      setShowCreate(false);
      setForm(EMPTY);
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
    finally { setSaving(false); }
  };

  const saveEdit = async () => {
    if (!editRow.doc_type.trim() || !editRow.doc_name.trim()) return toast('Doc type and name are required', 'err');
    const mb = parseFloat(editRow.max_size_mb);
    if (isNaN(mb) || mb <= 0) return toast('Max size must be a positive number', 'err');
    setSaving(true);
    try {
      await api.put(`/admin/document-setup/${editRow.id}`, { doc_type: editRow.doc_type, doc_name: editRow.doc_name, max_size_mb: mb });
      toast('Document type updated');
      setEditRow(null);
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!pendingRemove) return;
    const row = pendingRemove;
    setPendingRemove(null);
    try {
      await api.delete(`/admin/document-setup/${row.id}`);
      toast('Document type deactivated');
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
  };

  const inp = { padding: '7px 11px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', background: '#fff' };
  const editInp = { ...inp, border: '1px solid #6ee7b7', minWidth: 100 };

  return (
    <div style={{ padding: 24 }}>
      <ConfirmDialog
        open={!!pendingRemove}
        title="Deactivate Document Type"
        message={pendingRemove ? `Deactivate document type "${pendingRemove.doc_name}"?` : ''}
        confirmLabel="Deactivate"
        variant="warning"
        onConfirm={remove}
        onCancel={() => setPendingRemove(null)}
      />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: '#ecfdf5', color: '#059669', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <FileText size={20} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>Document Setup</h1>
            <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>Define allowed document types and file size limits.</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={{ padding: '8px 14px', background: '#ecfdf5', color: '#059669', border: '1px solid #a7f3d0', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => { setShowCreate(true); setForm(EMPTY); }} style={{ padding: '8px 16px', background: '#059669', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
            <Plus size={14} /> Add Document Type
          </button>
        </div>
      </div>

      {/* Toast */}
      {msg && (
        <div style={{ marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: msg.type === 'ok' ? '#dcfce7' : '#fee2e2', color: msg.type === 'ok' ? '#16a34a' : '#dc2626' }}>
          {msg.text}
        </div>
      )}

      {/* Create panel */}
      {showCreate && (
        <div style={{ marginBottom: 20, padding: 20, border: '1px solid #a7f3d0', borderRadius: 12, background: '#ecfdf5' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0, color: '#065f46', fontSize: 15, fontWeight: 700 }}>New Document Type</h3>
            <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={17} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Doc Type *</span>
              <input value={form.doc_type} onChange={e => setForm(f => ({ ...f, doc_type: e.target.value }))}
                placeholder="e.g. ID_PROOF" style={inp} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Display Name *</span>
              <input value={form.doc_name} onChange={e => setForm(f => ({ ...f, doc_name: e.target.value }))}
                placeholder="e.g. Identity Proof" style={inp} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Max Size (MB)</span>
              <input type="number" min="1" value={form.max_size_mb} onChange={e => setForm(f => ({ ...f, max_size_mb: e.target.value }))}
                style={{ ...inp, width: 90 }} />
            </label>
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowCreate(false)} style={{ padding: '7px 16px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            <button onClick={create} disabled={saving} style={{ padding: '7px 16px', background: '#059669', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: 13, opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Saving…' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>No document types found. Click "Add Document Type" to create one.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['#', 'Doc Type', 'Display Name', 'Max Size (MB)', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const isEditing = editRow?.id === row.id;
                  return (
                    <tr key={row.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 12 }}>{i + 1}</td>
                      <td style={{ padding: '10px 14px' }}>
                        {isEditing
                          ? <input value={editRow.doc_type} onChange={e => setEditRow(r => ({ ...r, doc_type: e.target.value }))} style={editInp} />
                          : <span style={{ fontFamily: 'monospace', background: '#f0fdf4', color: '#065f46', padding: '2px 7px', borderRadius: 5, fontSize: 12 }}>{row.doc_type}</span>}
                      </td>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>
                        {isEditing
                          ? <input value={editRow.doc_name} onChange={e => setEditRow(r => ({ ...r, doc_name: e.target.value }))} style={{ ...editInp, minWidth: 160 }} />
                          : row.doc_name}
                      </td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>
                        {isEditing
                          ? <input type="number" min="1" value={editRow.max_size_mb} onChange={e => setEditRow(r => ({ ...r, max_size_mb: e.target.value }))} style={{ ...editInp, width: 70 }} />
                          : `${row.max_size_mb} MB`}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {isEditing ? (
                            <>
                              <button onClick={saveEdit} disabled={saving} style={{ padding: '5px 10px', background: '#dcfce7', color: '#16a34a', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}>
                                <Check size={12} /> Save
                              </button>
                              <button onClick={() => setEditRow(null)} style={{ padding: '5px 8px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer' }}><X size={12} /></button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => setEditRow({ ...row })} title="Edit" style={{ padding: '5px 8px', background: '#ecfdf5', color: '#059669', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                                <Edit2 size={13} />
                              </button>
                              <button onClick={() => setPendingRemove(row)} title="Deactivate" style={{ padding: '5px 8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                                <Trash2 size={13} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
