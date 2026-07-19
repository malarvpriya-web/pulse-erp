// PATH: frontend/src/features/employees/pages/ExEmployees.jsx
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, X, Download, Eye, RefreshCw, UserCheck, ChevronUp, ChevronDown, Calendar, Edit2 } from 'lucide-react';
import api from '@/services/api/client';

const P      = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const PAGE_SIZE = 20;

const EXIT_REASON_MAP = {
  resignation:  { label: 'Resignation',  bg: '#fef3c7', color: '#b45309' },
  termination:  { label: 'Termination',  bg: '#fee2e2', color: '#b91c1c' },
  retirement:   { label: 'Retirement',   bg: '#dbeafe', color: '#1d4ed8' },
  contract_end: { label: 'Contract End', bg: '#f3f4f6', color: '#374151' },
  attrition:    { label: 'Attrition',    bg: '#fce7f3', color: '#9d174d' },
};

const SEPARATION_OPTIONS = [
  { value: 'resignation',  label: 'Resignation' },
  { value: 'termination',  label: 'Termination' },
  { value: 'retirement',   label: 'Retirement' },
  { value: 'contract_end', label: 'Contract End' },
  { value: 'attrition',    label: 'Attrition' },
];

function normaliseType(raw) {
  return (raw || '').toLowerCase().replace(/[\s-]+/g, '_');
}

function exitReasonDisplay(emp) {
  const key = normaliseType(emp.separation_type);
  if (EXIT_REASON_MAP[key]) return EXIT_REASON_MAP[key];
  const fallback = emp.effective_exit_reason || emp.exit_reason || '';
  return { label: fallback || 'Not specified', bg: '#f3f4f6', color: '#6b7280' };
}

function interviewBadge(emp) {
  if (emp.interview_done || emp.clearance_interview_done)
    return { label: 'Done',    bg: '#dcfce7', color: '#166534' };
  return { label: 'Pending', bg: '#fef9c3', color: '#92400e' };
}

function fnfBadge(fnf_status) {
  if (fnf_status === 'paid')     return { label: 'Cleared',  bg: '#dcfce7', color: '#166534' };
  if (fnf_status === 'approved') return { label: 'Approved', bg: '#dbeafe', color: '#1d4ed8' };
  if (fnf_status === 'draft')    return { label: 'Draft',    bg: '#fef3c7', color: '#b45309' };
  return { label: 'Pending', bg: '#fef9c3', color: '#92400e' };
}

function canRehire(emp) {
  return normaliseType(emp.separation_type) !== 'termination';
}

function calcTenure(joining_date, exit_date) {
  if (!joining_date) return null;
  const from = new Date(joining_date);
  const to   = exit_date ? new Date(exit_date) : new Date();
  const months = Math.max(0, Math.round((to - from) / (1000 * 60 * 60 * 24 * 30.44)));
  if (months < 12) return `${months}m`;
  const yrs = Math.floor(months / 12);
  const rem = months % 12;
  return rem ? `${yrs}y ${rem}m` : `${yrs}y`;
}

function exportCSV(rows) {
  const headers = ['S.No','Name','Department','Role','Exit Date','Exit Reason','Interview','F&F Status','Tenure','Rehire Eligible','Email'];
  const body = rows.map((emp, i) => {
    const er      = exitReasonDisplay(emp);
    const iv      = interviewBadge(emp);
    const fnf     = fnfBadge(emp.fnf_status);
    const exitDate = emp.effective_exit_date || emp.exit_date;
    const tenure  = calcTenure(emp.joining_date, exitDate) || '-';
    return [
      i + 1,
      `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
      emp.department || '-',
      emp.designation || '-',
      exitDate ? new Date(exitDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '-',
      er.label,
      iv.label,
      fnf.label,
      tenure,
      canRehire(emp) ? 'Yes' : 'No',
      emp.company_email || '-',
    ];
  });
  const csv = [headers, ...body]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: 'ex-employees.csv',
  });
  a.click();
}

function Badge({ label, bg, color }) {
  return (
    <span style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: bg, color }}>
      {label}
    </span>
  );
}

// ── Edit Exit Details Modal ───────────────────────────────────────────────────
function EditExitModal({ emp, onClose, onSaved }) {
  const exitDate = emp.effective_exit_date || emp.exit_date;
  const [form, setForm] = useState({
    exit_date:       exitDate ? exitDate.slice(0, 10) : '',
    exit_reason:     emp.effective_exit_reason || emp.exit_reason || '',
    separation_type: normaliseType(emp.separation_type) || '',
    last_working_date: exitDate ? exitDate.slice(0, 10) : '',
  });
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState('');

  async function save() {
    setSaving(true); setErr('');
    try {
      await api.patch(`/employees/ex/${emp.id}/exit-details`, form);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  }

  const inp = { padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 420, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>Edit Exit Details</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: '#6b7280' }}>×</button>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
          {emp.first_name} {emp.last_name} · {emp.office_id}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Separation Type</label>
            <select value={form.separation_type} onChange={e => setForm(f => ({ ...f, separation_type: e.target.value }))} style={inp}>
              <option value="">— Not specified —</option>
              {SEPARATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Last Working Date</label>
            <input type="date" value={form.last_working_date}
              onChange={e => setForm(f => ({ ...f, last_working_date: e.target.value, exit_date: e.target.value }))}
              style={inp} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Exit Reason / Details</label>
            <textarea rows={3} value={form.exit_reason}
              onChange={e => setForm(f => ({ ...f, exit_reason: e.target.value }))}
              placeholder="Reason for leaving…"
              style={{ ...inp, resize: 'vertical' }} />
          </div>
        </div>

        {err && <p style={{ margin: '12px 0 0', color: '#b91c1c', fontSize: 12 }}>{err}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', border: `1px solid ${BORDER}`, borderRadius: 7, background: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '8px 16px', border: 'none', borderRadius: 7, background: P, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer', opacity: saving ? .7 : 1 }}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Rehire Modal ──────────────────────────────────────────────────────────────
function RehireModal({ emp, onClose, onRehired }) {
  const today = new Date().toISOString().slice(0, 10);
  const [joiningDate, setJoiningDate] = useState(today);
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState('');

  async function confirm() {
    setSaving(true); setErr('');
    try {
      await api.post(`/employees/ex/${emp.id}/rehire`, { new_joining_date: joiningDate });
      onRehired();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.error || 'Rehire failed');
    } finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 380, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>Rehire Employee</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: '#6b7280' }}>×</button>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
          Reactivating <strong>{emp.first_name} {emp.last_name}</strong>. Their exit records will be cleared and status set to Active.
        </p>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>New Joining Date</label>
          <input type="date" value={joiningDate} onChange={e => setJoiningDate(e.target.value)}
            style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box' }} />
        </div>
        {err && <p style={{ margin: '10px 0 0', color: '#b91c1c', fontSize: 12 }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', border: `1px solid ${BORDER}`, borderRadius: 7, background: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={confirm} disabled={saving} style={{ padding: '8px 16px', border: 'none', borderRadius: 7, background: '#166534', color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer', opacity: saving ? .7 : 1 }}>
            {saving ? 'Processing…' : 'Confirm Rehire'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ExEmployees({ setPage, setSelectedEmployee }) {
  const [employees,    setEmployees]    = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [search,       setSearch]       = useState('');
  const [dept,         setDept]         = useState('All');
  const [reasonFilter, setReasonFilter] = useState('All');
  const [dateFrom,     setDateFrom]     = useState('');
  const [dateTo,       setDateTo]       = useState('');
  const [sortKey,      setSortKey]      = useState('');
  const [sortDir,      setSortDir]      = useState('asc');
  const [page,         setCurrentPage]  = useState(1);
  const [toast,        setToast]        = useState(null);
  const [editEmp,      setEditEmp]      = useState(null);
  const [rehireEmp,    setRehireEmp]    = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('exit_date_from', dateFrom);
      if (dateTo)   params.set('exit_date_to', dateTo);
      const res = await api.get(`/employees/ex?${params}`);
      setEmployees(res.data || []);
    } catch {
      showToast('Failed to load ex-employee data', 'error');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const depts = useMemo(
    () => ['All', ...new Set(employees.map(e => e.department).filter(Boolean))],
    [employees],
  );

  const filtered = useMemo(() => employees
    .filter(e => {
      const q = search.toLowerCase();
      if (q && !(
        `${e.first_name} ${e.last_name}`.toLowerCase().includes(q) ||
        (e.company_email || '').toLowerCase().includes(q) ||
        (e.office_id || '').toLowerCase().includes(q)
      )) return false;
      if (dept !== 'All' && e.department !== dept) return false;
      if (reasonFilter !== 'All' && normaliseType(e.separation_type) !== reasonFilter) return false;
      return true;
    })
    .sort((a, b) => {
      if (!sortKey) return 0;
      const va = (a[sortKey] || '').toString().toLowerCase();
      const vb = (b[sortKey] || '').toString().toLowerCase();
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    }),
    [employees, search, dept, reasonFilter, sortKey, sortDir],
  );

  const summary = useMemo(() => {
    const total    = employees.length;
    const thisYear = employees.filter(e => {
      const d = e.effective_exit_date || e.exit_date;
      return d && new Date(d).getFullYear() === new Date().getFullYear();
    }).length;
    const byReason = {};
    employees.forEach(e => {
      const key = normaliseType(e.separation_type) || 'unspecified';
      byReason[key] = (byReason[key] || 0) + 1;
    });
    const topReasons = Object.entries(byReason)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key, count]) => ({
        key, count,
        // 'unspecified' and any unknown key get a human-readable label
        label: EXIT_REASON_MAP[key]?.label
          || (key === 'unspecified' ? 'Reason Unspecified' : key.replace(/_/g, ' ')),
        pct:   total > 0 ? Math.round((count / total) * 100) : 0,
        ...(EXIT_REASON_MAP[key] || { bg: '#f3f4f6', color: '#6b7280' }),
      }));
    return { total, thisYear, topReasons };
  }, [employees]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows   = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }

  function SortIcon({ colKey }) {
    if (sortKey !== colKey) return <ChevronDown size={11} style={{ opacity: 0.25 }} />;
    return sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />;
  }

  const thStyle = (key) => ({
    padding: '10px 12px', fontSize: 12, fontWeight: 600,
    color: sortKey === key ? P : '#6b7280',
    cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
    background: LIGHT, textAlign: 'left',
  });

  const hasFilters = search || dept !== 'All' || reasonFilter !== 'All' || dateFrom || dateTo;

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

      {/* Modals */}
      {editEmp   && <EditExitModal emp={editEmp}   onClose={() => setEditEmp(null)}   onSaved={() => { load(); showToast('Exit details updated'); }} />}
      {rehireEmp && <RehireModal   emp={rehireEmp} onClose={() => setRehireEmp(null)} onRehired={() => { load(); showToast(`${rehireEmp.first_name} rehired successfully`); }} />}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 16, right: 16, zIndex: 1000,
          background: toast.type === 'error' ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${toast.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
          color: toast.type === 'error' ? '#991b1b' : '#166534',
          borderRadius: 8, padding: '10px 16px', fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>Ex-Employees</h1>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            {filtered.length} alumni record{filtered.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={{
            padding: '7px 10px', background: '#fff', border: `1px solid ${BORDER}`,
            borderRadius: 8, cursor: 'pointer', color: '#6b7280',
          }}>
            <RefreshCw size={14} />
          </button>
          <button onClick={() => exportCSV(filtered)} style={{
            padding: '7px 12px', background: '#fff', color: P, border: `1px solid ${BORDER}`,
            borderRadius: 8, cursor: 'pointer', fontSize: 12,
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            <Download size={13} /> Export CSV
          </button>
        </div>
      </div>

      {/* KPI summary chips */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 18px' }}>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>Total Ex-Employees</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#ef4444' }}>{summary.total}</div>
        </div>
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 18px' }}>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>This Year</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#f59e0b' }}>{summary.thisYear}</div>
        </div>
        {summary.topReasons.map(r => (
          <div key={r.key} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 18px' }}>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: r.color }}>
              {r.count}
              <span style={{ fontSize: 12, fontWeight: 500, color: '#9ca3af', marginLeft: 4 }}>({r.pct}%)</span>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{
        background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
        padding: '12px 16px', marginBottom: 16,
        display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
      }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setCurrentPage(1); }}
            placeholder="Search name, ID, email…"
            style={{
              width: '100%', paddingLeft: 30, paddingRight: search ? 28 : 10,
              paddingTop: 7, paddingBottom: 7,
              border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13,
              outline: 'none', boxSizing: 'border-box',
            }}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{
              position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
              border: 'none', background: 'transparent', cursor: 'pointer', color: '#9ca3af', padding: 0,
            }}><X size={13} /></button>
          )}
        </div>

        <select value={dept} onChange={e => { setDept(e.target.value); setCurrentPage(1); }}
          style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
          {depts.map(d => <option key={d} value={d}>{d === 'All' ? 'All Departments' : d}</option>)}
        </select>

        <select value={reasonFilter} onChange={e => { setReasonFilter(e.target.value); setCurrentPage(1); }}
          style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
          <option value="All">All Exit Reasons</option>
          <option value="unspecified">Reason Unspecified</option>
          {SEPARATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Calendar size={13} style={{ color: '#9ca3af', flexShrink: 0 }} />
          <input type="date" value={dateFrom}
            onChange={e => { setDateFrom(e.target.value); setCurrentPage(1); }}
            style={{ padding: '6px 8px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, color: '#374151' }}
          />
        </div>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>to</span>
        <input type="date" value={dateTo}
          onChange={e => { setDateTo(e.target.value); setCurrentPage(1); }}
          style={{ padding: '6px 8px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, color: '#374151' }}
        />

        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setDept('All'); setReasonFilter('All'); setDateFrom(''); setDateTo(''); setCurrentPage(1); }}
            style={{ padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>Loading ex-employee records…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#374151' }}>No ex-employee records found</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${BORDER}` }}>
                  <th style={{ ...thStyle(), width: 40, cursor: 'default' }}>#</th>
                  <th style={thStyle('first_name')} onClick={() => toggleSort('first_name')}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>Name <SortIcon colKey="first_name" /></span>
                  </th>
                  <th style={thStyle('department')} onClick={() => toggleSort('department')}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>Department <SortIcon colKey="department" /></span>
                  </th>
                  <th style={{ ...thStyle(), cursor: 'default' }}>Role</th>
                  <th style={thStyle('effective_exit_date')} onClick={() => toggleSort('effective_exit_date')}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>Exit Date <SortIcon colKey="effective_exit_date" /></span>
                  </th>
                  <th style={{ ...thStyle(), cursor: 'default' }}>Tenure</th>
                  <th style={{ ...thStyle(), cursor: 'default' }}>Exit Reason</th>
                  <th style={{ ...thStyle(), cursor: 'default' }}>Interview</th>
                  <th style={{ ...thStyle(), cursor: 'default' }}>F&amp;F</th>
                  <th style={{ ...thStyle(), cursor: 'default', textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((emp, i) => {
                  const er       = exitReasonDisplay(emp);
                  const iv       = interviewBadge(emp);
                  const fnf      = fnfBadge(emp.fnf_status);
                  const eligible = canRehire(emp);
                  const exitDate = emp.effective_exit_date || emp.exit_date;
                  const tenure   = calcTenure(emp.joining_date, exitDate);

                  return (
                    <tr key={emp.id}
                      style={{ borderBottom: `1px solid ${BORDER}`, transition: 'background 0.12s' }}
                      onMouseEnter={e => (e.currentTarget.style.background = LIGHT)}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <td style={{ padding: '10px 12px', color: '#9ca3af' }}>{(page - 1) * PAGE_SIZE + i + 1}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{
                            width: 30, height: 30, borderRadius: '50%',
                            background: '#fee2e2', color: '#dc2626',
                            fontWeight: 700, fontSize: 12, flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            {(emp.first_name || '?').charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, color: '#374151', display: 'flex', alignItems: 'center', gap: 5 }}>
                              {emp.first_name} {emp.last_name}
                              {!eligible && (
                                <span style={{ fontSize: 9, padding: '1px 5px', background: '#fef2f2', color: '#991b1b', borderRadius: 4, fontWeight: 700 }}>
                                  NO REHIRE
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{emp.office_id} · {emp.company_email}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '10px 12px', color: '#374151' }}>{emp.department || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#374151' }}>{emp.designation || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#6b7280' }}>
                        {exitDate ? new Date(exitDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>
                        {tenure || '—'}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <Badge label={er.label} bg={er.bg} color={er.color} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <Badge label={iv.label} bg={iv.bg} color={iv.color} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <Badge label={fnf.label} bg={fnf.bg} color={fnf.color} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', gap: 5, justifyContent: 'center', flexWrap: 'wrap' }}>
                          <button onClick={() => { setSelectedEmployee(emp); setPage('EmployeeProfile'); }}
                            style={{ padding: '5px 9px', border: `1px solid ${BORDER}`, borderRadius: 6, background: '#fff', color: P, cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
                            <Eye size={11} /> View
                          </button>
                          <button onClick={() => setEditEmp(emp)}
                            style={{ padding: '5px 9px', border: `1px solid ${BORDER}`, borderRadius: 6, background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
                            <Edit2 size={11} /> Edit
                          </button>
                          {eligible && (
                            <button onClick={() => setRehireEmp(emp)}
                              style={{ padding: '5px 9px', border: '1px solid #bbf7d0', borderRadius: 6, background: '#f0fdf4', color: '#166534', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
                              <UserCheck size={11} /> Rehire
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
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>Page {page} of {totalPages}</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              { label: '«', target: 1,         disabled: page === 1 },
              { label: '‹', target: page - 1,  disabled: page === 1 },
              { label: '›', target: page + 1,  disabled: page === totalPages },
              { label: '»', target: totalPages, disabled: page === totalPages },
            ].map(btn => (
              <button key={btn.label} onClick={() => !btn.disabled && setCurrentPage(btn.target)}
                disabled={btn.disabled}
                style={{ padding: '5px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, background: '#fff', cursor: btn.disabled ? 'default' : 'pointer', color: btn.disabled ? '#d1d5db' : P, fontSize: 13 }}>
                {btn.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
