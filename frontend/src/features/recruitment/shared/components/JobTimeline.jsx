import { useCallback, useEffect, useState } from 'react';
import {
  FilePlus2, Pencil, Send, Undo2, CheckCircle2, CornerUpLeft, Ban, Briefcase, FileText,
  PlayCircle, PauseCircle, XCircle, Trash2, UserPlus, UserCheck, Lock, RefreshCw, Circle,
} from 'lucide-react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import './job-timeline.css';

/**
 * JobTimeline — the story of one job, from the request to the last hire.
 *
 * Reads GET /recruitment/requisitions/:id/timeline: the recorded steps
 * (job_requisition_events) plus every application and hire on the opening.
 * Used on the requisition view and the job opening view, so both show the
 * same history.
 *
 * `refreshKey`: change it after an action on the page so the new step shows.
 */
const EVENTS = {
  raised:        { icon: FilePlus2,    tone: 'grey',   text: 'Requisition raised' },
  edited:        { icon: Pencil,       tone: 'grey',   text: 'Requisition edited' },
  submitted:     { icon: Send,         tone: 'amber',  text: 'Submitted for approval' },
  withdrawn:     { icon: Undo2,        tone: 'grey',   text: 'Withdrawn to draft' },
  approved:      { icon: CheckCircle2, tone: 'green',  text: 'Approved' },
  sent_back:     { icon: CornerUpLeft, tone: 'amber',  text: 'Sent back for changes' },
  cancelled:     { icon: Ban,          tone: 'red',    text: 'Requisition cancelled' },
  closed:        { icon: Lock,         tone: 'red',    text: 'Requisition closed' },
  reopened:      { icon: RefreshCw,    tone: 'purple', text: 'Requisition reopened' },
  restored:      { icon: Undo2,        tone: 'grey',   text: 'Requisition restored to draft' },
  job_drafted:   { icon: FileText,     tone: 'purple', text: 'Job opening saved as draft' },
  job_posted:    { icon: Briefcase,    tone: 'purple', text: 'Job opening posted' },
  job_published: { icon: PlayCircle,   tone: 'purple', text: 'Job opening published' },
  job_edited:    { icon: Pencil,       tone: 'grey',   text: 'Job opening edited' },
  job_paused:    { icon: PauseCircle,  tone: 'amber',  text: 'Job opening put on hold' },
  job_reopened:  { icon: RefreshCw,    tone: 'purple', text: 'Job opening reopened' },
  job_closed:    { icon: XCircle,      tone: 'red',    text: 'Job opening closed' },
  job_cancelled: { icon: XCircle,      tone: 'red',    text: 'Job opening cancelled' },
  job_deleted:   { icon: Trash2,       tone: 'red',    text: 'Job opening deleted' },
  application:   { icon: UserPlus,     tone: 'blue',   text: 'Application received' },
  hired:         { icon: UserCheck,    tone: 'green',  text: 'Hired' },
  filled:        { icon: Lock,         tone: 'green',  text: 'All positions filled' },
};
const ORIGIN = { recommended: 'recommended from another job', moved: 'moved from another job', careers: 'via careers page' };

const when = (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

/** Runs of 3+ applications collapse into one line that expands. */
function group(rows) {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (r.event === 'application' && last?.event === 'application') {
      if (!last.group) out[out.length - 1] = { ...last, group: [last] };
      out[out.length - 1].group.push(r);
      out[out.length - 1].at = r.at;
    } else out.push(r);
  }
  return out.flatMap(r => (r.group && r.group.length < 3 ? r.group : [r]));
}

export default function JobTimeline({ requisitionId, refreshKey = 0, setPage }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState({});
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);
  const openCandidate = (id) => { setSelectedCandidateId(id); setPage?.('CandidateDetail'); };

  const load = useCallback(async () => {
    if (!requisitionId) return;
    setLoading(true);
    setError('');
    try {
      const r = await api.get(`/recruitment/requisitions/${requisitionId}/timeline`);
      setRows(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      setRows([]);
      setError(e?.response?.data?.error || 'Could not load the timeline.');
    } finally {
      setLoading(false);
    }
  }, [requisitionId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (!requisitionId) return null;
  const items = group(rows);

  return (
    <section className="jtl" aria-label="Job timeline">
      <div className="jtl-hd">
        <h4>Timeline</h4>
        <button type="button" className="jtl-refresh" onClick={load} aria-label="Refresh timeline" title="Refresh"><RefreshCw size={13} /></button>
      </div>
      {loading ? <div className="jtl-empty">Loading…</div>
        : error ? <div className="jtl-error">{error} <button type="button" onClick={load}>Retry</button></div>
        : items.length === 0 ? <div className="jtl-empty">Nothing recorded yet.</div>
        : (
          <ol className="jtl-list">
            {items.map((r) => {
              const m = EVENTS[r.event] || { icon: Circle, tone: 'grey', text: r.event };
              const Icon = m.icon;
              const isGroup = !!r.group;
              return (
                <li key={r.key} className={`jtl-item jtl-${m.tone}`}>
                  <span className="jtl-dot"><Icon size={13} /></span>
                  <div className="jtl-body">
                    <div className="jtl-title">
                      {isGroup ? `${r.group.length} applications received` : m.text}
                      {!isGroup && r.candidate && (
                        <> — {setPage
                          ? <button type="button" className="jtl-link" onClick={() => openCandidate(r.candidate_id)}>{r.candidate}</button>
                          : r.candidate}</>
                      )}
                    </div>
                    <div className="jtl-meta">
                      {isGroup ? `${when(r.group[0].at)} – ${when(r.at)}` : when(r.at)}
                      {r.actor ? ` · ${r.actor}` : ''}
                    </div>
                    {r.comment && (
                      <div className={r.event === 'sent_back' || r.event === 'approved' ? 'jtl-quote' : 'jtl-note'}>
                        {r.event === 'application' ? (ORIGIN[r.comment] || r.comment) : r.comment}
                      </div>
                    )}
                    {isGroup && (
                      <>
                        <button type="button" className="jtl-link" onClick={() => setOpen(o => ({ ...o, [r.key]: !o[r.key] }))}>
                          {open[r.key] ? 'Hide names' : 'Show names'}
                        </button>
                        {open[r.key] && (
                          <ul className="jtl-names">
                            {r.group.map(g => (
                              <li key={g.key}>
                                {setPage
                                  ? <button type="button" className="jtl-link" onClick={() => openCandidate(g.candidate_id)}>{g.candidate}</button>
                                  : g.candidate}
                                <span className="jtl-meta"> · {when(g.at)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
    </section>
  );
}
