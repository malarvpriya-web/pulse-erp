import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ListChecks, ClipboardCheck, CalendarDays, MessageSquareWarning, Clock,
  FileSignature, UserPlus, CalendarClock, Shuffle, Archive, UserCog, Inbox, Star, Video,
} from 'lucide-react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
// The signed-in user lives in AuthContext, NOT in useAppStore — the store holds
// page/selection state only, so `useAppStore(s => s.user)` is always undefined and
// the greeting silently degraded to "Good morning, there".
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { PutForwardDialog } from '../shared/components/CandidateActionDialogs';
import './recruitment-work-queue.css';

/**
 * RecruitmentWorkQueue — §23's "My Recruitment Work".
 *
 * ── WHY THIS IS THE MODULE'S HOME AND THE DASHBOARD IS NOT ──────────────────
 * §25 puts it plainly: "Recruiters need action more than charts. Do not make the
 * first screen a wall of 20 charts." The priority order it gives is Work Queue,
 * Candidate List, Candidate Profile, Screening, Status, Notes, Talent Bank, and
 * only then Analytics.
 *
 * So this screen contains no charts at all. It is a list of numbers, every one of
 * which is a question a recruiter can act on this morning, and every one of which
 * is a link that lands on exactly the candidates it counted — the filter is
 * carried in the URL, so "8 candidates have been waiting more than 3 days" opens
 * those eight and nothing else.
 *
 * ── THE NUMBERS ARE MEASURED FROM THE RIGHT COLUMN ─────────────────────────
 * "Waiting more than 3 days" counts from `last_activity_at`, not `created_at`.
 * The previous recruiter dashboard measured age while its own comment claimed it
 * measured staleness, so a candidate interviewed yesterday could be reported as
 * waiting thirty days. That column exists because of this screen.
 */

/**
 * Each tile carries the filter that reproduces its own count.
 *
 * Written as the workbench's URL params so a click lands on a list that is
 * genuinely the same set — not an approximation of it. A tile whose link shows a
 * different number than the tile did is worse than no link.
 */
const TILES = [
  {
    key: 'needs_screening',
    label: 'need screening',
    detail: 'Applied or in screening, with no completed Stage 1',
    icon: ClipboardCheck,
    tone: 'act',
    to: { page: 'Candidates', params: { tab: 'all', queue: 'needs_screening' } },
  },
  {
    key: 'interviews_today',
    label: 'interviews today',
    detail: 'Still scheduled for today',
    icon: CalendarDays,
    tone: 'today',
    // `date` is filled in at click time — see go().
    to: { page: 'InterviewCenter', params: { tab: 'schedule', status: 'scheduled', date: 'TODAY' } },
  },
  {
    key: 'feedback_pending',
    label: 'feedbacks pending',
    detail: 'Interviews that have happened with no feedback recorded',
    icon: MessageSquareWarning,
    tone: 'warn',
    // Listed on this page (the schedule has no "no feedback" filter).
    to: { anchor: 'wq-feedback-due' },
  },
  {
    key: 'waiting_over_3_days',
    label: 'waiting more than 3 days',
    detail: 'Live candidates nobody has moved in 3+ days',
    icon: Clock,
    tone: 'warn',
    to: { page: 'Candidates', params: { tab: 'all', queue: 'waiting_over_3_days' } },
  },
  {
    key: 'offers_pending',
    label: 'offers pending',
    detail: 'Drafted, awaiting approval or sent — not yet answered',
    icon: FileSignature,
    tone: 'act',
    to: { page: 'OnboardingCenter', params: { tab: 'offers', status: 'unanswered' } },
  },
  {
    key: 'joining_pending',
    label: 'joining pending',
    detail: 'Selected or at offer, not yet joined',
    icon: UserPlus,
    tone: 'go',
    to: { page: 'Candidates', params: { tab: 'all', queue: 'joining_pending' } },
  },
  {
    key: 'recontact_due',
    label: 'due for recontact',
    detail: 'Future opportunities whose date has arrived',
    icon: CalendarClock,
    tone: 'keep',
    to: { page: 'TalentBank' },
  },
  {
    key: 'recommended_for_other_roles',
    label: 'suited to a role we are hiring for',
    detail: 'Recorded as suiting a department that has an open vacancy right now',
    icon: Shuffle,
    tone: 'route',
    to: { page: 'Candidates', params: { tab: 'all', queue: 'recommended_for_other_roles' } },
  },
  {
    key: 'talent_bank_size',
    label: 'in the Talent Bank',
    detail: 'Kept for future openings',
    icon: Archive,
    tone: 'keep',
    to: { page: 'TalentBank' },
  },
  {
    key: 'unassigned',
    label: 'unassigned',
    detail: 'Live candidates with no recruiter accountable',
    icon: UserCog,
    tone: 'warn',
    to: { page: 'Candidates', params: { tab: 'all', queue: 'unassigned' } },
  },
];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Browser-local YYYY-MM-DD (the business runs on IST; en-CA formats as ISO). */
function todayIso() {
  return new Date().toLocaleDateString('en-CA');
}

const roundLabel = (r) => (r ? String(r).replace(/_/g, ' ') : null);

export default function RecruitmentWorkQueue({ setPage, embedded = false }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);
  const { user, hasPermission } = useAuth();
  // "Contacted — bring back" is an edit (POST /recontacts/:id/complete is gated
  // recruitment:edit). A view-only user would otherwise click it and get a 403.
  const canEdit = typeof hasPermission === 'function' ? hasPermission('recruitment', 'edit') : true;
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);

  const [counts, setCounts] = useState(null);
  const [recontacts, setRecontacts] = useState([]);
  const [feedbackDue, setFeedbackDue] = useState([]);
  const [myInterviews, setMyInterviews] = useState([]);
  const [feedbackFor, setFeedbackFor] = useState(null);   // interview row
  const [fb, setFb] = useState({ rating: '', recommendation: '', comments: '' });
  const [savingFb, setSavingFb] = useState(false);
  const [bringing, setBringing] = useState(null);         // recontact id in flight
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/recruitment/work-queue');
      setCounts(res.data?.counts || {});
      setRecontacts(res.data?.recontacts_due || []);
      setFeedbackDue(res.data?.feedback_due || []);
      setMyInterviews(res.data?.my_interviews || []);
    } catch (e) {
      if (e?.code === 'ERR_CANCELED') return;
      setError(e?.response?.data?.error || 'Could not load your work queue.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Escape closes the feedback dialog.
  useEffect(() => {
    if (!feedbackFor) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !savingFb) setFeedbackFor(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [feedbackFor, savingFb]);

  const saveFeedback = async () => {
    if (!fb.recommendation) return toast('Choose your recommendation', 'error');
    if (fb.rating !== '' && !(Number(fb.rating) >= 1 && Number(fb.rating) <= 5)) {
      return toast('Rating must be between 1 and 5', 'error');
    }
    setSavingFb(true);
    try {
      // The panel endpoint, not the generic /interview-notes: it checks the caller
      // is the lead or on the panel, refuses a cancelled or future interview,
      // updates instead of duplicating, refreshes the candidate's rating and
      // writes the timeline + audit entries.
      await api.post(`/my-interviews/${feedbackFor.id}/feedback`, {
        rating: fb.rating === '' ? null : Number(fb.rating),
        recommendation: fb.recommendation,
        comments: fb.comments || null,
      });
      toast('Your feedback is saved on the candidate profile');
      setFeedbackFor(null);
      load();
    } catch (e) { toast(e?.response?.data?.error || 'Could not save the feedback', 'error'); }
    finally { setSavingFb(false); }
  };

  // "Contacted" only records the call. Bringing someone back into hiring means
  // putting them forward for an open job (PutForwardDialog), which also closes
  // the reminder — the old "bring back" set them active with no job and left
  // them parked in Future use.
  const markContacted = async (rc) => {
    setBringing(rc.id);
    try {
      await api.post(`/recruitment/recontacts/${rc.id}/complete`, { status: 'done', reengage: false });
      toast(`${rc.full_name} marked as contacted`);
      load();
    } catch (e) { toast(e?.response?.data?.error || 'Could not update', 'error'); }
    finally { setBringing(null); }
  };
  const [forwarding, setForwarding] = useState(null);

  const go = (to) => {
    if (to?.anchor) {
      document.getElementById(to.anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (!to?.page) return;
    const params = to.params ? { ...to.params } : undefined;
    if (params?.date === 'TODAY') params.date = todayIso();
    setPage?.(to.page, params);
  };

  const openCandidate = (id) => { setSelectedCandidateId(id); setPage?.('CandidateDetail'); };

  const firstName = useMemo(() => {
    // Same fallback chain Topbar.jsx uses for the avatar name, so the two agree.
    const n = user?.name || user?.username || user?.email?.split('@')[0] || '';
    const first = String(n).trim().split(/[\s.]+/)[0];
    return first || 'there';
  }, [user]);

  // Only tiles with something on them, plus the two that are informational even at
  // zero. A grid of ten zeros teaches the recruiter to stop reading it, which is
  // the failure mode §25 is warning about in a different form.
  const ALWAYS_SHOWN = new Set(['needs_screening', 'talent_bank_size']);
  const visible = TILES.filter(t => ALWAYS_SHOWN.has(t.key) || (counts?.[t.key] ?? 0) > 0);
  const quietTiles = TILES.filter(t => !visible.includes(t));

  const totalActions = useMemo(() => {
    if (!counts) return 0;
    return ['needs_screening', 'feedback_pending', 'waiting_over_3_days', 'recontact_due', 'offers_pending']
      .reduce((n, k) => n + (counts[k] || 0), 0);
  }, [counts]);

  const body = (
    <div className="wq">
      <header className="wq-hello">
        <h2>{greeting()}, {firstName}</h2>
        <p>
          {loading ? 'Loading your queue…'
            : error ? 'The work queue did not load.'
            : totalActions === 0
              ? 'Nothing is waiting on the recruiting team. Good place to be.'
              : `${totalActions} thing${totalActions === 1 ? '' : 's'} waiting on the recruiting team.`}
        </p>
      </header>

      {/* On a failed load, say so and offer a retry — never a grid of zeros and a
          "Nothing pending" line, which reads as an all-clear. */}
      {error && !loading && (
        <div className="wq-error" role="alert">
          <span>{error}</span>
          <button type="button" className="pulse-btn-secondary" onClick={load}>Try again</button>
        </div>
      )}

      {!error && (
        <>
          {/* ── §23's clickable numbers (whole company) ───────────────────── */}
          <div className="wq-tiles">
            {visible.map(({ key, label, detail, icon: Icon, tone, to }) => {
              const n = counts?.[key] ?? 0;
              return (
                <button
                  key={key}
                  type="button"
                  className={`wq-tile wq-tile--${tone}${n === 0 ? ' is-zero' : ''}`}
                  onClick={() => go(to)}
                  disabled={loading}
                >
                  <Icon size={16} className="wq-tile-icon" />
                  <span className="wq-tile-n">{loading ? '·' : n}</span>
                  <span className="wq-tile-label">{label}</span>
                  <span className="wq-tile-detail">{detail}</span>
                </button>
              );
            })}
          </div>

          {/* Everything at zero is collapsed into one honest line rather than hidden
              entirely — a recruiter should be able to tell "nothing pending" from
              "this panel is broken". */}
          {!loading && quietTiles.length > 0 && (
            <p className="wq-quiet">
              Nothing pending in: {quietTiles.map(t => t.label).join(', ')}.
            </p>
          )}

          {/* ── My own work ─────────────────────────────────────────────── */}
          <div className="wq-mine">
            <button type="button" className="wq-mine-btn"
                    onClick={() => go({ page: 'Candidates', params: { tab: 'all', rec: 'me', queue: 'live' } })}>
              <Inbox size={14} />
              <strong>{counts?.assigned_to_me ?? 0}</strong> in the pipeline, assigned to me
            </button>
            <button type="button" className="wq-mine-btn"
                    onClick={() => go({ page: 'Candidates', params: { tab: 'all' } })}>
              <ListChecks size={14} />
              Open the full candidate list
            </button>
            {(counts?.my_draft_screenings ?? 0) > 0 && (
              <span className="wq-mine-note">
                You have {counts.my_draft_screenings} screening{counts.my_draft_screenings === 1 ? '' : 's'} saved as a draft.
              </span>
            )}
          </div>
        </>
      )}

      {/* ── Interviews I am on (lead or panel) ─────────────────────────────── */}
      {myInterviews.length > 0 && (
        <section className="wq-panel">
          <header className="wq-panel-head">
            <CalendarDays size={15} />
            <h3>My interviews</h3>
            <button type="button" className="wq-panel-link" onClick={() => go({ page: 'MyInterviews' })}>All my interviews</button>
          </header>
          <div className="wq-rows">
            {myInterviews.map(iv => (
              <div key={iv.id} className="wq-row">
                <div className="wq-row-main">
                  <button type="button" className="wq-row-name" onClick={() => openCandidate(iv.candidate_id)}>
                    {iv.candidate_name}
                  </button>
                  <span className="wq-row-sub">
                    {[iv.job_title, roundLabel(iv.interview_round)].filter(Boolean).join(' · ')}
                    {' · '}{fmtDate(iv.interview_date)}{iv.interview_time ? ` ${String(iv.interview_time).slice(0, 5)}` : ''}
                    {iv.is_lead ? ' · you lead' : ' · panel'}
                  </span>
                </div>
                <div className="wq-row-acts">
                  {iv.meeting_link && /^https?:\/\//i.test(iv.meeting_link) && (
                    <a className="wq-row-link" href={iv.meeting_link} target="_blank" rel="noopener noreferrer"><Video size={12} /> Join</a>
                  )}
                  {iv.my_feedback_given
                    ? <span className="wq-row-sub">Feedback given</span>
                    : iv.is_future
                      ? <span className="wq-row-sub">Feedback opens on the day</span>
                      : <button type="button" className="wq-row-btn" onClick={() => { setFb({ rating: '', recommendation: '', comments: '' }); setFeedbackFor(iv); }}>
                          <Star size={12} /> My feedback
                        </button>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Feedback still owed (whole company) ─────────────────────────── */}
      {feedbackDue.length > 0 && (
        <section className="wq-panel" id="wq-feedback-due">
          <header className="wq-panel-head">
            <MessageSquareWarning size={15} />
            <h3>Interviews with no feedback yet</h3>
            <button type="button" className="wq-panel-link" onClick={() => go({ page: 'InterviewCenter', params: { tab: 'schedule' } })}>Open the schedule</button>
          </header>
          <div className="wq-rows">
            {feedbackDue.map(iv => (
              <div key={iv.id} className="wq-row">
                <div className="wq-row-main">
                  <button type="button" className="wq-row-name" onClick={() => openCandidate(iv.candidate_id)}>
                    {iv.candidate_name}
                  </button>
                  <span className="wq-row-sub">
                    {[roundLabel(iv.interview_round), iv.interviewer_name ? `with ${iv.interviewer_name}` : 'no interviewer set'].filter(Boolean).join(' · ')}
                    {' · '}{fmtDate(iv.interview_date)}
                    {iv.days_since > 0 ? ` (${iv.days_since}d ago)` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {(counts?.feedback_pending ?? 0) > feedbackDue.length && (
            <p className="wq-more">Showing the oldest {feedbackDue.length} of {counts.feedback_pending}.</p>
          )}
        </section>
      )}

      {feedbackFor && (
        <div className="wq-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !savingFb) setFeedbackFor(null); }}>
          <div className="wq-modal" role="dialog" aria-modal="true" aria-labelledby="wq-fb-title">
            <h3 id="wq-fb-title">Your feedback — {feedbackFor.candidate_name}</h3>
            <p className="wq-modal-sub">
              Saved on the candidate's profile. The recruiter records the final outcome on the schedule.
            </p>
            <label htmlFor="wq-fb-rec">Recommendation *</label>
            <select id="wq-fb-rec" autoFocus value={fb.recommendation} onChange={e => setFb(f => ({ ...f, recommendation: e.target.value }))}>
              <option value="">Choose…</option>
              <option value="strong_hire">Strong hire</option>
              <option value="hire">Hire</option>
              <option value="hold">Hold</option>
              <option value="reject">Do not hire</option>
            </select>
            <label htmlFor="wq-fb-rating">Rating (1–5)</label>
            <input id="wq-fb-rating" type="number" min="1" max="5" step="0.5" value={fb.rating} onChange={e => setFb(f => ({ ...f, rating: e.target.value }))} />
            <label htmlFor="wq-fb-c">Comments</label>
            <textarea id="wq-fb-c" rows={4} maxLength={5000} value={fb.comments} onChange={e => setFb(f => ({ ...f, comments: e.target.value }))} />
            <div className="wq-modal-acts">
              <button type="button" className="pulse-btn-secondary" onClick={() => setFeedbackFor(null)} disabled={savingFb}>Cancel</button>
              <button type="button" className="pulse-btn-primary" onClick={saveFeedback} disabled={savingFb}>{savingFb ? 'Saving…' : 'Save feedback'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Recontacts, in full ─────────────────────────────────────────── */}
      {recontacts.length > 0 && (
        <section className="wq-panel">
          <header className="wq-panel-head">
            <CalendarClock size={15} />
            <h3>Talent Bank candidates due for recontact</h3>
            <button type="button" className="wq-panel-link" onClick={() => go({ page: 'TalentBank' })}>
              Open the Talent Bank
            </button>
          </header>
          <div className="wq-rows">
            {recontacts.map(rc => (
              <div key={rc.id} className="wq-row">
                <div className="wq-row-main">
                  <button type="button" className="wq-row-name" onClick={() => openCandidate(rc.candidate_id)}>
                    {rc.full_name}
                  </button>
                  <span className="wq-row-sub">
                    {[rc.potential_role, rc.department].filter(Boolean).join(' · ') || 'no role noted'}
                    {' · due '}{fmtDate(rc.recontact_on)}
                    {rc.days_until_due < 0 ? ` (${Math.abs(rc.days_until_due)}d overdue)` : ''}
                  </span>
                </div>
                <div className="wq-row-acts">
                  {rc.phone && <a className="wq-row-link" href={`tel:${rc.phone}`}>{rc.phone}</a>}
                  {canEdit && (
                    <>
                      <button type="button" className="wq-row-btn" onClick={() => setForwarding({ id: rc.candidate_id, full_name: rc.full_name })}>
                        Put forward
                      </button>
                      <button type="button" className="wq-row-btn" disabled={bringing === rc.id} onClick={() => markContacted(rc)}>
                        {bringing === rc.id ? 'Saving…' : 'Contacted'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          {forwarding && (
            <PutForwardDialog candidate={forwarding} onClose={() => setForwarding(null)} onSaved={load} />
          )}
          {(counts?.recontact_due ?? 0) > recontacts.length && (
            <p className="wq-more">Showing the {recontacts.length} most overdue of {counts.recontact_due} — the rest are in the Talent Bank.</p>
          )}
        </section>
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <PageShell dock={
      <PageHero
        icon={ListChecks}
        eyebrow="Recruitment"
        title="My Recruitment Work"
        subtitle="What needs acting on today. The numbers are the whole recruiting team's queue; “assigned to me” and “My interviews” are yours."
      />
    }>
      {body}
    </PageShell>
  );
}
