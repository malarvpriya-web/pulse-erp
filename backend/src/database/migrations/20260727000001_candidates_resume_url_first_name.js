/**
 * 20260727000001_candidates_resume_url_first_name.js
 *
 * "Add Candidate" (POST /recruitment/candidates) was throwing 500 on every
 * submit, confirmed live: `column "resume_file_url" of relation "candidates"
 * does not exist`. recruitment.repository.js (createCandidate,
 * bulkCreateCandidates), recruitment.routes.js and talent.routes.js (resume
 * stats/list) all read/write `candidates.resume_file_url` — the column
 * recruitment-schema.sql defines — but the live table was bootstrapped from
 * the older module_tables.js baseline, which only ever created `resume_url`.
 * 20260619000001_phase5_recruitment_gdrive.js backfilled the other
 * full_name-schema columns (full_name, applied_job_id, current_stage, …) but
 * missed this one.
 *
 * Same baseline also left `first_name` NOT NULL with no default — a column
 * from the pre-full_name schema that no live code path populates or reads
 * for candidates (only for employees, a different table). That NOT NULL was
 * the second reason every candidate INSERT failed once resume_file_url is
 * fixed, so it's relaxed here too rather than resurrecting a dead column.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_candresume_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  await safe(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS resume_file_url VARCHAR(500)`);
  await safe(`ALTER TABLE candidates ALTER COLUMN first_name DROP NOT NULL`);
}

export async function down(knex) {
  // Column drop / re-adding NOT NULL are destructive — left intentionally
  // empty for safety, matching 20260619000001's convention.
}
