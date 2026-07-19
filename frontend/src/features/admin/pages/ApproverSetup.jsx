import { useState, useEffect, useRef, useCallback } from 'react';
import { UserCheck, Plus, Edit2, Trash2, X, Check, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const MODULES = [
  'leave', 'project_creation', 'expense', 'purchase_order',
  'travel', 'recruitment', 'asset', 'payroll', 'general',
];
const ROLES = ['manager', 'hr', 'finance', 'admin', 'super_admin', 'ceo', 'cfo'];
const EMPTY   = { module: '', approver_role: '', approver_email: '', sequence: 1 };

export default function ApproverSetup({ setPage }) {
  const [rows,          setRows]          = useState([]);
  const [loading,       setLoading]       = useState(false);
  const [saving,        setSaving]        = useState(false);
  const [showCreate,    setShowCreate]    = useState(false);
  const [editRow,       setEditRow]       = useState(null);
  const [form,          setForm]          = useState(EMPTY);
  const [msg,           setMsg]           = useState(null);
  const [pendingRemove, setPendingRemove] = useState(null);
  const isMounted = useRef(true);

  const toast = useCallback((text, type = 'ok') => {
    setMsg({ text, type });
    setTimeout(() => { if (isMounted.current) setMsg(null); }, 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/admin/approver-setup');
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
    if (!form.module.trim() || !form.approver_role.trim()) return toast('Module and approver role are required', 'err');
    const seq = parseInt(form.sequence);
    if (isNaN(seq) || seq < 1) return toast('Sequence must be a positive integer', 'err');
    setSaving(true);
    try {
      await api.post('/admin/approver-setup', { ...form, sequence: seq });
      toast('Approver config created');
      setShowCreate(false);
      setForm(EMPTY);
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
    finally { setSaving(false); }
  };

  const saveEdit = async () => {
    if (!editRow.module.trim() || !editRow.approver_role.trim()) return toast('Module and approver role are required', 'err');
    setSaving(true);
    try {
      await api.put(`/admin/approver-setup/${editRow.id}`, {
        module: editRow.module, approver_role: editRow.approver_role,
        approver_email: editRow.approver_email, sequence: parseInt(editRow.sequence) || 1,
      });
      toast('Approver config updated');
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
      await api.delete(`/admin/approver-setup/${row.id}`);
      toast('Approver config removed');
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
  };

  const inp = { padding: '7px 11px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', background: '#fff' };
  const editInp = { ...inp, border: '1px solid #c4b5fd', minWidth: 100 };
  const sel = { ...inp, cursor: 'pointer' };

  // Group by module
  const modules = [...new Set(rows.map(r => r?.module).filter(Boolean))].sort();

  const seqBadge = (n) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: '#ede9fe', color: '#6B3FDB', fontWeight: 700, fontSize: 11 }}>{n}</span>
  );

  return (
    <div style={{ padding: 24 }}>
      <ConfirmDialog
        open={!!pendingRemove}
        title="Remove Approver"
        message={pendingRemove ? `Remove approver "${pendingRemove.approver_role}" for ${pendingRemove.module}?` : ''}
        confirmLabel="Remove"
        variant="warning"
        onConfirm={remove}
        onCancel={() => setPendingRemove(null)}
      />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: '#ede9fe', color: '#6B3FDB', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <UserCheck size={20} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>Approver Setup</h1>
            <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>Configure approval chains per module and sequence.</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {setPage && (
            <button onClick={() => setPage('WorkflowConfiguration')} style={{ padding: '8px 14px', background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #ddd6fe', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
              Workflow Rules →
            </button>
          )}
          <button onClick={load} style={{ padding: '8px 14px', background: '#ede9fe', color: '#6B3FDB', border: '1px solid #ddd6fe', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => { setShowCreate(true); setForm(EMPTY); }} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
            <Plus size={14} /> Add Approver
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
        <div style={{ marginBottom: 20, padding: 20, border: '1px solid #ddd6fe', borderRadius: 12, background: '#faf5ff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0, color: '#4c1d95', fontSize: 15, fontWeight: 700 }}>New Approver Config</h3>
            <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={17} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr auto', gap: 12, alignItems: 'end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Module *</span>
              <select value={form.module} onChange={e => setForm(f => ({ ...f, module: e.target.value }))} style={sel}>
                <option value="">— select —</option>
                {MODULES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Approver Role *</span>
              <select value={form.approver_role} onChange={e => setForm(f => ({ ...f, approver_role: e.target.value }))} style={sel}>
                <option value="">— select —</option>
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Approver Email (optional)</span>
              <input value={form.approver_email} onChange={e => setForm(f => ({ ...f, approver_email: e.target.value }))}
                placeholder="specific@company.com" style={inp} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Seq</span>
              <input type="number" min="1" value={form.sequence} onChange={e => setForm(f => ({ ...f, sequence: e.target.value }))}
                style={{ ...inp, width: 60 }} />
            </label>
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowCreate(false)} style={{ padding: '7px 16px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            <button onClick={create} disabled={saving} style={{ padding: '7px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: 13, opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Saving…' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Module grouping info */}
      {!loading && modules.length > 0 && (
        <div style={{ marginBottom: 12, fontSize: 12, color: '#6b7280' }}>
          {rows.length} approver rule{rows.length !== 1 ? 's' : ''} across {modules.length} module{modules.length !== 1 ? 's' : ''}: {modules.join(', ')}
        </div>
      )}

      {/* Table */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>No approver rules found. Click "Add Approver" to create one.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Seq', 'Module', 'Approver Role', 'Approver Email', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const isEditing = editRow?.id === row?.id;
                  return (
                    <tr key={row?.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '10px 14px' }}>
                        {isEditing
                          ? <input type="number" min="1" value={editRow.sequence} onChange={e => setEditRow(r => ({ ...r, sequence: e.target.value }))} style={{ ...editInp, width: 55 }} />
                          : seqBadge(row?.sequence ?? 1)}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        {isEditing ? (
                          <select value={editRow.module} onChange={e => setEditRow(r => ({ ...r, module: e.target.value }))} style={{ ...editInp, cursor: 'pointer' }}>
                            {MODULES.map(m => <option key={m} value={m}>{m}</option>)}
                          </select>
                        ) : (
                          <span style={{ background: '#ede9fe', color: '#5b21b6', padding: '2px 9px', borderRadius: 10, fontSize: 12, fontWeight: 600 }}>
                            {row?.module ?? 'Unknown'}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>
                        {isEditing ? (
                          <select value={editRow.approver_role} onChange={e => setEditRow(r => ({ ...r, approver_role: e.target.value }))} style={{ ...editInp, cursor: 'pointer' }}>
                            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                        ) : (row?.approver_role ?? 'manager')}
                      </td>
                      <td style={{ padding: '10px 14px', color: '#6b7280', fontSize: 12 }}>
                        {isEditing
                          ? <input value={editRow.approver_email} onChange={e => setEditRow(r => ({ ...r, approver_email: e.target.value }))} style={{ ...editInp, minWidth: 180 }} placeholder="optional" />
                          : (row?.approver_email || '—')}
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
                              <button onClick={() => setEditRow({ ...row })} title="Edit" style={{ padding: '5px 8px', background: '#f5f3ff', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                                <Edit2 size={13} />
                              </button>
                              <button onClick={() => setPendingRemove(row)} title="Remove" style={{ padding: '5px 8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
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
