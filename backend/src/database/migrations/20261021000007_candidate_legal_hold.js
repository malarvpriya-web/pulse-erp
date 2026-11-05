/**
 * 20261021000007 — legal hold on candidates.
 *
 * A candidate under legal hold (litigation, a regulator's enquiry, a
 * discrimination claim about the hiring decision…) must not be anonymised by the
 * retention job, and their résumé must not be queued for deletion — whatever
 * their retention date or consent status. There was no way to express that: the
 * job anonymised everything due.
 *
 *   candidates.legal_hold         the switch the retention job checks, inside
 *                                 the same row lock it anonymises under
 *   candidates.legal_hold_reason  the CURRENT reason (history is in the log)
 *   candidates.legal_hold_by      users.id of whoever last placed / amended it
 *   candidates.legal_hold_at      when
 *
 * Every place / amend / release is written to candidate_retention_log — the
 * regulator-facing retention trail — in the same transaction as the change. Its
 * CHECK admitted only anonymised / extended / withdrawn / exported, so it is
 * widened to add hold_placed / hold_amended / hold_released, and `reason` from
 * varchar(60) to varchar(500) so a hold's reason is recorded in full rather than
 * truncated. Both are widenings: every existing row still satisfies them.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE candidates
      ADD COLUMN IF NOT EXISTS legal_hold        BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS legal_hold_reason TEXT,
      ADD COLUMN IF NOT EXISTS legal_hold_by     INTEGER,
      ADD COLUMN IF NOT EXISTS legal_hold_at     TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_candidates_legal_hold
      ON candidates (company_id) WHERE legal_hold;

    ALTER TABLE candidate_retention_log ALTER COLUMN reason TYPE VARCHAR(500);

    ALTER TABLE candidate_retention_log DROP CONSTRAINT IF EXISTS candidate_retention_log_action_check;
    ALTER TABLE candidate_retention_log ADD CONSTRAINT candidate_retention_log_action_check
      CHECK (action IN ('anonymised', 'extended', 'withdrawn', 'exported',
                        'hold_placed', 'hold_amended', 'hold_released'));
  `);
}

export async function down(knex) {
  await knex.raw(`
    DELETE FROM candidate_retention_log WHERE action IN ('hold_placed', 'hold_amended', 'hold_released');
    ALTER TABLE candidate_retention_log DROP CONSTRAINT IF EXISTS candidate_retention_log_action_check;
    ALTER TABLE candidate_retention_log ADD CONSTRAINT candidate_retention_log_action_check
      CHECK (action IN ('anonymised', 'extended', 'withdrawn', 'exported'));
    DROP INDEX IF EXISTS idx_candidates_legal_hold;
    ALTER TABLE candidates
      DROP COLUMN IF EXISTS legal_hold_at,
      DROP COLUMN IF EXISTS legal_hold_by,
      DROP COLUMN IF EXISTS legal_hold_reason,
      DROP COLUMN IF EXISTS legal_hold;
  `);
}
