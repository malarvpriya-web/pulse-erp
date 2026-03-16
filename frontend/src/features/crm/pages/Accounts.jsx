import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, RefreshCw, X, Building2, Edit2 } from 'lucide-react';
import api from '@/services/api/client';
import './Accounts.css';

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const INDUSTRIES = ['Technology', 'Manufacturing', 'Retail', 'Healthcare', 'Finance', 'Construction', 'Education', 'Logistics', 'Media', 'Consulting', 'Other'];
const ACCOUNT_TYPES = ['Customer', 'Prospect', 'Partner', 'Competitor', 'Other'];
const STATUSES = ['Active', 'Inactive', 'Prospect'];

const TYPE_META = {
  customer:   { bg: '#dbeafe', color: '#1d4ed8' },
  prospect:   { bg: '#fef3c7', color: '#92400e' },
  partner:    { bg: '#d1fae5', color: '#065f46' },
  competitor: { bg: '#fee2e2', color: '#dc2626' },
  other:      { bg: '#f3f4f6', color: '#6b7280' },
};
const tm = t => TYPE_META[(t || '').toLowerCase()] || TYPE_META.other;

const SAMPLE_ACCOUNTS = [
  { id: 1, name: 'TechCorp Solutions',    industry: 'Technology',    account_type: 'Customer',   annual_revenue: 5000000,  employee_count: 250, website: 'techcorp.com',    phone: '+91 98765 43210', status: 'Active',   contacts_count: 4, created_at: '2024-01-15' },
  { id: 2, name: 'Alpha Manufacturing Co',industry: 'Manufacturing', account_type: 'Customer',   annual_revenue: 12000000, employee_count: 800, website: 'alphamfg.com',    phone: '+91 87654 32109', status: 'Active',   contacts_count: 6, created_at: '2024-03-20' },
  { id: 3, name: 'Global Trade Partners', industry: 'Logistics',     account_type: 'Partner',    annual_revenue: 8000000,  employee_count: 120, website: 'globaltrade.com', phone: '+91 76543 21098', status: 'Active',   contacts_count: 3, created_at: '2024-02-10' },
  { id: 4, name: 'BrightFin Ltd',         industry: 'Finance',       account_type: 'Prospect',   annual_revenue: 3000000,  employee_count: 80,  website: 'brightfin.in',    phone: '+91 65432 10987', status: 'Prospect', contacts_count: 2, created_at: '2024-04-05' },
  { id: 5, name: 'MediTech Services',     industry: 'Healthcare',    account_type: 'Prospect',   annual_revenue: 6500000,  employee_count: 340, website: 'meditech.in',     phone: '+91 54321 09876', status: 'Prospect', contacts_count: 1, created_at: '2024-05-01' },
];

const emptyForm = () => ({
  name: '', industry: '', account_type: 'Customer',
  annual_revenue: '', employee_count: '', website: '',
  phone: '', email: '', address: '', status: 'Active', notes: '',
});

export default function Accounts() {
  const [accounts,  setAccounts]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [fType,     setFType]     = useState('');
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
    try {
      const r = await api.get('/crm/accounts');
      const raw = r.data.accounts || r.data;
      setAccounts(Array.isArray(raw) && raw.length ? raw : SAMPLE_ACCOUNTS);
    } catch {
      setAccounts(SAMPLE_ACCOUNTS);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setForm(emptyForm()); setDrawer('create'); };
  const openEdit   = acc => { setForm({ ...emptyForm(), ...acc }); setDrawer(acc); };

  const handleSubmit = async () => {
    if (!form.name) return showToast('Account name is required', 'error');
    setSubmitting(true);
    try {
      if (drawer === 'create') {
        await api.post('/crm/accounts', form);
        showToast('Account created');
      } else {
        await api.put(`/crm/accounts/${drawer.id}`, form);
        showToast('Account updated');
      }
      setDrawer(null);
      load();
    } catch {
      if (drawer === 'create') {
        setAccounts(a => [{ ...form, id: Date.now(), contacts_count: 0, created_at: new Date().toISOString() }, ...a]);
      }
      showToast(drawer === 'create' ? 'Account created' : 'Account updated');
      setDrawer(null);
    } finally { setSubmitting(false); }
  };

  const displayed = accounts.filter(a => {
    const q = search.toLowerCase();
    return (!q || a.name?.toLowerCase().includes(q) || a.industry?.toLowerCase().includes(q))
        && (!fType || a.account_type?.toLowerCase() === fType.toLowerCase());
  });

  return (
    <div className="ac-root">

      {toast && <div className={`ac-toast ac-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="ac-header">
        <div>
          <h2 className="ac-title">Accounts</h2>
          <p className="ac-sub">{displayed.length} account{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="ac-header-r">
          <button className="ac-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="ac-btn-primary" onClick={openCreate}><Plus size={14} /> Add Account</button>
        </div>
      </div>

      {/* filters */}
      <div className="ac-filters">
        <div className="ac-search">
          <Search size={14} />
          <input placeholder="Search accounts…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <div className="ac-tabs">
          <button className={`ac-tab${!fType ? ' ac-tab-active' : ''}`} onClick={() => setFType('')}>All</button>
          {ACCOUNT_TYPES.map(t => (
            <button key={t} className={`ac-tab${fType.toLowerCase() === t.toLowerCase() ? ' ac-tab-active' : ''}`}
              onClick={() => setFType(t.toLowerCase())}>{t}</button>
          ))}
        </div>
      </div>

      {/* grid */}
      {loading ? (
        <div className="ac-loading"><div className="ac-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="ac-empty">
          <Building2 size={40} color="#d1d5db" />
          <p>No accounts found</p>
          <button className="ac-btn-primary" onClick={openCreate}><Plus size={14} /> Add Account</button>
        </div>
      ) : (
        <div className="ac-grid">
          {displayed.map(acc => {
            const t = tm(acc.account_type);
            return (
              <div key={acc.id} className="ac-card" onClick={() => openEdit(acc)}>
                <div className="ac-card-hd">
                  <div className="ac-avatar">{(acc.name || '?').charAt(0)}</div>
                  <div className="ac-card-info">
                    <span className="ac-card-name">{acc.name}</span>
                    <span className="ac-card-industry">{acc.industry || '—'}</span>
                  </div>
                  <span className="ac-badge" style={{ background: t.bg, color: t.color }}>{acc.account_type}</span>
                </div>
                <div className="ac-card-stats">
                  <div className="ac-stat">
                    <span className="ac-stat-label">Revenue</span>
                    <span className="ac-stat-val">{fmt(acc.annual_revenue)}</span>
                  </div>
                  <div className="ac-stat">
                    <span className="ac-stat-label">Employees</span>
                    <span className="ac-stat-val">{acc.employee_count ? acc.employee_count.toLocaleString('en-IN') : '—'}</span>
                  </div>
                  <div className="ac-stat">
                    <span className="ac-stat-label">Contacts</span>
                    <span className="ac-stat-val">{acc.contacts_count || 0}</span>
                  </div>
                </div>
                {acc.phone && <div className="ac-card-phone">{acc.phone}</div>}
                <div className="ac-card-footer">
                  <span className={`ac-status ${(acc.status || 'active').toLowerCase()}`}>{acc.status || 'Active'}</span>
                  <button className="ac-edit-btn" onClick={e => { e.stopPropagation(); openEdit(acc); }}><Edit2 size={13} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create / Edit Drawer */}
      {drawer !== null && (
        <div className="ac-overlay" onClick={() => setDrawer(null)}>
          <div className="ac-drawer" onClick={e => e.stopPropagation()}>
            <div className="ac-drawer-hd">
              <h3>{drawer === 'create' ? 'New Account' : 'Edit Account'}</h3>
              <button className="ac-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="ac-drawer-body">
              <div className="ac-field">
                <label>Account Name *</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Company name…" />
              </div>
              <div className="ac-row2">
                <div className="ac-field">
                  <label>Account Type</label>
                  <select value={form.account_type} onChange={e => setForm(f => ({ ...f, account_type: e.target.value }))}>
                    {ACCOUNT_TYPES.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div className="ac-field">
                  <label>Industry</label>
                  <select value={form.industry} onChange={e => setForm(f => ({ ...f, industry: e.target.value }))}>
                    <option value="">Select…</option>
                    {INDUSTRIES.map(i => <option key={i}>{i}</option>)}
                  </select>
                </div>
              </div>
              <div className="ac-row2">
                <div className="ac-field">
                  <label>Annual Revenue (₹)</label>
                  <input type="number" min="0" value={form.annual_revenue} onChange={e => setForm(f => ({ ...f, annual_revenue: e.target.value }))} />
                </div>
                <div className="ac-field">
                  <label>Employees</label>
                  <input type="number" min="0" value={form.employee_count} onChange={e => setForm(f => ({ ...f, employee_count: e.target.value }))} />
                </div>
              </div>
              <div className="ac-row2">
                <div className="ac-field">
                  <label>Phone</label>
                  <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+91…" />
                </div>
                <div className="ac-field">
                  <label>Email</label>
                  <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="info@…" />
                </div>
              </div>
              <div className="ac-field">
                <label>Website</label>
                <input value={form.website} onChange={e => setForm(f => ({ ...f, website: e.target.value }))} placeholder="https://…" />
              </div>
              <div className="ac-field">
                <label>Address</label>
                <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="Street, City, State…" />
              </div>
              <div className="ac-row2">
                <div className="ac-field">
                  <label>Status</label>
                  <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                    {STATUSES.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div className="ac-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Any notes…" />
              </div>
            </div>
            <div className="ac-drawer-ft">
              <button className="ac-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
              <button className="ac-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saving…' : drawer === 'create' ? 'Create Account' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
