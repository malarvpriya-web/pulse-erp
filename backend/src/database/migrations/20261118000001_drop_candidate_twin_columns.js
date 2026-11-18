/**
 * 20261118000001_drop_candidate_twin_columns.js — candidates' dead twins (2026-11-18).
 *
 * candidates.stage / status / first_name / last_name are left-overs beside the
 * real columns current_stage / overall_status / full_name. Nothing writes them:
 * every row held the defaults ('applied', 'active') or NULL while the real
 * columns said "hired", "rejected", "offer"… The one reader (HR Benchmarks'
 * time to hire, `c.stage IN ('joined','accepted')`) therefore always found
 * nothing; it now reads overall_status. The Agencies list's name fallback
 * used first_name/last_name and now uses full_name only.
 *
 * Checked before dropping (dev, 2026-11-18): no view, index or constraint uses
 * them; first_name/last_name are NULL on every row; stage/status hold only
 * their defaults. Down re-adds them empty with the old defaults.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  for (const col of ['stage', 'status', 'first_name', 'last_name']) {
    await knex.raw(`ALTER TABLE candidates DROP COLUMN IF EXISTS ${col}`);
  }
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS stage varchar(50) DEFAULT 'applied'`);
  await knex.raw(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS status varchar(30) DEFAULT 'active'`);
  await knex.raw(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS first_name varchar(100)`);
  await knex.raw(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS last_name varchar(100)`);
}
