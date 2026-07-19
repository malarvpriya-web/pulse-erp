// PATH: frontend/src/features/employees/pages/EmployeesData.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search, X, Download, Plus, Eye, Edit2, UserX,
  RefreshCw, ChevronUp, ChevronDown, Users, Briefcase,
  Clock, AlertCircle, TrendingUp, Filter, Columns,
  CheckSquare, Square, UserCheck,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import './EmployeesData.css';

// Mirrors the backend HR_ROLES guard on employee writes — everyone else gets a
// "not allowed to edit" notice instead of edit controls that would 403.
const EMPLOYEE_EDITOR_ROLES = new Set([
  'super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin',
]);

// ── Status config ─────────────────────────────────────────────────────────────
const STATUS_CFG = {
  Active:    { bg: '#dcfce7', color: '#166534', dot: '#22c55e' },
  Probation: { bg: '#fef3c7', color: '#92400e', dot: '#f59e0b' },
  Notice:    { bg: '#fee2e2', color: '#991b1b', dot: '#ef4444' },
  Inactive:  { bg: '#f3f4f6', color: '#374151', dot: '#9ca3af' },
  Left:      { bg: '#f3f4f6', color: '#6b7280', dot: '#9ca3af' },
};
function statusCfg(s) { return STATUS_CFG[s] || STATUS_CFG.Active; }

// statuses that require a confirmation step before applying
const DESTRUCTIVE_STATUSES = new Set(['Notice', 'Inactive', 'Left']);

// ── Avatar colors (hash-based) ────────────────────────────────────────────────
const AVATAR_PALETTES = [
  { bg:'#ede9fe', color:'#6d28d9' }, { bg:'#dbeafe', color:'#1d4ed8' },
  { bg:'#dcfce7', color:'#166534' }, { bg:'#fff7ed', color:'#c2410c' },
  { bg:'#fdf4ff', color:'#9333ea' }, { bg:'#f0fdfa', color:'#0f766e' },
  { bg:'#fef9c3', color:'#a16207' }, { bg:'#fce7f3', color:'#9d174d' },
];
function avatarPalette(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_PALETTES[h % AVATAR_PALETTES.length];
}

// ── Computed field helpers ────────────────────────────────────────────────────
function calcAge(dob) {
  if (!dob) return '—';
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
  if (!d) return '—';
  return new Date(d.split('T')[0] + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ── Column definitions ────────────────────────────────────────────────────────
const COL_GROUPS = ['Job', 'Personal', 'Computed', 'Compliance'];

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
function exportCSV(rows, visibleCols) {
  const togglable = COLUMN_DEFS.filter(c => !c.always && visibleCols.has(c.key));
  const headers   = ['S.No', 'Employee ID', 'Name', ...togglable.map(c => c.label)];
  const body = rows.map((emp, i) => {
    const base = [i+1, emp.office_id||'—', `${emp.first_name||''} ${emp.last_name||''}`.trim()];
    const extra = togglable.map(c => {
      if (c.key === '_status')     return emp.status || 'Active';
      if (c.key === '_age')        return calcAge(emp.dob);
      if (c.key === '_experience') return calcExperience(emp);
      if (c.key === 'joining_date') return fmtDate(emp.joining_date);
      if (c.key === 'dob')         return fmtDate(emp.dob);
      return emp[c.key] || '—';
    });
    return [...base, ...extra];
  });
  const csv = [headers, ...body].map(r =>
    r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')
  ).join('\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv],{type:'text/csv'})),
    download: 'employees.csv',
  });
  a.click();
}

const PAGE_SIZE = 20;

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

// ── Terminate modal (soft-delete with exit info) ──────────────────────────────
function TerminateModal({ emp, onConfirm, onClose, open }) {
  const today = new Date().toISOString().split('T')[0];
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
            Moving <strong>{emp.first_name} {emp.last_name}</strong> to Ex-Employees.
            Their record is retained for compliance.
          </p>
          <div className="ed-modal-field">
            <label className="ed-modal-label">Last Working Day *</label>
            <input
              type="date"
              className="ed-modal-input"
              value={exitDate}
              max={today}
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
            {submitting ? 'Saving…' : 'Confirm Termination'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Bulk assign department modal ──────────────────────────────────────────────
function BulkAssignModal({ count, departments, onConfirm, onClose }) {
  const [dept,       setDept]       = useState('');
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
        </div>
        <div className="ed-modal-footer">
          <button className="ed-modal-cancel" onClick={onClose}>Cancel</button>
          <button
            className="ed-modal-confirm-primary"
            onClick={submit}
            disabled={submitting || !dept}
          >
            {submitting ? 'Saving…' : `Assign to ${dept || '…'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Status change confirmation modal ─────────────────────────────────────────
function StatusConfirmModal({ emp, newStatus, onConfirm, onClose }) {
  const sc = statusCfg(newStatus);
  const label = {
    Notice:   'On Notice',
    Inactive: 'Inactive',
    Left:     'Terminated',
  }[newStatus] || newStatus;

  return (
    <div className="ed-modal-overlay" onClick={onClose}>
      <div className="ed-modal" onClick={e => e.stopPropagation()}>
        <div className="ed-modal-hd">
          <span className="ed-modal-title">Confirm Status Change</span>
          <button className="ed-col-close" onClick={onClose}><X size={13}/></button>
        </div>
        <div className="ed-modal-body">
          <p className="ed-modal-sub">
            Change <strong>{emp.first_name} {emp.last_name}</strong>&apos;s status to{' '}
            <span style={{ color: sc.color, fontWeight: 600 }}>{label}</span>?
            {newStatus === 'Inactive' && ' This will hide them from active workforce counts.'}
            {newStatus === 'Notice'   && ' They will move to the "On Notice" category.'}
          </p>
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
function BulkStatusModal({ count, onConfirm, onClose }) {
  const [newStatus, setNewStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
          <p className="ed-modal-sub">
            Apply a new status to <strong>{count} employee{count !== 1 ? 's' : ''}</strong>.
          </p>
          <div className="ed-modal-field">
            <label className="ed-modal-label">New Status</label>
            <select className="ed-modal-input" value={newStatus} onChange={e => setNewStatus(e.target.value)}>
              <option value="">Select status…</option>
              <option value="Active">Active</option>
              <option value="Probation">Probation</option>
              <option value="Notice">On Notice</option>
              <option value="Inactive">Inactive</option>
            </select>
          </div>
        </div>
        <div className="ed-modal-footer">
          <button className="ed-modal-cancel" onClick={onClose}>Cancel</button>
          <button
            className="ed-modal-confirm-primary"
            onClick={submit}
            disabled={submitting || !newStatus}
          >
            {submitting ? 'Saving…' : 'Apply Status'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function EmployeesData({ setPage, setSelectedEmployee }) {
  const { readOnly } = usePageAccess();
  const { role: userRole } = useAuth();
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
  const [dept,            setDept]            = useState('All');
  const [status,          setStatus]          = useState(() => {
    const pre = sessionStorage.getItem('employeeStatusFilter');
    if (pre) { sessionStorage.removeItem('employeeStatusFilter'); return pre; }
    return 'All';
  });
  const [role,            setRole]            = useState('All');
  const [sortKey,         setSortKey]         = useState('');
  const [sortDir,         setSortDir]         = useState('asc');
  const [page,            setCurrentPage]     = useState(1);
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

  // Refresh list when browser tab regains visibility (catches stale data after editing)
  useEffect(() => {
    const handler = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [load]);

  // Clear selection when filters change to avoid acting on invisible rows
  useEffect(() => {
    setSelectedIds(new Set());
  }, [search, dept, status, role]);

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

  const EX_SET    = new Set(['left','terminated','resigned','ex-employee','notice_period','notice period']);
  const allStaff  = employees.filter(e => !EX_SET.has((e.status || '').toLowerCase()));
  const active    = allStaff.filter(e => (e.status||'Active') === 'Active');
  const probation = allStaff.filter(e => e.status === 'Probation');
  const notice    = allStaff.filter(e => e.status === 'Notice');
  const inactive  = allStaff.filter(e => e.status === 'Inactive');

  const filtered = allStaff
    .filter(e => {
      const q = search.toLowerCase();
      if (q && !(`${e.first_name} ${e.last_name}`.toLowerCase().includes(q) ||
        (e.company_email||'').toLowerCase().includes(q) ||
        (e.office_id||'').toLowerCase().includes(q) ||
        (e.department||'').toLowerCase().includes(q) ||
        (e.designation||'').toLowerCase().includes(q))) return false;
      if (dept   !== 'All' && e.department !== dept) return false;
      if (status !== 'All' && (e.status||'Active') !== status) return false;
      if (role   !== 'All' && e.designation !== role) return false;
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

  const totalPages     = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows       = filtered.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);
  const allPageSelected = pageRows.length > 0 && pageRows.every(e => selectedIds.has(e.id));

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

  async function handleBulkStatus(newStatus) {
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map(id => api.patch(`/employees/${id}/status`, { status: newStatus })));
      if (!isMounted.current) return;
      setEmployees(prev => prev.map(e => selectedIds.has(e.id) ? { ...e, status: newStatus } : e));
      setSelectedIds(new Set());
      setBulkStatusOpen(false);
      showToast(`Status updated for ${ids.length} employee${ids.length !== 1 ? 's' : ''}`);
    } catch {
      if (!isMounted.current) return;
      showToast('Failed to update status', 'error');
    }
  }

  async function handleTerminate(exitDate, exitReason) {
    const emp = terminateTarget;
    try {
      await api.put(`/employees/${emp.id}`, {
        status: 'Left',
        exit_date: exitDate,
        exit_reason: exitReason || null,
      });
      if (!isMounted.current) return;
      setEmployees(prev => prev.map(e => e.id===emp.id
        ? { ...e, status: 'Left', exit_date: exitDate, exit_reason: exitReason }
        : e
      ));
      setTerminateTarget(null);
      showToast(`${emp.first_name} moved to Ex-Employees`);
      setTimeout(() => setPage('ExEmployees'), 1200);
    } catch {
      if (!isMounted.current) return;
      showToast('Failed to terminate employee', 'error');
    }
  }

  async function handleBulkAssign(newDept) {
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map(id => api.put(`/employees/${id}`, { department: newDept })));
      if (!isMounted.current) return;
      setEmployees(prev => prev.map(e => selectedIds.has(e.id) ? { ...e, department: newDept } : e));
      setSelectedIds(new Set());
      setBulkAssignOpen(false);
      showToast(`Department updated for ${ids.length} employee${ids.length !== 1 ? 's' : ''}`);
    } catch {
      if (!isMounted.current) return;
      showToast('Failed to update department', 'error');
    }
  }

  const hasFilters    = search || dept!=='All' || status!=='All' || role!=='All';
  const customColCount = COLUMN_DEFS.filter(c => !c.always && !c.defaultOn && visibleCols.has(c.key)).length;

  const KPI_CARDS = [
    { label:'Active',     value:active.length,    icon:TrendingUp, palette:{ bg:'#f0fdf4', color:'#166534', icon:'#22c55e' }, filter:'Active'    },
    { label:'Probation',  value:probation.length, icon:Clock,      palette:{ bg:'#fffbeb', color:'#92400e', icon:'#f59e0b' }, filter:'Probation' },
    { label:'On Notice',  value:notice.length,    icon:AlertCircle,palette:{ bg:'#fef2f2', color:'#991b1b', icon:'#ef4444' }, filter:'Notice'    },
    { label:'Inactive',   value:inactive.length,  icon:Users,      palette:{ bg:'#f9fafb', color:'#374151', icon:'#9ca3af' }, filter:'Inactive'  },
    { label:'Total Staff',value:allStaff.length,  icon:Briefcase,  palette:{ bg:'#ede9fe', color:'#5b21b6', icon:'#6B3FDB' }, filter:null        },
  ];

  // ── Render one table cell for a column ──────────────────────────────────────
  function renderCell(emp, col, sc) {
    switch (col.key) {
      case '_num':
      case '_employee':
      case '_actions':
        return null;
      case '_status':
        return (
          <div className="ed-status-wrap">
            <span className="ed-status-dot" style={{ background: sc.dot }}/>
            <select
              className="ed-status-select"
              value={emp.status||'Active'}
              style={{ color: sc.color }}
              onChange={e => handleStatusChange(emp, e.target.value)}
            >
              <option value="Active">Active</option>
              <option value="Probation">Probation</option>
              <option value="Notice">On Notice</option>
              <option value="Inactive">Inactive</option>
            </select>
          </div>
        );
      case '_age':
        return <span className="ed-td-chip">{calcAge(emp.dob)}</span>;
      case '_experience':
        return <span className="ed-td-chip ed-td-chip-blue">{calcExperience(emp)}</span>;
      case 'office_id':
        return <span className="ed-emp-id">{emp.office_id||'—'}</span>;
      case 'department':
        return emp.department ? <span className="ed-dept-pill">{emp.department}</span> : '—';
      case 'designation':
        return <span className="ed-td-role">{emp.designation||'—'}</span>;
      case 'joining_date':
        return <span className="ed-td-muted">{fmtDate(emp.joining_date)}</span>;
      case 'dob':
        return <span className="ed-td-muted">{fmtDate(emp.dob)}</span>;
      case 'reporting_manager':
        return emp.reporting_manager
          ? <span className="ed-manager">{emp.reporting_manager}</span>
          : '—';
      case 'blood_group':
        return emp.blood_group
          ? <span className="ed-td-chip ed-td-chip-red">{emp.blood_group}</span>
          : '—';
      case 'gender':
        return emp.gender
          ? <span className="ed-td-chip">{emp.gender}</span>
          : '—';
      case 'employment_type':
        return emp.employment_type
          ? <span className="ed-td-chip">{emp.employment_type}</span>
          : '—';
      case 'skill_type':
        return emp.skill_type || '—';
      case 'pan_number':
        return emp.pan_number
          ? <span className="ed-td-mono">{emp.pan_number}</span>
          : '—';
      case 'aadhaar_number':
        return emp.aadhaar_number
          ? <span className="ed-td-mono">****{String(emp.aadhaar_number).slice(-4)}</span>
          : '—';
      default:
        return emp[col.key] || '—';
    }
  }

  // visible sorted columns (always-cols handled specially)
  const orderedCols = COLUMN_DEFS.filter(c => c.always || visibleCols.has(c.key));

  return (
    <div className="ed-root">

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
          count={selectedIds.size}
          departments={depts}
          onConfirm={handleBulkAssign}
          onClose={() => setBulkAssignOpen(false)}
        />
      )}

      {/* Bulk status change modal */}
      {bulkStatusOpen && (
        <BulkStatusModal
          count={selectedIds.size}
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
      <div className="ed-header">
        <div className="ed-header-l">
          <div className="ed-header-icon"><Users size={20}/></div>
          <div>
            <h1 className="ed-title">All Employees</h1>
            <p className="ed-sub">
              {filtered.length} of {allStaff.length} employees
              {hasFilters ? ' — filtered' : ''}
            </p>
          </div>
        </div>
        <div className="ed-header-actions">
          <button className="ed-icon-btn" onClick={load} title="Refresh"><RefreshCw size={14}/></button>
          <button className="ed-export-btn" onClick={() => exportCSV(filtered, visibleCols)}>
            <Download size={13}/> Export
          </button>
          {!readOnly && (
            <button className="ed-add-btn" onClick={() => { if (blockEdit()) return; setSelectedEmployee(null); setPage('AddEmployee'); }}>
              <Plus size={14}/> Add Employee
            </button>
          )}
        </div>
      </div>

      {/* ── KPI Cards ──────────────────────────────────────────────────────── */}
      <div className="ed-kpi-row">
        {KPI_CARDS.map(c => {
          const Icon = c.icon;
          const isActive = c.filter && status === c.filter;
          return (
            <div
              key={c.label}
              className={`ed-kpi-card${c.filter ? ' ed-kpi-card-clickable' : ''}${isActive ? ' ed-kpi-card-active' : ''}`}
              onClick={c.filter ? () => { setStatus(s => s === c.filter ? 'All' : c.filter); setCurrentPage(1); } : undefined}
              title={c.filter ? `Filter by ${c.label}` : undefined}
            >
              <div className="ed-kpi-icon" style={{ background:c.palette.bg, color:c.palette.icon }}>
                <Icon size={18}/>
              </div>
              <div className="ed-kpi-body">
                <span className="ed-kpi-val" style={{ color:c.palette.color }}>{c.value}</span>
                <span className="ed-kpi-label">{c.label}</span>
              </div>
            </div>
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
            placeholder="Search name, ID, dept, role…"
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
              <option value="Inactive">Inactive</option>
            </select>
          </div>
          <div className="ed-select-wrap">
            <select className="ed-select" value={role} onChange={e => { setRole(e.target.value); setCurrentPage(1); }}>
              {roles.map(r => <option key={r} value={r}>{r==='All'?'All Roles':r}</option>)}
            </select>
          </div>
          {hasFilters && (
            <button className="ed-clear-btn" onClick={() => { setSearch(''); setDept('All'); setStatus('All'); setRole('All'); setCurrentPage(1); }}>
              <X size={11}/> Clear
            </button>
          )}
        </div>

        {/* Column chooser button */}
        <div className="ed-col-btn-wrap" style={{ position:'relative', marginLeft:'auto' }}>
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
              onClick={() => exportCSV(filtered.filter(e => selectedIds.has(e.id)), visibleCols)}
            >
              <Download size={12}/> Export Selected
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
              <span className="ed-table-count">
                Showing <strong>{pageRows.length}</strong> of <strong>{filtered.length}</strong> employees
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
                    return (
                      <tr key={emp.id} className={`ed-tr${isSelected ? ' ed-tr-selected' : ''}`}>
                        <td className="ed-td ed-td-num">
                          <div className="ed-check-num">
                            <input
                              type="checkbox"
                              className="ed-row-check"
                              checked={isSelected}
                              onChange={() => toggleSelectOne(emp.id)}
                            />
                            <span className="ed-num-label">{(page-1)*PAGE_SIZE+i+1}</span>
                          </div>
                        </td>
                        <td className="ed-td">
                          <div className="ed-name-cell">
                            {emp.photo_url
                              ? <img src={emp.photo_url} alt={name} className="ed-avatar ed-avatar-photo" />
                              : <div className="ed-avatar" style={{ background:ap.bg, color:ap.color }}>{initials}</div>
                            }
                            <div>
                              <div className="ed-name">{name||'—'}</div>
                              <div className="ed-email">{emp.company_email||''}</div>
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

        {totalPages > 1 && (
          <div className="ed-pagination">
            <span className="ed-page-info">
              Page <strong>{page}</strong> of <strong>{totalPages}</strong> · {filtered.length} employees
            </span>
            <div className="ed-page-btns">
              {[
                { label:'«', target:1,          disabled:page===1 },
                { label:'‹', target:page-1,     disabled:page===1 },
                { label:'›', target:page+1,     disabled:page===totalPages },
                { label:'»', target:totalPages, disabled:page===totalPages },
              ].map(btn => (
                <button
                  key={btn.label}
                  className={`ed-page-btn${btn.disabled?' ed-page-btn-disabled':''}`}
                  onClick={() => !btn.disabled && setCurrentPage(btn.target)}
                  disabled={btn.disabled}
                >{btn.label}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
