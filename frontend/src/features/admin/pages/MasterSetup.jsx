import { useState, useEffect, useCallback } from 'react';
import { Plus, Edit2, Trash2, Check, X, Users, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import './MasterSetup.css';

const S = {
  input: {
    padding: '7px 11px', border: '1px solid #e5e7eb', borderRadius: 7,
    fontSize: 13, outline: 'none', fontFamily: 'inherit',
  },
  smInput: {
    padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 7,
    fontSize: 13, outline: 'none', fontFamily: 'inherit', width: 70,
    textAlign: 'center',
  },
  btn: (bg, color = '#fff') => ({
    padding: '7px 16px', background: bg, color, border: 'none',
    borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  }),
};

function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);
  return [toast, show];
}

// Generic list tab used for Departments, Zones, Designations, Grades, Bands
function SimpleListTab({ endpoint, label }) {
  const [items,         setItems]        = useState([]);
  const [newName,       setNewName]      = useState('');
  const [editId,        setEditId]       = useState(null);
  const [editVal,       setEditVal]      = useState('');
  const [loading,       setLoading]      = useState(false);
  const [loadErr,       setLoadErr]      = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [toast,         showToast]       = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(false);
    try {
      const res = await api.get(endpoint);
      const list = Array.isArray(res.data) ? res.data : (res.data?.data || []);
      setItems(list);
    } catch (err) {
      setItems([]);
      setLoadErr(true);
      showToast(err?.message || `Failed to load ${label.toLowerCase()}s`, 'error');
    } finally {
      setLoading(false);
    }
  }, [endpoint, label, showToast]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) { showToast(`Enter a ${label.toLowerCase()} name first`, 'error'); return; }
    try {
      const res = await api.post(endpoint, { name });
      const created = res.data?.id ? res.data : { id: Date.now(), name };
      setItems(prev => [...prev, created]);
      setNewName('');
      showToast(`${label} added`);
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || `Failed to add ${label.toLowerCase()}`, 'error');
    }
  };

  const handleSave = async (id) => {
    const name = editVal.trim();
    if (!name) { showToast('Name cannot be empty', 'error'); return; }
    try {
      await api.put(`${endpoint}/${id}`, { name });
      setItems(prev => prev.map(i => i.id === id ? { ...i, name } : i));
      setEditId(null);
      showToast('Updated');
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Failed to update', 'error');
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete;
    setPendingDelete(null);
    try {
      await api.delete(`${endpoint}/${id}`);
      setItems(prev => prev.filter(i => i.id !== id));
      showToast('Deleted');
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Failed to delete', 'error');
    }
  };

  return (
    <>
      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete ${label}`}
        message={`Delete this ${label.toLowerCase()}? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
      {toast && <div className={`ms-toast ms-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="ms-card">
        <div className="ms-add-row">
          <input
            className="ms-input"
            placeholder={`New ${label.toLowerCase()} name…`}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <button className="ms-btn-add" onClick={handleAdd}>
            <Plus size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />Add
          </button>
          <button onClick={load} style={{ ...S.btn('#f3f4f6', '#6b7280'), padding: '8px 10px' }} title="Refresh">
            <RefreshCw size={13} />
          </button>
        </div>

        {loading ? (
          <div className="ms-empty">Loading…</div>
        ) : loadErr ? (
          <div className="ms-empty" style={{ color: '#dc2626' }}>
            Could not load data. Check your connection and try refreshing.
          </div>
        ) : items.length === 0 ? (
          <div className="ms-empty">No {label.toLowerCase()}s found. Add one above.</div>
        ) : (
          <ul className="ms-list">
            {items.map(item => (
              <li key={item.id} className="ms-item">
                {editId === item.id ? (
                  <>
                    <input
                      className="ms-input ms-input-inline"
                      value={editVal}
                      autoFocus
                      onChange={e => setEditVal(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleSave(item.id);
                        if (e.key === 'Escape') setEditId(null);
                      }}
                    />
                    <button className="ms-btn-save" onClick={() => handleSave(item.id)}>
                      <Check size={12} style={{ marginRight: 3 }} />Save
                    </button>
                    <button className="ms-btn-cancel" onClick={() => setEditId(null)}>
                      <X size={12} style={{ marginRight: 3 }} />Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className="ms-item-name">{item.name}</span>
                    <button className="ms-btn-edit" onClick={() => { setEditId(item.id); setEditVal(item.name); }}>
                      <Edit2 size={11} style={{ marginRight: 3 }} />Rename
                    </button>
                    <button className="ms-btn-delete" onClick={() => setPendingDelete(item.id)}>
                      <Trash2 size={11} style={{ marginRight: 3 }} />Delete
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function LeaveTypesTab() {
  const [types,         setTypes]         = useState([]);
  const [loading,       setLoading]       = useState(false);
  const [loadErr,       setLoadErr]       = useState(false);
  const [editId,        setEditId]        = useState(null);
  const [editData,      setEditData]      = useState({});
  const [addForm,       setAddForm]       = useState({ leave_name: '', default_days: '', description: '' });
  const [allocating,    setAllocating]    = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingAlloc,  setPendingAlloc]  = useState(false);
  const [toast,      showToast]     = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(false);
    try {
      const res = await api.get('/leaves/types');
      const list = Array.isArray(res.data) ? res.data : (res.data?.data || []);
      setTypes(list);
    } catch (err) {
      setTypes([]);
      setLoadErr(true);
      showToast(err?.message || 'Failed to load leave types', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const { leave_name, default_days, description } = addForm;
    if (!leave_name.trim()) return showToast('Leave name is required', 'error');
    if (!default_days || isNaN(Number(default_days)) || Number(default_days) < 0)
      return showToast('Enter valid default days (0 or more)', 'error');
    try {
      const res = await api.post('/leaves/types', {
        leave_name: leave_name.trim(),
        default_days: Number(default_days),
        description: description.trim(),
      });
      const created = res.data?.id
        ? res.data
        : { id: Date.now(), leave_name: leave_name.trim(), default_days: Number(default_days), description: description.trim() };
      setTypes(prev => [...prev, created]);
      setAddForm({ leave_name: '', default_days: '', description: '' });
      showToast('Leave type added');
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Failed to add leave type', 'error');
    }
  };

  const startEdit = (lt) => {
    setEditId(lt.id);
    setEditData({ leave_name: lt.leave_name, default_days: lt.default_days, description: lt.description || '' });
  };

  const handleSave = async (id) => {
    if (!editData.leave_name?.trim()) return showToast('Name required', 'error');
    try {
      await api.put(`/leaves/types/${id}`, {
        leave_name: editData.leave_name.trim(),
        default_days: Number(editData.default_days),
        description: editData.description,
      });
      setTypes(prev => prev.map(t => t.id === id ? { ...t, ...editData, default_days: Number(editData.default_days) } : t));
      setEditId(null);
      showToast('Updated');
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Failed to update', 'error');
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete;
    setPendingDelete(null);
    try {
      await api.delete(`/leaves/types/${id}`);
      setTypes(prev => prev.filter(t => t.id !== id));
      showToast('Deleted');
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Failed to delete', 'error');
    }
  };

  const handleBulkAllocate = async () => {
    setPendingAlloc(false);
    const year = new Date().getFullYear();
    setAllocating(true);
    try {
      await api.post('/leaves/bulk-allocate', { year });
      showToast(`Leave balances allocated for ${year}`);
    } catch (err) {
      showToast(err.response?.data?.error || err?.message || 'Bulk allocation failed', 'error');
    } finally {
      setAllocating(false);
    }
  };

  const af = addForm;
  const setAF = (k, v) => setAddForm(p => ({ ...p, [k]: v }));

  return (
    <>
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete Leave Type"
        message="Delete this leave type? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        open={pendingAlloc}
        title="Bulk Allocate Leave Balances"
        message={`Allocate leave balances to ALL active employees for ${new Date().getFullYear()}? Existing balances will not be overwritten.`}
        confirmLabel="Allocate"
        variant="warning"
        onConfirm={handleBulkAllocate}
        onCancel={() => setPendingAlloc(false)}
      />
      {toast && <div className={`ms-toast ms-toast-${toast.type}`}>{toast.msg}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button
          onClick={() => setPendingAlloc(true)}
          disabled={allocating}
          style={{ ...S.btn('#6B3FDB'), display: 'flex', alignItems: 'center', gap: 6, opacity: allocating ? 0.65 : 1 }}
        >
          <Users size={13} />
          {allocating ? 'Allocating…' : `Bulk Allocate to All Employees (${new Date().getFullYear()})`}
        </button>
      </div>

      <div style={{ background: '#fff', border: '1px solid #ebebf0', borderRadius: 14, overflow: 'hidden' }}>
        {/* Add form */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f6', background: '#fafafa' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Add New Leave Type
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '2 1 160px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>Leave Name *</label>
              <input style={S.input} placeholder="e.g. Sick Leave" value={af.leave_name}
                onChange={e => setAF('leave_name', e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} />
            </div>
            <div style={{ flex: '0 0 100px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>Default Days *</label>
              <input type="number" min="0" style={{ ...S.smInput, width: '100%' }} placeholder="12"
                value={af.default_days} onChange={e => setAF('default_days', e.target.value)} />
            </div>
            <div style={{ flex: '3 1 200px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>Description</label>
              <input style={S.input} placeholder="Optional description…" value={af.description}
                onChange={e => setAF('description', e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} />
            </div>
            <button className="ms-btn-add" onClick={handleAdd} style={{ alignSelf: 'flex-end', marginBottom: 1 }}>
              <Plus size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />Add
            </button>
          </div>
        </div>

        {/* Table header */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 90px 3fr auto', gap: 12, padding: '10px 20px', background: '#f8f7ff', borderBottom: '1px solid #f0f0f6', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          <span>Leave Type</span><span style={{ textAlign: 'center' }}>Default Days</span><span>Description</span><span style={{ textAlign: 'right' }}>Actions</span>
        </div>

        {loading ? (
          <div className="ms-empty">Loading leave types…</div>
        ) : loadErr ? (
          <div className="ms-empty" style={{ color: '#dc2626' }}>Could not load leave types. Check your connection and try refreshing.</div>
        ) : types.length === 0 ? (
          <div className="ms-empty">No leave types configured. Add one above.</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 8px' }}>
            {types.map((lt, idx) => (
              <li key={lt.id} style={{ display: 'grid', gridTemplateColumns: '2fr 90px 3fr auto', gap: 12, alignItems: 'center', padding: '10px 20px', borderBottom: idx < types.length - 1 ? '1px solid #f0f0f6' : 'none' }}>
                {editId === lt.id ? (
                  <>
                    <input style={S.input} value={editData.leave_name} autoFocus
                      onChange={e => setEditData(p => ({ ...p, leave_name: e.target.value }))}
                      onKeyDown={e => e.key === 'Escape' && setEditId(null)} />
                    <input type="number" min="0" style={{ ...S.smInput, width: '100%' }} value={editData.default_days}
                      onChange={e => setEditData(p => ({ ...p, default_days: e.target.value }))} />
                    <input style={S.input} value={editData.description}
                      onChange={e => setEditData(p => ({ ...p, description: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') handleSave(lt.id); if (e.key === 'Escape') setEditId(null); }} />
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="ms-btn-save" onClick={() => handleSave(lt.id)}><Check size={11} style={{ marginRight: 3 }} />Save</button>
                      <button className="ms-btn-cancel" onClick={() => setEditId(null)}><X size={11} /></button>
                    </div>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 14, color: '#1f2937', fontWeight: 500 }}>{lt.leave_name}</span>
                    <div style={{ textAlign: 'center' }}>
                      <span style={{ display: 'inline-block', background: '#ede9fe', color: '#6d28d9', borderRadius: 6, padding: '2px 10px', fontSize: 13, fontWeight: 700 }}>{lt.default_days}</span>
                    </div>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{lt.description || '—'}</span>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="ms-btn-edit" onClick={() => startEdit(lt)}><Edit2 size={11} style={{ marginRight: 3 }} />Edit</button>
                      <button className="ms-btn-delete" onClick={() => setPendingDelete(lt.id)}><Trash2 size={11} style={{ marginRight: 3 }} />Delete</button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

const TABS = [
  { key: 'departments',  label: 'Departments',  endpoint: '/master/departments' },
  { key: 'zones',        label: 'Zones',        endpoint: '/master/zones' },
  { key: 'designations', label: 'Designations', endpoint: '/master/designations' },
  { key: 'grades',       label: 'Grades',       endpoint: '/master/grades' },
  { key: 'bands',        label: 'Bands',        endpoint: '/master/bands' },
  { key: 'leaveTypes',   label: 'Leave Types',  endpoint: null },
];

export default function MasterSetup() {
  const [activeTab, setActiveTab] = useState('departments');

  const tab = TABS.find(t => t.key === activeTab);

  return (
    <div className="ms-wrap">
      <div className="ms-header">
        <h1 className="ms-title">Master Data Setup</h1>
        <p className="ms-subtitle">Manage departments, zones, designations, grades, bands and leave type policies</p>
      </div>

      <div style={{ maxWidth: activeTab === 'leaveTypes' ? 920 : 700, margin: '32px auto', padding: '0 16px' }}>
        <div className="ms-tabs" style={{ marginBottom: 16 }}>
          {TABS.map(t => (
            <button key={t.key} className={`ms-tab${activeTab === t.key ? ' ms-tab-active' : ''}`} onClick={() => setActiveTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'leaveTypes' ? (
          <LeaveTypesTab />
        ) : (
          <SimpleListTab endpoint={tab.endpoint} label={tab.label.slice(0, -1)} />
        )}
      </div>
    </div>
  );
}
