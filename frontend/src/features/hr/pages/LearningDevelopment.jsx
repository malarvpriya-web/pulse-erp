// frontend/src/features/hr/pages/LearningDevelopment.jsx
// Trainings (2026-11-18) — page key kept so bookmarks and Page Access grants
// still resolve. Calendar + list with every filter, create / edit, and a full
// page per training: participants (enrol anyone, mark attended / no-show /
// completed with score), sessions with attendance, costs, repeat rounds
// (every 3 / 6 / 12 months), start / complete / cancel. The duplicate KPI row,
// skill-matrix tab and cost charts moved to the Dashboard and Skills pages.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GraduationCap } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { openEmployeeFile } from '@/features/employees/shared/employeeFiles';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  Filters, Pill, Empty, Tabs, LndDialog, EmployeePicker, useLndOptions, resetLndOptions,
  fmtDate, fmtINR, fmtNum, toQuery, errText, statusLabel, stars, downloadCsv, today,
} from '@/features/hr/learning/lndUi';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DEFAULT = { period: 'all', department: '', category: '', status: '', trainer_id: '', mode: '', mandatory: '', cost_min: '', cost_max: '', q: '' };
const BLANK = { title: '', description: '', category: '', mode: 'offline', scheduled_date: '', end_date: '', duration_hours: 8,
  max_participants: 30, cost_per_participant: 0, budget: '', trainer_id: '', venue: '', online_link: '', target_department: '',
  target_role: '', is_mandatory: false, refresher_months: '', competency_id: '', self_review_enabled: true, self_review_items: [] };

/* ── create / edit ─────────────────────────────────────────────── */
function ProgramForm({ initial, onClose, onSaved }) {
  const o = useLndOptions();
  const toast = useToast();
  const [f, setF] = useState(() => ({ ...BLANK, ...(initial || {}),
    scheduled_date: initial?.scheduled_date?.slice(0, 10) || '', end_date: initial?.end_date?.slice(0, 10) || '',
    refresher_months: initial?.refresher_months ?? '', trainer_id: initial?.trainer_id ?? '', competency_id: initial?.competency_id ?? '', budget: initial?.budget ?? '',
    self_review_enabled: initial?.self_review_enabled ?? true, self_review_items: Array.isArray(initial?.self_review_items) ? initial.self_review_items : [] }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    const body = { ...f, refresher_months: f.is_mandatory ? (f.refresher_months || null) : (f.refresher_months || null) };
    try {
      const r = initial?.id ? await api.put(`/training/programs/${initial.id}`, body) : await api.post('/training/programs', body);
      toast.success(initial?.id ? 'Training saved' : 'Training scheduled');
      onSaved(r.data);
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <LndDialog title={initial?.id ? 'Edit training' : 'Schedule training'} onClose={onClose} width={760} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" form="lnd-prog" className="pulse-btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <form id="lnd-prog" className="lnd-form" onSubmit={save}>
        <label className="full">Title *<input required value={f.title} onChange={set('title')} maxLength={255} /></label>
        <label>Category<select value={f.category || ''} onChange={set('category')}><option value="">—</option>{o.categories.map(c => <option key={c}>{c}</option>)}</select></label>
        <label>Mode<select value={f.mode} onChange={set('mode')}><option value="offline">Classroom</option><option value="online">Online</option><option value="hybrid">Hybrid</option></select></label>
        <label>Trainer<select value={f.trainer_id || ''} onChange={set('trainer_id')}><option value="">— not set —</option>{o.trainers.map(t => <option key={t.id} value={t.id}>{t.name} ({t.trainer_type})</option>)}</select>
          <span className="hint">Add trainers under L&D Setup → Trainers.</span></label>
        <label>Start date *<input type="date" required value={f.scheduled_date} onChange={set('scheduled_date')} /></label>
        <label>End date<input type="date" value={f.end_date || ''} min={f.scheduled_date} onChange={set('end_date')} /></label>
        <label>Duration (hours)<input type="number" min="0.5" step="0.5" value={f.duration_hours ?? ''} onChange={set('duration_hours')} /></label>
        <label>Seats<input type="number" min="1" value={f.max_participants ?? ''} onChange={set('max_participants')} /></label>
        <label>Cost per person (₹)<input type="number" min="0" value={f.cost_per_participant ?? ''} onChange={set('cost_per_participant')} /></label>
        <label>Budget (₹)<input type="number" min="0" value={f.budget ?? ''} onChange={set('budget')} /></label>
        <label>Venue<input value={f.venue || ''} onChange={set('venue')} /></label>
        <label>Online link<input value={f.online_link || ''} onChange={set('online_link')} placeholder="https://…" /></label>
        <label>For department<select value={f.target_department || ''} onChange={set('target_department')}><option value="">Everyone</option>{o.departments.map(d => <option key={d}>{d}</option>)}</select></label>
        <label>For designation<select value={f.target_role || ''} onChange={set('target_role')}><option value="">Everyone</option>{o.designations.map(d => <option key={d}>{d}</option>)}</select></label>
        <label>Builds skill<select value={f.competency_id || ''} onChange={set('competency_id')}><option value="">—</option>{o.competencies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <span className="hint">Completing raises this rating in Skills & Competencies.</span></label>
        <label className="lnd-inline full"><input type="checkbox" checked={!!f.is_mandatory} onChange={set('is_mandatory')} /> Mandatory — tracked in compliance</label>
        <label>Repeat every (months)<select value={f.refresher_months || ''} onChange={set('refresher_months')}>
          <option value="">{f.is_mandatory ? `Default (${o.settings?.default_refresher_months || 12})` : 'Does not repeat'}</option>
          {[3, 6, 12, 24, 36].map(m => <option key={m} value={m}>{m} months</option>)}</select>
          <span className="hint">Refresher due this long after someone completes it.</span></label>
        <label className="full">Description<textarea value={f.description || ''} onChange={set('description')} /></label>
        <label className="lnd-inline full"><input type="checkbox" checked={!!f.self_review_enabled} onChange={set('self_review_enabled')} />
          Before / after self-review — each participant rates their knowledge and confidence before the training and again after it</label>
        {f.self_review_enabled && (
          <div className="full">
            <span style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95' }}>Extra statements to rate (optional, up to 10)</span>
            {(f.self_review_items || []).map((it, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input value={it} maxLength={200} placeholder="e.g. I can use a CO2 extinguisher correctly"
                  onChange={e => setF(p => ({ ...p, self_review_items: p.self_review_items.map((x, j) => (j === i ? e.target.value : x)) }))} />
                <button type="button" className="lnd-link is-danger" onClick={() => setF(p => ({ ...p, self_review_items: p.self_review_items.filter((_, j) => j !== i) }))}>×</button>
              </div>
            ))}
            {(f.self_review_items || []).length < 10 && <button type="button" className="lnd-link" style={{ marginTop: 6 }} onClick={() => setF(p => ({ ...p, self_review_items: [...(p.self_review_items || []), ''] }))}>+ Add statement</button>}
            <span className="hint" style={{ display: 'block' }}>Knowledge and confidence are always asked. Statements are rated 1–5 before and after.</span>
          </div>
        )}
      </form>
    </LndDialog>
  );
}

/* ── calendar ──────────────────────────────────────────────────── */
function Calendar({ programs, month, setMonth, onOpen }) {
  const y = month.getFullYear(); const m = month.getMonth();
  const first = new Date(y, m, 1).getDay(); const days = new Date(y, m + 1, 0).getDate();
  const t = today();
  const byDay = {};
  for (const p of programs) {
    if (!p.scheduled_date) continue;
    const s = p.scheduled_date.slice(0, 10); const e = (p.end_date || p.scheduled_date).slice(0, 10);
    for (let d = 1; d <= days; d++) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (iso >= s && iso <= e) (byDay[d] = byDay[d] || []).push(p);
    }
  }
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return (
    <div className="lnd-card">
      <div className="lnd-card-title">
        <div className="lnd-actions">
          <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => setMonth(new Date(y, m - 1, 1))}>‹</button>
          <strong style={{ minWidth: 140, textAlign: 'center' }}>{MONTHS[m]} {y}</strong>
          <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => setMonth(new Date(y, m + 1, 1))}>›</button>
          <button type="button" className="lnd-link" onClick={() => setMonth(new Date())}>Today</button>
        </div>
        <span className="lnd-muted">Red edge = mandatory</span>
      </div>
      <div className="lnd-cal">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d} className="lnd-cal-head">{d}</div>)}
        {cells.map((d, i) => {
          const iso = d ? `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
          return (
            <div key={i} className={`lnd-cal-day${d ? '' : ' is-out'}${iso === t ? ' is-today' : ''}`}>
              {d && <div className="lnd-cal-num">{d}</div>}
              {(byDay[d] || []).slice(0, 4).map(p => (
                <button type="button" key={p.id} title={p.title} onClick={() => onOpen(p.id)}
                  className={`lnd-cal-ev${p.status === 'completed' ? ' is-done' : p.status === 'cancelled' ? ' is-cancel' : ''}${p.is_mandatory ? ' is-mand' : ''}`}>{p.title}</button>
              ))}
              {(byDay[d] || []).length > 4 && <div className="lnd-muted">+{byDay[d].length - 4} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── one training ──────────────────────────────────────────────── */
function ProgramDetail({ id, onBack, onChanged }) {
  const toast = useToast();
  const o = useLndOptions();
  const [p, setP] = useState(null);
  const [tab, setTab] = useState('people');
  const [err, setErr] = useState('');
  const [dlg, setDlg] = useState(null); // {type, ...}
  const [sel, setSel] = useState([]);
  const [pf, setPf] = useState({ status: '', q: '' });
  const load = useCallback(async () => {
    try { setP((await api.get(`/training/programs/${id}`)).data); setErr(''); }
    catch (e) { setErr(errText(e)); }
  }, [id]);
  useEffect(() => { load(); setSel([]); }, [load]);
  const act = async (fn, ok) => {
    try { await fn(); if (ok) toast.success(ok); await load(); onChanged?.(); }
    catch (e) { toast.error(errText(e)); }
  };
  if (err) return <div className="lnd"><button type="button" className="lnd-link lnd-back" onClick={onBack}>← All trainings</button><div className="lnd-error">{err}</div></div>;
  if (!p) return <div className="lnd"><Empty>Loading…</Empty></div>;

  const active = p.enrollments.filter(e => e.status !== 'withdrawn');
  const people = p.enrollments.filter(e => (!pf.status || e.status === pf.status)
    && (!pf.q || `${e.employee_name} ${e.office_id || ''} ${e.department || ''}`.toLowerCase().includes(pf.q.toLowerCase())));
  const closed = ['cancelled', 'completed'].includes(p.status);
  const totalCost = p.costs.reduce((s, c) => s + c.amount, 0);
  const bulk = (status, extra = {}) => act(() => api.post('/training/enrollments/bulk', { ids: sel, status, ...extra }), `${sel.length} updated`).then(() => setSel([]));

  return (
    <div className="lnd">
      <button type="button" className="lnd-link lnd-back" onClick={onBack}>← All trainings</button>
      <div className="lnd-card">
        <div className="lnd-card-title">
          <span style={{ fontSize: 18 }}>{p.title} <Pill status={p.status} /> {p.is_mandatory && <Pill tone="bad">Mandatory</Pill>}</span>
          <div className="lnd-actions">
            <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => setDlg({ type: 'edit' })}>Edit</button>
            {p.status === 'planned' && <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => act(() => api.post(`/training/programs/${p.id}/status`, { status: 'ongoing' }), 'Marked as running')}>Start</button>}
            {['planned', 'ongoing'].includes(p.status) && <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => act(() => api.post(`/training/programs/${p.id}/status`, { status: 'completed' }), 'Training closed')}>Close training</button>}
            {p.status === 'cancelled' && <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => act(() => api.post(`/training/programs/${p.id}/status`, { status: 'planned' }), 'Re-opened')}>Re-open</button>}
            <button type="button" className="pulse-btn-primary lnd-btn-sm" onClick={() => setDlg({ type: 'round' })}>Schedule next round</button>
            {p.status !== 'cancelled' && <button type="button" className="lnd-link is-danger" onClick={() => setDlg({ type: 'cancel' })}>Cancel training</button>}
          </div>
        </div>
        <div className="lnd-grid lnd-grid-3" style={{ fontSize: 13 }}>
          <div><span className="lnd-muted">Dates</span><br />{fmtDate(p.scheduled_date)}{p.end_date && p.end_date !== p.scheduled_date ? ` – ${fmtDate(p.end_date)}` : ''} · {fmtNum(p.duration_hours, 1)} h</div>
          <div><span className="lnd-muted">Trainer · mode</span><br />{p.trainer_name || '—'} · {statusLabel(p.mode)}{p.venue ? ` · ${p.venue}` : ''}</div>
          <div><span className="lnd-muted">Seats</span><br />{active.length} / {p.max_participants}</div>
          <div><span className="lnd-muted">For</span><br />{p.target_department || 'All departments'} · {p.target_role || 'all designations'}</div>
          <div><span className="lnd-muted">Repeats</span><br />{p.refresher_months ? `every ${p.refresher_months} months` : 'no'}{p.rounds.length > 1 ? ` · round ${p.rounds.findIndex(r => r.id === p.id) + 1} of ${p.rounds.length}` : ''}</div>
          <div><span className="lnd-muted">Cost</span><br />{fmtINR(totalCost)}{p.budget ? ` of ${fmtINR(p.budget)} budget` : ''}</div>
          {p.competency_name && <div><span className="lnd-muted">Builds skill</span><br />{p.competency_name}</div>}
          {p.assessments.length > 0 && <div><span className="lnd-muted">Test</span><br />{p.assessments.map(a => `${a.title} (pass ${a.pass_score}%)`).join(', ')}</div>}
          {p.cancel_reason && <div><span className="lnd-muted">Cancelled because</span><br />{p.cancel_reason}</div>}
        </div>
        {p.description && <p style={{ fontSize: 13, color: '#4b5563', marginBottom: 0 }}>{p.description}</p>}
      </div>

      <div className="lnd-card">
        <Tabs value={tab} onChange={setTab} tabs={[
          { id: 'people', label: 'Participants', count: active.length },
          { id: 'sessions', label: 'Sessions & attendance', count: p.sessions.length },
          { id: 'costs', label: 'Costs', count: p.costs.length },
          { id: 'review', label: 'Before / after review', count: p.self_review?.enabled ? p.self_review.summary.both_done : 0 },
          { id: 'rounds', label: 'Rounds', count: p.rounds.length > 1 ? p.rounds.length : 0 },
        ]} />

        {tab === 'review' && <SelfReviewTab data={p.self_review} title={p.title} id={p.id} />}

        {tab === 'people' && (<>
          <div className="lnd-actions" style={{ marginBottom: 10 }}>
            {!closed && <button type="button" className="pulse-btn-primary lnd-btn-sm" onClick={() => setDlg({ type: 'enrol' })}>+ Enrol employees</button>}
            <select value={pf.status} onChange={e => setPf(v => ({ ...v, status: e.target.value }))} style={{ padding: '5px 8px', borderRadius: 7, border: '1px solid #e9e4ff' }}>
              <option value="">All statuses</option>{['enrolled', 'in_progress', 'completed', 'no_show', 'withdrawn'].map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
            <input type="search" placeholder="Search" value={pf.q} onChange={e => setPf(v => ({ ...v, q: e.target.value }))} style={{ padding: '5px 8px', borderRadius: 7, border: '1px solid #e9e4ff' }} />
            {sel.length > 0 && (<>
              <span className="lnd-muted">{sel.length} selected:</span>
              <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => setDlg({ type: 'complete', ids: sel })}>Mark completed…</button>
              <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => bulk('in_progress')}>Attending</button>
              <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => bulk('no_show')}>No-show</button>
            </>)}
            <button type="button" className="lnd-link" style={{ marginLeft: 'auto' }} onClick={() => downloadCsv(people, `training-${p.id}-participants`, [
              { key: 'employee_name', label: 'Employee' }, { key: 'office_id', label: 'Code' }, { key: 'department', label: 'Department' },
              { key: 'status', label: 'Status' }, { key: 'score', label: 'Score' }, { key: 'completion_date', label: 'Completed' }, { key: 'feedback_rating', label: 'Feedback' }])}>Export CSV</button>
          </div>
          {people.length ? (
            <div className="lnd-table-wrap"><table className="lnd-table">
              <thead><tr><th><input type="checkbox" aria-label="Select all" checked={people.filter(e => e.status !== 'withdrawn' && e.status !== 'completed').every(e => sel.includes(e.id)) && sel.length > 0}
                onChange={e => setSel(e.target.checked ? people.filter(x => x.status !== 'withdrawn' && x.status !== 'completed').map(x => x.id) : [])} /></th>
                <th>Employee</th><th>Department</th><th>Status</th><th className="num">Attendance</th><th className="num">Score</th><th>Completed</th><th>Feedback</th><th /></tr></thead>
              <tbody>{people.map(e => (
                <tr key={e.id}>
                  <td>{!['withdrawn', 'completed'].includes(e.status) && <input type="checkbox" checked={sel.includes(e.id)} onChange={() => setSel(s => s.includes(e.id) ? s.filter(x => x !== e.id) : [...s, e.id])} />}</td>
                  <td>{e.employee_name}<div className="lnd-muted">{e.office_id} · {e.designation}</div></td>
                  <td>{e.department}</td>
                  <td><Pill status={e.status} />{e.enrolled_via !== 'hr' && <div className="lnd-muted">via {e.enrolled_via}</div>}</td>
                  <td className="num">{e.sessions_marked ? `${e.sessions_present}/${e.sessions_marked}` : '—'}</td>
                  <td className="num">{e.score != null ? `${Number(e.score)}%` : '—'}</td>
                  <td>{fmtDate(e.completion_date)}</td>
                  <td title={e.feedback_comments || ''}>{e.feedback_rating ? stars(e.feedback_rating) : '—'}</td>
                  <td><div className="lnd-actions">
                    {!['completed', 'withdrawn'].includes(e.status) && <button type="button" className="lnd-link" onClick={() => setDlg({ type: 'complete', ids: [e.id] })}>Complete</button>}
                    {e.status === 'withdrawn' && !closed && <button type="button" className="lnd-link" onClick={() => act(() => api.post(`/training/programs/${p.id}/enroll`, { employee_ids: [e.employee_id] }), 'Re-enrolled')}>Re-enrol</button>}
                    {e.status === 'completed' && (e.certificate_url
                      ? <button type="button" className="lnd-link" onClick={() => openEmployeeFile(e.certificate_url)}>Certificate</button>
                      : <label className="lnd-link" style={{ cursor: 'pointer' }}>Upload certificate<input type="file" hidden accept=".pdf,image/*" onChange={ev => {
                          const file = ev.target.files?.[0]; if (!file) return; const fd = new FormData(); fd.append('file', file);
                          act(() => api.post(`/training/enrollments/${e.id}/certificate`, fd), 'Certificate attached');
                        }} /></label>)}
                    {!['completed', 'withdrawn'].includes(e.status) && <button type="button" className="lnd-link is-danger" onClick={() => act(() => api.delete(`/training/enrollments/${e.id}`), 'Withdrawn')}>Withdraw</button>}
                  </div></td>
                </tr>
              ))}</tbody></table></div>
          ) : <Empty>No participants yet.</Empty>}
        </>)}

        {tab === 'sessions' && (<>
          <div className="lnd-actions" style={{ marginBottom: 10 }}><button type="button" className="pulse-btn-primary lnd-btn-sm" onClick={() => setDlg({ type: 'session' })}>+ Add session</button>
            <span className="lnd-muted">Use sessions for multi-day or multi-slot trainings; attendance per session shows on each participant.</span></div>
          {p.sessions.length ? (
            <table className="lnd-table"><thead><tr><th>Date</th><th>Time</th><th>Trainer</th><th>Venue / link</th><th>Status</th><th className="num">Present</th><th /></tr></thead>
              <tbody>{p.sessions.map(s => (
                <tr key={s.id}><td>{fmtDate(s.session_date)}</td><td>{s.start_time ? `${s.start_time.slice(0, 5)}–${(s.end_time || '').slice(0, 5)}` : '—'}</td>
                  <td>{s.trainer_name || '—'}</td><td>{s.venue || s.online_link || '—'}</td><td><Pill status={s.status} /></td>
                  <td className="num">{s.present_count} / {active.length}</td>
                  <td><div className="lnd-actions"><button type="button" className="lnd-link" onClick={() => setDlg({ type: 'attendance', session: s })}>Attendance</button>
                    <button type="button" className="lnd-link" onClick={() => setDlg({ type: 'session', session: s })}>Edit</button>
                    <button type="button" className="lnd-link is-danger" onClick={() => setDlg({ type: 'confirm', title: 'Remove session', msg: 'Remove this session and its attendance?', run: () => api.delete(`/training/sessions/${s.id}`) })}>Remove</button></div></td></tr>
              ))}</tbody></table>
          ) : <Empty>No sessions. A one-off training does not need any.</Empty>}
        </>)}

        {tab === 'costs' && (<>
          <div className="lnd-actions" style={{ marginBottom: 10 }}><button type="button" className="pulse-btn-primary lnd-btn-sm" onClick={() => setDlg({ type: 'cost' })}>+ Add cost</button>
            <strong style={{ marginLeft: 'auto' }}>Total {fmtINR(totalCost)}{p.budget ? ` · Budget ${fmtINR(p.budget)} · ${totalCost > p.budget ? 'over by ' + fmtINR(totalCost - p.budget) : 'remaining ' + fmtINR(p.budget - totalCost)}` : ''}</strong></div>
          {p.costs.length ? (
            <table className="lnd-table"><thead><tr><th>Date</th><th>Type</th><th>Description</th><th className="num">Amount</th><th /></tr></thead>
              <tbody>{p.costs.map(c => (
                <tr key={c.id}><td>{fmtDate(c.cost_date)}</td><td>{statusLabel(c.cost_type)}</td><td>{c.description || '—'}</td><td className="num">{fmtINR(c.amount)}</td>
                  <td><div className="lnd-actions"><button type="button" className="lnd-link" onClick={() => setDlg({ type: 'cost', cost: c })}>Edit</button>
                    <button type="button" className="lnd-link is-danger" onClick={() => setDlg({ type: 'confirm', title: 'Remove cost', msg: 'Remove this cost line?', run: () => api.delete(`/training/costs/${c.id}`) })}>Remove</button></div></td></tr>
              ))}</tbody></table>
          ) : <Empty>No costs recorded.</Empty>}
        </>)}

        {tab === 'rounds' && (
          <table className="lnd-table"><thead><tr><th>#</th><th>Date</th><th>Status</th><th /></tr></thead>
            <tbody>{p.rounds.map((r, i) => (
              <tr key={r.id}><td>{i + 1}</td><td>{fmtDate(r.scheduled_date)}</td><td><Pill status={r.status} /></td>
                <td>{r.id === p.id ? <span className="lnd-muted">this round</span> : <button type="button" className="lnd-link" onClick={() => onChanged?.(r.id)}>Open</button>}</td></tr>
            ))}</tbody></table>
        )}
      </div>

      {dlg?.type === 'edit' && <ProgramForm initial={p} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); load(); onChanged?.(); }} />}
      {dlg?.type === 'enrol' && <EnrolDialog program={p} onClose={() => setDlg(null)} onDone={() => { setDlg(null); load(); onChanged?.(); }} />}
      {dlg?.type === 'complete' && <CompleteDialog ids={dlg.ids} onClose={() => setDlg(null)} onDone={() => { setDlg(null); setSel([]); load(); onChanged?.(); }} />}
      {dlg?.type === 'session' && <SessionDialog program={p} session={dlg.session} trainers={o.trainers} onClose={() => setDlg(null)} onDone={() => { setDlg(null); load(); }} />}
      {dlg?.type === 'attendance' && <AttendanceDialog session={dlg.session} onClose={() => setDlg(null)} onDone={() => { setDlg(null); load(); }} />}
      {dlg?.type === 'cost' && <CostDialog program={p} cost={dlg.cost} types={o.cost_types} onClose={() => setDlg(null)} onDone={() => { setDlg(null); load(); onChanged?.(); }} />}
      {dlg?.type === 'round' && <RoundDialog program={p} onClose={() => setDlg(null)} onDone={(nid) => { setDlg(null); onChanged?.(nid); }} />}
      {dlg?.type === 'cancel' && <CancelDialog program={p} onClose={() => setDlg(null)} onDone={() => { setDlg(null); load(); onChanged?.(); }} />}
      <ConfirmDialog open={dlg?.type === 'confirm'} title={dlg?.title} message={dlg?.msg} confirmLabel="Remove" variant="danger"
        onConfirm={() => { const run = dlg.run; setDlg(null); act(run, 'Removed'); }} onCancel={() => setDlg(null)} />
    </div>
  );
}

function EnrolDialog({ program, onClose, onDone }) {
  const toast = useToast();
  const [ids, setIds] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const taken = program.enrollments.filter(e => e.status !== 'withdrawn').map(e => e.employee_id);
  const room = program.max_participants - taken.length;
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/training/programs/${program.id}/enroll`, { employee_ids: ids });
      toast.success(r.data.message);
      if (r.data.skipped?.length) toast.error(r.data.skipped.map(s => s.reason).filter((v, i, a) => a.indexOf(v) === i).join('; '));
      onDone();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <LndDialog title={`Enrol — ${program.title}`} onClose={onClose} width={620} error={err}
      footer={<><span className="lnd-muted" style={{ marginRight: 'auto' }}>{room} seat(s) left</span><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="pulse-btn-primary" disabled={!ids.length || busy} onClick={save}>{busy ? 'Enrolling…' : `Enrol ${ids.length || ''}`}</button></>}>
      <EmployeePicker value={ids} onChange={setIds} exclude={taken} />
      <p className="lnd-muted" style={{ marginTop: 8 }}>Each person gets a notification. Anyone beyond the seat limit is skipped.</p>
    </LndDialog>
  );
}

function CompleteDialog({ ids, onClose, onDone }) {
  const toast = useToast();
  const [score, setScore] = useState('');
  const [err, setErr] = useState('');
  const save = async () => {
    try {
      if (ids.length === 1) await api.put(`/training/enrollments/${ids[0]}`, { status: 'completed', score: score === '' ? null : score });
      else await api.post('/training/enrollments/bulk', { ids, status: 'completed', score: score === '' ? null : score });
      toast.success('Marked completed'); onDone();
    } catch (e) { setErr(errText(e)); }
  };
  return (
    <LndDialog title={`Mark ${ids.length} completed`} onClose={onClose} width={420} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="pulse-btn-primary" onClick={save}>Mark completed</button></>}>
      <div className="lnd-form"><label className="full">Score % (optional)<input type="number" min="0" max="100" value={score} onChange={e => setScore(e.target.value)} />
        <span className="hint">Completion raises the linked skill rating. A path prerequisite that is not yet done blocks completion.</span></label></div>
    </LndDialog>
  );
}

function SessionDialog({ program, session, trainers, onClose, onDone }) {
  const [f, setF] = useState({ session_date: session?.session_date || program.scheduled_date?.slice(0, 10) || '', start_time: session?.start_time?.slice(0, 5) || '',
    end_time: session?.end_time?.slice(0, 5) || '', trainer_id: session?.trainer_id || program.trainer_id || '', venue: session?.venue || program.venue || '',
    online_link: session?.online_link || '', status: session?.status || 'scheduled', notes: session?.notes || '' });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    try { session ? await api.put(`/training/sessions/${session.id}`, f) : await api.post(`/training/programs/${program.id}/sessions`, f); onDone(); }
    catch (x) { setErr(errText(x)); }
  };
  return (
    <LndDialog title={session ? 'Edit session' : 'Add session'} onClose={onClose} width={560} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="submit" form="lnd-sess" className="pulse-btn-primary">Save</button></>}>
      <form id="lnd-sess" className="lnd-form" onSubmit={save}>
        <label>Date *<input type="date" required value={f.session_date} onChange={set('session_date')} /></label>
        <label>Start<input type="time" value={f.start_time} onChange={set('start_time')} /></label>
        <label>End<input type="time" value={f.end_time} onChange={set('end_time')} /></label>
        <label>Trainer<select value={f.trainer_id || ''} onChange={set('trainer_id')}><option value="">—</option>{trainers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label>Venue<input value={f.venue} onChange={set('venue')} /></label>
        <label>Online link<input value={f.online_link} onChange={set('online_link')} /></label>
        <label>Status<select value={f.status} onChange={set('status')}>{['scheduled', 'completed', 'cancelled'].map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></label>
        <label className="full">Notes<textarea value={f.notes} onChange={set('notes')} /></label>
      </form>
    </LndDialog>
  );
}

function AttendanceDialog({ session, onClose, onDone }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`/training/sessions/${session.id}/attendance`).then(r => setRows(r.data.map(x => ({ ...x, present: x.present ?? false })))).catch(e => setErr(errText(e))); }, [session.id]);
  const save = async () => {
    try { await api.put(`/training/sessions/${session.id}/attendance`, { records: rows.map(r => ({ employee_id: r.employee_id, present: r.present, notes: r.notes })) }); toast.success('Attendance saved'); onDone(); }
    catch (e) { setErr(errText(e)); }
  };
  return (
    <LndDialog title={`Attendance — ${fmtDate(session.session_date)}`} onClose={onClose} width={560} error={err}
      footer={<><button type="button" className="lnd-link" style={{ marginRight: 'auto' }} onClick={() => setRows(r => r.map(x => ({ ...x, present: true })))}>All present</button>
        <button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="pulse-btn-primary" disabled={!rows} onClick={save}>Save</button></>}>
      {!rows ? <Empty>Loading…</Empty> : rows.length ? (
        <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Employee</th><th>Present</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={r.employee_id}><td>{r.employee_name}<div className="lnd-muted">{r.office_id} · {r.department}</div></td>
              <td><input type="checkbox" checked={!!r.present} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, present: e.target.checked } : x))} /></td></tr>
          ))}</tbody></table>
      ) : <Empty>Enrol people first.</Empty>}
    </LndDialog>
  );
}

function CostDialog({ program, cost, types, onClose, onDone }) {
  const [f, setF] = useState({ cost_type: cost?.cost_type || 'trainer_fee', amount: cost?.amount ?? '', description: cost?.description || '', cost_date: cost?.cost_date || today() });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    try { cost ? await api.put(`/training/costs/${cost.id}`, f) : await api.post(`/training/programs/${program.id}/costs`, f); onDone(); }
    catch (x) { setErr(errText(x)); }
  };
  return (
    <LndDialog title={cost ? 'Edit cost' : 'Add cost'} onClose={onClose} width={480} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="submit" form="lnd-cost" className="pulse-btn-primary">Save</button></>}>
      <form id="lnd-cost" className="lnd-form" onSubmit={save}>
        <label>Type<select value={f.cost_type} onChange={set('cost_type')}>{(types?.length ? types : ['trainer_fee', 'venue', 'materials', 'travel', 'food', 'certification', 'other']).map(t => <option key={t} value={t}>{statusLabel(t)}</option>)}</select></label>
        <label>Amount (₹) *<input type="number" min="0" step="0.01" required value={f.amount} onChange={set('amount')} /></label>
        <label>Date<input type="date" value={f.cost_date} onChange={set('cost_date')} /></label>
        <label className="full">Description<input value={f.description} onChange={set('description')} /></label>
      </form>
    </LndDialog>
  );
}

function RoundDialog({ program, onClose, onDone }) {
  const toast = useToast();
  const suggest = () => {
    if (!program.scheduled_date) return '';
    const d = new Date(program.scheduled_date); d.setMonth(d.getMonth() + (program.refresher_months || 6));
    return d.toISOString().slice(0, 10);
  };
  const [f, setF] = useState({ scheduled_date: suggest(), end_date: '', enroll_previous: true });
  const [err, setErr] = useState('');
  const save = async () => {
    try { const r = await api.post(`/training/programs/${program.id}/next-round`, f); toast.success(`Next round scheduled${r.data.enrolled_previous ? ` — ${r.data.enrolled_previous} re-enrolled` : ''}`); onDone(r.data.id); }
    catch (e) { setErr(errText(e)); }
  };
  return (
    <LndDialog title="Schedule the next round" onClose={onClose} width={460} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="pulse-btn-primary" onClick={save}>Schedule</button></>}>
      <div className="lnd-form">
        <label>Start date *<input type="date" value={f.scheduled_date} onChange={e => setF(v => ({ ...v, scheduled_date: e.target.value }))} /></label>
        <label>End date<input type="date" value={f.end_date} min={f.scheduled_date} onChange={e => setF(v => ({ ...v, end_date: e.target.value }))} /></label>
        <label className="lnd-inline full"><input type="checkbox" checked={f.enroll_previous} onChange={e => setF(v => ({ ...v, enroll_previous: e.target.checked }))} /> Enrol this round's participants again</label>
        <p className="hint full" style={{ margin: 0 }}>The new round copies every detail and stays in the same series, so compliance counts the latest completion.</p>
      </div>
    </LndDialog>
  );
}

function CancelDialog({ program, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const save = async () => {
    try { await api.post(`/training/programs/${program.id}/status`, { status: 'cancelled', cancel_reason: reason }); onDone(); }
    catch (e) { setErr(errText(e)); }
  };
  return (
    <LndDialog title="Cancel training" onClose={onClose} width={460} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Keep it</button><button type="button" className="pulse-btn-primary" disabled={!reason.trim()} onClick={save}>Cancel training</button></>}>
      <div className="lnd-form"><label className="full">Reason *<textarea value={reason} onChange={e => setReason(e.target.value)} /><span className="hint">Enrolled people are notified with this reason.</span></label></div>
    </LndDialog>
  );
}

/* ── before / after self-review ────────────────────────────────── */
const change = (v) => (v == null ? '—' : <span style={{ fontWeight: 700, color: v > 0 ? 'var(--color-success)' : v < 0 ? 'var(--color-danger)' : '#6b7280' }}>{v > 0 ? '+' : ''}{v}</span>);
function SelfReviewTab({ data, title, id }) {
  if (!data?.enabled) return <Empty>Before / after self-review is switched off for this training (Edit → Before / after self-review).</Empty>;
  const s = data.summary;
  return (<>
    <div className="lnd-kpis">
      <div className="lnd-kpi"><div className="lnd-kpi-value">{s.pre_done} / {s.enrolled}</div><div className="lnd-kpi-label">Rated before</div></div>
      <div className="lnd-kpi"><div className="lnd-kpi-value">{s.post_done} / {s.enrolled}</div><div className="lnd-kpi-label">Rated after</div></div>
      <div className="lnd-kpi"><div className="lnd-kpi-value">{s.knowledge.before ?? '—'} → {s.knowledge.after ?? '—'}</div><div className="lnd-kpi-label">Knowledge (avg, 1–5) {change(s.knowledge.change)}</div><div className="lnd-kpi-sub">people who did both: {s.both_done}</div></div>
      <div className="lnd-kpi"><div className="lnd-kpi-value">{s.confidence.before ?? '—'} → {s.confidence.after ?? '—'}</div><div className="lnd-kpi-label">Confidence (avg, 1–5) {change(s.confidence.change)}</div></div>
    </div>
    {s.items.length > 0 && (
      <table className="lnd-table" style={{ width: '100%', marginBottom: 12 }}><thead><tr><th>Statement</th><th className="num">Before</th><th className="num">After</th><th className="num">Change</th></tr></thead>
        <tbody>{s.items.map(it => <tr key={it.item}><td>{it.item}</td><td className="num">{it.before ?? '—'}</td><td className="num">{it.after ?? '—'}</td><td className="num">{change(it.change)}</td></tr>)}</tbody></table>
    )}
    <div className="lnd-actions" style={{ marginBottom: 8 }}>
      <span className="lnd-muted">Participants rate themselves in Self Service → My Learning. The after-review opens when you mark them completed.</span>
      <button type="button" className="lnd-link" style={{ marginLeft: 'auto' }} onClick={() => downloadCsv(data.people.map(p => ({
        employee: p.employee_name, department: p.department, status: p.status, knowledge_before: p.pre_knowledge, knowledge_after: p.post_knowledge,
        knowledge_change: p.knowledge_change, confidence_before: p.pre_confidence, confidence_after: p.post_confidence, confidence_change: p.confidence_change,
        ...Object.fromEntries(data.items.flatMap(it => [[`${it} (before)`, p.pre_items?.[it] ?? ''], [`${it} (after)`, p.post_items?.[it] ?? '']])),
        comments_after: p.post_comments || '' })), `training-${id}-before-after`)}>Export CSV</button>
    </div>
    {data.people.length ? (
      <div className="lnd-table-wrap"><table className="lnd-table">
        <thead><tr><th>Employee</th><th>Status</th><th className="num">Knowledge before</th><th className="num">after</th><th className="num">change</th>
          <th className="num">Confidence before</th><th className="num">after</th><th className="num">change</th><th>Comments after</th></tr></thead>
        <tbody>{data.people.map(p => (
          <tr key={p.enrollment_id}><td>{p.employee_name}<div className="lnd-muted">{p.department}</div></td><td><Pill status={p.status} /></td>
            <td className="num">{p.pre_knowledge ?? '—'}</td><td className="num">{p.post_knowledge ?? '—'}</td><td className="num">{change(p.knowledge_change)}</td>
            <td className="num">{p.pre_confidence ?? '—'}</td><td className="num">{p.post_confidence ?? '—'}</td><td className="num">{change(p.confidence_change)}</td>
            <td title={p.pre_comments ? `Before: ${p.pre_comments}` : ''}>{p.post_comments || <span className="lnd-muted">—</span>}</td></tr>
        ))}</tbody></table></div>
    ) : <Empty>No participants yet for {title}.</Empty>}
  </>);
}

/* ── page ──────────────────────────────────────────────────────── */
export default function LearningDevelopment() {
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const openId = sp.get('program');
  const [f, setF] = useState(DEFAULT);
  const [view, setView] = useState('calendar');
  const [month, setMonth] = useState(new Date());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [del, setDel] = useState(null);

  const query = useMemo(() => {
    // The calendar shows its whole month; the list honours the period filter.
    if (view === 'calendar') {
      const y = month.getFullYear(); const mm = String(month.getMonth() + 1).padStart(2, '0');
      const last = new Date(y, month.getMonth() + 1, 0).getDate();
      return toQuery({ ...f, period: 'custom', from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` });
    }
    return toQuery(f);
  }, [f, view, month]);

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows((await api.get(`/training/programs${query}`)).data); }
    catch (e) { toast.error(errText(e, 'Could not load trainings')); }
    finally { setLoading(false); }
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const open = (id) => { const n = new URLSearchParams(sp); if (id) n.set('program', String(id)); else n.delete('program'); setSp(n); };
  const remove = async () => {
    const id = del; setDel(null);
    try { await api.delete(`/training/programs/${id}`); toast.success('Training deleted'); load(); }
    catch (e) { toast.error(errText(e)); }
  };

  return (
    <PageShell dock={<PageHero icon={GraduationCap} eyebrow="Learning Center" title="Trainings" subtitle="Schedule, enrol, take attendance, close and repeat trainings"
      actions={<button type="button" className="plh-cta" onClick={() => setForm({})}>+ Schedule training</button>} />}>
      {openId ? (
        <ProgramDetail id={openId} onBack={() => open(null)} onChanged={(nid) => { load(); resetLndOptions(); if (nid) open(nid); }} />
      ) : (
        <div className="lnd">
          <Filters value={f} onChange={setF} fields={view === 'calendar' ? ['department', 'category', 'status', 'trainer', 'mode', 'mandatory', 'cost', 'q'] : ['period', 'department', 'category', 'status', 'trainer', 'mode', 'mandatory', 'cost', 'q']}
            statusOptions={['planned', 'ongoing', 'completed', 'cancelled']} onReset={() => setF(DEFAULT)}
            extra={<label>View<select value={view} onChange={e => setView(e.target.value)}><option value="calendar">Calendar</option><option value="list">List</option></select></label>} />
          {view === 'calendar' ? <Calendar programs={rows} month={month} setMonth={setMonth} onOpen={open} /> : (
            <div className="lnd-card">
              <div className="lnd-card-title"><span>{rows.length} training(s)</span>
                <button type="button" className="lnd-link" onClick={() => downloadCsv(rows, 'trainings', [
                  { key: 'title', label: 'Title' }, { key: 'category', label: 'Category' }, { key: 'scheduled_date', label: 'Date' }, { key: 'trainer_name', label: 'Trainer' },
                  { key: 'status', label: 'Status' }, { key: 'enrolled_count', label: 'Enrolled' }, { key: 'completed_count', label: 'Completed' }, { key: 'total_cost', label: 'Cost' }])}>Export CSV</button></div>
              {loading ? <Empty>Loading…</Empty> : rows.length ? (
                <div className="lnd-table-wrap"><table className="lnd-table">
                  <thead><tr><th>Date</th><th>Training</th><th>Category</th><th>Trainer</th><th>Mode</th><th className="num">Seats</th><th className="num">Done</th><th className="num">Cost</th><th>Status</th><th /></tr></thead>
                  <tbody>{rows.map(p => (
                    <tr key={p.id} className="is-click" onClick={() => open(p.id)}>
                      <td>{fmtDate(p.scheduled_date)}</td>
                      <td>{p.title} {p.is_mandatory && <Pill tone="bad">Mandatory</Pill>}{p.refresher_months ? <div className="lnd-muted">repeats every {p.refresher_months} mo{p.rounds_in_series > 1 ? ` · ${p.rounds_in_series} rounds` : ''}</div> : null}</td>
                      <td>{p.category || '—'}</td><td>{p.trainer_name || '—'}</td><td>{statusLabel(p.mode)}</td>
                      <td className="num">{p.enrolled_count} / {p.max_participants}</td><td className="num">{p.completed_count}</td>
                      <td className="num">{fmtINR(p.total_cost)}</td><td><Pill status={p.status} /></td>
                      <td onClick={e => e.stopPropagation()}><button type="button" className="lnd-link is-danger" onClick={() => setDel(p.id)}>Delete</button></td>
                    </tr>
                  ))}</tbody></table></div>
              ) : <Empty>No trainings match these filters.</Empty>}
            </div>
          )}
        </div>
      )}
      {form && <ProgramForm initial={null} onClose={() => setForm(null)} onSaved={(p) => { setForm(null); load(); open(p.id); }} />}
      <ConfirmDialog open={!!del} title="Delete training" message="Delete this training? One with completion records must be cancelled instead." confirmLabel="Delete" variant="danger" onConfirm={remove} onCancel={() => setDel(null)} />
    </PageShell>
  );
}
