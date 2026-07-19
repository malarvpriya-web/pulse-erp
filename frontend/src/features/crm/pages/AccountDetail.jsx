import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Building2, Phone, Globe, MapPin, Users, TrendingUp,
  Mail, Edit2, Plus, ChevronRight, Target, Activity, FileText, X,
} from 'lucide-react';
import api from '@/services/api/client';
import './AccountDetail.css';

// ── formatters ────────────────────────────────────────────────────────────────
const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  if (v > 0)         return `₹${v.toFixed(0)}`;
  return '—';
};
const fmtDate = d => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const AVATAR_COLORS = ['#6B3FDB', '#2563EB', '#059669', '#D97706', '#DC2626'];
const avatarColor = name => AVATAR_COLORS[((name || '').charCodeAt(0) || 0) % AVATAR_COLORS.length];
const getInitials = name => {
  if (!name) return '?';
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
};

const TYPE_META = {
  customer:   { bg: '#dbeafe', color: '#1d4ed8' },
  prospect:   { bg: '#fef3c7', color: '#92400e' },
  partner:    { bg: '#d1fae5', color: '#065f46' },
  competitor: { bg: '#fee2e2', color: '#dc2626' },
  other:      { bg: '#f3f4f6', color: '#6b7280' },
};
const tm = t => TYPE_META[(t || '').toLowerCase()] || TYPE_META.other;

const STAGE_META = {
  won:           { bg: '#dcfce7', color: '#16a34a' },
  lost:          { bg: '#fee2e2', color: '#dc2626' },
  qualification: { bg: '#fef9c3', color: '#854d0e' },
  proposal:      { bg: '#dbeafe', color: '#1d4ed8' },
  negotiation:   { bg: '#ede9fe', color: '#6B3FDB' },
};
const stageMeta = s => STAGE_META[(s || '').toLowerCase()] || { bg: '#f3f4f6', color: '#6b7280' };

// ── tabs ──────────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'overview',      label: 'Overview',      icon: Building2 },
  { key: 'contacts',      label: 'Contacts',       icon: Users },
  { key: 'opportunities', label: 'Opportunities',  icon: Target },
  { key: 'activity',      label: 'Activity',       icon: Activity },
];

// ── Contact form ──────────────────────────────────────────────────────────────
const emptyContact = () => ({ full_name: '', email: '', phone: '', designation: '' });

function ContactForm({ accountId, onSaved, onClose }) {
  const [form, setForm] = useState(emptyContact());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!form.full_name.trim()) { setErr('Name is required'); return; }
    setSaving(true);
    try {
      await api.post('/crm/contacts', { ...form, account_id: accountId });
      onSaved();
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to save contact');
    } finally { setSaving(false); }
  };

  return (
    <div className="ad-modal-mask" onClick={onClose}>
      <div className="ad-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-hd">
          <h3>Add Contact</h3>
          <button className="ad-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ad-modal-body">
          {err && <div className="ad-err">{err}</div>}
          <div className="ad-field">
            <label>Full Name *</label>
            <input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} placeholder="Jane Doe" />
          </div>
          <div className="ad-row2">
            <div className="ad-field">
              <label>Email</label>
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="jane@…" />
            </div>
            <div className="ad-field">
              <label>Phone</label>
              <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+91…" />
            </div>
          </div>
          <div className="ad-field">
            <label>Designation</label>
            <select value={form.designation} onChange={e => setForm(f => ({ ...f, designation: e.target.value }))}>
              <option value="">-- Select Designation --</option>
              {['CEO','CTO','CFO','COO','CMO','Director','VP','General Manager','Manager','Senior Manager','Deputy Manager','Assistant Manager','Team Lead','Senior Engineer','Engineer','Analyst','Consultant','Executive','Officer','Supervisor','Other'].map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </div>
        <div className="ad-modal-ft">
          <button className="ad-btn-outline" onClick={onClose}>Cancel</button>
          <button className="ad-btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Add Contact'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Opportunity form ──────────────────────────────────────────────────────────
const emptyOpp = () => ({ opportunity_name: '', expected_value: '', stage: 'Qualification', expected_closing_date: '' });

function OppForm({ accountId, onSaved, onClose }) {
  const [form, setForm] = useState(emptyOpp());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const STAGES = ['Qualification', 'Proposal', 'Negotiation', 'Won', 'Lost'];

  const submit = async () => {
    if (!form.opportunity_name.trim()) { setErr('Opportunity name is required'); return; }
    setSaving(true);
    try {
      await api.post('/crm/opportunities', { ...form, account_id: accountId });
      onSaved();
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to save opportunity');
    } finally { setSaving(false); }
  };

  return (
    <div className="ad-modal-mask" onClick={onClose}>
      <div className="ad-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-hd">
          <h3>New Opportunity</h3>
          <button className="ad-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ad-modal-body">
          {err && <div className="ad-err">{err}</div>}
          <div className="ad-field">
            <label>Opportunity Name *</label>
            <input value={form.opportunity_name} onChange={e => setForm(f => ({ ...f, opportunity_name: e.target.value }))} placeholder="Deal name…" />
          </div>
          <div className="ad-row2">
            <div className="ad-field">
              <label>Value (₹)</label>
              <input type="number" min="0" value={form.expected_value} onChange={e => setForm(f => ({ ...f, expected_value: e.target.value }))} />
            </div>
            <div className="ad-field">
              <label>Stage</label>
              <select value={form.stage} onChange={e => setForm(f => ({ ...f, stage: e.target.value }))}>
                {STAGES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="ad-field">
            <label>Expected Close Date</label>
            <input type="date" value={form.expected_closing_date} onChange={e => setForm(f => ({ ...f, expected_closing_date: e.target.value }))} />
          </div>
        </div>
        <div className="ad-modal-ft">
          <button className="ad-btn-outline" onClick={onClose}>Cancel</button>
          <button className="ad-btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Create Opportunity'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function AccountDetail() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const accountId = searchParams.get('id');

  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [tab,        setTab]        = useState('overview');
  const [modal,      setModal]      = useState(null); // 'contact' | 'opportunity'
  const [toast,      setToast]      = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const r = await api.get(`/crm/accounts/${accountId}`);
      setData(r.data);
    } catch {
      setData(null);
    } finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  if (!accountId) {
    return (
      <div className="ad-root ad-center">
        <p>No account selected.</p>
        <button className="ad-btn-primary" onClick={() => navigate('/Accounts')}>Back to Accounts</button>
      </div>
    );
  }

  if (loading) return <div className="ad-root ad-center"><div className="ad-spinner" /></div>;

  if (!data) {
    return (
      <div className="ad-root ad-center">
        <p>Account not found.</p>
        <button className="ad-btn-primary" onClick={() => navigate('/Accounts')}>Back to Accounts</button>
      </div>
    );
  }

  const { account, contacts = [], opportunities = [], activities = [] } = data;
  const t = tm(account.account_type);
  const bg = avatarColor(account.name);

  const openOpps  = opportunities.filter(o => !['won','lost'].includes((o.stage || '').toLowerCase()));
  const pipelineV = openOpps.reduce((s, o) => s + parseFloat(o.expected_value || o.deal_value || 0), 0);
  const wonV      = opportunities
    .filter(o => (o.stage || '').toLowerCase() === 'won')
    .reduce((s, o) => s + parseFloat(o.expected_value || o.deal_value || 0), 0);

  return (
    <div className="ad-root">
      {toast && <div className={`ad-toast ad-toast-${toast.type}`}>{toast.msg}</div>}

      {/* header */}
      <div className="ad-header">
        <button className="ad-back-btn" onClick={() => navigate('/Accounts')}>
          <ArrowLeft size={16} /> Accounts
        </button>
        <div className="ad-hd-main">
          <div className="ad-avatar" style={{ background: bg }}>
            {account.logo_url
              ? <img src={account.logo_url} alt={account.name} style={{ width: '100%', height: '100%', borderRadius: 14, objectFit: 'cover' }} />
              : getInitials(account.name)
            }
          </div>
          <div className="ad-hd-info">
            <h1 className="ad-name">{account.name || account.account_name}</h1>
            <div className="ad-hd-meta">
              <span className="ad-badge" style={{ background: t.bg, color: t.color }}>{account.account_type || 'Other'}</span>
              {account.industry && <span className="ad-industry">{account.industry}</span>}
              {account.city && <span className="ad-city"><MapPin size={12} /> {account.city}</span>}
            </div>
          </div>
        </div>

        {/* KPI strip */}
        <div className="ad-kpi-strip">
          <div className="ad-kpi">
            <span className="ad-kpi-label">Annual Revenue</span>
            <span className="ad-kpi-val">{fmt(account.annual_revenue)}</span>
          </div>
          <div className="ad-kpi">
            <span className="ad-kpi-label">Open Pipeline</span>
            <span className="ad-kpi-val ad-kpi-green">{fmt(pipelineV)}</span>
          </div>
          <div className="ad-kpi">
            <span className="ad-kpi-label">Won Value</span>
            <span className="ad-kpi-val">{fmt(wonV)}</span>
          </div>
          <div className="ad-kpi">
            <span className="ad-kpi-label">Contacts</span>
            <span className="ad-kpi-val">{contacts.length}</span>
          </div>
          <div className="ad-kpi">
            <span className="ad-kpi-label">Employees</span>
            <span className="ad-kpi-val">{account.employee_count ? account.employee_count.toLocaleString('en-IN') : '—'}</span>
          </div>
        </div>
      </div>

      {/* tabs */}
      <div className="ad-tabs">
        {TABS.map(tb => {
          const Icon = tb.icon;
          return (
            <button
              key={tb.key}
              className={`ad-tab${tab === tb.key ? ' ad-tab-active' : ''}`}
              onClick={() => setTab(tb.key)}
            >
              <Icon size={14} /> {tb.label}
              {tb.key === 'contacts'      && contacts.length      > 0 && <span className="ad-tab-badge">{contacts.length}</span>}
              {tb.key === 'opportunities' && opportunities.length > 0 && <span className="ad-tab-badge">{opportunities.length}</span>}
            </button>
          );
        })}
      </div>

      {/* tab panels */}
      <div className="ad-panel">

        {/* ── Overview ── */}
        {tab === 'overview' && (
          <div className="ad-overview">
            <div className="ad-section-card">
              <h3 className="ad-section-title">Details</h3>
              <div className="ad-detail-grid">
                {[
                  { label: 'Account Name',   value: account.name || account.account_name },
                  { label: 'Type',           value: account.account_type || '—' },
                  { label: 'Industry',       value: account.industry || '—' },
                  { label: 'Status',         value: account.status || (account.is_active ? 'Active' : 'Inactive') },
                  { label: 'Annual Revenue', value: fmt(account.annual_revenue) },
                  { label: 'Employees',      value: account.employee_count?.toLocaleString('en-IN') || '—' },
                  { label: 'City',           value: account.city || '—' },
                  { label: 'Member Since',   value: fmtDate(account.created_at) },
                ].map(row => (
                  <div key={row.label} className="ad-detail-row">
                    <span className="ad-detail-label">{row.label}</span>
                    <span className="ad-detail-val">{row.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {(account.phone || account.email || account.website) && (
              <div className="ad-section-card">
                <h3 className="ad-section-title">Contact Info</h3>
                <div className="ad-contact-info">
                  {account.phone   && <a href={`tel:${account.phone}`}   className="ad-contact-link"><Phone size={14}/>{account.phone}</a>}
                  {account.email   && <a href={`mailto:${account.email}`} className="ad-contact-link"><Mail  size={14}/>{account.email}</a>}
                  {account.website && <a href={account.website} target="_blank" rel="noopener noreferrer" className="ad-contact-link"><Globe size={14}/>{account.website}</a>}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Contacts ── */}
        {tab === 'contacts' && (
          <div>
            <div className="ad-panel-hd">
              <span className="ad-panel-count">{contacts.length} contact{contacts.length !== 1 ? 's' : ''}</span>
              <button className="ad-btn-primary" onClick={() => setModal('contact')}>
                <Plus size={14} /> Add Contact
              </button>
            </div>
            {contacts.length === 0 ? (
              <div className="ad-empty">
                <Users size={36} color="#d1d5db" />
                <p>No contacts yet</p>
                <button className="ad-btn-primary" onClick={() => setModal('contact')}><Plus size={14} /> Add Contact</button>
              </div>
            ) : (
              <div className="ad-contact-list">
                {contacts.map(c => (
                  <div key={c.id} className="ad-contact-card">
                    <div className="ad-contact-avatar" style={{ background: avatarColor(c.full_name) }}>
                      {getInitials(c.full_name)}
                    </div>
                    <div className="ad-contact-info-col">
                      <span className="ad-contact-name">{c.full_name}</span>
                      {c.designation && <span className="ad-contact-role">{c.designation}</span>}
                    </div>
                    <div className="ad-contact-links">
                      {c.email && <a href={`mailto:${c.email}`} className="ad-contact-chip"><Mail size={12}/>{c.email}</a>}
                      {c.phone && <a href={`tel:${c.phone}`}   className="ad-contact-chip"><Phone size={12}/>{c.phone}</a>}
                    </div>
                    {c.is_primary && <span className="ad-primary-badge">Primary</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Opportunities ── */}
        {tab === 'opportunities' && (
          <div>
            <div className="ad-panel-hd">
              <span className="ad-panel-count">{opportunities.length} opportunit{opportunities.length !== 1 ? 'ies' : 'y'}</span>
              <button className="ad-btn-primary" onClick={() => setModal('opportunity')}>
                <Plus size={14} /> New Opportunity
              </button>
            </div>
            {opportunities.length === 0 ? (
              <div className="ad-empty">
                <Target size={36} color="#d1d5db" />
                <p>No opportunities yet</p>
                <button className="ad-btn-primary" onClick={() => setModal('opportunity')}><Plus size={14} /> New Opportunity</button>
              </div>
            ) : (
              <div className="ad-opp-list">
                {opportunities.map(o => {
                  const sm = stageMeta(o.stage);
                  const val = parseFloat(o.expected_value || o.deal_value || 0);
                  return (
                    <div key={o.id} className="ad-opp-card">
                      <div className="ad-opp-main">
                        <span className="ad-opp-name">{o.opportunity_name}</span>
                        <span className="ad-opp-val">{val > 0 ? fmt(val) : '—'}</span>
                      </div>
                      <div className="ad-opp-meta">
                        <span className="ad-stage-badge" style={{ background: sm.bg, color: sm.color }}>{o.stage}</span>
                        {(o.expected_closing_date || o.expected_close_date) && (
                          <span className="ad-opp-date">
                            Close: {fmtDate(o.expected_closing_date || o.expected_close_date)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Activity ── */}
        {tab === 'activity' && (
          <div>
            <div className="ad-panel-hd">
              <span className="ad-panel-count">{activities.length} activit{activities.length !== 1 ? 'ies' : 'y'}</span>
            </div>
            {activities.length === 0 ? (
              <div className="ad-empty">
                <Activity size={36} color="#d1d5db" />
                <p>No activity recorded yet</p>
              </div>
            ) : (
              <div className="ad-activity-list">
                {activities.map(a => (
                  <div key={a.id} className="ad-activity-item">
                    <div className="ad-activity-dot" />
                    <div className="ad-activity-body">
                      <span className="ad-activity-type">{a.activity_type || 'Note'}</span>
                      {a.subject && <span className="ad-activity-subject">{a.subject}</span>}
                      {a.description && <p className="ad-activity-desc">{a.description}</p>}
                      <span className="ad-activity-date">{fmtDate(a.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* modals */}
      {modal === 'contact' && (
        <ContactForm
          accountId={accountId}
          onSaved={() => { setModal(null); showToast('Contact added'); load(); }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'opportunity' && (
        <OppForm
          accountId={accountId}
          onSaved={() => { setModal(null); showToast('Opportunity created'); load(); }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
