import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/context/AuthContext';
import { Plus, X, Search, Receipt, Link, ChevronRight, CheckCircle, Clock, AlertCircle } from 'lucide-react';
import { fmt } from './travelUtils';

const EXPENSE_TYPES = [
  {
    group: 'Travel',
    items: ['Flight', 'Train', 'Metro', 'Bus', 'Taxi', 'Cab', 'Fuel', 'Toll', 'Parking'],
  },
  {
    group: 'Accommodation',
    items: ['Hotel', 'Guest House', 'Lodging'],
  },
  {
    group: 'Food',
    items: ['Breakfast', 'Lunch', 'Dinner'],
  },
  {
    group: 'Customer',
    items: ['Meeting Expense', 'Entertainment'],
  },
  {
    group: 'Site',
    items: ['Consumables', 'Tools', 'Miscellaneous'],
  },
];

const STATUS_STEPS = [
  { key: 'Draft',            label: 'Draft' },
  { key: 'Submitted',        label: 'Submitted' },
  { key: 'Manager Approved', label: 'Manager Approved' },
  { key: 'Accounts Verified',label: 'Accounts Verified' },
  { key: 'Mgmt Approved',    label: 'Mgmt Approved' },
  { key: 'Paid',             label: 'Paid' },
];

const STATUS_COLOR = {
  'Draft':              { bg: '#f3f4f6', color: '#6b7280' },
  'Submitted':          { bg: '#fef3c7', color: '#92400e' },
  'Manager Approved':   { bg: '#dbeafe', color: '#1e40af' },
  'Manager Rejected':   { bg: '#fee2e2', color: '#991b1b' },
  'Accounts Verified':  { bg: '#d1fae5', color: '#065f46' },
  'Accounts Rejected':  { bg: '#fee2e2', color: '#991b1b' },
  'Mgmt Approved':      { bg: '#ede9fe', color: '#5b21b6' },
  'Mgmt Rejected':      { bg: '#fee2e2', color: '#991b1b' },
  'Paid':               { bg: '#d1fae5', color: '#065f46' },
  'Closed':             { bg: '#e5e7eb', color: '#374151' },
};

const EMPTY = {
  travel_request_id: '', employee_id: '', employee_name: '', department: '',
  customer_name: '', project_number: '', site_name: '', po_number: '',
  expense_date: '', expense_type: 'Travel', expense_category: 'Flight',
  amount: '', gst_amount: '', remarks: '',
  bill_number: '', google_drive_link: '', vendor_name: '',
  borne_by: 'company',
};

const inp = { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fff' };
const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 };

function StatusBadge({ status }) {
  const sc = STATUS_COLOR[status] || { bg: '#f3f4f6', color: '#374151' };
  return (
    <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {status}
    </span>
  );
}

function WorkflowStepper({ status }) {
  const current = STATUS_STEPS.findIndex(s => s.key === status);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
      {STATUS_STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        const rejected = status?.includes('Rejected') && i === current;
        const color = rejected ? '#ef4444' : done || active ? '#10b981' : '#d1d5db';
        return (
          <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: color,
              border: active ? `2px solid ${color}` : 'none',
            }} />
            <span style={{ fontSize: 10, color: active ? '#1f2937' : done ? '#6b7280' : '#9ca3af', fontWeight: active ? 600 : 400 }}>
              {step.label}
            </span>
            {i < STATUS_STEPS.length - 1 && (
              <ChevronRight size={10} color={done ? '#10b981' : '#d1d5db'} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function ExpenseClaims() {
  const toast = useToast();
  const { user, hasAnyRole } = useAuth();
  const [claims,    setClaims]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [showForm,  setShowForm]  = useState(false);
  const [form,      setForm]      = useState(EMPTY);
  const [saving,    setSaving]    = useState(false);
  const [search,    setSearch]    = useState('');
  const [statusTab, setStatusTab] = useState('All');
  const [selected,  setSelected]  = useState(null);
  const [requests,  setRequests]  = useState([]);
  const [policyInfo, setPolicyInfo] = useState(null);
  const [checkingPolicy, setCheckingPolicy] = useState(false);
  const [deptList,  setDeptList]  = useState([]);

  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid the approval/settlement actions from anyone
  // holding manager/finance as a secondary role. See AuthContext.
  const isManager  = hasAnyRole('admin', 'super_admin', 'manager', 'hr');
  const isAccounts = hasAnyRole('admin', 'super_admin', 'finance');
  const isAdmin    = hasAnyRole('admin', 'super_admin');

  const load = useCallback(() => {
    setLoading(true);
    api.get('/reimbursement/claims', { params: { limit: 200 } })
      .then(r => setClaims(Array.isArray(r.data) ? r.data : []))
      .catch(() => setClaims([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    api.get('/travel/requests', { params: { limit: 100 } })
      .then(r => setRequests(Array.isArray(r.data) ? r.data : []))
      .catch(() => toast.error('Could not load travel requests'));
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, [load]);

  // Category items based on selected expense_type
  const categoryItems = EXPENSE_TYPES.find(g => g.group === form.expense_type)?.items || [];

  const fld = (key, val) => {
    setForm(p => {
      const next = { ...p, [key]: val };
      if (key === 'expense_type') next.expense_category = EXPENSE_TYPES.find(g => g.group === val)?.items[0] || '';
      return next;
    });
  };

  // Policy check when amount or expense_type changes
  useEffect(() => {
    if (!form.employee_id || !form.amount || !form.expense_type) { setPolicyInfo(null); return; }
    const t = setTimeout(async () => {
      setCheckingPolicy(true);
      try {
        const r = await api.post('/travel-policy/check', {
          employee_id: form.employee_id,
          expense_type: form.expense_type,
          amount: form.amount,
        });
        setPolicyInfo(r.data);
      } catch { setPolicyInfo(null); }
      finally { setCheckingPolicy(false); }
    }, 600);
    return () => clearTimeout(t);
  }, [form.employee_id, form.amount, form.expense_type]);

  const totalAmount = (Number(form.amount) || 0) + (Number(form.gst_amount) || 0);

  const handleSave = async () => {
    if (!form.expense_date || !form.expense_type || !form.expense_category || !form.amount) {
      toast.error('Date, Expense Type, Category, and Amount are required.'); return;
    }
    setSaving(true);
    try {
      await api.post('/reimbursement/claims', {
        ...form,
        amount: Number(form.amount) || 0,
        gst_amount: Number(form.gst_amount) || 0,
        total_amount: totalAmount,
        over_policy: policyInfo ? !policyInfo.within_policy : false,
      });
      toast.success('Expense claim created');
      setShowForm(false); setForm(EMPTY); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save claim');
    } finally { setSaving(false); }
  };

  const handleSubmit = async (id) => {
    try {
      await api.post(`/reimbursement/claims/${id}/submit`);
      toast.success('Claim submitted for approval');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Submit failed'); }
  };

  const handleManagerApprove = async (id, status, remarks = '') => {
    try {
      await api.put(`/reimbursement/claims/${id}/manager-approve`, { status, remarks });
      toast.success(`Manager ${status}`);
      setSelected(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Action failed'); }
  };

  const handleAccountsVerify = async (id, status, data = {}) => {
    try {
      await api.put(`/reimbursement/claims/${id}/accounts-verify`, { status, ...data });
      toast.success(`Accounts ${status}`);
      setSelected(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Action failed'); }
  };

  const handleMgmtApprove = async (id, status, remarks = '') => {
    try {
      await api.put(`/reimbursement/claims/${id}/mgmt-approve`, { status, remarks });
      toast.success(`Management ${status}`);
      setSelected(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Action failed'); }
  };

  const filtered = claims.filter(c => {
    if (statusTab !== 'All' && c.status !== statusTab) return false;
    if (!search) return true;
    return [c.claim_number, c.employee_name, c.customer_name, c.project_number,
            c.expense_type, c.expense_category, c.po_number]
      .some(v => (v || '').toLowerCase().includes(search.toLowerCase()));
  });

  const totalPending = claims.filter(c => !['Paid','Closed'].includes(c.status) && !c.status?.includes('Rejected')).reduce((s, c) => s + Number(c.total_amount || 0), 0);
  const totalPaid = claims.filter(c => c.status === 'Paid').reduce((s, c) => s + Number(c.total_amount || 0), 0);
  const overPolicy = claims.filter(c => c.over_policy).length;

  const statuses = ['All', 'Draft', 'Submitted', 'Manager Approved', 'Accounts Verified', 'Mgmt Approved', 'Paid'];

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Expense Claims</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            Travel expense reimbursement management
          </p>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15} /> New Claim
        </button>
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Total Claims',    value: claims.length,         color: '#6366f1' },
          { label: 'Pending Amount',  value: fmt(totalPending),     color: '#f59e0b', isText: true },
          { label: 'Reimbursed',      value: fmt(totalPaid),        color: '#10b981', isText: true },
          { label: 'Over Policy',     value: overPolicy,            color: '#ef4444' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 12, padding: '16px 20px', border: '1px solid #f0f0f4' }}>
            <div style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', marginBottom: 6, letterSpacing: '0.5px' }}>{k.label}</div>
            <div style={{ fontSize: k.isText ? 18 : 28, fontWeight: 700, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search claim #, employee, customer, project..."
            style={{ ...inp, paddingLeft: 32 }} />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {statuses.map(s => (
            <button key={s} onClick={() => setStatusTab(s)}
              style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid', fontSize: 11, fontWeight: 500, cursor: 'pointer',
                borderColor: statusTab === s ? '#6B3FDB' : '#e5e7eb',
                background: statusTab === s ? '#6B3FDB' : '#fff',
                color: statusTab === s ? '#fff' : '#374151', whiteSpace: 'nowrap' }}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Claims table */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
            <Receipt size={36} color="#d1d5db" style={{ marginBottom: 10 }} />
            <p style={{ margin: 0 }}>No expense claims found</p>
            <button onClick={() => setShowForm(true)}
              style={{ marginTop: 12, padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
              Add First Claim
            </button>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Claim #', 'Employee', 'Category', 'Customer / Project', 'Date', 'Amount', 'GST', 'Total', 'Bill', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={c.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '10px 14px', fontWeight: 600, color: '#6B3FDB', whiteSpace: 'nowrap' }}>{c.claim_number}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ fontWeight: 500, color: '#1f2937' }}>{c.employee_name || '—'}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.department}</div>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ fontWeight: 500, color: '#374151' }}>{c.expense_type}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.expense_category}</div>
                  </td>
                  <td style={{ padding: '10px 14px', color: '#6b7280', maxWidth: 140 }}>
                    {c.customer_name && <div style={{ fontWeight: 500, color: '#374151', fontSize: 12 }}>{c.customer_name}</div>}
                    {c.project_number && <div style={{ fontSize: 11 }}>{c.project_number}</div>}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#6b7280', whiteSpace: 'nowrap' }}>{c.expense_date?.slice(0,10)}</td>
                  <td style={{ padding: '10px 14px', color: '#374151', fontWeight: 500 }}>{fmt(c.amount)}</td>
                  <td style={{ padding: '10px 14px', color: '#f59e0b' }}>{fmt(c.gst_amount || 0)}</td>
                  <td style={{ padding: '10px 14px', color: '#10b981', fontWeight: 600 }}>{fmt(c.total_amount || c.amount)}</td>
                  <td style={{ padding: '10px 14px' }}>
                    {c.google_drive_link
                      ? <a href={c.google_drive_link} target="_blank" rel="noopener noreferrer" style={{ color: '#6366f1', fontSize: 11, textDecoration: 'none' }}>
                          <Link size={12} style={{ verticalAlign: 'middle', marginRight: 2 }} />View
                        </a>
                      : <span style={{ color: '#d1d5db', fontSize: 11 }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <StatusBadge status={c.status} />
                    {c.over_policy && (
                      <div style={{ fontSize: 10, color: '#ef4444', marginTop: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
                        <AlertCircle size={10} /> Over Policy
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => setSelected(c)}
                        style={{ padding: '4px 10px', background: '#f5f3ff', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                        View
                      </button>
                      {c.status === 'Draft' && (
                        <button onClick={() => handleSubmit(c.id)}
                          style={{ padding: '4px 10px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                          Submit
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail / Approval modal */}
      {selected && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 640, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>{selected.claim_number}</h2>
                <StatusBadge status={selected.status} />
              </div>
              <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>

            <WorkflowStepper status={selected.status} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13, marginTop: 20 }}>
              {[
                ['Employee', selected.employee_name],
                ['Department', selected.department],
                ['Expense Type', selected.expense_type],
                ['Category', selected.expense_category],
                ['Date', selected.expense_date?.slice(0,10)],
                ['Amount', fmt(selected.amount)],
                ['GST', fmt(selected.gst_amount || 0)],
                ['Total', fmt(selected.total_amount || selected.amount)],
                ['Customer', selected.customer_name],
                ['Project #', selected.project_number],
                ['Site', selected.site_name],
                ['PO Number', selected.po_number],
                ['Bill #', selected.bill_number],
                ['Cost Type', selected.cost_type],
                ['Over Policy', selected.over_policy ? `Yes — ${selected.over_policy_reason || ''}` : 'No'],
                ['GST Verified', selected.gst_verified ? 'Yes' : '—'],
              ].filter(([, v]) => v).map(([label, value]) => (
                <div key={label}>
                  <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontWeight: 500, color: '#1f2937' }}>{value}</div>
                </div>
              ))}
            </div>

            {selected.remarks && (
              <div style={{ marginTop: 16, padding: 12, background: '#f9fafb', borderRadius: 8, fontSize: 13 }}>
                <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, marginBottom: 4 }}>REMARKS</div>
                {selected.remarks}
              </div>
            )}

            {selected.google_drive_link && (
              <a href={selected.google_drive_link} target="_blank" rel="noopener noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, padding: '8px 14px', background: '#ede9fe', color: '#5b21b6', borderRadius: 8, fontSize: 12, textDecoration: 'none', fontWeight: 600 }}>
                <Link size={13} /> View Bill on Google Drive
              </a>
            )}

            {/* Action buttons based on status and role */}
            <div style={{ marginTop: 24, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {isManager && selected.status === 'Submitted' && (
                <>
                  <button onClick={() => handleManagerApprove(selected.id, 'Approved')}
                    style={{ padding: '9px 18px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    Approve
                  </button>
                  <button onClick={() => handleManagerApprove(selected.id, 'Rejected', 'Rejected by manager')}
                    style={{ padding: '9px 18px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    Reject
                  </button>
                </>
              )}
              {isAccounts && selected.status === 'Manager Approved' && (
                <>
                  <button onClick={() => handleAccountsVerify(selected.id, 'Approved', { gst_verified: true, bill_match_verified: true, duplicate_checked: true })}
                    style={{ padding: '9px 18px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    Accounts Verify
                  </button>
                  <button onClick={() => handleAccountsVerify(selected.id, 'Rejected', { remarks: 'Bill mismatch / GST issue' })}
                    style={{ padding: '9px 18px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    Reject
                  </button>
                </>
              )}
              {isAdmin && selected.status === 'Accounts Verified' && (
                <>
                  <button onClick={() => handleMgmtApprove(selected.id, 'Approved')}
                    style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    Management Approve
                  </button>
                  <button onClick={() => handleMgmtApprove(selected.id, 'Rejected')}
                    style={{ padding: '9px 18px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    Reject
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* New Claim Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 720, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>New Expense Claim</h2>
              <button onClick={() => { setShowForm(false); setForm(EMPTY); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>

            {/* Employee & Commercial Linkage */}
            <div style={{ fontSize: 12, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>Employee & Commercial</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
              <div>
                <label style={lbl}>Employee Name</label>
                <input value={form.employee_name} onChange={e => fld('employee_name', e.target.value)} placeholder="Your name" style={inp} />
              </div>
              <div>
                <label style={lbl}>Department</label>
                <select value={form.department} onChange={e => fld('department', e.target.value)} style={inp}>
                  <option value="">-- Select Department --</option>
                  {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Linked Travel Request</label>
                <select value={form.travel_request_id} onChange={e => fld('travel_request_id', e.target.value)} style={inp}>
                  <option value="">— None —</option>
                  {requests.map(r => (
                    <option key={r.id} value={r.id}>TR-{String(r.id).padStart(3,'0')} — {r.destination || r.purpose}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={lbl}>Customer</label>
                <input value={form.customer_name} onChange={e => fld('customer_name', e.target.value)} placeholder="Customer name" style={inp} />
              </div>
              <div>
                <label style={lbl}>Project Number</label>
                <input value={form.project_number} onChange={e => fld('project_number', e.target.value)} placeholder="PRJ-2026-0001" style={inp} />
              </div>
              <div>
                <label style={lbl}>Site Name</label>
                <input value={form.site_name} onChange={e => fld('site_name', e.target.value)} placeholder="Site / location" style={inp} />
              </div>
              <div>
                <label style={lbl}>PO Number</label>
                <input value={form.po_number} onChange={e => fld('po_number', e.target.value)} placeholder="Purchase order #" style={inp} />
              </div>
            </div>

            {/* Expense Details */}
            <div style={{ fontSize: 12, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>Expense Details</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div>
                <label style={lbl}>Expense Type *</label>
                <select value={form.expense_type} onChange={e => fld('expense_type', e.target.value)} style={inp}>
                  {EXPENSE_TYPES.map(g => <option key={g.group} value={g.group}>{g.group}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Category *</label>
                <select value={form.expense_category} onChange={e => fld('expense_category', e.target.value)} style={inp}>
                  {categoryItems.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Expense Date *</label>
                <input type="date" value={form.expense_date} onChange={e => fld('expense_date', e.target.value)} style={inp} />
              </div>
              <div>
                <label style={lbl}>Vendor / Payee</label>
                <input value={form.vendor_name} onChange={e => fld('vendor_name', e.target.value)} placeholder="Hotel name, airline, etc." style={inp} />
              </div>
              <div>
                <label style={lbl}>Base Amount (₹) *</label>
                <input type="number" value={form.amount} onChange={e => fld('amount', e.target.value)} placeholder="0.00" style={inp} />
              </div>
              <div>
                <label style={lbl}>GST Amount (₹)</label>
                <input type="number" value={form.gst_amount} onChange={e => fld('gst_amount', e.target.value)} placeholder="0.00" style={inp} />
              </div>
              <div>
                <label style={lbl}>Borne By *</label>
                <select value={form.borne_by} onChange={e => fld('borne_by', e.target.value)} style={inp}>
                  <option value="company">Company — reimbursable</option>
                  <option value="personal">Personal — not reimbursable</option>
                </select>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                  {form.borne_by === 'personal'
                    ? 'Counts toward the trip total but will not be paid out.'
                    : 'Included in the amount payable to the employee.'}
                </div>
              </div>

              {/* Policy warning */}
              {policyInfo && !policyInfo.within_policy && (
                <div style={{ gridColumn: '1/-1', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <AlertCircle size={16} color="#f97316" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ fontSize: 12 }}>
                    <div style={{ fontWeight: 600, color: '#c2410c' }}>Over Policy Limit</div>
                    <div style={{ color: '#9a3412' }}>Policy limit: {fmt(policyInfo.policy_limit)} | Your claim: {fmt(form.amount)}</div>
                  </div>
                </div>
              )}
              {policyInfo?.within_policy && form.amount && (
                <div style={{ gridColumn: '1/-1', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '8px 14px', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <CheckCircle size={14} color="#16a34a" />
                  <span style={{ fontSize: 12, color: '#166534' }}>Within policy limit of {fmt(policyInfo.policy_limit)}</span>
                </div>
              )}

              {totalAmount > 0 && (
                <div style={{ gridColumn: '1/-1', background: '#f5f3ff', borderRadius: 8, padding: '10px 14px', display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Total Claim Amount</span>
                  <span style={{ fontSize: 18, fontWeight: 700, color: '#6B3FDB' }}>{fmt(totalAmount)}</span>
                </div>
              )}

              <div style={{ gridColumn: '1/-1' }}>
                <label style={lbl}>Bill Number / Receipt Ref</label>
                <input value={form.bill_number} onChange={e => fld('bill_number', e.target.value)} placeholder="INV-2026-001" style={inp} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={lbl}>Google Drive Bill Link</label>
                <div style={{ position: 'relative' }}>
                  <Link size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                  <input value={form.google_drive_link} onChange={e => fld('google_drive_link', e.target.value)}
                    placeholder="https://drive.google.com/..."
                    style={{ ...inp, paddingLeft: 32 }} />
                </div>
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={lbl}>Remarks</label>
                <textarea value={form.remarks} onChange={e => fld('remarks', e.target.value)} rows={2}
                  placeholder="Purpose, context, or notes for this expense..."
                  style={{ ...inp, resize: 'vertical' }} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 24 }}>
              <button onClick={() => { setShowForm(false); setForm(EMPTY); setPolicyInfo(null); }}
                style={{ padding: '9px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}>Cancel</button>
              <button onClick={handleSave} disabled={saving}
                style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving...' : 'Save Claim'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
