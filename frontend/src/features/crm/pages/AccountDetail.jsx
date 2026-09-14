import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Building2, Phone, Globe, MapPin, Users, TrendingUp, Mail,
  Edit2, Plus, ChevronRight, Target, Activity, FileText, X, Contact,
  Package, LayoutDashboard, UserCog, Network,
} from 'lucide-react';
import api from '@/services/api/client';
import './AccountDetail.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

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
// Unit prices need the exact figure — fmt()'s Cr/L/K abbreviation rounds
// ₹1,250.50 to "₹1K" and would make two different prices look identical.
const fmtRs = v => (v == null || v === '' || isNaN(parseFloat(v)))
  ? '—' : '₹' + parseFloat(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtQty = v => (v == null || v === '' || isNaN(parseFloat(v)))
  ? '—' : parseFloat(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });

const AVATAR_COLORS = ['#6B3FDB', '#2563EB', '#059669', '#6d28d9', '#DC2626'];
const avatarColor = name => AVATAR_COLORS[((name || '').charCodeAt(0) || 0) % AVATAR_COLORS.length];
const getInitials = name => {
  if (!name) return '?';
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
};

const TYPE_META = {
  customer:   { bg: '#dbeafe', color: '#1d4ed8' },
  prospect:   { bg: '#ede9fe', color: '#5b21b6' },
  partner:    { bg: '#d1fae5', color: '#065f46' },
  competitor: { bg: '#fee2e2', color: '#dc2626' },
  other:      { bg: '#f3f4f6', color: '#6b7280' },
};
const tm = t => TYPE_META[(t || '').toLowerCase()] || TYPE_META.other;

const STAGE_META = {
  won:           { bg: '#dcfce7', color: '#16a34a' },
  lost:          { bg: '#fee2e2', color: '#dc2626' },
  qualification: { bg: '#ede9fe', color: '#5b21b6' },
  proposal:      { bg: '#dbeafe', color: '#1d4ed8' },
  negotiation:   { bg: '#ede9fe', color: '#6B3FDB' },
};
const stageMeta = s => STAGE_META[(s || '').toLowerCase()] || { bg: '#f3f4f6', color: '#6b7280' };

// ── tabs ──────────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'overview',      label: 'Overview',      icon: Building2 },
  { key: 'contacts',      label: 'Contacts',       icon: Users },
  { key: 'products',      label: 'Products Bought', icon: Package },
  { key: 'opportunities', label: 'Opportunities',  icon: Target },
  { key: 'team',          label: 'Account Team',   icon: UserCog },
  { key: 'hierarchy',     label: 'Hierarchy',      icon: Network },
  { key: 'activity',      label: 'Activity',       icon: Activity },
];

// ── Products-bought panel ─────────────────────────────────────────────────────
// What this customer has actually bought — the line items behind the invoices
// and sales orders, with the date and the price they paid. Keyed on the party,
// not the account, because invoices/orders/quotations all carry `customer_id`
// pointing at `parties` (the canonical customer master); `accounts` is its
// CRM-side extension and holds no documents of its own.
//
// Lives in its own component so it fetches only when the tab is opened, and so a
// customer with a long order history never slows down the Overview tab.
function ProductsPanel({ partyId }) {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(true);
  const [view, setView]       = useState('products'); // products | lines | quotes

  useEffect(() => {
    if (!partyId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api.get(`/crm/customer360/${partyId}/products`)
      .then(r => { if (!cancelled) setData(r.data); })
      // Surfaced rather than swallowed: an empty table would read as "this
      // customer has never bought anything", which is a different claim.
      .catch(e => { if (!cancelled) setError(e?.response?.data?.error || 'Could not load purchase history'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [partyId]);

  if (!partyId) {
    return (
      <div className="ad-empty">
        <Package size={36} color="#d1d5db" />
        <p>This account is not linked to a customer record yet, so it has no orders or invoices.</p>
      </div>
    );
  }
  if (loading) return <div className="ad-center" style={{ padding: 40 }}><div className="ad-spinner" /></div>;
  if (error)   return <div className="ad-err" style={{ margin: 0 }}>{error}</div>;

  const s        = data?.summary  || {};
  const products = data?.products || [];
  const lines    = data?.lines    || [];
  const quotes   = data?.quotes   || [];

  const VIEWS = [
    { key: 'products', label: `Products (${products.length})` },
    { key: 'lines',    label: `Every Line (${lines.length})` },
    { key: 'quotes',   label: `Quoted (${quotes.length})` },
  ];

  const th = { padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
  const thR = { ...th, textAlign: 'right' };
  const td = { padding: '9px 12px', fontSize: 12.5, color: '#374151', borderBottom: '1px solid #f5f5f9' };
  const tdR = { ...td, textAlign: 'right' };

  const productLink = (row) => row.item_id
    ? (
      <button
        onClick={() => navigate(`/ItemDetail?id=${row.item_id}`)}
        title="Open this component — vendors, prices and purchase history"
        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: '#6B3FDB', fontWeight: 600, cursor: 'pointer', textAlign: 'left' }}
      >
        {row.product_name}
      </button>
    )
    : row.product_name;

  return (
    <div>
      <div className="ad-panel-hd">
        <span className="ad-panel-count">
          {s.product_count || 0} distinct product{s.product_count === 1 ? '' : 's'} ·{' '}
          {fmt(s.total_value)} billed/ordered ·{' '}
          {s.first_purchase ? `${fmtDate(s.first_purchase)} → ${fmtDate(s.last_purchase)}` : 'no dated purchases'}
        </span>
      </div>

      <div className="ad-tabs" style={{ marginBottom: 12 }}>
        {VIEWS.map(v => (
          <button key={v.key} className={`ad-tab${view === v.key ? ' ad-tab-active' : ''}`} onClick={() => setView(v.key)}>
            {v.label}
          </button>
        ))}
      </div>

      {view === 'products' && (products.length === 0 ? (
        <div className="ad-empty"><Package size={36} color="#d1d5db" /><p>No products invoiced or ordered yet</p></div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: '#fafafa' }}>
              <th style={th}>Product</th><th style={th}>Code</th><th style={th}>Unit</th>
              <th style={thR}>Times</th><th style={thR}>Total Qty</th><th style={thR}>Last Price</th>
              <th style={thR} title="Total value divided by total quantity. It can differ from the unit prices beside it when a line amount carries a discount or was overridden.">Avg Realised</th><th style={thR}>Lowest</th><th style={thR}>Highest</th>
              <th style={thR}>Total Value</th><th style={th}>First</th><th style={th}>Latest</th>
            </tr></thead>
            <tbody>
              {products.map((p, i) => (
                <tr key={p.item_id ?? `${p.product_name}-${i}`}>
                  <td style={{ ...td, fontWeight: 600, color: '#111827' }}>{productLink(p)}</td>
                  <td style={{ ...td, fontFamily: 'monospace', color: '#6B3FDB' }}>{p.item_code || '—'}</td>
                  <td style={td}>{p.unit || '—'}</td>
                  <td style={tdR}>{p.line_count}</td>
                  <td style={tdR}>{fmtQty(p.total_qty)}</td>
                  <td style={{ ...tdR, fontWeight: 700, color: '#111827' }}>{fmtRs(p.last_price)}</td>
                  <td style={tdR}>{fmtRs(p.avg_price)}</td>
                  <td style={tdR}>{fmtRs(p.min_price)}</td>
                  <td style={tdR}>{fmtRs(p.max_price)}</td>
                  <td style={{ ...tdR, fontWeight: 700 }}>{fmt(p.total_value)}</td>
                  <td style={td}>{fmtDate(p.first_purchased)}</td>
                  <td style={td}>{fmtDate(p.last_purchased)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {view === 'lines' && (lines.length === 0 ? (
        <div className="ad-empty"><FileText size={36} color="#d1d5db" /><p>No invoice or order lines yet</p></div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: '#fafafa' }}>
              <th style={th}>Document</th><th style={th}>Type</th><th style={th}>Date</th>
              <th style={th}>Product</th><th style={thR}>Qty</th><th style={th}>Unit</th>
              <th style={thR}>Unit Price</th><th style={thR}>Amount</th><th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.doc_type}-${l.doc_id}-${i}`}>
                  <td style={{ ...td, fontFamily: 'monospace', color: '#6B3FDB', fontWeight: 600 }}>{l.doc_number || `#${l.doc_id}`}</td>
                  <td style={td}>{l.doc_type}</td>
                  <td style={td}>{fmtDate(l.doc_date)}</td>
                  <td style={{ ...td, fontWeight: 600, color: '#111827' }}>{productLink(l)}</td>
                  <td style={tdR}>{fmtQty(l.quantity)}</td>
                  <td style={td}>{l.unit || '—'}</td>
                  <td style={{ ...tdR, fontWeight: 700 }}>{fmtRs(l.unit_price)}</td>
                  <td style={tdR}>{fmtRs(l.amount)}</td>
                  <td style={{ ...td, textTransform: 'capitalize' }}>{l.status || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {view === 'quotes' && (quotes.length === 0 ? (
        <div className="ad-empty"><FileText size={36} color="#d1d5db" /><p>Nothing quoted to this customer yet</p></div>
      ) : (
        <>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>
            Quoted, not bought — these lines are deliberately excluded from the totals above.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#fafafa' }}>
                <th style={th}>Quotation</th><th style={th}>Date</th><th style={th}>Valid Till</th>
                <th style={th}>Product</th><th style={thR}>Qty</th><th style={thR}>Unit Price</th>
                <th style={thR}>Amount</th><th style={th}>Status</th>
              </tr></thead>
              <tbody>
                {quotes.map((qn, i) => (
                  <tr key={`${qn.doc_id}-${i}`}>
                    <td style={{ ...td, fontFamily: 'monospace', color: '#6B3FDB', fontWeight: 600 }}>{qn.doc_number || `#${qn.doc_id}`}</td>
                    <td style={td}>{fmtDate(qn.doc_date)}</td>
                    <td style={td}>{fmtDate(qn.validity_date)}</td>
                    <td style={{ ...td, fontWeight: 600, color: '#111827' }}>{productLink(qn)}</td>
                    <td style={tdR}>{fmtQty(qn.quantity)}</td>
                    <td style={{ ...tdR, fontWeight: 700 }}>{fmtRs(qn.unit_price)}</td>
                    <td style={tdR}>{fmtRs(qn.amount)}</td>
                    <td style={{ ...td, textTransform: 'capitalize' }}>{qn.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ))}
    </div>
  );
}

// ── Contact form ──────────────────────────────────────────────────────────────
const emptyContact = () => ({ full_name: '', email: '', phone: '', designation: '' });

function ContactForm({ accountId, onSaved, onClose }) {
  const [form, setForm] = useState(emptyContact());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // The contacts API's contract is first_name / last_name — the list, the
  // search and its ORDER BY all key on them, and it composes full_name itself.
  // This modal keeps one box because the account view shows a single name line,
  // so split here: first word is the given name, the rest is the surname. A
  // one-word name is a valid contact (last_name is optional server-side).
  const submit = async () => {
    const parts = form.full_name.trim().split(' ').filter(Boolean);
    if (parts.length === 0) { setErr('Name is required'); return; }
    const [first, ...rest] = parts;
    setSaving(true);
    setErr('');
    try {
      await api.post('/crm/contacts', {
        first_name:  first,
        last_name:   rest.join(' '),
        email:       form.email.trim(),
        phone:       form.phone.trim(),
        designation: form.designation,
        account_id:  accountId,
      });
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

// ── Account team panel ────────────────────────────────────────────────────────
// The `crm_team_members` table and its `/crm/team` CRUD shipped with no UI at
// all, which is the whole reason the table was empty (manual §157.1). Selling to
// an enterprise account is never a one-owner job: `accounts.assigned_to` answers
// "who is credited", this answers "who is actually on it, and what may they
// change".
//
// POST /crm/team upserts on (parent, employee), so re-adding somebody already on
// the team silently changes their role rather than erroring — the copy below
// says so, because a form that looks like it did nothing is worse than one that
// refuses.
const TEAM_ROLES = [
  { key: 'owner',             label: 'Owner' },
  { key: 'sales_lead',        label: 'Sales Lead' },
  { key: 'technical',         label: 'Technical' },
  { key: 'commercial',        label: 'Commercial' },
  { key: 'executive_sponsor', label: 'Executive Sponsor' },
  { key: 'support',           label: 'Support' },
  { key: 'contributor',       label: 'Contributor' },
];
const ROLE_LABEL = Object.fromEntries(TEAM_ROLES.map(r => [r.key, r.label]));

// Owner and sales lead carry the deal; everyone else is support colour. Keeps
// the roster scannable at a glance instead of seven equal-weight chips.
const ROLE_TONE = {
  owner:             { bg: '#ede9fe', color: '#5b21b6' },
  sales_lead:        { bg: '#ede9fe', color: '#5b21b6' },
  executive_sponsor: { bg: '#fef3c7', color: '#92400e' },
};
const roleTone = r => ROLE_TONE[r] || { bg: '#f3f4f6', color: '#4b5563' };

function TeamPanel({ accountId, showToast }) {
  const [rows,      setRows]      = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [adding,    setAdding]    = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [pick,      setPick]      = useState({ employee_id: '', team_role: 'contributor', access_level: 'read' });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [teamRes, empRes] = await Promise.allSettled([
      api.get('/crm/team', { params: { account_id: accountId } }),
      api.get('/employees', { params: { status: 'active', limit: 500 } }),
    ]);

    if (teamRes.status === 'fulfilled') {
      setRows(Array.isArray(teamRes.value.data?.data) ? teamRes.value.data.data : []);
    } else {
      // A read failure has to say so. Rendering an empty roster over a 403 or a
      // 500 tells the user this account has no team, which is a different fact.
      setRows([]);
      setError(teamRes.reason?.response?.data?.error || 'Could not load the account team');
    }

    if (empRes.status === 'fulfilled') {
      const ed = empRes.value.data;
      setEmployees(Array.isArray(ed) ? ed : Array.isArray(ed?.employees) ? ed.employees : []);
    }
    setLoading(false);
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const onTeam = new Set(rows.map(r => r.employee_id));

  const submit = async () => {
    const employeeId = parseInt(pick.employee_id, 10);
    if (!Number.isInteger(employeeId)) { showToast('Pick an employee first', 'error'); return; }
    setSaving(true);
    try {
      const wasOn = onTeam.has(employeeId);
      await api.post('/crm/team', {
        account_id: accountId,
        employee_id: employeeId,
        team_role: pick.team_role,
        access_level: pick.access_level,
      });
      setPick({ employee_id: '', team_role: 'contributor', access_level: 'read' });
      setAdding(false);
      await load();
      showToast(wasOn ? 'Role updated — they were already on this team' : 'Added to the account team');
    } catch (err) {
      showToast(err.response?.data?.error || 'Could not add them to the team', 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row) => {
    try {
      await api.delete(`/crm/team/${row.id}`);
      await load();
      showToast(`${row.employee_name || 'Member'} removed from the team`);
    } catch (err) {
      showToast(err.response?.data?.error || 'Could not remove them', 'error');
    }
  };

  if (loading) return <div className="ad-center" style={{ padding: 40 }}><div className="ad-spinner" /></div>;

  return (
    <div>
      <div className="ad-panel-hd">
        <span className="ad-panel-count">
          {rows.length} team member{rows.length !== 1 ? 's' : ''}
        </span>
        {!adding && (
          <button className="ad-btn-primary" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add Member
          </button>
        )}
      </div>

      {error && <div className="ad-err">{error}</div>}

      {adding && (
        <div className="ad-team-form">
          <select
            className="ad-team-select"
            value={pick.employee_id}
            onChange={e => setPick(p => ({ ...p, employee_id: e.target.value }))}
            aria-label="Employee"
          >
            <option value="">Choose an employee…</option>
            {employees.map(e => (
              <option key={e.id} value={e.id}>
                {e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim() || `Employee ${e.id}`}
                {onTeam.has(e.id) ? ' — already on team' : ''}
              </option>
            ))}
          </select>
          <select
            className="ad-team-select"
            value={pick.team_role}
            onChange={e => setPick(p => ({ ...p, team_role: e.target.value }))}
            aria-label="Team role"
          >
            {TEAM_ROLES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <select
            className="ad-team-select"
            value={pick.access_level}
            onChange={e => setPick(p => ({ ...p, access_level: e.target.value }))}
            aria-label="Access level"
          >
            <option value="read">Read only</option>
            <option value="edit">Can edit</option>
          </select>
          <button className="ad-btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : 'Add'}
          </button>
          <button className="ad-btn-outline" onClick={() => { setAdding(false); setPick({ employee_id: '', team_role: 'contributor', access_level: 'read' }); }}>
            Cancel
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="ad-empty">
          <Users size={36} color="#d1d5db" />
          <p>No one is on this account team yet</p>
          {!adding && (
            <button className="ad-btn-primary" onClick={() => setAdding(true)}><Plus size={14} /> Add Member</button>
          )}
        </div>
      ) : (
        <div className="ad-contact-list">
          {rows.map(m => {
            const tone = roleTone(m.team_role);
            return (
              <div key={m.id} className="ad-contact-card">
                <div className="ad-contact-avatar" style={{ background: avatarColor(m.employee_name) }}>
                  {getInitials(m.employee_name)}
                </div>
                <div className="ad-contact-info-col">
                  <span className="ad-contact-name">{m.employee_name || `Employee ${m.employee_id}`}</span>
                  {m.designation && <span className="ad-contact-role">{m.designation}</span>}
                </div>
                {/* Its own class, not `.ad-contact-links`: that one stacks in a
                    column on purpose (email over phone on the Contacts tab).
                    A role + access pair reads as a row. */}
                <div className="ad-team-tags">
                  <span className="ad-badge" style={{ background: tone.bg, color: tone.color }}>
                    {ROLE_LABEL[m.team_role] || m.team_role}
                  </span>
                  <span className="ad-badge" style={{ background: m.access_level === 'edit' ? '#dcfce7' : '#f3f4f6', color: m.access_level === 'edit' ? '#166534' : '#6b7280' }}>
                    {m.access_level === 'edit' ? 'Can edit' : 'Read only'}
                  </span>
                  {m.company_email && (
                    <a href={`mailto:${m.company_email}`} className="ad-contact-chip"><Mail size={12} />{m.company_email}</a>
                  )}
                </div>
                <button className="ad-icon-btn" onClick={() => remove(m)} title="Remove from team" aria-label={`Remove ${m.employee_name || 'member'} from team`}>
                  <X size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Account hierarchy panel ───────────────────────────────────────────────────
// Parent/child accounts — a group buying through several subsidiaries is one
// customer commercially and several rows in `accounts`. The endpoint returns the
// whole family from the ROOT down (not just this account's children), with
// pipeline rolled up per node, so a subsidiary page shows the group it sits in.
//
// The server has a DB trigger that refuses a self-parent, a cycle, and excess
// depth, and reports all three as a readable 400 — so the picker offers every
// account and lets the server be the authority rather than guessing here.
function HierarchyPanel({ accountId, showToast, onChanged }) {
  const [tree,     setTree]     = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [editing,  setEditing]  = useState(false);
  const [parentId, setParentId] = useState('');
  const [saving,   setSaving]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [hRes, aRes] = await Promise.allSettled([
      api.get(`/crm/accounts/${accountId}/hierarchy`),
      api.get('/crm/accounts'),
    ]);

    if (hRes.status === 'fulfilled') {
      setTree(hRes.value.data);
      const me = (hRes.value.data?.nodes || []).find(n => n.id === Number(accountId));
      setParentId(me?.parent_account_id == null ? '' : String(me.parent_account_id));
    } else {
      setTree(null);
      setError(hRes.reason?.response?.data?.error || 'Could not load the account hierarchy');
    }

    if (aRes.status === 'fulfilled') {
      const raw = aRes.value.data?.accounts ?? aRes.value.data;
      setAccounts(Array.isArray(raw) ? raw : []);
    }
    setLoading(false);
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/crm/accounts/${accountId}/parent`, {
        parent_account_id: parentId === '' ? null : Number(parentId),
      });
      setEditing(false);
      await load();
      onChanged?.();
      showToast(parentId === '' ? 'Account is now a top-level account' : 'Parent account updated');
    } catch (err) {
      // The trigger's message is the useful one ("would create a cycle", …).
      showToast(err.response?.data?.error || 'Could not change the parent account', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="ad-center" style={{ padding: 40 }}><div className="ad-spinner" /></div>;
  if (error)   return <div className="ad-err" style={{ margin: 0 }}>{error}</div>;

  const nodes  = tree?.nodes || [];
  const totals = tree?.totals || {};

  return (
    <div>
      <div className="ad-panel-hd">
        <span className="ad-panel-count">
          {nodes.length} account{nodes.length !== 1 ? 's' : ''} in this group
        </span>
        {!editing && (
          <button className="ad-btn-primary" onClick={() => setEditing(true)}>
            <Edit2 size={14} /> Set Parent
          </button>
        )}
      </div>

      {editing && (
        <div className="ad-team-form">
          <select
            className="ad-team-select"
            style={{ flex: 1 }}
            value={parentId}
            onChange={e => setParentId(e.target.value)}
            aria-label="Parent account"
          >
            <option value="">— No parent (top-level account) —</option>
            {accounts
              .filter(a => a.id !== Number(accountId))
              .map(a => <option key={a.id} value={a.id}>{a.name || a.account_name}</option>)}
          </select>
          <button className="ad-btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="ad-btn-outline" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      )}

      {/* Group roll-up — the number a parent account cannot get from its own row */}
      <div className="ad-kpi-strip" style={{ marginBottom: 14 }}>
        <div className="ad-kpi">
          <span className="ad-kpi-label">Accounts</span>
          <span className="ad-kpi-val">{totals.accounts ?? nodes.length}</span>
        </div>
        <div className="ad-kpi">
          <span className="ad-kpi-label">Opportunities</span>
          <span className="ad-kpi-val">{totals.opportunity_count ?? 0}</span>
        </div>
        <div className="ad-kpi">
          <span className="ad-kpi-label">Open Pipeline</span>
          <span className="ad-kpi-val">{fmt(totals.open_pipeline || 0)}</span>
        </div>
        <div className="ad-kpi ad-kpi-green">
          <span className="ad-kpi-label">Won</span>
          <span className="ad-kpi-val">{fmt(totals.won_value || 0)}</span>
        </div>
      </div>

      {nodes.length === 0 ? (
        <div className="ad-empty">
          <Building2 size={36} color="#d1d5db" />
          <p>No hierarchy for this account</p>
        </div>
      ) : (
        <div className="ad-tree">
          {nodes.map(n => {
            const isSelf = n.id === Number(accountId);
            return (
              <div
                key={n.id}
                className={`ad-tree-node${isSelf ? ' ad-tree-node--self' : ''}`}
                style={{ marginLeft: (n.depth || 0) * 22 }}
              >
                {n.depth > 0 && <span className="ad-tree-elbow" aria-hidden="true" />}
                <Building2 size={14} className="ad-tree-icon" />
                <span className="ad-tree-name">{n.name}</span>
                {isSelf && <span className="ad-badge" style={{ background: '#ede9fe', color: '#5b21b6' }}>This account</span>}
                {n.account_type && <span className="ad-tree-meta">{n.account_type}</span>}
                <span className="ad-tree-nums">
                  {n.opportunity_count || 0} opp{(n.opportunity_count || 0) !== 1 ? 's' : ''}
                  {' · '}
                  {fmt(n.open_pipeline || 0)} open
                </span>
              </div>
            );
          })}
        </div>
      )}
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
    <PageShell dock={
      <PageHero
        icon={Contact}
        eyebrow="CRM"
        title={account.name || account.account_name}
        subtitle="Annual Revenue"
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={() => navigate('/Accounts')}>
            <ArrowLeft size={16} /> Accounts
          </button>
          {/* accounts.party_id is the link to the canonical customer master —
              without it Customer 360 has nothing to key on, so the button is
              only offered when the account is actually linked. */}
          {account.party_id && (
            <button className="plh-cta" onClick={() => navigate(`/Customer360?party_id=${account.party_id}`)}>
              <LayoutDashboard size={16} /> Customer 360°
            </button>
          )}
        </>}
      />
    }>
      {toast && <div className={`ad-toast ad-toast-${toast.type}`}>{toast.msg}</div>}

      {/* header */}


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

        {/* ── Products Bought ── */}
        {tab === 'products' && <ProductsPanel partyId={account.party_id} />}

        {/* ── Account Team ── */}
        {tab === 'team' && <TeamPanel accountId={accountId} showToast={showToast} />}

        {/* ── Hierarchy ── */}
        {tab === 'hierarchy' && (
          <HierarchyPanel accountId={accountId} showToast={showToast} onChanged={load} />
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
    </PageShell>
  );
}
