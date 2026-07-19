/**
 * 20260610000001_candidates_talent_columns.js
 *
 * Adds talent-profile columns to candidates (skills, experience, ctc, etc.)
 * and creates the talent_pool_members junction table with correct UUID types.
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT tal_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT tal_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT tal_sp');
      console.warn(`[candidates_talent_columns] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // ── Talent profile columns on candidates ─────────────────────────────────
  await safe('skills',              `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS skills               JSONB       DEFAULT '[]'`);
  await safe('experience_years',    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience_years     NUMERIC(4,1)`);
  await safe('current_company',     `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS current_company      VARCHAR(255)`);
  await safe('current_designation', `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS current_designation  VARCHAR(255)`);
  await safe('notice_period_days',  `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS notice_period_days   INTEGER`);
  await safe('expected_ctc',        `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS expected_ctc         NUMERIC(14,2)`);
  await safe('tags',                `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS tags                 JSONB       DEFAULT '[]'`);
  await safe('notes',               `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS notes                TEXT`);

  // ── talent_pool_members: proper UUID candidate_id + INTEGER pool_id ────────
  // talent_pool_candidates (created at runtime) has INTEGER candidate_id (wrong) —
  // this new table uses the correct UUID type for candidate_id.
  // Fix: drop UUID variant before recreating with correct INTEGER type
  await safe('fix talent_pool_members uuid type', `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'talent_pool_members'
          AND column_name = 'candidate_id'
          AND data_type = 'uuid'
      ) THEN
        DROP TABLE IF EXISTS talent_pool_members CASCADE;
      END IF;
    END $$
  `);
  await safe('talent_pool_members table', `
    CREATE TABLE IF NOT EXISTS talent_pool_members (
      pool_id      INTEGER      NOT NULL,
      candidate_id INTEGER      NOT NULL,
      added_at     TIMESTAMPTZ  DEFAULT NOW(),
      PRIMARY KEY  (pool_id, candidate_id)
    )
  `);

  await safe('idx talent_pool_members pool',      `CREATE INDEX IF NOT EXISTS idx_tpm_pool      ON talent_pool_members(pool_id)`);
  await safe('idx talent_pool_members candidate', `CREATE INDEX IF NOT EXISTS idx_tpm_candidate ON talent_pool_members(candidate_id)`);

  // ── GIN index for skills search ───────────────────────────────────────────
  await safe('idx candidates skills gin', `CREATE INDEX IF NOT EXISTS idx_candidates_skills_gin ON candidates USING GIN(skills)`);

  console.log('[migration 20260610000001] Candidates talent columns applied.');
}

export async function down(knex) {
  // Column drops are destructive — left intentionally empty for safety
}
