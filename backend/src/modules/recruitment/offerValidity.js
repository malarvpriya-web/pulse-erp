/**
 * "Default Offer Validity" — the per-company number of days an offer stays open,
 * configured in Recruitment Settings and stored as
 * `company_settings(module='recruitment').settings->>'offer_validity_days'`.
 *
 * This setting was written by the UI but read by nothing for a long time
 * (talent.routes.js hardcoded 14), so a company that had configured 7 saw expiry
 * dates a week late and offers lingered on the Expiring Offers panel after they
 * had actually lapsed. It now has two readers, hence this shared helper rather
 * than a third copy of the query.
 *
 * Note the scope of what this value does NOW: since offer_letters.offer_expiry_date
 * exists (migration 20260813000001), this is only the DEFAULT stamped onto an offer
 * at send time. It no longer retroactively controls the expiry of offers already
 * sent — those carry their own stored date, which is the point of that column.
 */

import pool from '../shared/db.js';

export const DEFAULT_OFFER_VALIDITY_DAYS = 14;

/**
 * @param {number|null} companyId
 * @returns {Promise<number>} configured validity in days, or 14 if unset/invalid.
 */
export async function getOfferValidityDays(companyId) {
  try {
    const { rows } = await pool.query(
      `SELECT (settings->>'offer_validity_days')::int AS days
         FROM company_settings
        WHERE module = 'recruitment' AND ($1::int IS NULL OR company_id = $1)
        LIMIT 1`,
      [companyId ?? null]
    );
    const days = rows[0]?.days;
    return days > 0 ? days : DEFAULT_OFFER_VALIDITY_DAYS;
  } catch {
    // A missing company_settings row/table must never break offer sending.
    return DEFAULT_OFFER_VALIDITY_DAYS;
  }
}
