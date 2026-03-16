import { useState, useEffect, useCallback } from 'react';
import {
  Search, Filter, Plus, RefreshCw, ChevronDown, X,
  Ticket, AlertTriangle, Clock, CheckCircle, MessageSquare
} from 'lucide-react';
import api from '@/services/api/client';
import './AllTickets.css';

const priorityColor = p => {
  const m = (p || '').toLowerCase();
  if (m === 'critical') return { bg: '#fef2f2', color: '#7f1d1d' };
  if (m === 'high')     return { bg: '#fee2e2', color: '#dc2626' };
  if (m === 'medium')   return { bg: '#fef3c7', color: '#92400e' };
  return { bg: '#f0fdf4', color: '#15803d' };
};

const statusColor = s => {
  const m = (s || '').toLowerCase();
  if (m === 'open')        return { bg: '#eef2ff', color: '#4338ca' };
  if (m === 'in progress') return { bg: '#fef3c7', color: '#92400e' };
  if (m === 'resolved')    return { bg: '#f0fdf4', color: '#15803d' };
  if (m === 'pending')     return { bg: '#eff6ff', color: '#1d4ed8' };
  return { bg: '#f3f4f6', color: '#6b7280' };
};

const emptyForm = () => ({
  title: '', description: '', category: '', priority: 'Medium',
  team: '', requester_name: '', requester_email: '',
});

export default function AllTickets() {
  const [tickets,   setTickets]   = useState([]);
  const [filters,   setFilters]   = useState({ categories: [], teams: [], priorities: [], statuses: [] });
  const [total,     setTotal]     = useState(0);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [fStatus,   setFStatus]   = useState('');
  const [fPriority, setFPriority] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [drawer,    setDrawer]    = useState(null);   // null | 'create' | ticket
  const [detail,    setDetail]    = useState(null);   // ticket detail
  const [form,      setForm]      = useState(emptyForm());
  const [submitting,setSubmitting]= useState(false);
  const [comment,   setComment]   = useState('');
  const [toast,     setToast]     = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadFilters = async () => {
    try {
      const r = await api.get('/servicedesk/filters');
      setFilters(r.data);
    } catch {}
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (fStatus)   params.status   = fStatus;
      if (fPriority) params.priority = fPriority;
      if (fCategory) params.category = fCategory;
      if (search)    params.search   = search;
      const r = await api.get('/servicedesk/tickets', { params });
      setTickets(r.data.tickets || []);
      setTotal(r.data.total || 0);
    } catch {
      setTickets([]); setTotal(0);
    } finally { setLoading(false); }
  }, [fStatus, fPriority, fCategory, search]);

  useEffect(() => { loadFilters(); }, []);
  useEffect(() => { load(); }, [load]);

  const openDetail = async (t) => {
    try {
      const r = await api.get(`/servicedesk/tickets/${t.id}`);
      setDetail(r.data);
      setDrawer('detail');
    } catch { setDetail(t); setDrawer('detail'); }
  };

  const handleCreate = async () => {
    if (!form.title || !form.requester_name) return showToast('Title and requester required', 'error');
    setSubmitting(true);
    try {
      await api.post('/servicedesk/tickets', form);
      showToast('Ticket created');
      setDrawer(null); setForm(emptyForm()); load();
    } catch (e) { showToast(e.response?.data?.error || 'Failed to create ticket', 'error'); }
    finally { setSubmitting(false); }
  };

  const handleStatusChange = async (id, status) => {
    try {
      const t = tickets.find(x => x.id === id);
      await api.put(`/servicedesk/tickets/${id}`, { ...t, status });
      showToast(`Status updated to ${status}`);
      load();
      if (detail?.id === id) setDetail(d => ({ ...d, status }));
    } catch { showToast('Failed to update', 'error'); }
  };

  const handleComment = async () => {
    if (!comment.trim() || !detail) return;
    try {
      await api.post(`/servicedesk/tickets/${detail.id}/comments`, { body: comment });
      setComment('');
      const r = await api.get(`/servicedesk/tickets/${detail.id}`);
      setDetail(r.data);
    } catch { showToast('Failed to add comment', 'error'); }
  };

  const clearFilters = () => { setFStatus(''); setFPriority(''); setFCategory(''); setSearch(''); };

  return (
    <div className="at-root">

      {/* toast */}
      {toast && (
        <div className={`at-toast at-toast-${toast.type}`}>{toast.msg}</div>
      )}

      {/* header */}
      <div className="at-header">
        <div>
          <h2 className="at-title">All Tickets</h2>
          <p className="at-sub">{total} ticket{total !== 1 ? 's' : ''} total</p>
        </div>
        <button className="at-btn-primary" onClick={() => { setForm(emptyForm()); setDrawer('create'); }}>
          <Plus size={15} /> New Ticket
        </button>
      </div>

      {/* search + filters */}
      <div className="at-filters">
        <div className="at-search">
          <Search size={15} />
          <input placeholder="Search tickets…" value={search}
            onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="at-select" value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option value="">All Status</option>
          {(filters.statuses || []).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="at-select" value={fPriority} onChange={e => setFPriority(e.target.value)}>
          <option value="">All Priority</option>
          {(filters.priorities || []).map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="at-select" value={fCategory} onChange={e => setFCategory(e.target.value)}>
          <option value="">All Category</option>
          {(filters.categories || []).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {(fStatus || fPriority || fCategory || search) && (
          <button className="at-clear-btn" onClick={clearFilters}>
            <X size={13} /> Clear
          </button>
        )}
        <button className="at-icon-btn" onClick={load}><RefreshCw size={14} /></button>
      </div>

      {/* table */}
      {loading ? (
        <div className="at-loading"><div className="at-spinner" /></div>
      ) : tickets.length === 0 ? (
        <div className="at-empty">
          <Ticket size={40} color="#d1d5db" />
          <p>No tickets found</p>
        </div>
      ) : (
        <div className="at-table-wrap">
          <table className="at-table">
            <thead>
              <tr>
                <th>Ticket #</th><th>Title</th><th>Category</th>
                <th>Requester</th><th>Team</th><th>Priority</th>
                <th>Status</th><th>Created</th><th></th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => {
                const pc = priorityColor(t.priority);
                const sc = statusColor(t.status);
                return (
                  <tr key={t.id} className="at-row" onClick={() => openDetail(t)}>
                    <td className="at-td-mono">{t.ticket_number}</td>
                    <td className="at-td-title">{t.title}</td>
                    <td>{t.category}</td>
                    <td>{t.requester_name}<br/><span className="at-email">{t.requester_email}</span></td>
                    <td>{t.team || '—'}</td>
                    <td><span className="at-badge" style={{ background: pc.bg, color: pc.color }}>{t.priority}</span></td>
                    <td><span className="at-badge" style={{ background: sc.bg, color: sc.color }}>{t.status}</span></td>
                    <td>{t.created_at ? new Date(t.created_at).toLocaleDateString('en-IN') : '—'}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <select className="at-status-sel"
                        value={t.status}
                        onChange={e => handleStatusChange(t.id, e.target.value)}>
                        {['Open','In Progress','Pending','Resolved','Closed'].map(s =>
                          <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Create drawer ────────────────────────────────────────────────── */}
      {drawer === 'create' && (
        <div className="at-overlay" onClick={() => setDrawer(null)}>
          <div className="at-drawer" onClick={e => e.stopPropagation()}>
            <div className="at-drawer-hd">
              <h3>New Support Ticket</h3>
              <button className="at-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="at-drawer-body">
              <div className="at-field">
                <label>Title *</label>
                <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Brief issue summary" />
              </div>
              <div className="at-field">
                <label>Description</label>
                <textarea rows={4} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Describe the issue in detail" />
              </div>
              <div className="at-row2">
                <div className="at-field">
                  <label>Category</label>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                    <option value="">Select…</option>
                    {(filters.categories.length ? filters.categories : ['IT Support','Finance','HR','CRM','System','Access','Performance','Documents']).map(c =>
                      <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="at-field">
                  <label>Priority</label>
                  <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
                    {['Low','Medium','High','Critical'].map(p => <option key={p}>{p}</option>)}
                  </select>
                </div>
              </div>
              <div className="at-field">
                <label>Team</label>
                <select value={form.team} onChange={e => setForm(f => ({ ...f, team: e.target.value }))}>
                  <option value="">Select team…</option>
                  {(filters.teams.length ? filters.teams : ['IT Support','Finance IT','HR Support','CRM Support']).map(t =>
                    <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="at-row2">
                <div className="at-field">
                  <label>Requester Name *</label>
                  <input value={form.requester_name} onChange={e => setForm(f => ({ ...f, requester_name: e.target.value }))} />
                </div>
                <div className="at-field">
                  <label>Requester Email</label>
                  <input type="email" value={form.requester_email} onChange={e => setForm(f => ({ ...f, requester_email: e.target.value }))} />
                </div>
              </div>
            </div>
            <div className="at-drawer-ft">
              <button className="at-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
              <button className="at-btn-primary" onClick={handleCreate} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create Ticket'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Detail drawer ─────────────────────────────────────────────── */}
      {drawer === 'detail' && detail && (
        <div className="at-overlay" onClick={() => { setDrawer(null); setDetail(null); }}>
          <div className="at-drawer at-drawer-wide" onClick={e => e.stopPropagation()}>
            <div className="at-drawer-hd">
              <div>
                <span className="at-td-mono">{detail.ticket_number}</span>
                <h3 style={{ margin: '4px 0 0', fontSize: 16 }}>{detail.title}</h3>
              </div>
              <button className="at-icon-btn" onClick={() => { setDrawer(null); setDetail(null); }}><X size={16} /></button>
            </div>
            <div className="at-drawer-body">
              <div className="at-detail-badges">
                {[
                  { label: 'Priority', val: detail.priority, ...priorityColor(detail.priority) },
                  { label: 'Status',   val: detail.status,   ...statusColor(detail.status) },
                ].map((b, i) => (
                  <span key={i} className="at-badge" style={{ background: b.bg, color: b.color }}>{b.label}: {b.val}</span>
                ))}
                <span className="at-detail-meta">Category: <strong>{detail.category}</strong></span>
                <span className="at-detail-meta">Team: <strong>{detail.team || '—'}</strong></span>
                <span className="at-detail-meta">Requester: <strong>{detail.requester_name}</strong></span>
              </div>
              {detail.description && (
                <div className="at-detail-desc">{detail.description}</div>
              )}
              <div className="at-comments">
                <h4 style={{ margin: '0 0 12px', fontSize: 13, color: '#374151' }}>
                  <MessageSquare size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                  Comments ({(detail.comments || []).length})
                </h4>
                {(detail.comments || []).map((c, i) => (
                  <div key={i} className="at-comment">
                    <div className="at-comment-hd">
                      <span className="at-comment-author">{c.author}</span>
                      <span className="at-comment-time">{new Date(c.created_at).toLocaleString('en-IN')}</span>
                    </div>
                    <p className="at-comment-body">{c.body}</p>
                  </div>
                ))}
                <div className="at-comment-input">
                  <textarea rows={3} placeholder="Add a comment…" value={comment}
                    onChange={e => setComment(e.target.value)} />
                  <button className="at-btn-primary" onClick={handleComment} disabled={!comment.trim()}>
                    Reply
                  </button>
                </div>
              </div>
            </div>
            <div className="at-drawer-ft">
              <select className="at-select" value={detail.status}
                onChange={e => handleStatusChange(detail.id, e.target.value)}>
                {['Open','In Progress','Pending','Resolved','Closed'].map(s =>
                  <option key={s} value={s}>{s}</option>)}
              </select>
              <button className="at-btn-outline" onClick={() => { setDrawer(null); setDetail(null); }}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
