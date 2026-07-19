import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, X, Pencil, Trash2, Target } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const fmtL = (n) => {
  const v = parseFloat(n) || 0;
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)}L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
};

const TYPE_COLORS = {
  email:    { bg: '#dbeafe', color: '#2563eb' },
  social:   { bg: '#e0e7ff', color: '#4f46e5' },
  event:    { bg: '#d1fae5', color: '#16a34a' },
  content:  { bg: '#fef3c7', color: '#d97706' },
  paid:     { bg: '#fee2e2', color: '#dc2626' },
  referral: { bg: '#f0fdf4', color: '#15803d' },
};

const STATUS_COLORS = {
  draft:     { bg: '#f3f4f6', color: '#6b7280' },
  active:    { bg: '#d1fae5', color: '#16a34a' },
  paused:    { bg: '#fef3c7', color: '#d97706' },
  completed: { bg: '#dbeafe', color: '#2563eb' },
  cancelled: { bg: '#fee2e2', color: '#dc2626' },
};

const TYPES   = ['email','social','event','content','paid','referral'];
const STATUSES = ['draft','active','paused','completed','cancelled'];

const BLANK = {
  name: '', type: 'email', status: 'draft', budget: '', target_leads: '',
  start_date: '', end_date: '', description: '',
};

function SkeletonCard() {
  return (
    <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 16, animation: 'pulse 1.5s ease-in-out infinite' }}>
      {[120, 80, 200, 60].map((w, i) => (
        <div key={i} style={{ height: 12, width: w, background: 'var(--color-border-tertiary)', borderRadius: 4, marginBottom: 10 }} />
      ))}
    </div>
  );
}

export default function Campaigns() {
  const [rows, setRows]         = useState([]);
  const [stats, setStats]       = useState({});
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]     = useState(null);
  const [form, setForm]         = useState(BLANK);
  const [saving, setSaving]     = useState(false);
  const [filterType, setFilterType]     = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch]             = useState('');
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filterType)   params.type   = filterType;
      if (filterStatus) params.status = filterStatus;
      if (search)       params.search = search;
      const [campsRes, statsRes] = await Promise.allSettled([
        api.get('/marketing/campaigns', { params }),
        api.get('/marketing/campaigns/stats'),
      ]);
      setRows(campsRes.status === 'fulfilled' && Array.isArray(campsRes.value?.data) ? campsRes.value.data : []);
      setStats(statsRes.status === 'fulfilled' ? (statsRes.value?.data || {}) : {});
    } catch { setRows([]); }
    finally { setLoading(false); }
  }, [filterType, filterStatus, search]);

  useEffect(() => { load(); }, [load]);

  const openNew = () => { setForm(BLANK); setEditId(null); setShowForm(true); };
  const openEdit = (r) => {
    setForm({
      name: r.name || '', type: r.type || 'email', status: r.status || 'draft',
      budget: r.budget || '', target_leads: r.target_leads || '',
      start_date: r.start_date?.slice(0, 10) || '',
      end_date:   r.end_date?.slice(0, 10) || '',
      description: r.description || '',
    });
    setEditId(r.id);
    setShowForm(true);
  };

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try { await api.delete(`/marketing/campaigns/${id}`); load(); } catch { /* silent */ }
  };

  const handleStatusToggle = async (r) => {
    const next = r.status === 'active' ? 'paused' : 'active';
    try { await api.patch(`/marketing/campaigns/${r.id}/status`, { status: next }); load(); } catch { /* silent */ }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editId) {
        await api.put(`/marketing/campaigns/${editId}`, form);
      } else {
        await api.post('/marketing/campaigns', form);
      }
      setShowForm(false);
      load();
    } catch { /* silent */ }
    finally { setSaving(false); }
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div style={{ padding: 24, background: 'var(--color-background-primary)' }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>Campaigns</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Manage all marketing campaigns</p>
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search campaigns…"
          style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', width: 180 }} />
        <button onClick={load} style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, background: 'var(--color-background-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', fontSize: 13 }}>
          <RefreshCw size={14} /> Refresh
        </button>
        <button onClick={openNew} style={{ padding: '7px 16px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> New Campaign
        </button>
      </div>

      {/* KPI stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total', value: stats.total ?? 0 },
          { label: 'Active', value: stats.active ?? 0 },
          { label: 'Draft', value: stats.draft ?? 0 },
          { label: 'Budget', value: fmtL(stats.total_budget) },
          { label: 'Spent', value: fmtL(stats.total_spent) },
          { label: 'Leads', value: stats.total_leads ?? 0 },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4, fontWeight: 500 }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>{loading ? '…' : value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {['', ...TYPES].map(t => (
          <button key={t || 'all'} onClick={() => setFilterType(t)}
            style={{ padding: '5px 14px', borderRadius: 20, border: '0.5px solid var(--color-border-tertiary)', background: filterType === t ? '#6B3FDB' : 'var(--color-background-secondary)', color: filterType === t ? '#fff' : 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 500 }}>
            {t || 'All Types'}
          </button>
        ))}
        <div style={{ width: 1, background: 'var(--color-border-tertiary)', margin: '0 4px' }} />
        {['', ...STATUSES].map(s => (
          <button key={s || 'all-s'} onClick={() => setFilterStatus(s)}
            style={{ padding: '5px 14px', borderRadius: 20, border: '0.5px solid var(--color-border-tertiary)', background: filterStatus === s ? '#6B3FDB' : 'var(--color-background-secondary)', color: filterStatus === s ? '#fff' : 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 500 }}>
            {s || 'All Status'}
          </button>
        ))}
      </div>

      {/* Slide-in form */}
      {showForm && (
        <>
          <div onClick={() => setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }} />
          <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 460, background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', zIndex: 50, padding: 24, overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h3 style={{ margin: 0, color: 'var(--color-text-primary)', fontSize: 17 }}>{editId ? 'Edit Campaign' : 'New Campaign'}</h3>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}><X size={20} /></button>
            </div>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Campaign Name *</label>
                <input value={form.name} required onChange={e => set('name', e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Type</label>
                  <select value={form.type} onChange={e => set('type', e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
                    {TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Status</label>
                  <select value={form.status} onChange={e => set('status', e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
                    {STATUSES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {[['budget','Budget (₹)','number'],['target_leads','Target Leads','number']].map(([k,l,t]) => (
                  <div key={k}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{l}</label>
                    <input type={t} min={0} value={form[k]} onChange={e => set(k, e.target.value)}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {[['start_date','Start Date *'],['end_date','End Date']].map(([k,l]) => (
                  <div key={k}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{l}</label>
                    <input type="date" value={form[k]} required={k === 'start_date'} onChange={e => set(k, e.target.value)}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }} />
                  </div>
                ))}
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Description</label>
                <textarea rows={3} value={form.description} onChange={e => set('description', e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', resize: 'vertical' }} />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <button type="submit" disabled={saving} style={{ flex: 1, padding: '9px 0', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                  {saving ? 'Saving…' : (editId ? 'Update' : 'Create Campaign')}
                </button>
                <button type="button" onClick={() => setShowForm(false)} style={{ flex: 1, padding: '9px 0', background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {/* Campaign cards grid */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 16 }}>
          <SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
      ) : rows.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 24px', textAlign: 'center', background: 'var(--color-background-secondary)', borderRadius: 10, border: '0.5px solid var(--color-border-tertiary)' }}>
          <Target size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
          <p style={{ fontWeight: 500, fontSize: 15, color: 'var(--color-text-primary)', margin: '0 0 4px' }}>No campaigns yet</p>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 16px' }}>Create your first campaign to start tracking performance.</p>
          <button onClick={openNew} style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> Create Campaign
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 16 }}>
          {rows.map(r => {
            const tc = TYPE_COLORS[r.type] || {};
            const sc = STATUS_COLORS[r.status] || {};
            const pct = r.budget > 0 ? Math.min(100, Math.round((parseFloat(r.spent) || 0) / parseFloat(r.budget) * 100)) : 0;
            return (
              <div key={r.id} style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: tc.bg, color: tc.color }}>{r.type}</span>
                      <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.color }}>{r.status}</span>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span>Budget: <strong style={{ color: 'var(--color-text-primary)' }}>{fmtL(r.budget)}</strong></span>
                    <span>Spent: <strong style={{ color: 'var(--color-text-primary)' }}>{fmtL(r.spent)}</strong></span>
                  </div>
                  <div style={{ height: 4, background: 'var(--color-border-tertiary)', borderRadius: 2 }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: pct > 80 ? '#dc2626' : '#6B3FDB', borderRadius: 2 }} />
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 11, marginTop: 2 }}>{pct}% spent</div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                  Leads: <strong style={{ color: 'var(--color-text-primary)' }}>{r.actual_leads || 0}</strong> / {r.target_leads || 0}
                  {r.owner_name && <span style={{ marginLeft: 10 }}>· {r.owner_name}</span>}
                </div>
                {(r.start_date || r.end_date) && (
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                    {r.start_date?.slice(0,10)} → {r.end_date?.slice(0,10) || 'Ongoing'}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, borderTop: '0.5px solid var(--color-border-tertiary)', paddingTop: 10 }}>
                  <button onClick={() => openEdit(r)} style={{ flex: 1, padding: '6px 0', background: 'none', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                    <Pencil size={12} /> Edit
                  </button>
                  {(r.status === 'active' || r.status === 'paused') && (
                    <button onClick={() => handleStatusToggle(r)} style={{ flex: 1, padding: '6px 0', background: 'none', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: r.status === 'active' ? '#d97706' : '#16a34a' }}>
                      {r.status === 'active' ? 'Pause' : 'Resume'}
                    </button>
                  )}
                  <button onClick={() => setPendingHandleDelete(r.id)} style={{ padding: '6px 10px', background: 'none', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, cursor: 'pointer', color: '#dc2626' }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Campaign"
        message="Delete this campaign?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
    </div>
  );
}
