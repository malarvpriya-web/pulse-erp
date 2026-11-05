import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, Building, Users, MapPin, Phone, Mail, Power, Network, Search, RotateCcw } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { PageHero, PageShell } from '@/components/pulse-ui';

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
  'Service Center': { bg: '#ede9fe', color: '#5b21b6' },
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
  const [query, setQuery] = useState('');
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

  /**
   * Bring a deactivated branch back.
   *
   * There was no way back before: DELETE switched a branch off and nothing
   * switched one on again, so a branch deactivated by mistake was gone —
   * and Add Employee only offers ACTIVE branches, so its employees could not
   * be re-filed either.
   */
  const handleReactivate = async (id, name) => {
    try {
      await api.post(`/branches/${id}/reactivate`);
      await load();
      toast.success(`Branch "${name}" reactivated`);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || 'Failed to reactivate');
    }
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

  // Search across the fields someone would actually recall a branch by — its
  // name, its code or its city. Normalised the same way the master-data search
  // is, so "head office" finds "Head Office".
  const needle = query.trim().toLowerCase();
  const matches = (b) => !needle ||
    [b.name, b.code, b.city, b.state].some(v => String(v ?? '').toLowerCase().includes(needle));

  const active   = branches.filter(b => b.is_active !== false && matches(b));
  const inactive = branches.filter(b => b.is_active === false && matches(b));

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
    <PageShell dock={
      <PageHero
        icon={Network}
        eyebrow="Settings"
        title="Branch Management"
        actions={<button className="plh-cta"
          onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); }}>
          <Plus size={15} /> Add Branch
        </button>}
      />
    }>
      <ConfirmDialog
        open={!!pendingDeactivate}
        title="Deactivate Branch"
        message={pendingDeactivate ? `Deactivate branch "${pendingDeactivate.name}"?` : ''}
        confirmLabel="Deactivate"
        variant="warning"
        onConfirm={handleDeactivate}
        onCancel={() => setPendingDeactivate(null)}
      />

      {/* Search — branches are the Location master, and a group with a dozen
          sites is exactly where scanning a card grid stops working. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 0 }}>
          <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
          <input
            type="search"
            aria-label="Search branches"
            placeholder="Search by name, code or city…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px 9px 32px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', font: 'inherit' }}
          />
        </div>
        <span style={{ fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>
          {active.length} active{inactive.length ? ` · ${inactive.length} inactive` : ''}
        </span>
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
                  {b.is_active !== false ? (
                    <button onClick={() => setPendingDeactivate({ id: b.id, name: b.name })}
                      title={`Deactivate "${b.name}" — it stops being selectable on new employee records`}
                      aria-label={`Deactivate ${b.name}`}
                      style={{ padding: '7px 12px', background: '#f9fafb', color: '#9ca3af', border: '1px solid #e5e7eb', borderRadius: 7, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Power size={12} />
                    </button>
                  ) : (
                    // The way back. Without it a branch switched off by mistake
                    // stayed off, and Add Employee only offers ACTIVE branches —
                    // so its employees could not be re-filed either.
                    <button onClick={() => handleReactivate(b.id, b.name)}
                      title={`Reactivate "${b.name}"`}
                      aria-label={`Reactivate ${b.name}`}
                      style={{ padding: '7px 12px', background: '#ede9fe', color: '#6B3FDB', border: '1px solid #c4b5fd', borderRadius: 7, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <RotateCcw size={12} />
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
    </PageShell>
  );
}
