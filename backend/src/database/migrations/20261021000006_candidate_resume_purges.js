/**
 * 20261021000006 — candidate_resume_purges: the résumé-file half of anonymisation.
 *
 * jobs/candidateRetention.cron.js nulled `resume_file_url` / `resume_url` and
 * said "the blob itself is cleaned up by the storage sweep". No storage sweep
 * exists, so an anonymised candidate's CV stayed in uploads/ for good.
 *
 * One row per stored résumé reference of an anonymised candidate, written in the
 * SAME transaction as the anonymisation — so a committed anonymisation always
 * has its files queued, and a rolled-back one queues nothing. The file itself is
 * removed only after that commit, by candidateRetention's purge step, which
 * re-checks that no other record references it.
 *
 *   status
 *     pending          queued; not yet processed
 *     failed           deletion attempted and the file is still there (retried
 *                      while attempts < the job's cap; last_error says why)
 *     deleted          removed, and confirmed absent afterwards
 *     already_absent   nothing on disk to remove
 *     retained_shared  another record still references the file — kept
 *     skipped_external not a local upload (S3/R2 URL, Google Drive id) — not
 *                      deleted by this job
 *     unsafe_path      the stored reference is not a plain file name directly
 *                      inside uploads/ (traversal, sub-directory, symlink…) —
 *                      never touched
 *
 * UNIQUE (candidate_id, file_ref) makes queueing idempotent on a retried run.
 * Additive only; no existing row is changed.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS candidate_resume_purges (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER,
      candidate_id  INTEGER NOT NULL,
      file_ref      TEXT NOT NULL,
      status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','failed','deleted','already_absent',
                                      'retained_shared','skipped_external','unsafe_path')),
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      referenced_by TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at  TIMESTAMPTZ,
      UNIQUE (candidate_id, file_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_candidate_resume_purges_open
      ON candidate_resume_purges (id) WHERE status IN ('pending','failed');
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS candidate_resume_purges`);
}
