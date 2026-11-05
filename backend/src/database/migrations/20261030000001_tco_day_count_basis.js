/**
 * 20261030000001 — procurement_settings.tco_day_count_basis.
 * See MODULE_FEATURE_CONNECTION_MANUAL.md §214.
 *
 * The TCO engine priced carrying cost over 12 x 30.44 = 365.28 days and credit
 * terms over 365, so Q/2 x v x h came out 0.08% high (Rs 50,038 for a Rs 50,000
 * textbook case) and the two time-based rates disagreed with each other. One
 * basis now drives carrying, credit terms and early-payment financing.
 *
 * 365 is the default (Indian GAAP/Ind AS interest convention); 360 is accepted
 * for companies whose treasury policy uses it. Anything else is a typo, so a
 * CHECK rejects it — the settings PUT returns 422 before it gets here.
 *
 * ⚠ tco.service.loadTcoParams SELECTs this column and swallows SQL errors
 * (falls back to engine defaults), so this migration must run before that code
 * serves traffic, or every company silently loses its saved TCO rates.
 * ADD COLUMN with a constant default is metadata-only: no row is rewritten.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE procurement_settings
      ADD COLUMN IF NOT EXISTS tco_day_count_basis INTEGER NOT NULL DEFAULT 365
  `);
  await knex.raw(`
    DO $$ BEGIN
      ALTER TABLE procurement_settings
        ADD CONSTRAINT procurement_settings_tco_day_count_basis_check
        CHECK (tco_day_count_basis IN (360, 365));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE procurement_settings DROP CONSTRAINT IF EXISTS procurement_settings_tco_day_count_basis_check`);
  await knex.raw(`ALTER TABLE procurement_settings DROP COLUMN IF EXISTS tco_day_count_basis`);
}
