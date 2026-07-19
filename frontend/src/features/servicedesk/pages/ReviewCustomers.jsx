import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { Plus, X, Search, Users, Pencil, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { formatDateTime } from '@/utils/dateFormatter';

// Customers are CRM contacts (person) under accounts (company) — see migration
// 20260717000001. The old service_customers table is no longer read.
const ROLES = ['User', 'Admin'];
const ROLE_STYLE = {
  Admin: { bg: '#ede9fe', color: '#6B3FDB' },
  User:  { bg: '#f3f4f6', color: '#6b7280' },
};
const EMPTY = { name: '', email: '', mobile: '', account_id: '', designation: '', photo_url: '', customer_role: 'User' };

// Mirrors shared/validators.js on the backend.
const normalizeMobile = (v) => {
  let d = String(v ?? '').replace(/[^0-9]/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);
  return d;
};
const isMobileValid = (v) => /^[6-9][0-9]{9}$/.test(normalizeMobile(v));

const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

// Deterministic avatar tint so a row keeps the same colour between loads.
const AVATAR_BG = ['#ede9fe', '#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3', '#e0e7ff'];
const avatarBg = (id, name) => {
  const key = Number(id) || String(name || '').length;
  return AVATAR_BG[key % AVATAR_BG.length];
};

const COLUMNS = [
  { key: 'id',            label: 'ID',      sortable: true,  width: 64 },
  { key: 'photo',         label: 'Photo',   sortable: false, width: 64 },
  { key: 'name',          label: 'Name',    sortable: true  },
  { key: 'account_name',  label: 'Company', sortable: true  },
  { key: 'email',         label: 'Email',   sortable: true  },
  { key: 'mobile',        label: 'Mobile',  sortable: true  },
  { key: 'customer_role', label: 'Role',    sortable: true  },
  { key: 'created_at',    label: 'Created', sortable: true  },
  { key: 'actions',       label: '',        sortable: false, width: 80 },
];

export default function ReviewCustomers() {
  const [customers, setCustomers] = useState([]);
  const [accounts,  setAccounts]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [sort,      setSort]      = useState({ key: 'name', dir: 'asc' });
  const [showForm,  setShowForm]  = useState(false);
  const [editing,   setEditing]   = useState(null);
  const [form,      setForm]      = useState(EMPTY);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');
  const [toast,     setToast]     = useState(null);
  const [confirm,   setConfirm]   = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback((signal) => {
    setLoading(true);
    api.get('/servicedesk/customers', {
      params: { search: search.trim() || undefined, sort: sort.key, dir: sort.dir, limit: 200 },
      signal,
    })
      .then(r => setCustomers(Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.data) ? r.data.data : [])))
      .catch(err => { if (err.name !== 'CanceledError') setCustomers([]); })
      .finally(() => setLoading(false));
  }, [search, sort]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => load(ctrl.signal), 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [load]);

  useEffect(() => {
    api.get('/servicedesk/customer-accounts')
      .then(r => setAccounts(Array.isArray(r.data) ? r.data : []))
      .catch(() => setAccounts([]));
  }, []);

  const toggleSort = (key) =>
    setSort(s => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  const openNew  = () => { setEditing(null); setForm(EMPTY); setError(''); setShowForm(true); };
  const openEdit = (c) => {
    setEditing(c);
    setForm({
      name: c.name ?? '', email: c.email ?? '', mobile: c.mobile ?? '',
      account_id: c.account_id ?? '', designation: c.designation ?? '',
      photo_url: c.photo_url ?? '', customer_role: c.customer_role ?? 'User',
    });
    setError(''); setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim())                        { setError('Customer name is required.'); return; }
    if (form.mobile && !isMobileValid(form.mobile)) { setError('Mobile must be a 10-digit Indian number starting with 6-9.'); return; }
    setSaving(true); setError('');
    const payload = {
      ...form,
      mobile: form.mobile ? normalizeMobile(form.mobile) : null,
      account_id: form.account_id || null,
    };
    try {
      if (editing) await api.put(`/servicedesk/customers/${editing.id}`, payload);
      else         await api.post('/servicedesk/customers', payload);
      setShowForm(false); setForm(EMPTY); setEditing(null);
      load();
      showToast(editing ? 'Customer updated' : 'Customer added');
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to save.');
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    const c = confirm;
    setConfirm(null);
    try {
      await api.delete(`/servicedesk/customers/${c.id}`);
      load();
      showToast('Customer deleted');
    } catch (e) {
      showToast(e?.response?.data?.error || 'Failed to delete.', 'error');
    }
  };

  const inp = (label, key, opts = {}) => (
    <div style={{ gridColumn: opts.full ? '1/-1' : 'auto' }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</label>
      <input type={opts.type || 'text'} value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
        placeholder={opts.placeholder}
        style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}/>
      {opts.hint && <p style={{ margin: '4px 0 0', fontSize: 11, color: '#9ca3af' }}>{opts.hint}</p>}
    </div>
  );

  const cell = { padding: '10px 16px' };

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, padding: '10px 18px', borderRadius: 8, fontWeight: 600, fontSize: 13,
          background: toast.type === 'success' ? '#d1fae5' : '#fee2e2', color: toast.type === 'success' ? '#065f46' : '#991b1b' }}>
          {toast.msg}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Service Customers</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>{customers.length} customers</p>
        </div>
        <button onClick={openNew}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15}/> New
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, company, email, mobile..."
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}/>
        </div>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflowX: 'auto' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : customers.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            <Users size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }}/>
            <p style={{ margin: '0 0 4px', fontWeight: 500 }}>No customers found</p>
            <p style={{ margin: 0, fontSize: 12 }}>{search ? 'Try a different search' : 'Add your first service customer'}</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {COLUMNS.map(col => {
                  const on = sort.key === col.key;
                  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
                  return (
                    <th key={col.key}
                      onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                      style={{ ...cell, width: col.width, textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap',
                        color: on ? '#6B3FDB' : '#374151', borderBottom: '1px solid #f0f0f4',
                        cursor: col.sortable ? 'pointer' : 'default', userSelect: 'none' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {col.label}
                        {col.sortable && on && <Arrow size={12}/>}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {customers.map((c, i) => {
                const rs = ROLE_STYLE[c?.customer_role] || ROLE_STYLE.User;
                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ ...cell, color: '#9ca3af', fontVariantNumeric: 'tabular-nums' }}>{c.id}</td>
                    <td style={cell}>
                      {c.photo_url ? (
                        <img src={c.photo_url} alt=""
                          style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', display: 'block' }}/>
                      ) : (
                        <div aria-hidden="true" style={{ width: 32, height: 32, borderRadius: '50%', background: avatarBg(c.id, c.name),
                          color: '#4b5563', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>
                          {initials(c.name)}
                        </div>
                      )}
                    </td>
                    <td style={{ ...cell, fontWeight: 600, color: '#1f2937' }}>
                      {c.name || <span style={{ color: '#d1d5db', fontWeight: 400 }}>—</span>}
                      {c.designation && <div style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af' }}>{c.designation}</div>}
                    </td>
                    <td style={{ ...cell, color: '#374151' }}>{c.account_name ?? '—'}</td>
                    <td style={{ ...cell, color: '#6b7280' }}>{c.email ?? '—'}</td>
                    <td style={{ ...cell, color: '#6b7280', fontVariantNumeric: 'tabular-nums' }}>{c.mobile ?? '—'}</td>
                    <td style={cell}>
                      <span style={{ background: rs.bg, color: rs.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                        {c.customer_role ?? 'User'}
                      </span>
                    </td>
                    <td style={{ ...cell, color: '#6b7280', whiteSpace: 'nowrap' }}>{formatDateTime(c.created_at) || '—'}</td>
                    <td style={cell}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={() => openEdit(c)} title="Edit" aria-label={`Edit ${c.name || 'customer'}`}
                          style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', borderRadius: 6 }}>
                          <Pencil size={14}/>
                        </button>
                        <button onClick={() => setConfirm(c)} title="Delete" aria-label={`Delete ${c.name || 'customer'}`}
                          style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', borderRadius: 6 }}>
                          <Trash2 size={14}/>
                        </button>
                      </div>
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
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>{editing ? 'Edit Customer' : 'Add Customer'}</h2>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20}/></button>
            </div>
            {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {inp('Name *',      'name',        { full: true, placeholder: 'Full name' })}
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Company</label>
                <select value={form.account_id} onChange={e => setForm(p => ({ ...p, account_id: e.target.value }))}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}>
                  <option value="">— No company —</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              {inp('Email',       'email',       { type: 'email', placeholder: 'email@example.com' })}
              {inp('Mobile',      'mobile',      { placeholder: '9812345678', hint: '10 digits, starting 6-9' })}
              {inp('Designation', 'designation', { placeholder: 'e.g. IT Head' })}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Role</label>
                <select value={form.customer_role} onChange={e => setForm(p => ({ ...p, customer_role: e.target.value }))}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}>
                  {ROLES.map(r => <option key={r}>{r}</option>)}
                </select>
              </div>
              {inp('Photo URL',   'photo_url',   { full: true, placeholder: 'https://... (optional)' })}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 24 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '9px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}>Cancel</button>
              <button onClick={handleSave} disabled={saving}
                style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving...' : (editing ? 'Save Changes' : 'Add Customer')}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        variant="danger"
        title="Delete customer"
        message={`Delete ${confirm?.name || 'this customer'}? This also removes them from CRM contacts.`}
        onConfirm={handleDelete}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
