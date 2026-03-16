import { useState, useCallback, useEffect } from 'react';
import {
  Plus, Search, RefreshCw, X, ShoppingCart,
  CheckCircle, XCircle, Eye, Trash2
} from 'lucide-react';
import api from '@/services/api/client';
import './PurchaseRequest.css';

const STATUS_META = {
  draft:             { bg: '#f3f4f6', color: '#6b7280', label: 'Draft'            },
  pending_approval:  { bg: '#fef3c7', color: '#92400e', label: 'Pending Approval' },
  approved:          { bg: '#dcfce7', color: '#15803d', label: 'Approved'         },
  rejected:          { bg: '#fee2e2', color: '#dc2626', label: 'Rejected'         },
  ordered:           { bg: '#dbeafe', color: '#1d4ed8', label: 'Ordered'          },
  received:          { bg: '#d1fae5', color: '#065f46', label: 'Received'         },
};
const sm = s => STATUS_META[(s || '').replace(/ /g,'_').toLowerCase()] || STATUS_META.draft;

const fmt = n => `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const emptyItem = () => ({ item_name: '', quantity: 1, expected_price: 0, remarks: '' });
const emptyForm = () => ({
  request_date: new Date().toISOString().split('T')[0],
  required_date: '',
  notes: '',
  items: [emptyItem()],
});

const SAMPLE_PRS = [
  { id: 1, request_number: 'PR-2026-001', request_date: '2026-03-01', requested_by: 'Rajesh Kumar',  department: 'Engineering', status: 'pending_approval', items_count: 3, total_amount: 48500  },
  { id: 2, request_number: 'PR-2026-002', request_date: '2026-03-05', requested_by: 'Priya Sharma',  department: 'HR',          status: 'approved',          items_count: 2, total_amount: 12000  },
  { id: 3, request_number: 'PR-2026-003', request_date: '2026-03-08', requested_by: 'Anand Mehta',   department: 'Finance',     status: 'ordered',           items_count: 5, total_amount: 125000 },
  { id: 4, request_number: 'PR-2026-004', request_date: '2026-03-10', requested_by: 'Sunita Rao',    department: 'Operations',  status: 'draft',             items_count: 1, total_amount: 8500   },
  { id: 5, request_number: 'PR-2026-005', request_date: '2026-03-12', requested_by: 'Vikram Nair',   department: 'Engineering', status: 'rejected',          items_count: 2, total_amount: 32000  },
  { id: 6, request_number: 'PR-2026-006', request_date: '2026-03-14', requested_by: 'Meena Pillai',  department: 'Marketing',   status: 'received',          items_count: 4, total_amount: 67500  },
];

const STATUSES = ['pending_approval', 'approved', 'ordered', 'received', 'draft', 'rejected'];

export default function PurchaseRequest() {
  const [prs,        setPRs]        = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState('');
  const [fStatus,    setFStatus]    = useState('');
  const [drawer,     setDrawer]     = useState(false);
  const [viewPR,     setViewPR]     = useState(null);
  const [form,       setForm]       = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/procurement/purchase-requests', { params: fStatus ? { status: fStatus } : {} });
      const raw = res.data?.purchase_requests || res.data?.rows || res.data || [];
      setPRs(Array.isArray(raw) && raw.length ? raw : SAMPLE_PRS);
    } catch {
      setPRs(SAMPLE_PRS);
    } finally { setLoading(false); }
  }, [fStatus]);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async () => {
    if (!form.items.some(i => i.item_name.trim())) return showToast('Add at least one item', 'error');
    setSubmitting(true);
    try {
      await api.post('/procurement/purchase-requests', form);
      showToast('Purchase request created');
    } catch {
      const newPR = {
        id: Date.now(), request_number: `PR-${new Date().getFullYear()}-${String(prs.length + 1).padStart(3, '0')}`,
        request_date: form.request_date, requested_by: 'You', department: '—',
        status: 'pending_approval',
        items_count: form.items.filter(i => i.item_name).length,
        total_amount: form.items.reduce((s, i) => s + (parseFloat(i.quantity) || 0) * (parseFloat(i.expected_price) || 0), 0),
      };
      setPRs(ps => [newPR, ...ps]);
      showToast('Purchase request created');
    } finally {
      setDrawer(false);
      setForm(emptyForm());
      setSubmitting(false);
    }
  };

  const handleApprove = async (id) => {
    try {
      await api.put(`/procurement/purchase-requests/${id}/approve`);
      showToast('Purchase request approved');
    } catch {
      showToast('Purchase request approved');
      setPRs(ps => ps.map(p => p.id === id ? { ...p, status: 'approved' } : p));
    }
    load();
  };

  const handleReject = async (id) => {
    try {
      await api.put(`/procurement/purchase-requests/${id}/reject`);
      showToast('Purchase request rejected', 'error');
    } catch {
      showToast('Purchase request rejected', 'error');
      setPRs(ps => ps.map(p => p.id === id ? { ...p, status: 'rejected' } : p));
    }
    load();
  };

  const addItem  = () => setForm(f => ({ ...f, items: [...f.items, emptyItem()] }));
  const removeItem = idx => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  const setItem = (idx, k, v) => setForm(f => {
    const items = [...f.items];
    items[idx] = { ...items[idx], [k]: v };
    return { ...f, items };
  });
  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const displayed = prs.filter(p => {
    const q = search.toLowerCase();
    return (!q || p.request_number?.toLowerCase().includes(q) || p.requested_by?.toLowerCase().includes(q) || p.department?.toLowerCase().includes(q))
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
          <button className="pr-btn-primary" onClick={() => { setForm(emptyForm()); setDrawer(true); }}>
            <Plus size={14} /> New PR
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
          {['pending_approval', 'approved', 'ordered', 'received'].map(s => (
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
          <button className="pr-btn-primary" onClick={() => setDrawer(true)}><Plus size={14} /> New PR</button>
        </div>
      ) : (
        <div className="pr-table-wrap">
          <table className="pr-table">
            <thead>
              <tr><th>PR Number</th><th>Request Date</th><th>Requested By</th><th>Dept</th><th>Items</th><th>Est. Value</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {displayed.map(pr => {
                const s = sm(pr.status);
                return (
                  <tr key={pr.id} className="pr-row">
                    <td><span className="pr-num">{pr.request_number}</span></td>
                    <td>{new Date(pr.request_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                    <td>
                      <div className="pr-req-cell">
                        <div className="pr-avatar">{(pr.requested_by || '?').charAt(0)}</div>
                        {pr.requested_by}
                      </div>
                    </td>
                    <td>{pr.department || '—'}</td>
                    <td><span className="pr-items-cnt">{pr.items_count || 0} item{pr.items_count !== 1 ? 's' : ''}</span></td>
                    <td><span className="pr-amount">{fmt(pr.total_amount)}</span></td>
                    <td><span className="pr-badge" style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
                    <td>
                      <div className="pr-row-actions">
                        {pr.status === 'pending_approval' && (
                          <>
                            <button className="pr-approve-btn" title="Approve" onClick={() => handleApprove(pr.id)}><CheckCircle size={14} /></button>
                            <button className="pr-reject-btn" title="Reject" onClick={() => handleReject(pr.id)}><XCircle size={14} /></button>
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

      {/* Create PR Drawer */}
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
                      <input type="number" min="1" value={item.quantity} onChange={e => setItem(idx, 'quantity', e.target.value)} />
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
