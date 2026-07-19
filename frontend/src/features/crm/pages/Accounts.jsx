import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, RefreshCw, X, Building2, Edit2 } from 'lucide-react';
import api from '@/services/api/client';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import './Accounts.css';

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  if (v > 0)         return `₹${v.toFixed(0)}`;
  return '—';
};

const INDUSTRIES  = ['Technology', 'Manufacturing', 'Retail', 'Healthcare', 'Finance', 'Construction', 'Education', 'Logistics', 'Media', 'Consulting', 'Other'];
const ACCOUNT_TYPES = ['Customer', 'Prospect', 'Partner', 'Competitor', 'Other'];
const STATUSES    = ['Active', 'Inactive', 'Prospect'];

const TYPE_META = {
  customer:   { bg: '#dbeafe', color: '#1d4ed8' },
  prospect:   { bg: '#fef3c7', color: '#92400e' },
  partner:    { bg: '#d1fae5', color: '#065f46' },
  competitor: { bg: '#fee2e2', color: '#dc2626' },
  other:      { bg: '#f3f4f6', color: '#6b7280' },
};
const tm = t => TYPE_META[(t || '').toLowerCase()] || TYPE_META.other;

const AVATAR_COLORS = ['#6B3FDB', '#2563EB', '#059669', '#D97706', '#DC2626'];
const avatarColor = name => AVATAR_COLORS[((name || '').charCodeAt(0) || 0) % AVATAR_COLORS.length];
const getInitials = name => {
  if (!name) return '?';
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
};

const emptyForm = () => ({
  name: '', industry: '', account_type: 'Customer',
  annual_revenue: '', employee_count: '', website: '',
  phone: '', email: '', city: '', status: 'Active', notes: '',
});

export default function Accounts() {
  const navigate = useNavigate();
  const { readOnly } = usePageAccess();
  const [accounts,   setAccounts]   = useState([]);
  const [stats,      setStats]      = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [fType,      setFType]      = useState('');
  const [drawer,     setDrawer]     = useState(null);
  const [form,       setForm]       = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accRes, statsRes] = await Promise.allSettled([
        api.get('/crm/accounts'),
        api.get('/crm/accounts/stats'),
      ]);
      if (accRes.status === 'fulfilled') {
        const raw = accRes.value.data?.accounts ?? accRes.value.data;
        setAccounts(Array.isArray(raw) ? raw : []);
      }
      if (statsRes.status === 'fulfilled') setStats(statsRes.value.data);
    } catch {
      setAccounts([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setForm(emptyForm()); setDrawer('create'); };
  const openEdit   = (acc, e) => { e?.stopPropagation(); setForm({ ...emptyForm(), ...acc }); setDrawer(acc); };

  const handleSubmit = async () => {
    if (!form.name?.trim()) return showToast('Account name is required', 'error');
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
    } catch (err) {
      const msg = err?.response?.data?.error || (drawer === 'create' ? 'Failed to create account' : 'Failed to update account');
      showToast(msg, 'error');
    } finally { setSubmitting(false); }
  };

  const displayed = accounts.filter(a => {
    const q = search.toLowerCase();
    return (!q || a.name?.toLowerCase().includes(q) || a.industry?.toLowerCase().includes(q))
        && (!fType || (a.account_type || '').toLowerCase() === fType.toLowerCase());
  });

  const PILLS = [
    { label: 'All',        key: '',           count: stats?.total },
    { label: 'Customer',   key: 'customer',   count: stats?.customers },
    { label: 'Prospect',   key: 'prospect',   count: stats?.prospects },
    { label: 'Partner',    key: 'partner',    count: stats?.partners },
    { label: 'Competitor', key: 'competitor', count: stats?.competitors },
    { label: 'Other',      key: 'other',      count: stats?.other },
  ];

  return (
    <div className="ac-root">

      {toast && <div className={`ac-toast ac-toast-${toast.type}`}>{toast.msg}</div>}

      {readOnly && <ReadOnlyBanner />}

      <div className="ac-header">
        <div>
          <h2 className="ac-title">Accounts</h2>
          <p className="ac-sub">{displayed.length} account{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="ac-header-r">
          <button className="ac-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          {!readOnly && <button className="ac-btn-primary" onClick={openCreate}><Plus size={14} /> Add Account</button>}
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
          {PILLS.map(p => (
            <button
              key={p.key}
              className={`ac-tab${fType === p.key ? ' ac-tab-active' : ''}`}
              onClick={() => setFType(p.key)}
            >
              {p.label}{p.count != null ? ` (${p.count})` : ''}
            </button>
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
          {!readOnly && <button className="ac-btn-primary" onClick={openCreate}><Plus size={14} /> Add Account</button>}
        </div>
      ) : (
        <div className="ac-grid">
          {displayed.map(acc => {
            const t   = tm(acc.account_type);
            const bg  = avatarColor(acc.name);
            const pipeline = parseFloat(acc.open_pipeline_value || 0);
            return (
              <div
                key={acc.id}
                className="ac-card"
                onClick={() => navigate(`/AccountDetail?id=${acc.id}`)}
              >
                <div className="ac-card-hd">
                  <div className="ac-avatar" style={{ background: bg, color: '#fff' }}>
                    {acc.logo_url
                      ? <img src={acc.logo_url} alt={acc.name} style={{ width: '100%', height: '100%', borderRadius: 10, objectFit: 'cover' }} />
                      : getInitials(acc.name)
                    }
                  </div>
                  <div className="ac-card-info">
                    <span className="ac-card-name">{acc.name ?? '—'}</span>
                    <span className="ac-card-industry">{acc.industry || ''}</span>
                  </div>
                  <span className="ac-badge" style={{ background: t.bg, color: t.color }}>{acc.account_type || 'Other'}</span>
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
                    <span className="ac-stat-val">{acc.contacts_count ?? 0}</span>
                  </div>
                </div>
                {pipeline > 0 && (
                  <div className="ac-pipeline">Pipeline: {fmt(pipeline)}</div>
                )}
                {acc.phone && <div className="ac-card-phone">{acc.phone}</div>}
                <div className="ac-card-footer">
                  <span className={`ac-status ${(acc.status || 'active').toLowerCase()}`}>{acc.status || 'Active'}</span>
                  {!readOnly && (
                    <button
                      className="ac-edit-btn"
                      title="Edit account"
                      onClick={e => openEdit(acc, e)}
                    >
                      <Edit2 size={13} />
                    </button>
                  )}
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
              <div className="ac-row2">
                <div className="ac-field">
                  <label>Website</label>
                  <input value={form.website} onChange={e => setForm(f => ({ ...f, website: e.target.value }))} placeholder="https://…" />
                </div>
                <div className="ac-field">
                  <label>City</label>
                  <input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} placeholder="Chennai…" />
                </div>
              </div>
              <div className="ac-field">
                <label>Status</label>
                <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                  {STATUSES.map(s => <option key={s}>{s}</option>)}
                </select>
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
