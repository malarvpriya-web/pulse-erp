import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, Search, Wrench } from 'lucide-react';

const EMPTY = { name:'', email:'', phone:'', skills:'', zone:'', status:'Active', employee_id:'' };

export default function ServiceEngineers() {
  const [engineers, setEngineers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [showForm,  setShowForm]  = useState(false);
  const [form,      setForm]      = useState(EMPTY);
  const [saving,    setSaving]    = useState(false);
  const [search,    setSearch]    = useState('');
  const toast = useToast();

  const loadEngineers = () => {
    setLoading(true);
    api.get('/servicedesk/engineers', { params: { limit: 100 } })
      .then(r => setEngineers(Array.isArray(r.data) ? r.data : []))
      .catch(() => setEngineers([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadEngineers();
    api.get('/servicedesk/employees-list')
      .then(r => setEmployees(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
  }, []);

  const handleEmployeeSelect = (e) => {
    const empId = e.target.value;
    const emp = employees.find(em => String(em.id) === empId);
    if (emp) {
      setForm(p => ({ ...p, employee_id: empId, name: emp.name ?? '', email: emp.email ?? '', phone: emp.phone ?? '' }));
    } else {
      setForm(p => ({ ...p, employee_id: '' }));
    }
  };

  const handleSave = async () => {
    if (!form.name) return;
    setSaving(true);
    try {
      await api.post('/servicedesk/engineers', form);
      setShowForm(false);
      setForm(EMPTY);
      loadEngineers();
      toast.success('Engineer added successfully');
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Save failed. Please try again.');
    } finally { setSaving(false); }
  };

  const filtered = engineers?.filter(e =>
    !search || [e?.name, e?.zone, e?.skills].some(v => (v ?? '').toLowerCase().includes(search.toLowerCase()))
  ) ?? [];

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Service Engineers</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>{engineers?.length ?? 0} engineers</p>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15}/> Add Engineer
        </button>
      </div>

      <div style={{ position: 'relative', marginBottom: 16, maxWidth: 320 }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }}/>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, zone, skills..."
          style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}/>
      </div>

      {loading ? <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading...</div> :
       filtered.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center', border: '1px solid #f0f0f4' }}>
          <Wrench size={40} color="#d1d5db" style={{ marginBottom: 12 }}/>
          <p style={{ color: '#9ca3af', margin: '0 0 16px' }}>No service engineers added</p>
          <button onClick={() => setShowForm(true)} style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Add Engineer</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 16 }}>
          {filtered.map(e => (
            <div key={e?.id} style={{ background: '#fff', borderRadius: 12, padding: 20, border: '1px solid #f0f0f4' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div style={{ width: 42, height: 42, borderRadius: '50%', background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: '#6B3FDB' }}>{(e?.name ?? '?')[0].toUpperCase()}</span>
                </div>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', margin: 0 }}>{e?.name ?? 'Unknown'}</p>
                  <span style={{ background: e?.status === 'Active' ? '#d1fae5' : '#f3f4f6', color: e?.status === 'Active' ? '#065f46' : '#6b7280', padding: '1px 7px', borderRadius: 20, fontSize: 10, fontWeight: 600 }}>{e?.status ?? 'Active'}</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {e?.email && <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{e.email}</p>}
                {e?.phone && <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{e.phone}</p>}
                <p style={{ fontSize: 12, color: '#374151', margin: 0 }}>Zone: <strong>{e?.zone ?? 'Unassigned'}</strong></p>
                {(e?.active_visits ?? 0) > 0 && (
                  <p style={{ fontSize: 12, color: '#374151', margin: 0 }}>Active Visits: <strong>{e.active_visits}</strong></p>
                )}
                {e?.skills ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                    {(e.skills).split(',').map((s, i) => s.trim() && (
                      <span key={i} style={{ background: '#f5f3ff', color: '#6B3FDB', padding: '2px 7px', borderRadius: 20, fontSize: 10, fontWeight: 500 }}>{s.trim()}</span>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>No skills listed</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 460, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Add Service Engineer</h2>
              <button onClick={() => { setShowForm(false); setForm(EMPTY); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20}/></button>
            </div>
            <div style={{ display: 'grid', gap: 14 }}>
              {employees.length > 0 && (
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Link to Existing Employee (optional)</label>
                  <select value={form.employee_id} onChange={handleEmployeeSelect}
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fff' }}>
                    <option value="">— Select employee to auto-fill —</option>
                    {employees.map(emp => (
                      <option key={emp.id} value={emp.id}>{emp?.name ?? 'Unknown'} — {emp?.department ?? ''}</option>
                    ))}
                  </select>
                </div>
              )}
              {[
                { label: 'Full Name *', key: 'name',  placeholder: 'Engineer name' },
                { label: 'Email',       key: 'email', placeholder: 'engineer@company.com', type: 'email' },
                { label: 'Phone',       key: 'phone', placeholder: '+91...' },
                { label: 'Zone / Area', key: 'zone',  placeholder: 'North Chennai, Bangalore West...' },
                { label: 'Skills',      key: 'skills',placeholder: 'AC, Plumbing, Electrical (comma separated)' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{f.label}</label>
                  <input type={f.type || 'text'} value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} placeholder={f.placeholder}
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}/>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => { setShowForm(false); setForm(EMPTY); }} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.name}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (saving || !form.name) ? 0.6 : 1 }}>
                {saving ? 'Saving...' : 'Add Engineer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
