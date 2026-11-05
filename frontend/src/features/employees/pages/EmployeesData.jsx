// PATH: frontend/src/features/employees/pages/EmployeesData.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, X, Download, Plus, Eye, Edit2, UserX, RefreshCw, ChevronUp, ChevronDown, Users, Briefcase, Clock, AlertCircle, TrendingUp, Filter, Columns, CheckSquare, Square, UserCheck, SlidersHorizontal } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import './EmployeesData.css';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  bucketOf, tenureBucketOf, STATUS_LABELS,
  WRITABLE_STATUSES, BULK_WRITABLE_STATUSES, canonicalWritableStatus,
} from '../employeeStatus';
import { display, isBlank, EMPTY } from '../displayValue';
import { localDay } from '@/utils/dateFormatter';
import { maskAadhaar, downloadCsv } from '../csvExport';
import {
  peekEmployeeListFilter, clearEmployeeListFilter,
  matchesEmployeeFilter, describeEmployeeFilter,
  missingMandatoryFields,
} from '../employeeListFilter';

// Mirrors the backend HR_ROLES guard on employee writes — everyone else gets a
// "not allowed to edit" notice instead of edit controls that would 403.
const EMPLOYEE_EDITOR_ROLES = new Set([
  'super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin',
]);

// ── Status config ─────────────────────────────────────────────────────────────
// Keyed by BUCKET (see employeeStatus.js STATUS_BUCKETS), not by raw status.
// The previous map was keyed by raw value, so an employee stored as
// 'notice_period' — one of the three legacy spellings of notice that the READ
// vocabulary has to tolerate — missed every key and was painted in Active
// green while the row's own Status filter correctly called them Notice.
const STATUS_CFG = {
  Active:    { bg: '#dcfce7', color: '#166534', dot: '#22c55e' },
  Probation: { bg: '#ede9fe', color: '#5b21b6', dot: '#7c5cf0' },
  Notice:    { bg: '#fef3c7', color: '#92400e', dot: '#f59e0b' },
  Other:     { bg: '#f3f4f6', color: '#374151', dot: '#9ca3af' },
  Exited:    { bg: '#f3f4f6', color: '#6b7280', dot: '#9ca3af' },
};
function statusCfg(status) { return STATUS_CFG[bucketOf(status)] || STATUS_CFG.Other; }

// Statuses that require a confirmation step before applying. 'Left' is the only
// writable status that ends employment, and it is not reachable from the row
// dropdown at all — it goes through the Terminate modal, which captures a last
// working day and a reason. 'Inactive' used to be offerable here, which meant
// one click retired someone with neither.
const DESTRUCTIVE_STATUSES = new Set(['Notice']);

/**
 * Which mandatory fields a row is missing.
 *
 * Delegates to `missingMandatoryFields` in employeeListFilter.js rather than
 * keeping a third list: the page had its own (Employee ID, Department, Role)
 * while the dashboard's drill-down had another (joining date, department,
 * designation, skill_type, probation end), so the same employee could be
 * "incomplete" on one screen and complete on the other. The shared list is
 * defined as "this row would fail POST /employees today" and is contract-tested
 * against the backend's REQUIRED_ON_CREATE.
 */
const missingFieldsOf = missingMandatoryFields;

// ── Avatar colors (hash-based) ────────────────────────────────────────────────
const AVATAR_PALETTES = [
  { bg:'#ede9fe', color:'#6d28d9' }, { bg:'#dbeafe', color:'#1d4ed8' },
  { bg:'#dcfce7', color:'#166534' }, { bg:'#fff7ed', color:'#5b21b6' },
  { bg:'#fdf4ff', color:'#9333ea' }, { bg:'#f0fdfa', color:'#0f766e' },
  { bg:'#ede9fe', color:'#6d28d9' }, { bg:'#fce7f3', color:'#9d174d' },
];
function avatarPalette(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_PALETTES[h % AVATAR_PALETTES.length];
}

// ── Computed field helpers ────────────────────────────────────────────────────
function calcAge(dob) {
  if (isBlank(dob)) return EMPTY;
  const years = Math.floor((Date.now() - new Date(dob)) / (365.25 * 24 * 60 * 60 * 1000));
  return years > 0 ? `${years} yrs` : '< 1 yr';
}

function calcExperience(emp) {
  const prev = (parseFloat(emp.previous_years_1) || 0) + (parseFloat(emp.previous_years_2) || 0);
  let cur = 0;
  if (emp.joining_date) {
    cur = (Date.now() - new Date(emp.joining_date)) / (365.25 * 24 * 60 * 60 * 1000);
  }
  const total = prev + cur;
  const yrs = Math.floor(total);
  const mos = Math.round((total - yrs) * 12);
  if (yrs === 0 && mos === 0) return '< 1 mo';
  if (mos === 0) return `${yrs} yr`;
  if (yrs === 0) return `${mos} mo`;
  return `${yrs} yr ${mos} mo`;
}

function fmtDate(d) {
  // isBlank catches the 'null' family before `.split` is reached; the NaN guard
  // catches a value that is a string but not a date, which rendered the literal
  // text "Invalid Date" into the Joined and Date of Birth columns.
  if (isBlank(d)) return EMPTY;
  const parsed = new Date(String(d).split('T')[0] + 'T00:00:00');
  if (Number.isNaN(parsed.getTime())) return EMPTY;
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ── Column definitions ────────────────────────────────────────────────────────
const COL_GROUPS = ['Job', 'Notice', 'Personal', 'Computed', 'Compliance'];

/** Shown automatically whenever the list is filtered to Notice. */
const NOTICE_COLS = ['_notice_start', '_notice_lwd', '_notice_days', '_notice_status'];

const COLUMN_DEFS = [
  // Always visible (no toggle)
  { key:'_num',       label:'#',          always:true },
  { key:'_employee',  label:'Employee',   always:true },
  { key:'_actions',   label:'Actions',    always:true },
  // Default visible
  { key:'office_id',         label:'Emp ID',          group:'Job',        defaultOn:true  },
  { key:'department',        label:'Department',      group:'Job',        defaultOn:true  },
  { key:'designation',       label:'Role',            group:'Job',        defaultOn:true  },
  { key:'_status',           label:'Status',          group:'Job',        defaultOn:true  },
  { key:'joining_date',      label:'Joined',          group:'Job',        defaultOn:true  },
  { key:'reporting_manager', label:'Manager',         group:'Job',        defaultOn:true  },
  // Computed
  { key:'_age',              label:'Age',             group:'Computed',   defaultOn:false },
  { key:'_experience',       label:'Total Experience',group:'Computed',   defaultOn:false },
  // Personal
  { key:'dob',               label:'Date of Birth',  group:'Personal',   defaultOn:false },
  { key:'phone',             label:'Phone',           group:'Personal',   defaultOn:false },
  { key:'gender',            label:'Gender',          group:'Personal',   defaultOn:false },
  { key:'blood_group',       label:'Blood Group',     group:'Personal',   defaultOn:false },
  { key:'marital_status',    label:'Marital Status',  group:'Personal',   defaultOn:false },
  { key:'father_name',       label:'Father Name',     group:'Personal',   defaultOn:false },
  { key:'emergency_name',    label:'Emergency Contact',group:'Personal',  defaultOn:false },
  { key:'emergency_phone',   label:'Emergency Phone', group:'Personal',   defaultOn:false },
  { key:'current_address',   label:'Current Address', group:'Personal',   defaultOn:false },
  // Job details
  { key:'employment_type',   label:'Employment Type', group:'Job',        defaultOn:false },
  { key:'skill_type',        label:'Skill Type',      group:'Job',        defaultOn:false },
  { key:'location',          label:'Location',        group:'Job',        defaultOn:false },
  { key:'zone',              label:'Zone',            group:'Job',        defaultOn:false },
  { key:'highest_qualification', label:'Qualification', group:'Job',      defaultOn:false },
  { key:'employee_role',     label:'System Role',     group:'Job',        defaultOn:false },
  // Notice period — only meaningful for staff serving notice, so these are
  // off by default and switched on automatically when the Notice filter is
  // active (see NOTICE_COLS below). The values are merged in from
  // /hr-widgets/upcoming-exits, which is the only place the exit request's
  // dates and status are exposed.
  { key:'_notice_start',  label:'Notice Started',    group:'Notice', defaultOn:false },
  { key:'_notice_lwd',    label:'Last Working Day',  group:'Notice', defaultOn:false },
  { key:'_notice_days',   label:'Days Remaining',    group:'Notice', defaultOn:false },
  { key:'_notice_status', label:'Exit Request',      group:'Notice', defaultOn:false },
  // Compliance
  { key:'pan_number',        label:'PAN',             group:'Compliance', defaultOn:false },
  { key:'aadhaar_number',    label:'Aadhaar',         group:'Compliance', defaultOn:false },
  { key:'pf_number',         label:'PF Number',       group:'Compliance', defaultOn:false },
  { key:'uan_number',        label:'UAN',             group:'Compliance', defaultOn:false },
];

const LS_KEY = 'pulse_emp_cols';
const DEFAULT_COLS = new Set(
  COLUMN_DEFS.filter(c => c.always || c.defaultOn).map(c => c.key)
);

function loadSavedCols() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set(DEFAULT_COLS);
}

// ── CSV export ────────────────────────────────────────────────────────────────
/**
 * Cells whose export value must not simply be the raw column.
 *
 * ⚠ Aadhaar is MASKED on screen (`****1234`) and was exported in FULL. An export
 * that reveals more than the page it came from is a PII leak with a paper trail:
 * the number leaves in a spreadsheet that gets mailed around, and nothing on the
 * screen suggested it would. The rule is that the CSV says what the table says.
 */
function exportValue(emp, colKey) {
  switch (colKey) {
    // bucketOf, not the raw column: a reconciliation done in Excel must not
    // disagree with the Status column it was copied from.
    case '_status':        return bucketOf(emp.status);
    case '_age':           return calcAge(emp.dob);
    case '_experience':    return calcExperience(emp);
    case 'joining_date':   return fmtDate(emp.joining_date);
    case 'dob':            return fmtDate(emp.dob);
    case 'aadhaar_number': return isBlank(emp.aadhaar_number)
      ? EMPTY
      : maskAadhaar(emp.aadhaar_number);
    // display(), not `|| em-dash`: the string 'null' is truthy.
    default:               return display(emp[colKey]);
  }
}

// Formula-injection quoting (csvCell), Aadhaar masking and the BOM download live
// in ../csvExport, shared with Employee Documents' export.

/**
 * Export the rows passed in — which is always the FILTERED set, never the whole
 * table. The button label carries the count so it is obvious which.
 *
 * `scope` only names the file. An HR user who exports a department and an HR user
 * who exports everything both end up with a download in the same folder, and
 * `employees.csv` twice tells them nothing about which is which.
 */
function exportCSV(rows, visibleCols, scope = 'all') {
  const togglable = COLUMN_DEFS.filter(c => !c.always && visibleCols.has(c.key));
  const headers   = ['S.No', 'Employee ID', 'Name', ...togglable.map(c => c.label)];
  const body = rows.map((emp, i) => [
    i + 1,
    display(emp.office_id),
    `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
    ...togglable.map(c => exportValue(emp, c.key)),
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  downloadCsv(headers, body, `employees-${scope}-${stamp}.csv`);
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;
const LS_PAGE_SIZE = 'pulse_emp_page_size';

/**
 * The chip label the Total Staff KPI applies.
 *
 * A constant because three places have to agree on it: the card that sets it, the
 * `isActive` highlight that reads it back, and the chip copy that special-cases
 * the exited-count wording. A string literal repeated three times is a string
 * literal that ends up spelled two ways.
 */
const CURRENT_STAFF_LABEL = 'Current Staff';

function loadPageSize() {
  try {
    const n = parseInt(localStorage.getItem(LS_PAGE_SIZE), 10);
    if (PAGE_SIZE_OPTIONS.includes(n)) return n;
  } catch { /* private mode / blocked storage — fall through to the default */ }
  return DEFAULT_PAGE_SIZE;
}

/**
 * The rows-per-page control, rendered in TWO places: the filter bar at the top
 * and the pagination bar at the bottom.
 *
 * One component reading one piece of state, not two controls kept in step — so
 * "the top selector and the bottom pagination must remain synchronized" holds by
 * construction rather than by an effect someone could forget. The `id` differs
 * between the two because a duplicated DOM id would break the <label>
 * association for both of them.
 */
function PageSizeControl({ id, pageSize, onChange, compact = false }) {
  return (
    <div className={`ed-page-size${compact ? ' ed-page-size-compact' : ''}`}>
      <label htmlFor={id}>{compact ? 'Rows' : 'Rows per page'}</label>
      <select
        id={id}
        className="ed-page-size-select"
        value={pageSize}
        onChange={e => onChange(Number(e.target.value))}
      >
        {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
  );
}

/**
 * Page numbers to render, with gaps collapsed to an ellipsis.
 * Always shows the first, the last, and a window around the current page, so
 * the control stays one line wide at 32 pages as well as at 2.
 */
function pageItems(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = new Set([1, total, current, current - 1, current + 1]);
  if (current <= 3) { out.add(2); out.add(3); out.add(4); }
  if (current >= total - 2) { out.add(total - 1); out.add(total - 2); out.add(total - 3); }
  const pages = [...out].filter(n => n >= 1 && n <= total).sort((a, b) => a - b);
  const withGaps = [];
  for (let i = 0; i < pages.length; i++) {
    if (i && pages[i] - pages[i - 1] > 1) withGaps.push(`gap-${pages[i]}`);
    withGaps.push(pages[i]);
  }
  return withGaps;
}

// ── Column chooser panel ──────────────────────────────────────────────────────
function ColPanel({ visibleCols, setVisibleCols, onClose }) {
  const toggleCol = key => {
    setVisibleCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      localStorage.setItem(LS_KEY, JSON.stringify([...next]));
      return next;
    });
  };
  const resetAll = () => {
    setVisibleCols(new Set(DEFAULT_COLS));
    localStorage.removeItem(LS_KEY);
  };

  const togglable = COLUMN_DEFS.filter(c => !c.always);

  return (
    <div className="ed-col-panel">
      <div className="ed-col-panel-hd">
        <span className="ed-col-panel-title">Column Visibility</span>
        <div style={{ display:'flex', gap:6 }}>
          <button className="ed-col-reset" onClick={resetAll}>Reset</button>
          <button className="ed-col-close" onClick={onClose}><X size={13}/></button>
        </div>
      </div>
      <div className="ed-col-body">
        {COL_GROUPS.map(group => {
          const cols = togglable.filter(c => c.group === group);
          if (!cols.length) return null;
          return (
            <div key={group} className="ed-col-group">
              <div className="ed-col-group-label">{group}</div>
              {cols.map(col => {
                const on = visibleCols.has(col.key);
                return (
                  <label key={col.key} className="ed-col-item">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleCol(col.key)}
                      className="ed-col-checkbox"
                    />
                    <span className={`ed-col-check-icon ${on ? 'on' : ''}`}>
                      {on ? <CheckSquare size={14}/> : <Square size={14}/>}
                    </span>
                    <span className="ed-col-item-label">{col.label}</span>
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Terminate modal → Exit Management ─────────────────────────────────────────
// Containment C6 / MD-14 (HR_P0_REMEDIATION_DESIGN_2026-11-03.md): this used to
// PUT status 'Left' straight onto the employee — no exit request, no clearance,
// no full & final settlement, no login revocation. It now collects the same two
// facts and hands them to Exit Management → Initiate Exit, which records the
// separation; nothing is written from this page.
function TerminateModal({ emp, onConfirm, onClose, open }) {
  const today = localDay();
  const [exitDate,   setExitDate]   = useState(today);
  const [exitReason, setExitReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!exitDate) return;
    setSubmitting(true);
    await onConfirm(exitDate, exitReason);
    setSubmitting(false);
  }

  return (
    <div role="dialog" aria-modal="true" className="ed-modal-overlay" onClick={onClose} style={{ display: open ? 'flex' : 'none' }}>
      <div className="ed-modal" onClick={e => e.stopPropagation()}>
        <div className="ed-modal-hd">
          <span className="ed-modal-title">Terminate Employee</span>
          <button className="ed-col-close" onClick={onClose}><X size={13}/></button>
        </div>
        <div className="ed-modal-body">
          <p className="ed-modal-sub">
            <strong>{emp.first_name} {emp.last_name}</strong> leaves through Exit Management, which records
            the separation, exit clearance and the full &amp; final settlement. Nothing is changed on this page.
          </p>
          <div className="ed-modal-field">
            <label className="ed-modal-label">Last Working Day *</label>
            <input
              type="date"
              className="ed-modal-input"
              value={exitDate}
              onChange={e => setExitDate(e.target.value)}
            />
          </div>
          <div className="ed-modal-field">
            <label className="ed-modal-label">Exit Reason</label>
            <select
              className="ed-modal-input"
              value={exitReason}
              onChange={e => setExitReason(e.target.value)}
            >
              <option value="">Select reason…</option>
              <option value="Resignation">Resignation</option>
              <option value="Termination">Termination</option>
              <option value="Contract End">Contract End</option>
              <option value="Retirement">Retirement</option>
              <option value="Absconding">Absconding</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </div>
        <div className="ed-modal-footer">
          <button className="ed-modal-cancel" onClick={onClose}>Cancel</button>
          <button
            className="ed-modal-confirm-danger"
            onClick={submit}
            disabled={submitting || !exitDate}
          >
            {submitting ? 'Opening…' : 'Continue in Exit Management'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Who a bulk action is about to change, by name.
 *
 * A count alone is not enough to cancel on. "Change status for 12 employees"
 * gives no way to notice that the selection still holds three rows from a
 * filter applied two minutes ago — the names do. Capped, with the remainder
 * counted, so a 100-row selection does not push the buttons off screen.
 */
function AffectedList({ employees, max = 12 }) {
  const shown = employees.slice(0, max);
  const rest  = employees.length - shown.length;
  return (
    <div className="ed-affected">
      <div className="ed-affected-hd">This will change {employees.length} record{employees.length === 1 ? '' : 's'}:</div>
      <ul className="ed-affected-list">
        {shown.map(e => (
          <li key={e.id}>
            <span className="ed-affected-name">{`${e.first_name||''} ${e.last_name||''}`.trim() || display(e.company_email)}</span>
            <span className="ed-affected-meta">
              {display(e.office_id)} · {display(e.department)} · {STATUS_LABELS[bucketOf(e.status)] || bucketOf(e.status)}
            </span>
          </li>
        ))}
      </ul>
      {rest > 0 && <div className="ed-affected-more">and {rest} more</div>}
    </div>
  );
}

// ── Bulk assign department modal ──────────────────────────────────────────────
// Two steps: choose, then confirm against the named list. A department change
// re-routes approvals and payroll cost centres for everyone in the selection,
// so it does not get to be a single click either.
function BulkAssignModal({ employees, departments, onConfirm, onClose }) {
  const count = employees.length;
  const [dept,       setDept]       = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!dept) return;
    setSubmitting(true);
    await onConfirm(dept);
    setSubmitting(false);
  }

  return (
    <div className="ed-modal-overlay" onClick={onClose}>
      <div className="ed-modal" onClick={e => e.stopPropagation()}>
        <div className="ed-modal-hd">
          <span className="ed-modal-title">Assign Department</span>
          <button className="ed-col-close" onClick={onClose}><X size={13}/></button>
        </div>
        <div className="ed-modal-body">
          {!confirming ? (
            <>
              <p className="ed-modal-sub">
                Assign a new department to{' '}
                <strong>{count} employee{count !== 1 ? 's' : ''}</strong>.
              </p>
              <div className="ed-modal-field">
                <label className="ed-modal-label">Department</label>
                <select
                  className="ed-modal-input"
                  value={dept}
                  onChange={e => setDept(e.target.value)}
                >
                  <option value="">Select department…</option>
                  {departments.filter(d => d !== 'All').map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <>
              <p className="ed-modal-sub">
                Move <strong>{count} employee{count !== 1 ? 's' : ''}</strong> to{' '}
                <strong className="ed-modal-newval">{dept}</strong>. Their current department is
                shown beside each name.
              </p>
              <AffectedList employees={employees} />
            </>
          )}
        </div>
        <div className="ed-modal-footer">
          <button
            className="ed-modal-cancel"
            onClick={() => (confirming ? setConfirming(false) : onClose())}
          >
            {confirming ? 'Back' : 'Cancel'}
          </button>
          {!confirming ? (
            <button
              className="ed-modal-confirm-primary"
              onClick={() => setConfirming(true)}
              disabled={!dept}
            >
              Review {count} change{count !== 1 ? 's' : ''}
            </button>
          ) : (
            <button className="ed-modal-confirm-primary" onClick={submit} disabled={submitting}>
              {submitting ? 'Saving…' : `Assign ${count} to ${dept}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Status change confirmation modal ─────────────────────────────────────────
function StatusConfirmModal({ emp, newStatus, onConfirm, onClose }) {
  const sc = statusCfg(newStatus);
  // STATUS_LABELS, not a second local map. The local one listed 'Inactive' and
  // 'Left' — neither of which this dropdown can produce any more — and would
  // have gone stale the moment the vocabulary changed, which it just did.
  const label = STATUS_LABELS[newStatus] || newStatus;
  const fromLabel = STATUS_LABELS[bucketOf(emp.status)] || bucketOf(emp.status);

  return (
    <div className="ed-modal-overlay" onClick={onClose}>
      <div className="ed-modal" onClick={e => e.stopPropagation()}>
        <div className="ed-modal-hd">
          <span className="ed-modal-title">Confirm Status Change</span>
          <button className="ed-col-close" onClick={onClose}><X size={13}/></button>
        </div>
        <div className="ed-modal-body">
          <p className="ed-modal-sub">
            Change <strong>{emp.first_name} {emp.last_name}</strong>{' '}
            ({display(emp.office_id)}) from <strong>{fromLabel}</strong> to{' '}
            <span style={{ color: sc.color, fontWeight: 600 }}>{label}</span>?
            {newStatus === 'Notice' &&
              ' They stay in headcount and on payroll until their last working day.'}
          </p>
          {/* Setting Notice here is a STATUS change only: it creates no
              exit_request, records no last working day, and seeds no clearance
              checklist. POST /employees/:id/offboard does all three, and the
              dashboard's notice columns (Notice Started, Last Working Day, Days
              Remaining, Exit Request) read from exit_requests — so an employee
              moved to Notice from this dropdown shows Notice with every one of
              those columns blank. Saying so is the difference between a
              deliberate shortcut and a silent bypass of the exit workflow. */}
          {newStatus === 'Notice' && (
            <p className="ed-modal-note">
              This records the status only — no exit request, last working day or
              clearance checklist. Use <strong>Terminate</strong> on the row, which opens
              Exit Management, when the departure is being processed.
            </p>
          )}
        </div>
        <div className="ed-modal-footer">
          <button className="ed-modal-cancel" onClick={onClose}>Cancel</button>
          <button className="ed-modal-confirm-danger" onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Bulk status change modal ──────────────────────────────────────────────────
function BulkStatusModal({ employees, onConfirm, onClose }) {
  const count = employees.length;
  const [newStatus,  setNewStatus]  = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Rows the action would not actually change. Applying a status to someone who
  // already holds it is a no-op that still shows up in the audit log as an
  // employment-status change, so it is worth naming before the click.
  const willChange = employees.filter(e => bucketOf(e.status) !== bucketOf(newStatus));
  const noChange   = count - willChange.length;

  async function submit() {
    if (!newStatus) return;
    setSubmitting(true);
    await onConfirm(newStatus);
    setSubmitting(false);
  }

  return (
    <div className="ed-modal-overlay" onClick={onClose}>
      <div className="ed-modal" onClick={e => e.stopPropagation()}>
        <div className="ed-modal-hd">
          <span className="ed-modal-title">Change Status</span>
          <button className="ed-col-close" onClick={onClose}><X size={13}/></button>
        </div>
        <div className="ed-modal-body">
          {!confirming ? (
            <>
              <p className="ed-modal-sub">
                Apply a new status to <strong>{count} employee{count !== 1 ? 's' : ''}</strong>.
              </p>
              <div className="ed-modal-field">
                <label className="ed-modal-label">New Status</label>
                {/* BULK_WRITABLE_STATUSES — the canonical write vocabulary minus
                    'Left'. A bulk change carries no last working day and no exit
                    reason, so bulk-exiting would create N departures that no
                    report can date. Exit one at a time, via Terminate. */}
                <select className="ed-modal-input" value={newStatus} onChange={e => setNewStatus(e.target.value)}>
                  <option value="">Select status…</option>
                  {BULK_WRITABLE_STATUSES.map(v => (
                    <option key={v} value={v}>{STATUS_LABELS[v] || v}</option>
                  ))}
                </select>
              </div>
              <p className="ed-modal-note">
                To exit an employee, use the Terminate action on their row — it opens
                Exit Management with the last working day and reason filled in.
              </p>
            </>
          ) : (
            <>
              <p className="ed-modal-sub">
                Set <strong className="ed-modal-newval">{STATUS_LABELS[newStatus] || newStatus}</strong>{' '}
                on <strong>{willChange.length} employee{willChange.length !== 1 ? 's' : ''}</strong>.
                {noChange > 0 && ` ${noChange} already ${noChange === 1 ? 'has' : 'have'} this status and will be skipped.`}
              </p>
              <AffectedList employees={willChange} />
            </>
          )}
        </div>
        <div className="ed-modal-footer">
          <button
            className="ed-modal-cancel"
            onClick={() => (confirming ? setConfirming(false) : onClose())}
          >
            {confirming ? 'Back' : 'Cancel'}
          </button>
          {!confirming ? (
            <button
              className="ed-modal-confirm-primary"
              onClick={() => setConfirming(true)}
              disabled={!newStatus}
            >
              Review {count} change{count !== 1 ? 's' : ''}
            </button>
          ) : (
            <button
              className="ed-modal-confirm-danger"
              onClick={submit}
              disabled={submitting || willChange.length === 0}
            >
              {submitting ? 'Saving…' : `Set ${willChange.length} to ${STATUS_LABELS[newStatus] || newStatus}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function EmployeesData({ setPage, setSelectedEmployee }) {
  const { readOnly } = usePageAccess();
  const { role: userRole, hasPermission } = useAuth();
  const isEditorRole = EMPLOYEE_EDITOR_ROLES.has(String(userRole || '').toLowerCase());
  const [editNotice, setEditNotice] = useState(false);

  // Returns true when editing must be blocked (shows the notice popup).
  const blockEdit = () => {
    if (isEditorRole) return false;
    setEditNotice(true);
    return true;
  };
  const [employees,       setEmployees]       = useState([]);
  const [loading,         setLoading]         = useState(false);
  const [search,          setSearch]          = useState('');
  // Drill-down handed over by the Employees Dashboard (or HRDashboard's legacy
  // status key). Peeked in the initialiser and cleared in a mount effect —
  // see peekEmployeeListFilter() for why clearing here would break under
  // StrictMode. `status` and `dept` seed the page's own controls so the drill
  // lands on a list the user can then widen by hand; the remaining criteria
  // (gender, skill, tenure, joined-between) have no control on this page and
  // are applied through `drillFilter`, which the chip below can dismiss.
  const [drillFilter,     setDrillFilter]     = useState(peekEmployeeListFilter);
  const [dept,            setDept]            = useState(() => drillFilter?.department || 'All');
  const [status,          setStatus]          = useState(() => drillFilter?.status || 'All');
  const [role,            setRole]            = useState('All');
  const [sortKey,         setSortKey]         = useState('');
  const [sortDir,         setSortDir]         = useState('asc');
  const [page,            setCurrentPage]     = useState(1);
  const [pageSize,        setPageSize]        = useState(loadPageSize);
  // Legacy rows missing a mandatory field. A toggle, not a status option: being
  // incomplete is a data-quality fact, orthogonal to employment status, and
  // folding it into the Status dropdown would put a sixth non-status into the
  // vocabulary this page just finished consolidating.
  const [incompleteOnly,  setIncompleteOnly]  = useState(false);
  const [toast,           setToast]           = useState(null);
  const [showCols,        setShowCols]        = useState(false);
  const [visibleCols,     setVisibleCols]     = useState(loadSavedCols);
  const [selectedIds,     setSelectedIds]     = useState(new Set());
  const [terminateTarget,   setTerminateTarget]   = useState(null);
  const [bulkAssignOpen,   setBulkAssignOpen]   = useState(false);
  const [bulkStatusOpen,   setBulkStatusOpen]   = useState(false);
  const [statusConfirm,    setStatusConfirm]    = useState(null); // { emp, newStatus }

  const searchRef  = useRef(null);
  const colBtnRef  = useRef(null);
  const colPanRef  = useRef(null);
  const isMounted  = useRef(true);
  const abortRef   = useRef(null);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // Drop the handover so returning to this page later starts clean. Idempotent,
  // which is what makes it safe under StrictMode's double-invoked effects.
  useEffect(() => { clearEmployeeListFilter(); }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3200);
  };

  const load = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;
    setLoading(true);
    try {
      const res = await api.get('/employees?status=all', { signal });
      if (signal.aborted) return;
      setEmployees(res.data || []);
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      showToast('Failed to load employees', 'error');
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Exit details for staff serving notice.
   *
   * `/employees` carries no exit_requests data, so the notice columns would be
   * permanently blank without this. Fetched only when the Notice cohort is
   * actually on screen, and merged by employee id.
   *
   * days=365 with overdue included: a notice period can legitimately run
   * months out, and — more importantly — an exit whose last working day has
   * already passed is exactly the row HR needs to see here.
   */
  const [exitInfo, setExitInfo] = useState({});
  const showingNotice = status === 'Notice' || drillFilter?.status === 'Notice';
  useEffect(() => {
    if (!showingNotice) return undefined;
    const ctrl = new AbortController();
    api.get('/hr-widgets/upcoming-exits', { params: { days: 365 }, signal: ctrl.signal })
      .then(r => {
        const byId = {};
        for (const row of (Array.isArray(r.data) ? r.data : [])) byId[row.id] = row;
        setExitInfo(byId);
      })
      .catch(() => { /* columns fall back to em-dash; never blocks the list */ });
    return () => ctrl.abort();
  }, [showingNotice]);

  // Turn the notice columns on the moment that cohort is shown, without
  // touching the user's saved column preferences for every other view.
  useEffect(() => {
    if (!showingNotice) return;
    setVisibleCols(prev => {
      if (NOTICE_COLS.every(k => prev.has(k))) return prev;
      const next = new Set(prev);
      NOTICE_COLS.forEach(k => next.add(k));
      return next;
    });
  }, [showingNotice]);

  // Refresh list when browser tab regains visibility (catches stale data after editing)
  useEffect(() => {
    const handler = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [load]);

  // Clear selection when filters change to avoid acting on invisible rows
  useEffect(() => {
    setSelectedIds(new Set());
  }, [search, dept, status, role, incompleteOnly]);

  // Close col panel on outside click
  useEffect(() => {
    const handler = e => {
      if (colPanRef.current && !colPanRef.current.contains(e.target) &&
          colBtnRef.current && !colBtnRef.current.contains(e.target)) {
        setShowCols(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const depts = ['All', ...new Set(employees.map(e => e.department).filter(Boolean))];
  const roles = ['All', ...new Set(employees.map(e => e.designation).filter(Boolean))];

  // `bucketOf` is the shared vocabulary — the same one the API counts with.
  // This page used to carry its own EX_SET, which listed 'notice_period' but
  // not 'Notice' and left 'Inactive' in the staff set. The result was a Total
  // Staff tile of 33 against a dashboard Total Employees of 32, for the same
  // company on the same day. See features/employees/employeeStatus.js.
  const allStaff  = employees.filter(e => bucketOf(e.status) !== 'Exited');
  const active    = allStaff.filter(e => bucketOf(e.status) === 'Active');
  const probation = allStaff.filter(e => bucketOf(e.status) === 'Probation');
  const notice    = allStaff.filter(e => bucketOf(e.status) === 'Notice');
  const other     = allStaff.filter(e => bucketOf(e.status) === 'Other');

  const filtered = allStaff
    .filter(e => {
      // Every field the placeholder advertises, and nothing advertised that is
      // not searched. `reporting_manager` was the gap: the Manager column is
      // visible by default and typing a manager's name returned nothing.
      // `name` is included because that column is populated independently of
      // first/last on rows created outside the Add Employee form.
      const q = search.trim().toLowerCase();
      if (q) {
        const haystack = [
          `${e.first_name || ''} ${e.last_name || ''}`,
          e.name, e.office_id, e.company_email, e.personal_email,
          e.department, e.designation, e.reporting_manager,
        ];
        // isBlank filters out the literal 'null' rows, so searching "null" does
        // not match three employees on a value that is not really there.
        if (!haystack.some(v => !isBlank(v) && String(v).toLowerCase().includes(q))) return false;
      }
      if (dept   !== 'All' && e.department !== dept) return false;
      if (status !== 'All' && bucketOf(e.status) !== status) return false;
      if (role   !== 'All' && e.designation !== role) return false;
      if (incompleteOnly && missingFieldsOf(e).length === 0) return false;
      // Criteria the dashboard can send that this page has no control for.
      if (!matchesEmployeeFilter(e, drillFilter, tenureBucketOf)) return false;
      return true;
    })
    .sort((a, b) => {
      if (!sortKey) return 0;
      let va, vb;
      if (sortKey === '_age') {
        va = a.dob ? new Date(a.dob).getTime() : 0;
        vb = b.dob ? new Date(b.dob).getTime() : 0;
      } else if (sortKey === '_experience') {
        // compute total years as a float for numeric sort
        const expYrs = emp => {
          const prev = (parseFloat(emp.previous_years_1)||0) + (parseFloat(emp.previous_years_2)||0);
          const cur  = emp.joining_date
            ? (Date.now() - new Date(emp.joining_date)) / (365.25*24*60*60*1000)
            : 0;
          return prev + cur;
        };
        va = expYrs(a); vb = expYrs(b);
      } else {
        va = (a[sortKey]||'').toString().toLowerCase();
        vb = (b[sortKey]||'').toString().toLowerCase();
      }
      if (typeof va === 'number') return sortDir==='asc' ? va-vb : vb-va;
      return sortDir==='asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });

  const totalPages     = Math.max(1, Math.ceil(filtered.length / pageSize));
  /**
   * Clamped, not just derived.
   *
   * Every filter control calls setCurrentPage(1), but `page` also had to survive
   * a change in the underlying LIST — a refresh, a termination, a bulk status
   * change that moves rows out of the current filter. On page 2 of 2 with 21
   * rows, terminating one leaves 20: totalPages drops to 1 and the old
   * slice(20, 40) returned [], rendering an empty table under a count that said
   * "20 of 20". Clamping here means no code path can leave the view past the
   * end.
   */
  const safePage       = Math.min(page, totalPages);
  const firstRowNum    = filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const lastRowNum     = Math.min(safePage * pageSize, filtered.length);
  const pageRows       = filtered.slice((safePage-1)*pageSize, safePage*pageSize);
  const allPageSelected = pageRows.length > 0 && pageRows.every(e => selectedIds.has(e.id));

  /** Rows on the register that are not complete master records. */
  const incompleteCount = allStaff.filter(e => missingFieldsOf(e).length > 0).length;

  /**
   * Employees who match the drill-down but have LEFT, so this register does not
   * list them.
   *
   * The Employees Dashboard's New Hires KPI counts everyone hired in the period —
   * correctly, since it is a hiring-activity metric. This page lists current staff
   * — correctly, since ex-employees live on Ex-Employees. So clicking a KPI of 27
   * lands on a list of 26, and both numbers are right.
   *
   * Right is not the same as explained. Rather than change either population
   * (the KPI would stop measuring hiring; the register would start listing
   * leavers), the chip states the difference. `employees` holds every status
   * because the page fetches `?status=all`, so this costs nothing extra.
   */
  const drillExitedCount = drillFilter
    ? employees.filter(e =>
        bucketOf(e.status) === 'Exited' &&
        matchesEmployeeFilter(e, drillFilter, tenureBucketOf) &&
        (drillFilter.status == null || drillFilter.status === 'All')).length
    : 0;

  function changePageSize(n) {
    setPageSize(n);
    // Back to the first page: keeping the page number while the window grows
    // would jump past rows the user was looking at.
    setCurrentPage(1);
    try { localStorage.setItem(LS_PAGE_SIZE, String(n)); } catch { /* blocked storage */ }
  }

  /**
   * Keep `page` in STATE from sitting past the last page.
   *
   * `safePage` above already clamps what is RENDERED, so the table is never
   * blank; this settles the state so the next interaction starts from a real page
   * number rather than from a stale one that happens to clamp.
   *
   * MUST stay BELOW the `totalPages` const. Declared above it, the dependency
   * array is evaluated in the same render pass while `totalPages` is still in its
   * temporal dead zone, and the whole page dies inside the error boundary with
   * "Cannot access 'totalPages' before initialization" -- not a wrong number, a
   * blank page. Caught by tests/suites/22-all-employees.spec.ts, which is the
   * only thing in this repo that actually renders this component.
   */
  useEffect(() => {
    setCurrentPage(p => Math.min(p, totalPages));
  }, [totalPages]);

  function toggleSelectAll() {
    if (allPageSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        pageRows.forEach(e => next.delete(e.id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        pageRows.forEach(e => next.add(e.id));
        return next;
      });
    }
  }

  function toggleSelectOne(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSort(key) {
    if (sortKey===key) setSortDir(d => d==='asc'?'desc':'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }

  function SortIcon({ colKey }) {
    if (sortKey!==colKey) return <ChevronDown size={10} className="ed-sort-icon"/>;
    return sortDir==='asc' ? <ChevronUp size={10} className="ed-sort-active"/> : <ChevronDown size={10} className="ed-sort-active"/>;
  }

  async function applyStatusChange(emp, newStatus) {
    try {
      await api.patch(`/employees/${emp.id}/status`, { status: newStatus });
      if (!isMounted.current) return;
      setEmployees(prev => prev.map(e => e.id===emp.id ? { ...e, status:newStatus } : e));
      showToast(`${emp.first_name}'s status updated to ${newStatus}`);
    } catch {
      if (!isMounted.current) return;
      showToast('Failed to update status', 'error');
    }
  }

  function handleStatusChange(emp, newStatus) {
    if (blockEdit()) return;
    if (newStatus === emp.status) return;
    if (DESTRUCTIVE_STATUSES.has(newStatus)) {
      setStatusConfirm({ emp, newStatus });
    } else {
      applyStatusChange(emp, newStatus);
    }
  }

  /**
   * Bulk status change.
   *
   * allSettled, not all(): these are N independent requests, and Promise.all
   * rejects on the first failure while the rest keep going. The old code then
   * showed "Failed to update status" and updated NOTHING in local state — so
   * eleven of twelve employees had in fact been changed on the server while the
   * page insisted nothing had happened. Apply exactly the ones that succeeded
   * and say how many did not.
   */
  async function handleBulkStatus(newStatus) {
    // Only the rows that actually change, matching what the confirm step listed.
    const targets = selectedEmployees.filter(e => bucketOf(e.status) !== bucketOf(newStatus));
    const results = await Promise.allSettled(
      targets.map(e => api.patch(`/employees/${e.id}/status`, { status: newStatus })),
    );
    if (!isMounted.current) return;
    const okIds = new Set(targets.filter((_, i) => results[i].status === 'fulfilled').map(e => e.id));
    const failed = targets.length - okIds.size;

    setEmployees(prev => prev.map(e => okIds.has(e.id) ? { ...e, status: newStatus } : e));
    setSelectedIds(new Set());
    setBulkStatusOpen(false);
    if (failed === 0) {
      showToast(`Status updated for ${okIds.size} employee${okIds.size !== 1 ? 's' : ''}`);
    } else {
      showToast(
        `${okIds.size} updated, ${failed} failed — the failed records are unchanged`,
        okIds.size ? 'error' : 'error',
      );
    }
  }

  // Hands the exit to Exit Management → Initiate Exit, pre-filled; writes nothing
  // here (containment C6 / MD-14). Exit Management maps the reason to a
  // separation type and HR confirms it there.
  function handleTerminate(exitDate, exitReason) {
    const emp = terminateTarget;
    setTerminateTarget(null);
    setPage('ExitCenter', {
      tab: 'exit',
      initiate: String(emp.id),
      lwd: exitDate,
      ...(exitReason ? { reason: exitReason } : {}),
      name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
    });
  }

  /** Same partial-failure handling as handleBulkStatus — see its comment. */
  async function handleBulkAssign(newDept) {
    const targets = selectedEmployees;
    const results = await Promise.allSettled(
      targets.map(e => api.put(`/employees/${e.id}`, { department: newDept })),
    );
    if (!isMounted.current) return;
    const okIds = new Set(targets.filter((_, i) => results[i].status === 'fulfilled').map(e => e.id));
    const failed = targets.length - okIds.size;

    setEmployees(prev => prev.map(e => okIds.has(e.id) ? { ...e, department: newDept } : e));
    setSelectedIds(new Set());
    setBulkAssignOpen(false);
    showToast(
      failed === 0
        ? `Department updated for ${okIds.size} employee${okIds.size !== 1 ? 's' : ''}`
        : `${okIds.size} updated, ${failed} failed — the failed records are unchanged`,
      failed === 0 ? 'success' : 'error',
    );
  }

  /**
   * The selected ROWS, not just their ids.
   *
   * Drawn from `employees` rather than `filtered`, so a selection survives a
   * filter change long enough for the confirmation list to name every record —
   * including any the current filter has since hidden, which is exactly the
   * mistake a confirmation step exists to catch.
   */
  const selectedEmployees = employees.filter(e => selectedIds.has(e.id));

  const hasFilters    = search || dept!=='All' || status!=='All' || role!=='All'
                        || incompleteOnly || !!drillFilter;

  /** Clear everything, including the criteria that have no on-page control. */
  function clearAllFilters() {
    setSearch(''); setDept('All'); setStatus('All'); setRole('All');
    setIncompleteOnly(false); setDrillFilter(null); setCurrentPage(1);
  }

  /**
   * What the banner says. Built from LIVE state, not from the handover's
   * `label`: status and department are seeded into this page's own controls,
   * so once the user changes one, a frozen label would keep claiming a filter
   * that is no longer applied. The handover's wording is kept only while those
   * two still match what was handed over — it phrases a joined-between window
   * ("Joined This financial year (01 Apr 26 – 27 Sept 26)") better than the
   * raw dates do.
   */
  const drillDescription = (() => {
    if (!drillFilter) return '';
    const untouched =
      (drillFilter.status || 'All') === status &&
      (drillFilter.department || 'All') === dept;
    if (untouched && drillFilter.label) return drillFilter.label;
    return describeEmployeeFilter({
      ...drillFilter,
      label: undefined,
      status: status !== 'All' ? status : undefined,
      department: dept !== 'All' ? dept : undefined,
    });
  })();
  const customColCount = COLUMN_DEFS.filter(c => !c.always && !c.defaultOn && visibleCols.has(c.key)).length;

  // Active + Probation + Notice + Other == Total Staff, by construction, and
  // Total Staff == the dashboard's Total Employees for the same company. The
  // old band offered an 'Inactive' tile, which is an EXITED status and so was
  // permanently 0 inside a set that excluded it.
  const KPI_CARDS = [
    { label:'Active',     value:active.length,    icon:TrendingUp, palette:{ bg:'#f0fdf4', color:'#166534', icon:'#22c55e' }, filter:'Active'    },
    { label:'Probation',  value:probation.length, icon:Clock,      palette:{ bg:'#f5f3ff', color:'#5b21b6', icon:'#7c5cf0' }, filter:'Probation' },
    { label:'On Notice',  value:notice.length,    icon:AlertCircle,palette:{ bg:'#fffbeb', color:'#92400e', icon:'#f59e0b' }, filter:'Notice'    },
    ...(other.length
      ? [{ label:'Other',  value:other.length,    icon:Users,      palette:{ bg:'#f9fafb', color:'#374151', icon:'#9ca3af' }, filter:'Other'     }]
      : []),
    /**
     * Total Staff is the whole current-staff population — it is not a status, so
     * it carries an `action` rather than a `filter`.
     *
     * The register's base population ALREADY excludes exited employees
     * (`allStaff`), so this cannot narrow the list further, and pretending
     * otherwise would be a filter that changes nothing. What it does instead is
     * genuinely useful: it CLEARS any status/department/role/incomplete narrowing
     * and states, in the chip, that you are looking at all 32 current staff and
     * that N exited records exist elsewhere. That is the one fact the page
     * otherwise hides — the count line says "32 of 32" and never mentions the 34
     * rows behind it.
     */
    { label:'Total Staff',value:allStaff.length,  icon:Briefcase,  palette:{ bg:'#ede9fe', color:'#5b21b6', icon:'#6B3FDB' }, action:'current'   },
  ];

  // ── Render one table cell for a column ──────────────────────────────────────
  function renderCell(emp, col, sc) {
    const exit = exitInfo[emp.id];
    switch (col.key) {
      case '_notice_start':
        return exit?.notice_started_on ? fmtDate(exit.notice_started_on) : EMPTY;
      case '_notice_lwd':
        return exit?.last_working_date ? fmtDate(exit.last_working_date) : EMPTY;
      case '_notice_days': {
        if (!exit || exit.days_remaining == null) return EMPTY;
        const d = Number(exit.days_remaining);
        // Past the last working day but still on the register: the exit has
        // stalled. Say so rather than showing a quiet negative number.
        return (
          <span style={{ fontWeight: 600, color: d < 0 ? '#b91c1c' : d <= 7 ? '#b45309' : '#374151' }}>
            {d < 0 ? `${Math.abs(d)}d overdue` : d === 0 ? 'today' : `${d}d left`}
          </span>
        );
      }
      case '_notice_status':
        return exit?.exit_request_status
          ? <span className="ed-badge-soft">{exit.exit_request_status}</span>
          : EMPTY;
      case '_num':
      case '_employee':
      case '_actions':
        return null;
      case '_status': {
        // The stored value is not always one this control can SET: the READ
        // vocabulary tolerates 'notice_period', 'resigned', 'Sabbatical' and
        // more, while WRITABLE_STATUSES is four values. When they differ, offer
        // the stored value as a selected, disabled option rather than letting the
        // <select> silently display its first option -- which is what made a row
        // stored as 'notice_period' read as "Active" on screen.
        const canon = canonicalWritableStatus(emp.status);
        return (
          <div className="ed-status-wrap">
            <span className="ed-status-dot" style={{ background: sc.dot }}/>
            <select
              className="ed-status-select"
              value={canon ?? '__raw'}
              style={{ color: sc.color }}
              onChange={e => handleStatusChange(emp, e.target.value)}
              aria-label={`Employment status for ${emp.first_name || ''} ${emp.last_name || ''}`.trim()}
            >
              {!canon && (
                <option value="__raw" disabled>
                  {display(emp.status)} ({bucketOf(emp.status)})
                </option>
              )}
              {/* 'Left' is writable but deliberately not offered here -- exiting
                  goes through Terminate so a last working day is recorded. */}
              {BULK_WRITABLE_STATUSES.map(v => (
                <option key={v} value={v}>{STATUS_LABELS[v] || v}</option>
              ))}
            </select>
          </div>
        );
      }
      case '_age':
        return <span className="ed-td-chip">{calcAge(emp.dob)}</span>;
      case '_experience':
        return <span className="ed-td-chip ed-td-chip-blue">{calcExperience(emp)}</span>;
      // The three mandatory fields render their absence as a flagged gap, not as
      // a neutral em-dash. An em-dash reads as "nothing to say here"; these are
      // records that cannot be completed by looking at them.
      case 'office_id':
        return isBlank(emp.office_id)
          ? <span className="ed-missing" title="No Employee ID - this record predates server-side ID generation">Not assigned</span>
          : <span className="ed-emp-id">{emp.office_id}</span>;
      case 'department':
        return isBlank(emp.department)
          ? <span className="ed-missing" title="Department is required on an employee record">Missing</span>
          : <span className="ed-dept-pill">{emp.department}</span>;
      case 'designation':
        return isBlank(emp.designation)
          ? <span className="ed-missing" title="Role / Designation is required on an employee record">Missing</span>
          : <span className="ed-td-role">{emp.designation}</span>;
      case 'joining_date':
        return <span className="ed-td-muted">{fmtDate(emp.joining_date)}</span>;
      case 'dob':
        return <span className="ed-td-muted">{fmtDate(emp.dob)}</span>;
      case 'reporting_manager':
        // isBlank, not truthiness. Three live rows hold the STRING 'null' here
        // (employee ids 6, 12 and 46), which is truthy, so the old guard printed
        // the word `null` into the Manager column. See displayValue.js.
        return isBlank(emp.reporting_manager)
          ? <span className="ed-td-muted">Not assigned</span>
          : <span className="ed-manager">{emp.reporting_manager}</span>;
      case 'blood_group':
        return isBlank(emp.blood_group)
          ? EMPTY
          : <span className="ed-td-chip ed-td-chip-red">{emp.blood_group}</span>;
      case 'gender':
        return isBlank(emp.gender)
          ? EMPTY
          : <span className="ed-td-chip">{emp.gender}</span>;
      case 'employment_type':
        return isBlank(emp.employment_type)
          ? EMPTY
          : <span className="ed-td-chip">{emp.employment_type}</span>;
      case 'skill_type':
        return display(emp.skill_type);
      case 'pan_number':
        return isBlank(emp.pan_number)
          ? EMPTY
          : <span className="ed-td-mono">{emp.pan_number}</span>;
      case 'aadhaar_number':
        return isBlank(emp.aadhaar_number)
          ? EMPTY
          : <span className="ed-td-mono">****{String(emp.aadhaar_number).slice(-4)}</span>;
      default:
        // display(), not `|| em-dash`. The default arm serves every column added
        // from here on, so a truthiness check here is a standing invitation for
        // the next 'null'-shaped value to reach the screen.
        return display(emp[col.key]);
    }
  }

  // visible sorted columns (always-cols handled specially)
  const orderedCols = COLUMN_DEFS.filter(c => c.always || visibleCols.has(c.key));

  return (
    <PageShell dock={
      <PageHero
        icon={Users}
        eyebrow="Employees"
        title="All Employees"
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={load} title="Refresh"><RefreshCw size={14}/></button>
          {/* States the count, so "Export" cannot be mistaken for "export the
              whole database" when a filter is active — it exports exactly the
              rows the table is showing. */}
          <button
            className="plh-cta plh-cta--ghost"
            onClick={() => exportCSV(filtered, visibleCols, hasFilters ? 'filtered' : 'all')}
            title={hasFilters
              ? `Export the ${filtered.length} employees matching the current filters`
              : `Export all ${filtered.length} employees`}
          >
            <Download size={13}/> Export{filtered.length ? ` (${filtered.length})` : ''}
          </button>
          {/*
            The master lists behind the Add Employee pickers, one click from
            the register HR already lives on — rather than buried in Settings.
            Opens the SAME management screen, scoped to the employee masters.
          */}
          {/* Interns are a separate register (own INT numbers, not in this
              list or its headcount). Offered only to a caller who can open it. */}
          {hasPermission?.('internships', 'view') && (
            <button className="plh-cta plh-cta--ghost" onClick={() => setPage('Internships')}
              title="Interns are kept in their own register, separate from employees">
              View Internships →
            </button>
          )}
          {!readOnly && (
            <button
              className="plh-cta plh-cta--ghost"
              title="Add, rename, deactivate or remove the departments, designations and other lists used on Add Employee"
              onClick={() => setPage('EmployeeMasters')}
            >
              <SlidersHorizontal size={13}/> Manage Employee Masters
            </button>
          )}
          {!readOnly && (
            <button className="plh-cta" onClick={() => { if (blockEdit()) return; setSelectedEmployee(null); setPage('AddEmployee'); }}>
              <Plus size={14}/> Add Employee
            </button>
          )}
        </>}
      />
    }>

      {/* Toast */}
      {toast && (
        <div className={`ed-toast ${toast.type==='error'?'ed-toast-error':'ed-toast-success'}`}>
          <span className="ed-toast-dot"/>
          {toast.msg}
        </div>
      )}

      {/* Terminate modal — always mounted so Playwright can track visibility changes */}
      <TerminateModal
        emp={terminateTarget || {}}
        onConfirm={handleTerminate}
        onClose={() => setTerminateTarget(null)}
        open={!!terminateTarget}
      />

      {/* Bulk assign department modal */}
      {bulkAssignOpen && (
        <BulkAssignModal
          employees={selectedEmployees}
          departments={depts}
          onConfirm={handleBulkAssign}
          onClose={() => setBulkAssignOpen(false)}
        />
      )}

      {/* Bulk status change modal */}
      {bulkStatusOpen && (
        <BulkStatusModal
          employees={selectedEmployees}
          onConfirm={handleBulkStatus}
          onClose={() => setBulkStatusOpen(false)}
        />
      )}

      {/* Status change confirmation modal */}
      {statusConfirm && (
        <StatusConfirmModal
          emp={statusConfirm.emp}
          newStatus={statusConfirm.newStatus}
          onConfirm={() => {
            applyStatusChange(statusConfirm.emp, statusConfirm.newStatus);
            setStatusConfirm(null);
          }}
          onClose={() => setStatusConfirm(null)}
        />
      )}

      {/* Not-allowed notice for employee-role users */}
      {editNotice && (
        <div className="ed-modal-overlay" onClick={() => setEditNotice(false)}>
          <div className="ed-modal" onClick={e => e.stopPropagation()}>
            <div className="ed-modal-hd">
              <span className="ed-modal-title">Editing Not Allowed</span>
              <button className="ed-col-close" onClick={() => setEditNotice(false)}><X size={13}/></button>
            </div>
            <div className="ed-modal-body">
              <p className="ed-modal-sub">
                You are logged in as an <strong>employee</strong> — you are not allowed to edit
                employee records. Please contact HR/Admin for any changes.
              </p>
            </div>
            <div className="ed-modal-footer">
              <button className="ed-modal-confirm-primary" onClick={() => setEditNotice(false)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {readOnly && <ReadOnlyBanner />}

      {/* ── Header ─────────────────────────────────────────────────────────── */}

      {/* ── Drill-down banner ──────────────────────────────────────────────
          A list arrived at from a dashboard card must SAY it is narrowed.
          Without this the page looks like the full employee register with a
          surprisingly small row count, and every count on it silently
          disagrees with the register. */}
      {drillFilter && (
        <div className="ed-drill-chip">
          <Filter size={12} />
          <span>
            Showing <strong>{filtered.length}</strong> of {allStaff.length} employees ·{' '}
            {drillDescription}
            {drillExitedCount > 0 && (
              /* Without this the arithmetic silently fails to add up against the
                 card that was clicked: a New Hires card reading 27 opening a list
                 of 26 is a discrepancy until the 1 leaver is named.
                 "since left" only means anything for a drill with a date window —
                 for Total Staff the same number is simply the exited records that
                 this register never shows, so the wording follows the filter. */
              <span className="ed-drill-note">
                {(drillFilter.joinedFrom || drillFilter.joinedTo)
                  ? ` · ${drillExitedCount} more ${drillExitedCount === 1 ? 'has' : 'have'} since left`
                    + ` and ${drillExitedCount === 1 ? 'is' : 'are'} on Ex-Employees`
                  : ` · ${drillExitedCount} exited ${drillExitedCount === 1 ? 'record' : 'records'}`
                    + ` ${drillExitedCount === 1 ? 'is' : 'are'} not shown here — see Ex-Employees`}
              </span>
            )}
          </span>
          {drillFilter.origin && (
            <button type="button" className="ed-drill-back" onClick={() => setPage(drillFilter.origin)}>
              Back to dashboard
            </button>
          )}
          <button type="button" className="ed-drill-clear" onClick={clearAllFilters} title="Show all employees">
            <X size={12} /> Clear
          </button>
        </div>
      )}

      {/* ── KPI Cards ──────────────────────────────────────────────────────── */}
      <div className="ed-kpi-row">
        {KPI_CARDS.map(c => {
          const Icon = c.icon;
          const isActive = c.filter
            ? status === c.filter
            : drillFilter?.label === CURRENT_STAFF_LABEL;
          return (
            /**
             * A real <button>, not a div with onClick.
             *
             * These were divs, so the whole KPI band was unreachable by keyboard
             * and invisible to a screen reader: no role, no accessible name, no
             * Enter/Space. A button gets all of that from the platform rather than
             * from a pile of onKeyDown/role/tabIndex props that have to be kept
             * right. Nothing inside is interactive, so there is no nested button.
             */
            <button
              type="button"
              key={c.label}
              className={`ed-kpi-card ed-kpi-card-clickable${isActive ? ' ed-kpi-card-active' : ''}`}
              onClick={() => {
                setCurrentPage(1);
                if (c.filter) {
                  // Clicking the active one again releases it — the card is a
                  // toggle, which is why it reports aria-pressed.
                  setDrillFilter(null);
                  setStatus(s => (s === c.filter ? 'All' : c.filter));
                  return;
                }
                // Total Staff: drop every narrowing, then state what is on screen.
                setSearch(''); setDept('All'); setStatus('All'); setRole('All');
                setIncompleteOnly(false);
                setDrillFilter(isActive ? null : { label: CURRENT_STAFF_LABEL });
              }}
              aria-pressed={isActive}
              /* The visible text is a bare number and a short label, which reads as
                 "32 Total Staff" out of context. Spell out what activating it does. */
              aria-label={c.filter
                ? `${c.label}: ${c.value} employees. Filter the list to ${c.label}.`
                : `${c.label}: ${c.value} employees. Show all current staff.`}
              title={c.filter
                ? `Filter by ${c.label}`
                : 'Show all current staff — clears the other filters'}
            >
              <div className="ed-kpi-icon" style={{ background:c.palette.bg, color:c.palette.icon }}>
                <Icon size={18}/>
              </div>
              <div className="ed-kpi-body">
                <span className="ed-kpi-val" style={{ color:c.palette.color }}>{c.value}</span>
                <span className="ed-kpi-label">{c.label}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Filter Bar ─────────────────────────────────────────────────────── */}
      <div className="ed-filter-bar">
        <div className="ed-search-wrap">
          <Search size={13} className="ed-search-icon"/>
          <input
            ref={searchRef}
            className="ed-search"
            value={search}
            onChange={e => { setSearch(e.target.value); setCurrentPage(1); }}
            placeholder="Search name, ID, email, dept, role, manager…"
          />
          {search && <button className="ed-search-clear" onClick={() => setSearch('')}><X size={12}/></button>}
        </div>

        <div className="ed-filter-selects">
          <div className="ed-select-wrap">
            <Filter size={11} className="ed-select-icon"/>
            <select className="ed-select" value={dept} onChange={e => { setDept(e.target.value); setCurrentPage(1); }}>
              {depts.map(d => <option key={d} value={d}>{d==='All'?'All Departments':d}</option>)}
            </select>
          </div>
          <div className="ed-select-wrap">
            <select className="ed-select" value={status} onChange={e => { setStatus(e.target.value); setCurrentPage(1); }}>
              <option value="All">All Status</option>
              <option value="Active">Active</option>
              <option value="Probation">Probation</option>
              <option value="Notice">On Notice</option>
              {/* 'Inactive' was here and could never match: this list only
                  holds current staff, and Inactive is an exited status.
                  Ex-employees live on the Ex-Employees page. */}
              {other.length > 0 && <option value="Other">Other</option>}
            </select>
          </div>
          <div className="ed-select-wrap">
            <select className="ed-select" value={role} onChange={e => { setRole(e.target.value); setCurrentPage(1); }}>
              {roles.map(r => <option key={r} value={r}>{r==='All'?'All Roles':r}</option>)}
            </select>
          </div>
          {/* Incomplete legacy records stay on the register and stay visible --
              the user's instruction was not to delete them. This makes them
              reachable in one click instead of leaving them scattered through 32
              rows, and the count states the size of the problem on its face. */}
          {incompleteCount > 0 && (
            <button
              type="button"
              className={`ed-incomplete-btn${incompleteOnly ? ' ed-incomplete-btn-on' : ''}`}
              onClick={() => { setIncompleteOnly(v => !v); setCurrentPage(1); }}
              title={"Records missing a mandatory field — Employee ID, Department, Role, Status or Joining date. These would fail validation if created today."}
              aria-pressed={incompleteOnly}
            >
              <AlertCircle size={11}/> Incomplete
              <span className="ed-incomplete-count">{incompleteCount}</span>
            </button>
          )}
          {hasFilters && (
            <button className="ed-clear-btn" onClick={clearAllFilters}>
              <X size={11}/> Clear
            </button>
          )}
        </div>

        {/* Rows-per-page at the TOP, so the page size can be changed without
            scrolling past the entire table to reach the pagination bar. Same
            component and same state as the one at the bottom. */}
        <div className="ed-filter-right">
          <PageSizeControl
            id="ed-page-size-top"
            pageSize={pageSize}
            onChange={changePageSize}
          />
        </div>

        {/* Column chooser button */}
        <div className="ed-col-btn-wrap" style={{ position:'relative' }}>
          <button
            ref={colBtnRef}
            className={`ed-col-btn${showCols?' ed-col-btn-active':''}`}
            onClick={() => setShowCols(v => !v)}
            title="Column visibility"
          >
            <Columns size={13}/>
            Columns
            {customColCount > 0 && <span className="ed-col-badge">{customColCount}</span>}
          </button>
          {showCols && (
            <div ref={colPanRef} className="ed-col-panel-wrap">
              <ColPanel
                visibleCols={visibleCols}
                setVisibleCols={setVisibleCols}
                onClose={() => setShowCols(false)}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Bulk Action Bar ─────────────────────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <div className="ed-bulk-bar">
          <div className="ed-bulk-info">
            <CheckSquare size={14} className="ed-bulk-icon"/>
            <strong>{selectedIds.size}</strong>&nbsp;employee{selectedIds.size !== 1 ? 's' : ''} selected
          </div>
          <div className="ed-bulk-actions">
            <button
              className="ed-bulk-btn"
              onClick={() => exportCSV(selectedEmployees, visibleCols, 'selected')}
            >
              <Download size={12}/> Export Selected ({selectedIds.size})
            </button>
            {!readOnly && (
              <>
                <button className="ed-bulk-btn" onClick={() => { if (blockEdit()) return; setBulkAssignOpen(true); }}>
                  <UserCheck size={12}/> Assign Department
                </button>
                <button className="ed-bulk-btn" onClick={() => { if (blockEdit()) return; setBulkStatusOpen(true); }}>
                  <RefreshCw size={12}/> Change Status
                </button>
              </>
            )}
            <button className="ed-bulk-btn-clear" onClick={() => setSelectedIds(new Set())}>
              <X size={12}/> Deselect All
            </button>
          </div>
        </div>
      )}

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      <div className="ed-table-card">
        {loading ? (
          <div className="ed-skeleton-list">
            {[1,2,3,4,5,6].map(i => <div key={i} className="ed-skeleton-row"/>)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="ed-empty">
            <div className="ed-empty-icon"><Users size={36}/></div>
            {employees.length === 0 ? (
              <>
                <p className="ed-empty-title">No employees yet</p>
                <p className="ed-empty-sub">Start by adding your first team member</p>
                {!readOnly && (
                  <button className="ed-add-btn" onClick={() => { if (blockEdit()) return; setSelectedEmployee(null); setPage('AddEmployee'); }}>
                    <Plus size={13}/> Add First Employee
                  </button>
                )}
              </>
            ) : (
              <>
                <p className="ed-empty-title">No results found</p>
                <p className="ed-empty-sub">Try adjusting your search or filters</p>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="ed-table-topbar">
              {/* A RANGE, not a count of the current page. "Showing 20 of 32"
                  reads as "20 match, out of 32 employees" -- it gave no hint
                  that 12 more were one click away, and on page 2 it said the
                  same thing about a different 12 rows. */}
              <span className="ed-table-count">
                Showing <strong>{firstRowNum}{lastRowNum > firstRowNum ? `\u2013${lastRowNum}` : ''}</strong>{' '}
                of <strong>{filtered.length}</strong> employee{filtered.length === 1 ? '' : 's'}
                {filtered.length !== allStaff.length && (
                  <span className="ed-table-count-filtered"> (filtered from {allStaff.length})</span>
                )}
              </span>
              <span className="ed-table-cols-info">
                {orderedCols.filter(c => !c.always).length} columns visible
              </span>
            </div>
            <div className="ed-table-scroll">
              <table className="ed-table">
                <thead>
                  <tr>
                    <th className="ed-th ed-th-num">
                      <div className="ed-check-num">
                        <input
                          type="checkbox"
                          className="ed-row-check"
                          checked={allPageSelected}
                          onChange={toggleSelectAll}
                          title={allPageSelected ? 'Deselect page' : 'Select page'}
                        />
                        <span className="ed-num-label">#</span>
                      </div>
                    </th>
                    <th className="ed-th">Employee</th>
                    {orderedCols.filter(c => !c.always).map(col => (
                      <th
                        key={col.key}
                        className={`ed-th${['office_id','department','designation','joining_date','_age','_experience'].includes(col.key)?' ed-th-sort':''}`}
                        onClick={() => ['office_id','department','designation','joining_date','_age','_experience'].includes(col.key) && toggleSort(col.key)}
                      >
                        {col.label}
                        {['office_id','department','designation','joining_date','_age','_experience'].includes(col.key) && (
                          <SortIcon colKey={col.key}/>
                        )}
                      </th>
                    ))}
                    <th className="ed-th ed-th-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((emp, i) => {
                    const sc         = statusCfg(emp.status||'Active');
                    const name       = `${emp.first_name||''} ${emp.last_name||''}`.trim();
                    const ap         = avatarPalette(name);
                    const initials   = ((emp.first_name||'?').charAt(0)+(emp.last_name||'').charAt(0)).toUpperCase();
                    const isSelected = selectedIds.has(emp.id);
                    const gaps       = missingFieldsOf(emp);
                    return (
                      <tr
                        key={emp.id}
                        className={`ed-tr${isSelected ? ' ed-tr-selected' : ''}${gaps.length ? ' ed-tr-incomplete' : ''}`}
                      >
                        <td className="ed-td ed-td-num">
                          <div className="ed-check-num">
                            <input
                              type="checkbox"
                              className="ed-row-check"
                              checked={isSelected}
                              onChange={() => toggleSelectOne(emp.id)}
                            />
                            <span className="ed-num-label">{(safePage-1)*pageSize+i+1}</span>
                          </div>
                        </td>
                        <td className="ed-td">
                          <div className="ed-name-cell">
                            {emp.photo_url
                              ? <img src={emp.photo_url} alt={name} className="ed-avatar ed-avatar-photo" />
                              : <div className="ed-avatar" style={{ background:ap.bg, color:ap.color }}>{initials}</div>
                            }
                            <div>
                              <div className="ed-name">
                                {name || display(emp.company_email)}
                                {gaps.length > 0 && (
                                  <span
                                    className="ed-gap-badge"
                                    title={`Incomplete record — missing ${gaps.join(', ')}`}
                                  >
                                    <AlertCircle size={10}/>
                                    {/* Names the gaps inline. "Incomplete" alone tells HR
                                        that something is wrong and nothing about what to
                                        fix, turning a one-click correction into a hunt
                                        through the record. Capped at two so a row with
                                        five gaps cannot wrap the name column. */}
                                    {gaps.slice(0, 2).join(' · ')}
                                    {gaps.length > 2 ? ` +${gaps.length - 2}` : ''}
                                  </span>
                                )}
                              </div>
                              <div className="ed-email">{display(emp.company_email, '')}</div>
                            </div>
                          </div>
                        </td>
                        {orderedCols.filter(c => !c.always).map(col => (
                          <td key={col.key} className="ed-td">
                            {renderCell(emp, col, sc)}
                          </td>
                        ))}
                        <td className="ed-td ed-td-actions">
                          <div className="ed-actions">
                            <button className="ed-btn-view" onClick={() => { sessionStorage.setItem('selectedEmployeeId', String(emp.id)); sessionStorage.setItem('selectedEmployee', JSON.stringify(emp)); setSelectedEmployee(emp); setPage('EmployeeProfile', { id: emp.id }); }}>
                              <Eye size={12}/> View
                            </button>
                            {!readOnly && (
                              <>
                                <button className="ed-btn-edit" onClick={() => { if (blockEdit()) return; sessionStorage.setItem('selectedEmployeeId', String(emp.id)); sessionStorage.setItem('selectedEmployee', JSON.stringify(emp)); setSelectedEmployee(emp); setPage('EditEmployee'); }}>
                                  <Edit2 size={12}/> Edit
                                </button>
                                <button
                                  className="ed-btn-deact"
                                  onClick={() => { if (blockEdit()) return; setTerminateTarget(emp); }}
                                  title="Terminate employee"
                                >
                                  <UserX size={12}/>
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Rendered whenever there are rows, not only when totalPages > 1: the
            rows-per-page control lives here, and at 20-of-32 the old condition
            showed it while at 50-of-32 it vanished -- so the only way back to a
            smaller page size disappeared exactly when it had been used. */}
        {filtered.length > 0 && (
          <div className="ed-pagination">
            <PageSizeControl
              id="ed-page-size-bottom"
              pageSize={pageSize}
              onChange={changePageSize}
              compact
            />

            <span className="ed-page-info">
              {firstRowNum}{lastRowNum > firstRowNum ? `\u2013${lastRowNum}` : ''} of {filtered.length}
              {totalPages > 1 && <> · page <strong>{safePage}</strong> of <strong>{totalPages}</strong></>}
            </span>

            {totalPages > 1 && (
              <div className="ed-page-btns">
                <button
                  className={`ed-page-btn${safePage === 1 ? ' ed-page-btn-disabled' : ''}`}
                  onClick={() => safePage > 1 && setCurrentPage(safePage - 1)}
                  disabled={safePage === 1}
                >Previous</button>

                {pageItems(safePage, totalPages).map(item =>
                  typeof item === 'number' ? (
                    <button
                      key={item}
                      className={`ed-page-btn${item === safePage ? ' ed-page-btn-current' : ''}`}
                      onClick={() => setCurrentPage(item)}
                      aria-current={item === safePage ? 'page' : undefined}
                    >{item}</button>
                  ) : (
                    <span key={item} className="ed-page-gap">…</span>
                  )
                )}

                <button
                  className={`ed-page-btn${safePage === totalPages ? ' ed-page-btn-disabled' : ''}`}
                  onClick={() => safePage < totalPages && setCurrentPage(safePage + 1)}
                  disabled={safePage === totalPages}
                >Next</button>
              </div>
            )}
          </div>
        )}
      </div>
    </PageShell>
  );
}
