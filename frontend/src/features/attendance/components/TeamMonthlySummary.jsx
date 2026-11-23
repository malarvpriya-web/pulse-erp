// Team Attendance → Monthly summary (§278.3, owner 2026-11-19).
// One row per team member for a month: leaves, late arrivals in three bands
// (up to 15 min, 15–30, over 30), early exits, geo fence, salary cut for late
// coming. The same figures go to each manager as a notification on the 1st.
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import api from '@/services/api/client';

const P = '#6B3FDB';
const COLS = [
  { key: 'present_days', label: 'Present' },
  { key: 'leave_days', label: 'Leave' },
  { key: 'absent_days', label: 'Absent', bad: true },
  { key: 'half_days', label: 'Half day' },
  { key: 'late_upto_15', label: 'Late ≤15 min' },
  { key: 'late_15_30', label: 'Late 15–30 min', bad: true },
  { key: 'late_over_30', label: 'Late >30 min', bad: true },
  { key: 'early_exits', label: 'Early exits', bad: true },
  { key: 'app_punches', label: 'Geo: inside' },
  { key: 'geo_blocked', label: 'Geo: refused', bad: true },
  { key: 'penalty_days', label: 'Salary cut (days)', bad: true },
];

function monthOptions() {
  const out = [];
  const d = new Date(); d.setDate(1);
  for (let i = 0; i < 12; i++) {
    out.push({ m: d.getMonth() + 1, y: d.getFullYear(), label: d.toLocaleString('en-GB', { month: 'long', year: 'numeric' }) });
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

export default function TeamMonthlySummary({ department }) {
  const opts = monthOptions();
  const [pick, setPick] = useState(`${opts[0].y}-${opts[0].m}`);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const [y, m] = pick.split('-');
    setData(null); setError('');
    const q = new URLSearchParams({ month: m, year: y });
    if (department) q.set('department', department);
    api.get(`/attendance/team-summary?${q}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e?.response?.data?.message || e?.response?.data?.error || 'Could not load the summary'));
  }, [pick, department]);

  const members = data?.members || [];
  const total = (k) => members.reduce((s, r) => s + Number(r[k] || 0), 0);

  const exportCsv = () => {
    const head = ['Employee', 'Code', 'Department', ...COLS.map((c) => c.label)];
    const rows = members.map((r) => [r.employee_name, r.emp_code, r.department, ...COLS.map((c) => r[c.key])]);
    const csv = [head, ...rows].map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `team-attendance-${pick}.csv`; a.click();
  };

  return (
    <div data-testid="team-monthly-summary" style={{ background: '#fff', border: '1px solid #ece9f8', borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Month"
          style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }}>
          {opts.map((o) => <option key={`${o.y}-${o.m}`} value={`${o.y}-${o.m}`}>{o.label}</option>)}
        </select>
        <span style={{ flex: 1, fontSize: 12, color: '#6b7280' }}>
          {members.length} {members.length === 1 ? 'person' : 'people'} · managers also get this on the 1st of every month
        </span>
        <button onClick={exportCsv} disabled={!members.length}
          style={{ padding: '7px 14px', background: P, color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Download size={13} /> Export CSV
        </button>
      </div>
      {error && <div role="alert" style={{ color: '#dc2626', fontSize: 13 }}>{error}</div>}
      {!data && !error && <div style={{ color: '#9ca3af', fontSize: 13, padding: 16 }}>Loading…</div>}
      {data && !members.length && <div style={{ color: '#9ca3af', fontSize: 13, padding: 16 }}>No team members to show.</div>}
      {members.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #f0f0f4', textAlign: 'left' }}>
                <th style={{ padding: '8px 10px', color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>Employee</th>
                {COLS.map((c) => <th key={c.key} style={{ padding: '8px 10px', color: '#6b7280', fontSize: 11, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {members.map((r) => (
                <tr key={r.employee_id} style={{ borderBottom: '1px solid #f8f7fc' }}>
                  <td style={{ padding: '8px 10px' }}>
                    <div style={{ fontWeight: 600, color: '#1f2937' }}>{r.employee_name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.emp_code} · {r.department || '—'}</div>
                  </td>
                  {COLS.map((c) => {
                    const v = Number(r[c.key] || 0);
                    return <td key={c.key} style={{ padding: '8px 10px', color: c.bad && v > 0 ? '#dc2626' : v > 0 ? '#1f2937' : '#9ca3af', fontWeight: c.bad && v > 0 ? 600 : 400 }}>{v}</td>;
                  })}
                </tr>
              ))}
              <tr style={{ background: '#faf9ff', fontWeight: 700 }}>
                <td style={{ padding: '8px 10px', color: P }}>Team total</td>
                {COLS.map((c) => <td key={c.key} style={{ padding: '8px 10px', color: P }}>{Math.round(total(c.key) * 10) / 10}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
