// frontend/src/features/hr/pages/LearningDashboard.jsx
// L&D Dashboard (2026-11-18). One API call (/training/dashboard) answers every
// tile and chart for the chosen period / department / category. The Training
// Calendar's duplicate KPI row and cost charts now live only here.
import { useCallback, useEffect, useState } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { Filters, Kpi, Pill, Empty, fmtINR, fmtNum, fmtDate, pct, toQuery, errText, statusLabel } from '@/features/hr/learning/lndUi';

const SERIES = ['#6B3FDB', '#2563eb', '#16a34a', '#d97706', '#dc2626', '#0891b2', '#7c3aed'];
const DEFAULT = { period: 'fytd', department: '', category: '' };

function Card({ title, children, right }) {
  return <div className="lnd-card"><h4 className="lnd-card-title"><span>{title}</span>{right}</h4>{children}</div>;
}

export default function LearningDashboard({ setPage }) {
  const [f, setF] = useState(DEFAULT);
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { setD((await api.get(`/training/dashboard${toQuery(f)}`)).data); }
    catch (e) { setErr(errText(e, 'Could not load the dashboard')); }
    finally { setLoading(false); }
  }, [f]);
  useEffect(() => { load(); }, [load]);

  const go = (page) => setPage?.(page);
  const k = d?.kpis || {};

  return (
    <PageShell dock={<PageHero icon={LayoutDashboard} eyebrow="Learning Center" title="L&D Dashboard"
      subtitle={d ? `${d.period_label}${d.department ? ` · ${d.department}` : ''}${d.category ? ` · ${d.category}` : ''}` : 'Training, compliance, skills and spend'} />}>
      <div className="lnd">
        <Filters value={f} onChange={setF} fields={['period', 'department', 'category']} onReset={() => setF(DEFAULT)} />
        {err && <div className="lnd-error">{err}</div>}
        {loading && !d ? <Empty>Loading…</Empty> : d && (<>
          <div className="lnd-kpis">
            <Kpi label="Trainings" value={fmtNum(k.programs)} sub={`${k.active_programs} planned / running · ${k.cancelled} cancelled`} tone="brand" onClick={() => go('LearningDevelopment')} />
            <Kpi label="Upcoming (30 days)" value={fmtNum(k.upcoming_30d)} onClick={() => go('LearningDevelopment')} />
            <Kpi label="Completion rate" value={pct(k.completion_rate_pct)} sub={`${k.completions} of ${k.enrollments} enrolments`} tone={k.completion_rate_pct >= 80 ? 'good' : k.completion_rate_pct >= 50 ? 'warn' : 'bad'} />
            <Kpi label="People trained" value={fmtNum(k.employees_trained)} sub={`of ${k.headcount} active staff`} />
            <Kpi label="Training hours" value={fmtNum(k.training_hours, 1)} sub={`${k.hours_per_employee} h per employee`} />
            <Kpi label="No-shows" value={fmtNum(k.no_shows)} tone={k.no_shows ? 'warn' : undefined} />
            <Kpi label="Spend" value={fmtINR(k.total_cost)} sub={k.budget ? `Budget ${fmtINR(k.budget)}` : 'No budget set'} tone={k.budget && k.total_cost > k.budget ? 'bad' : undefined} />
            <Kpi label="Avg feedback" value={k.avg_feedback ? `${k.avg_feedback} / 5` : '—'} />
            <Kpi label="Knowledge gain" value={k.knowledge_gain != null ? `${k.knowledge_gain > 0 ? '+' : ''}${k.knowledge_gain}` : '—'}
              sub={k.self_review_pairs ? `self-rated before → after, ${k.self_review_pairs} people · confidence ${k.confidence_gain > 0 ? '+' : ''}${k.confidence_gain}` : 'no before/after reviews yet'}
              tone={k.knowledge_gain > 0 ? 'good' : k.knowledge_gain < 0 ? 'bad' : undefined} onClick={() => go('TrainingReports')} />
            <Kpi label="Mandatory compliance" value={pct(k.mandatory_compliance_pct)} sub={`${k.mandatory_not_done} not done`} tone={k.mandatory_compliance_pct >= 90 ? 'good' : k.mandatory_compliance_pct >= 70 ? 'warn' : 'bad'} onClick={() => go('TrainingReports')} />
            <Kpi label="Refreshers overdue" value={fmtNum(k.refresher_overdue)} sub={`${k.refresher_due_soon} due within 30 days`} tone={k.refresher_overdue ? 'bad' : 'good'} />
            <Kpi label="Certificates expiring" value={fmtNum(k.certs_expiring_30d)} sub={`${k.certs_expiring_90d} more within 90 days · ${k.certs_expired} expired`} tone={k.certs_expired ? 'bad' : k.certs_expiring_30d ? 'warn' : 'good'} onClick={() => go('CertificationManagement')} />
            <Kpi label="Skill gaps" value={fmtNum(k.skill_gaps)} sub="ratings below the required level" tone={k.skill_gaps ? 'warn' : 'good'} onClick={() => go('SkillsCompetencies')} />
          </div>

          <div className="lnd-grid lnd-grid-2">
            <Card title="Month by month">
              <div style={{ height: 230 }}>
                {d.monthly.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={d.monthly} margin={{ top: 6, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="n" allowDecimals={false} tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="c" orientation="right" tick={{ fontSize: 11 }} tickFormatter={v => fmtINR(v)} />
                      <Tooltip formatter={(v, n) => (n === 'Spend' ? fmtINR(v) : v)} />
                      <Legend />
                      <Line yAxisId="n" dataKey="programs" name="Trainings" stroke={SERIES[0]} strokeWidth={2} />
                      <Line yAxisId="n" dataKey="completions" name="Completions" stroke={SERIES[2]} strokeWidth={2} />
                      <Line yAxisId="c" dataKey="cost" name="Spend" stroke={SERIES[3]} strokeDasharray="4 3" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : <Empty>No trainings in this period.</Empty>}
              </div>
            </Card>
            <Card title="Mandatory trainings — compliance">
              {d.compliance_series.length ? (
                <div className="lnd-table-wrap" style={{ maxHeight: 230 }}>
                  <table className="lnd-table"><thead><tr><th>Training</th><th>Repeats</th><th className="num">Required</th><th className="num">Overdue</th><th className="num">Not done</th><th>Compliance</th></tr></thead>
                    <tbody>{d.compliance_series.map(s => (
                      <tr key={s.series_id}><td>{s.title}</td><td>{s.refresher_months ? `every ${s.refresher_months} mo` : 'once'}</td>
                        <td className="num">{s.required}</td><td className="num">{s.overdue}</td><td className="num">{s.not_done}</td>
                        <td><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div className="lnd-bar" style={{ flex: 1 }}><span style={{ width: `${s.compliance_pct}%` }} /></div>{s.compliance_pct}%</div></td></tr>
                    ))}</tbody></table>
                </div>
              ) : <Empty>No mandatory trainings yet. Mark a training “Mandatory” to track it here.</Empty>}
            </Card>
            <Card title="Training hours by department">
              <div style={{ height: 220 }}>
                {d.hours_by_department.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={d.hours_by_department} margin={{ top: 6, right: 10, left: 0, bottom: 30 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="department" tick={{ fontSize: 11 }} angle={-20} textAnchor="end" interval={0} />
                      <YAxis tick={{ fontSize: 11 }} /><Tooltip />
                      <Bar dataKey="hours" name="Hours" fill={SERIES[0]} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <Empty>No completed training in this period.</Empty>}
              </div>
            </Card>
            <Card title="Spend by type">
              <div style={{ height: 220 }}>
                {d.cost_by_type.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={d.cost_by_type.map(r => ({ ...r, name: statusLabel(r.name) }))} dataKey="value" nameKey="name" innerRadius={45} outerRadius={80}>
                        {d.cost_by_type.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
                      </Pie>
                      <Tooltip formatter={v => fmtINR(v)} /><Legend />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <Empty>No costs recorded. Add them on each training.</Empty>}
              </div>
            </Card>
            <Card title="Lowest completion">
              {d.lowest_completion.length ? (
                <div className="lnd-table-wrap" style={{ maxHeight: 220 }}>
                  <table className="lnd-table"><thead><tr><th>Training</th><th className="num">Enrolled</th><th className="num">Done</th><th>Completion</th></tr></thead>
                    <tbody>{d.lowest_completion.map(r => (
                      <tr key={r.id}><td>{r.title}</td><td className="num">{r.enrolled}</td><td className="num">{r.completed}</td><td>{pct(r.completion_pct)}</td></tr>
                    ))}</tbody></table>
                </div>
              ) : <Empty>No enrolments in this period.</Empty>}
            </Card>
            <Card title="Trainers by feedback">
              {d.trainers.length ? (
                <div className="lnd-table-wrap" style={{ maxHeight: 220 }}>
                  <table className="lnd-table"><thead><tr><th>Trainer</th><th className="num">Trainings</th><th className="num">Completions</th><th className="num">Avg rating</th></tr></thead>
                    <tbody>{d.trainers.map(t => (
                      <tr key={t.id}><td>{t.trainer}</td><td className="num">{t.programs}</td><td className="num">{t.completions}</td><td className="num">{t.avg_rating ?? '—'}</td></tr>
                    ))}</tbody></table>
                </div>
              ) : <Empty>No trainer has a training in this period.</Empty>}
            </Card>
          </div>

          <div className="lnd-grid lnd-grid-2" style={{ marginTop: 14 }}>
            <Card title={`Refreshers due (${d.refresher_due.length})`}>
              {d.refresher_due.length ? (
                <div className="lnd-table-wrap" style={{ maxHeight: 300 }}>
                  <table className="lnd-table"><thead><tr><th>Employee</th><th>Training</th><th>Last done</th><th>Valid until</th><th>Status</th></tr></thead>
                    <tbody>{d.refresher_due.map((r, i) => (
                      <tr key={i}><td>{r.employee_name}<div className="lnd-muted">{r.department}</div></td><td>{r.title}</td>
                        <td>{fmtDate(r.last_completed)}</td><td>{fmtDate(r.valid_until)}</td>
                        <td><Pill status={r.status} />{r.next_scheduled && <div className="lnd-muted">booked {fmtDate(r.next_scheduled)}</div>}</td></tr>
                    ))}</tbody></table>
                </div>
              ) : <Empty>Everyone is up to date.</Empty>}
            </Card>
            <Card title={`Overdue (${d.overdue.length})`}>
              {d.overdue.length ? (
                <div className="lnd-table-wrap" style={{ maxHeight: 300 }}>
                  <table className="lnd-table"><thead><tr><th>Employee</th><th>Training</th><th>Date</th><th className="num">Days late</th></tr></thead>
                    <tbody>{d.overdue.map(r => (
                      <tr key={r.id}><td>{r.employee_name}<div className="lnd-muted">{r.department}</div></td>
                        <td>{r.program} {r.is_mandatory && <Pill tone="bad">Mandatory</Pill>}</td>
                        <td>{fmtDate(r.scheduled_date)}</td><td className="num">{r.days_overdue}</td></tr>
                    ))}</tbody></table>
                </div>
              ) : <Empty>No overdue training. Mark attendance and completion on each training to keep this accurate.</Empty>}
            </Card>
          </div>
          <div className="lnd-card" style={{ marginTop: 14 }}>
            <h4 className="lnd-card-title"><span>Coming up</span><button type="button" className="lnd-link" onClick={() => go('LearningDevelopment')}>Open Trainings →</button></h4>
            {d.upcoming.length ? (
              <table className="lnd-table"><thead><tr><th>Date</th><th>Training</th><th>Mode</th><th className="num">Enrolled</th></tr></thead>
                <tbody>{d.upcoming.map(u => (
                  <tr key={u.id}><td>{fmtDate(u.scheduled_date)}</td><td>{u.title} {u.is_mandatory && <Pill tone="bad">Mandatory</Pill>}</td>
                    <td>{statusLabel(u.mode)}</td><td className="num">{u.enrolled} / {u.max_participants}</td></tr>
                ))}</tbody></table>
            ) : <Empty>Nothing scheduled.</Empty>}
          </div>
        </>)}
      </div>
    </PageShell>
  );
}
