/**
 * Add a real `offer_letters.offer_expiry_date`.
 *
 * Until now an offer's expiry was never stored — it was *derived* everywhere as
 * `offer_sent_date + company_settings.offer_validity_days`. That works for a
 * uniform company-wide policy but cannot express the ordinary business case of
 * extending a deadline for one candidate ("they asked for another week"), and it
 * silently rewrites history: changing the company's default validity retroactively
 * moves the expiry date of every offer ever sent, including ones already lapsed.
 *
 * Storing the date fixes both. The company setting keeps its job — it is the
 * DEFAULT applied when an offer is sent — but once stamped, the row owns its date.
 *
 * Backfill: existing rows get the derived value they were already being displayed
 * with, so nothing visibly changes on migrate. Rows with no offer_sent_date (drafts
 * and, in this database, the accepted offers) are left NULL — they have no sent
 * date to derive from, and a draft has no meaningful expiry until it is sent.
 *
 * Company validity is read per-company from company_settings, falling back to 14
 * (the same fallback talent.routes.js uses) when a company has not configured one.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS offer_expiry_date DATE
  `);

  // Backfill to exactly what the derived expression would have produced, so the
  // Expiring Offers panel shows identical dates before and after this migration.
  await knex.raw(`
    UPDATE offer_letters ol
       SET offer_expiry_date = (
             ol.offer_sent_date
             + COALESCE(
                 (SELECT (cs.settings->>'offer_validity_days')::int
                    FROM company_settings cs
                   WHERE cs.module = 'recruitment'
                     AND cs.company_id IS NOT DISTINCT FROM ol.company_id
                   LIMIT 1),
                 14
               )
           )::date
     WHERE ol.offer_sent_date IS NOT NULL
       AND ol.offer_expiry_date IS NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS offer_letters_expiry_idx
      ON offer_letters (offer_expiry_date)
     WHERE deleted_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS offer_letters_expiry_idx`);
  await knex.raw(`ALTER TABLE offer_letters DROP COLUMN IF EXISTS offer_expiry_date`);
}
