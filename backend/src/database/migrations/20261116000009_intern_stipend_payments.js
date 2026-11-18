/**
 * 20261116000009_intern_stipend_payments.js — HR audit 2026-11-16 (11-03 F-22).
 *
 * An intern's stipend was stored (interns.stipend, stipend_frequency) and read
 * by nothing: no due was ever raised and nothing could be paid.
 *
 * 1. interns gain the salary-account fields a payment needs (holder, bank,
 *    account number, IFSC). Nullable; validated by the API.
 * 2. intern_stipend_payments — one row per intern per month: HR raises the dues
 *    for a month (amount from the stipend and frequency, pro-rated for a part
 *    month), may correct an amount with a reason while it is due, and Finance
 *    records the payment (UTR, value date, company bank account). Unique per
 *    intern and month, so a month cannot be raised twice.
 * No existing row changes.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE interns
      ADD COLUMN IF NOT EXISTS bank_account_holder VARCHAR(150),
      ADD COLUMN IF NOT EXISTS bank_name           VARCHAR(150),
      ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(30),
      ADD COLUMN IF NOT EXISTS bank_ifsc           VARCHAR(11)`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS intern_stipend_payments (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER NOT NULL REFERENCES companies(id),
      intern_id        INTEGER NOT NULL REFERENCES interns(id),
      period_month     DATE    NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
      amount           NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
      computed_amount  NUMERIC(12,2) NOT NULL CHECK (computed_amount >= 0),
      basis            TEXT,
      adjust_reason    TEXT,
      status           VARCHAR(10) NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid', 'cancelled')),
      created_by       INTEGER REFERENCES users(id),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_by          INTEGER REFERENCES users(id),
      paid_at          TIMESTAMPTZ,
      utr              VARCHAR(35),
      value_date       DATE,
      bank_account_id  INTEGER REFERENCES bank_accounts(id),
      cancel_reason    TEXT,
      UNIQUE (intern_id, period_month)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_isp_company_month ON intern_stipend_payments (company_id, period_month)`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_isp_utr ON intern_stipend_payments (company_id, utr) WHERE utr IS NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS intern_stipend_payments`);
  await knex.raw(`
    ALTER TABLE interns
      DROP COLUMN IF EXISTS bank_account_holder, DROP COLUMN IF EXISTS bank_name,
      DROP COLUMN IF EXISTS bank_account_number, DROP COLUMN IF EXISTS bank_ifsc`);
}
