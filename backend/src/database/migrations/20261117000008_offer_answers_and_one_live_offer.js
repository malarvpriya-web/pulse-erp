/**
 * 20261117000008_offer_answers_and_one_live_offer.js — Offer Management review (2026-11-17).
 *
 *  1. offer_letters.close_reason — why a candidate declined, or why the company
 *     withdrew. Both used to be a bare status change with no reason anywhere,
 *     so "why do we lose offers?" had no answer.
 *  2. offer_status CHECK — the column had none; the API's move table is the
 *     only thing that kept it to the six real states.
 *  3. One live offer per candidate — nothing stopped a second draft for a
 *     candidate who already had one draft / pending / sent, and the Approval
 *     Center then showed two offers for one person. Accepted offers are not
 *     "live" (the candidate is hired), so they don't block a future offer.
 *  4. One active template per event per company — the sender takes LIMIT 1
 *     with no tie-break, so two active company templates for the same event
 *     sent an arbitrary one.
 *
 * Checked before writing: no existing rows break 2, 3 or 4 (dev, 2026-11-17).
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS close_reason text`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offer_letters_status_check') THEN
        ALTER TABLE offer_letters ADD CONSTRAINT offer_letters_status_check
          CHECK (offer_status IN ('draft','pending_approval','sent','accepted','declined','withdrawn'));
      END IF;
    END $$`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS offer_letters_one_live_per_candidate
      ON offer_letters (candidate_id)
      WHERE deleted_at IS NULL AND offer_status IN ('draft','pending_approval','sent')`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS email_templates_one_active_per_event
      ON email_templates (company_id, stage_trigger)
      WHERE module = 'recruitment' AND deleted_at IS NULL AND is_active AND company_id IS NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS email_templates_one_active_per_event`);
  await knex.raw(`DROP INDEX IF EXISTS offer_letters_one_live_per_candidate`);
  await knex.raw(`ALTER TABLE offer_letters DROP CONSTRAINT IF EXISTS offer_letters_status_check`);
  await knex.raw(`ALTER TABLE offer_letters DROP COLUMN IF EXISTS close_reason`);
}
