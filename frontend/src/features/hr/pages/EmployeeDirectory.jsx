import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Search, X, Users, Mail, Phone, Building2,
  LayoutGrid, List, Download, ChevronDown,
  Cake, Star, BriefcaseMedical, MapPin,
} from 'lucide-react';
import api from '@/services/api/client';
import { usePagination } from '@/features/_shared/usePagination';
import Pagination from '@/features/_shared/Pagination';

// ── Constants ─────────────────────────────────────────────────────────────────

const EX_STATUSES = new Set([
  'left', 'terminated', 'resigned', 'inactive',
  'ex-employee', 'notice_period', 'notice period',
]);

const STATUS_CFG = {
  active:    { bg: '#dcfce7', color: '#15803d', chipBg: '#dcfce7', chipBorder: '#bbf7d0', label: 'Active'    },
  probation: { bg: '#fef3c7', color: '#92400e', chipBg: '#fef3c7', chipBorder: '#fde68a', label: 'Probation' },
  notice:    { bg: '#fee2e2', color: '#991b1b', chipBg: '#fee2e2', chipBorder: '#fecaca', label: 'On Notice' },
};
function statusCfg(s) {
  return STATUS_CFG[(s || 'active').toLowerCase()] || { bg: '#f3f4f6', color: '#6b7280', label: s || 'Active' };
}

const AVATAR_PALETTES = [
  { bg: '#ede9fe', color: '#6d28d9' }, { bg: '#dbeafe', color: '#1d4ed8' },
  { bg: '#dcfce7', color: '#166534' }, { bg: '#fff7ed', color: '#c2410c' },
  { bg: '#fdf4ff', color: '#9333ea' }, { bg: '#f0fdfa', color: '#0f766e' },
  { bg: '#fef9c3', color: '#a16207' }, { bg: '#fce7f3', color: '#9d174d' },
];
function avatarPalette(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_PALETTES[h % AVATAR_PALETTES.length];
}

// Returns true when a MM-DD string falls within the next `days` days (inclusive today)
function isWithinDays(mdStr, days = 7) {
  if (!mdStr || mdStr === 'null') return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [mm, dd] = mdStr.split('-').map(Number);
  if (!mm || !dd) return false;
  let target = new Date(today.getFullYear(), mm - 1, dd);
  if (target < today) target = new Date(today.getFullYear() + 1, mm - 1, dd);
  const diff = (target - today) / 86400000;
  return diff >= 0 && diff < days;
}

function anniversaryYears(joiningDate) {
  if (!joiningDate) return 0;
  return new Date().getFullYear() - new Date(joiningDate).getFullYear();
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d.split('T')[0] + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ── CSV export ────────────────────────────────────────────────────────────────
function exportCSV(employees) {
  const headers = ['Name', 'Designation', 'Department', 'Email', 'Phone', 'Status', 'Location', 'Joined'];
  const rows = employees.map(e => [
    e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim(),
    e.designation || '',
    e.department || '',
    e.company_email || e.email || '',
    e.phone || '',
    e.status || 'Active',
    e.location || '',
    fmtDate(e.joining_date),
  ]);
  const csv = [headers, ...rows]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  Object.assign(document.createElement('a'), { href: url, download: 'employee-directory.csv' }).click();
  URL.revokeObjectURL(url);
}

// ── Sort helpers ──────────────────────────────────────────────────────────────
const SORT_OPTIONS = [
  { value: 'name_asc',   label: 'Name A → Z'       },
  { value: 'name_desc',  label: 'Name Z → A'       },
  { value: 'dept',       label: 'By Department'     },
  { value: 'joined_new', label: 'Newest Joined'     },
  { value: 'joined_old', label: 'Longest Serving'   },
];

function applySortKey(arr, key) {
  return [...arr].sort((a, b) => {
    const na = a.name || `${a.first_name || ''} ${a.last_name || ''}`.trim();
    const nb = b.name || `${b.first_name || ''} ${b.last_name || ''}`.trim();
    switch (key) {
      case 'name_desc':  return nb.localeCompare(na);
      case 'dept':       return (a.department || '').localeCompare(b.department || '') || na.localeCompare(nb);
      case 'joined_new': return (new Date(b.joining_date || 0)) - (new Date(a.joining_date || 0));
      case 'joined_old': return (new Date(a.joining_date || 0)) - (new Date(b.joining_date || 0));
      default:           return na.localeCompare(nb); // name_asc
    }
  });
}

// ── Shared Avatar component ───────────────────────────────────────────────────
function Avatar({ name, photoUrl, size = 44 }) {
  const ap       = avatarPalette(name);
  const initials = name.split(' ').map(n => n[0]).filter(Boolean).join('').slice(0, 2).toUpperCase() || '?';
  if (photoUrl) {
    return <img src={photoUrl} alt={name} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: ap.bg, color: ap.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: Math.round(size * 0.34), flexShrink: 0, letterSpacing: '-0.5px' }}>
      {initials}
    </div>
  );
}

// ── Badge chips on cards ──────────────────────────────────────────────────────
function Badges({ emp }) {
  const isBday = isWithinDays(emp.birth_md, 7);
  const yrs    = anniversaryYears(emp.joining_date);
  const isAnni = yrs > 0 && isWithinDays(emp.anniversary_md, 7);
  const isLeave = !!emp.on_leave_today;

  if (!isBday && !isAnni && !isLeave) return null;
  return (
    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '8px' }}>
      {isBday && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: '#fdf4ff', color: '#7e22ce', fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '20px', border: '1px solid #e9d5ff' }}>
          <Cake size={9} /> Birthday soon
        </span>
      )}
      {isAnni && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: '#fffbeb', color: '#b45309', fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '20px', border: '1px solid #fde68a' }}>
          <Star size={9} /> {yrs}yr anniversary
        </span>
      )}
      {isLeave && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: '#f0f9ff', color: '#0369a1', fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '20px', border: '1px solid #bae6fd' }}>
          <BriefcaseMedical size={9} /> On leave today
        </span>
      )}
    </div>
  );
}

// ── Card view ─────────────────────────────────────────────────────────────────
function CardGrid({ employees, onSelect }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: '16px' }}>
      {employees.map(emp => {
        const name  = emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || '?';
        const sc    = statusCfg(emp.status);
        const email = emp.company_email || emp.email || '';

        return (
          <div
            key={emp.id}
            style={{ background: '#fff', borderRadius: '12px', border: '1px solid #e5e7eb', padding: '20px', cursor: 'pointer', transition: 'box-shadow 0.15s, transform 0.15s' }}
            onClick={() => onSelect(emp)}
            onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 6px 20px rgba(0,0,0,0.08)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
            onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}
          >
            {/* Avatar + name */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
              <Avatar name={name} photoUrl={emp.photo_url} size={46} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
                <div style={{ fontSize: '12px', color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {emp.designation || <span style={{ color: '#d1d5db' }}>—</span>}
                </div>
              </div>
            </div>

            {/* Info rows */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '12px' }}>
              {emp.department && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#6b7280' }}>
                  <Building2 size={11} color="#9ca3af" />{emp.department}
                </div>
              )}
              {email && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <Mail size={11} color="#9ca3af" />{email}
                </div>
              )}
              {emp.phone && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#6b7280' }}>
                  <Phone size={11} color="#9ca3af" />{emp.phone}
                </div>
              )}
              {emp.location && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#6b7280' }}>
                  <MapPin size={11} color="#9ca3af" />{emp.location}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', background: '#f3f4f6', color: '#374151', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>
                {emp.department || '—'}
              </span>
              <span style={{ fontSize: '11px', background: sc.bg, color: sc.color, padding: '2px 8px', borderRadius: '20px', fontWeight: 500 }}>
                {sc.label}
              </span>
            </div>

            {/* Event badges */}
            <Badges emp={emp} />
          </div>
        );
      })}
    </div>
  );
}

// ── List (table) view ─────────────────────────────────────────────────────────
function ListTable({ employees, onSelect }) {
  return (
    <div style={{ background: '#fff', borderRadius: '12px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
            {['Employee', 'Department', 'Email', 'Phone', 'Status', 'Joined', ''].map(h => (
              <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {employees.map((emp, idx) => {
            const name  = emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || '?';
            const sc    = statusCfg(emp.status);
            const email = emp.company_email || emp.email || '';
            const isBday = isWithinDays(emp.birth_md, 7);
            const yrs    = anniversaryYears(emp.joining_date);
            const isAnni = yrs > 0 && isWithinDays(emp.anniversary_md, 7);

            return (
              <tr
                key={emp.id}
                style={{ borderBottom: idx < employees.length - 1 ? '1px solid #f3f4f6' : 'none', cursor: 'pointer', transition: 'background 0.1s' }}
                onClick={() => onSelect(emp)}
                onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {/* Employee cell */}
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Avatar name={name} photoUrl={emp.photo_url} size={34} />
                    <div>
                      <div style={{ fontWeight: 600, color: '#111827', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        {name}
                        {isBday  && <Cake size={11} color="#9333ea" title="Birthday this week" />}
                        {isAnni  && <Star size={11} color="#d97706" title={`${yrs}yr anniversary`} />}
                        {emp.on_leave_today && <BriefcaseMedical size={11} color="#0284c7" title="On leave today" />}
                      </div>
                      <div style={{ fontSize: '11px', color: '#9ca3af' }}>{emp.designation || '—'}</div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: '12px 16px', color: '#374151' }}>{emp.department || '—'}</td>
                <td style={{ padding: '12px 16px', color: '#6b7280', fontSize: '12px', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email || '—'}</td>
                <td style={{ padding: '12px 16px', color: '#6b7280', fontSize: '12px' }}>{emp.phone || '—'}</td>
                <td style={{ padding: '12px 16px' }}>
                  <span style={{ background: sc.bg, color: sc.color, padding: '2px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: 500 }}>{sc.label}</span>
                </td>
                <td style={{ padding: '12px 16px', color: '#9ca3af', fontSize: '12px' }}>{fmtDate(emp.joining_date)}</td>
                <td style={{ padding: '12px 16px' }}>
                  <button
                    style={{ fontSize: '11px', color: '#6366f1', background: '#eef2ff', border: 'none', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontWeight: 600 }}
                    onClick={e => { e.stopPropagation(); onSelect(emp); }}
                  >
                    View
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Status chip filter bar ────────────────────────────────────────────────────
function StatusChips({ employees, current, onChange }) {
  const counts = useMemo(() => {
    const map = { all: employees.length, active: 0, probation: 0, notice: 0 };
    employees.forEach(e => {
      const s = (e.status || 'active').toLowerCase();
      if (s === 'active')    map.active++;
      else if (s === 'probation') map.probation++;
      else if (s === 'notice')    map.notice++;
    });
    return map;
  }, [employees]);

  const chips = [
    { key: 'all',       label: 'All',        count: counts.all,       bg: '#f3f4f6', color: '#374151', activeBg: '#1f2937', activeColor: '#fff' },
    { key: 'active',    label: 'Active',     count: counts.active,    bg: '#dcfce7', color: '#15803d', activeBg: '#15803d', activeColor: '#fff' },
    { key: 'probation', label: 'Probation',  count: counts.probation, bg: '#fef3c7', color: '#92400e', activeBg: '#92400e', activeColor: '#fff' },
    { key: 'notice',    label: 'On Notice',  count: counts.notice,    bg: '#fee2e2', color: '#991b1b', activeBg: '#991b1b', activeColor: '#fff' },
  ];

  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '20px' }}>
      {chips.map(c => {
        const active = current === c.key;
        return (
          <button
            key={c.key}
            onClick={() => onChange(c.key)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '5px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
              border: 'none', cursor: 'pointer', transition: 'all 0.15s',
              background: active ? c.activeBg : c.bg,
              color: active ? c.activeColor : c.color,
              boxShadow: active ? '0 2px 6px rgba(0,0,0,0.15)' : 'none',
            }}
          >
            {c.label}
            <span style={{ background: active ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.08)', borderRadius: '10px', padding: '0 6px', fontSize: '11px' }}>
              {c.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function EmployeeDirectory({ setPage }) {
  const [employees, setEmployees] = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [search,    setSearch]    = useState('');
  const [fDept,     setFDept]     = useState('');
  const [fStatus,   setFStatus]   = useState('all');
  const [sortKey,   setSortKey]   = useState('name_asc');
  const [viewMode,  setViewMode]  = useState(() => localStorage.getItem('dir_view') || 'cards');
  const [showSort,  setShowSort]  = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/employees/directory');
      const raw = res.data?.employees || res.data || [];
      setEmployees(Array.isArray(raw) ? raw : []);
    } catch {
      // Fallback: full /employees with client-side ex-employee filter
      try {
        const r2  = await api.get('/employees');
        const raw2 = r2.data?.employees || r2.data || [];
        setEmployees(
          (Array.isArray(raw2) ? raw2 : [])
            .filter(e => !EX_STATUSES.has((e.status || '').toLowerCase()))
        );
      } catch (err2) {
        setEmployees([]);
        setError(err2.message || 'Failed to load employees');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Persist view preference
  function setView(v) { setViewMode(v); localStorage.setItem('dir_view', v); }

  // Build departments from actual data
  const departments = useMemo(
    () => [...new Set(employees.map(e => e.department).filter(Boolean))].sort(),
    [employees]
  );

  // Filter + sort pipeline
  const displayed = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = employees.filter(e => {
      const name  = e.name || `${e.first_name || ''} ${e.last_name || ''}`.trim();
      const email = e.company_email || e.email || '';
      const matchQ = !q ||
        name.toLowerCase().includes(q) ||
        (e.designation || '').toLowerCase().includes(q) ||
        email.toLowerCase().includes(q) ||
        (e.department || '').toLowerCase().includes(q);
      const matchDept   = !fDept   || e.department === fDept;
      const matchStatus = fStatus === 'all' || (e.status || 'active').toLowerCase() === fStatus;
      return matchQ && matchDept && matchStatus;
    });
    return applySortKey(filtered, sortKey);
  }, [employees, search, fDept, fStatus, sortKey]);

  const { page, totalPages, slice, next, prev, goTo, pageSize, total } =
    usePagination(displayed, 20);

  const currentSort = SORT_OPTIONS.find(o => o.value === sortKey) || SORT_OPTIONS[0];

  function handleSelect(emp) {
    sessionStorage.setItem('selectedEmployeeId', emp.id);
    sessionStorage.setItem('selectedEmployee', JSON.stringify(emp));
    if (setPage) setPage('EmployeeProfile');
  }

  const hasFilters = search || fDept || fStatus !== 'all';

  return (
    <div style={{ padding: '24px' }} onClick={() => setShowSort(false)}>

      {/* Error banner */}
      {error && (
        <div style={{ background: '#fee2e2', color: '#dc2626', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '13px' }}>
          {error}
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 700 }}>Employee Directory</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: '13px' }}>
            {displayed.length} of {employees.length} employees
            {departments.length > 0 && ` · ${departments.length} department${departments.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* View toggle */}
          <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: '8px', padding: '3px' }}>
            {[
              { mode: 'cards', Icon: LayoutGrid, title: 'Card view' },
              { mode: 'list',  Icon: List,        title: 'List view' },
            ].map(({ mode, Icon, title }) => (
              <button
                key={mode}
                title={title}
                onClick={() => setView(mode)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '28px', borderRadius: '6px', border: 'none', cursor: 'pointer', background: viewMode === mode ? '#fff' : 'transparent', color: viewMode === mode ? '#374151' : '#9ca3af', boxShadow: viewMode === mode ? '0 1px 3px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.15s' }}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
          {/* Export */}
          <button
            onClick={() => exportCSV(displayed)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: '#374151', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer' }}
          >
            <Download size={13} /> Export CSV
          </button>
        </div>
      </div>

      {/* ── Search + Dept + Sort ────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '8px 12px', flex: '1', minWidth: '200px' }}>
          <Search size={14} color="#9ca3af" />
          <input
            style={{ border: 'none', outline: 'none', fontSize: '13px', width: '100%', background: 'transparent' }}
            placeholder="Search name, role, email, department…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: '#9ca3af' }} onClick={() => setSearch('')}>
              <X size={12} />
            </button>
          )}
        </div>

        {/* Department */}
        <select
          style={{ fontSize: '13px', padding: '8px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', background: '#fff', color: fDept ? '#111827' : '#9ca3af', cursor: 'pointer' }}
          value={fDept}
          onChange={e => setFDept(e.target.value)}
        >
          <option value="">All Departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>

        {/* Sort dropdown */}
        <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
          <button
            onClick={() => setShowSort(v => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '8px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', color: '#374151', whiteSpace: 'nowrap' }}
          >
            {currentSort.label} <ChevronDown size={12} />
          </button>
          {showSort && (
            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.1)', padding: '4px', zIndex: 50, minWidth: '170px' }}>
              {SORT_OPTIONS.map(o => (
                <button
                  key={o.value}
                  onClick={() => { setSortKey(o.value); setShowSort(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: '13px', border: 'none', borderRadius: '6px', cursor: 'pointer', background: sortKey === o.value ? '#eef2ff' : 'transparent', color: sortKey === o.value ? '#4338ca' : '#374151', fontWeight: sortKey === o.value ? 600 : 400 }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Clear all filters */}
        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setFDept(''); setFStatus('all'); }}
            style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: '#ef4444', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', fontWeight: 600 }}
          >
            <X size={11} /> Clear
          </button>
        )}
      </div>

      {/* ── Status chips ───────────────────────────────────────────────────── */}
      <StatusChips employees={employees} current={fStatus} onChange={v => { setFStatus(v); }} />

      {/* ── Content ────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '80px 0', color: '#9ca3af' }}>
          <Users size={36} color="#d1d5db" style={{ marginBottom: '10px' }} />
          <p style={{ margin: 0 }}>Loading directory…</p>
        </div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '80px 0', color: '#9ca3af' }}>
          <Users size={40} color="#d1d5db" style={{ marginBottom: '12px' }} />
          <p style={{ margin: 0, fontWeight: 600, color: '#374151', fontSize: '15px' }}>No employees found</p>
          {hasFilters && (
            <p style={{ margin: '6px 0 16px', fontSize: '13px' }}>Try adjusting your search or filters</p>
          )}
          {hasFilters && (
            <button
              onClick={() => { setSearch(''); setFDept(''); setFStatus('all'); }}
              style={{ background: '#eef2ff', color: '#4338ca', border: 'none', borderRadius: '8px', padding: '8px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
            >
              Clear all filters
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Showing X–Y label */}
          <p style={{ margin: '0 0 14px', fontSize: '12px', color: '#9ca3af' }}>
            Showing <strong style={{ color: '#374151' }}>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}</strong> of <strong style={{ color: '#374151' }}>{total}</strong> employees
          </p>

          {viewMode === 'cards'
            ? <CardGrid employees={slice} onSelect={handleSelect} />
            : <ListTable employees={slice} onSelect={handleSelect} />
          }

          <div style={{ marginTop: '20px' }}>
            <Pagination page={page} totalPages={totalPages} total={total} pageSize={pageSize} onNext={next} onPrev={prev} onGoTo={goTo} />
          </div>
        </>
      )}
    </div>
  );
}
