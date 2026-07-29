/**
 * 20260724000002_job_openings_positions_filled.js
 *
 * hireCandidate() (recruitment.repository.js) marks a job opening filled via
 * `UPDATE job_openings SET status='closed', positions_filled = COALESCE(positions_filled,0)+1`
 * — but job_openings has no positions_filled column at all, confirmed live
 * ("column positions_filled does not exist"). This was the 3rd distinct
 * blocking bug found in hireCandidate this session (after the missing
 * candidate_stage_history table) — the function has evidently never
 * completed a real run in this environment. job_requisitions.number_of_positions
 * already tracks how many total positions a requisition wants; job_openings
 * itself has no equivalent multi-position concept, so positions_filled is
 * additive here rather than derived from an existing column.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_jopositionsfilled_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  await safe(`ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS positions_filled INTEGER NOT NULL DEFAULT 0`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE job_openings DROP COLUMN IF EXISTS positions_filled`);
}
