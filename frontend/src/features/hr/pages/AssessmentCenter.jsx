// frontend/src/features/hr/pages/AssessmentCenter.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const inputStyle = { width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 };

function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>

      <ConfirmDialog
        open={!!pendingArchiveAssessment}
        title="Archive Assessment"
        message="Archive this assessment?"
        confirmLabel="Archive"
        variant="warning"
        onConfirm={archiveAssessment}
        onCancel={() => setPendingArchiveAssessment(null)}
      />
      <div style={{ background:'#fff', borderRadius:12, padding:24, width:'100%', maxWidth: wide ? 820 : 560, maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <h3 style={{ margin:0, color:'#4c1d95', fontSize:16 }}>{title}</h3>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:20, color:'#6b7280' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function AssessmentCenter() {
  const { user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('list');
  const [assessments, setAssessments] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [selectedAssessment, setSelectedAssessment] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [attempt, setAttempt] = useState(null);
  const [answers, setAnswers] = useState({});
  const [results, setResults] = useState([]);
  const [history, setHistory] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [showQForm, setShowQForm] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);
  const [timer, setTimer] = useState(null);
  const timerRef = useRef(null);
  const [form, setForm] = useState({ title:'', description:'', program_id:'', pass_score:70, max_attempts:3, time_limit_mins:'' });
  const [tempQuestions, setTempQuestions] = useState([]);
  const [pendingArchiveAssessment, setPendingArchiveAssessment] = useState(null);

  const load = useCallback(async () => {
    const [aRes, pRes] = await Promise.allSettled([
      api.get('/assessments'),
      api.get('/training/programs'),
    ]);
    if (aRes.status === 'fulfilled') setAssessments(aRes.value.data || []);
    if (pRes.status === 'fulfilled') setPrograms(pRes.value.data || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab === 'history' && user?.employee_id) {
      api.get(`/assessments/employee/${user.employee_id}/history`).then(r => setHistory(r.data || [])).catch(() => setHistory([]));
    }
  }, [tab, user]);

  // Countdown timer
  useEffect(() => {
    if (attempt && timer === null && selectedAssessment?.time_limit_mins) {
      setTimer(selectedAssessment.time_limit_mins * 60);
    }
  }, [attempt, selectedAssessment]);

  useEffect(() => {
    if (timer === null) return;
    if (timer <= 0) { submitAttempt(); return; }
    timerRef.current = setTimeout(() => setTimer(t => t - 1), 1000);
    return () => clearTimeout(timerRef.current);
  }, [timer]);

  const saveAssessment = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/assessments', { ...form, program_id: form.program_id || undefined, time_limit_mins: form.time_limit_mins || undefined });
      toast.success('Assessment created');
      setShowForm(false);
      setForm({ title:'', description:'', program_id:'', pass_score:70, max_attempts:3, time_limit_mins:'' });
      load();
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
    finally { setLoading(false); }
  };

  const openQEditor = async (assessment) => {
    setSelectedAssessment(assessment);
    try {
      const r = await api.get(`/assessments/${assessment.id}/questions`);
      setTempQuestions(r.data || []);
    } catch { setTempQuestions([]); }
    setShowQForm(true);
  };

  const addQuestion = () => setTempQuestions(q => [...q, { question_text:'', question_type:'mcq', options:['Option A','Option B','Option C','Option D'], correct_answer:'', marks:1 }]);

  const saveQuestions = async () => {
    setLoading(true);
    try {
      await api.put(`/assessments/${selectedAssessment.id}/questions`, { questions: tempQuestions });
      toast.success('Questions saved');
      setShowQForm(false);
      load();
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
    finally { setLoading(false); }
  };

  const startAttempt = async (assessment) => {
    setSelectedAssessment(assessment);
    setLoading(true);
    try {
      const r = await api.post(`/assessments/${assessment.id}/start`, { employee_id: user?.employee_id });
      setAttempt(r.data.attempt);
      setQuestions(r.data.questions);
      setAnswers({});
      setTimer(r.data.time_limit_mins ? r.data.time_limit_mins * 60 : null);
      setTab('take');
    } catch (err) { toast.error(err?.response?.data?.error || 'Max attempts reached or assessment unavailable'); }
    finally { setLoading(false); }
  };

  const submitAttempt = async () => {
    if (!attempt) return;
    clearTimeout(timerRef.current);
    setLoading(true);
    try {
      const r = await api.post(`/assessments/attempts/${attempt.id}/submit`, { answers });
      toast.success(r.data.feedback || 'Submitted');
      setAttempt(null); setTimer(null);
      setTab('history');
    } catch (err) { toast.error(err?.response?.data?.error || 'Submit failed'); }
    finally { setLoading(false); }
  };

  const openResults = async (assessment) => {
    setSelectedAssessment(assessment);
    try {
      const r = await api.get(`/assessments/${assessment.id}/results`);
      setResults(r.data || []);
    } catch { setResults([]); }
    setShowResults(true);
  };

  const archiveAssessment = async () => {
    if (!pendingArchiveAssessment) return;
    const id = pendingArchiveAssessment;
    setPendingArchiveAssessment(null);
    try { await api.delete(`/assessments/${id}`); toast.success('Archived'); load(); }
    catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
  };

  const tabStyle = (k) => ({ padding:'8px 18px', border:'none', cursor:'pointer', borderRadius:'6px 6px 0 0', fontWeight:600, fontSize:14, background: tab===k ? '#6B3FDB' : '#e9e4ff', color: tab===k ? '#fff' : '#6B3FDB' });
  const fmtTime = (s) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

  return (
    <div style={{ padding:24, background:'#f5f3ff', minHeight:'100vh' }}>
      <div style={{ marginBottom:16 }}>
        <h2 style={{ margin:0, color:'#4c1d95', fontSize:22 }}>📝 Assessment Center</h2>
        <p style={{ margin:0, color:'#6b7280', fontSize:13 }}>Build quizzes, administer tests, and track results</p>
      </div>

      <div style={{ display:'flex', gap:4, borderBottom:'2px solid #e9e4ff', flexWrap:'wrap' }}>
        {[['list','Assessments'],['take','Take Assessment'],['history','My History']].map(([k,l]) => (
          <button key={k} style={tabStyle(k)} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderTop:'none', borderRadius:'0 8px 8px 8px', padding:20 }}>

        {/* ── LIST TAB ── */}
        {tab === 'list' && (
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h3 style={{ margin:0, color:'#4c1d95' }}>All Assessments</h3>
              <button onClick={() => setShowForm(true)} style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'8px 18px', cursor:'pointer', fontWeight:600 }}>+ Create Assessment</button>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {assessments.map(a => (
                <div key={a.id} style={{ background:'#f5f3ff', border:'1px solid #e9e4ff', borderRadius:10, padding:16, display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:10 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:700, color:'#1f2937', fontSize:14, marginBottom:4 }}>{a.title}</div>
                    {a.program_title && <div style={{ fontSize:12, color:'#6b7280', marginBottom:4 }}>Program: {a.program_title}</div>}
                    <div style={{ display:'flex', gap:16, fontSize:12, color:'#6b7280', flexWrap:'wrap' }}>
                      <span>Questions: <strong>{a.question_count || 0}</strong></span>
                      <span>Pass: <strong>{a.pass_score}%</strong></span>
                      <span>Max Attempts: <strong>{a.max_attempts}</strong></span>
                      <span>Avg Score: <strong>{a.avg_score || '—'}%</strong></span>
                      <span>Takers: <strong>{a.attempt_count || 0}</strong></span>
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                    <button onClick={() => openQEditor(a)} style={{ padding:'5px 12px', background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Edit Questions</button>
                    <button onClick={() => startAttempt(a)} style={{ padding:'5px 12px', background:'#dcfce7', color:'#16a34a', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Take</button>
                    <button onClick={() => openResults(a)} style={{ padding:'5px 12px', background:'#fef3c7', color:'#d97706', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Results</button>
                    <button onClick={() => setPendingArchiveAssessment(a.id)} style={{ padding:'5px 12px', background:'#fef2f2', color:'#dc2626', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Archive</button>
                  </div>
                </div>
              ))}
              {assessments.length === 0 && <p style={{ textAlign:'center', color:'#9ca3af', padding:'32px 0' }}>No assessments yet. Create one to start testing your team.</p>}
            </div>
          </div>
        )}

        {/* ── TAKE ASSESSMENT TAB ── */}
        {tab === 'take' && attempt && (
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h3 style={{ margin:0, color:'#4c1d95' }}>{selectedAssessment?.title}</h3>
              {timer !== null && (
                <div style={{ background: timer < 60 ? '#fef2f2' : '#f5f3ff', border:`1px solid ${timer < 60 ? '#fecaca' : '#e9e4ff'}`, borderRadius:8, padding:'6px 16px', fontWeight:800, fontSize:18, color: timer < 60 ? '#dc2626' : '#6B3FDB' }}>
                  ⏱ {fmtTime(timer)}
                </div>
              )}
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
              {questions.map((q, qi) => (
                <div key={q.id} style={{ background:'#f5f3ff', borderRadius:10, padding:16, border:'1px solid #e9e4ff' }}>
                  <p style={{ fontWeight:700, color:'#1f2937', margin:'0 0 12px', fontSize:14 }}>
                    Q{qi+1}. {q.question_text} <span style={{ fontWeight:400, color:'#9ca3af', fontSize:12 }}>({q.marks} mark{q.marks!==1?'s':''})</span>
                  </p>
                  {(q.question_type === 'mcq' || q.question_type === 'true_false') && (
                    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                      {(q.question_type === 'true_false' ? ['True','False'] : (q.options || [])).map(opt => (
                        <label key={opt} style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer', fontSize:13, padding:'8px 12px', borderRadius:7, background: answers[q.id]===opt ? '#ede9fe' : '#fff', border:`1px solid ${answers[q.id]===opt ? '#6B3FDB' : '#e9e4ff'}` }}>
                          <input type="radio" name={`q_${q.id}`} value={opt} checked={answers[q.id]===opt} onChange={() => setAnswers(a => ({...a, [q.id]:opt}))} />
                          {opt}
                        </label>
                      ))}
                    </div>
                  )}
                  {q.question_type === 'short_answer' && (
                    <textarea value={answers[q.id]||''} onChange={e => setAnswers(a => ({...a, [q.id]:e.target.value}))}
                      style={{...inputStyle, height:80, resize:'vertical'}} placeholder="Your answer…" />
                  )}
                </div>
              ))}
            </div>
            <div style={{ display:'flex', gap:10, marginTop:24 }}>
              <button onClick={submitAttempt} disabled={loading} style={{ flex:1, maxWidth:240, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'10px 0', cursor:'pointer', fontWeight:700, fontSize:15 }}>
                {loading ? 'Submitting…' : 'Submit Assessment'}
              </button>
              <button onClick={() => { clearTimeout(timerRef.current); setAttempt(null); setTab('list'); }} style={{ background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'10px 20px', cursor:'pointer', fontWeight:600 }}>Cancel</button>
            </div>
          </div>
        )}
        {tab === 'take' && !attempt && (
          <p style={{ color:'#9ca3af', textAlign:'center', padding:'48px 0' }}>Select an assessment from the list tab and click "Take" to begin.</p>
        )}

        {/* ── HISTORY TAB ── */}
        {tab === 'history' && (
          <div>
            <h3 style={{ margin:'0 0 16px', color:'#4c1d95' }}>My Assessment History</h3>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead><tr style={{ background:'#f5f3ff' }}>
                {['Assessment','Program','Date','Score','Passed','Attempt'].map(h => (
                  <th key={h} style={{ padding:'8px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600 }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id} style={{ borderBottom:'1px solid #f0ebff' }}>
                    <td style={{ padding:'8px 12px', fontWeight:600 }}>{h.assessment_title}</td>
                    <td style={{ padding:'8px 12px', color:'#6b7280' }}>{h.program_title || '—'}</td>
                    <td style={{ padding:'8px 12px' }}>{h.submitted_at ? new Date(h.submitted_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td style={{ padding:'8px 12px', fontWeight:700, color: h.score_pct >= h.pass_score ? '#16a34a' : '#dc2626' }}>{h.score_pct}%</td>
                    <td style={{ padding:'8px 12px' }}>
                      <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:600, background: h.passed ? '#dcfce7' : '#fef2f2', color: h.passed ? '#16a34a' : '#dc2626' }}>
                        {h.passed ? 'PASS' : 'FAIL'}
                      </span>
                    </td>
                    <td style={{ padding:'8px 12px', color:'#6b7280' }}>#{h.attempt_number}</td>
                  </tr>
                ))}
                {history.length === 0 && <tr><td colSpan={6} style={{ padding:'32px 16px', textAlign:'center', color:'#9ca3af' }}>No assessment history yet</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create assessment modal */}
      {showForm && (
        <Modal title="Create Assessment" onClose={() => setShowForm(false)}>
          <form onSubmit={saveAssessment}>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Title *</label>
              <input required value={form.title} onChange={e => setForm(f => ({...f, title:e.target.value}))} style={inputStyle} />
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Linked Program (optional)</label>
              <select value={form.program_id} onChange={e => setForm(f => ({...f, program_id:e.target.value}))} style={inputStyle}>
                <option value="">None</option>
                {programs.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:12 }}>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Pass Score %</label>
                <input type="number" value={form.pass_score} onChange={e => setForm(f => ({...f, pass_score:parseInt(e.target.value)||70}))} style={inputStyle} min={0} max={100} />
              </div>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Max Attempts</label>
                <input type="number" value={form.max_attempts} onChange={e => setForm(f => ({...f, max_attempts:parseInt(e.target.value)||3}))} style={inputStyle} min={1} />
              </div>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Time Limit (min)</label>
                <input type="number" value={form.time_limit_mins} onChange={e => setForm(f => ({...f, time_limit_mins:e.target.value}))} style={inputStyle} placeholder="No limit" />
              </div>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Description</label>
              <textarea value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} style={{...inputStyle, height:60, resize:'vertical'}} />
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button type="submit" disabled={loading} style={{ flex:1, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>{loading ? 'Creating…' : 'Create'}</button>
              <button type="button" onClick={() => setShowForm(false)} style={{ flex:1, background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Question editor modal */}
      {showQForm && selectedAssessment && (
        <Modal title={`Questions: ${selectedAssessment.title}`} wide onClose={() => setShowQForm(false)}>
          <div style={{ display:'flex', flexDirection:'column', gap:16, marginBottom:16 }}>
            {tempQuestions.map((q, qi) => (
              <div key={qi} style={{ background:'#f5f3ff', borderRadius:10, padding:16, border:'1px solid #e9e4ff' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                  <span style={{ fontWeight:700, color:'#6B3FDB', fontSize:13 }}>Q{qi+1}</span>
                  <button onClick={() => setTempQuestions(qs => qs.filter((_,i) => i!==qi))} style={{ background:'none', border:'none', cursor:'pointer', color:'#dc2626', fontSize:16 }}>✕</button>
                </div>
                <input value={q.question_text} onChange={e => setTempQuestions(qs => qs.map((x,i) => i===qi ? {...x, question_text:e.target.value} : x))}
                  style={{...inputStyle, marginBottom:8}} placeholder="Question text" />
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:8 }}>
                  <div>
                    <label style={{ fontSize:11, color:'#6b7280', display:'block', marginBottom:3 }}>Type</label>
                    <select value={q.question_type} onChange={e => setTempQuestions(qs => qs.map((x,i) => i===qi ? {...x, question_type:e.target.value} : x))} style={inputStyle}>
                      <option value="mcq">Multiple Choice</option>
                      <option value="true_false">True / False</option>
                      <option value="short_answer">Short Answer</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize:11, color:'#6b7280', display:'block', marginBottom:3 }}>Correct Answer</label>
                    <input value={q.correct_answer} onChange={e => setTempQuestions(qs => qs.map((x,i) => i===qi ? {...x, correct_answer:e.target.value} : x))} style={inputStyle} placeholder="Exact answer / option" />
                  </div>
                  <div>
                    <label style={{ fontSize:11, color:'#6b7280', display:'block', marginBottom:3 }}>Marks</label>
                    <input type="number" value={q.marks} onChange={e => setTempQuestions(qs => qs.map((x,i) => i===qi ? {...x, marks:parseInt(e.target.value)||1} : x))} style={inputStyle} min={1} />
                  </div>
                </div>
                {q.question_type === 'mcq' && (
                  <div>
                    <label style={{ fontSize:11, color:'#6b7280', display:'block', marginBottom:3 }}>Options (one per line)</label>
                    <textarea value={(q.options||[]).join('\n')} onChange={e => setTempQuestions(qs => qs.map((x,i) => i===qi ? {...x, options:e.target.value.split('\n')} : x))} style={{...inputStyle, height:72, resize:'vertical'}} />
                  </div>
                )}
              </div>
            ))}
            <button onClick={addQuestion} style={{ background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'10px 0', cursor:'pointer', fontWeight:600 }}>+ Add Question</button>
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={saveQuestions} disabled={loading} style={{ flex:1, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>{loading ? 'Saving…' : 'Save Questions'}</button>
            <button onClick={() => setShowQForm(false)} style={{ flex:1, background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* Results modal */}
      {showResults && selectedAssessment && (
        <Modal title={`Results: ${selectedAssessment.title}`} wide onClose={() => setShowResults(false)}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead><tr style={{ background:'#f5f3ff' }}>
              {['Employee','Department','Date','Score','Passed','Attempt'].map(h => (
                <th key={h} style={{ padding:'8px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600 }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {results.map(r => (
                <tr key={r.id} style={{ borderBottom:'1px solid #f0ebff' }}>
                  <td style={{ padding:'8px 12px', fontWeight:600 }}>{r.employee_name}</td>
                  <td style={{ padding:'8px 12px', color:'#6b7280' }}>{r.department}</td>
                  <td style={{ padding:'8px 12px' }}>{r.submitted_at ? new Date(r.submitted_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                  <td style={{ padding:'8px 12px', fontWeight:700, color: r.passed ? '#16a34a' : '#dc2626' }}>{r.score_pct}%</td>
                  <td style={{ padding:'8px 12px' }}>
                    <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:600, background: r.passed ? '#dcfce7' : '#fef2f2', color: r.passed ? '#16a34a' : '#dc2626' }}>
                      {r.passed ? 'PASS' : 'FAIL'}
                    </span>
                  </td>
                  <td style={{ padding:'8px 12px', color:'#6b7280' }}>#{r.attempt_number}</td>
                </tr>
              ))}
              {results.length === 0 && <tr><td colSpan={6} style={{ padding:'32px 16px', textAlign:'center', color:'#9ca3af' }}>No results yet</td></tr>}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
