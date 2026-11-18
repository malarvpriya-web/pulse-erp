/**
 * 20261105000006 — who approved and paid which settlement version (manual §254).
 *
 * exit_requests only said "paid", with no person, payment or journal behind it. Each step is
 * now a row: approval names a version and a person; payment adds the UTR, value date, bank
 * account and journal. A version is approved once and paid once, and a UTR is used once.
 * The application role has insert and read only.
 *
 * down() drops the table.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS fnf_settlement_events (
      id                SERIAL PRIMARY KEY,
      settlement_id     INTEGER NOT NULL REFERENCES fnf_settlements(id) ON DELETE CASCADE,
      exit_request_id   INTEGER NOT NULL,
      company_id        INTEGER,
      action            VARCHAR(10) NOT NULL CHECK (action IN ('approve', 'pay')),
      actor_id          INTEGER,
      amount            NUMERIC(14,2) NOT NULL,
      utr               VARCHAR(40),
      value_date        DATE,
      bank_account_id   INTEGER,
      journal_entry_id  UUID,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fnf_settlement_events_once UNIQUE (settlement_id, action)
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS fnf_settlement_events_utr ON fnf_settlement_events (UPPER(utr)) WHERE utr IS NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS fnf_settlement_events`);
}
