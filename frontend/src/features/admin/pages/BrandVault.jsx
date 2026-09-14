import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Sparkles, Plus, Edit2, Trash2, RotateCcw, X, Check, RefreshCw,
  ExternalLink, FileText,
} from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { PageHero, PageShell } from '@/components/pulse-ui';

const EMPTY = { title: '', description: '', file_url: '' };

export default function BrandVault() {
  const [rows,       setRows]       = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editRow,    setEditRow]    = useState(null);
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
      const r = await api.get('/admin/company-documents');
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
    if (!form.title.trim() || !form.file_url.trim()) return toast('Title and link are required', 'err');
    setSaving(true);
    try {
      await api.post('/admin/company-documents', form);
      toast('Brand Vault item added');
      setShowCreate(false);
      setForm(EMPTY);
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
    finally { setSaving(false); }
  };

  const saveEdit = async () => {
    if (!editRow.title.trim() || !editRow.file_url.trim()) return toast('Title and link are required', 'err');
    setSaving(true);
    try {
      await api.put(`/admin/company-documents/${editRow.id}`, {
        title: editRow.title, description: editRow.description, file_url: editRow.file_url,
      });
      toast('Brand Vault item updated');
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
      await api.delete(`/admin/company-documents/${row.id}`);
      toast('Removed from Brand Vault');
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
  };

  const reactivate = async (row) => {
    try {
      await api.put(`/admin/company-documents/${row.id}`, {
        title: row.title, description: row.description, file_url: row.file_url, is_active: true,
      });
      toast('Restored to Brand Vault');
      load();
    } catch (e) { toast(e.response?.data?.error || e.message, 'err'); }
  };

  const inp = { padding: '7px 11px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', background: '#fff' };
  const editInp = { ...inp, border: '1px solid #d8b4fe', minWidth: 100 };

  return (
    <PageShell dock={
      <PageHero
        icon={FileText}
        eyebrow="Administration"
        title="Brand Vault"
        subtitle="Manage the download links shown on the Home dashboard's Brand Vault panel — paste a Google Drive share link (or any direct file URL) for each item."
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="plh-cta" onClick={() => { setShowCreate(true); setForm(EMPTY); }}>
            <Plus size={14} /> Add Item
          </button>
        </>}
      />
    }>
      <ConfirmDialog
        open={!!pendingRemove}
        title="Remove Brand Vault Item"
        message={pendingRemove ? `Remove "${pendingRemove.title}" from the Home Brand Vault panel? It stays here and can be restored later.` : ''}
        confirmLabel="Remove"
        variant="warning"
        onConfirm={remove}
        onCancel={() => setPendingRemove(null)}
      />


      {/* Toast */}
      {msg && (
        <div style={{ marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: msg.type === 'ok' ? '#dcfce7' : '#fee2e2', color: msg.type === 'ok' ? '#16a34a' : '#dc2626' }}>
          {msg.text}
        </div>
      )}

      {/* Create panel */}
      {showCreate && (
        <div style={{ marginBottom: 20, padding: 20, border: '1px solid #f3e8ff', borderRadius: 12, background: '#fdf4ff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0, color: '#7e22ce', fontSize: 15, fontWeight: 700 }}>New Brand Vault Item</h3>
            <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={17} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Title *</span>
              <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Logo Pack" style={inp} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Download Link *</span>
              <input value={form.file_url} onChange={e => setForm(f => ({ ...f, file_url: e.target.value }))}
                placeholder="https://drive.google.com/file/d/… or a direct file URL" style={inp} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: '1 / -1' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Description</span>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Shown as a hover tooltip on the Home tile" style={inp} />
            </label>
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowCreate(false)} style={{ padding: '7px 16px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            <button onClick={create} disabled={saving} style={{ padding: '7px 16px', background: '#a855f7', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: 13, opacity: saving ? 0.7 : 1 }}>
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
          <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>No Brand Vault items yet. Click "Add Item" to create one.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Title', 'Description', 'Download Link', 'Status', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const isEditing = editRow?.id === row.id;
                  return (
                    <tr key={row.id} style={{ borderBottom: '1px solid #f3f4f6', opacity: row.is_active ? 1 : 0.55 }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827', minWidth: 140 }}>
                        {isEditing
                          ? <input value={editRow.title} onChange={e => setEditRow(r => ({ ...r, title: e.target.value }))} style={{ ...editInp, minWidth: 140 }} />
                          : row.title}
                        {row.visible_roles && (
                          <div style={{ fontSize: 11, color: '#a855f7', fontWeight: 600, marginTop: 2 }}>
                            Restricted: {row.visible_roles.join(', ')}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px', color: '#6b7280', minWidth: 160 }}>
                        {isEditing
                          ? <input value={editRow.description || ''} onChange={e => setEditRow(r => ({ ...r, description: e.target.value }))} style={{ ...editInp, minWidth: 160 }} />
                          : (row.description || '—')}
                      </td>
                      <td style={{ padding: '10px 14px', minWidth: 220 }}>
                        {isEditing
                          ? <input value={editRow.file_url} onChange={e => setEditRow(r => ({ ...r, file_url: e.target.value }))} style={{ ...editInp, minWidth: 220 }} />
                          : row.file_url
                            ? <a href={row.file_url} target="_blank" rel="noreferrer" style={{ color: '#a855f7', display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}>
                                {row.file_url.length > 42 ? row.file_url.slice(0, 42) + '…' : row.file_url} <ExternalLink size={11} />
                              </a>
                            : <span style={{ color: '#d1d5db' }}>No link</span>}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{
                          padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                          background: row.is_active ? '#dcfce7' : '#f3f4f6',
                          color: row.is_active ? '#16a34a' : '#9ca3af',
                        }}>
                          {row.is_active ? 'Live' : 'Removed'}
                        </span>
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
                          ) : row.is_active ? (
                            <>
                              <button onClick={() => setEditRow({ ...row })} title="Edit" style={{ padding: '5px 8px', background: '#fdf4ff', color: '#a855f7', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                                <Edit2 size={13} />
                              </button>
                              <button onClick={() => setPendingRemove(row)} title="Remove" style={{ padding: '5px 8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                                <Trash2 size={13} />
                              </button>
                            </>
                          ) : (
                            <button onClick={() => reactivate(row)} title="Restore" style={{ padding: '5px 10px', background: '#dcfce7', color: '#16a34a', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}>
                              <RotateCcw size={12} /> Restore
                            </button>
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
    </PageShell>
  );
}
