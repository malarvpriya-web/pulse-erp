import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, Building, Users, MapPin, Phone, Mail, Power } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const BRANCH_TYPES = ['HQ', 'Factory', 'Warehouse', 'Service Center', 'Sales Office', 'Regional Office'];

const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat',
  'Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh',
  'Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab',
  'Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand',
  'West Bengal','Andaman and Nicobar Islands','Chandigarh','Delhi','Puducherry',
  'Jammu and Kashmir','Ladakh',
];

const TYPE_COLORS = {
  'HQ':             { bg: '#ede9fe', color: '#6B3FDB' },
  'Factory':        { bg: '#dbeafe', color: '#1e40af' },
  'Warehouse':      { bg: '#d1fae5', color: '#065f46' },
  'Service Center': { bg: '#fef3c7', color: '#92400e' },
  'Sales Office':   { bg: '#fee2e2', color: '#991b1b' },
  'Regional Office':{ bg: '#f0fdf4', color: '#166534' },
};

const EMPTY_FORM = {
  name: '', code: '', branch_type: 'HQ',
  city: '', state: '', address: '',
  phone: '', email: '',
};

export default function BranchManagement() {
  const [branches, setBranches] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState(EMPTY_FORM);
  const [saving, setSaving]     = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [pendingDeactivate, setPendingDeactivate] = useState(null);
  const isMounted = useRef(true);
  const toast = useToast();

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const load = () => {
    setLoading(true);
    api.get('/branches')
      .then(r => { if (isMounted.current) setBranches(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (isMounted.current) setBranches([]); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('Branch name is required'); return; }
    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/branches/${editingId}`, form);
        toast.success('Branch updated');
      } else {
        await api.post('/branches', form);
        toast.success('Branch created');
      }
      setShowForm(false);
      setForm(EMPTY_FORM);
      setEditingId(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
    } finally { if (isMounted.current) setSaving(false); }
  };

  const openEdit = (branch) => {
    setForm({
      name: branch.name || '',
      code: branch.code || '',
      branch_type: branch.branch_type || 'HQ',
      city: branch.city || '',
      state: branch.state || '',
      address: branch.address || '',
      phone: branch.phone || '',
      email: branch.email || '',
    });
    setEditingId(branch.id);
    setShowForm(true);
  };

  const handleDeactivate = async () => {
    if (!pendingDeactivate) return;
    const { id, name } = pendingDeactivate;
    setPendingDeactivate(null);
    try {
      await api.delete(`/branches/${id}`);
      toast.success(`Branch "${name}" deactivated`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to deactivate');
    }
  };

  const active   = branches.filter(b => b.is_active !== false);
  const inactive = branches.filter(b => b.is_active === false);

  const set = field => e => setForm(p => ({ ...p, [field]: e.target.value }));

  const inp = (label, field, type = 'text', required = false) => (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
        {label}{required && <span style={{ color: '#ef4444' }}> *</span>}
      </label>
      <input type={type} value={form[field]} onChange={set(field)}
        style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
    </div>
  );

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!pendingDeactivate}
        title="Deactivate Branch"
        message={pendingDeactivate ? `Deactivate branch "${pendingDeactivate.name}"?` : ''}
        confirmLabel="Deactivate"
        variant="warning"
        onConfirm={handleDeactivate}
        onCancel={() => setPendingDeactivate(null)}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Branch Management</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>{active.length} active branches · {inactive.length} inactive</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
        >
          <Plus size={15} /> Add Branch
        </button>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 24 }}>
        {BRANCH_TYPES.map(t => {
          const count = branches.filter(b => b.branch_type === t).length;
          if (count === 0) return null;
          const sc = TYPE_COLORS[t] || { bg: '#f3f4f6', color: '#374151' };
          return (
            <div key={t} style={{ background: '#fff', borderRadius: 10, border: '1px solid #f0f0f4', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ background: sc.bg, borderRadius: 8, padding: 8 }}><Building size={16} color={sc.color} /></div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#1f2937' }}>{count}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{t}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Branches grid */}
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
      ) : branches.length === 0 ? (
        <div className="no-data" style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 60, textAlign: 'center', color: '#9ca3af' }}>
          <Building size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
          <p style={{ margin: '0 0 16px' }}>No branches yet</p>
          <button onClick={() => setShowForm(true)}
            style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Add First Branch
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {branches.map(b => {
            const sc = TYPE_COLORS[b.branch_type] || { bg: '#f3f4f6', color: '#374151' };
            return (
              <div key={b.id} className="branch-card" style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20, opacity: b.is_active === false ? 0.6 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#1f2937' }}>{b.name}</div>
                    {b.code && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{b.code}</div>}
                  </div>
                  {b.branch_type && (
                    <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {b.branch_type}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                  {(b.city || b.state) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280' }}>
                      <MapPin size={12} />
                      {[b.city, b.state].filter(Boolean).join(', ')}
                    </div>
                  )}
                  {b.phone && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280' }}>
                      <Phone size={12} />{b.phone}
                    </div>
                  )}
                  {b.email && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280' }}>
                      <Mail size={12} />{b.email}
                    </div>
                  )}
                  {b.employee_count > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280' }}>
                      <Users size={12} />{b.employee_count} employee{b.employee_count !== 1 ? 's' : ''}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => openEdit(b)}
                    style={{ flex: 1, padding: '7px 0', background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                    Edit
                  </button>
                  {b.is_active !== false && (
                    <button onClick={() => setPendingDeactivate({ id: b.id, name: b.name })}
                      style={{ padding: '7px 12px', background: '#f9fafb', color: '#9ca3af', border: '1px solid #e5e7eb', borderRadius: 7, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Power size={12} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create / Edit Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 520, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                {editingId ? 'Edit Branch' : 'Add Branch'}
              </h2>
              <button onClick={() => { setShowForm(false); setEditingId(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
              <div style={{ gridColumn: '1/-1' }}>{inp('Branch Name', 'name', 'text', true)}</div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Type</label>
                <select value={form.branch_type} onChange={set('branch_type')}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}>
                  {BRANCH_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              {inp('Branch Code', 'code')}
              {inp('City', 'city')}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>State</label>
                <select value={form.state} onChange={set('state')}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}>
                  <option value="">Select State</option>
                  {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Address</label>
                <textarea value={form.address} onChange={set('address')} rows={2}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
              </div>
              {inp('Phone', 'phone', 'tel')}
              {inp('Email', 'email', 'email')}
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowForm(false); setEditingId(null); }}
                style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving || !form.name.trim()}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (saving || !form.name.trim()) ? 0.6 : 1 }}>
                {saving ? 'Saving...' : editingId ? 'Update Branch' : 'Add Branch'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
