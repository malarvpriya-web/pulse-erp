/**
 * 20260724000001_candidate_stage_history.js
 *
 * `candidate_stage_history` was referenced at 5 call sites in
 * recruitment.repository.js (createCandidate, bulkCreateCandidates,
 * moveCandidateStage, getCandidateStageHistory, hireCandidate) but the table
 * was never created anywhere — every one of those functions throws
 * `relation "candidate_stage_history" does not exist` the moment it runs,
 * confirmed live. Creates it with the columns/types those 5 call sites
 * already assume (candidate_id, stage, moved_by, notes, moved_date).
 *
 * moved_by is `employees(id)`, not `users(id)` — getCandidateStageHistory's
 * own read joins `employees e ON csh.moved_by = e.id`, so the FK has to
 * target employees to match. (See the companion route fix in
 * recruitment.routes.js's interview-outcome auto-advance handler, which was
 * passing a users.id into this column — the same recurring employees-vs-users
 * id mistake documented in project_stock_ledger_created_by_fk.)
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_candstagehist_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  await safe(`
    CREATE TABLE IF NOT EXISTS candidate_stage_history (
      id SERIAL PRIMARY KEY,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      stage VARCHAR(50) NOT NULL,
      moved_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      notes TEXT,
      moved_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_candidate_stage_history_candidate ON candidate_stage_history(candidate_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS candidate_stage_history`);
}
