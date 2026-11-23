/**
 * 20261119000002 — Late bands, punctuality rating, comp-off choice, contract
 * labour statements to Finance (§278.4, owner 2026-11-19).
 *
 * 1. attendance_general_settings.late_bands — the minutes Live Workforce groups
 *    today's late arrivals by ("above 10 / 15 / 30 min"). Edited in Settings →
 *    Late arrival; the boxes follow the setting.
 * 2. attendance_general_settings.punctuality_bands — the default rating a
 *    performance review shows for punctuality: on time on ≥95 % of days present
 *    = 5, ≥90 % = 4, ≥80 % = 3, ≥70 % = 2, below = 1. Editable in Settings.
 * 3. employees.comp_off_eligible — comp off is given only to the employees HR
 *    chooses (owner: production staff, not everyone). Default no.
 * 4. contract_labour_finance_statements — the month's contract-labour
 *    attendance per contractor, sent to Finance (man-days, hours) for the
 *    contractor's bill.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const LATE_BANDS = [10, 15, 30];
const PUNCTUALITY_BANDS = [
  { min_pct: 95, rating: 5 }, { min_pct: 90, rating: 4 }, { min_pct: 80, rating: 3 },
  { min_pct: 70, rating: 2 }, { min_pct: 0, rating: 1 },
];

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE attendance_general_settings
      ADD COLUMN IF NOT EXISTS late_bands JSONB NOT NULL DEFAULT '${JSON.stringify(LATE_BANDS)}'::jsonb,
      ADD COLUMN IF NOT EXISTS punctuality_bands JSONB NOT NULL DEFAULT '${JSON.stringify(PUNCTUALITY_BANDS)}'::jsonb`);

  await knex.raw(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS comp_off_eligible BOOLEAN NOT NULL DEFAULT false`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS contract_labour_finance_statements (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
      year SMALLINT NOT NULL,
      contractor_company VARCHAR(200) NOT NULL,
      workers INTEGER NOT NULL DEFAULT 0,
      present_days NUMERIC(7,1) NOT NULL DEFAULT 0,
      hours NUMERIC(9,2) NOT NULL DEFAULT 0,
      detail JSONB,
      sent_by INTEGER,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, month, year, contractor_company)
    )`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS contract_labour_finance_statements`);
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS comp_off_eligible`);
  await knex.raw(`ALTER TABLE attendance_general_settings DROP COLUMN IF EXISTS late_bands, DROP COLUMN IF EXISTS punctuality_bands`);
}
