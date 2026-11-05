import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  UserRound, ChevronLeft, ClipboardCheck, Shuffle, Archive, CalendarClock, Ban,
  CalendarPlus, Pin, PinOff, Trash2, Users2, Sparkles, Check, Phone, Mail,
} from 'lucide-react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import { PageHero, PageShell } from '@/components/pulse-ui';
import ResumeViewer from '../shared/components/ResumeViewer';
import { candidateListReturnParams } from '../shared/listReturn';
import {
  ConsiderOtherRolesDialog, TalentBankDialog, FutureOpportunityDialog,
} from '../shared/components/CandidateActionDialogs';
import {
  ACTIVE_STAGES, DEADEND_STAGES, stageLabelShort, stageColor,
  dispositionLabel, dispositionColor, SELECTABLE_DISPOSITIONS,
  noteTypeLabel, noteTypeColor, NOTE_TYPES, NOTE_VISIBILITY_LABELS,
  relocationLabel, relocationColor, relocationOptions, sourceLabel,
  decisionLabel, decisionTone, SCORE_SECTIONS, COMPETENCIES, JUDGEMENTS,
  SUITABILITY_LABELS, SUITABILITY_COLORS, activityTone,
  CLASSIFICATION_LABELS,
} from '../shared/constants';
import './candidate-detail.css';

/**
 * CandidateDetail — the candidate profile, rebuilt around the résumé.
 *
 * ── WHAT WAS WRONG WITH THE OLD ONE ─────────────────────────────────────────
 * Two things, and the first is not a subtlety:
 *
 *  1. It showed NO RÉSUMÉ. `grep resume` over the previous version of this file
 *     returned zero hits — the candidate profile in an applicant tracking system
 *     did not display the applicant's résumé, which §5 makes the central
 *     requirement of the whole screen.
 *
 *  2. Its `PageHero` was titled "Scheduled Interviews" with the subtitle "No
 *     interviews scheduled yet." on every candidate, copy-paste damage from the
 *     Hero rollout. The recruiter's most-used screen was labelled as a different
 *     screen entirely.
 *
 * It also showed six facts about the candidate (email, phone, source, applied-for,
 * stage, status) and nothing else — no experience, location, notice period, CTC,
 * qualification, skills or tags — and its only "notes" were interview feedback.
 *
 * ── THE LAYOUT IS §5's ──────────────────────────────────────────────────────
 * Top bar with the identity and every quick action; résumé filling the large left
 * area; a right rail carrying summary, contact, education, screening, notes,
 * activity and tags. The recruiter reads the résumé and acts on it without the two
 * ever being on different screens.
 *
 * Previous/next candidate is offered when the list handed us an order to walk.
 */

const RAIL_TABS = [
  { id: 'summary',  label: 'Summary' },
  { id: 'notes',    label: 'Notes' },
  { id: 'activity', label: 'Timeline' },
  { id: 'similar',  label: 'Similar' },
];

export default function CandidateDetail({ setPage }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);

  const candidateId = useAppStore(s => s.selectedCandidateId);

  const [candidate, setCandidate] = useState(null);
  const [applications, setApplications] = useState([]);
  const [notes, setNotes] = useState([]);
  const [activity, setActivity] = useState([]);
  const [suitability, setSuitability] = useState([]);
  const [screening, setScreening] = useState(null);
  const [similar, setSimilar] = useState([]);
  const [recontacts, setRecontacts] = useState([]);
  const [meta, setMeta] = useState({ departments: [], pools: [], recruiters: [] });

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('summary');
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  const [noteBody, setNoteBody] = useState('');
  const [noteType, setNoteType] = useState('recruiter');
  const [noteVisibility, setNoteVisibility] = useState('internal');
  const [savingNote, setSavingNote] = useState(false);

  const [editing, setEditing] = useState(false);
  const [profileDraft, setProfileDraft] = useState({});

  const load = useCallback(async () => {
    if (!candidateId) { setLoading(false); return; }
    setLoading(true);
    const results = await Promise.allSettled([
      api.get(`/recruitment/candidates/${candidateId}`),
      api.get(`/recruitment/candidates/${candidateId}/applications`),
      api.get(`/recruitment/candidates/${candidateId}/notes`),
      api.get(`/recruitment/candidates/${candidateId}/activity`),
      api.get(`/recruitment/candidates/${candidateId}/suitability`),
      api.get(`/recruitment/candidates/${candidateId}/screening`),
      api.get(`/recruitment/candidates/${candidateId}/recontact`),
      api.get('/recruitment/meta/candidate-workbench'),
    ]);
    const val = (i, fallback) => (results[i].status === 'fulfilled' ? results[i].value.data : fallback);
    const arr = (i) => { const v = val(i, []); return Array.isArray(v) ? v : []; };

    setCandidate(val(0, null));
    setApplications(arr(1));
    setNotes(arr(2));
    setActivity(arr(3));
    setSuitability(arr(4));
    setScreening(val(5, {})?.screening || null);
    setRecontacts(arr(6));
    setMeta(val(7, {}) || {});
    setLoading(false);
  }, [candidateId]);

  useEffect(() => { load(); }, [load]);

  // Similar candidates load only when that tab is opened. §20 is a useful feature
  // and a comparatively expensive query; running it on every profile view would
  // slow down the 95% of visits that never look at it.
  useEffect(() => {
    if (tab !== 'similar' || !candidateId || similar.length) return;
    api.get(`/recruitment/candidates/${candidateId}/similar`)
      .then(res => setSimilar(Array.isArray(res.data) ? res.data : []))
      .catch(() => setSimilar([]));
  }, [tab, candidateId, similar.length]);

  const moveStage = async (stage) => {
    if (!candidate || busy || stage === candidate.current_stage) return;
    setBusy(true);
    try {
      await api.post(`/recruitment/candidates/${candidate.id}/move-stage`, { new_stage: stage });
      toast(`${candidate.full_name} → ${stageLabelShort(stage)}`);
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not change the stage', 'error');
    } finally { setBusy(false); }
  };

  const moveApplication = async (applicationId, stage) => {
    try {
      await api.post(`/recruitment/applications/${applicationId}/move-stage`, { stage });
      toast(`Moved to ${stageLabelShort(stage)}`);
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not move this application', 'error');
    }
  };

  const setDisposition = async (disposition) => {
    try {
      await api.patch(`/recruitment/candidates/${candidate.id}/profile`, { disposition });
      toast(`Candidate status: ${dispositionLabel(disposition)}`);
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not change the status', 'error');
    }
  };

  const addNote = async () => {
    const body = noteBody.trim();
    if (!body || savingNote) return;
    setSavingNote(true);
    try {
      await api.post(`/recruitment/candidates/${candidate.id}/notes`, {
        body, note_type: noteType, visibility: noteVisibility,
      });
      setNoteBody('');
      toast('Note added');
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not save the note', 'error');
    } finally { setSavingNote(false); }
  };

  const togglePin = async (note) => {
    try {
      await api.put(`/recruitment/candidates/${candidate.id}/notes/${note.id}`, { is_pinned: !note.is_pinned });
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not pin the note', 'error');
    }
  };

  const removeNote = async (note) => {
    // The note is soft-deleted and its "note added" event stays on the timeline,
    // so this is a hide rather than an erasure — worth saying in the prompt so the
    // recruiter is not surprised either way.
    if (!window.confirm('Remove this note? It stops appearing on the profile; the record that it existed stays on the timeline.')) return;
    try {
      await api.delete(`/recruitment/candidates/${candidate.id}/notes/${note.id}`);
      toast('Note removed');
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not remove the note', 'error');
    }
  };

  const saveProfile = async () => {
    try {
      await api.patch(`/recruitment/candidates/${candidate.id}/profile`, profileDraft);
      toast('Profile updated');
      setEditing(false);
      setProfileDraft({});
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not save', 'error');
    }
  };

  const putForward = async (suit, jobOpeningId) => {
    try {
      const res = await api.post(`/recruitment/suitability/${suit.id}/convert`, { job_opening_id: jobOpeningId });
      toast(res?.data?.message || 'Put forward');
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not put them forward', 'error');
    }
  };

  const skills = useMemo(() => (Array.isArray(candidate?.skills) ? candidate.skills : []), [candidate]);
  const tags = useMemo(() => (Array.isArray(candidate?.tags) ? candidate.tags : []), [candidate]);
  const primaryApp = applications.find(a => a.is_primary) || applications[0];
  const pendingRecontact = recontacts.find(r => r.status === 'pending');

  if (!candidateId) {
    return (
      <PageShell dock={<PageHero icon={UserRound} eyebrow="Recruitment" title="Candidate" />}>
        <div className="cd-blank">
          <p>No candidate selected.</p>
          <button type="button" className="cd-btn" onClick={() => setPage?.('Candidates', { tab: 'all' })}>Back to candidates</button>
        </div>
      </PageShell>
    );
  }

  if (loading) {
    return (
      <PageShell dock={<PageHero icon={UserRound} eyebrow="Recruitment" title="Candidate" />}>
        <div className="cd-blank">Loading…</div>
      </PageShell>
    );
  }

  if (!candidate) {
    return (
      <PageShell dock={<PageHero icon={UserRound} eyebrow="Recruitment" title="Candidate" />}>
        <div className="cd-blank">
          <p>Could not load this candidate.</p>
          <button type="button" className="cd-btn" onClick={load}>Try again</button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell dock={
      /* §5's top bar. Titled with the CANDIDATE — the previous version of this
         page was titled "Scheduled Interviews" on every profile. */
      <PageHero
        icon={UserRound}
        eyebrow={`Recruitment · ${candidate.candidate_code || `#${candidate.id}`}`}
        title={candidate.full_name || 'Candidate'}
        subtitle={
          [
            candidate.current_designation,
            candidate.current_company,
            primaryApp ? `applied for ${primaryApp.job_title}` : 'speculative profile',
          ].filter(Boolean).join(' · ')
        }
        meta={[
          { label: 'experience', value: candidate.experience_years != null ? `${candidate.experience_years} yrs` : '—' },
          { label: 'location', value: [candidate.current_city, candidate.current_state].filter(Boolean).join(', ') || candidate.location || '—' },
          { label: 'source', value: sourceLabel(candidate.source) },
          { label: 'notice', value: candidate.notice_period_days != null ? `${candidate.notice_period_days}d` : '—' },
        ]}
        actions={
          <>
            <button type="button" className="plh-cta" onClick={() => setPage?.('Candidates', candidateListReturnParams())}>
              <ChevronLeft size={14} /> Candidates
            </button>
            <button type="button" className="plh-cta" onClick={() => setPage?.('CandidateScreening')}>
              <ClipboardCheck size={14} /> Screen
            </button>
            <button type="button" className="plh-cta" onClick={() => setDialog('roles')}>
              <Shuffle size={14} /> Other roles
            </button>
            <button type="button" className="plh-cta" onClick={() => setDialog('bank')}>
              <Archive size={14} /> Talent Bank
            </button>
            <button type="button" className="plh-cta" onClick={() => setDialog('future')}>
              <CalendarClock size={14} /> Future
            </button>
          </>
        }
      />
    }>
      {/* ── Status strip ─────────────────────────────────────────────────── */}
      <div className="cd-strip">
        <label className="cd-strip-field">
          <span>Candidate status</span>
          <select
            className="cd-sel"
            value={candidate.disposition || 'new'}
            onChange={(e) => setDisposition(e.target.value)}
            style={dispositionColor(candidate.disposition)}
          >
            {SELECTABLE_DISPOSITIONS.map(d => <option key={d} value={d}>{dispositionLabel(d)}</option>)}
          </select>
        </label>

        <label className="cd-strip-field">
          <span>Pipeline stage</span>
          <select
            className="cd-sel"
            value={candidate.current_stage || 'applied'}
            disabled={busy}
            onChange={(e) => moveStage(e.target.value)}
            style={stageColor(candidate.current_stage)}
          >
            <optgroup label="In the pipeline">
              {ACTIVE_STAGES.map(s => <option key={s} value={s}>{stageLabelShort(s)}</option>)}
            </optgroup>
            <optgroup label="Parked — candidate stays in the system">
              {DEADEND_STAGES.map(s => <option key={s} value={s}>{stageLabelShort(s)}</option>)}
            </optgroup>
          </select>
        </label>

        <label className="cd-strip-field">
          <span>Recruiter</span>
          <select
            className="cd-sel"
            value={candidate.recruiter_id || ''}
            onChange={async (e) => {
              try {
                await api.patch(`/recruitment/candidates/${candidate.id}/profile`, {
                  recruiter_id: e.target.value === '' ? '' : parseInt(e.target.value, 10),
                });
                toast('Recruiter updated');
                load();
              } catch (err) { toast(err?.response?.data?.error || 'Could not assign', 'error'); }
            }}
          >
            <option value="">Unassigned</option>
            {meta.recruiters?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>

        <div className="cd-strip-right">
          {candidate.phone && (
            <a className="cd-contact" href={`tel:${candidate.phone}`}><Phone size={13} /> {candidate.phone}</a>
          )}
          {candidate.email && (
            <a className="cd-contact" href={`mailto:${candidate.email}`}><Mail size={13} /> {candidate.email}</a>
          )}
        </div>
      </div>

      {pendingRecontact && (
        <div className="cd-banner cd-banner--keep">
          <CalendarClock size={14} />
          <span>
            Future opportunity — recontact on <strong>{fmtDate(pendingRecontact.recontact_on)}</strong>
            {pendingRecontact.potential_role ? ` about ${pendingRecontact.potential_role}` : ''}
            {pendingRecontact.days_until_due <= 0 ? ' · due now' : ` · in ${pendingRecontact.days_until_due} days`}
          </span>
          <button
            type="button" className="cd-banner-btn"
            onClick={async () => {
              try {
                await api.post(`/recruitment/recontacts/${pendingRecontact.id}/complete`, {
                  status: 'done', reengage: true,
                });
                toast('Marked as recontacted and back in active consideration');
                load();
              } catch (e) { toast(e?.response?.data?.error || 'Could not update', 'error'); }
            }}
          >
            <Check size={12} /> Recontacted — bring back
          </button>
        </div>
      )}

      {/* ── §5's main area: résumé left, rail right ──────────────────────── */}
      <div className="cd-main">
        <div className="cd-resume">
          <ResumeViewer candidate={candidate} minHeight={640} />
        </div>

        <aside className="cd-rail">
          <nav className="cd-tabs" role="tablist">
            {RAIL_TABS.map(t => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`cd-tab${tab === t.id ? ' is-on' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === 'notes' && notes.length > 0 && <span className="cd-tab-n">{notes.length}</span>}
              </button>
            ))}
          </nav>

          {/* ── Summary ─────────────────────────────────────────────────── */}
          {tab === 'summary' && (
            <div className="cd-pane">
              <Card
                title="Candidate summary"
                action={
                  editing
                    ? <><button type="button" className="cd-mini" onClick={() => { setEditing(false); setProfileDraft({}); }}>Cancel</button>
                        <button type="button" className="cd-mini cd-mini--go" onClick={saveProfile}>Save</button></>
                    : <button type="button" className="cd-mini" onClick={() => setEditing(true)}>Edit</button>
                }
              >
                {editing ? (
                  <div className="cd-edit">
                    <EditField label="Current city" value={profileDraft.current_city ?? candidate.current_city ?? ''}
                               onChange={v => setProfileDraft(d => ({ ...d, current_city: v }))} />
                    <EditField label="Current state" value={profileDraft.current_state ?? candidate.current_state ?? ''}
                               onChange={v => setProfileDraft(d => ({ ...d, current_state: v }))} />
                    <EditField label="Native place" value={profileDraft.native_place ?? candidate.native_place ?? ''}
                               onChange={v => setProfileDraft(d => ({ ...d, native_place: v }))} />
                    <EditField label="Relevant experience (yrs)" type="number"
                               value={profileDraft.relevant_experience_years ?? candidate.relevant_experience_years ?? ''}
                               onChange={v => setProfileDraft(d => ({ ...d, relevant_experience_years: v }))} />
                    <div className="cd-edit-field">
                      <span>Willing to relocate</span>
                      <select className="cd-sel cd-sel--full"
                              value={profileDraft.willing_to_relocate ?? candidate.willing_to_relocate ?? 'unknown'}
                              onChange={e => setProfileDraft(d => ({ ...d, willing_to_relocate: e.target.value }))}>
                        {relocationOptions().map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div className="cd-edit-field">
                      <span>Classification</span>
                      <select className="cd-sel cd-sel--full"
                              value={profileDraft.classification ?? candidate.classification ?? ''}
                              onChange={e => setProfileDraft(d => ({ ...d, classification: e.target.value }))}>
                        <option value="">Not classified</option>
                        {Object.entries(CLASSIFICATION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </div>
                    <div className="cd-edit-field cd-edit-field--wide">
                      <span>Relocation note — only what the candidate volunteered</span>
                      <textarea className="cd-textarea" rows={2}
                                value={profileDraft.relocation_note ?? candidate.relocation_note ?? ''}
                                onChange={e => setProfileDraft(d => ({ ...d, relocation_note: e.target.value }))} />
                    </div>
                  </div>
                ) : (
                  <>
                    <dl className="cd-facts">
                      <Fact label="Candidate ID" value={candidate.candidate_code} />
                      <Fact label="Total experience" value={candidate.experience_years != null ? `${candidate.experience_years} yrs` : null} />
                      <Fact label="Relevant experience" value={candidate.relevant_experience_years != null ? `${candidate.relevant_experience_years} yrs` : null} />
                      <Fact label="Current company" value={candidate.current_company} />
                      <Fact label="Current designation" value={candidate.current_designation} />
                      <Fact label="Current city" value={candidate.current_city || candidate.location} />
                      <Fact label="Current state" value={candidate.current_state} />
                      <Fact label="Native place" value={candidate.native_place} />
                      <Fact label="Notice period" value={candidate.notice_period_days != null ? `${candidate.notice_period_days} days` : null} />
                      <Fact label="Current salary" value={candidate.current_salary != null ? Number(candidate.current_salary).toLocaleString('en-IN') : null} />
                      <Fact label="Expected CTC" value={candidate.expected_ctc != null ? Number(candidate.expected_ctc).toLocaleString('en-IN') : null} />
                      <Fact label="Classification" value={CLASSIFICATION_LABELS[candidate.classification]} />
                      <Fact label="Qualification" value={candidate.qualification} />
                      <Fact label="Specialisation" value={candidate.specialisation} />
                      <Fact label="Institution" value={candidate.institution} />
                      <Fact label="Graduation year" value={candidate.graduation_year} />
                    </dl>

                    <div className="cd-relo">
                      <span className="cd-chip" style={relocationColor(candidate.willing_to_relocate)}>
                        {relocationLabel(candidate.willing_to_relocate)}
                      </span>
                      {candidate.relocation_support_required && (
                        <span className="cd-chip cd-chip--dim">Relocation support required</span>
                      )}
                      {candidate.relocation_note && <p className="cd-relo-note">{candidate.relocation_note}</p>}
                    </div>

                    {skills.length > 0 && (
                      <div className="cd-taglist">
                        <span className="cd-taglist-label">Skills</span>
                        {skills.map(s => <span key={s} className="cd-chip cd-chip--skill">{s}</span>)}
                      </div>
                    )}
                    {tags.length > 0 && (
                      <div className="cd-taglist">
                        <span className="cd-taglist-label">Tags</span>
                        {tags.map(t => <span key={t} className="cd-chip cd-chip--dim">{t}</span>)}
                      </div>
                    )}
                  </>
                )}
              </Card>

              {/* ── Applications ───────────────────────────────────────── */}
              <Card title={`Applications (${applications.length})`}>
                {applications.length === 0 ? (
                  <p className="cd-muted">
                    Not linked to any opening — a speculative profile. Use <strong>Other roles</strong>
                    {' '}to record where they would fit.
                  </p>
                ) : applications.map(a => (
                  <div key={a.id} className="cd-app">
                    <div className="cd-app-main">
                      <span className="cd-app-title">
                        {a.job_title}
                        {a.is_primary && <span className="cd-tagline">original</span>}
                        {a.origin === 'recommended' && <span className="cd-tagline cd-tagline--route">recommended</span>}
                      </span>
                      <span className="cd-app-sub">
                        {a.department || '—'}{a.location ? ` · ${a.location}` : ''}
                        {a.recommended_from_title ? ` · put forward from ${a.recommended_from_title}` : ''}
                      </span>
                      {a.notes && <p className="cd-app-note">{a.notes}</p>}
                    </div>
                    <select
                      className="cd-sel cd-sel--sm"
                      value={a.stage}
                      onChange={(e) => moveApplication(a.id, e.target.value)}
                      style={stageColor(a.stage)}
                      aria-label={`Stage for the ${a.job_title} application`}
                    >
                      <optgroup label="In the pipeline">
                        {ACTIVE_STAGES.map(s => <option key={s} value={s}>{stageLabelShort(s)}</option>)}
                      </optgroup>
                      <optgroup label="Parked">
                        {DEADEND_STAGES.map(s => <option key={s} value={s}>{stageLabelShort(s)}</option>)}
                      </optgroup>
                    </select>
                  </div>
                ))}
              </Card>

              {/* ── Screening (§14's breakdown) ────────────────────────── */}
              <Card
                title="Stage 1 screening"
                action={
                  <button type="button" className="cd-mini" onClick={() => setPage?.('CandidateScreening')}>
                    {screening ? 'Open' : 'Start'}
                  </button>
                }
              >
                {!screening ? (
                  <p className="cd-muted">Not screened yet.</p>
                ) : (
                  <>
                    <div className="cd-score">
                      <span className="cd-score-num">{screening.total_score ?? '—'}<em>/100</em></span>
                      <div className="cd-score-side">
                        <span className="cd-chip cd-chip--dim">
                          {screening.status === 'completed' ? 'Completed' : 'Draft'}
                        </span>
                        {screening.decision && (
                          <span className="cd-chip" style={decisionTone(screening.decision)}>
                            {decisionLabel(screening.decision)}
                          </span>
                        )}
                      </div>
                    </div>
                    {screening.recommendation && screening.decision
                      && screening.recommendation !== screening.decision && (
                      <p className="cd-override">
                        Scorecard suggested <strong>{decisionLabel(screening.recommendation)}</strong>;
                        the recruiter chose otherwise.
                        {screening.override_reason ? ` “${screening.override_reason}”` : ''}
                      </p>
                    )}
                    <ul className="cd-bd">
                      {SCORE_SECTIONS.map(({ key, label, weight }) => {
                        const b = screening.score_breakdown?.[key];
                        return (
                          <li key={key} className={b?.assessed ? '' : 'is-unassessed'}>
                            <span>{label}</span>
                            <span>{b?.assessed ? `${b.scored}/${weight}` : `—/${weight}`}</span>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="cd-ratings">
                      {[...JUDGEMENTS, ...COMPETENCIES].map(({ key, label }) => (
                        <div key={key} className="cd-rating">
                          <span>{label}</span>
                          <span className="cd-dots" aria-label={`${label}: ${screening[key] ?? 'not rated'} of 5`}>
                            {[1, 2, 3, 4, 5].map(n => <i key={n} className={n <= (screening[key] || 0) ? 'on' : ''} />)}
                          </span>
                        </div>
                      ))}
                    </div>
                    {screening.summary_note && <p className="cd-quote">{screening.summary_note}</p>}
                    {screening.reject_reason && (
                      <p className="cd-quote cd-quote--bad">Reject reason: {screening.reject_reason}</p>
                    )}
                  </>
                )}
              </Card>

              {/* ── Other roles (§16/§27) ──────────────────────────────── */}
              <Card
                title="Also suited to"
                action={<button type="button" className="cd-mini" onClick={() => setDialog('roles')}>Add</button>}
              >
                {suitability.length === 0 ? (
                  <p className="cd-muted">
                    No alternative roles recorded. If they are wrong for this opening but right for
                    Manifest, this is where that gets remembered.
                  </p>
                ) : suitability.map(s => (
                  <div key={s.department} className="cd-suit">
                    <div className="cd-suit-main">
                      <span className="cd-suit-dept">
                        {s.department}
                        <span className="cd-chip cd-chip--xs" style={SUITABILITY_COLORS[s.suitability]}>
                          {SUITABILITY_LABELS[s.suitability]}
                        </span>
                        {s.status === 'actioned' && <span className="cd-tagline">put forward</span>}
                      </span>
                      {s.reason && <p className="cd-suit-reason">{s.reason}</p>}
                      <span className="cd-suit-meta">
                        {s.identified_by_name ? `${s.identified_by_name} · ` : ''}{fmtDate(s.identified_at)}
                        {s.identified_from_title ? ` · from ${s.identified_from_title}` : ''}
                      </span>
                    </div>
                    {/* The whole point of the record: when a vacancy exists in that
                        department, turn the judgement into an application without
                        creating a second candidate. */}
                    {s.open_openings > 0 && s.status !== 'actioned' && (
                      <OpeningPicker
                        department={s.department}
                        onPick={(jobId) => putForward(s, jobId)}
                      />
                    )}
                  </div>
                ))}
              </Card>
            </div>
          )}

          {/* ── Notes (§9) ──────────────────────────────────────────────── */}
          {tab === 'notes' && (
            <div className="cd-pane">
              <Card title="Add a note">
                <textarea
                  className="cd-textarea"
                  rows={4}
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value)}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); addNote(); } }}
                  placeholder="Strong electrical fundamentals. No direct AHF experience. Good troubleshooting approach. Consider for Testing or Service."
                />
                <div className="cd-note-actions">
                  <select className="cd-sel cd-sel--sm" value={noteType} onChange={(e) => setNoteType(e.target.value)} aria-label="Note type">
                    {NOTE_TYPES.map(t => <option key={t} value={t}>{noteTypeLabel(t)}</option>)}
                  </select>
                  <select className="cd-sel cd-sel--sm" value={noteVisibility} onChange={(e) => setNoteVisibility(e.target.value)} aria-label="Who can see this note">
                    {Object.entries(NOTE_VISIBILITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <button type="button" className="cd-btn cd-btn--primary" onClick={addNote} disabled={savingNote || !noteBody.trim()}>
                    {savingNote ? 'Saving…' : 'Add note'}
                  </button>
                  <span className="cd-kbd-hint">Ctrl + Enter</span>
                </div>
                <p className="cd-note-hint">
                  A note stays with the candidate, not with this application — it will still be here
                  when they apply for something else.
                </p>
              </Card>

              {notes.length === 0
                ? <Card title="Notes"><p className="cd-muted">No notes yet.</p></Card>
                : notes.map(n => (
                  <div key={n.id} className={`cd-note${n.is_pinned ? ' is-pinned' : ''}`}>
                    <div className="cd-note-head">
                      <span className="cd-chip cd-chip--xs" style={noteTypeColor(n.note_type)}>
                        {noteTypeLabel(n.note_type)}
                      </span>
                      {n.visibility !== 'internal' && (
                        <span className="cd-chip cd-chip--xs cd-chip--dim">
                          {NOTE_VISIBILITY_LABELS[n.visibility]}
                        </span>
                      )}
                      {n.application_job_title && (
                        <span className="cd-chip cd-chip--xs cd-chip--dim">{n.application_job_title}</span>
                      )}
                      <span className="cd-note-meta">
                        {n.author_name || 'Unknown'} · {fmtDate(n.created_at)}
                        {/* A note whose text was changed after the fact is a
                            different kind of evidence from one that was not. */}
                        {n.edited_at && <em> · edited {fmtDate(n.edited_at)}</em>}
                      </span>
                      <span className="cd-note-tools">
                        <button type="button" className="cd-icon" onClick={() => togglePin(n)} title={n.is_pinned ? 'Unpin' : 'Pin'}>
                          {n.is_pinned ? <PinOff size={12} /> : <Pin size={12} />}
                        </button>
                        <button type="button" className="cd-icon" onClick={() => removeNote(n)} title="Remove">
                          <Trash2 size={12} />
                        </button>
                      </span>
                    </div>
                    <p className="cd-note-body">{n.body}</p>
                  </div>
                ))}
            </div>
          )}

          {/* ── Timeline (§21) ─────────────────────────────────────────── */}
          {tab === 'activity' && (
            <div className="cd-pane">
              <Card title={`Activity timeline (${activity.length})`}>
                {activity.length === 0 ? (
                  <p className="cd-muted">Nothing recorded yet.</p>
                ) : (
                  <ol className="cd-timeline">
                    {activity.map((e, i) => (
                      <li key={e.id || `${e.created_at}-${i}`}>
                        <span className="cd-tl-dot" style={{ background: activityTone(e.event_type).dot }} />
                        <div className="cd-tl-body">
                          <p className="cd-tl-summary">{e.summary}</p>
                          <p className="cd-tl-meta">
                            {new Date(e.created_at).toLocaleString('en-GB', {
                              day: '2-digit', month: 'short', year: 'numeric',
                              hour: '2-digit', minute: '2-digit',
                            })}
                            {e.actor_name ? ` · ${e.actor_name}` : ''}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                <p className="cd-note-hint">
                  The timeline is append-only — there is no edit or delete for it anywhere in Pulse.
                  A mistake is corrected by recording a correction.
                </p>
              </Card>
            </div>
          )}

          {/* ── Similar (§20) ──────────────────────────────────────────── */}
          {tab === 'similar' && (
            <div className="cd-pane">
              <Card title="Similar candidates">
                {similar.length === 0 ? (
                  <p className="cd-muted">
                    No comparable candidates found. Matching uses qualification, specialisation,
                    skills, experience band, current role, employer and location.
                  </p>
                ) : similar.map(s => (
                  <div key={s.id} className="cd-similar">
                    <div className="cd-similar-head">
                      <button
                        type="button"
                        className="cd-similar-name"
                        onClick={() => { useAppStore.getState().setSelectedCandidateId(s.id); setTab('summary'); setSimilar([]); }}
                      >
                        {s.full_name}
                      </button>
                      <span className="cd-chip cd-chip--xs" style={stageColor(s.current_stage)}>
                        {stageLabelShort(s.current_stage)}
                      </span>
                    </div>
                    <p className="cd-similar-sub">
                      {[s.current_designation, s.current_company].filter(Boolean).join(' · ') || '—'}
                    </p>
                    {/* §20: "Do NOT show an unexplained AI score as the only
                        information." Every reason the match was made is listed,
                        and the score is secondary to them. */}
                    <ul className="cd-why">
                      {s.reasons.map(r => (
                        <li key={r}><Check size={11} /> {r}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </Card>
            </div>
          )}
        </aside>
      </div>

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}
      {dialog === 'roles' && (
        <ConsiderOtherRolesDialog
          candidate={candidate}
          departments={meta.departments || []}
          existing={suitability}
          onClose={() => setDialog(null)}
          onSaved={load}
        />
      )}
      {dialog === 'bank' && (
        <TalentBankDialog
          candidate={candidate}
          pools={meta.pools || []}
          onClose={() => setDialog(null)}
          onSaved={load}
        />
      )}
      {dialog === 'future' && (
        <FutureOpportunityDialog
          candidate={candidate}
          departments={meta.departments || []}
          onClose={() => setDialog(null)}
          onSaved={load}
        />
      )}
    </PageShell>
  );
}

/* ── Small pieces ───────────────────────────────────────────────────────── */

function Card({ title, action, children }) {
  return (
    <section className="cd-card">
      <header className="cd-card-head">
        <h3>{title}</h3>
        {action && <div className="cd-card-action">{action}</div>}
      </header>
      {children}
    </section>
  );
}

function Fact({ label, value }) {
  // Rendered even when empty. "We do not know this person's notice period" is
  // itself something a recruiter acts on, and an omitted row makes the grid
  // reflow differently on every candidate.
  return (
    <div className="cd-fact">
      <dt>{label}</dt>
      <dd className={value ? '' : 'is-empty'}>{value || 'Not recorded'}</dd>
    </div>
  );
}

function EditField({ label, value, onChange, type = 'text' }) {
  return (
    <div className="cd-edit-field">
      <span>{label}</span>
      <input className="cd-input" type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/**
 * Pick which open vacancy in a department to put the candidate forward for.
 *
 * Loaded on demand rather than with the profile: most suitability rows never get
 * converted, and fetching the openings for every department on every profile view
 * would be several queries for a button nobody pressed.
 */
function OpeningPicker({ department, onPick }) {
  const [openings, setOpenings] = useState(null);
  const [open, setOpen] = useState(false);

  const loadOpenings = async () => {
    setOpen(true);
    if (openings) return;
    try {
      const res = await api.get('/recruitment/openings', { params: { status: 'open' } });
      const list = Array.isArray(res.data) ? res.data : (res.data?.rows || []);
      setOpenings(list.filter(o => String(o.department || '').toLowerCase() === String(department).toLowerCase()));
    } catch { setOpenings([]); }
  };

  if (!open) {
    return (
      <button type="button" className="cd-mini cd-mini--go" onClick={loadOpenings}>
        <CalendarPlus size={12} /> Put forward
      </button>
    );
  }

  return (
    <select
      className="cd-sel cd-sel--sm"
      defaultValue=""
      onChange={(e) => { if (e.target.value) onPick(parseInt(e.target.value, 10)); }}
      aria-label={`Open ${department} roles`}
    >
      <option value="">{openings === null ? 'Loading…' : openings.length ? 'Pick an opening…' : 'No open roles'}</option>
      {(openings || []).map(o => <option key={o.id} value={o.id}>{o.job_title}</option>)}
    </select>
  );
}
