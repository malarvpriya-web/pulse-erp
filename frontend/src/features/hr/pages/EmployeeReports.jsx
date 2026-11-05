// frontend/src/features/hr/pages/EmployeeReports.jsx
/**
 * Workforce Analytics & Reports — stage 1.
 *
 * Everything on the page comes from GET /analytics/workforce (one company-scoped
 * source, the same one the Employees Dashboard counts from). Rules the page keeps:
 *
 *  · Composition (department, status, designation, …) is the CURRENT workforce,
 *    as of today. The period only moves the joining and exit trends — said on
 *    the page, and the period control is labelled for exactly that.
 *  · Every breakdown states how many records it is drawn from ("12 of 31
 *    recorded"). Blanks are never drawn as a bar; they are counted beside the
 *    chart. Below `minSample` recorded values there is no chart at all — a
 *    plain list instead — and a field nobody has filled says so.
 *  · Salary is not here. It needs payroll:view and its own endpoint (a later stage).
 *  · The route requires hr:view. Drill-through to All Employees needs
 *    employees:view as well: without it the charts are read-only — no clickable
 *    bars, no "open" buttons.
 *  · The Reports & Exports links below are the page's existing downloads and
 *    stay until that section is rebuilt and tested on its own.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  BarChart3, Users, UserX, FileText, ArrowRight, RefreshCw, AlertTriangle, Info, Download,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell, DashboardFilterBar } from '@/components/pulse-ui';
import useDashboardFilters from '@/hooks/useDashboardFilters';
import { BUCKET_COLORS } from '@/features/employees/employeeStatus';
import { setEmployeeListFilter, NOT_RECORDED } from '@/features/employees/employeeListFilter';
import { downloadCsv, maskAadhaarInText } from '@/features/employees/csvExport';
import { localDay } from '@/utils/dateFormatter';
import './EmployeeReports.css';

/**
 * Where the old CSV cards went (kept as-is in this stage).
 *
 * `module` is the permission each destination route is gated on in routes.jsx
 * (null = the route has no module gate). A link the user cannot open is hidden
 * rather than shown and dead-ended on Access Denied.
 */
export const REPORT_LINKS = [
  { page: 'EmployeesData',     module: 'employees', icon: Users,    label: 'All Employees',
    desc: 'Current headcount — filter by department, status and more, then export the filtered list as CSV.' },
  { page: 'ExEmployees',       module: 'employees', icon: UserX,    label: 'Ex-Employees',
    desc: 'Attrition — exits with reason, date, exit interview and F&F status, filterable by exit date and exportable.' },
  { page: 'EmployeeDocuments', module: 'employee_documents', icon: FileText, label: 'Employee Documents',
    desc: 'Document expiry — filter to expired or expiring documents and use "Export filtered".' },
];

/** Composition cards, in display order. `drill` = the All Employees filter key, if it can express the bucket. */
export const COMPOSITION = [
  { key: 'department',        title: 'Department',         drill: 'department' },
  { key: 'status',            title: 'Employee Status',    drill: 'status' },
  { key: 'designation',       title: 'Designation',        drill: 'designation' },
  { key: 'employmentType',    title: 'Employment Type',    drill: 'employmentType' },
  // No drill: the breakdown carries the category NAME and the employee list holds
  // only the id, so a name→id match could select the wrong people.
  { key: 'workforceCategory', title: 'Workforce Category', drill: null },
  { key: 'skillType',         title: 'Skill Type',         drill: 'skillType' },
  { key: 'qualification',     title: 'Qualification',      drill: 'qualification' },
  { key: 'gender',            title: 'Gender',             drill: 'gender' },
  // Age and experience are computed bands; the employee list cannot filter on them.
  { key: 'age',               title: 'Age',                drill: null, ordered: true },
  { key: 'experience',        title: 'Experience',         drill: null, ordered: true },
];

/** Global filter dimensions → the query key GET /analytics/workforce reads. */
const DIMENSIONS = [
  { key: 'department',      label: 'Department',      from: 'department' },
  { key: 'branch_id',       label: 'Location',        from: 'location' },
  { key: 'employment_type', label: 'Employment Type', from: 'employmentType' },
  { key: 'designation',     label: 'Designation',     from: 'designation' },
  { key: 'gender',          label: 'Gender',          from: 'gender' },
  { key: 'status',          label: 'Status',          from: null },
  { key: 'skill_type',      label: 'Skill Type',      from: 'skillType' },
];
const STATUS_OPTIONS = ['Active', 'Probation', 'Notice', 'Other', 'Exited'];

const BAR = '#6B3FDB';

/**
 * What to tell the user when GET /analytics/workforce fails.
 *
 * ⚠ A 404 is called out on its own. On 2026-10-13 the page showed only
 * "Workforce analytics could not be loaded." while the request was getting
 * Express's HTML "Cannot GET /api/analytics/workforce" — the backend was an
 * old process started before the route existed. A message that names the
 * status and the likely cause points straight at it. Every other failure says
 * its HTTP status too, so a screenshot is enough to tell auth, gate and server
 * errors apart.
 */
export function workforceErrorMessage(e) {
  const status = e?.response?.status;
  if (status === 403) return 'You do not have access to workforce analytics.';
  if (status === 404) {
    return 'This server does not provide workforce analytics (HTTP 404). '
      + 'The backend may be running an older build — restart or redeploy it.';
  }
  const detail = typeof e?.response?.data?.error === 'string' ? e.response.data.error : null;
  if (!status) return 'Workforce analytics could not be loaded: the server did not respond.';
  return `Workforce analytics could not be loaded (HTTP ${status})${detail ? `: ${detail}` : '.'}`;
}

const pctText = (n) => (n == null ? '—' : `${Math.round(n)}%`);
const completenessTone = (f) => {
  if (f.total === 0) return 'none';
  if (f.pct >= 80) return 'good';
  if (f.pct >= 50) return 'fair';
  return 'poor';
};

/** Options for every dimension from one UNFILTERED read, so each value is exactly what the API matches on. */
function optionsFrom(data) {
  const out = {};
  for (const d of DIMENSIONS) {
    if (d.key === 'status') { out.status = STATUS_OPTIONS.map(v => ({ value: v, label: v })); continue; }
    const buckets = data?.breakdowns?.[d.from]?.buckets || [];
    out[d.key] = buckets.map(b => (d.key === 'branch_id'
      ? { value: b.branchId == null ? NOT_RECORDED : String(b.branchId), label: b.value }
      : { value: b.value, label: b.value }));
  }
  return out;
}

export default function EmployeeReports({ setPage }) {
  const { hasPermission } = useAuth();
  const canView  = hasPermission('hr', 'view');
  const canDrill = hasPermission('employees', 'view');
  const links = REPORT_LINKS.filter(l => !l.module || hasPermission(l.module, 'view'));

  const filters = useDashboardFilters({
    defaultPeriod: 'last12m',
    dimensions: Object.fromEntries(DIMENSIONS.map(d => [d.key, 'all'])),
    storageKey: 'workforce-analytics',
  });
  const { params } = filters;

  const [data, setData]       = useState(null);
  const [options, setOptions] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const ctrlRef = useRef(null);

  const load = useCallback(async (p) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/analytics/workforce', { params: p, signal: ctrl.signal });
      setData(res.data);
    } catch (e) {
      if (e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED') return;
      setError(workforceErrorMessage(e));
      setData(null);
    } finally {
      if (ctrlRef.current === ctrl) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canView) load(params);
    return () => ctrlRef.current?.abort();
  }, [params, canView, load]);

  // Filter options: one unfiltered read, independent of the selection.
  useEffect(() => {
    if (!canView) return;
    api.get('/analytics/workforce', { params: { period: 'all' } })
      .then(res => setOptions(optionsFrom(res.data)))
      .catch(() => setOptions({}));
  }, [canView]);

  // ── Drill-through ──────────────────────────────────────────────────────────
  // The active global filters travel with the click, so the list shows the
  // same population the chart counted.
  const drillBase = useMemo(() => {
    const dims = filters.dimensions || {};
    const wf = {};
    const set = (k, v) => { if (v && v !== 'all') wf[k] = v; };
    set('department', dims.department);
    set('designation', dims.designation);
    set('employmentType', dims.employment_type);
    set('gender', dims.gender);
    set('skillType', dims.skill_type);
    if (dims.branch_id && dims.branch_id !== 'all') {
      wf.branchId = dims.branch_id === NOT_RECORDED ? null : dims.branch_id;
    }
    const status = dims.status && dims.status !== 'all' ? dims.status : 'All';
    return { status, wf };
  }, [filters.dimensions]);

  const drill = useCallback((extra, label) => {
    if (!canDrill) return;
    const f = {
      status: extra.status ?? drillBase.status,
      wf: { ...drillBase.wf, ...(extra.wf || {}) },
      ...(extra.joinedFrom ? { joinedFrom: extra.joinedFrom, joinedTo: extra.joinedTo } : {}),
      label,
      origin: 'EmployeeReports',
    };
    if (!Object.keys(f.wf).length) delete f.wf;
    setEmployeeListFilter(f);
    setPage?.('EmployeesData');
  }, [canDrill, drillBase, setPage]);

  // All Employees lists current staff; people who left are on Ex-Employees.
  // While the population IS the leavers (Status filter = Exited) a drill would
  // land on an empty list, so it is not offered at all.
  const drillAllowed = canDrill && drillBase.status !== 'Exited';

  const drillFor = (card) => {
    if (!drillAllowed || !card.drill) return null;
    return (bucket) => {
      if (card.drill === 'status' && bucket.value === 'Exited') return undefined;
      if (card.drill === 'status') return drill({ status: bucket.value }, `Workforce Analytics · Status: ${bucket.value}`);
      return drill({ wf: { [card.drill]: bucket.value } }, `Workforce Analytics · ${card.title}: ${bucket.value}`);
    };
  };

  if (!canView) {
    return (
      <PageShell className="wfa-shell" dock={<PageHero icon={BarChart3} eyebrow="Human Resources" title="Workforce Analytics & Reports" />}>
        <p className="wfa-empty" role="alert">You need HR access to view workforce analytics.</p>
      </PageShell>
    );
  }

  const dimensionDefs = DIMENSIONS.map(d => ({
    key: d.key, label: d.label, options: options[d.key] || [], width: 130,
  }));

  return (
    <PageShell className="wfa-shell" dock={
      <PageHero
        icon={BarChart3}
        eyebrow="Human Resources"
        title="Workforce Analytics & Reports"
        subtitle="Who works here today, how complete the records are, and who joined and left"
      />
    }>
      <div className="wfa-page">
        <DashboardFilterBar
          filters={filters}
          periodLabel="Joins & exits period"
          dimensions={dimensionDefs}
          actions={(
            <button type="button" className="wfa-btn" onClick={() => load(params)} disabled={loading}>
              <RefreshCw size={12} aria-hidden="true" /> Refresh
            </button>
          )}
        />

        {data && (
          <p className="wfa-caption">
            Composition shows the <strong>{data.population.basis === 'current' ? 'current workforce' : `status: ${data.population.basis.split(':')[1]}`}</strong> as
            of today — <strong>{data.population.total}</strong> {data.population.total === 1 ? 'employee' : 'employees'}.
            The period applies to joining and exit trends only
            {data.period?.from ? ` (${data.period.from} to ${data.period.to})` : ''}.
            {!canDrill && ' Charts are read-only for your role.'}
            {canDrill && !drillAllowed && ' Leavers are listed on Ex-Employees, so these charts do not open All Employees.'}
          </p>
        )}

        {error && (
          <div className="wfa-error" role="alert">
            <AlertTriangle size={14} aria-hidden="true" /> {error}
            <button type="button" className="wfa-btn" onClick={() => load(params)}>Retry</button>
          </div>
        )}
        {loading && !data && <p className="wfa-empty">Loading workforce analytics…</p>}

        {data && (
          <>
            <Completeness fields={data.completeness} />

            <h2 className="wfa-section">Workforce composition <span>as of today</span></h2>
            <div className="wfa-grid">
              {COMPOSITION.map(card => (
                <BreakdownCard
                  key={card.key}
                  card={card}
                  breakdown={data.breakdowns[card.key]}
                  minSample={data.minSample}
                  onDrill={drillFor(card)}
                />
              ))}
            </div>

            <h2 className="wfa-section">Joining &amp; attrition <span>{data.period?.label || 'selected period'}</span></h2>
            <div className="wfa-grid wfa-grid-2">
              <TrendCard
                title="Joining trend"
                total={data.joiningTrend.total}
                unit="joined"
                months={data.joiningTrend.months}
                valueKey="joins"
                truncated={data.period?.trendTruncated}
                onDrill={drillAllowed
                  ? (m) => drill({ joinedFrom: `${m.monthKey}-01`, joinedTo: lastDayOf(m.monthKey) },
                                 `Workforce Analytics · Joined ${m.month}`)
                  : null}
              />
              <AttritionCard exits={data.exits} truncated={data.period?.trendTruncated} />
            </div>
          </>
        )}

        <h2 className="wfa-section">Reports &amp; exports <span>CSV, using the filters above</span></h2>
        <ReportExports params={params} />

        {links.length > 0 && (
          <>
            <h3 className="wfa-subsection">Open the full lists</h3>
            <div className="wfa-links">
              {links.map(({ page, icon: Icon, label, desc }) => (
                <button key={page} type="button" className="wfa-link" onClick={() => setPage?.(page)}>
                  <span className="wfa-link-title">
                    <Icon size={18} color={BAR} aria-hidden="true" /> {label}
                    <ArrowRight size={14} color={BAR} aria-hidden="true" style={{ marginLeft: 'auto' }} />
                  </span>
                  <span className="wfa-link-desc">{desc}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}

// ── Reports & exports ─────────────────────────────────────────────────────────

/** Expiry windows the document export offers; keys are what the API accepts. */
export const DOCUMENT_WINDOWS = [
  { value: 'expired',       label: 'Expired' },
  { value: 'next30',        label: 'Expiring in the next 30 days' },
  { value: 'next60',        label: 'Expiring in the next 60 days' },
  { value: 'next90',        label: 'Expiring in the next 90 days' },
  { value: 'expired_or_30', label: 'Expired or expiring in 30 days' },
];

/**
 * The three exports. `period` says whether the page's period applies: headcount
 * is "as of today" like the composition charts; attrition covers the period.
 */
export const EXPORTS = [
  { key: 'headcount', title: 'Headcount', path: '/analytics/employee-reports/headcount', period: false,
    desc: 'Current workforce matching the filters above, as of today. The period does not apply.' },
  { key: 'attrition', title: 'Attrition', path: '/analytics/employee-reports/attrition', period: true,
    desc: 'Exits in the selected period, with exit date, its source and the reason. Exits with no recorded date are included and marked Unknown.' },
  { key: 'documents', title: 'Document expiry', path: '/analytics/employee-reports/doc-expiry', period: false,
    desc: 'Expired or expiring documents of employees matching the filters. Choose the expiry window first.' },
];

/** What to say when an export request fails. */
export function exportErrorMessage(e) {
  const status = e?.response?.status;
  if (status === 403) return 'You do not have access to this report.';
  if (status === 404) return 'This server does not provide this report (HTTP 404). The backend may be running an older build.';
  const detail = typeof e?.response?.data?.error === 'string' ? e.response.data.error : null;
  if (!status) return 'Download failed: the server did not respond.';
  return `Download failed (HTTP ${status})${detail ? `: ${detail}` : '.'}`;
}

/**
 * Write the CSV with the shared writer: every cell is formula-quoted by
 * buildCsv, and every text cell has Aadhaar-shaped numbers masked first — a
 * document called "Aadhar Card 2345 6789 0123" is exported as "…****0123".
 */
export function writeExportCsv(columns, rows, filename) {
  const safe = rows.map(r => r.map(v => (typeof v === 'string' ? maskAadhaarInText(v) : (v ?? ''))));
  downloadCsv(columns, safe, filename);
}

function ReportExports({ params }) {
  const [busy, setBusy]       = useState({});
  const [notes, setNotes]     = useState({});
  const [docWindow, setDocWindow] = useState('');

  const run = async (exp) => {
    const query = { ...params };
    if (!exp.period) { delete query.period; delete query.from; delete query.to; }
    if (exp.key === 'documents') query.window = docWindow;
    setBusy(b => ({ ...b, [exp.key]: true }));
    setNotes(n => ({ ...n, [exp.key]: null }));
    try {
      const { data } = await api.get(exp.path, { params: query });
      if (!data?.rows?.length) {
        setNotes(n => ({ ...n, [exp.key]: { tone: 'empty', text: 'No records match these filters — nothing was downloaded.' } }));
        return;
      }
      const stamp = localDay();
      const suffix = exp.key === 'documents' ? `-${docWindow}` : '';
      writeExportCsv(data.columns, data.rows, `workforce-${exp.key}${suffix}-${stamp}.csv`);
      const extra = exp.key === 'attrition' && data.dateUnknown
        ? ` ${data.dateUnknown} with no recorded exit date ${data.dateUnknown === 1 ? 'is' : 'are'} marked Unknown.`
        : '';
      setNotes(n => ({ ...n, [exp.key]: { tone: 'ok', text: `Downloaded ${data.total} ${data.total === 1 ? 'row' : 'rows'}.${extra}` } }));
    } catch (e) {
      setNotes(n => ({ ...n, [exp.key]: { tone: 'error', text: exportErrorMessage(e) } }));
    } finally {
      setBusy(b => ({ ...b, [exp.key]: false }));
    }
  };

  return (
    <div className="wfa-exports">
      {EXPORTS.map(exp => {
        const needsWindow = exp.key === 'documents' && !docWindow;
        return (
          <article key={exp.key} className="wfa-export" aria-label={`${exp.title} report`}>
            <h3>{exp.title} CSV</h3>
            <p className="wfa-link-desc">{exp.desc}</p>
            {exp.key === 'documents' && (
              <label className="wfa-export-field">
                <span>Expiry window</span>
                <select value={docWindow} onChange={e => setDocWindow(e.target.value)} aria-label="Expiry window">
                  <option value="">Choose a window…</option>
                  {DOCUMENT_WINDOWS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </select>
              </label>
            )}
            <button type="button" className="wfa-btn wfa-export-btn"
                    onClick={() => run(exp)} disabled={busy[exp.key] || needsWindow}
                    aria-label={`Download ${exp.title} CSV`}>
              <Download size={12} aria-hidden="true" />
              {busy[exp.key] ? 'Preparing…' : 'Download CSV'}
            </button>
            {notes[exp.key] && (
              <p role="status" className={`wfa-export-note wfa-export-note-${notes[exp.key].tone}`}>{notes[exp.key].text}</p>
            )}
          </article>
        );
      })}
    </div>
  );
}

/** YYYY-MM → its last day, YYYY-MM-DD. */
function lastDayOf(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m, 0);
  return `${monthKey}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Completeness ──────────────────────────────────────────────────────────────
function Completeness({ fields }) {
  return (
    <section className="wfa-complete" aria-label="Data completeness">
      <div className="wfa-complete-head">
        <Info size={13} aria-hidden="true" /> Data completeness — how many records each chart is drawn from
      </div>
      <ul className="wfa-chips">
        {fields.map(f => (
          <li key={f.field} className={`wfa-chip wfa-chip-${completenessTone(f)}`}
              title={`${f.label}: ${f.recorded} of ${f.total} recorded`}>
            <span className="wfa-chip-label">{f.label}</span>
            <span className="wfa-chip-value">{f.recorded}/{f.total}</span>
            <span className="wfa-chip-pct">{pctText(f.pct)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── One composition breakdown ─────────────────────────────────────────────────
export function BreakdownCard({ card, breakdown, minSample, onDrill }) {
  const bd = breakdown || { total: 0, recorded: 0, notRecorded: 0, buckets: [] };
  const recorded = bd.buckets.filter(b => b.value !== NOT_RECORDED);
  const bars = card.ordered ? recorded : recorded.filter(b => b.count > 0);
  const state = bd.total === 0 ? 'empty'
    : bd.recorded === 0 ? 'none'
      : bd.recorded < minSample ? 'low'
        : 'chart';
  const colorOf = (b) => (card.key === 'status' ? (BUCKET_COLORS[b.value] || BAR) : BAR);
  const height = Math.max(120, bars.length * 26 + 30);

  return (
    <article className="wfa-card" aria-labelledby={`wfa-${card.key}`}>
      <header className="wfa-card-head">
        <h3 id={`wfa-${card.key}`}>{card.title}</h3>
        <span className="wfa-card-sub">
          {bd.recorded} of {bd.total} recorded
          {bd.notRecorded > 0 && ` · ${bd.notRecorded} not recorded`}
        </span>
      </header>

      {state === 'empty' && <p className="wfa-state">No employees match the current filters.</p>}
      {state === 'none' && (
        <p className="wfa-state wfa-state-warn">
          Not recorded for any of the {bd.total} {bd.total === 1 ? 'employee' : 'employees'} — nothing to chart yet.
        </p>
      )}
      {state === 'low' && (
        <p className="wfa-state wfa-state-warn">
          Too few records to chart: only {bd.recorded} of {bd.total} recorded (a chart needs at least {minSample}).
        </p>
      )}

      {state === 'chart' && (
        <div className="wfa-chart" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bars} layout="vertical" margin={{ top: 4, right: 28, left: 4, bottom: 4 }}>
              <CartesianGrid horizontal={false} stroke="#eef0f4" />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} />
              <YAxis type="category" dataKey="value" width={120} tick={{ fontSize: 11, fill: '#374151' }} />
              <Tooltip cursor={{ fill: '#f5f3ff' }} formatter={(v) => [v, 'Employees']} />
              <Bar dataKey="count" barSize={14} radius={[0, 4, 4, 0]}
                   onClick={onDrill ? (d) => onDrill(d?.payload ?? d) : undefined}
                   style={onDrill ? { cursor: 'pointer' } : undefined}>
                {bars.map(b => <Cell key={b.value} fill={colorOf(b)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {(state === 'chart' || state === 'low') && (
        <DataTable
          caption={`${card.title} — employees per value`}
          rows={recorded.filter(b => card.ordered || b.count > 0)}
          open={state === 'low'}
          onDrill={onDrill}
          // Leavers are not on All Employees; no button that opens an empty list.
          canOpen={(b) => !(card.key === 'status' && b.value === 'Exited')}
          drillLabel={(b) => `Open the ${b.count} ${card.title.toLowerCase()} "${b.value}" employees in All Employees`}
        />
      )}
    </article>
  );
}

/** The numbers behind a chart, and — when allowed — the drill-through buttons. */
function DataTable({ caption, rows, open, onDrill, drillLabel, canOpen = () => true }) {
  return (
    <details className="wfa-table" open={open || undefined}>
      <summary>{open ? 'Values' : 'Show data'}</summary>
      <table>
        <caption className="wfa-sr">{caption}</caption>
        <thead><tr><th scope="col">Value</th><th scope="col">Employees</th>{onDrill && <th scope="col"><span className="wfa-sr">Open</span></th>}</tr></thead>
        <tbody>
          {rows.map(b => (
            <tr key={b.value}>
              <th scope="row">{b.value}</th>
              <td>{b.count}</td>
              {onDrill && (
                <td>
                  {b.count > 0 && canOpen(b) && (
                    <button type="button" className="wfa-drill" onClick={() => onDrill(b)} aria-label={drillLabel(b)}>
                      Open
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

// ── Trends ────────────────────────────────────────────────────────────────────
function MonthlyBars({ months, valueKey, onDrill, color = BAR }) {
  return (
    <div className="wfa-chart" style={{ height: 180 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={months} margin={{ top: 8, right: 8, left: -18, bottom: 4 }}>
          <CartesianGrid vertical={false} stroke="#eef0f4" />
          <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#6b7280' }} interval="preserveStartEnd" />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#6b7280' }} />
          <Tooltip cursor={{ fill: '#f5f3ff' }} formatter={(v) => [v, valueKey === 'joins' ? 'Joined' : 'Left']} />
          <Bar dataKey={valueKey} fill={color} barSize={14} radius={[4, 4, 0, 0]}
               onClick={onDrill ? (d) => onDrill(d?.payload ?? d) : undefined}
               style={onDrill ? { cursor: 'pointer' } : undefined} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrendCard({ title, total, unit, months, valueKey, truncated, onDrill }) {
  return (
    <article className="wfa-card" aria-label={title}>
      <header className="wfa-card-head">
        <h3>{title}</h3>
        <span className="wfa-card-sub">{total} {unit} in the period{truncated ? ' · chart shows the latest months' : ''}</span>
      </header>
      {months.length === 0
        ? <p className="wfa-state">No months in the selected period.</p>
        : <MonthlyBars months={months} valueKey={valueKey} onDrill={onDrill} />}
      <DataTable
        caption={`${title} by month`}
        rows={months.map(m => ({ value: m.month, count: m[valueKey], monthKey: m.monthKey, month: m.month }))}
        onDrill={onDrill}
        drillLabel={(r) => `Open the ${r.count} employees who joined in ${r.value} in All Employees`}
      />
    </article>
  );
}

function AttritionCard({ exits, truncated }) {
  return (
    <article className="wfa-card" aria-label="Attrition">
      <header className="wfa-card-head">
        <h3>Attrition</h3>
        <span className="wfa-card-sub">
          {exits.inPeriod} left in the period{truncated ? ' · chart shows the latest months' : ''}
        </span>
      </header>
      {exits.byMonth.length === 0
        ? <p className="wfa-state">No months in the selected period.</p>
        : <MonthlyBars months={exits.byMonth} valueKey="exits" color={BUCKET_COLORS.Exited} />}

      {exits.dateUnknown.count > 0 && (
        <p className="wfa-state wfa-state-warn">
          {exits.dateUnknown.count} {exits.dateUnknown.count === 1 ? 'exit has' : 'exits have'} no recorded exit date
          and {exits.dateUnknown.count === 1 ? 'is' : 'are'} not in any month above.
        </p>
      )}

      <h4 className="wfa-subhead">Exit reasons in the period</h4>
      {exits.byReason.length === 0
        ? <p className="wfa-state">No exits in the period.</p>
        : (
          <ul className="wfa-reasons">
            {exits.byReason.map(r => (
              <li key={r.reason}><span>{r.reason}</span><strong>{r.count}</strong></li>
            ))}
          </ul>
        )}
      <p className="wfa-foot">{exits.allTime} {exits.allTime === 1 ? 'person has' : 'people have'} left in total, across all time.</p>
    </article>
  );
}
