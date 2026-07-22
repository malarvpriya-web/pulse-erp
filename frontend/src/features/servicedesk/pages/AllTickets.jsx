import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search, Plus, RefreshCw, X, Ticket, MessageSquare,
  Paperclip, Trash2, Download, AlertTriangle
} from 'lucide-react';
import api from '@/services/api/client';
import { priorityColor, statusColor } from './ticketUtils';
import './AllTickets.css';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';

const emptyForm = () => ({
  title: '', description: '', category: '', priority: 'Medium',
  team: '', requester_name: '', requester_email: '',
  due_date: '', serial_number: '', amc_contract_id: '',
  assigned_to: '', department: 'Service',
});

const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const fmtDateTime = (d) => d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export default function AllTickets() {
  const { readOnly } = usePageAccess();
  const [tickets,    setTickets]    = useState([]);
  const [filters,    setFilters]    = useState({ categories: [], teams: [], priorities: [], statuses: [] });
  const [engineers,  setEngineers]  = useState([]);
  const [total,      setTotal]      = useState(0);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [fStatus,    setFStatus]    = useState('');
  const [fPriority,  setFPriority]  = useState('');
  const [fCategory,  setFCategory]  = useState('');
  const [drawer,     setDrawer]     = useState(null);
  const [detail,     setDetail]     = useState(null);
  const [attachments,setAttachments]= useState([]);
  const [form,       setForm]       = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [comment,    setComment]    = useState('');
  const [toast,      setToast]      = useState(null);
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);
  const fileRef = useRef(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const loadFilters = async () => {
    try {
      const [filRes, engRes] = await Promise.allSettled([
        api.get('/servicedesk/filters'),
        api.get('/servicedesk/engineers'),
      ]);
      if (filRes.status === 'fulfilled') setFilters(filRes.value.data);
      if (engRes.status === 'fulfilled') setEngineers(engRes.value.data || []);
    } catch (err) { showToast('Could not load filter options', 'error'); }
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
      const [detRes, attRes] = await Promise.allSettled([
        api.get(`/servicedesk/tickets/${t.id}`),
        api.get(`/servicedesk/tickets/${t.id}/attachments`),
      ]);
      setDetail(detRes.status === 'fulfilled' ? detRes.value.data : t);
      setAttachments(attRes.status === 'fulfilled' ? attRes.value.data : []);
      setDrawer('detail');
    } catch { setDetail(t); setAttachments([]); setDrawer('detail'); }
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

  const handleStatusChange = async (id, newStatus) => {
    const prev = tickets.find(x => x.id === id);
    const prevStatus = prev?.status;
    setTickets(ts => ts.map(t => t.id === id ? { ...t, status: newStatus } : t));
    if (detail?.id === id) setDetail(d => ({ ...d, status: newStatus }));
    try {
      await api.put(`/servicedesk/tickets/${id}`, { ...prev, status: newStatus });
      showToast(`Status updated to ${newStatus}`);
    } catch (e) {
      setTickets(ts => ts.map(t => t.id === id ? { ...t, status: prevStatus } : t));
      if (detail?.id === id) setDetail(d => ({ ...d, status: prevStatus }));
      showToast(e?.response?.data?.error || 'Failed to update status', 'error');
    }
  };

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/servicedesk/tickets/${id}`);
      showToast('Ticket deleted');
      setDrawer(null); setDetail(null); load();
    } catch (e) { showToast(e.response?.data?.error || 'Failed to delete', 'error'); }
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

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !detail) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      await api.post(`/servicedesk/tickets/${detail.id}/attachments`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      showToast('File attached');
      const r = await api.get(`/servicedesk/tickets/${detail.id}/attachments`);
      setAttachments(r.data);
    } catch (e) { showToast(e.response?.data?.error || 'Upload failed', 'error'); }
    e.target.value = '';
  };

  const handleDeleteAttachment = async (attId) => {
    try {
      await api.delete(`/servicedesk/tickets/${detail.id}/attachments/${attId}`);
      setAttachments(a => a.filter(x => x.id !== attId));
    } catch { showToast('Failed to remove attachment', 'error'); }
  };

  const handleExport = async () => {
    try {
      const params = new URLSearchParams();
      if (fStatus)   params.set('status', fStatus);
      if (fPriority) params.set('priority', fPriority);
      if (fCategory) params.set('category', fCategory);
      const res = await api.get(`/servicedesk/export/tickets?${params}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url;
      a.download = `tickets_${new Date().toISOString().slice(0,10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch { showToast('Export failed', 'error'); }
  };

  const clearFilters = () => { setFStatus(''); setFPriority(''); setFCategory(''); setSearch(''); };

  return (
    <div className="at-root">

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Ticket"
        message="Delete this ticket? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />

      {toast && (
        <div className={`at-toast at-toast-${toast.type}`}>{toast.msg}</div>
      )}

      {readOnly && <ReadOnlyBanner />}

      <div className="at-header">
        <div>
          <h2 className="at-title">All Tickets</h2>
          <p className="at-sub">{total} ticket{total !== 1 ? 's' : ''} total</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="at-btn-outline" onClick={handleExport} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Download size={14} /> Export CSV
          </button>
          {!readOnly && (
            <button className="at-btn-primary" onClick={() => { setForm(emptyForm()); setDrawer('create'); }}>
              <Plus size={15} /> New Ticket
            </button>
          )}
        </div>
      </div>

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
                <th>Status</th><th>Due</th><th>Created</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(tickets ?? []).map((t) => {
                const pc = priorityColor(t?.priority ?? 'Medium');
                const sc = statusColor(t?.status ?? 'Open');
                const overdue = t?.due_date && new Date(t.due_date) < new Date() && !['Resolved','Closed'].includes(t?.status ?? '');
                return (
                  <tr key={t.id} className="at-row" onClick={() => openDetail(t)}>
                    <td className="at-td-mono">{t.ticket_number}</td>
                    <td className="at-td-title">
                      {t.title}
                      {t.attachment_count > 0 && (
                        <span title={`${t.attachment_count} attachment(s)`} style={{ marginLeft: 6, color: '#9ca3af', fontSize: 11 }}>
                          <Paperclip size={11} style={{ verticalAlign: 'middle' }} /> {t.attachment_count}
                        </span>
                      )}
                      {t.serial_number && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: '#6366f1', fontFamily: 'monospace' }}>{t.serial_number}</span>
                      )}
                    </td>
                    <td>{t.category}</td>
                    <td>{t?.requester_name ?? 'Unknown'}<br/><span className="at-email">{t?.requester_email ?? '—'}</span></td>
                    <td>{t?.team ?? '—'}</td>
                    <td><span className="at-badge" style={{ background: pc.bg, color: pc.color }}>{t?.priority ?? 'Medium'}</span></td>
                    <td><span className="at-badge" style={{ background: sc.bg, color: sc.color }}>{t?.status ?? 'Open'}</span></td>
                    <td style={{ color: overdue ? '#ef4444' : undefined }}>
                      {fmtDate(t.due_date)}
                      {overdue && <AlertTriangle size={12} style={{ marginLeft: 4, verticalAlign: 'middle' }} />}
                    </td>
                    <td>{fmtDate(t.created_at)}</td>
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
                    {(filters.categories.length ? filters.categories : ['IT Support','Finance','HR','CRM','System','Access','Performance','Documents','Service','Field','AMC','Warranty']).map(c =>
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
              <div className="at-row2">
                <div className="at-field">
                  <label>Team</label>
                  <select value={form.team} onChange={e => setForm(f => ({ ...f, team: e.target.value }))}>
                    <option value="">Select team…</option>
                    {(filters.teams.length ? filters.teams : ['IT Support','Finance IT','HR Support','Service','Field Service']).map(t =>
                      <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="at-field">
                  <label>Assign Engineer</label>
                  <select value={form.assigned_to} onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))}>
                    <option value="">Unassigned</option>
                    {/* support_tickets.assigned_to is an employee_id (integer FK), not
                        the engineer's name — previously this sent e.name, which the
                        backend silently rejected/mistyped, so assignment never worked.
                        Engineers with no linked employee record can't be assigned. */}
                    {engineers.filter(e => e.employee_id).map(e => <option key={e.id} value={e.employee_id}>{e.name} — {e.specialization || e.zone || ''}</option>)}
                  </select>
                </div>
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
              <div className="at-row2">
                <div className="at-field">
                  <label>Serial Number</label>
                  <input value={form.serial_number} onChange={e => setForm(f => ({ ...f, serial_number: e.target.value }))} placeholder="e.g. MT-HVDC-001" />
                </div>
                <div className="at-field">
                  <label>Due Date</label>
                  <input type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
                </div>
              </div>
              <div className="at-row2">
                <div className="at-field">
                  <label>Department</label>
                  <select value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))}>
                    {['Service','Field','AMC','IT','Finance','HR'].map(d => <option key={d}>{d}</option>)}
                  </select>
                </div>
                <div className="at-field">
                  <label>AMC Contract ID</label>
                  <input type="number" value={form.amc_contract_id} onChange={e => setForm(f => ({ ...f, amc_contract_id: e.target.value }))} placeholder="Optional" />
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
                {detail.serial_number && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: '#6366f1', fontFamily: 'monospace' }}>
                    S/N: {detail.serial_number}
                  </span>
                )}
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
                {detail.assigned_to && <span className="at-detail-meta">Assigned: <strong>{detail.assigned_to_name || `Employee #${detail.assigned_to}`}</strong></span>}
                {detail.due_date && (
                  <span className="at-detail-meta" style={{ color: new Date(detail.due_date) < new Date() && !['Resolved','Closed'].includes(detail.status) ? '#ef4444' : undefined }}>
                    Due: <strong>{fmtDate(detail.due_date)}</strong>
                  </span>
                )}
                {detail.amc_contract_id && <span className="at-detail-meta">AMC: <strong>#{detail.amc_contract_id}</strong></span>}
              </div>
              {detail.description && (
                <div className="at-detail-desc">{detail.description}</div>
              )}

              {/* Attachments */}
              <div className="at-attachments">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <h4 style={{ margin: 0, fontSize: 13, color: '#374151' }}>
                    <Paperclip size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                    Attachments ({attachments.length})
                  </h4>
                  <button
                    style={{ fontSize: 12, padding: '4px 10px', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 5, cursor: 'pointer' }}
                    onClick={() => fileRef.current?.click()}
                  >
                    + Attach File
                  </button>
                  <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={handleFileUpload} />
                </div>
                {attachments.length === 0 && (
                  <p style={{ color: '#9ca3af', fontSize: 13, margin: 0 }}>No attachments yet.</p>
                )}
                {attachments.map(att => (
                  <div key={att.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                    <Paperclip size={13} color="#9ca3af" />
                    <a href={att.url} target="_blank" rel="noreferrer" style={{ flex: 1, fontSize: 13, color: '#6366f1', textDecoration: 'none' }}>
                      {att.original_name || att.filename}
                    </a>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>
                      {att.file_size ? `${(att.file_size / 1024).toFixed(0)} KB` : ''}
                    </span>
                    {!readOnly && (
                      <button onClick={() => handleDeleteAttachment(att.id)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 2 }}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Comments */}
              <div className="at-comments">
                <h4 style={{ margin: '16px 0 12px', fontSize: 13, color: '#374151' }}>
                  <MessageSquare size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                  Comments ({(detail.comments || []).length})
                </h4>
                {(detail.comments || []).map((c, i) => (
                  <div key={i} className="at-comment">
                    <div className="at-comment-hd">
                      <span className="at-comment-author">{c.author}</span>
                      <span className="at-comment-time">{fmtDateTime(c.created_at)}</span>
                    </div>
                    <p className="at-comment-body">{c.body}</p>
                  </div>
                ))}
                {!readOnly && (
                  <div className="at-comment-input">
                    <textarea rows={3} placeholder="Add a comment…" value={comment}
                      onChange={e => setComment(e.target.value)} />
                    <button className="at-btn-primary" onClick={handleComment} disabled={!comment.trim()}>
                      Reply
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="at-drawer-ft">
              {!readOnly && (
                <>
                  <button
                    style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}
                    onClick={() => setPendingHandleDelete(detail.id)}
                    title="Delete ticket"
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                  <select className="at-select" value={detail.status}
                    onChange={e => handleStatusChange(detail.id, e.target.value)}>
                    {['Open','In Progress','Pending','Resolved','Closed'].map(s =>
                      <option key={s} value={s}>{s}</option>)}
                  </select>
                </>
              )}
              <button className="at-btn-outline" onClick={() => { setDrawer(null); setDetail(null); }}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
