import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, X, Briefcase, Pencil, Trash2, ChevronRight } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const PAGE_SIZE = 20;

const PIPELINE = ['targeted','contacted','engaged','converted','dropped'];

const STATUS_COLORS = {
  targeted:  { bg: '#f3f4f6', color: '#6b7280' },
  contacted: { bg: '#dbeafe', color: '#2563eb' },
  engaged:   { bg: '#fef3c7', color: '#d97706' },
  converted: { bg: '#d1fae5', color: '#16a34a' },
  dropped:   { bg: '#fee2e2', color: '#dc2626' },
};
const PRIORITY_COLORS = {
  low:    { bg: '#f3f4f6', color: '#6b7280' },
  medium: { bg: '#fef3c7', color: '#d97706' },
  high:   { bg: '#fee2e2', color: '#dc2626' },
};

const BLANK = { account_name: '', campaign_id: '', priority: 'medium', assigned_to: '', notes: '' };

export default function PursuitList() {
  const [rows, setRows]           = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterCamp,   setFilterCamp]   = useState('');
  const [page, setPage]           = useState(1);
  const [showForm, setShowForm]   = useState(false);
  const [editId, setEditId]       = useState(null);
  const [form, setForm]           = useState(BLANK);
  const [saving, setSaving]       = useState(false);
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filterStatus) params.status      = filterStatus;
      if (filterCamp)   params.campaign_id = filterCamp;
      const [listRes, campsRes, empsRes] = await Promise.allSettled([
        api.get('/marketing/pursuit-list', { params }),
        api.get('/marketing/campaigns'),
        api.get('/employees'),
      ]);
      setRows(listRes.status === 'fulfilled' && Array.isArray(listRes.value?.data) ? listRes.value.data : []);
      setCampaigns(campsRes.status === 'fulfilled' && Array.isArray(campsRes.value?.data) ? campsRes.value.data : []);
      const empData = empsRes.status === 'fulfilled' ? empsRes.value?.data : null;
      setEmployees(Array.isArray(empData) ? empData : Array.isArray(empData?.employees) ? empData.employees : []);
    } catch { setRows([]); }
    finally { setLoading(false); }
  }, [filterStatus, filterCamp]);

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter(r =>
    !search || JSON.stringify(r).toLowerCase().includes(search.toLowerCase())
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const openNew = () => { setForm(BLANK); setEditId(null); setShowForm(true); };
  const openEdit = (r) => {
    setForm({
      account_name: r.display_account_name || r.account_name || '',
      campaign_id:  r.campaign_id  || '',
      priority:     r.priority     || 'medium',
      assigned_to:  r.assigned_to  || '',
      notes:        r.notes        || '',
    });
    setEditId(r.id);
    setShowForm(true);
  };

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try { await api.delete(`/marketing/pursuit-list/${id}`); load(); } catch { /* silent */ }
  };

  const handleStatusChange = async (id, status) => {
    try { await api.patch(`/marketing/pursuit-list/${id}`, { status }); load(); } catch { /* silent */ }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editId) {
        await api.patch(`/marketing/pursuit-list/${editId}`, form);
      } else {
        await api.post('/marketing/pursuit-list', form);
      }
      setShowForm(false);
      load();
    } catch { /* silent */ }
    finally { setSaving(false); }
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const COLS = ['Account', 'Campaign', 'Status', 'Priority', 'Assigned To', 'Notes', 'Actions'];

  return (
    <div style={{ padding: 24, background: 'var(--color-background-primary)' }}>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Remove from Pursuit"
        message="Remove from pursuit list?"
        confirmLabel="Remove"
        variant="warning"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>Pursuit List</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Target accounts for marketing outreach</p>
        </div>
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search…"
          style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', width: 160 }} />
        <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1); }}
          style={{ padding: '7px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
          <option value="">All Status</option>
          {PIPELINE.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
        </select>
        <select value={filterCamp} onChange={e => { setFilterCamp(e.target.value); setPage(1); }}
          style={{ padding: '7px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
          <option value="">All Campaigns</option>
          {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={load} style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, background: 'var(--color-background-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', fontSize: 13 }}>
          <RefreshCw size={14} /> Refresh
        </button>
        <button onClick={openNew} style={{ padding: '7px 16px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Add to Pursuit
        </button>
      </div>

      {/* Pipeline summary strip */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, overflowX: 'auto', paddingBottom: 4 }}>
        {PIPELINE.map((s, i) => {
          const cnt = rows.filter(r => r.status === s).length;
          const sc = STATUS_COLORS[s];
          return (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, padding: '8px 14px', textAlign: 'center', minWidth: 90 }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 2 }}>{s.charAt(0).toUpperCase() + s.slice(1)}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: sc.color }}>{cnt}</div>
              </div>
              {i < PIPELINE.length - 1 && <ChevronRight size={14} style={{ color: 'var(--color-text-secondary)', opacity: 0.4 }} />}
            </div>
          );
        })}
      </div>

      {/* Slide-in form */}
      {showForm && (
        <>
          <div onClick={() => setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }} />
          <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 440, background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', zIndex: 50, padding: 24, overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h3 style={{ margin: 0, color: 'var(--color-text-primary)', fontSize: 17 }}>{editId ? 'Edit Pursuit' : 'Add to Pursuit'}</h3>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}><X size={20} /></button>
            </div>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Account Name *</label>
                <input value={form.account_name} required onChange={e => set('account_name', e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Campaign</label>
                <select value={form.campaign_id} onChange={e => set('campaign_id', e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
                  <option value="">— None —</option>
                  {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Priority</label>
                  <select value={form.priority} onChange={e => set('priority', e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
                    {['low','medium','high'].map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Assign To</label>
                  <select value={form.assigned_to} onChange={e => set('assigned_to', e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
                    <option value="">— Select —</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => set('notes', e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', resize: 'vertical' }} />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <button type="submit" disabled={saving} style={{ flex: 1, padding: '9px 0', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                  {saving ? 'Saving…' : (editId ? 'Update' : 'Add to Pursuit')}
                </button>
                <button type="button" onClick={() => setShowForm(false)} style={{ flex: 1, padding: '9px 0', background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </form>
          </div>
        </>
      )}

      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, overflow: 'hidden' }}>
        {loading ? (
          [1,2,3].map(i => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 16px', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
              {[140, 120, 90, 80, 110, 140, 70].map((w, j) => (
                <div key={j} style={{ height: 14, width: w, background: 'var(--color-background-secondary)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          ))
        ) : paged.length === 0 ? (
          <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 24px', textAlign: 'center', background: 'var(--color-background-secondary)', borderRadius: 10, border: '0.5px solid var(--color-border-tertiary)' }}>
              <Briefcase size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
              <p style={{ fontWeight: 500, fontSize: 15, color: 'var(--color-text-primary)', margin: '0 0 4px' }}>No pursuit targets</p>
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 16px' }}>Add accounts to pursue for marketing outreach.</p>
              <button onClick={openNew} style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Add to Pursuit</button>
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--color-background-secondary)' }}>
                  {COLS.map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.map((r, i) => {
                  const sc = STATUS_COLORS[r.status] || {};
                  const pc = PRIORITY_COLORS[r.priority] || {};
                  return (
                    <tr key={r.id ?? i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--color-text-primary)' }}>{r.display_account_name || r.account_name || '—'}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{r.campaign_name || '—'}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <select value={r.status || 'targeted'} onChange={e => handleStatusChange(r.id, e.target.value)}
                          style={{ padding: '3px 8px', borderRadius: 8, border: `1.5px solid ${sc.color || '#e5e7eb'}`, background: sc.bg || '#f9fafb', color: sc.color || '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                          {PIPELINE.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        {r.priority ? <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: pc.bg, color: pc.color }}>{r.priority}</span> : '—'}
                      </td>
                      <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)' }}>{r.assigned_to_name || '—'}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.notes || '—'}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => openEdit(r)} title="Edit" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B3FDB', padding: 4 }}><Pencil size={14} /></button>
                          <button onClick={() => setPendingHandleDelete(r.id)} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: 4 }}><Trash2 size={14} /></button>
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

      {!loading && totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          <span>{filtered.length} records · Page {page} of {totalPages}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              style={{ padding: '5px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, background: 'var(--color-background-secondary)', cursor: page === 1 ? 'default' : 'pointer', color: 'var(--color-text-secondary)', opacity: page === 1 ? 0.5 : 1, fontSize: 13 }}>Prev</button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              style={{ padding: '5px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, background: 'var(--color-background-secondary)', cursor: page === totalPages ? 'default' : 'pointer', color: 'var(--color-text-secondary)', opacity: page === totalPages ? 0.5 : 1, fontSize: 13 }}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
