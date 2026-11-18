// frontend/src/features/hr/pages/AssessmentCenter.jsx
// Assessments — the HR builder (2026-11-18). Tests, questions with answers,
// results, and marking of written answers. Employees take tests in Self
// Service → My Learning, which never receives the answers.
import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { Filters, Pill, Empty, Tabs, LndDialog, useLndOptions, fmtDate, fmtNum, toQuery, errText, downloadCsv, PERIODS } from '@/features/hr/learning/lndUi';

const DEFAULT = { status: 'active', category: '', q: '', program_id: '' };

function TestForm({ test, onClose, onSaved }) {
  const o = useLndOptions();
  const [programs, setPrograms] = useState([]);
  const [f, setF] = useState({ title: test?.title || '', description: test?.description || '', program_id: test?.program_id || '',
    pass_score: test?.pass_score ?? (o.settings?.default_pass_score || 70), max_attempts: test?.max_attempts ?? (o.settings?.default_max_attempts || 3),
    time_limit_mins: test?.time_limit_mins ?? '', is_active: test?.is_active ?? true });
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/training/programs').then(r => setPrograms(r.data)).catch(() => {}); }, []);
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    try { const r = test ? await api.put(`/assessments/${test.id}`, f) : await api.post('/assessments', f); onSaved(r.data); }
    catch (x) { setErr(errText(x)); }
  };
  return (
    <LndDialog title={test ? 'Test settings' : 'New test'} onClose={onClose} width={600} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="submit" form="lnd-test" className="pulse-btn-primary">Save</button></>}>
      <form id="lnd-test" className="lnd-form" onSubmit={save}>
        <label className="full">Title *<input required value={f.title} onChange={set('title')} /></label>
        <label className="full">For training<select value={f.program_id || ''} onChange={set('program_id')}><option value="">Stand-alone (open to everyone)</option>
          {programs.map(p => <option key={p.id} value={p.id}>{p.title} — {fmtDate(p.scheduled_date)}</option>)}</select>
          <span className="hint">Linked: only that training's participants see it, and passing completes their training.</span></label>
        <label>Pass mark %<input type="number" min="1" max="100" value={f.pass_score} onChange={set('pass_score')} /></label>
        <label>Attempts allowed<input type="number" min="1" max="20" value={f.max_attempts} onChange={set('max_attempts')} /></label>
        <label>Time limit (minutes)<input type="number" min="1" max="600" value={f.time_limit_mins} onChange={set('time_limit_mins')} placeholder="No limit" />
          <span className="hint">Checked by the server — a late submission does not pass.</span></label>
        {test && <label className="lnd-inline"><input type="checkbox" checked={f.is_active} onChange={set('is_active')} /> Active</label>}
        <label className="full">Instructions<textarea value={f.description} onChange={set('description')} /></label>
      </form>
    </LndDialog>
  );
}

function QuestionsEditor({ test, onClose, onSaved }) {
  const toast = useToast();
  const [qs, setQs] = useState(null);
  const [err, setErr] = useState('');
  const [confirmChange, setConfirmChange] = useState(false);
  useEffect(() => { api.get(`/assessments/${test.id}/questions`).then(r => setQs(r.data.map(q => ({ ...q, options: Array.isArray(q.options) ? q.options : [] })))).catch(e => setErr(errText(e))); }, [test.id]);
  const up = (i, patch) => setQs(l => l.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const add = (type) => setQs(l => [...l, { question_text: '', question_type: type, options: type === 'mcq' ? ['', ''] : [], correct_answer: type === 'true_false' ? 'True' : '', marks: 1 }]);
  const save = async () => {
    setErr('');
    try { await api.put(`/assessments/${test.id}/questions`, { questions: qs, confirm_change: confirmChange }); toast.success('Questions saved'); onSaved(); }
    catch (e) { if (e?.response?.status === 409) setConfirmChange(true); setErr(errText(e)); }
  };
  const total = (qs || []).reduce((s, q) => s + (Number(q.marks) || 0), 0);
  return (
    <LndDialog title={`Questions — ${test.title}`} onClose={onClose} width={860} error={err}
      footer={<><span className="lnd-muted" style={{ marginRight: 'auto' }}>{qs?.length || 0} questions · {total} marks</span>
        <button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="pulse-btn-primary" disabled={!qs} onClick={save}>{confirmChange ? 'Save anyway' : 'Save'}</button></>}>
      {!qs ? <Empty>Loading…</Empty> : (<>
        {qs.map((q, i) => (
          <div key={i} className="lnd-form" style={{ border: '1px solid #e9e4ff', borderRadius: 10, padding: 12, marginBottom: 10 }}>
            <label className="full">Q{i + 1}<textarea value={q.question_text} onChange={e => up(i, { question_text: e.target.value })} style={{ minHeight: 44 }} /></label>
            <label>Type<select value={q.question_type} onChange={e => up(i, { question_type: e.target.value, options: e.target.value === 'mcq' ? (q.options?.length ? q.options : ['', '']) : [], correct_answer: e.target.value === 'true_false' ? 'True' : '' })}>
              <option value="mcq">Multiple choice</option><option value="true_false">True / False</option><option value="short_answer">Written answer (marked by HR)</option></select></label>
            <label>Marks<input type="number" min="1" max="100" value={q.marks} onChange={e => up(i, { marks: e.target.value })} /></label>
            {q.question_type === 'mcq' && (
              <div className="full">
                {q.options.map((opt, k) => (
                  <label key={k} className="lnd-inline" style={{ marginBottom: 6 }}>
                    <input type="radio" name={`ans-${i}`} checked={!!opt && q.correct_answer === opt} onChange={() => up(i, { correct_answer: opt })} title="Correct answer" />
                    <input value={opt} placeholder={`Option ${k + 1}`} style={{ flex: 1 }} onChange={e => {
                      const v = e.target.value; const opts = q.options.map((x, j) => (j === k ? v : x));
                      up(i, { options: opts, correct_answer: q.correct_answer === opt ? v : q.correct_answer });
                    }} />
                    {q.options.length > 2 && <button type="button" className="lnd-link is-danger" onClick={() => up(i, { options: q.options.filter((_, j) => j !== k), correct_answer: q.correct_answer === opt ? '' : q.correct_answer })}>×</button>}
                  </label>
                ))}
                <button type="button" className="lnd-link" onClick={() => up(i, { options: [...q.options, ''] })}>+ option</button>
                <span className="hint" style={{ marginLeft: 10 }}>Pick the correct one with the radio button.</span>
              </div>
            )}
            {q.question_type === 'true_false' && (
              <label>Correct answer<select value={q.correct_answer} onChange={e => up(i, { correct_answer: e.target.value })}><option>True</option><option>False</option></select></label>
            )}
            {q.question_type === 'short_answer' && (
              <label className="full">Model answer (for the marker)<input value={q.correct_answer || ''} onChange={e => up(i, { correct_answer: e.target.value })} /></label>
            )}
            <div className="full lnd-actions">
              <button type="button" className="lnd-link" disabled={!i} onClick={() => setQs(l => { const n = [...l]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}>↑ Move up</button>
              <button type="button" className="lnd-link is-danger" onClick={() => setQs(l => l.filter((_, j) => j !== i))}>Remove question</button>
            </div>
          </div>
        ))}
        <div className="lnd-actions">
          <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => add('mcq')}>+ Multiple choice</button>
          <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => add('true_false')}>+ True / False</button>
          <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => add('short_answer')}>+ Written answer</button>
        </div>
      </>)}
    </LndDialog>
  );
}

function ReviewDialog({ attemptId, onClose, onDone }) {
  const toast = useToast();
  const [a, setA] = useState(null);
  const [marks, setMarks] = useState({});
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`/assessments/attempts/${attemptId}`).then(r => setA(r.data)).catch(e => setErr(errText(e))); }, [attemptId]);
  const pending = a?.questions.filter(q => q.question_type === 'short_answer' && a.question_marks?.[q.id] === null) || [];
  const save = async () => {
    try { const r = await api.post(`/assessments/attempts/${attemptId}/review`, { marks }); toast.success(`Marked — ${Number(r.data.score_pct)}% ${r.data.passed ? '(passed)' : '(not passed)'}`); onDone(); }
    catch (e) { setErr(errText(e)); }
  };
  return (
    <LndDialog title={a ? `${a.employee_name} — ${a.assessment_title}` : 'Attempt'} onClose={onClose} width={760} error={err}
      footer={a?.review_status === 'pending_review' ? <><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="pulse-btn-primary" disabled={pending.some(q => marks[q.id] === undefined || marks[q.id] === '')} onClick={save}>Save marks</button></> : null}>
      {!a ? <Empty>Loading…</Empty> : a.questions.map((q, i) => {
        const given = a.answers?.[q.id];
        const m = a.question_marks?.[q.id];
        return (
          <div key={q.id} style={{ borderBottom: '1px solid #f0ebff', padding: '10px 0', fontSize: 13 }}>
            <strong>Q{i + 1}. {q.question_text}</strong> <span className="lnd-muted">({q.marks} marks)</span>
            <div style={{ margin: '6px 0' }}>Answer: <em>{given ?? '— no answer —'}</em></div>
            {q.question_type !== 'short_answer'
              ? <div>Correct: {q.correct_answer} · <Pill tone={m ? 'good' : 'bad'}>{m ?? 0} / {q.marks}</Pill></div>
              : m === null && a.review_status === 'pending_review'
                ? <div className="lnd-form" style={{ maxWidth: 260 }}><label>Marks (0–{q.marks})<input type="number" min="0" max={q.marks} value={marks[q.id] ?? ''} onChange={e => setMarks(v => ({ ...v, [q.id]: e.target.value }))} />
                    {q.correct_answer && <span className="hint">Model answer: {q.correct_answer}</span>}</label></div>
                : <div><Pill tone="brand">{m ?? 0} / {q.marks}</Pill></div>}
          </div>
        );
      })}
    </LndDialog>
  );
}

function Results({ test, onReview }) {
  const o = useLndOptions();
  const [f, setF] = useState({ period: 'all', department: '', result: '' });
  const [rows, setRows] = useState(null);
  useEffect(() => { setRows(null); api.get(`/assessments/${test.id}/results${toQuery(f)}`).then(r => setRows(r.data)).catch(() => setRows([])); }, [test.id, f]);
  return (<>
    <div className="lnd-filters">
      <label>Period<select value={f.period} onChange={e => setF(v => ({ ...v, period: e.target.value }))}>{PERIODS.filter(p => !['upcoming', 'next3m', 'next6m', 'custom'].includes(p.value)).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
      <label>Department<select value={f.department} onChange={e => setF(v => ({ ...v, department: e.target.value }))}><option value="">All</option>{o.departments.map(d => <option key={d}>{d}</option>)}</select></label>
      <label>Result<select value={f.result} onChange={e => setF(v => ({ ...v, result: e.target.value }))}><option value="">All</option><option value="passed">Passed</option><option value="failed">Not passed</option><option value="pending">Awaiting review</option></select></label>
      {rows?.length > 0 && <button type="button" className="lnd-link" onClick={() => downloadCsv(rows, `test-${test.id}-results`)}>Export CSV</button>}
    </div>
    {!rows ? <Empty>Loading…</Empty> : rows.length ? (
      <div className="lnd-table-wrap"><table className="lnd-table"><thead><tr><th>Employee</th><th>Department</th><th>Submitted</th><th className="num">Attempt</th><th className="num">Score</th><th>Result</th><th /></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id}><td>{r.employee_name}<div className="lnd-muted">{r.office_id}</div></td><td>{r.department}</td><td>{fmtDate(r.submitted_at)}</td>
            <td className="num">#{r.attempt_number}</td><td className="num">{fmtNum(r.score_pct)}%</td>
            <td>{r.review_status === 'pending_review' ? <Pill status="pending_review" /> : <Pill status={r.passed ? 'passed' : 'failed'}>{r.passed ? 'Passed' : r.time_exceeded ? 'Late' : 'Not passed'}</Pill>}</td>
            <td><button type="button" className="lnd-link" onClick={() => onReview(r.id)}>{r.review_status === 'pending_review' ? 'Mark' : 'View'}</button></td></tr>
        ))}</tbody></table></div>
    ) : <Empty>No attempts yet.</Empty>}
  </>);
}

export default function AssessmentCenter() {
  const toast = useToast();
  const [f, setF] = useState(DEFAULT);
  const [tests, setTests] = useState(null);
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('list');
  const [dlg, setDlg] = useState(null);
  const [rk, setRk] = useState(0);
  const load = useCallback(() => api.get(`/assessments${toQuery(f)}`).then(r => setTests(r.data)).catch(e => { toast.error(errText(e)); setTests([]); }), [f]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const pending = (tests || []).reduce((s, t) => s + (t.pending_review || 0), 0);
  const archive = async () => {
    const id = dlg.id; setDlg(null);
    try { await api.delete(`/assessments/${id}`); toast.success('Archived'); load(); } catch (e) { toast.error(errText(e)); }
  };
  return (
    <PageShell dock={<PageHero icon={ClipboardCheck} eyebrow="Learning Center" title="Assessments" subtitle="Build tests, see results, mark written answers"
      actions={<button type="button" className="plh-cta" onClick={() => setDlg({ type: 'form' })}>+ New test</button>} />}>
      <div className="lnd">
        {sel ? (<>
          <button type="button" className="lnd-link lnd-back" onClick={() => { setSel(null); load(); }}>← All tests</button>
          <div className="lnd-card"><div className="lnd-card-title"><span>Results — {sel.title}</span><span className="lnd-muted">Pass {sel.pass_score}% · {sel.max_attempts} attempts</span></div>
            <Results key={rk} test={sel} onReview={(id) => setDlg({ type: 'review', id })} /></div>
        </>) : (<>
          <Tabs value={tab} onChange={setTab} tabs={[{ id: 'list', label: 'Tests' }, { id: 'review', label: 'Awaiting review', count: pending }]} />
          <Filters value={f} onChange={setF} fields={['category', 'q']} onReset={() => setF(DEFAULT)}
            extra={<label>Status<select value={f.status} onChange={e => setF(v => ({ ...v, status: e.target.value }))}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></label>} />
          {!tests ? <Empty>Loading…</Empty> : (tab === 'review' ? tests.filter(t => t.pending_review) : tests).length ? (
            <div className="lnd-table-wrap"><table className="lnd-table">
              <thead><tr><th>Test</th><th>Training</th><th className="num">Questions</th><th className="num">Pass</th><th className="num">Takers</th><th className="num">Passed</th><th className="num">Avg</th><th className="num">To mark</th><th /></tr></thead>
              <tbody>{(tab === 'review' ? tests.filter(t => t.pending_review) : tests).map(t => (
                <tr key={t.id}>
                  <td>{t.title} {!t.is_active && <Pill>Archived</Pill>}{t.time_limit_mins ? <div className="lnd-muted">{t.time_limit_mins} min</div> : null}</td>
                  <td>{t.program_title || <span className="lnd-muted">Stand-alone</span>}</td>
                  <td className="num">{t.question_count} <span className="lnd-muted">({t.total_marks} m)</span></td>
                  <td className="num">{t.pass_score}%</td><td className="num">{t.takers || 0}</td><td className="num">{t.passed_count || 0}</td>
                  <td className="num">{t.avg_score != null ? `${t.avg_score}%` : '—'}</td>
                  <td className="num">{t.pending_review ? <Pill status="pending_review">{t.pending_review}</Pill> : '—'}</td>
                  <td><div className="lnd-actions">
                    <button type="button" className="lnd-link" onClick={() => setDlg({ type: 'questions', test: t })}>Questions</button>
                    <button type="button" className="lnd-link" onClick={() => setSel(t)}>Results</button>
                    <button type="button" className="lnd-link" onClick={() => setDlg({ type: 'form', test: t })}>Settings</button>
                    {t.is_active && <button type="button" className="lnd-link is-danger" onClick={() => setDlg({ type: 'archive', id: t.id })}>Archive</button>}
                  </div></td>
                </tr>
              ))}</tbody></table></div>
          ) : <Empty>{tab === 'review' ? 'Nothing waiting to be marked.' : 'No tests yet.'}</Empty>}
          {tests?.some(t => !t.question_count && t.is_active) && <p className="lnd-muted">Tests without questions are hidden from employees until questions are added.</p>}
        </>)}
      </div>
      {dlg?.type === 'form' && <TestForm test={dlg.test} onClose={() => setDlg(null)} onSaved={(t) => { setDlg(dlg.test ? null : { type: 'questions', test: t }); toast.success('Saved'); load(); }} />}
      {dlg?.type === 'questions' && <QuestionsEditor test={dlg.test} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); load(); }} />}
      {dlg?.type === 'review' && <ReviewDialog attemptId={dlg.id} onClose={() => setDlg(null)} onDone={() => { setDlg(null); load(); setRk(k => k + 1); }} />}
      <ConfirmDialog open={dlg?.type === 'archive'} title="Archive test" message="Archive this test? Results stay." confirmLabel="Archive" variant="warning" onConfirm={archive} onCancel={() => setDlg(null)} />
    </PageShell>
  );
}
