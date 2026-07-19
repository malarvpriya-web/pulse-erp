import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, X, Package, CheckCircle } from 'lucide-react';
import api from '@/services/api/client';

const PAGE_SIZE = 20;
const fmtDate = (d) => d ? d.slice(0, 10) : '—';
const isOverdue = (due, status) => {
  if (!due || status === 'delivered') return false;
  return new Date(due) < new Date();
};

const STATUS_COLORS = {
  pending:     { bg: '#f3f4f6', color: '#6b7280' },
  in_progress: { bg: '#dbeafe', color: '#2563eb' },
  delivered:   { bg: '#d1fae5', color: '#16a34a' },
  overdue:     { bg: '#fee2e2', color: '#dc2626' },
};

const TYPES = ['email','social_post','blog','ad','video','brochure'];

const BLANK = { campaign_id: '', name: '', type: '', due_date: '', assigned_to: '', notes: '' };

export default function DeliveryTracker() {
  const [rows, setRows]           = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [filterCamp, setFilterCamp]     = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [page, setPage]           = useState(1);
  const [showForm, setShowForm]   = useState(false);
  const [form, setForm]           = useState(BLANK);
  const [saving, setSaving]       = useState(false);
  const [deliverNotes, setDeliverNotes] = useState('');
  const [deliveringId, setDeliveringId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filterCamp)   params.campaign_id = filterCamp;
      if (filterStatus) params.status      = filterStatus;
      const [delivRes, campsRes, empsRes] = await Promise.allSettled([
        api.get('/marketing/deliverables', { params }),
        api.get('/marketing/campaigns'),
        api.get('/employees'),
      ]);
      setRows(delivRes.status === 'fulfilled' && Array.isArray(delivRes.value?.data) ? delivRes.value.data : []);
      setCampaigns(campsRes.status === 'fulfilled' && Array.isArray(campsRes.value?.data) ? campsRes.value.data : []);
      const empData = empsRes.status === 'fulfilled' ? empsRes.value?.data : null;
      setEmployees(Array.isArray(empData) ? empData : Array.isArray(empData?.employees) ? empData.employees : []);
    } catch { setRows([]); }
    finally { setLoading(false); }
  }, [filterCamp, filterStatus]);

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter(r =>
    !search || JSON.stringify(r).toLowerCase().includes(search.toLowerCase())
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const openNew = () => { setForm(BLANK); setShowForm(true); };

  const handleDeliver = async (id) => {
    try {
      await api.patch(`/marketing/deliverables/${id}/deliver`, { notes: deliverNotes });
      setDeliveringId(null);
      setDeliverNotes('');
      load();
    } catch { /* silent */ }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/marketing/deliverables', form);
      setShowForm(false);
      load();
    } catch { /* silent */ }
    finally { setSaving(false); }
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const COLS = ['Deliverable', 'Type', 'Campaign', 'Assigned To', 'Due Date', 'Status', 'Actions'];

  return (
    <div style={{ padding: 24, background: 'var(--color-background-primary)' }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>Delivery Tracker</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Track campaign deliverables and their completion</p>
        </div>
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search…"
          style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', width: 160 }} />
        <select value={filterCamp} onChange={e => { setFilterCamp(e.target.value); setPage(1); }}
          style={{ padding: '7px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
          <option value="">All Campaigns</option>
          {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1); }}
          style={{ padding: '7px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
          <option value="">All Status</option>
          {['pending','in_progress','delivered'].map(s => <option key={s} value={s}>{s.replace('_',' ')}</option>)}
        </select>
        <button onClick={load} style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, background: 'var(--color-background-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', fontSize: 13 }}>
          <RefreshCw size={14} /> Refresh
        </button>
        <button onClick={openNew} style={{ padding: '7px 16px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Add Deliverable
        </button>
      </div>

      {/* Deliver confirmation modal */}
      {deliveringId && (
        <>
          <div onClick={() => setDeliveringId(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: 24, zIndex: 50, width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Mark as Delivered</h3>
            <textarea value={deliverNotes} onChange={e => setDeliverNotes(e.target.value)} placeholder="Delivery notes (optional)…" rows={3}
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', resize: 'vertical', marginBottom: 16 }} />
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => handleDeliver(deliveringId)} style={{ flex: 1, padding: '9px 0', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>Confirm Delivered</button>
              <button onClick={() => setDeliveringId(null)} style={{ flex: 1, padding: '9px 0', background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            </div>
          </div>
        </>
      )}

      {/* New deliverable form */}
      {showForm && (
        <>
          <div onClick={() => setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }} />
          <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 440, background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', zIndex: 50, padding: 24, overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h3 style={{ margin: 0, color: 'var(--color-text-primary)', fontSize: 17 }}>Add Deliverable</h3>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}><X size={20} /></button>
            </div>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Name *</label>
                <input value={form.name} required onChange={e => set('name', e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Type</label>
                  <select value={form.type} onChange={e => set('type', e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
                    <option value="">— Select —</option>
                    {TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Due Date</label>
                  <input type="date" value={form.due_date} onChange={e => set('due_date', e.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }} />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Campaign</label>
                <select value={form.campaign_id} onChange={e => set('campaign_id', e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
                  <option value="">— None —</option>
                  {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Assigned To</label>
                <select value={form.assigned_to} onChange={e => set('assigned_to', e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
                  <option value="">— Select employee —</option>
                  {employees.map(e => <option key={e.id} value={e.id}>{e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim()}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Notes</label>
                <textarea rows={2} value={form.notes} onChange={e => set('notes', e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', resize: 'vertical' }} />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <button type="submit" disabled={saving} style={{ flex: 1, padding: '9px 0', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                  {saving ? 'Saving…' : 'Add Deliverable'}
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
              {[140, 90, 120, 110, 90, 80, 100].map((w, j) => (
                <div key={j} style={{ height: 14, width: w, background: 'var(--color-background-secondary)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          ))
        ) : paged.length === 0 ? (
          <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 24px', textAlign: 'center', background: 'var(--color-background-secondary)', borderRadius: 10, border: '0.5px solid var(--color-border-tertiary)' }}>
              <Package size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
              <p style={{ fontWeight: 500, fontSize: 15, color: 'var(--color-text-primary)', margin: '0 0 4px' }}>No deliverables found</p>
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 16px' }}>Add campaign deliverables to track completion.</p>
              <button onClick={openNew} style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Add Deliverable</button>
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
                  const overdue = isOverdue(r.due_date, r.status);
                  const sc = STATUS_COLORS[overdue ? 'overdue' : r.status] || {};
                  return (
                    <tr key={r.id ?? i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)', background: overdue ? 'rgba(220,38,38,0.04)' : 'transparent' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--color-text-primary)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || '—'}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)' }}>{r.type?.replace('_',' ') || '—'}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{r.campaign_name || '—'}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)' }}>{r.assigned_to_name || '—'}</td>
                      <td style={{ padding: '10px 14px', color: overdue ? '#dc2626' : 'var(--color-text-secondary)', whiteSpace: 'nowrap', fontWeight: overdue ? 600 : 400 }}>
                        {fmtDate(r.due_date)}{overdue ? ' ⚠' : ''}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.color, whiteSpace: 'nowrap' }}>
                          {overdue ? 'overdue' : (r.status || '—')}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        {r.status !== 'delivered' && (
                          <button onClick={() => { setDeliveringId(r.id); setDeliverNotes(''); }}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: '#d1fae5', color: '#16a34a', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                            <CheckCircle size={12} /> Deliver
                          </button>
                        )}
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
