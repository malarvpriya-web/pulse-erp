import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Plus, Search, RefreshCw, X, ShoppingCart,
  CheckCircle, XCircle, Trash2, ArrowRight,
} from 'lucide-react';
import api from '@/services/api/client';
import './PurchaseRequest.css';

const STATUS_META = {
  draft:             { bg: '#f3f4f6', color: '#6b7280', label: 'Draft'            },
  pending_approval:  { bg: '#fef3c7', color: '#92400e', label: 'Pending Approval' },
  approved:          { bg: '#dcfce7', color: '#15803d', label: 'Approved'         },
  rejected:          { bg: '#fee2e2', color: '#dc2626', label: 'Rejected'         },
  converted_to_po:   { bg: '#dbeafe', color: '#1d4ed8', label: 'Ordered'          },
  received:          { bg: '#d1fae5', color: '#065f46', label: 'Received'         },
};
const sm = s => STATUS_META[(s || '').replace(/ /g, '_').toLowerCase()] || STATUS_META.draft;

const PRIORITY_META = {
  urgent: { bg: '#fee2e2', color: '#dc2626', label: 'Urgent'  },
  high:   { bg: '#ffedd5', color: '#c2410c', label: 'High'    },
  medium: { bg: '#fef3c7', color: '#92400e', label: 'Medium'  },
  low:    { bg: '#f3f4f6', color: '#6b7280', label: 'Low'     },
};
const pm = p => PRIORITY_META[(p || 'medium').toLowerCase()] || PRIORITY_META.medium;

const fmt = n => `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const emptyItem = () => ({ item_name: '', quantity: 1, expected_price: 0, remarks: '' });
const emptyForm = () => ({
  request_date:  new Date().toISOString().split('T')[0],
  required_date: '',
  department:    '',
  priority:      'medium',
  notes:         '',
  items:         [emptyItem()],
});

const STATUSES = ['pending_approval', 'approved', 'converted_to_po', 'received', 'draft', 'rejected'];

export default function PurchaseRequest() {
  const [prs,         setPRs]         = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [search,      setSearch]      = useState('');
  const [fStatus,     setFStatus]     = useState('');
  const [drawer,      setDrawer]      = useState(false);
  const [form,        setForm]        = useState(emptyForm());
  const [submitting,  setSubmitting]  = useState(false);
  const [actioningId, setActioningId] = useState(null);
  const [toast,       setToast]       = useState(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/procurement/purchase-requests', { params: fStatus ? { status: fStatus } : {} });
      if (!isMounted.current) return;
      const raw = res.data?.purchase_requests || res.data?.rows || res.data || [];
      setPRs(Array.isArray(raw) ? raw : []);
    } catch {
      if (!isMounted.current) return;
      setPRs([]);
      showToast('Failed to load purchase requests', 'error');
    } finally { if (isMounted.current) setLoading(false); }
  }, [fStatus]);

  useEffect(() => { load(); }, [load]);

  // Load departments once
  useEffect(() => {
    api.get('/orgchart/departments')
      .then(r => { if (isMounted.current) setDepartments(r.data?.data || r.data || []); })
      .catch(() => { if (isMounted.current) showToast('Could not load departments', 'error'); });
  }, []);

  const handleSubmit = async () => {
    if (!form.items.some(i => i.item_name.trim())) return showToast('Add at least one item', 'error');
    setSubmitting(true);
    try {
      await api.post('/procurement/purchase-requests', form);
      if (!isMounted.current) return;
      showToast('Purchase request created');
      setDrawer(false);
      setForm(emptyForm());
      load();
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e.response?.data?.error || 'Failed to create purchase request', 'error');
    } finally {
      if (isMounted.current) setSubmitting(false);
    }
  };

  const handleApprove = async (id) => {
    if (actioningId) return;
    setActioningId(id);
    try {
      const res = await api.put(`/procurement/purchase-requests/${id}/approve`);
      if (!isMounted.current) return;
      const level = res.data?.approval_level;
      showToast(level === 'auto' ? 'PR auto-approved (below threshold)' : `PR approved (${(level || '').toUpperCase()} level)`);
      load();
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e.response?.data?.error || 'Failed to approve', 'error');
    } finally { if (isMounted.current) setActioningId(null); }
  };

  const handleReject = async (id) => {
    if (actioningId) return;
    setActioningId(id);
    try {
      await api.put(`/procurement/purchase-requests/${id}/reject`);
      if (!isMounted.current) return;
      showToast('Purchase request rejected');
      load();
    } catch {
      if (!isMounted.current) return;
      showToast('Failed to reject', 'error');
    } finally { if (isMounted.current) setActioningId(null); }
  };

  const handleConvertToPO = async (id) => {
    if (actioningId) return;
    setActioningId(id);
    try {
      const res = await api.patch(`/procurement/purchase-requests/${id}/convert-to-po`);
      if (!isMounted.current) return;
      showToast(`PO ${res.data.po_number} created`);
      load();
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e.response?.data?.error || 'Failed to convert to PO', 'error');
    } finally { if (isMounted.current) setActioningId(null); }
  };

  const addItem    = () => setForm(f => ({ ...f, items: [...f.items, emptyItem()] }));
  const removeItem = idx => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  const setItem    = (idx, k, v) => setForm(f => {
    const items = [...f.items];
    items[idx] = { ...items[idx], [k]: v };
    return { ...f, items };
  });
  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const displayed = prs.filter(p => {
    const q = search.toLowerCase();
    return (!q || p.request_number?.toLowerCase().includes(q) || p.requested_by?.toLowerCase().includes(q) || (p.first_name + ' ' + p.last_name).toLowerCase().includes(q) || p.department?.toLowerCase().includes(q))
        && (!fStatus || p.status === fStatus);
  });

  const counts = STATUSES.reduce((acc, s) => { acc[s] = prs.filter(p => p.status === s).length; return acc; }, {});
  const lineTotal = form.items.reduce((s, i) => s + (parseFloat(i.quantity) || 0) * (parseFloat(i.expected_price) || 0), 0);

  return (
    <div className="pr-root">
      {toast && <div className={`pr-toast pr-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="pr-header">
        <div>
          <h2 className="pr-title">Purchase Requests</h2>
          <p className="pr-sub">{displayed.length} request{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="pr-header-r">
          <button className="pr-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="pr-icon-btn" title="Export CSV"
            onClick={async () => {
              try {
                const r = await api.get('/procurement/purchase-requests/export', { responseType: 'blob' });
                const url = URL.createObjectURL(r.data);
                const a = document.createElement('a');
                a.href = url;
                a.download = `purchase-requests-${new Date().toISOString().slice(0,10)}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              } catch { showToast('Export failed', 'error'); }
            }}>
            ↓ Export
          </button>
          <button className="pr-btn-primary" onClick={() => { setForm(emptyForm()); setDrawer(true); }}>
            <Plus size={14} /> New Request
          </button>
        </div>
      </div>

      <div className="pr-filters">
        <div className="pr-search">
          <Search size={14} />
          <input placeholder="Search PR number, requestor…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <div className="pr-tabs">
          <button className={`pr-tab${!fStatus ? ' pr-tab-active' : ''}`} onClick={() => setFStatus('')}>
            All <span className="pr-tab-count">{prs.length}</span>
          </button>
          {['pending_approval', 'approved', 'converted_to_po', 'received'].map(s => (
            <button key={s} className={`pr-tab${fStatus === s ? ' pr-tab-active' : ''}`} onClick={() => setFStatus(s)}>
              {sm(s).label} <span className="pr-tab-count">{counts[s] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="pr-loading"><div className="pr-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="pr-empty">
          <ShoppingCart size={40} color="#d1d5db" />
          <p>No purchase requests found</p>
          <button className="pr-btn-primary" onClick={() => setDrawer(true)}><Plus size={14} /> New Request</button>
        </div>
      ) : (
        <div className="pr-table-wrap">
          <table className="pr-table">
            <thead>
              <tr>
                <th>PR Number</th>
                <th>Request Date</th>
                <th>Requested By</th>
                <th>Dept</th>
                <th>Required By</th>
                <th>Priority</th>
                <th>Est. Value</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(pr => {
                const s  = sm(pr.status);
                const p  = pm(pr.priority);
                const requestorName = pr.requested_by
                  || (pr.first_name ? `${pr.first_name} ${pr.last_name || ''}`.trim() : '—');
                return (
                  <tr key={pr.id} className="pr-row">
                    <td><span className="pr-num">{pr.request_number}</span></td>
                    <td>{pr.request_date ? new Date(pr.request_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td>
                      <div className="pr-req-cell">
                        <div className="pr-avatar">{(requestorName || '?').charAt(0)}</div>
                        {requestorName}
                      </div>
                    </td>
                    <td>{pr.department || '—'}</td>
                    <td>{pr.required_date ? new Date(pr.required_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td>
                      {pr.priority && (
                        <span className="pr-badge" style={{ background: p.bg, color: p.color }}>{p.label}</span>
                      )}
                    </td>
                    <td><span className="pr-amount">{fmt(pr.total_amount)}</span></td>
                    <td><span className="pr-badge" style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
                    <td>
                      <div className="pr-row-actions">
                        {pr.status === 'pending_approval' && (
                          <>
                            <button className="pr-approve-btn" title="Approve" disabled={!!actioningId} onClick={() => handleApprove(pr.id)}><CheckCircle size={14} /></button>
                            <button className="pr-reject-btn" title="Reject"  disabled={!!actioningId} onClick={() => handleReject(pr.id)}><XCircle size={14} /></button>
                          </>
                        )}
                        {pr.status === 'approved' && (
                          <button className="pr-convert-btn" title="Convert to PO" disabled={!!actioningId} onClick={() => handleConvertToPO(pr.id)}>
                            <ArrowRight size={14} /> To PO
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

      {drawer && (
        <div className="pr-overlay" onClick={() => setDrawer(false)}>
          <div className="pr-drawer" onClick={e => e.stopPropagation()}>
            <div className="pr-drawer-hd">
              <h3>New Purchase Request</h3>
              <button className="pr-icon-btn" onClick={() => setDrawer(false)}><X size={16} /></button>
            </div>
            <div className="pr-drawer-body">
              <div className="pr-row2">
                <div className="pr-field">
                  <label>Request Date</label>
                  <input type="date" value={form.request_date} onChange={e => setF('request_date', e.target.value)} />
                </div>
                <div className="pr-field">
                  <label>Required By</label>
                  <input type="date" value={form.required_date} onChange={e => setF('required_date', e.target.value)} />
                </div>
              </div>
              <div className="pr-row2">
                <div className="pr-field">
                  <label>Department</label>
                  <select value={form.department} onChange={e => setF('department', e.target.value)}>
                    <option value="">Select department…</option>
                    {departments.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div className="pr-field">
                  <label>Priority</label>
                  <select value={form.priority} onChange={e => setF('priority', e.target.value)}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
              </div>

              <div className="pr-items-section">
                <div className="pr-items-hd">
                  <span>Items</span>
                  <button className="pr-add-item-btn" onClick={addItem}><Plus size={12} /> Add Item</button>
                </div>
                {form.items.map((item, idx) => (
                  <div key={idx} className="pr-item-row">
                    <div className="pr-field pr-item-name">
                      <label>{idx === 0 ? 'Item Name' : ''}</label>
                      <input value={item.item_name} onChange={e => setItem(idx, 'item_name', e.target.value)} placeholder="Item description…" />
                    </div>
                    <div className="pr-field pr-item-qty">
                      <label>{idx === 0 ? 'Qty' : ''}</label>
                      <input type="number" min="1" value={item.quantity} onChange={e => {
                          const v = parseFloat(e.target.value);
                          setItem(idx, 'quantity', isNaN(v) || v < 0 ? 0 : v);
                        }} />
                    </div>
                    <div className="pr-field pr-item-price">
                      <label>{idx === 0 ? 'Est. Price (₹)' : ''}</label>
                      <input type="number" step="0.01" value={item.expected_price} onChange={e => setItem(idx, 'expected_price', e.target.value)} />
                    </div>
                    <div className="pr-field pr-item-remarks">
                      <label>{idx === 0 ? 'Remarks' : ''}</label>
                      <input value={item.remarks} onChange={e => setItem(idx, 'remarks', e.target.value)} placeholder="Optional…" />
                    </div>
                    {form.items.length > 1 && (
                      <button className="pr-remove-btn" onClick={() => removeItem(idx)} style={{ marginTop: idx === 0 ? 22 : 0 }}><Trash2 size={13} /></button>
                    )}
                  </div>
                ))}
                <div className="pr-total">
                  <span>Estimated Total</span>
                  <strong>{fmt(lineTotal)}</strong>
                </div>
              </div>

              <div className="pr-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setF('notes', e.target.value)} placeholder="Additional notes or justification…" />
              </div>
            </div>
            <div className="pr-drawer-ft">
              <button className="pr-btn-outline" onClick={() => setDrawer(false)}>Cancel</button>
              <button className="pr-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Submitting…' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
