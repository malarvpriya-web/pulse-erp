import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, RefreshCw, FileText, Calendar, AlertCircle, CheckCircle, Clock, Download, RotateCcw, Receipt } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const STATUS_COLOR = {
  active:    { bg: '#d1fae5', color: '#065f46' },
  expired:   { bg: '#fee2e2', color: '#991b1b' },
  draft:     { bg: '#fef3c7', color: '#92400e' },
  cancelled: { bg: '#f3f4f6', color: '#6b7280' },
};

const EMPTY_FORM = {
  lifecycle_instance_id: '', sales_order_id: '',
  start_date: '', end_date: '',
  sla_response_hours: 24, preventive_visits_per_year: 4,
  status: 'active', coverage_notes: '',
  contract_value: '', billing_frequency: 'Annual',
  payment_terms: 'Net 30', serial_number: '',
};

const EMPTY_RENEW = { new_end_date: '', new_value: '', notes: '' };

function fmt(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function daysLeft(endDate) {
  if (!endDate) return null;
  return Math.ceil((new Date(endDate) - new Date()) / 86400000);
}

const inputStyle = { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };

export default function AMCManagement() {
  const [contracts,    setContracts]    = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [showForm,     setShowForm]     = useState(false);
  const [form,         setForm]         = useState(EMPTY_FORM);
  const [saving,       setSaving]       = useState(false);
  const [editingId,    setEditingId]    = useState(null);
  const [statusFilter, setStatusFilter] = useState('All');
  const [genVisits,    setGenVisits]    = useState({});
  const [renewingId,   setRenewingId]   = useState(null);
  const [renewForm,    setRenewForm]    = useState(EMPTY_RENEW);
  const [renewSaving,  setRenewSaving]  = useState(false);
  const [invoicing,    setInvoicing]    = useState({});
  const [renewHistory, setRenewHistory] = useState({ id: null, data: [] });
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);
  const isMounted = useRef(true);
  const toast = useToast();

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const load = () => {
    setLoading(true);
    const params = {};
    if (statusFilter !== 'All') params.status = statusFilter;
    api.get('/lifecycle/amc-contracts', { params })
      .then(r => { if (isMounted.current) setContracts(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (isMounted.current) setContracts([]); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  };

  useEffect(() => { load(); }, [statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!form.start_date || !form.end_date) { toast.error('Start date and end date are required'); return; }
    if (new Date(form.end_date) <= new Date(form.start_date)) { toast.error('End date must be after start date'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        lifecycle_instance_id    : form.lifecycle_instance_id ? Number(form.lifecycle_instance_id) : null,
        sales_order_id           : form.sales_order_id ? Number(form.sales_order_id) : null,
        sla_response_hours       : Number(form.sla_response_hours),
        preventive_visits_per_year: Number(form.preventive_visits_per_year),
        contract_value           : form.contract_value ? Number(form.contract_value) : null,
      };
      if (editingId) {
        await api.put(`/lifecycle/amc-contracts/${editingId}`, payload);
        toast.success('AMC contract updated');
      } else {
        await api.post('/lifecycle/amc-contracts', payload);
        toast.success('AMC contract created');
      }
      setShowForm(false); setForm(EMPTY_FORM); setEditingId(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
    } finally { if (isMounted.current) setSaving(false); }
  };

  const openEdit = async (id) => {
    try {
      const r = await api.get(`/lifecycle/amc-contracts/${id}`);
      const d = r.data;
      setForm({
        lifecycle_instance_id    : d.lifecycle_instance_id || '',
        sales_order_id           : d.sales_order_id || '',
        start_date               : (d.start_date || '').slice(0, 10),
        end_date                 : (d.end_date || '').slice(0, 10),
        sla_response_hours       : d.sla_response_hours || 24,
        preventive_visits_per_year: d.preventive_visits_per_year || 4,
        status                   : d.status || 'active',
        coverage_notes           : d.coverage_notes || '',
        contract_value           : d.contract_value || '',
        billing_frequency        : d.billing_frequency || 'Annual',
        payment_terms            : d.payment_terms || 'Net 30',
        serial_number            : d.serial_number || '',
      });
      setEditingId(id); setShowForm(true);
    } catch { toast.error('Failed to load contract details'); }
  };

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/lifecycle/amc-contracts/${id}`);
      toast.success('Contract deleted'); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Delete failed'); }
  };

  const generateVisits = async (id) => {
    setGenVisits(p => ({ ...p, [id]: true }));
    try {
      const r = await api.post(`/lifecycle/amc-contracts/${id}/generate-visits`);
      toast.success(`Generated ${r.data.generated} preventive maintenance visits`);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to generate visits'); }
    finally { setGenVisits(p => ({ ...p, [id]: false })); }
  };

  const generateInvoice = async (id) => {
    setInvoicing(p => ({ ...p, [id]: true }));
    try {
      const r = await api.post(`/lifecycle/amc-contracts/${id}/generate-invoice`);
      const inv = r.data.invoice;
      toast.success(`Invoice created — ${fmt(inv.billing_amount)} due ${inv.due_date}`);
    } catch (e) { toast.error(e.response?.data?.error || 'Invoice generation failed'); }
    finally { setInvoicing(p => ({ ...p, [id]: false })); }
  };

  const handleRenew = async () => {
    if (!renewForm.new_end_date) { toast.error('New end date is required'); return; }
    setRenewSaving(true);
    try {
      await api.post(`/lifecycle/amc-contracts/${renewingId}/renew`, {
        new_end_date: renewForm.new_end_date,
        new_value   : renewForm.new_value ? Number(renewForm.new_value) : undefined,
        notes       : renewForm.notes || undefined,
      });
      toast.success('Contract renewed successfully');
      setRenewingId(null); setRenewForm(EMPTY_RENEW); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Renewal failed'); }
    finally { setRenewSaving(false); }
  };

  const viewRenewalHistory = async (id) => {
    try {
      const r = await api.get(`/lifecycle/amc-contracts/${id}/renewals`);
      setRenewHistory({ id, data: r.data || [] });
    } catch { toast.error('Failed to load renewal history'); }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/lifecycle/amc-contracts/export/csv', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url;
      a.download = `amc_contracts_${new Date().toISOString().slice(0,10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch { toast.error('Export failed'); }
  };

  const active   = contracts.filter(c => c.status === 'active').length;
  const expiring = contracts.filter(c => { const d = daysLeft(c.end_date); return c.status === 'active' && d !== null && d >= 0 && d <= 30; }).length;
  const expired  = contracts.filter(c => { const d = daysLeft(c.end_date); return d !== null && d < 0 && c.status === 'active'; }).length;
  const totalARR = contracts.filter(c => c.status === 'active').reduce((s, c) => s + Number(c.contract_value || 0), 0);

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete AMC Contract"
        message="Delete this AMC contract? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>AMC Contract Management</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>Annual Maintenance Contracts — billing, renewals, preventive visits</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleExport}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
            <Download size={14} /> Export
          </button>
          <button onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <Plus size={15} /> New AMC Contract
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Active Contracts', value: active, icon: <CheckCircle size={18} color="#10b981" />, bg: '#d1fae5' },
          { label: 'Expiring ≤30 days', value: expiring, icon: <Clock size={18} color="#f59e0b" />, bg: '#fef3c7' },
          { label: 'Overdue (active past end)', value: expired, icon: <AlertCircle size={18} color="#ef4444" />, bg: '#fee2e2' },
          { label: 'Active ARR', value: fmt(totalARR), icon: <Receipt size={18} color="#6366f1" />, bg: '#e0e7ff' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ background: k.bg, borderRadius: 10, padding: 10 }}>{k.icon}</div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#1f2937' }}>{k.value}</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['All', 'active', 'expired', 'draft', 'cancelled'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer',
              borderColor: statusFilter === s ? '#6B3FDB' : '#e5e7eb',
              background: statusFilter === s ? '#6B3FDB' : '#fff',
              color: statusFilter === s ? '#fff' : '#374151' }}>
            {s === 'All' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        <button onClick={load} style={{ marginLeft: 'auto', padding: '7px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>
          <RefreshCw size={14} color="#9ca3af" />
        </button>
      </div>

      {/* Table */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : contracts.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            <FileText size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
            <p style={{ margin: '0 0 16px' }}>No AMC contracts found</p>
            <button onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); }}
              style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              Create First Contract
            </button>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Contract #', 'Serial / Lifecycle', 'Period', 'Value', 'Billing', 'SLA', 'Renewal', 'Days Left', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {contracts.map((c, i) => {
                const sc  = STATUS_COLOR[c.status] || STATUS_COLOR.draft;
                const dl  = daysLeft(c.end_date);
                const dlColor = dl === null ? '#9ca3af' : dl < 0 ? '#ef4444' : dl <= 30 ? '#f59e0b' : '#10b981';
                const nextRenewalDays = c.next_renewal_date ? daysLeft(c.next_renewal_date) : null;
                return (
                  <tr key={c.id || i} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: '#6B3FDB' }}>{c.contract_number || `AMC-${c.id}`}</td>
                    <td style={{ padding: '10px 12px', fontSize: 12 }}>
                      {c.serial_number && <div style={{ color: '#6366f1', fontFamily: 'monospace', fontWeight: 600 }}>{c.serial_number}</div>}
                      {c.lifecycle_number && <div style={{ color: '#6B3FDB' }}>{c.lifecycle_number}</div>}
                      {c.order_number && <div style={{ color: '#6b7280' }}>SO: {c.order_number}</div>}
                      {!c.serial_number && !c.lifecycle_number && !c.order_number && '—'}
                    </td>
                    <td style={{ padding: '10px 12px', color: '#374151', whiteSpace: 'nowrap', fontSize: 12 }}>
                      <div>{(c.start_date || '').slice(0, 10)}</div>
                      <div style={{ color: '#9ca3af' }}>to {(c.end_date || '').slice(0, 10)}</div>
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: '#1f2937', whiteSpace: 'nowrap' }}>
                      {c.contract_value ? fmt(c.contract_value) : <span style={{ color: '#f59e0b' }}>Not set</span>}
                    </td>
                    <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>
                      <div>{c.billing_frequency || 'Annual'}</div>
                      <div>{c.payment_terms || 'Net 30'}</div>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#374151' }}>{c.sla_response_hours}h</td>
                    <td style={{ padding: '10px 12px', fontSize: 12 }}>
                      {c.next_renewal_date ? (
                        <div style={{ color: nextRenewalDays !== null && nextRenewalDays <= 30 ? '#f59e0b' : '#6b7280' }}>
                          {(c.next_renewal_date || '').slice(0, 10)}
                          {c.renewal_count > 0 && <div style={{ color: '#9ca3af' }}>#{c.renewal_count} renewals</div>}
                        </div>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: dlColor, whiteSpace: 'nowrap' }}>
                      {dl === null ? '—' : dl < 0 ? `${Math.abs(dl)}d overdue` : `${dl}d`}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {c.status.charAt(0).toUpperCase() + c.status.slice(1)}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button onClick={() => openEdit(c.id)}
                          style={{ padding: '3px 8px', background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Edit</button>
                        <button onClick={() => generateVisits(c.id)} disabled={genVisits[c.id]}
                          style={{ padding: '3px 8px', background: '#dbeafe', color: '#1e40af', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                          {genVisits[c.id] ? '...' : 'Visits'}
                        </button>
                        <button onClick={() => generateInvoice(c.id)} disabled={invoicing[c.id]}
                          title="Generate invoice"
                          style={{ padding: '3px 8px', background: '#d1fae5', color: '#065f46', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                          {invoicing[c.id] ? '...' : 'Invoice'}
                        </button>
                        <button onClick={() => { setRenewingId(c.id); setRenewForm({ new_end_date: '', new_value: c.contract_value || '', notes: '' }); }}
                          title="Renew contract"
                          style={{ padding: '3px 8px', background: '#fef3c7', color: '#92400e', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                          Renew
                        </button>
                        <button onClick={() => viewRenewalHistory(c.id)}
                          title="Renewal history"
                          style={{ padding: '3px 8px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11 }}>
                          History
                        </button>
                        <button onClick={() => setPendingHandleDelete(c.id)}
                          style={{ padding: '3px 8px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Del</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Create/Edit Modal ── */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 620, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>{editingId ? 'Edit AMC Contract' : 'New AMC Contract'}</h2>
              <button onClick={() => { setShowForm(false); setEditingId(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
              <div>
                <label style={labelStyle}>Lifecycle Instance ID</label>
                <input type="number" value={form.lifecycle_instance_id} onChange={e => setForm(p => ({ ...p, lifecycle_instance_id: e.target.value }))} placeholder="Optional" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Sales Order ID</label>
                <input type="number" value={form.sales_order_id} onChange={e => setForm(p => ({ ...p, sales_order_id: e.target.value }))} placeholder="Optional" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Serial Number</label>
                <input value={form.serial_number} onChange={e => setForm(p => ({ ...p, serial_number: e.target.value }))} placeholder="e.g. MT-HVDC-001" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Status</label>
                <select value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))} style={inputStyle}>
                  <option value="active">Active</option>
                  <option value="draft">Draft</option>
                  <option value="expired">Expired</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Start Date *</label>
                <input type="date" value={form.start_date} onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>End Date *</label>
                <input type="date" value={form.end_date} onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))} style={inputStyle} />
              </div>

              {/* Billing section */}
              <div>
                <label style={labelStyle}>Contract Value (₹)</label>
                <input type="number" value={form.contract_value} onChange={e => setForm(p => ({ ...p, contract_value: e.target.value }))} placeholder="0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Billing Frequency</label>
                <select value={form.billing_frequency} onChange={e => setForm(p => ({ ...p, billing_frequency: e.target.value }))} style={inputStyle}>
                  {['Annual','Half-Yearly','Quarterly','Monthly'].map(f => <option key={f}>{f}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Payment Terms</label>
                <select value={form.payment_terms} onChange={e => setForm(p => ({ ...p, payment_terms: e.target.value }))} style={inputStyle}>
                  {['Net 30','Net 45','Net 60','Advance','On Delivery'].map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>SLA Response (hours)</label>
                <input type="number" min="1" value={form.sla_response_hours} onChange={e => setForm(p => ({ ...p, sla_response_hours: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Preventive Visits / Year</label>
                <input type="number" min="1" max="24" value={form.preventive_visits_per_year} onChange={e => setForm(p => ({ ...p, preventive_visits_per_year: e.target.value }))} style={inputStyle} />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Coverage Notes</label>
              <textarea value={form.coverage_notes} onChange={e => setForm(p => ({ ...p, coverage_notes: e.target.value }))} rows={3}
                placeholder="Scope of coverage — equipment, parts, labour..."
                style={{ ...inputStyle, resize: 'vertical' }} />
            </div>

            {form.contract_value && form.billing_frequency && (
              <div style={{ background: '#f0fdf4', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: '#065f46' }}>
                Billing amount per invoice: {fmt(
                  form.billing_frequency === 'Quarterly' ? form.contract_value / 4
                  : form.billing_frequency === 'Monthly' ? form.contract_value / 12
                  : form.billing_frequency === 'Half-Yearly' ? form.contract_value / 2
                  : form.contract_value
                )}
              </div>
            )}

            <div style={{ background: '#f5f3ff', borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 12, color: '#5b21b6' }}>
              <strong>Lifecycle gate:</strong> Active AMC contract linked to a lifecycle instance unlocks the service → AMC stage transition.
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowForm(false); setEditingId(null); }}
                style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.start_date || !form.end_date}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (saving || !form.start_date || !form.end_date) ? 0.6 : 1 }}>
                {saving ? 'Saving...' : editingId ? 'Update Contract' : 'Create Contract'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Renew Modal ── */}
      {renewingId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Renew AMC Contract</h2>
              <button onClick={() => setRenewingId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
              <div>
                <label style={labelStyle}>New End Date *</label>
                <input type="date" value={renewForm.new_end_date} onChange={e => setRenewForm(r => ({ ...r, new_end_date: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>New Contract Value (₹)</label>
                <input type="number" value={renewForm.new_value} onChange={e => setRenewForm(r => ({ ...r, new_value: e.target.value }))} placeholder="Leave blank to keep current" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Renewal Notes</label>
                <textarea value={renewForm.notes} onChange={e => setRenewForm(r => ({ ...r, notes: e.target.value }))} rows={3}
                  placeholder="Reason for renewal, changes in scope..."
                  style={{ ...inputStyle, resize: 'none' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setRenewingId(null)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleRenew} disabled={renewSaving || !renewForm.new_end_date}
                style={{ padding: '9px 18px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (renewSaving || !renewForm.new_end_date) ? 0.6 : 1 }}>
                {renewSaving ? 'Renewing...' : 'Confirm Renewal'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Renewal History Modal ── */}
      {renewHistory.id && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 540, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Renewal History</h2>
              <button onClick={() => setRenewHistory({ id: null, data: [] })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            {renewHistory.data.length === 0 ? (
              <p style={{ color: '#9ca3af', textAlign: 'center', padding: '20px 0' }}>No renewals recorded yet.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Date', 'Renewed By', 'Old End', 'New End', 'Value', 'Notes'].map(h => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, borderBottom: '1px solid #f0f0f4' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {renewHistory.data.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                      <td style={{ padding: '8px 10px', color: '#374151' }}>{new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                      <td style={{ padding: '8px 10px', color: '#374151' }}>{r.renewed_by || '—'}</td>
                      <td style={{ padding: '8px 10px', color: '#9ca3af' }}>{(r.old_end_date || '').slice(0, 10)}</td>
                      <td style={{ padding: '8px 10px', color: '#10b981', fontWeight: 600 }}>{(r.new_end_date || '').slice(0, 10)}</td>
                      <td style={{ padding: '8px 10px', color: '#1f2937' }}>{r.new_value ? fmt(r.new_value) : '—'}</td>
                      <td style={{ padding: '8px 10px', color: '#6b7280', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
