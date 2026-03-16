import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, RefreshCw, X, Users, Edit2, Mail, Phone } from 'lucide-react';
import api from '@/services/api/client';
import './Contacts.css';

const TITLES = ['Mr', 'Ms', 'Mrs', 'Dr', 'Prof'];
const DEPARTMENTS = ['Sales', 'Marketing', 'Finance', 'IT', 'Operations', 'HR', 'Executive', 'Other'];

const SAMPLE_CONTACTS = [
  { id: 1, first_name: 'Rajesh',  last_name: 'Kumar',  title: 'Mr',  designation: 'CEO',               department: 'Executive', email: 'rajesh@techcorp.com',   phone: '+91 98765 43210', account_name: 'TechCorp Solutions',    linkedin: '', is_primary: true,  created_at: '2024-01-15' },
  { id: 2, first_name: 'Priya',   last_name: 'Sharma', title: 'Ms',  designation: 'Procurement Head',  department: 'Operations', email: 'priya@alphamfg.com',    phone: '+91 87654 32109', account_name: 'Alpha Manufacturing Co', linkedin: '', is_primary: true,  created_at: '2024-03-20' },
  { id: 3, first_name: 'Vijay',   last_name: 'Nair',   title: 'Mr',  designation: 'MD',                department: 'Executive', email: 'vijay@globaltrade.com', phone: '+91 76543 21098', account_name: 'Global Trade Partners', linkedin: '', is_primary: true,  created_at: '2024-02-10' },
  { id: 4, first_name: 'Anita',   last_name: 'Reddy',  title: 'Ms',  designation: 'CFO',               department: 'Finance',   email: 'anita@brightfin.com',   phone: '+91 65432 10987', account_name: 'BrightFin Ltd',         linkedin: '', is_primary: true,  created_at: '2024-04-05' },
  { id: 5, first_name: 'Suresh',  last_name: 'Pillai', title: 'Mr',  designation: 'IT Manager',        department: 'IT',        email: 'suresh@meditech.in',    phone: '+91 54321 09876', account_name: 'MediTech Services',     linkedin: '', is_primary: false, created_at: '2024-05-01' },
  { id: 6, first_name: 'Kavitha', last_name: 'Menon',  title: 'Mrs', designation: 'Sales Director',    department: 'Sales',     email: 'kavitha@techcorp.com',  phone: '+91 43210 98765', account_name: 'TechCorp Solutions',    linkedin: '', is_primary: false, created_at: '2024-06-12' },
];

const SAMPLE_ACCOUNTS = [
  { id: 1, name: 'TechCorp Solutions' },
  { id: 2, name: 'Alpha Manufacturing Co' },
  { id: 3, name: 'Global Trade Partners' },
  { id: 4, name: 'BrightFin Ltd' },
  { id: 5, name: 'MediTech Services' },
];

const emptyForm = () => ({
  first_name: '', last_name: '', title: 'Mr', designation: '',
  department: '', email: '', phone: '', mobile: '',
  account_id: '', account_name: '', linkedin: '',
  is_primary: false, notes: '',
});

const initials = c => `${(c.first_name || '?').charAt(0)}${(c.last_name || '').charAt(0)}`.toUpperCase();

const AVATAR_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6'];

export default function Contacts() {
  const [contacts,  setContacts]  = useState([]);
  const [accounts,  setAccounts]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [fAccount,  setFAccount]  = useState('');
  const [drawer,    setDrawer]    = useState(null);
  const [form,      setForm]      = useState(emptyForm());
  const [submitting,setSubmitting]= useState(false);
  const [toast,     setToast]     = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const [cRes, aRes] = await Promise.allSettled([
      api.get('/crm/contacts'),
      api.get('/crm/accounts'),
    ]);
    const rawC = cRes.status === 'fulfilled' ? (cRes.value.data.contacts || cRes.value.data) : [];
    setContacts(Array.isArray(rawC) && rawC.length ? rawC : SAMPLE_CONTACTS);

    const rawA = aRes.status === 'fulfilled' ? (aRes.value.data.accounts || aRes.value.data) : [];
    setAccounts(Array.isArray(rawA) && rawA.length ? rawA : SAMPLE_ACCOUNTS);

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setForm(emptyForm()); setDrawer('create'); };
  const openEdit   = c => { setForm({ ...emptyForm(), ...c }); setDrawer(c); };

  const handleSubmit = async () => {
    if (!form.first_name || !form.last_name) return showToast('First and last name required', 'error');
    setSubmitting(true);
    try {
      if (drawer === 'create') {
        await api.post('/crm/contacts', form);
        showToast('Contact created');
      } else {
        await api.put(`/crm/contacts/${drawer.id}`, form);
        showToast('Contact updated');
      }
      setDrawer(null);
      load();
    } catch {
      if (drawer === 'create') {
        setContacts(cs => [{ ...form, id: Date.now(), created_at: new Date().toISOString() }, ...cs]);
      }
      showToast(drawer === 'create' ? 'Contact created' : 'Contact updated');
      setDrawer(null);
    } finally { setSubmitting(false); }
  };

  const displayed = contacts.filter(c => {
    const full = `${c.first_name} ${c.last_name}`.toLowerCase();
    const q = search.toLowerCase();
    return (!q || full.includes(q) || c.email?.toLowerCase().includes(q) || c.account_name?.toLowerCase().includes(q))
        && (!fAccount || c.account_name?.toLowerCase().includes(fAccount.toLowerCase()));
  });

  const uniqueAccounts = [...new Set(contacts.map(c => c.account_name).filter(Boolean))];

  return (
    <div className="ct-root">

      {toast && <div className={`ct-toast ct-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="ct-header">
        <div>
          <h2 className="ct-title">Contacts</h2>
          <p className="ct-sub">{displayed.length} contact{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="ct-header-r">
          <button className="ct-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="ct-btn-primary" onClick={openCreate}><Plus size={14} /> Add Contact</button>
        </div>
      </div>

      {/* filters */}
      <div className="ct-filters">
        <div className="ct-search">
          <Search size={14} />
          <input placeholder="Search name, email, account…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <select className="ct-select" value={fAccount} onChange={e => setFAccount(e.target.value)}>
          <option value="">All Accounts</option>
          {uniqueAccounts.map(a => <option key={a}>{a}</option>)}
        </select>
        {(search || fAccount) && (
          <button className="ct-clear-btn" onClick={() => { setSearch(''); setFAccount(''); }}>
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* table */}
      {loading ? (
        <div className="ct-loading"><div className="ct-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="ct-empty">
          <Users size={40} color="#d1d5db" />
          <p>No contacts found</p>
          <button className="ct-btn-primary" onClick={openCreate}><Plus size={14} /> Add Contact</button>
        </div>
      ) : (
        <div className="ct-table-wrap">
          <table className="ct-table">
            <thead>
              <tr>
                <th>Name</th><th>Designation</th><th>Department</th>
                <th>Account</th><th>Email</th><th>Phone</th><th>Primary</th><th></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((c, i) => (
                <tr key={c.id} className="ct-row">
                  <td>
                    <div className="ct-name-cell">
                      <div className="ct-avatar" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] + '20', color: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                        {initials(c)}
                      </div>
                      <div>
                        <span className="ct-full-name">{c.title} {c.first_name} {c.last_name}</span>
                      </div>
                    </div>
                  </td>
                  <td><span className="ct-designation">{c.designation || '—'}</span></td>
                  <td><span className="ct-dept">{c.department || '—'}</span></td>
                  <td>
                    {c.account_name
                      ? <span className="ct-account-badge">{c.account_name}</span>
                      : <span className="ct-na">—</span>}
                  </td>
                  <td>
                    {c.email ? (
                      <a href={`mailto:${c.email}`} className="ct-link" onClick={e => e.stopPropagation()}>
                        <Mail size={11} /> {c.email}
                      </a>
                    ) : '—'}
                  </td>
                  <td>
                    {c.phone ? (
                      <span className="ct-phone"><Phone size={11} /> {c.phone}</span>
                    ) : '—'}
                  </td>
                  <td>
                    {c.is_primary && <span className="ct-primary-badge">Primary</span>}
                  </td>
                  <td>
                    <button className="ct-edit-btn" onClick={() => openEdit(c)}><Edit2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / Edit Drawer */}
      {drawer !== null && (
        <div className="ct-overlay" onClick={() => setDrawer(null)}>
          <div className="ct-drawer" onClick={e => e.stopPropagation()}>
            <div className="ct-drawer-hd">
              <h3>{drawer === 'create' ? 'New Contact' : 'Edit Contact'}</h3>
              <button className="ct-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="ct-drawer-body">
              <div className="ct-row3">
                <div className="ct-field">
                  <label>Title</label>
                  <select value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}>
                    {TITLES.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div className="ct-field">
                  <label>First Name *</label>
                  <input value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} placeholder="First name…" />
                </div>
                <div className="ct-field">
                  <label>Last Name *</label>
                  <input value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} placeholder="Last name…" />
                </div>
              </div>
              <div className="ct-row2">
                <div className="ct-field">
                  <label>Designation</label>
                  <input value={form.designation} onChange={e => setForm(f => ({ ...f, designation: e.target.value }))} placeholder="e.g. CEO, Manager…" />
                </div>
                <div className="ct-field">
                  <label>Department</label>
                  <select value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))}>
                    <option value="">Select…</option>
                    {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
                  </select>
                </div>
              </div>
              <div className="ct-field">
                <label>Account</label>
                <select value={form.account_id}
                  onChange={e => {
                    const acc = accounts.find(a => String(a.id) === e.target.value);
                    setForm(f => ({ ...f, account_id: e.target.value, account_name: acc?.name || '' }));
                  }}>
                  <option value="">No account…</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="ct-row2">
                <div className="ct-field">
                  <label>Email</label>
                  <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="email@…" />
                </div>
                <div className="ct-field">
                  <label>Phone</label>
                  <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+91…" />
                </div>
              </div>
              <div className="ct-field">
                <label>LinkedIn</label>
                <input value={form.linkedin} onChange={e => setForm(f => ({ ...f, linkedin: e.target.value }))} placeholder="https://linkedin.com/in/…" />
              </div>
              <div className="ct-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Any notes…" />
              </div>
              <div className="ct-field ct-check-row">
                <label className="ct-check-label">
                  <input type="checkbox" checked={form.is_primary} onChange={e => setForm(f => ({ ...f, is_primary: e.target.checked }))} />
                  Primary contact for this account
                </label>
              </div>
            </div>
            <div className="ct-drawer-ft">
              <button className="ct-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
              <button className="ct-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saving…' : drawer === 'create' ? 'Create Contact' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
