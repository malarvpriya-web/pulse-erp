/**
 * 20261029000002 — bank-detail maker-checker, Phase 1 (§204).
 *
 * employee_bank_change_requests
 *   One proposed set of bank details for one employee, waiting for a second
 *   HR person. The employees row is changed ONLY when a different reviewer
 *   approves (employee.controller.js / bankChange.service.js).
 *   · status: pending → approved | rejected | withdrawn
 *   · at most ONE pending request per employee (partial unique index), so two
 *     proposals can never race to overwrite each other.
 *   · proposed_* hold the full set to apply (current values overlaid with the
 *     changed ones), so an approval writes one coherent set.
 *   · employee/company FKs CASCADE: a request has no meaning without its
 *     employee, and suites that delete their fixture employees must not be
 *     blocked by it. requested_by / decided_by are users.id, SET NULL.
 *
 * employees.bank_verified_at / bank_verified_by
 *   Stamped when a request is approved. NULL on every existing row: details
 *   entered before this change are "not verified" — nothing is back-filled and
 *   nothing is blocked on it yet (Phase 2 is a separate decision).
 *
 * Additive only. No employee, bank, payroll or claim row is read or written.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() drops exactly what up() adds.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS employee_bank_change_requests (
      id                     SERIAL PRIMARY KEY,
      employee_id            INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      proposed_account_number VARCHAR(50),
      proposed_ifsc_code     VARCHAR(20),
      proposed_bank_name     VARCHAR(150),
      proposed_branch_name   VARCHAR(150),
      fields_changed         TEXT[] NOT NULL DEFAULT '{}',
      source                 VARCHAR(20) NOT NULL DEFAULT 'edit',
      status                 VARCHAR(20) NOT NULL DEFAULT 'pending',
      requested_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
      requested_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_at             TIMESTAMPTZ,
      decision_reason        TEXT,
      CONSTRAINT chk_ebcr_status CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
      CONSTRAINT chk_ebcr_source CHECK (source IN ('create', 'edit'))
    )
  `);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ebcr_one_pending
                    ON employee_bank_change_requests (employee_id) WHERE status = 'pending'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ebcr_company_status
                    ON employee_bank_change_requests (company_id, status)`);
  await knex.raw(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS bank_verified_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS bank_verified_by INTEGER
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS bank_verified_by, DROP COLUMN IF EXISTS bank_verified_at`);
  await knex.raw(`DROP TABLE IF EXISTS employee_bank_change_requests`);
}
