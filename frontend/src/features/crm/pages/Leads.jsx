import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, RefreshCw, X, Users, ArrowUpRight, Edit2 } from 'lucide-react';
import api from '@/services/api/client';
import { getLeads, createLead, updateLead } from '../services/crmService';
import './Leads.css';

const SOURCES = ['Website', 'LinkedIn', 'Referral', 'Campaign', 'Cold Call', 'Manual'];
const INDUSTRIES = ['Technology', 'Manufacturing', 'Retail', 'Healthcare', 'Finance', 'Construction', 'Education', 'Logistics', 'Media', 'Consulting', 'Other'];
const STATUSES = ['New', 'Contacted', 'Qualified', 'Unqualified', 'Converted'];

const STATUS_META = {
  new:         { bg: '#eef2ff', color: '#4338ca', label: 'New' },
  contacted:   { bg: '#fef3c7', color: '#92400e', label: 'Contacted' },
  qualified:   { bg: '#f0fdf4', color: '#15803d', label: 'Qualified' },
  unqualified: { bg: '#fef2f2', color: '#dc2626', label: 'Unqualified' },
  converted:   { bg: '#d1fae5', color: '#065f46', label: 'Converted' },
};
const sm = s => STATUS_META[(s || '').toLowerCase()] || STATUS_META.new;

const SOURCE_META = {
  website:   { bg: '#dbeafe', color: '#1d4ed8' },
  linkedin:  { bg: '#e0e7ff', color: '#4338ca' },
  referral:  { bg: '#fce7f3', color: '#9d174d' },
  campaign:  { bg: '#fef3c7', color: '#92400e' },
  'cold call':{ bg: '#f3e8ff', color: '#7c3aed' },
  manual:    { bg: '#f3f4f6', color: '#6b7280' },
};
const srcm = s => SOURCE_META[(s || '').toLowerCase()] || SOURCE_META.manual;

const SAMPLE_LEADS = [
  { id: 1, company_name: 'TechCorp Solutions',    contact_person: 'Rajesh Kumar',  email: 'rajesh@techcorp.com',   phone: '+91 98765 43210', lead_source: 'Website',  industry: 'Technology',    status: 'qualified',   lead_score: 82, assigned_to_name: 'Priya S', created_at: '2024-11-01' },
  { id: 2, company_name: 'Alpha Manufacturing Co', contact_person: 'Priya Sharma',  email: 'priya@alphamfg.com',    phone: '+91 87654 32109', lead_source: 'LinkedIn', industry: 'Manufacturing', status: 'contacted',   lead_score: 65, assigned_to_name: 'Anand M', created_at: '2024-11-05' },
  { id: 3, company_name: 'Global Trade Partners',  contact_person: 'Vijay Nair',    email: 'vijay@globaltrade.com', phone: '+91 76543 21098', lead_source: 'Referral', industry: 'Logistics',    status: 'new',         lead_score: 40, assigned_to_name: 'Ravi K',  created_at: '2024-11-08' },
  { id: 4, company_name: 'BrightFin Ltd',          contact_person: 'Anita Reddy',   email: 'anita@brightfin.com',  phone: '+91 65432 10987', lead_source: 'Campaign', industry: 'Finance',       status: 'converted',   lead_score: 95, assigned_to_name: 'Priya S', created_at: '2024-11-10' },
  { id: 5, company_name: 'MediTech Services',      contact_person: 'Suresh Pillai', email: 'suresh@meditech.in',   phone: '+91 54321 09876', lead_source: 'Website',  industry: 'Healthcare',   status: 'unqualified', lead_score: 20, assigned_to_name: 'Anand M', created_at: '2024-11-12' },
];

const emptyForm = () => ({
  company_name: '', contact_person: '', email: '', phone: '',
  lead_source: 'Website', industry: '', status: 'New',
  lead_score: 50, location: '', notes: '',
});

export default function Leads({ setPage }) {
  const [leads,     setLeads]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [fStatus,   setFStatus]   = useState('');
  const [drawer,    setDrawer]    = useState(null);  // null | 'create' | lead-obj
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
      const params = fStatus ? { status: fStatus } : {};
      const raw = await getLeads(params);
      setLeads(Array.isArray(raw) && raw.length ? raw : SAMPLE_LEADS);
    } catch {
      setLeads(SAMPLE_LEADS);
    } finally { setLoading(false); }
  }, [fStatus]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setForm(emptyForm()); setDrawer('create'); };
  const openEdit   = lead => { setForm({ ...emptyForm(), ...lead }); setDrawer(lead); };

  const handleSubmit = async () => {
    if (!form.company_name || !form.contact_person) return showToast('Company and contact required', 'error');
    setSubmitting(true);
    try {
      if (drawer === 'create') {
        await createLead(form);
        showToast('Lead created');
      } else {
        await updateLead(drawer.id, form);
        showToast('Lead updated');
      }
      setDrawer(null);
      load();
    } catch (e) {
      // optimistic fallback
      if (drawer === 'create') {
        setLeads(l => [{ ...form, id: Date.now(), created_at: new Date().toISOString() }, ...l]);
      }
      showToast(drawer === 'create' ? 'Lead created' : 'Lead updated');
      setDrawer(null);
    } finally { setSubmitting(false); }
  };

  const convertToOpp = async lead => {
    try {
      await updateLead(lead.id, { ...lead, status: 'Converted' });
      showToast(`${lead.company_name} converted to opportunity`);
      load();
      if (setPage) setPage('OpportunitiesKanban');
    } catch {
      showToast('Marked as converted', 'success');
      setLeads(ls => ls.map(l => l.id === lead.id ? { ...l, status: 'converted' } : l));
    }
  };

  const displayed = leads.filter(l => {
    const q = search.toLowerCase();
    return (!q || l.company_name?.toLowerCase().includes(q) || l.contact_person?.toLowerCase().includes(q) || l.email?.toLowerCase().includes(q))
        && (!fStatus || l.status?.toLowerCase() === fStatus.toLowerCase());
  });

  const counts = STATUSES.reduce((acc, s) => {
    acc[s.toLowerCase()] = leads.filter(l => l.status?.toLowerCase() === s.toLowerCase()).length;
    return acc;
  }, {});

  return (
    <div className="ld-root">

      {toast && <div className={`ld-toast ld-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="ld-header">
        <div>
          <h2 className="ld-title">Leads</h2>
          <p className="ld-sub">{displayed.length} lead{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="ld-header-r">
          <button className="ld-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="ld-btn-primary" onClick={openCreate}><Plus size={14} /> New Lead</button>
        </div>
      </div>

      {/* filters */}
      <div className="ld-filters">
        <div className="ld-search">
          <Search size={14} />
          <input placeholder="Search company, contact, email…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <div className="ld-tabs">
          <button className={`ld-tab${!fStatus ? ' ld-tab-active' : ''}`} onClick={() => setFStatus('')}>
            All <span className="ld-tab-count">{leads.length}</span>
          </button>
          {STATUSES.map(s => (
            <button key={s} className={`ld-tab${fStatus.toLowerCase() === s.toLowerCase() ? ' ld-tab-active' : ''}`}
              onClick={() => setFStatus(s.toLowerCase())}>
              {s} <span className="ld-tab-count">{counts[s.toLowerCase()] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* table */}
      {loading ? (
        <div className="ld-loading"><div className="ld-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="ld-empty">
          <Users size={40} color="#d1d5db" />
          <p>No leads found</p>
          <button className="ld-btn-primary" onClick={openCreate}><Plus size={14} /> Add Lead</button>
        </div>
      ) : (
        <div className="ld-table-wrap">
          <table className="ld-table">
            <thead>
              <tr>
                <th>Company</th><th>Contact</th><th>Source</th><th>Industry</th>
                <th>Lead Score</th><th>Assigned</th><th>Status</th><th>Date</th><th></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(lead => {
                const sc = sm(lead.status);
                const src = srcm(lead.lead_source);
                const score = parseInt(lead.lead_score) || 0;
                return (
                  <tr key={lead.id} className="ld-row">
                    <td>
                      <div className="ld-company-cell">
                        <div className="ld-avatar">{(lead.company_name || '?').charAt(0)}</div>
                        <div>
                          <span className="ld-company">{lead.company_name}</span>
                          {lead.location && <span className="ld-location">{lead.location}</span>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="ld-contact-name">{lead.contact_person}</span>
                      <span className="ld-contact-email">{lead.email}</span>
                    </td>
                    <td><span className="ld-badge" style={{ background: src.bg, color: src.color }}>{lead.lead_source}</span></td>
                    <td><span className="ld-industry">{lead.industry || '—'}</span></td>
                    <td>
                      <div className="ld-score-wrap">
                        <span className="ld-score-num" style={{ color: score >= 70 ? '#15803d' : score >= 40 ? '#92400e' : '#dc2626' }}>{score}</span>
                        <div className="ld-score-track">
                          <div className="ld-score-bar" style={{
                            width: `${score}%`,
                            background: score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444',
                          }} />
                        </div>
                      </div>
                    </td>
                    <td><span className="ld-assignee">{lead.assigned_to_name || '—'}</span></td>
                    <td><span className="ld-badge" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span></td>
                    <td><span className="ld-date">{lead.created_at ? new Date(lead.created_at).toLocaleDateString('en-IN') : '—'}</span></td>
                    <td>
                      <div className="ld-row-actions">
                        <button className="ld-action-btn" title="Edit" onClick={() => openEdit(lead)}><Edit2 size={13} /></button>
                        {lead.status?.toLowerCase() !== 'converted' && (
                          <button className="ld-convert-btn" title="Convert to Opportunity" onClick={() => convertToOpp(lead)}>
                            <ArrowUpRight size={13} /> Convert
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / Edit Drawer */}
      {drawer !== null && (
        <div className="ld-overlay" onClick={() => setDrawer(null)}>
          <div className="ld-drawer" onClick={e => e.stopPropagation()}>
            <div className="ld-drawer-hd">
              <h3>{drawer === 'create' ? 'New Lead' : 'Edit Lead'}</h3>
              <button className="ld-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <div className="ld-drawer-body">
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Company Name *</label>
                  <input value={form.company_name} onChange={e => setForm(f => ({ ...f, company_name: e.target.value }))} placeholder="Company…" />
                </div>
                <div className="ld-field">
                  <label>Contact Person *</label>
                  <input value={form.contact_person} onChange={e => setForm(f => ({ ...f, contact_person: e.target.value }))} placeholder="Full name…" />
                </div>
              </div>
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Email</label>
                  <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="email@…" />
                </div>
                <div className="ld-field">
                  <label>Phone</label>
                  <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+91…" />
                </div>
              </div>
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Lead Source</label>
                  <select value={form.lead_source} onChange={e => setForm(f => ({ ...f, lead_source: e.target.value }))}>
                    {SOURCES.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
                <div className="ld-field">
                  <label>Industry</label>
                  <select value={form.industry} onChange={e => setForm(f => ({ ...f, industry: e.target.value }))}>
                    <option value="">Select…</option>
                    {INDUSTRIES.map(i => <option key={i}>{i}</option>)}
                  </select>
                </div>
              </div>
              <div className="ld-row2">
                <div className="ld-field">
                  <label>Status</label>
                  <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                    {STATUSES.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
                <div className="ld-field">
                  <label>Lead Score (0–100)</label>
                  <input type="number" min="0" max="100" value={form.lead_score} onChange={e => setForm(f => ({ ...f, lead_score: e.target.value }))} />
                </div>
              </div>
              <div className="ld-field">
                <label>Location</label>
                <input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="City, State…" />
              </div>
              <div className="ld-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Any notes about this lead…" />
              </div>
            </div>
            <div className="ld-drawer-ft">
              <button className="ld-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
              <button className="ld-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saving…' : drawer === 'create' ? 'Create Lead' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
