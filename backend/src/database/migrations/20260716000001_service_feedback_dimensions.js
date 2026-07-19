/**
 * 20260716000001_service_feedback_dimensions.js
 *
 * Feedback View enhancement — split the single blended CSAT `rating` into the
 * four service-quality dimensions the Service Feedback page needs, and close the
 * IPCS(complaint) -> IPS(ticket) -> Feedback loop by carrying a complaint link
 * on the feedback row itself.
 *
 * All new columns live on the existing `csat_responses` table (created at server
 * start by the servicedesk route module, not a migration) so this whole file is
 * GUARDED: on a fresh DB where the table does not exist yet at migrate time,
 * every step is skipped rather than aborting. The route module's inline CREATE
 * TABLE was extended with the same columns to cover the fresh-install case.
 *
 *   product_rating   INTEGER 1-5   customer's rating of the product
 *   engineer_rating  INTEGER 1-5   customer's rating of the service engineer
 *   visited_on_time  BOOLEAN       engineer arrived within the scheduled window
 *   resolved         BOOLEAN       customer confirmed the issue was resolved
 *   customer_name    TEXT          denormalized customer name for the grid
 *   complaint_id     INTEGER       -> complaints(id), ON DELETE SET NULL
 *
 * All ratings are pinned to INTEGER 1-5 to stay consistent with the existing
 * csat_responses.rating, customer_portal_tickets.customer_rating and
 * commissioning_workflows.customer_rating (NOT the VoC 1-10 scale).
 *
 * complaint_id is backfilled from the ticket path
 * (csat_responses.ticket_id -> support_tickets.complaint_id) so existing
 * feedback rows immediately trace back to their complaint where one exists.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_svcfb_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate object/i.test(err.message || '')) throw err;
    }
  };

  // ── new dimension columns (guarded; csat_responses is a runtime table) ───────
  await safe(`ALTER TABLE csat_responses ADD COLUMN IF NOT EXISTS product_rating  INTEGER`);
  await safe(`ALTER TABLE csat_responses ADD COLUMN IF NOT EXISTS engineer_rating INTEGER`);
  await safe(`ALTER TABLE csat_responses ADD COLUMN IF NOT EXISTS visited_on_time BOOLEAN`);
  await safe(`ALTER TABLE csat_responses ADD COLUMN IF NOT EXISTS resolved        BOOLEAN`);
  await safe(`ALTER TABLE csat_responses ADD COLUMN IF NOT EXISTS customer_name   TEXT`);
  await safe(`ALTER TABLE csat_responses ADD COLUMN IF NOT EXISTS complaint_id    INTEGER`);

  // 1-5 bounds, matching the existing rating CHECK. Added as NOT VALID-safe
  // constraints via ADD CONSTRAINT (all rows are NULL at this point).
  await safe(`ALTER TABLE csat_responses ADD CONSTRAINT chk_csat_product_rating  CHECK (product_rating  BETWEEN 1 AND 5)`);
  await safe(`ALTER TABLE csat_responses ADD CONSTRAINT chk_csat_engineer_rating CHECK (engineer_rating BETWEEN 1 AND 5)`);

  // ── close the loop: feedback -> complaint ────────────────────────────────────
  // Backfill from the ticket path first, then attach the FK.
  await safe(`
    UPDATE csat_responses c
       SET complaint_id = t.complaint_id
      FROM support_tickets t
     WHERE c.ticket_id = t.id
       AND c.complaint_id IS NULL
       AND t.complaint_id IS NOT NULL
  `);
  await safe(`
    ALTER TABLE csat_responses
      ADD CONSTRAINT fk_csat_responses_complaint
      FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE SET NULL
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_csat_responses_complaint ON csat_responses(complaint_id)`);
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`DROP INDEX IF EXISTS idx_csat_responses_complaint`);
  await safe(`ALTER TABLE csat_responses DROP CONSTRAINT IF EXISTS fk_csat_responses_complaint`);
  await safe(`ALTER TABLE csat_responses DROP CONSTRAINT IF EXISTS chk_csat_engineer_rating`);
  await safe(`ALTER TABLE csat_responses DROP CONSTRAINT IF EXISTS chk_csat_product_rating`);
  await safe(`ALTER TABLE csat_responses DROP COLUMN IF EXISTS complaint_id`);
  await safe(`ALTER TABLE csat_responses DROP COLUMN IF EXISTS customer_name`);
  await safe(`ALTER TABLE csat_responses DROP COLUMN IF EXISTS resolved`);
  await safe(`ALTER TABLE csat_responses DROP COLUMN IF EXISTS visited_on_time`);
  await safe(`ALTER TABLE csat_responses DROP COLUMN IF EXISTS engineer_rating`);
  await safe(`ALTER TABLE csat_responses DROP COLUMN IF EXISTS product_rating`);
}
