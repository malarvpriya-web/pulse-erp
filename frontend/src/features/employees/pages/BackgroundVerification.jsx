// ──────────────────────────────────────────────────────────────────────────────
// Employees → Background Verification
//
// Five tabs over /api/bgv: Dashboard · Employees · Agencies · Costs · Reports.
// Notes and the design rules live in features/employees/BGV_NOTES.md.
//
// ⚠ EVERY component in this file is declared at MODULE level, never inside
// another component's body. A `const Row = …` inside a render creates a NEW
// component type on every render, so React unmounts and remounts the whole
// subtree on each keystroke — which in AddEmployee lost every field's focus and
// made MasterSelect refetch its list, and which the jsdom test did not catch.
// [[project_employee_foundation_final_audit_2026-09-29]]
//
// ⚠ A KPI card carries the FILTER the backend used to count it and applies
// exactly that filter to the Employees tab. There is no card that opens an
// unfiltered list and no filter the API does not really apply.
// ──────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ShieldCheck, Search, RefreshCw, Download, Plus, Eye, X,
  Building2, Wallet, FileBarChart, LayoutDashboard, Users, AlertTriangle, Pencil,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { display } from '../displayValue';
import {
  CASE_STATUSES, badgeFor, money, shortDate, monthLabel,
} from '../bgv';
import './BackgroundVerification.css';

const TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'employees', label: 'Employee BGV', icon: Users },
  { key: 'agencies',  label: 'Agencies',    icon: Building2 },
  { key: 'costs',     label: 'Cost Tracking', icon: Wallet },
  { key: 'reports',   label: 'Reports',     icon: FileBarChart },
];

/** The filter keys the API understands. Anything else is not sent. */
const EMPTY_FILTERS = {
  search: '', department: '', designation: '', status: '', agency_id: '',
  check_type: '', check_status: '', check_result: '',
  joined_from: '', joined_to: '', from: '', to: '',
  cost_min: '', cost_max: '', pending_reports: '', overdue: '', unpaid: '',
  // Set by the "Employees Under BGV" card. Listed here so a KPI filter is always
  // cleared by "Clear filters" and by the next card click — a filter the reset
  // object does not know about sticks invisibly and the list stops matching the
  // card the user just pressed.
  has_checks: '',
};

/** Drop the blanks — an empty string must not become a filter the API applies. */
const cleanFilters = (f) =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v != null));

const Badge = ({ value }) => {
  if (!value) return <span>—</span>;
  const { bg, color } = badgeFor(value);
  return <span className="bgv-badge" style={{ background: bg, color }}>{value}</span>;
};

const Field = ({ label, children }) => (
  <div className="bgv-field">
    <label>{label}</label>
    {children}
  </div>
);

/**
 * One KPI card. A <button>, because it does something.
 * `filter` is the API filter the backend used for this number.
 */
const KpiCard = ({ label, value, filter, active, onPick }) => (
  <button
    type="button"
    className={`bgv-kpi${active ? ' is-active' : ''}`}
    onClick={() => onPick(filter)}
    title={Object.keys(filter || {}).length ? 'Open this list' : 'Open the full list'}
  >
    <span className="bgv-kpi-val">{value ?? 0}</span>
    <span className="bgv-kpi-label">{label}</span>
  </button>
);

/** A labelled horizontal bar list — spend by agency / type / month / department. */
const BarList = ({ title, rows, labelKey = 'label', valueKey = 'amount', format = money, empty }) => {
  const max = Math.max(1, ...rows.map(r => Math.abs(Number(r[valueKey]) || 0)));
  return (
    <div className="bgv-card">
      <h3 className="bgv-card-title">{title}</h3>
      {rows.length === 0 && <p className="bgv-note" style={{ margin: 0 }}>{empty}</p>}
      {rows.map((r, i) => (
        <div className="bgv-bar-row" key={`${r[labelKey]}-${i}`}>
          <div>
            <div className="bgv-bar-label">{display(r[labelKey])}</div>
            <div className="bgv-bar-track">
              <div className="bgv-bar-fill" style={{ width: `${(Math.abs(Number(r[valueKey]) || 0) / max) * 100}%` }} />
            </div>
          </div>
          <div className="bgv-bar-val">{format(r[valueKey])}</div>
        </div>
      ))}
    </div>
  );
};

const AGENCY_BLANK = {
  agency_name: '', contact_person: '', email: '', phone: '', address: '',
  website: '', gstin: '', services: [], is_active: true, notes: '',
};

/**
 * Add / edit an agency.
 *
 * `services` is the list of check types this vendor performs, chosen from the
 * SAME master vocabulary the checks use (BGV_CHECK_TYPE) — not a second list, so
 * a type added in Master Data becomes selectable here at once.
 */
function AgencyModal({ initial, checkTypes, onClose, onSaved, setPage }) {
  const [form, setForm] = useState(() => ({ ...AGENCY_BLANK, ...(initial || {}),
    services: Array.isArray(initial?.services) ? initial.services : [] }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const toggleService = (name) => setForm(f => ({
    ...f,
    services: f.services.includes(name) ? f.services.filter(s => s !== name) : [...f.services, name],
  }));

  const save = async () => {
    if (!form.agency_name.trim()) { setError('Agency name is required.'); return; }
    // `saving` gates the submit as well as the label: without the guard a second
    // click fires a second POST and the 409 that follows reads as a save failure.
    if (saving) return;
    setSaving(true); setError('');
    try {
      if (initial?.id) await api.put(`/bgv/agencies/${initial.id}`, form);
      else await api.post('/bgv/agencies', form);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the agency.');
    } finally { setSaving(false); }
  };

  return (
    <div className="bgv-modal-mask" onClick={onClose}>
      <div className="bgv-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="bgv-modal-title">{initial?.id ? 'Edit agency' : 'New verification agency'}</h3>
        <p className="bgv-note">
          The vendor that performs the checks. Re-use an existing agency wherever you
          can — a second row for the same firm splits its spend across two records.
        </p>
        {error && <p className="bgv-danger" style={{ fontSize: 13 }}>{error}</p>}
        <div className="bgv-filters" style={{ marginBottom: 12 }}>
          <Field label="Agency name *"><input value={form.agency_name} onChange={set('agency_name')} /></Field>
          <Field label="Contact person"><input value={form.contact_person || ''} onChange={set('contact_person')} /></Field>
          <Field label="Email"><input type="email" value={form.email || ''} onChange={set('email')} /></Field>
          <Field label="Phone"><input value={form.phone || ''} onChange={set('phone')} /></Field>
          <Field label="Website"><input value={form.website || ''} onChange={set('website')} /></Field>
          <Field label="GSTIN"><input value={form.gstin || ''} onChange={set('gstin')} maxLength={15} /></Field>
        </div>
        <Field label="Address">
          <textarea rows={2} value={form.address || ''} onChange={set('address')} />
        </Field>
        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase', color: '#6b7280' }}>
            Check types supported
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {checkTypes.map(t => (
              <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#374151' }}>
                <input type="checkbox" checked={form.services.includes(t)} onChange={() => toggleService(t)} />
                {t}
              </label>
            ))}
            {checkTypes.length === 0 && (
              <span className="bgv-note" style={{ margin: 0 }}>
                No check types in the master yet — add them under Master Data → BGV Check Type.
              </span>
            )}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="Notes"><textarea rows={2} value={form.notes || ''} onChange={set('notes')} /></Field>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 13, color: '#374151' }}>
          <input type="checkbox" checked={form.is_active !== false}
                 onChange={(e) => setForm(f => ({ ...f, is_active: e.target.checked }))} />
          Active — offered when creating a verification
        </label>
        <div className="bgv-modal-actions">
          <button type="button" className="bgv-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="bgv-btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : initial?.id ? 'Save changes' : 'Create agency'}
          </button>
        </div>
        {setPage && (
          <p className="bgv-note" style={{ marginTop: 10, marginBottom: 0 }}>
            Check types are master data — manage the list under{' '}
            <button type="button" className="bgv-file-name"
                    onClick={() => setPage('EmployeeMasters')}>Employee Masters</button>.
          </p>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function BackgroundVerification({ setPage, urlParams }) {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('bgv', 'edit');
  const canAdd = hasPermission('bgv', 'add');
  const canExport = hasPermission('bgv', 'export');
  // The Discrepancy Report names every employee with a finding, so it needs the
  // same grant the findings themselves do. Offering a button that can only 403
  // is worse than not offering it.
  const canSeeSensitive = hasPermission('bgv_sensitive', 'view');

  // Deep-linkable tab, validated against TABS — an unknown ?tab= would render a
  // header with no body underneath.
  const [tab, setTab] = useState(() =>
    TABS.some(t => t.key === urlParams?.tab) ? urlParams.tab : 'dashboard');

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [dash, setDash] = useState(null);
  const [cases, setCases] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [costs, setCosts] = useState([]);
  const [checkTypes, setCheckTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [agencyModal, setAgencyModal] = useState(null); // null | {} | row
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const query = useMemo(() => cleanFilters(filters), [filters]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [d, c, a, k, types] = await Promise.all([
        api.get('/bgv/dashboard', { params: query }),
        api.get('/bgv/cases', { params: query }),
        api.get('/bgv/agencies'),
        api.get('/bgv/costs', { params: query }),
        api.get('/master/v/bgv-check-types'),
      ]);
      if (!mounted.current) return;
      setDash(d.data);
      setCases(Array.isArray(c.data) ? c.data : []);
      setAgencies(Array.isArray(a.data) ? a.data : []);
      setCosts(Array.isArray(k.data) ? k.data : []);
      setCheckTypes((Array.isArray(types.data) ? types.data : []).map(r => r.name).filter(Boolean));
    } catch (err) {
      // An aborted request is not an error the user needs to see; axios reports
      // it as CanceledError, not AbortError. [[project_axios_canceled_not_aborterror]]
      if (err.name === 'CanceledError') return;
      if (mounted.current) setError(err.response?.data?.message || 'Could not load background verification data.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => { mounted.current = true; load(); }, [load]);

  const set = (k) => (e) => setFilters(f => ({ ...f, [k]: e.target.value }));

  /** A KPI card was clicked: apply exactly the filter the backend counted with. */
  const applyKpi = (filter) => {
    setFilters({ ...EMPTY_FILTERS, ...(filter || {}) });
    setTab('employees');
  };

  const activeFilterCount = Object.keys(query).length;
  const departments = useMemo(
    () => [...new Set(cases.map(c => c.department).filter(Boolean))].sort(), [cases]);
  const designations = useMemo(
    () => [...new Set(cases.map(c => c.designation).filter(Boolean))].sort(), [cases]);

  const openEmployee = (employeeId) => setPage?.('EmployeeBGV', { employee_id: employeeId });

  const exportReport = async (kind) => {
    try {
      const res = await api.get(`/bgv/reports/${kind}`, { params: query, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bgv-${kind}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.message || 'The export could not be produced.');
    }
  };

  const deactivateAgency = async (row) => {
    if (!window.confirm(
      `Deactivate ${row.agency_name}?\n\nIt stops being offered on new verifications. ` +
      `Every past check keeps naming it — nothing is deleted.`)) return;
    try {
      await api.delete(`/bgv/agencies/${row.id}`);
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not deactivate the agency.');
    }
  };

  const totalSpend = dash?.spend?.total;
  const pendingPayments = dash?.spend?.pending_payments;

  const hero = (
    <PageHero
      icon={ShieldCheck}
      eyebrow="Employees"
      title="Background Verification"
      subtitle="Verification cases, checks, reports, agencies and spend — one case per employee."
      meta={[
        { label: 'under BGV', value: dash?.counts?.under_bgv ?? '—' },
        { label: 'discrepancies', value: dash?.counts?.discrepancy ?? '—', tone: (dash?.counts?.discrepancy > 0) ? 'bad' : undefined },
        { label: 'total spend', value: money(totalSpend) },
      ]}
      actions={
        <button type="button" className="plh-cta" onClick={load} disabled={loading}>
          <RefreshCw size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    />
  );

  return (
    <PageShell dock={hero}>
      <div className="bgv-tabs" role="tablist">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`bgv-tab${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <t.icon size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bgv-card" style={{ borderColor: '#fecaca', background: '#fef2f2', marginBottom: 16 }}>
          <span className="bgv-danger">{error}</span>
        </div>
      )}

      {/* ── Dashboard ───────────────────────────────────────────────────────── */}
      {tab === 'dashboard' && (
        <>
          <div className="bgv-kpis">
            {(dash?.kpis || []).map(k => (
              <KpiCard key={k.key} label={k.label} value={k.value} filter={k.filter}
                       active={false} onPick={applyKpi} />
            ))}
            <div className="bgv-kpi" style={{ cursor: 'default' }}>
              <span className="bgv-kpi-val">{money(totalSpend)}</span>
              <span className="bgv-kpi-label">Total BGV Spend</span>
            </div>
          </div>
          <p className="bgv-note">
            Every card above opens the employee list filtered to exactly the rows it counted.
            {Number(pendingPayments) > 0 && (
              <> Pending payments: <strong className="bgv-warn">{money(pendingPayments)}</strong>.</>
            )}
          </p>
          <div className="bgv-grid">
            <BarList title="Spend by agency" rows={dash?.spend?.by_agency || []}
                     empty="No verification costs recorded yet." />
            <BarList title="Spend by verification type" rows={dash?.spend?.by_check_type || []}
                     empty="No verification costs recorded yet." />
            <BarList title="Spend by month" rows={(dash?.spend?.by_month || []).map(r => ({ ...r, label: monthLabel(r.label) }))}
                     empty="No verification costs recorded yet." />
            <BarList title="Spend by department" rows={dash?.spend?.by_department || []}
                     empty="No department has BGV spend yet." />
          </div>
        </>
      )}

      {/* ── Employee BGV list ───────────────────────────────────────────────── */}
      {tab === 'employees' && (
        <>
          <div className="bgv-filters">
            <Field label="Search name / employee ID">
              <input value={filters.search} onChange={set('search')} placeholder="EMP040 or a name" />
            </Field>
            <Field label="BGV status">
              <select value={filters.status} onChange={set('status')}>
                <option value="">All statuses</option>
                {CASE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Department">
              <select value={filters.department} onChange={set('department')}>
                <option value="">All departments</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="Designation">
              <select value={filters.designation} onChange={set('designation')}>
                <option value="">All designations</option>
                {designations.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="Agency">
              <select value={filters.agency_id} onChange={set('agency_id')}>
                <option value="">All agencies</option>
                {agencies.map(a => <option key={a.id} value={a.id}>{a.agency_name}</option>)}
              </select>
            </Field>
            <Field label="Verification type">
              <select value={filters.check_type} onChange={set('check_type')}>
                <option value="">All types</option>
                {checkTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Check result">
              <select value={filters.check_result} onChange={set('check_result')}>
                <option value="">Any result</option>
                <option value="Pending">Pending</option>
                <option value="Clear">Clear</option>
                <option value="Discrepancy">Discrepancy</option>
                <option value="Unable to Verify">Unable to Verify</option>
              </select>
            </Field>
            <Field label="Joined from"><input type="date" value={filters.joined_from} onChange={set('joined_from')} /></Field>
            <Field label="Joined to"><input type="date" value={filters.joined_to} onChange={set('joined_to')} /></Field>
            <Field label="BGV activity from"><input type="date" value={filters.from} onChange={set('from')} /></Field>
            <Field label="BGV activity to"><input type="date" value={filters.to} onChange={set('to')} /></Field>
            <Field label="Cost min (₹)"><input type="number" min="0" value={filters.cost_min} onChange={set('cost_min')} /></Field>
            <Field label="Cost max (₹)"><input type="number" min="0" value={filters.cost_max} onChange={set('cost_max')} /></Field>
            <div className="bgv-field">
              <label>Only</label>
              <select
                value={filters.pending_reports === 'true' ? 'reports' : filters.overdue === 'true' ? 'overdue' : filters.unpaid === 'true' ? 'unpaid' : ''}
                onChange={(e) => setFilters(f => ({
                  ...f,
                  pending_reports: e.target.value === 'reports' ? 'true' : '',
                  overdue: e.target.value === 'overdue' ? 'true' : '',
                  unpaid: e.target.value === 'unpaid' ? 'true' : '',
                }))}
              >
                <option value="">No extra filter</option>
                <option value="reports">Reports missing</option>
                <option value="overdue">Overdue checks</option>
                <option value="unpaid">Unpaid verification costs</option>
              </select>
            </div>
            <div className="bgv-field">
              <label>&nbsp;</label>
              <button type="button" className="bgv-btn" onClick={() => setFilters(EMPTY_FILTERS)}>
                <X size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />Clear filters
              </button>
            </div>
          </div>

          <p className="bgv-note">
            <Search size={12} style={{ marginRight: 5, verticalAlign: '-2px' }} />
            {loading ? 'Loading…' : `${cases.length} employee${cases.length === 1 ? '' : 's'}`}
            {activeFilterCount > 0 && ` · ${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} applied`}
          </p>

          <div className="bgv-table-wrap">
            <table className="bgv-table">
              <thead>
                <tr>
                  <th>Employee ID</th><th>Employee Name</th><th>Department</th><th>Designation</th>
                  <th>Joining Date</th><th>BGV Status</th><th>Agency</th>
                  <th className="bgv-num">Done</th><th className="bgv-num">Pending</th>
                  <th className="bgv-num">Cost</th><th>Last Updated</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {cases.map(r => (
                  <tr key={r.employee_id}>
                    <td style={{ fontWeight: 700 }}>{display(r.employee_code)}</td>
                    <td>{display(r.employee_name)}</td>
                    <td>{display(r.department)}</td>
                    <td>{display(r.designation)}</td>
                    <td>{shortDate(r.joining_date)}</td>
                    <td><Badge value={r.bgv_status} /></td>
                    <td>{display(r.primary_agency_name)}</td>
                    <td className="bgv-num">{r.checks_completed}/{r.checks_total}</td>
                    <td className="bgv-num">
                      {r.checks_pending}
                      {r.reports_missing > 0 && (
                        <span className="bgv-warn" title={`${r.reports_missing} check(s) with no report attached`}> ⚑</span>
                      )}
                    </td>
                    <td className="bgv-num">{money(r.total_cost)}</td>
                    <td>{shortDate(r.last_updated)}</td>
                    <td>
                      <button type="button" className="bgv-btn bgv-btn-sm" onClick={() => openEmployee(r.employee_id)}>
                        <Eye size={12} style={{ marginRight: 4, verticalAlign: '-2px' }} />View BGV
                      </button>
                    </td>
                  </tr>
                ))}
                {!loading && cases.length === 0 && (
                  <tr><td colSpan={12} className="bgv-empty">
                    No employee matches these filters.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Agencies ────────────────────────────────────────────────────────── */}
      {tab === 'agencies' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
            <p className="bgv-note" style={{ margin: 0 }}>
              Verification vendors. Deactivating one stops it being offered; every past
              check keeps naming it, so spend history stays intact.
            </p>
            {canAdd && (
              <button type="button" className="bgv-btn-primary" onClick={() => setAgencyModal({})}>
                <Plus size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />New agency
              </button>
            )}
          </div>
          <div className="bgv-table-wrap">
            <table className="bgv-table">
              <thead>
                <tr>
                  <th>Agency</th><th>Contact</th><th>Email</th><th>Phone</th><th>GSTIN</th>
                  <th>Services</th><th className="bgv-num">Checks</th><th className="bgv-num">Billed</th>
                  <th>Status</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {agencies.map(a => (
                  <tr key={a.id} style={a.is_active ? undefined : { opacity: .6 }}>
                    <td style={{ fontWeight: 700 }}>{a.agency_name}</td>
                    <td>{display(a.contact_person)}</td>
                    <td>{display(a.email)}</td>
                    <td>{display(a.phone)}</td>
                    <td>{display(a.gstin)}</td>
                    <td style={{ maxWidth: 240, fontSize: 12 }}>
                      {Array.isArray(a.services) && a.services.length ? a.services.join(', ') : '—'}
                    </td>
                    <td className="bgv-num">{a.checks_count}</td>
                    <td className="bgv-num">{money(a.total_billed)}</td>
                    <td><Badge value={a.is_active ? 'Clear' : 'Cancelled'} /></td>
                    <td>
                      <div className="bgv-row-actions">
                        {canEdit && (
                          <button type="button" className="bgv-btn bgv-btn-sm" onClick={() => setAgencyModal(a)}>
                            <Pencil size={12} style={{ marginRight: 4, verticalAlign: '-2px' }} />Edit
                          </button>
                        )}
                        {canEdit && a.is_active && (
                          <button type="button" className="bgv-btn bgv-btn-sm" onClick={() => deactivateAgency(a)}>
                            Deactivate
                          </button>
                        )}
                        {canEdit && !a.is_active && (
                          <button type="button" className="bgv-btn bgv-btn-sm"
                                  onClick={async () => { await api.put(`/bgv/agencies/${a.id}`, { is_active: true }); load(); }}>
                            Reactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && agencies.length === 0 && (
                  <tr><td colSpan={10} className="bgv-empty">
                    No verification agency yet. Add the firm that performs your checks.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Cost tracking ───────────────────────────────────────────────────── */}
      {tab === 'costs' && (
        <>
          <div className="bgv-kpis">
            <div className="bgv-kpi" style={{ cursor: 'default' }}>
              <span className="bgv-kpi-val">{money(totalSpend)}</span>
              <span className="bgv-kpi-label">Total spend</span>
            </div>
            <div className="bgv-kpi" style={{ cursor: 'default' }}>
              <span className="bgv-kpi-val">{money(pendingPayments)}</span>
              <span className="bgv-kpi-label">Pending payments</span>
            </div>
            <div className="bgv-kpi" style={{ cursor: 'default' }}>
              <span className="bgv-kpi-val">{costs.length}</span>
              <span className="bgv-kpi-label">Checks billed / recorded</span>
            </div>
          </div>
          <p className="bgv-note">
            A dash in Amount means the cost has <strong>not been captured yet</strong> —
            it is not ₹0. Filters from the Employee BGV tab apply here too.
          </p>
          <div className="bgv-table-wrap">
            <table className="bgv-table">
              <thead>
                <tr>
                  <th>Employee ID</th><th>Employee</th><th>Department</th><th>Verification</th><th>Agency</th>
                  <th className="bgv-num">Amount</th><th className="bgv-num">Tax</th><th className="bgv-num">Total</th>
                  <th>Invoice</th><th>Payment</th><th>Paid On</th>
                </tr>
              </thead>
              <tbody>
                {costs.map(c => (
                  <tr key={c.check_id}>
                    <td style={{ fontWeight: 700 }}>{display(c.employee_code)}</td>
                    <td>{display(c.employee_name)}</td>
                    <td>{display(c.department)}</td>
                    <td>{display(c.check_type)}</td>
                    <td>{display(c.agency_name)}</td>
                    <td className="bgv-num">{money(c.amount)}</td>
                    <td className="bgv-num">{money(c.tax_amount)}</td>
                    <td className="bgv-num" style={{ fontWeight: 700 }}>{money(c.total_amount)}</td>
                    <td>{display(c.invoice_number)}</td>
                    <td><Badge value={c.payment_status} /></td>
                    <td>{shortDate(c.payment_date)}</td>
                  </tr>
                ))}
                {!loading && costs.length === 0 && (
                  <tr><td colSpan={11} className="bgv-empty">No verification checks match these filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Reports ─────────────────────────────────────────────────────────── */}
      {tab === 'reports' && (
        <div className="bgv-card">
          <h3 className="bgv-card-title">Exports</h3>
          <p className="bgv-note">
            Each export runs with <strong>the filters currently set on the Employee BGV
            tab</strong> — {activeFilterCount === 0 ? 'none are set, so these cover everyone' : `${activeFilterCount} applied`}.
            {!canExport && <> <span className="bgv-warn">Your role cannot export BGV data.</span></>}
            {canExport && !canSeeSensitive && (
              <> <span className="bgv-warn">The Discrepancy Report is restricted to HR Manager / Admin roles.</span></>
            )}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {[
              ['employees',   'BGV Employee Report', false],
              ['cost',        'BGV Cost Report', false],
              ['agency',      'Agency-wise Report', false],
              ['pending',     'Pending Verification Report', false],
              ['discrepancy', 'Discrepancy Report', true],
            ].map(([kind, label, sensitive]) => {
              const blocked = !canExport || (sensitive && !canSeeSensitive);
              return (
                <button key={kind} type="button" className="bgv-btn" disabled={blocked}
                        title={sensitive && !canSeeSensitive
                          ? 'Restricted to HR Manager / Admin roles'
                          : undefined}
                        onClick={() => exportReport(kind)}>
                  <Download size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />{label}
                </button>
              );
            })}
          </div>
          {Number(dash?.counts?.discrepancy) > 0 && (
            <p className="bgv-note" style={{ marginTop: 14, marginBottom: 0 }}>
              <AlertTriangle size={13} className="bgv-danger" style={{ marginRight: 5, verticalAlign: '-2px' }} />
              <span className="bgv-danger">{dash.counts.discrepancy}</span> employee case(s) carry a discrepancy.
              {!canSeeSensitive && ' The findings are restricted to HR Manager / Admin roles.'}
            </p>
          )}
        </div>
      )}

      {agencyModal && (
        <AgencyModal
          initial={agencyModal.id ? agencyModal : null}
          checkTypes={checkTypes}
          setPage={setPage}
          onClose={() => setAgencyModal(null)}
          onSaved={() => { setAgencyModal(null); load(); }}
        />
      )}
    </PageShell>
  );
}
