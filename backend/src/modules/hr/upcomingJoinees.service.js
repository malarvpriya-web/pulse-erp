/**
 * Upcoming joinees — people with a confirmed future start date who are NOT
 * employees yet.
 *
 * ── Where the data lives ───────────────────────────────────────────────────
 * `offer_letters` is the live offer table (10 code consumers, including
 * recruitment.routes.js and shared/statusSets.js). `job_offers` is its dead
 * twin: five seeded rows and no consumer outside the schema files and the
 * document-number helper. Do not build on `job_offers`.
 *
 * NOTHING here creates an employee record. A joinee is a candidate with an
 * accepted offer; they become an `employees` row when HR actually onboards
 * them, and at that moment they must drop out of this list and appear in
 * headcount instead — never both.
 *
 * ⚠⚠ "Has this candidate already joined?" cannot be answered by
 * `employees.source_candidate_id` alone. That column is populated on 1 of 44
 * live employee rows: candidate 9 ("Resume DB Candidate") has an accepted
 * offer AND an employees row created by a different path, with a NULL
 * source_candidate_id. Keying only on the FK reported someone who had been on
 * the payroll for seven weeks as an upcoming joinee. The email match is what
 * catches them; the FK is kept because it is the explicit link and survives an
 * email change.
 *
 * ── The four states ────────────────────────────────────────────────────────
 *   upcoming  accepted, starts within the window
 *   imminent  accepted, starts within 7 days — the subset HR acts on this week
 *   overdue   accepted, start date has PASSED and no employee record exists.
 *             A no-show or a stalled onboarding. It must stay visible: this is
 *             exactly the row that a `BETWEEN CURRENT_DATE AND …` window drops
 *             on the day it starts to matter.
 *   pending   offer SENT but not accepted. Reported separately and never added
 *             into the headline count — "confirmed" means accepted.
 */
import pool from '../../config/db.js';
import { OFFER_ACCEPTED, isIn } from '../../shared/statusSets.js';

/** How far ahead "upcoming" reaches by default. */
export const DEFAULT_JOINEE_WINDOW_DAYS = 30;

/** The subset HR treats as this week's work. */
export const IMMINENT_DAYS = 7;

/**
 * True when this candidate is already on the payroll.
 * See the header for why one predicate is not enough.
 */
const ALREADY_AN_EMPLOYEE = `
  EXISTS (
    SELECT 1 FROM employees e
     WHERE e.deleted_at IS NULL
       AND ( e.source_candidate_id = c.id
             OR ( NULLIF(TRIM(c.email), '') IS NOT NULL
                  AND ( LOWER(TRIM(e.company_email))  = LOWER(TRIM(c.email))
                        OR LOWER(TRIM(e.personal_email)) = LOWER(TRIM(c.email)) ) ) )
  )`;

/**
 * @param {object} opts
 * @param {number|null} opts.company_id
 * @param {number} [opts.days] forward window for `upcoming`
 * @returns {Promise<{summary: object, joinees: object[]}>}
 */
export async function getUpcomingJoinees({
  company_id = null, days = DEFAULT_JOINEE_WINDOW_DAYS, department = null,
} = {}) {
  const window = Math.min(Math.max(Number(days) || DEFAULT_JOINEE_WINDOW_DAYS, 1), 365);

  // DISTINCT ON keeps one row per candidate. Candidate 10 in live data holds
  // two offers (one 'sent', one 'draft'); without this a single person would
  // be counted twice the moment both were accepted.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (ol.candidate_id)
            ol.candidate_id,
            ol.id                                                   AS offer_id,
            COALESCE(NULLIF(TRIM(c.full_name), ''),
                     TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')),
                     c.email)                                       AS name,
            c.email,
            ol.joining_date,
            LOWER(ol.offer_status)                                  AS offer_status,
            COALESCE(NULLIF(TRIM(jo.department), ''), 'Unassigned') AS department,
            jo.job_title,
            (ol.joining_date - CURRENT_DATE)::int                   AS days_to_join,
            CASE
              WHEN NOT (${isIn('ol.offer_status', OFFER_ACCEPTED)})        THEN 'pending'
              WHEN ol.joining_date <  CURRENT_DATE                        THEN 'overdue'
              WHEN ol.joining_date <= CURRENT_DATE + ($2 || ' days')::INTERVAL
                   AND ol.joining_date <= CURRENT_DATE + ($3 || ' days')::INTERVAL THEN 'imminent'
              ELSE 'upcoming'
            END                                                     AS joinee_state
       FROM offer_letters ol
       JOIN candidates c ON c.id = ol.candidate_id
       LEFT JOIN job_openings jo ON jo.id = ol.job_opening_id
      WHERE ol.joining_date IS NOT NULL
        AND ($1::int IS NULL OR ol.company_id = $1)
        -- 'draft' was never extended, so it is not a commitment by anyone.
        AND LOWER(ol.offer_status) <> 'draft'
        -- Accepted offers count however far back their start date is (an
        -- overdue joinee is the point); unaccepted ones only look forward.
        AND ( ${isIn('ol.offer_status', OFFER_ACCEPTED)}
              OR ol.joining_date >= CURRENT_DATE )
        AND ol.joining_date <= CURRENT_DATE + ($2 || ' days')::INTERVAL
        -- Same department dimension the rest of the dashboard uses, so a
        -- filtered page does not show one department's headcount beside the
        -- whole company's incoming joiners.
        AND ($4::text IS NULL
             OR COALESCE(NULLIF(TRIM(jo.department), ''), 'Unassigned') = $4)
        AND NOT ${ALREADY_AN_EMPLOYEE}
      -- Accepted wins over sent for the same candidate, then the earliest date.
      ORDER BY ol.candidate_id,
               (${isIn('ol.offer_status', OFFER_ACCEPTED)}) DESC,
               ol.joining_date ASC`,
    [company_id, window, IMMINENT_DAYS, department || null],
  );

  const joinees = rows.filter(r => r.joinee_state !== 'pending');
  const pending = rows.filter(r => r.joinee_state === 'pending');

  return {
    summary: {
      // Confirmed and still ahead of us — the headline number.
      total:    joinees.filter(r => r.joinee_state !== 'overdue').length,
      next7:    joinees.filter(r => r.joinee_state === 'imminent').length,
      // Confirmed, start date passed, no employee record. Needs chasing.
      overdue:  joinees.filter(r => r.joinee_state === 'overdue').length,
      // Offered but not accepted. Deliberately OUTSIDE `total`.
      pendingAcceptance: pending.length,
      windowDays: window,
    },
    joinees,
    pending,
  };
}

export default { getUpcomingJoinees, DEFAULT_JOINEE_WINDOW_DAYS, IMMINENT_DAYS };
