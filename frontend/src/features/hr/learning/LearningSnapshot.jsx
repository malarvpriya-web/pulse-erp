// Learning record panel (2026-11-18) — shown beside a probation review (HR's
// decision and the department head's review). `url` returns lndSnapshot.
import { useEffect, useState } from 'react';
import api from '@/services/api/client';
import { Pill, Level, fmtDate, errText } from './lndUi';

export default function LearningSnapshot({ url, title = 'Learning during probation' }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    setD(null); setErr('');
    Promise.resolve(api.get(url))
      .then(r => { if (!live) return; if (r?.data?.totals) setD(r.data); else setErr('none'); })
      .catch(e => { if (live) setErr(errText(e)); });
    return () => { live = false; };
  }, [url]);
  if (err) return null; // no access or nothing to show — the review works without it
  if (!d) return <div className="lnd" style={{ fontSize: 12, color: '#9ca3af', padding: '6px 0' }}>Loading learning record…</div>;
  const t = d.totals;
  const mandOk = t.mandatory_required ? t.mandatory_compliant === t.mandatory_required : true;
  return (
    <div className="lnd">
      <div className="lnd-card" style={{ padding: 12, margin: '10px 0' }}>
        <div className="lnd-card-title" style={{ marginBottom: 8 }}>
          <span>{title}{d.since ? <span className="lnd-muted"> · since {fmtDate(d.since)}</span> : null}</span>
          <button type="button" className="lnd-link" onClick={() => setOpen(o => !o)}>{open ? 'Hide details' : 'Show details'}</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 13 }}>
          <span><strong>{t.completed}</strong> trainings completed ({t.hours} h){t.avg_score != null ? ` · avg score ${t.avg_score}%` : ''}</span>
          {t.open > 0 && <span><strong>{t.open}</strong> open</span>}
          {t.no_shows > 0 && <span style={{ color: 'var(--color-danger)' }}><strong>{t.no_shows}</strong> no-show</span>}
          <span>Tests: <strong>{t.tests_passed}</strong> / {t.tests_taken} passed</span>
          <span>Mandatory: <Pill tone={mandOk ? 'good' : 'bad'}>{t.mandatory_compliant} / {t.mandatory_required} done</Pill></span>
          {t.knowledge_gain != null && <span>Self-rated knowledge <strong>{t.knowledge_gain > 0 ? '+' : ''}{t.knowledge_gain}</strong> after training</span>}
          {t.skill_gaps > 0 && <span style={{ color: 'var(--color-warning)' }}><strong>{t.skill_gaps}</strong> skill(s) below the role's level</span>}
        </div>
        {open && (
          <div style={{ marginTop: 10, display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            <div><div className="lnd-muted" style={{ fontWeight: 700 }}>Trainings</div>
              {d.trainings.length ? d.trainings.map((x, i) => <div key={i} style={{ fontSize: 12, padding: '3px 0' }}>{fmtDate(x.scheduled_date)} · {x.title} <Pill status={x.status} />{x.score != null ? ` ${x.score}%` : ''}</div>) : <div className="lnd-muted">None</div>}</div>
            <div><div className="lnd-muted" style={{ fontWeight: 700 }}>Mandatory</div>
              {d.mandatory.length ? d.mandatory.map((m, i) => <div key={i} style={{ fontSize: 12, padding: '3px 0' }}>{m.title} <Pill status={m.status} /></div>) : <div className="lnd-muted">None apply</div>}
              <div className="lnd-muted" style={{ fontWeight: 700, marginTop: 6 }}>Certificates</div>
              {d.certificates.length ? d.certificates.map((c, i) => <div key={i} style={{ fontSize: 12, padding: '3px 0' }}>{c.name} <Pill status={c.status} /></div>) : <div className="lnd-muted">None</div>}</div>
            <div><div className="lnd-muted" style={{ fontWeight: 700 }}>Skills (level / needed)</div>
              {d.skills.length ? d.skills.map((s, i) => <div key={i} style={{ fontSize: 12, padding: '3px 0', display: 'flex', alignItems: 'center', gap: 6 }}><Level level={s.level} gap={!s.level || s.level < s.required} /> {s.name} <span className="lnd-muted">needs L{s.required}</span></div>) : <div className="lnd-muted">Not rated</div>}</div>
          </div>
        )}
      </div>
    </div>
  );
}
