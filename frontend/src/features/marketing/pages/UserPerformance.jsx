import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Users, ChevronUp, ChevronDown } from 'lucide-react';
import api from '@/services/api/client';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function monthYearOptions() {
  const opts = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    opts.push({ month: d.getMonth() + 1, year: d.getFullYear(), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
  }
  return opts;
}

const COLS = [
  { key: 'name',                label: 'Name',                sortable: true },
  { key: 'designation',         label: 'Designation',         sortable: true },
  { key: 'tasks_completed',     label: 'Tasks Done',           sortable: true, align: 'center' },
  { key: 'tasks_assigned',      label: 'Tasks Assigned',       sortable: true, align: 'center' },
  { key: 'hours_logged',        label: 'Hours Logged',         sortable: true, align: 'center' },
  { key: 'pursuits_converted',  label: 'Pursuits Converted',   sortable: true, align: 'center' },
  { key: '_progress',           label: 'Completion',           sortable: false },
];

export default function UserPerformance() {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState('tasks_completed');
  const [sortDir, setSortDir] = useState('desc');
  const [search, setSearch]   = useState('');
  const monthOpts = monthYearOptions();
  const [selectedMY, setSelectedMY] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const opt = monthOpts[selectedMY];
    try {
      const res = await api.get('/marketing/user-performance', {
        params: { month: opt.month, year: opt.year },
      });
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch { setRows([]); }
    finally { setLoading(false); }
  }, [selectedMY]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const filtered = rows.filter(r =>
    !search || JSON.stringify(r).toLowerCase().includes(search.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortKey] ?? 0;
    const bv = b[sortKey] ?? 0;
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  return (
    <div style={{ padding: 24, background: 'var(--color-background-primary)' }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>User Performance</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Per-member marketing activity for the selected month</p>
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
          style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', width: 180 }} />
        <select value={selectedMY} onChange={e => setSelectedMY(Number(e.target.value))}
          style={{ padding: '7px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
          {monthOpts.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
        </select>
        <button onClick={load} style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, background: 'var(--color-background-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', fontSize: 13 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, overflow: 'hidden' }}>
        {loading ? (
          [1,2,3].map(i => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 16px', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
              {[130, 110, 80, 80, 80, 90, 150].map((w, j) => (
                <div key={j} style={{ height: 14, width: w, background: 'var(--color-background-secondary)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          ))
        ) : sorted.length === 0 ? (
          <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 24px', textAlign: 'center', background: 'var(--color-background-secondary)', borderRadius: 10, border: '0.5px solid var(--color-border-tertiary)' }}>
              <Users size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
              <p style={{ fontWeight: 500, fontSize: 15, color: 'var(--color-text-primary)', margin: '0 0 4px' }}>No performance data</p>
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>Assign tasks or log timesheets to see team performance.</p>
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--color-background-secondary)' }}>
                  {COLS.map(col => (
                    <th key={col.key}
                      onClick={() => col.sortable && handleSort(col.key)}
                      style={{ padding: '10px 14px', textAlign: col.align || 'left', fontWeight: 600, color: sortKey === col.key ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap', cursor: col.sortable ? 'pointer' : 'default', userSelect: 'none' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {col.label}
                        {col.sortable && (sortKey === col.key
                          ? (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                          : <ChevronUp size={12} style={{ opacity: 0.3 }} />)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => {
                  const assigned  = parseInt(r.tasks_assigned  || 0);
                  const completed = parseInt(r.tasks_completed || 0);
                  const pct = assigned > 0 ? Math.round(completed / assigned * 100) : 0;
                  return (
                    <tr key={r.id ?? i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--color-text-primary)' }}>{r.name || '—'}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)' }}>{r.designation || '—'}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'center', fontWeight: 700, color: completed > 0 ? '#16a34a' : 'var(--color-text-secondary)' }}>{completed}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>{assigned}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'center', fontWeight: 600, color: '#6B3FDB' }}>
                        {parseFloat(r.hours_logged || 0).toFixed(1)}h
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>{r.pursuits_converted || 0}</td>
                      <td style={{ padding: '10px 14px', minWidth: 140 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 6, background: 'var(--color-border-tertiary)', borderRadius: 3 }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: pct >= 80 ? '#16a34a' : pct >= 50 ? '#d97706' : '#6B3FDB', borderRadius: 3, transition: 'width 0.3s ease' }} />
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{pct}%</span>
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

      {!loading && sorted.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {sorted.length} team members · Click column headers to sort
        </div>
      )}
    </div>
  );
}
