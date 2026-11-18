// frontend/src/features/hr/pages/MyLearning.jsx
// My Learning (2026-11-18) — every employee's own trainings, open trainings to
// join, learning paths, tests, certificates, skills and mandatory status.
// Everything comes from /my-learning, which answers only for the caller.
import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { openEmployeeFile } from '@/features/employees/shared/employeeFiles';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { Pill, Empty, Tabs, Kpi, LndDialog, Level, fmtDate, fmtNum, errText, statusLabel, stars, today } from '@/features/hr/learning/lndUi';

function FeedbackDialog({ enrollment, settings, onClose, onDone }) {
  const [rating, setRating] = useState(enrollment.feedback_rating || 0);
  const [comments, setComments] = useState(enrollment.feedback_comments || '');
  const [err, setErr] = useState('');
  const min = settings.feedback_required ? settings.min_feedback_chars || 0 : 0;
  const save = async () => {
    try { await api.post(`/my-learning/enrollments/${enrollment.id}/feedback`, { rating, comments }); onDone(); }
    catch (e) { setErr(errText(e)); }
  };
  return (
    <LndDialog title={`Feedback — ${enrollment.title}`} onClose={onClose} width={480} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="pulse-btn-primary" disabled={!rating || comments.length < min} onClick={save}>Send</button></>}>
      <div className="lnd-form">
        <div className="full" style={{ fontSize: 28, letterSpacing: 4 }}>
          {[1, 2, 3, 4, 5].map(n => <button key={n} type="button" aria-label={`${n} stars`} onClick={() => setRating(n)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 28, color: n <= rating ? '#f59e0b' : '#d1d5db' }}>★</button>)}
        </div>
        <label className="full">Comments{min ? ` (at least ${min} characters)` : ''}<textarea value={comments} onChange={e => setComments(e.target.value)} />
          {min > 0 && <span className="hint">{comments.length} / {min}</span>}</label>
      </div>
    </LndDialog>
  );
}

const SCALE = { 1: 'Very low', 2: 'Low', 3: 'Moderate', 4: 'Good', 5: 'Very good' };
function Rate({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} type="button" title={SCALE[n]} onClick={() => onChange(n)}
          className={`lnd-level l${value === n ? n : 0}`} style={{ width: 38 }}>{n}</button>
      ))}
      <span className="lnd-muted" style={{ alignSelf: 'center', marginLeft: 6 }}>{value ? SCALE[value] : ''}</span>
    </div>
  );
}

/** Before / after self-review form. Shows the before-answers next to the after form. */
function SelfReviewDialog({ enrollment, phase, onClose, onDone }) {
  const items = Array.isArray(enrollment.self_review_items) ? enrollment.self_review_items : [];
  const reviews = enrollment.self_reviews || [];
  const mine = reviews.find(r => r.phase === phase);
  const before = reviews.find(r => r.phase === 'pre');
  const [f, setF] = useState({ knowledge: mine?.knowledge || 0, confidence: mine?.confidence || 0, item_ratings: mine?.item_ratings || {}, comments: mine?.comments || '' });
  const [err, setErr] = useState('');
  const ready = f.knowledge && f.confidence && items.every(it => f.item_ratings[it]);
  const save = async () => {
    try { const r = await api.post(`/my-learning/enrollments/${enrollment.id}/self-review`, { phase, ...f }); onDone(r.data.message); }
    catch (e) { setErr(errText(e)); }
  };
  const row = (label, value, onChange, prev) => (
    <div style={{ padding: '10px 0', borderBottom: '1px solid #f0ebff' }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{label}{phase === 'post' && prev != null && <span className="lnd-muted"> — before: {prev}</span>}</div>
      <Rate value={value} onChange={onChange} />
    </div>
  );
  return (
    <LndDialog title={`${phase === 'pre' ? 'Before' : 'After'} the training — ${enrollment.title}`} onClose={onClose} width={620} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="pulse-btn-primary" disabled={!ready} onClick={save}>Save</button></>}>
      <p className="lnd-muted" style={{ marginTop: 0 }}>
        {phase === 'pre' ? 'Rate yourself honestly as you are today. After the training you rate yourself again and both are compared.'
          : 'Rate yourself now, after the training. Your rating from before is shown for comparison.'}
      </p>
      {row('My knowledge of this topic', f.knowledge, v => setF(x => ({ ...x, knowledge: v })), before?.knowledge)}
      {row('My confidence applying it at work', f.confidence, v => setF(x => ({ ...x, confidence: v })), before?.confidence)}
      {items.map(it => row(it, f.item_ratings[it], v => setF(x => ({ ...x, item_ratings: { ...x.item_ratings, [it]: v } })), before?.item_ratings?.[it]))}
      <div className="lnd-form" style={{ marginTop: 10 }}>
        <label className="full">{phase === 'pre' ? 'What do you hope to learn? (optional)' : 'What changed for you? (optional)'}
          <textarea value={f.comments} onChange={e => setF(x => ({ ...x, comments: e.target.value }))} maxLength={2000} /></label>
      </div>
    </LndDialog>
  );
}

function ReviewCell({ e, onOpen }) {
  if (!e.self_review_enabled) return <span className="lnd-muted">—</span>;
  const r = e.self_reviews || [];
  const pre = r.find(x => x.phase === 'pre'); const post = r.find(x => x.phase === 'post');
  return (
    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
      <div>Before: {pre ? <strong>K{pre.knowledge} · C{pre.confidence}</strong> : e.self_review_open === 'pre' ? <button type="button" className="lnd-link" onClick={() => onOpen('pre')}>Rate now</button> : <span className="lnd-muted">not done</span>}
        {pre && e.self_review_open === 'pre' && <> <button type="button" className="lnd-link" onClick={() => onOpen('pre')}>edit</button></>}</div>
      <div>After: {post ? <strong>K{post.knowledge} · C{post.confidence}</strong> : e.self_review_open === 'post' ? <button type="button" className="lnd-link" onClick={() => onOpen('post')}>Rate now</button> : <span className="lnd-muted">after completion</span>}</div>
    </div>
  );
}

function TakeTest({ assessmentId, onClose, onDone }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [answers, setAnswers] = useState({});
  const [left, setLeft] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submitted = useRef(false);
  useEffect(() => {
    api.post(`/my-learning/assessments/${assessmentId}/start`).then(r => { setS(r.data); setLeft(r.data.seconds_left); }).catch(e => setErr(errText(e)));
  }, [assessmentId]);
  const submit = useCallback(async () => {
    if (submitted.current || !s) return;
    submitted.current = true; setBusy(true);
    try { const r = await api.post(`/my-learning/attempts/${s.attempt.id}/submit`, { answers }); toast[r.data.passed === false ? 'error' : 'success'](r.data.message); onDone(); }
    catch (e) { submitted.current = false; setErr(errText(e)); } finally { setBusy(false); }
  }, [s, answers, toast, onDone]);
  useEffect(() => {
    if (left == null) return undefined;
    if (left <= 0) { submit(); return undefined; }
    const t = setTimeout(() => setLeft(l => l - 1), 1000);
    return () => clearTimeout(t);
  }, [left, submit]);
  const mm = left != null ? `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}` : null;
  return (
    <LndDialog title={s ? s.assessment.title : 'Test'} onClose={onClose} width={760} error={err}
      footer={s && <><span style={{ marginRight: 'auto', fontWeight: 700, color: left != null && left < 60 ? 'var(--color-danger)' : 'var(--color-primary)' }}>{mm ? `⏱ ${mm}` : 'No time limit'} · pass {s.assessment.pass_score}%</span>
        <button type="button" className="pulse-btn-secondary" onClick={onClose}>Leave (resume later)</button>
        <button type="button" className="pulse-btn-primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : 'Submit'}</button></>}>
      {!s ? (!err && <Empty>Starting…</Empty>) : s.questions.map((q, i) => (
        <div key={q.id} style={{ borderBottom: '1px solid #f0ebff', padding: '12px 0' }}>
          <p style={{ fontWeight: 700, margin: '0 0 8px', fontSize: 14 }}>Q{i + 1}. {q.question_text} <span className="lnd-muted">({q.marks} mark{q.marks === 1 ? '' : 's'})</span></p>
          {q.question_type === 'short_answer'
            ? <div className="lnd-form"><label className="full"><textarea value={answers[q.id] || ''} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} placeholder="Your answer" /></label></div>
            : (q.question_type === 'true_false' ? ['True', 'False'] : (q.options || [])).map(o => (
              <label key={o} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 4,
                background: answers[q.id] === o ? '#ede9fe' : '#fafafa', border: `1px solid ${answers[q.id] === o ? 'var(--color-primary)' : '#eee'}` }}>
                <input type="radio" name={`q${q.id}`} checked={answers[q.id] === o} onChange={() => setAnswers(a => ({ ...a, [q.id]: o }))} />{o}
              </label>
            ))}
        </div>
      ))}
    </LndDialog>
  );
}

export default function MyLearning() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('mine');
  const [show, setShow] = useState('upcoming');
  const [dlg, setDlg] = useState(null);
  const load = useCallback(() => api.get('/my-learning/overview').then(r => { setD(r.data); setErr(''); }).catch(e => setErr(errText(e, 'Could not load your learning'))), []);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, ok) => { try { const r = await fn(); toast.success(r?.data?.message || ok); load(); } catch (e) { toast.error(errText(e)); } };

  if (err) return <PageShell dock={<PageHero icon={BookOpen} eyebrow="Self Service" title="My Learning" />}><div className="lnd"><div className="lnd-error">{err}</div></div></PageShell>;
  if (!d) return <PageShell dock={<PageHero icon={BookOpen} eyebrow="Self Service" title="My Learning" />}><div className="lnd"><Empty>Loading…</Empty></div></PageShell>;

  const t = today();
  const upcoming = d.enrollments.filter(e => e.status !== 'completed' && e.program_status !== 'cancelled');
  const done = d.enrollments.filter(e => e.status === 'completed');
  const list = show === 'upcoming' ? upcoming : show === 'completed' ? done : d.enrollments;
  const hours = done.reduce((s, e) => s + (e.duration_hours || 0), 0);
  const mandBad = d.mandatory.filter(m => m.status !== 'compliant');
  const certBad = d.certifications.filter(c => c.status === 'expired' || (c.days_left != null && c.days_left <= 30));
  const awaiting = new Set(d.attempts.filter(x => x.review_status === 'pending_review').map(x => x.assessment_id));
  const openTests = d.assessments.filter(a => !a.passed && !awaiting.has(a.id) && a.attempts_used < a.max_attempts);
  const reviewsDue = d.enrollments.filter(e => e.self_review_open).length;

  return (
    <PageShell dock={<PageHero icon={BookOpen} eyebrow="Self Service" title="My Learning" subtitle="Your trainings, tests, certificates and skills" />}>
      <div className="lnd">
        <div className="lnd-kpis">
          <Kpi label="Upcoming / in progress" value={upcoming.length} tone="brand" onClick={() => { setTab('mine'); setShow('upcoming'); }} />
          <Kpi label="Completed" value={done.length} sub={`${fmtNum(hours, 1)} hours`} tone="good" onClick={() => { setTab('mine'); setShow('completed'); }} />
          <Kpi label="Tests to take" value={openTests.length} tone={openTests.length ? 'warn' : undefined} onClick={() => setTab('tests')} />
          <Kpi label="Mandatory due" value={mandBad.length} tone={mandBad.length ? 'bad' : 'good'} onClick={() => setTab('mandatory')} />
          <Kpi label="Certificates to renew" value={certBad.length} tone={certBad.length ? 'warn' : 'good'} onClick={() => setTab('certs')} />
          <Kpi label="Self-reviews to do" value={reviewsDue} sub="rate yourself before and after" tone={reviewsDue ? 'warn' : undefined} onClick={() => { setTab('mine'); setShow('all'); }} />
          <Kpi label="Open trainings" value={d.available.length} onClick={() => setTab('open')} />
        </div>
        <Tabs value={tab} onChange={setTab} tabs={[
          { id: 'mine', label: 'My trainings' }, { id: 'open', label: 'Open trainings', count: d.available.length },
          { id: 'paths', label: 'Learning paths', count: d.paths.length }, { id: 'tests', label: 'Tests', count: openTests.length },
          { id: 'mandatory', label: 'Mandatory', count: mandBad.length }, { id: 'certs', label: 'Certificates', count: d.certifications.length },
          { id: 'skills', label: 'My skills' },
        ]} />

        {tab === 'mine' && (<div className="lnd-card">
          <div className="lnd-actions" style={{ marginBottom: 10 }}>
            {['upcoming', 'completed', 'all'].map(s => <button key={s} type="button" className={s === show ? 'pulse-btn-primary lnd-btn-sm' : 'pulse-btn-secondary lnd-btn-sm'} onClick={() => setShow(s)}>{statusLabel(s)}</button>)}
          </div>
          {list.length ? (
            <div className="lnd-table-wrap"><table className="lnd-table"><thead><tr><th>Date</th><th>Training</th><th>Where</th><th>Status</th><th title="K = knowledge, C = confidence, each 1–5">Self-review (K / C)</th><th className="num">Score</th><th>Feedback</th><th /></tr></thead>
              <tbody>{list.map(e => (
                <tr key={e.id}>
                  <td>{fmtDate(e.scheduled_date)}{e.end_date && e.end_date !== e.scheduled_date ? ` – ${fmtDate(e.end_date)}` : ''}</td>
                  <td>{e.title} {e.is_mandatory && <Pill tone="bad">Mandatory</Pill>}<div className="lnd-muted">{[e.category, e.trainer_name, `${fmtNum(e.duration_hours, 1)} h`].filter(Boolean).join(' · ')}</div></td>
                  <td>{e.venue || (e.online_link ? <a href={e.online_link} target="_blank" rel="noreferrer">Join online</a> : statusLabel(e.mode))}</td>
                  <td>{e.program_status === 'cancelled' ? <Pill status="cancelled" /> : <Pill status={e.status} />}</td>
                  <td><ReviewCell e={e} onOpen={(phase) => setDlg({ type: 'review', e, phase })} /></td>
                  <td className="num">{e.score != null ? `${Number(e.score)}%` : '—'}</td>
                  <td>{e.feedback_rating ? stars(e.feedback_rating) : (e.status === 'completed' || e.status === 'in_progress' || e.program_status === 'completed')
                    ? <button type="button" className="lnd-link" onClick={() => setDlg({ type: 'fb', e })}>Give feedback</button> : '—'}</td>
                  <td><div className="lnd-actions">
                    {e.certificate_url && <button type="button" className="lnd-link" onClick={() => openEmployeeFile(e.certificate_url)}>Certificate</button>}
                    {e.status === 'enrolled' && e.enrolled_via === 'self' && e.scheduled_date > t && <button type="button" className="lnd-link is-danger" onClick={() => setDlg({ type: 'withdraw', e })}>Withdraw</button>}
                  </div></td>
                </tr>
              ))}</tbody></table></div>
          ) : <Empty>{show === 'upcoming' ? 'Nothing upcoming. See Open trainings to join one.' : 'Nothing here yet.'}</Empty>}
        </div>)}

        {tab === 'open' && (<div className="lnd-card">
          {!d.settings.allow_self_enrollment && <div className="lnd-error">Self-enrolment is turned off — ask HR to enrol you.</div>}
          {d.available.length ? (
            <div className="lnd-table-wrap"><table className="lnd-table"><thead><tr><th>Date</th><th>Training</th><th>Mode</th><th className="num">Seats</th><th /></tr></thead>
              <tbody>{d.available.map(p => {
                const full = p.enrolled_count >= p.max_participants;
                return (
                  <tr key={p.id}><td>{fmtDate(p.scheduled_date)}</td>
                    <td>{p.title} {p.is_mandatory && <Pill tone="bad">Mandatory</Pill>}<div className="lnd-muted">{[p.category, p.trainer_name, `${fmtNum(p.duration_hours, 1)} h`].filter(Boolean).join(' · ')}</div>
                      {p.description && <div className="lnd-muted">{p.description}</div>}</td>
                    <td>{statusLabel(p.mode)}{p.venue ? ` · ${p.venue}` : ''}</td>
                    <td className="num">{p.max_participants - p.enrolled_count} left</td>
                    <td>{d.settings.allow_self_enrollment && <button type="button" className="pulse-btn-primary lnd-btn-sm" disabled={full}
                      onClick={() => act(() => api.post(`/my-learning/enroll/${p.id}`), 'Enrolled')}>{full ? 'Full' : 'Enrol'}</button>}</td></tr>
                );
              })}</tbody></table></div>
          ) : <Empty>No open trainings for your department right now.</Empty>}
        </div>)}

        {tab === 'paths' && (d.paths.length ? (
          <div className="lnd-grid lnd-grid-2">{d.paths.map(p => (
            <div key={p.id} className="lnd-card" style={{ margin: 0 }}>
              <div className="lnd-card-title"><span>{p.name}</span>{p.status === 'completed' ? <Pill status="completed" /> : p.due_date && p.due_date.slice(0, 10) < t ? <Pill status="overdue" /> : <Pill status="in_progress" />}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><div className="lnd-bar" style={{ flex: 1 }}><span style={{ width: `${p.total_items ? Math.round(100 * p.completed_items / p.total_items) : 0}%` }} /></div>
                {p.completed_items}/{p.total_items}{p.due_date ? <span className="lnd-muted"> · due {fmtDate(p.due_date)}</span> : null}</div>
              {(p.items || []).map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderTop: '1px solid #f3f0ff' }}>
                  <span>{i + 1}. {it.title} {!it.is_mandatory && <span className="lnd-muted">(optional)</span>}<span className="lnd-muted"> · {fmtDate(it.scheduled_date)}</span></span>
                  <Pill status={it.status || 'not_done'} />
                </div>
              ))}
            </div>
          ))}</div>
        ) : <div className="lnd-card"><Empty>No learning paths assigned to you.</Empty></div>)}

        {tab === 'tests' && (<div className="lnd-card">
          {d.assessments.length ? (
            <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Test</th><th>For training</th><th className="num">Questions</th><th>Time</th><th className="num">Attempts</th><th>Result</th><th /></tr></thead>
              <tbody>{d.assessments.map(a => (
                <tr key={a.id}><td>{a.title}{a.description && <div className="lnd-muted">{a.description}</div>}</td><td>{a.program_title || '—'}</td><td className="num">{a.question_count}</td>
                  <td>{a.time_limit_mins ? `${a.time_limit_mins} min` : 'No limit'}</td><td className="num">{a.attempts_used} / {a.max_attempts}</td>
                  <td>{a.passed ? <Pill status="passed">Passed</Pill> : a.attempts_used ? <Pill tone="warn">Not yet</Pill> : '—'}</td>
                  <td>{awaiting.has(a.id) ? <Pill status="pending_review" /> : !a.passed && a.attempts_used < a.max_attempts && <button type="button" className="pulse-btn-primary lnd-btn-sm" onClick={() => setDlg({ type: 'test', id: a.id })}>{a.attempts_used ? 'Try again' : 'Start'}</button>}</td></tr>
              ))}</tbody></table>
          ) : <Empty>No tests for you right now.</Empty>}
          {d.attempts.length > 0 && (<>
            <h4 className="lnd-card-title" style={{ marginTop: 16 }}><span>History</span></h4>
            <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Submitted</th><th>Test</th><th className="num">Attempt</th><th className="num">Score</th><th>Result</th></tr></thead>
              <tbody>{d.attempts.map(x => (
                <tr key={x.id}><td>{fmtDate(x.submitted_at)}</td><td>{x.assessment_title}</td><td className="num">#{x.attempt_number}</td><td className="num">{x.review_status === 'pending_review' ? '—' : `${fmtNum(x.score_pct)}%`}</td>
                  <td>{x.review_status === 'pending_review' ? <Pill status="pending_review" /> : x.passed ? <Pill status="passed">Passed</Pill> : <Pill status="failed">{x.time_exceeded ? 'Late' : 'Not passed'}</Pill>}</td></tr>
              ))}</tbody></table>
          </>)}
        </div>)}

        {tab === 'mandatory' && (<div className="lnd-card">
          {d.mandatory.length ? (
            <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Training</th><th>Repeats</th><th>Last done</th><th>Valid until</th><th>Next booked</th><th>Status</th></tr></thead>
              <tbody>{d.mandatory.map(m => (
                <tr key={m.series_id}><td>{m.title}</td><td>{m.refresher_months ? `every ${m.refresher_months} months` : 'once'}</td><td>{fmtDate(m.last_completed)}</td>
                  <td>{fmtDate(m.valid_until)}</td><td>{fmtDate(m.next_scheduled)}</td><td><Pill status={m.status} /></td></tr>
              ))}</tbody></table>
          ) : <Empty>No mandatory training applies to you.</Empty>}
        </div>)}

        {tab === 'certs' && (<div className="lnd-card">
          {d.certifications.length ? (
            <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Certificate</th><th>Number</th><th>Issued</th><th>Expires</th><th>Status</th><th /></tr></thead>
              <tbody>{d.certifications.map(c => (
                <tr key={c.id}><td>{c.name}<div className="lnd-muted">{c.issuing_body}</div></td><td>{c.certificate_number || '—'}</td><td>{fmtDate(c.issue_date)}</td>
                  <td>{c.expiry_date ? fmtDate(c.expiry_date) : 'Never'}{c.status === 'active' && c.days_left != null && c.days_left <= 60 && <div className="lnd-muted">{c.days_left} days left</div>}</td>
                  <td><Pill status={c.status} /></td><td>{c.certificate_url && <button type="button" className="lnd-link" onClick={() => openEmployeeFile(c.certificate_url)}>View</button>}</td></tr>
              ))}</tbody></table>
          ) : <Empty>No certificates recorded. HR records them — send yours to HR.</Empty>}
        </div>)}

        {tab === 'skills' && (<div className="lnd-card">
          {d.skills.length ? (
            <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Skill</th><th>Your level</th><th>Your role needs</th><th>From</th></tr></thead>
              <tbody>{d.skills.map(s => (
                <tr key={s.competency_id}><td>{s.name}<div className="lnd-muted">{s.category}</div></td>
                  <td><Level level={s.assessed_level} gap={s.assessed_level ? s.assessed_level < s.required_level : true} /></td>
                  <td>L{s.required_level}</td><td>{s.source ? `${statusLabel(s.source)} · ${fmtDate(s.assessed_date)}` : 'Not rated yet'}</td></tr>
              ))}</tbody></table>
          ) : <Empty>No skills rated or required for your role yet.</Empty>}
        </div>)}
      </div>
      {dlg?.type === 'fb' && <FeedbackDialog enrollment={dlg.e} settings={d.settings} onClose={() => setDlg(null)} onDone={() => { setDlg(null); toast.success('Thank you for your feedback'); load(); }} />}
      {dlg?.type === 'review' && <SelfReviewDialog enrollment={dlg.e} phase={dlg.phase} onClose={() => setDlg(null)} onDone={(m) => { setDlg(null); toast.success(m); load(); }} />}
      {dlg?.type === 'test' && <TakeTest assessmentId={dlg.id} onClose={() => { setDlg(null); load(); }} onDone={() => { setDlg(null); load(); }} />}
      <ConfirmDialog open={dlg?.type === 'withdraw'} title="Withdraw" message={`Withdraw from ${dlg?.e?.title}?`} confirmLabel="Withdraw" variant="warning"
        onConfirm={() => { const e = dlg.e; setDlg(null); act(() => api.post(`/my-learning/enrollments/${e.id}/withdraw`), 'Withdrawn'); }} onCancel={() => setDlg(null)} />
    </PageShell>
  );
}
