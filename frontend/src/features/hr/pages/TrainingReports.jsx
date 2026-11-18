// frontend/src/features/hr/pages/TrainingReports.jsx
// L&D Reports (2026-11-18). Every report takes the same filters — period
// (last 3 / 6 / 12 months, quarter, FY, custom), department, category,
// training, trainer, mandatory — and exports what is on screen.
import { useEffect, useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { Filters, Pill, Empty, EmployeeSelect, fmtDate, fmtINR, fmtNum, toQuery, errText, downloadCsv, statusLabel } from '@/features/hr/learning/lndUi';

const REPORTS = [
  { id: 'mandatory-compliance', label: 'Mandatory compliance', chart: ['training', 'compliance_pct'], filters: ['department', 'category'] },
  { id: 'refresher-due', label: 'Refreshers due', filters: ['department', 'category'] },
  { id: 'completion-rates', label: 'Completion by training', chart: ['training', 'completion_pct'] },
  { id: 'overdue-training', label: 'Overdue training' },
  { id: 'attendance', label: 'Session attendance', chart: ['training', 'attendance_pct'] },
  { id: 'training-hours', label: 'Training hours by department', chart: ['department', 'total_hours'] },
  { id: 'assessment-results', label: 'Test results', chart: ['test', 'pass_rate_pct'] },
  { id: 'self-review-comparison', label: 'Before vs after (by training)', chart: ['training', 'knowledge_change'] },
  { id: 'self-review-people', label: 'Before vs after (by person)' },
  { id: 'feedback-analysis', label: 'Feedback', chart: ['training', 'avg_rating'] },
  { id: 'trainer-effectiveness', label: 'Trainer effectiveness', chart: ['trainer', 'avg_rating'] },
  { id: 'budget-vs-actual', label: 'Budget vs actual', chart: ['category', 'actual'] },
  { id: 'training-cost', label: 'Cost per training' },
  { id: 'certification-status', label: 'Certificate status', filters: ['department', 'category', 'mandatory'] },
  { id: 'certification-coverage', label: 'Missing / expired mandatory certificates', filters: ['department'] },
  { id: 'competency-gaps', label: 'Skill gaps', filters: ['department'], group: true },
  { id: 'learning-path-completion', label: 'Learning path completion', chart: ['path', 'completion_pct'], filters: ['department'] },
  { id: 'employee-history', label: 'One employee’s training record', employee: true },
];
const DEFAULT = { period: 'fytd', department: '', category: '', trainer_id: '', mandatory: '', program_id: '', employee_id: '', group: 'department', cost_min: '', cost_max: '' };
const COST_REPORTS = ['budget-vs-actual', 'training-cost', 'self-review-comparison'];

const MONEY = /cost|budget|actual|variance/;
const DATE = /(^|_)(date|completed_on|last_completed|valid_until|next_scheduled|session_date|expiry_date)$/;
function cell(k, v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (k === 'status') return <Pill status={v} />;
  if (DATE.test(k)) return fmtDate(v);
  if (/_pct$/.test(k)) return `${fmtNum(v)}%`;
  if (MONEY.test(k) && typeof v === 'number') return fmtINR(v);
  if (typeof v === 'number') return fmtNum(v, 2);
  return String(v);
}

export default function TrainingReports() {
  const [rid, setRid] = useState(REPORTS[0].id);
  const [f, setF] = useState(DEFAULT);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [programs, setPrograms] = useState([]);
  const rep = REPORTS.find(r => r.id === rid);
  useEffect(() => { api.get('/training/programs').then(r => setPrograms(r.data)).catch(() => {}); }, []);
  useEffect(() => {
    if (rep.employee && !f.employee_id) { setRows([]); return; }
    setRows(null); setErr('');
    api.get(`/lnd-reports/${rid}${toQuery(f)}`).then(r => setRows(r.data)).catch(e => { setErr(errText(e)); setRows([]); });
  }, [rid, f]); // eslint-disable-line react-hooks/exhaustive-deps
  const cols = useMemo(() => (rows?.length ? Object.keys(rows[0]) : []), [rows]);
  const fields = [...(rep.filters || ['period', 'department', 'category', 'trainer', 'mandatory']), ...(COST_REPORTS.includes(rid) ? ['cost'] : [])];

  return (
    <PageShell dock={<PageHero icon={BarChart3} eyebrow="Learning Center" title="L&D Reports" subtitle="Compliance, completion, attendance, tests, feedback, cost and skills" />}>
      <div className="lnd" style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 240px) 1fr', gap: 14, alignItems: 'start' }}>
        <div className="lnd-card" style={{ position: 'sticky', top: 12, padding: 8 }}>
          {REPORTS.map(r => (
            <button key={r.id} type="button" onClick={() => setRid(r.id)} className="lnd-tab"
              style={{ display: 'block', width: '100%', textAlign: 'left', borderBottom: 'none', borderLeft: `3px solid ${r.id === rid ? 'var(--color-primary)' : 'transparent'}`, marginBottom: 2,
                color: r.id === rid ? 'var(--color-primary)' : undefined, background: r.id === rid ? '#f5f3ff' : 'none', borderRadius: 6 }}>{r.label}</button>
          ))}
        </div>
        <div style={{ minWidth: 0 }}>
          <Filters value={f} onChange={setF} fields={fields} onReset={() => setF(DEFAULT)} extra={<>
            {!rep.filters && <label>Training<select value={f.program_id} onChange={e => setF(v => ({ ...v, program_id: e.target.value }))}><option value="">All</option>
              {programs.filter(p => !p.series_id).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
            {rep.group && <label>Group by<select value={f.group} onChange={e => setF(v => ({ ...v, group: e.target.value }))}><option value="department">Department</option><option value="designation">Designation</option></select></label>}
            {rep.employee && <label>Employee<EmployeeSelect value={f.employee_id} onChange={v => setF(x => ({ ...x, employee_id: v }))} /></label>}
          </>} />
          {err && <div className="lnd-error">{err}</div>}
          {rep.chart && rows?.length > 0 && (
            <div className="lnd-card">
              <div style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rows.slice(0, 20)} margin={{ top: 6, right: 10, left: 0, bottom: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey={rep.chart[0]} tick={{ fontSize: 10 }} angle={-20} textAnchor="end" interval={0} />
                    <YAxis tick={{ fontSize: 11 }} /><Tooltip formatter={(v) => cell(rep.chart[1], v)} />
                    <Bar dataKey={rep.chart[1]} name={statusLabel(rep.chart[1])} fill="#6B3FDB" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          <div className="lnd-card">
            <div className="lnd-card-title"><span>{rep.label} {rows && <span className="lnd-muted">· {rows.length} row(s)</span>}</span>
              <button type="button" className="lnd-link" disabled={!rows?.length} onClick={() => downloadCsv(rows, rid)}>Export CSV</button></div>
            {rep.employee && !f.employee_id ? <Empty>Choose an employee.</Empty> : !rows ? <Empty>Loading…</Empty> : rows.length ? (
              <div className="lnd-table-wrap"><table className="lnd-table">
                <thead><tr>{cols.map(c => <th key={c} className={typeof rows[0][c] === 'number' ? 'num' : ''}>{statusLabel(c)}</th>)}</tr></thead>
                <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(c => <td key={c} className={typeof r[c] === 'number' ? 'num' : ''}>{cell(c, r[c])}</td>)}</tr>)}</tbody>
              </table></div>
            ) : <Empty>No data for these filters.</Empty>}
          </div>
        </div>
      </div>
    </PageShell>
  );
}
