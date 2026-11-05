import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, ChevronLeft, ChevronRight, FileText, Phone, Mail, MapPin, Briefcase,
  GraduationCap, Clock, IndianRupee, ClipboardCheck, StickyNote, Shuffle,
  Archive, CalendarClock, Ban, ExternalLink, Pin,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import {
  stageLabelShort, stageColor, ALL_STAGES, ACTIVE_STAGES, DEADEND_STAGES,
  dispositionLabel, dispositionColor, noteTypeLabel, noteTypeColor,
  relocationLabel, relocationColor, sourceLabel, decisionLabel, decisionTone,
  SUITABILITY_LABELS, SUITABILITY_COLORS, activityTone, COMPETENCIES,
} from '../constants';
import './candidate-quickview.css';

/**
 * CandidateQuickView — §8's right-side drawer.
 *
 * The brief's reasoning, which is worth restating because it drives every choice
 * in this file: "The recruiter should be able to process candidates sequentially
 * without returning to the candidate list." Before this, clicking a candidate was
 * a full page transition that discarded the list's filters and scroll position,
 * so processing eighty candidates meant eighty round trips through a list that
 * had to be re-narrowed each time.
 *
 * ── ONE REQUEST PER CANDIDATE ───────────────────────────────────────────────
 * Everything below comes from GET /recruitment/candidates/:id/quick-view, which
 * returns the candidate, their applications, latest screening, recent notes,
 * recent activity, suitability records, pools and pending recontact in a single
 * round trip. A drawer that called six endpoints would fire ~480 requests across
 * a morning's eighty candidates, which is what §31 is about.
 *
 * ── PREV / NEXT ─────────────────────────────────────────────────────────────
 * Provided by the caller (the workbench owns the row order). Arrow keys are bound
 * here rather than on the list because the drawer has focus while it is open.
 */

const RATING_KEYS = COMPETENCIES.slice(0, 5);   // the five §8 names as the summary

export default function CandidateQuickView({
  candidateId,
  onClose,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
  /** Full profile, screening workspace, and "consider other roles". */
  onOpenProfile,
  onOpenScreening,
  onConsiderOtherRoles,
  onAddToTalentBank,
  onFutureOpportunity,
  /** Called after any change so the list behind can refresh its row. */
  onChanged,
}) {
  const _toast = useToast();
  const toast = useCallback((message, type = 'success') => _toast({ message, type }), [_toast]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingStage, setSavingStage] = useState(false);
  const [noteBody, setNoteBody] = useState('');
  const [noteType, setNoteType] = useState('recruiter');
  const [savingNote, setSavingNote] = useState(false);

  const panelRef = useRef(null);

  const load = useCallback(async () => {
    if (!candidateId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/recruitment/candidates/${candidateId}/quick-view`);
      setData(res.data);
    } catch (e) {
      if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') return;
      setError(e?.response?.data?.error || 'Could not load this candidate.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [candidateId]);

  useEffect(() => { load(); }, [load]);

  // The note draft belongs to the candidate being looked at. Carrying it across a
  // next-candidate press would attach one person's assessment to another's record.
  useEffect(() => { setNoteBody(''); setNoteType('recruiter'); }, [candidateId]);

  // §32's keyboard flow. Bound on the panel, not the window, so the list's own
  // shortcuts still work when the drawer is closed, and so typing in the note box
  // is never hijacked (the guard checks the event target).
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.key === 'Escape')      { e.preventDefault(); onClose?.(); }
      else if (e.key === 'j' || e.key === 'ArrowDown')  { if (hasNext) { e.preventDefault(); onNext?.(); } }
      else if (e.key === 'k' || e.key === 'ArrowUp')    { if (hasPrev) { e.preventDefault(); onPrev?.(); } }
      else if (e.key === 's' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpenScreening?.(candidateId); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNext, onPrev, hasNext, hasPrev, onOpenScreening, candidateId]);

  // Focus the panel when it opens so the keyboard flow works without a click, and
  // so a screen reader announces the drawer rather than leaving focus behind it.
  useEffect(() => { panelRef.current?.focus(); }, [candidateId]);

  const c = data?.candidate;

  const moveStage = async (stage) => {
    if (!c || savingStage || stage === c.current_stage) return;
    setSavingStage(true);
    // Optimistic: §31 asks for status changes to "feel immediate". Reverted below
    // if the server refuses, rather than left showing a change that did not happen.
    const previous = c.current_stage;
    setData(d => ({ ...d, candidate: { ...d.candidate, current_stage: stage } }));
    try {
      await api.post(`/recruitment/candidates/${c.id}/move-stage`, { new_stage: stage });
      toast(`${c.full_name} → ${stageLabelShort(stage)}`);
      onChanged?.();
      load();
    } catch (e) {
      setData(d => ({ ...d, candidate: { ...d.candidate, current_stage: previous } }));
      toast(e?.response?.data?.error || 'Could not change the stage', 'error');
    } finally {
      setSavingStage(false);
    }
  };

  const addNote = async () => {
    const body = noteBody.trim();
    if (!body || savingNote) return;
    setSavingNote(true);
    try {
      await api.post(`/recruitment/candidates/${c.id}/notes`, { body, note_type: noteType });
      setNoteBody('');
      toast('Note added');
      onChanged?.();
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not save the note', 'error');
    } finally {
      setSavingNote(false);
    }
  };

  const screening = data?.screening;
  const primaryApp = data?.applications?.find(a => a.is_primary) || data?.applications?.[0];

  return (
    <div className="cqv-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <aside
        className="cqv"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={c ? `Quick view — ${c.full_name}` : 'Candidate quick view'}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="cqv-head">
          <div className="cqv-head-nav">
            <button
              type="button" className="cqv-icon" onClick={onPrev} disabled={!hasPrev}
              title="Previous candidate (K)" aria-label="Previous candidate"
            ><ChevronLeft size={16} /></button>
            <button
              type="button" className="cqv-icon" onClick={onNext} disabled={!hasNext}
              title="Next candidate (J)" aria-label="Next candidate"
            ><ChevronRight size={16} /></button>
            <span className="cqv-kbd-hint">J / K to move · Esc to close</span>
          </div>
          <button type="button" className="cqv-icon" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        {loading && <div className="cqv-state">Loading…</div>}
        {error && !loading && <div className="cqv-state cqv-state--bad">{error}</div>}

        {c && !loading && (
          <>
            <div className="cqv-scroll">
              {/* ── Identity ─────────────────────────────────────────── */}
              <section className="cqv-identity">
                <div className="cqv-avatar" aria-hidden>
                  {c.photo_url
                    ? <img src={c.photo_url} alt="" />
                    : <span>{(c.full_name || '?').trim().charAt(0).toUpperCase()}</span>}
                </div>
                <div className="cqv-identity-text">
                  <h2 className="cqv-name">{c.full_name}</h2>
                  <p className="cqv-role">
                    {c.current_designation || 'Role not recorded'}
                    {c.current_company ? ` · ${c.current_company}` : ''}
                  </p>
                  <div className="cqv-chips">
                    <span className="cqv-chip" style={dispositionColor(c.disposition)}>
                      {dispositionLabel(c.disposition)}
                    </span>
                    <span className="cqv-chip" style={stageColor(c.current_stage)}>
                      {stageLabelShort(c.current_stage)}
                    </span>
                    {c.candidate_code && <span className="cqv-chip cqv-chip--plain">{c.candidate_code}</span>}
                  </div>
                </div>
              </section>

              {/* ── Facts a recruiter reads before speaking ──────────── */}
              <section className="cqv-facts">
                <Fact icon={Briefcase} label="Experience"
                      value={c.experience_years != null ? `${c.experience_years} yrs${c.relevant_experience_years != null ? ` · ${c.relevant_experience_years} relevant` : ''}` : null} />
                <Fact icon={MapPin} label="Location"
                      value={[c.current_city, c.current_state].filter(Boolean).join(', ') || c.location} />
                <Fact icon={GraduationCap} label="Education"
                      value={[c.qualification, c.specialisation].filter(Boolean).join(' · ')} />
                <Fact icon={Clock} label="Notice period"
                      value={c.notice_period_days != null ? `${c.notice_period_days} days` : null} />
                <Fact icon={IndianRupee} label="Expected CTC"
                      value={c.expected_ctc != null ? Number(c.expected_ctc).toLocaleString('en-IN') : null} />
                <Fact icon={ExternalLink} label="Source" value={sourceLabel(c.source)} />
              </section>

              {/* Relocation is called out on its own rather than buried in the
                  facts grid: with the site planned near Durganagar it is one of
                  the two or three answers that decide whether a conversation is
                  worth having (§26). */}
              <section className="cqv-relocation">
                <span className="cqv-chip" style={relocationColor(c.willing_to_relocate)}>
                  {relocationLabel(c.willing_to_relocate)}
                </span>
                {c.native_place && <span className="cqv-relo-note">Native: {c.native_place}</span>}
                {c.relocation_note && <p className="cqv-relo-note">{c.relocation_note}</p>}
              </section>

              {/* ── Contact ──────────────────────────────────────────── */}
              <section className="cqv-contact">
                {c.phone && (
                  <a className="cqv-contact-btn" href={`tel:${c.phone}`}>
                    <Phone size={13} /> {c.phone}
                  </a>
                )}
                {c.email && (
                  <a className="cqv-contact-btn" href={`mailto:${c.email}`}>
                    <Mail size={13} /> {c.email}
                  </a>
                )}
              </section>

              {/* ── Résumé ───────────────────────────────────────────── */}
              {/* A button, not the viewer itself. The drawer is 480px wide and a
                  résumé at that width is unreadable — §33 is explicit that the
                  viewer must stay readable. It opens the full profile, where the
                  viewer has the room it needs. */}
              <button type="button" className="cqv-resume" onClick={() => onOpenProfile?.(c.id)}>
                <FileText size={15} />
                <span>
                  {(c.resume_file_url || c.resume_url || c.resume_gdrive_url)
                    ? 'Open résumé and full profile'
                    : 'Open full profile (no résumé on file)'}
                </span>
                <ChevronRight size={14} className="cqv-resume-arrow" />
              </button>

              {/* ── Applications ─────────────────────────────────────── */}
              <Block title={`Applications (${data.applications.length})`}>
                {data.applications.length === 0 ? (
                  <p className="cqv-muted">
                    Not linked to any opening — a speculative profile. Use
                    &ldquo;Consider other roles&rdquo; to put them forward for one.
                  </p>
                ) : data.applications.map(a => (
                  <div key={a.id} className="cqv-row">
                    <div className="cqv-row-main">
                      <span className="cqv-row-title">{a.job_title}</span>
                      <span className="cqv-row-sub">
                        {a.department || '—'}
                        {a.is_primary ? ' · original' : ''}
                        {a.origin === 'recommended' ? ' · recommended' : ''}
                      </span>
                    </div>
                    <span className="cqv-chip" style={stageColor(a.stage)}>{stageLabelShort(a.stage)}</span>
                  </div>
                ))}
              </Block>

              {/* ── Quick stage change (§7) ──────────────────────────── */}
              <Block title="Stage">
                <label className="cqv-label" htmlFor="cqv-stage">Move to</label>
                <select
                  id="cqv-stage"
                  className="cqv-select"
                  value={c.current_stage || 'applied'}
                  disabled={savingStage}
                  onChange={(e) => moveStage(e.target.value)}
                >
                  <optgroup label="In the pipeline">
                    {ACTIVE_STAGES.map(s => <option key={s} value={s}>{stageLabelShort(s)}</option>)}
                  </optgroup>
                  {/* Grouped separately and labelled, so "not suitable for this
                      role" is visibly not in the same family as "rejected". */}
                  <optgroup label="Parked — candidate stays in the system">
                    {DEADEND_STAGES.map(s => <option key={s} value={s}>{stageLabelShort(s)}</option>)}
                  </optgroup>
                </select>
              </Block>

              {/* ── Screening summary (§8) ───────────────────────────── */}
              <Block title="Stage 1 screening">
                {!screening ? (
                  <>
                    <p className="cqv-muted">Not screened yet.</p>
                    <button type="button" className="cqv-btn cqv-btn--primary"
                            onClick={() => onOpenScreening?.(c.id, primaryApp?.id)}>
                      <ClipboardCheck size={14} /> Start screening <kbd>S</kbd>
                    </button>
                  </>
                ) : (
                  <>
                    <div className="cqv-score">
                      <div className="cqv-score-num">
                        {screening.total_score ?? '—'}<span>/100</span>
                      </div>
                      <div className="cqv-score-meta">
                        <span className="cqv-chip cqv-chip--plain">
                          {screening.status === 'completed' ? 'Completed' : 'Draft'}
                        </span>
                        {screening.decision && (
                          <span className="cqv-chip" style={decisionTone(screening.decision)}>
                            {decisionLabel(screening.decision)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="cqv-ratings">
                      {RATING_KEYS.map(({ key, label }) => (
                        <div key={key} className="cqv-rating">
                          <span className="cqv-rating-label">{label}</span>
                          <span className="cqv-rating-dots" aria-label={`${label}: ${screening[key] ?? 'not rated'} of 5`}>
                            {[1, 2, 3, 4, 5].map(n => (
                              <i key={n} className={n <= (screening[key] || 0) ? 'on' : ''} />
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                    {screening.summary_note && <p className="cqv-quote">{screening.summary_note}</p>}
                    <button type="button" className="cqv-btn"
                            onClick={() => onOpenScreening?.(c.id, screening.application_id || primaryApp?.id)}>
                      <ClipboardCheck size={14} /> {screening.status === 'completed' ? 'Review screening' : 'Continue screening'}
                    </button>
                  </>
                )}
              </Block>

              {/* ── Other roles they suit (§16) ──────────────────────── */}
              {data.suitability.length > 0 && (
                <Block title="Also suited to">
                  {data.suitability.map(s => (
                    <div key={s.department} className="cqv-row">
                      <div className="cqv-row-main">
                        <span className="cqv-row-title">{s.department}</span>
                        {s.reason && <span className="cqv-row-sub">{s.reason}</span>}
                      </div>
                      <span className="cqv-chip" style={SUITABILITY_COLORS[s.suitability]}>
                        {SUITABILITY_LABELS[s.suitability]}
                      </span>
                    </div>
                  ))}
                </Block>
              )}

              {/* ── Talent Bank + recontact ──────────────────────────── */}
              {(data.pools.length > 0 || data.recontact) && (
                <Block title="Retained">
                  {data.pools.length > 0 && (
                    <div className="cqv-tags">
                      {data.pools.map(p => (
                        <span key={p.id} className="cqv-chip cqv-chip--pool">{p.pool_name}</span>
                      ))}
                    </div>
                  )}
                  {data.recontact && (
                    <p className="cqv-next">
                      <CalendarClock size={13} />
                      Recontact {fmtDate(data.recontact.recontact_on)}
                      {data.recontact.potential_role ? ` about ${data.recontact.potential_role}` : ''}
                    </p>
                  )}
                </Block>
              )}

              {/* ── Notes (§9) ──────────────────────────────────────── */}
              <Block title={`Notes${c.note_count ? ` (${c.note_count})` : ''}`}>
                <div className="cqv-note-form">
                  <textarea
                    className="cqv-textarea"
                    rows={3}
                    placeholder="Strong electrical fundamentals. No direct AHF experience. Consider for Testing or Service."
                    value={noteBody}
                    onChange={(e) => setNoteBody(e.target.value)}
                    onKeyDown={(e) => {
                      // Ctrl/Cmd+Enter saves. §9 wants notes "extremely easy to
                      // create"; reaching for the mouse after typing is the cost
                      // this removes.
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); addNote(); }
                    }}
                  />
                  <div className="cqv-note-actions">
                    <select
                      className="cqv-select cqv-select--sm"
                      value={noteType}
                      onChange={(e) => setNoteType(e.target.value)}
                      aria-label="Note type"
                    >
                      {['recruiter', 'screening', 'interview', 'technical', 'management', 'followup', 'general']
                        .map(t => <option key={t} value={t}>{noteTypeLabel(t)}</option>)}
                    </select>
                    <button
                      type="button"
                      className="cqv-btn cqv-btn--primary"
                      onClick={addNote}
                      disabled={savingNote || !noteBody.trim()}
                    >
                      {savingNote ? 'Saving…' : 'Add note'}
                    </button>
                  </div>
                </div>

                {data.notes.length === 0
                  ? <p className="cqv-muted">No notes yet.</p>
                  : data.notes.map(n => (
                    <div key={n.id} className="cqv-note">
                      <div className="cqv-note-head">
                        <span className="cqv-chip cqv-chip--sm" style={noteTypeColor(n.note_type)}>
                          {noteTypeLabel(n.note_type)}
                        </span>
                        {n.is_pinned && <Pin size={11} className="cqv-pin" aria-label="Pinned" />}
                        <span className="cqv-note-meta">
                          {n.author_name || 'Unknown'} · {fmtDate(n.created_at)}
                        </span>
                      </div>
                      <p className="cqv-note-body">{n.body}</p>
                    </div>
                  ))}
              </Block>

              {/* ── Recent activity (§21) ───────────────────────────── */}
              <Block title="Recent activity">
                {data.activity.length === 0
                  ? <p className="cqv-muted">Nothing recorded yet.</p>
                  : (
                    <ol className="cqv-timeline">
                      {data.activity.map((e, i) => (
                        <li key={`${e.created_at}-${i}`}>
                          <span className="cqv-dot" style={{ background: activityTone(e.event_type).dot }} />
                          <div>
                            <p className="cqv-tl-summary">{e.summary}</p>
                            <p className="cqv-tl-meta">
                              {fmtDate(e.created_at)}
                              {e.actor_name ? ` · ${e.actor_name}` : ''}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
              </Block>
            </div>

            {/* ── Actions (§8) ───────────────────────────────────────── */}
            {/* Pinned to the bottom of the drawer so the seven decisions are
                reachable without scrolling back, however long the notes get.
                Ordered so the constructive outcomes come first and Reject is
                last and alone — the §2 principle as layout. */}
            <footer className="cqv-actions">
              <button type="button" className="cqv-act" onClick={() => onOpenScreening?.(c.id, primaryApp?.id)}>
                <ClipboardCheck size={14} /> Screen
              </button>
              <button type="button" className="cqv-act" onClick={() => onConsiderOtherRoles?.(c)}>
                <Shuffle size={14} /> Other roles
              </button>
              <button type="button" className="cqv-act" onClick={() => onAddToTalentBank?.(c)}>
                <Archive size={14} /> Talent Bank
              </button>
              <button type="button" className="cqv-act" onClick={() => onFutureOpportunity?.(c)}>
                <CalendarClock size={14} /> Future
              </button>
              <button type="button" className="cqv-act cqv-act--stop" onClick={() => moveStage('rejected')}>
                <Ban size={14} /> Reject
              </button>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}

function Fact({ icon: Icon, label, value }) {
  // A fact with no value is rendered as "not recorded" rather than omitted. An
  // absent row makes the grid reflow between candidates, and "we do not know this
  // person's notice period" is itself information a recruiter acts on.
  return (
    <div className="cqv-fact">
      <Icon size={13} className="cqv-fact-icon" />
      <div>
        <span className="cqv-fact-label">{label}</span>
        <span className={`cqv-fact-value${value ? '' : ' is-empty'}`}>{value || 'Not recorded'}</span>
      </div>
    </div>
  );
}

function Block({ title, children }) {
  return (
    <section className="cqv-block">
      <h3 className="cqv-block-title">{title}</h3>
      {children}
    </section>
  );
}
