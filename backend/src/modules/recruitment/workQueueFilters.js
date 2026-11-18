/**
 * workQueueFilters.js — one definition per "My Recruitment Work" tile.
 *
 * The work queue counts candidates and the candidate list shows them. Before
 * 2026-11-17 the two used DIFFERENT rules: "need screening" counted applied +
 * screening candidates with no completed Stage 1, but its link listed stage =
 * screening only; "waiting more than 3 days" counted live stages only, but its
 * link also listed hired and rejected people. A tile whose link shows another
 * number is worse than no link.
 *
 * Both sides now read the predicate from here. Each predicate uses the alias
 * `c` for candidates and takes no bind parameters — the company scope is
 * applied by the caller (and correlated through c.company_id where a sub-query
 * needs it), so the same SQL fits both the COUNT and the paged list.
 */

export const LIVE_STAGES = ['applied', 'screening', 'shortlisted', 'assessment', '1st_level', '2nd_level', 'offer', 'selected'];
const LIVE = `c.current_stage IN (${LIVE_STAGES.map(s => `'${s}'`).join(',')})`;

export const QUEUE_PREDICATES = {
  // Applied or in screening, with no completed Stage 1.
  needs_screening: `c.current_stage IN ('applied','screening')
    AND NOT EXISTS (SELECT 1 FROM candidate_screenings s
                     WHERE s.candidate_id = c.id AND s.status = 'completed')`,
  // Live candidates nobody has moved in 3+ days (staleness, not age).
  waiting_over_3_days: `${LIVE}
    AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '3 days'`,
  // Selected or at offer, not yet joined. COALESCE: a NULL disposition must
  // still count — `NULL <> 'hired'` is NULL, which would drop the row.
  joining_pending: `c.current_stage IN ('selected','offer') AND COALESCE(c.disposition, '') <> 'hired'`,
  // Recorded as suiting a department that has an open vacancy right now.
  recommended_for_other_roles: `EXISTS (
    SELECT 1 FROM candidate_role_suitability rs
     WHERE rs.candidate_id = c.id AND rs.status = 'open' AND rs.suitability <> 'not_suitable'
       AND EXISTS (SELECT 1 FROM job_openings o
                    WHERE o.status = 'open' AND o.deleted_at IS NULL
                      AND o.company_id = c.company_id
                      AND LOWER(o.department) = LOWER(rs.department)))`,
  // Live candidates with no recruiter accountable.
  unassigned: `${LIVE} AND c.recruiter_id IS NULL`,
  // Live — used with recruiter_id=me for "assigned to me".
  live: LIVE,
};

export const QUEUE_KEYS = Object.keys(QUEUE_PREDICATES);

/**
 * Offers still waiting for an answer: drafted, awaiting approval or sent.
 * One set for My Work's "offers pending", the Dashboard's "Pending offers" and
 * Offer Management's "Awaiting answer" tab (frontend UNANSWERED). The Dashboard
 * used to count 'sent' only and showed 0 while My Work showed 2.
 */
export const UNANSWERED_OFFER_STATUSES = ['draft', 'pending_approval', 'sent'];
export const UNANSWERED_OFFERS_SQL = `(${UNANSWERED_OFFER_STATUSES.map(s => `'${s}'`).join(',')})`;
