import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ListChecks, ClipboardCheck, CalendarDays, MessageSquareWarning, Clock,
  FileSignature, UserPlus, CalendarClock, Shuffle, Archive, UserCog, Inbox,
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
    to: { page: 'Candidates', params: { tab: 'all', stage: 'screening' } },
  },
  {
    key: 'interviews_today',
    label: 'interviews today',
    detail: 'Scheduled for today and not cancelled',
    icon: CalendarDays,
    tone: 'today',
    to: { page: 'InterviewCenter' },
  },
  {
    key: 'feedback_pending',
    label: 'feedbacks pending',
    detail: 'Interviews that have happened with no feedback recorded',
    icon: MessageSquareWarning,
    tone: 'warn',
    to: { page: 'InterviewCenter' },
  },
  {
    key: 'waiting_over_3_days',
    label: 'waiting more than 3 days',
    detail: 'Live candidates nobody has moved in 3+ days',
    icon: Clock,
    tone: 'warn',
    to: { page: 'Candidates', params: { tab: 'all', stale: '3' } },
  },
  {
    key: 'offers_pending',
    label: 'offers pending',
    detail: 'Drafted or sent, not yet answered',
    icon: FileSignature,
    tone: 'act',
    to: { page: 'OnboardingCenter' },
  },
  {
    key: 'joining_pending',
    label: 'joining pending',
    detail: 'Selected or at offer, not yet joined',
    icon: UserPlus,
    tone: 'go',
    to: { page: 'Candidates', params: { tab: 'all', stage: 'selected' } },
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
    to: { page: 'Candidates', params: { tab: 'all' } },
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
    to: { page: 'Candidates', params: { tab: 'all', rec: 'unassigned' } },
  },
];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function RecruitmentWorkQueue({ setPage, embedded = false }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);
  const { user } = useAuth();
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);

  const [counts, setCounts] = useState(null);
  const [recontacts, setRecontacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/recruitment/work-queue');
      setCounts(res.data?.counts || {});
      setRecontacts(res.data?.recontacts_due || []);
    } catch (e) {
      if (e?.code === 'ERR_CANCELED') return;
      setError(e?.response?.data?.error || 'Could not load your work queue.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const go = (to) => {
    if (!to?.page) return;
    setPage?.(to.page, to.params);
  };

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
            : error ? error
            : totalActions === 0
              ? 'Nothing is waiting on you. Good place to be.'
              : `${totalActions} thing${totalActions === 1 ? '' : 's'} waiting on you.`}
        </p>
      </header>

      {/* ── §23's clickable numbers ───────────────────────────────────────── */}
      <div className="wq-tiles">
        {visible.map(({ key, label, detail, icon: Icon, tone, to }) => {
          const n = counts?.[key] ?? 0;
          return (
            <button
              key={key}
              type="button"
              className={`wq-tile wq-tile--${tone}${n === 0 ? ' is-zero' : ''}`}
              onClick={() => go(to)}
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

      {/* ── My own work ─────────────────────────────────────────────────── */}
      <div className="wq-mine">
        <button type="button" className="wq-mine-btn"
                onClick={() => go({ page: 'Candidates', params: { tab: 'all', rec: 'me' } })}>
          <Inbox size={14} />
          <strong>{counts?.assigned_to_me ?? 0}</strong> assigned to me
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
                  <button
                    type="button"
                    className="wq-row-name"
                    onClick={() => { setSelectedCandidateId(rc.candidate_id); setPage?.('CandidateDetail'); }}
                  >
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
                  <button
                    type="button"
                    className="wq-row-btn"
                    onClick={async () => {
                      try {
                        await api.post(`/recruitment/recontacts/${rc.id}/complete`, { status: 'done', reengage: true });
                        toast(`${rc.full_name} back in active consideration`);
                        load();
                      } catch (e) { toast(e?.response?.data?.error || 'Could not update', 'error'); }
                    }}
                  >
                    Contacted — bring back
                  </button>
                </div>
              </div>
            ))}
          </div>
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
        subtitle="What needs you today. Analytics live on the Dashboard — this screen is for acting, not reading."
      />
    }>
      {body}
    </PageShell>
  );
}
