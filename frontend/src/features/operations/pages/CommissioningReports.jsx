import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, ClipboardCheck, CheckSquare, Square, Search } from 'lucide-react';

const STATUS_COLOR = {
  open:        { bg: '#fef3c7', color: '#92400e' },
  in_progress: { bg: '#dbeafe', color: '#1e40af' },
  completed:   { bg: '#d1fae5', color: '#065f46' },
  failed:      { bg: '#fee2e2', color: '#991b1b' },
};

const DEFAULT_CHECKLIST = [
  'Equipment installed at site',
  'Power connections verified',
  'Functional test completed',
  'Safety checks done',
  'Customer sign-off obtained',
  'Documentation handed over',
];

const EMPTY_FORM = {
  lifecycle_instance_id: '',
  sales_order_id: '',
  site_name: '',
  site_address: '',
  commissioning_date: '',
  engineer_name: '',
  status: 'open',
  checklist: DEFAULT_CHECKLIST.map(item => ({ item, checked: false })),
  punch_points: [],
  remarks: '',
};

export default function CommissioningReports() {
  const [reports, setReports]     = useState([]);
  const [loading, setLoading]     = useState(false);
  const [showForm, setShowForm]   = useState(false);
  const [form, setForm]           = useState(EMPTY_FORM);
  const [saving, setSaving]       = useState(false);
  const [search, setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [newPunch, setNewPunch]   = useState('');
  const [editingId, setEditingId] = useState(null);
  const isMounted = useRef(true);
  const toast = useToast();

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const load = () => {
    setLoading(true);
    const params = {};
    if (statusFilter !== 'All') params.status = statusFilter;
    api.get('/lifecycle/commissioning', { params })
      .then(r => { if (isMounted.current) setReports(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (isMounted.current) setReports([]); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  };
  useEffect(() => { load(); }, [statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleChecklist = (i) => setForm(p => ({
    ...p,
    checklist: p.checklist.map((c, idx) => idx === i ? { ...c, checked: !c.checked } : c),
  }));

  const addPunch = () => {
    if (!newPunch.trim()) return;
    setForm(p => ({ ...p, punch_points: [...p.punch_points, { point: newPunch.trim(), resolved: false }] }));
    setNewPunch('');
  };

  const togglePunch = (i) => setForm(p => ({
    ...p,
    punch_points: p.punch_points.map((pp, idx) => idx === i ? { ...pp, resolved: !pp.resolved } : pp),
  }));

  const handleSave = async () => {
    if (!form.site_name || !form.commissioning_date) {
      toast.error('Site name and commissioning date are required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        lifecycle_instance_id: form.lifecycle_instance_id ? Number(form.lifecycle_instance_id) : null,
        sales_order_id: form.sales_order_id ? Number(form.sales_order_id) : null,
      };
      if (editingId) {
        await api.put(`/lifecycle/commissioning/${editingId}`, payload);
        toast.success('Commissioning report updated');
      } else {
        await api.post('/lifecycle/commissioning', payload);
        toast.success('Commissioning report created');
      }
      setShowForm(false);
      setForm(EMPTY_FORM);
      setEditingId(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
    } finally { if (isMounted.current) setSaving(false); }
  };

  const openEdit = async (id) => {
    try {
      const r = await api.get(`/lifecycle/commissioning/${id}`);
      const d = r.data;
      setForm({
        lifecycle_instance_id: d.lifecycle_instance_id || '',
        sales_order_id: d.sales_order_id || '',
        site_name: d.site_name || '',
        site_address: d.site_address || '',
        commissioning_date: (d.commissioning_date || '').slice(0, 10),
        engineer_name: d.engineer_name || '',
        status: d.status || 'open',
        checklist: Array.isArray(d.checklist) ? d.checklist : DEFAULT_CHECKLIST.map(item => ({ item, checked: false })),
        punch_points: Array.isArray(d.punch_points) ? d.punch_points : [],
        remarks: d.remarks || '',
      });
      setEditingId(id);
      setShowForm(true);
    } catch {
      toast.error('Failed to load report details');
    }
  };

  const filtered = reports.filter(r =>
    !search || [r.site_name, r.engineer_name, r.lifecycle_number, r.order_number].some(v => (v || '').toLowerCase().includes(search.toLowerCase()))
  );

  const completedItems = (r) => {
    if (!Array.isArray(r.checklist)) return '—';
    const done = r.checklist.filter(c => c.checked).length;
    return `${done}/${r.checklist.length}`;
  };

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Commissioning Reports</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>{reports.length} reports · {reports.filter(r => r.status === 'completed').length} completed</p>
        </div>
        <button onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15} /> New Report
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search site, engineer, lifecycle..."
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
        </div>
        {['All', 'open', 'in_progress', 'completed', 'failed'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer',
              borderColor: statusFilter === s ? '#6B3FDB' : '#e5e7eb', background: statusFilter === s ? '#6B3FDB' : '#fff', color: statusFilter === s ? '#fff' : '#374151' }}>
            {s === 'All' ? 'All' : s.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
          </button>
        ))}
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            <ClipboardCheck size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
            <p style={{ margin: '0 0 16px' }}>No commissioning reports found</p>
            <button onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); }} style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Create First Report</button>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Site', 'Lifecycle / SO', 'Engineer', 'Date', 'Checklist', 'Punch Points', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const sc = STATUS_COLOR[r.status] || STATUS_COLOR.open;
                const punches = Array.isArray(r.punch_points) ? r.punch_points : [];
                const unresolvedPunches = punches.filter(p => !p.resolved).length;
                return (
                  <tr key={r.id || i} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 16px', fontWeight: 600, color: '#1f2937' }}>
                      <div>{r.site_name || '—'}</div>
                      {r.site_address && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{r.site_address}</div>}
                    </td>
                    <td style={{ padding: '10px 16px', color: '#6b7280', fontSize: 12 }}>
                      {r.lifecycle_number && <div style={{ color: '#6B3FDB', fontWeight: 600 }}>{r.lifecycle_number}</div>}
                      {r.order_number && <div>SO: {r.order_number}</div>}
                      {!r.lifecycle_number && !r.order_number && '—'}
                    </td>
                    <td style={{ padding: '10px 16px', color: '#374151' }}>{r.engineer_name || 'Unassigned'}</td>
                    <td style={{ padding: '10px 16px', color: '#374151', whiteSpace: 'nowrap' }}>
                      {(r.commissioning_date || '').slice(0, 10) || '—'}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ background: '#ede9fe', color: '#6B3FDB', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                        {completedItems(r)}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {unresolvedPunches > 0 ? (
                        <span style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                          {unresolvedPunches} open
                        </span>
                      ) : (
                        <span style={{ color: '#9ca3af', fontSize: 11 }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                        {r.status.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <button onClick={() => openEdit(r.id)}
                        style={{ padding: '4px 10px', background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 600, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                {editingId ? 'Edit Commissioning Report' : 'New Commissioning Report'}
              </h2>
              <button onClick={() => { setShowForm(false); setEditingId(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Site Name *</label>
                <input value={form.site_name} onChange={e => setForm(p => ({ ...p, site_name: e.target.value }))} placeholder="Customer / Site name"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Site Address</label>
                <input value={form.site_address} onChange={e => setForm(p => ({ ...p, site_address: e.target.value }))} placeholder="Full installation address"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Commissioning Date *</label>
                <input type="date" value={form.commissioning_date} onChange={e => setForm(p => ({ ...p, commissioning_date: e.target.value }))}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Engineer Name</label>
                <input value={form.engineer_name} onChange={e => setForm(p => ({ ...p, engineer_name: e.target.value }))} placeholder="Commissioning engineer"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Lifecycle Instance ID</label>
                <input type="number" value={form.lifecycle_instance_id} onChange={e => setForm(p => ({ ...p, lifecycle_instance_id: e.target.value }))} placeholder="Optional"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Status</label>
                <select value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}>
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                </select>
              </div>
            </div>

            {/* Checklist */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Commissioning Checklist</label>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                {form.checklist.map((c, i) => (
                  <div key={i} onClick={() => toggleChecklist(i)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer',
                      background: c.checked ? '#f0fdf4' : '#fff', borderBottom: i < form.checklist.length - 1 ? '1px solid #f0f0f4' : 'none' }}>
                    {c.checked ? <CheckSquare size={16} color="#10b981" /> : <Square size={16} color="#9ca3af" />}
                    <span style={{ fontSize: 13, color: c.checked ? '#065f46' : '#374151', textDecoration: c.checked ? 'line-through' : 'none' }}>{c.item}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Punch Points */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
                Punch Points ({form.punch_points.filter(p => !p.resolved).length} open)
              </label>
              {form.punch_points.length > 0 && (
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
                  {form.punch_points.map((pp, i) => (
                    <div key={i} onClick={() => togglePunch(i)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', cursor: 'pointer',
                        background: pp.resolved ? '#f0fdf4' : '#fff', borderBottom: i < form.punch_points.length - 1 ? '1px solid #f0f0f4' : 'none' }}>
                      {pp.resolved ? <CheckSquare size={14} color="#10b981" /> : <Square size={14} color="#ef4444" />}
                      <span style={{ fontSize: 12, color: pp.resolved ? '#6b7280' : '#374151', flex: 1, textDecoration: pp.resolved ? 'line-through' : 'none' }}>{pp.point}</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={newPunch} onChange={e => setNewPunch(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addPunch()}
                  placeholder="Add punch point..."
                  style={{ flex: 1, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, outline: 'none' }} />
                <button onClick={addPunch} style={{ padding: '8px 14px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Add</button>
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Remarks</label>
              <textarea value={form.remarks} onChange={e => setForm(p => ({ ...p, remarks: e.target.value }))} rows={3} placeholder="Additional notes..."
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowForm(false); setEditingId(null); }} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.site_name || !form.commissioning_date}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving...' : editingId ? 'Update Report' : 'Create Report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
