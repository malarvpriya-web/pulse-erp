// Employee record → Learning tab (2026-11-18): the employee's trainings,
// mandatory status, certificates, skills and paths, from /training/employee/:id/summary
// (training:view). The employee sees the same in Self Service → My Learning.
import { useEffect, useState } from 'react';
import api from '@/services/api/client';
import { Pill, Empty, Level, Kpi, fmtDate, fmtNum, errText, statusLabel } from './lndUi';

export default function EmployeeLearningTab({ employeeId }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!employeeId) return;
    setD(null); setErr('');
    api.get(`/training/employee/${employeeId}/summary`).then(r => setD(r.data))
      .catch(e => setErr(e?.response?.status === 403 ? 'You do not have access to training records.' : errText(e)));
  }, [employeeId]);
  if (err) return <div className="lnd"><div className="lnd-error">{err}</div></div>;
  if (!d) return <div className="lnd"><Empty>Loading…</Empty></div>;
  const mandBad = d.mandatory.filter(m => m.status !== 'compliant').length;
  return (
    <div className="lnd">
      <div className="lnd-kpis">
        <Kpi label="Trainings completed" value={d.totals.completed} sub={`${fmtNum(d.totals.hours, 1)} hours`} tone="good" />
        <Kpi label="Open trainings" value={d.trainings.filter(t => ['enrolled', 'in_progress'].includes(t.status)).length} tone="brand" />
        <Kpi label="Mandatory not compliant" value={mandBad} tone={mandBad ? 'bad' : 'good'} />
        <Kpi label="Certificates" value={d.certifications.length} sub={`${d.certifications.filter(c => c.status === 'expired').length} expired`} />
      </div>
      <div className="lnd-grid lnd-grid-2">
        <div className="lnd-card"><h4 className="lnd-card-title"><span>Trainings</span></h4>
          {d.trainings.length ? <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Date</th><th>Training</th><th>Status</th><th className="num">Score</th></tr></thead>
            <tbody>{d.trainings.map(t => <tr key={t.id}><td>{fmtDate(t.scheduled_date)}</td><td>{t.title} {t.is_mandatory && <Pill tone="bad">Mandatory</Pill>}</td><td><Pill status={t.status} /></td><td className="num">{t.score != null ? `${t.score}%` : '—'}</td></tr>)}</tbody></table>
            : <Empty>No trainings.</Empty>}</div>
        <div className="lnd-card"><h4 className="lnd-card-title"><span>Mandatory trainings</span></h4>
          {d.mandatory.length ? <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Training</th><th>Last done</th><th>Valid until</th><th>Status</th></tr></thead>
            <tbody>{d.mandatory.map(m => <tr key={m.series_id}><td>{m.title}</td><td>{fmtDate(m.last_completed)}</td><td>{fmtDate(m.valid_until)}</td><td><Pill status={m.status} /></td></tr>)}</tbody></table>
            : <Empty>None apply.</Empty>}</div>
        <div className="lnd-card"><h4 className="lnd-card-title"><span>Certificates</span></h4>
          {d.certifications.length ? <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Certificate</th><th>Expires</th><th>Status</th></tr></thead>
            <tbody>{d.certifications.map(c => <tr key={c.id}><td>{c.name}</td><td>{c.expiry_date ? fmtDate(c.expiry_date) : 'Never'}</td><td><Pill status={c.status} /></td></tr>)}</tbody></table>
            : <Empty>None recorded.</Empty>}</div>
        <div className="lnd-card"><h4 className="lnd-card-title"><span>Skills</span></h4>
          {d.skills.length ? <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Skill</th><th>Level</th><th>From</th></tr></thead>
            <tbody>{d.skills.map(s => <tr key={s.name}><td>{s.name}<div className="lnd-muted">{s.category}</div></td><td><Level level={s.assessed_level} /></td><td>{statusLabel(s.source)} · {fmtDate(s.assessed_date)}</td></tr>)}</tbody></table>
            : <Empty>Not rated.</Empty>}
          {d.paths.length > 0 && <p className="lnd-muted">Learning paths: {d.paths.map(p => `${p.name} (${statusLabel(p.status)})`).join(', ')}</p>}
        </div>
      </div>
    </div>
  );
}
