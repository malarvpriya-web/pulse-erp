import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, RefreshCw, X, Users, Edit2, Mail, Phone } from 'lucide-react';
import api from '@/services/api/client';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import './Contacts.css';

const TITLES = ['Mr', 'Ms', 'Mrs', 'Dr', 'Prof'];
const DEPARTMENTS = ['Sales', 'Marketing', 'Finance', 'IT', 'Operations', 'HR', 'Executive', 'Other'];


const emptyForm = () => ({
  first_name: '', last_name: '', title: 'Mr', designation: '',
  department: '', email: '', phone: '', mobile: '',
  account_id: '', account_name: '', linkedin: '',
  is_primary: false, notes: '',
});

const initials = c => `${(c.first_name || '?').charAt(0)}${(c.last_name || '').charAt(0)}`.toUpperCase();

const AVATAR_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6'];

export default function Contacts() {
  const { readOnly } = usePageAccess();
  const [contacts,  setContacts]  = useState([]);
  const [accounts,  setAccounts]  = useState([]);
  const [loading,   setLoading]   = useState(false);
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
    setContacts(Array.isArray(rawC) ? rawC : []);

    const rawA = aRes.status === 'fulfilled' ? (aRes.value.data.accounts || aRes.value.data) : [];
    setAccounts(Array.isArray(rawA) ? rawA : []);

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
      showToast(drawer === 'create' ? 'Failed to create contact' : 'Failed to update contact', 'error');
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

      {readOnly && <ReadOnlyBanner />}

      <div className="ct-header">
        <div>
          <h2 className="ct-title">Contacts</h2>
          <p className="ct-sub">{displayed.length} contact{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="ct-header-r">
          <button className="ct-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          {!readOnly && <button className="ct-btn-primary" onClick={openCreate}><Plus size={14} /> Add Contact</button>}
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
          {!readOnly && <button className="ct-btn-primary" onClick={openCreate}><Plus size={14} /> Add Contact</button>}
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
                <tr key={c.id} className="ct-row" onClick={() => { if (!readOnly) openEdit(c); }} style={{ cursor: readOnly ? 'default' : 'pointer' }}>
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
                      <a href={`mailto:${c.email}`} className="ct-link"
                         onClick={e => e.stopPropagation()}>
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
                    {!readOnly && <button className="ct-edit-btn" onClick={e => { e.stopPropagation(); openEdit(c); }}><Edit2 size={13} /></button>}
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
                  <select value={form.designation} onChange={e => setForm(f => ({ ...f, designation: e.target.value }))}>
                    <option value="">-- Select Designation --</option>
                    {['CEO','CTO','CFO','COO','CMO','Director','VP','General Manager','Manager','Senior Manager','Deputy Manager','Assistant Manager','Team Lead','Senior Engineer','Engineer','Analyst','Consultant','Executive','Officer','Supervisor','Other'].map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
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
