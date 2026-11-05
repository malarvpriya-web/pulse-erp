/**
 * 20261021000001 — CTC foundation (PAYROLL_DATA_FLOW_AUDIT.md Part 4 / §P4).
 *
 * ADDITIVE ONLY. No existing row is updated; existing salary revisions keep
 * their meaning (monthly Basic, structure-computed) and are never reinterpreted.
 *
 *  1. salary_revision_proposals — CTC-driven (or Basic) salary proposals in
 *     draft. A proposal becomes a row in employee_salary_assignments only when
 *     approved, so drafts are invisible to every reader of that table (payroll,
 *     increments, F&F, encashment, analytics). One live proposal per offer /
 *     increment (duplicate-conversion guard).
 *  2. employee_salary_assignments — nullable columns describing a CTC revision:
 *     entry_mode, annual_ctc, ctc_policy_version, breakdown (the HR-approved
 *     component amounts payroll pays from), proposal_id, company_id. NULL on
 *     every existing row = legacy revision.
 *  3. salary_structures — company_id (NULL = shared template) and template_id
 *     (the shared template a company copy came from). Existing 2 structures
 *     stay shared; no copies are created here.
 *  4. increment_recommendations — system-derived annual CTC figures and the
 *     proposal they produced.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS salary_revision_proposals (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      employee_id         INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      structure_id        INTEGER REFERENCES salary_structures(id) ON DELETE SET NULL,
      effective_from      DATE NOT NULL,
      entry_mode          VARCHAR(20) NOT NULL CHECK (entry_mode IN ('annual_ctc', 'basic_monthly')),
      requested_annual_ctc NUMERIC(14,2),
      basic_monthly       NUMERIC(12,2) NOT NULL CHECK (basic_monthly > 0),
      annual_ctc          NUMERIC(14,2) NOT NULL CHECK (annual_ctc > 0),
      rounding_residual   NUMERIC(10,2) NOT NULL DEFAULT 0,
      breakdown           JSONB NOT NULL,
      ctc_policy_version  VARCHAR(80) NOT NULL,
      rules_as_of         DATE NOT NULL,
      status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'approved', 'rejected', 'cancelled')),
      source_type         VARCHAR(20) NOT NULL DEFAULT 'manual'
                          CHECK (source_type IN ('manual', 'offer', 'increment')),
      source_id           VARCHAR(64),
      created_by          INTEGER,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_by          INTEGER,
      decided_at          TIMESTAMPTZ,
      decision_note       TEXT,
      assignment_id       INTEGER REFERENCES employee_salary_assignments(id) ON DELETE SET NULL
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS salary_revision_proposals_one_live_per_source
      ON salary_revision_proposals (source_type, source_id)
      WHERE source_type IN ('offer', 'increment') AND status IN ('draft', 'approved')
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS salary_revision_proposals_company ON salary_revision_proposals (company_id, status)`);

  for (const ddl of [
    `ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`,
    `ADD COLUMN IF NOT EXISTS entry_mode VARCHAR(20)`,
    `ADD COLUMN IF NOT EXISTS annual_ctc NUMERIC(14,2)`,
    `ADD COLUMN IF NOT EXISTS ctc_policy_version VARCHAR(80)`,
    `ADD COLUMN IF NOT EXISTS breakdown JSONB`,
    `ADD COLUMN IF NOT EXISTS proposal_id INTEGER`,
  ]) await knex.raw(`ALTER TABLE employee_salary_assignments ${ddl}`);

  await knex.raw(`ALTER TABLE salary_structures ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`);
  await knex.raw(`ALTER TABLE salary_structures ADD COLUMN IF NOT EXISTS template_id INTEGER REFERENCES salary_structures(id) ON DELETE SET NULL`);

  for (const ddl of [
    `ADD COLUMN IF NOT EXISTS current_annual_ctc NUMERIC(14,2)`,
    `ADD COLUMN IF NOT EXISTS new_annual_ctc NUMERIC(14,2)`,
    `ADD COLUMN IF NOT EXISTS proposal_id INTEGER REFERENCES salary_revision_proposals(id) ON DELETE SET NULL`,
  ]) await knex.raw(`ALTER TABLE increment_recommendations ${ddl}`);
}

export async function down(knex) {
  for (const c of ['proposal_id', 'new_annual_ctc', 'current_annual_ctc']) await knex.raw(`ALTER TABLE increment_recommendations DROP COLUMN IF EXISTS ${c}`);
  for (const c of ['template_id', 'company_id']) await knex.raw(`ALTER TABLE salary_structures DROP COLUMN IF EXISTS ${c}`);
  for (const c of ['proposal_id', 'breakdown', 'ctc_policy_version', 'annual_ctc', 'entry_mode', 'company_id']) {
    await knex.raw(`ALTER TABLE employee_salary_assignments DROP COLUMN IF EXISTS ${c}`);
  }
  await knex.raw(`DROP TABLE IF EXISTS salary_revision_proposals`);
}
