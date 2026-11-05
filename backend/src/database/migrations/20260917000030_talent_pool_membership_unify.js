/**
 * Reunify talent-pool membership onto one table, and stop it splitting again.
 *
 * Two tables have been recording the same relationship:
 *
 *   talent_pool_candidates — created by talent.routes.js's import-time DDL.
 *     Proper FKs to talent_pools(id) and candidates(id), both ON DELETE CASCADE.
 *     Holds the REAL memberships. Read by almost nothing.
 *   talent_pool_members    — what every endpoint in talent.routes.js actually
 *     reads and writes. Carries `notes` and `added_by`, which the other lacks,
 *     but has NO foreign key on pool_id or candidate_id.
 *
 * Because the reads and the data lived in different tables, every pool reported
 * `member_count: 0` and `GET /pools/:id/members` returned `[]` no matter what was
 * in it — while talent_pool_members itself accumulated rows pointing at pool and
 * candidate ids that do not exist, which is exactly what the missing FKs allowed.
 *
 * This migration keeps talent_pool_members (the shape the code and the UI expect,
 * with notes and attribution), moves the genuine memberships into it, deletes the
 * rows that reference nothing, and adds the foreign keys that would have made the
 * orphans impossible. talent_pool_candidates is then dropped: it is the copy
 * nothing reads, and leaving a second table recording the same fact is how this
 * started.
 *
 * Ordering matters — the orphan purge must run BEFORE the FKs are added, or the
 * ALTERs fail on the very rows they exist to prevent.
 */

export async function up(knex) {
  // 1. Carry the real memberships across. ON CONFLICT so a membership already
  //    present in both tables keeps the richer talent_pool_members row (its
  //    notes and added_by), rather than being overwritten with nulls.
  await knex.raw(`
    INSERT INTO talent_pool_members (pool_id, candidate_id, added_at)
    SELECT tpc.pool_id, tpc.candidate_id, tpc.added_at
      FROM talent_pool_candidates tpc
     WHERE EXISTS (SELECT 1 FROM talent_pools tp WHERE tp.id = tpc.pool_id)
       AND EXISTS (SELECT 1 FROM candidates  c  WHERE c.id  = tpc.candidate_id)
    ON CONFLICT (pool_id, candidate_id) DO NOTHING
  `);

  // 2. Drop rows that point at a pool or candidate which no longer exists.
  //    These are unreachable by definition — every read path INNER JOINs
  //    candidates — so nothing visible is lost.
  await knex.raw(`
    DELETE FROM talent_pool_members tpm
     WHERE NOT EXISTS (SELECT 1 FROM talent_pools tp WHERE tp.id = tpm.pool_id)
        OR NOT EXISTS (SELECT 1 FROM candidates  c  WHERE c.id  = tpm.candidate_id)
  `);

  // 3. The constraints that keep step 2 from ever being needed again. CASCADE
  //    matches talent_pool_candidates' semantics: deleting a pool or a candidate
  //    removes the membership rather than orphaning it.
  await knex.raw(`
    ALTER TABLE talent_pool_members
      DROP CONSTRAINT IF EXISTS talent_pool_members_pool_id_fkey
  `);
  await knex.raw(`
    ALTER TABLE talent_pool_members
      ADD CONSTRAINT talent_pool_members_pool_id_fkey
      FOREIGN KEY (pool_id) REFERENCES talent_pools(id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE talent_pool_members
      DROP CONSTRAINT IF EXISTS talent_pool_members_candidate_id_fkey
  `);
  await knex.raw(`
    ALTER TABLE talent_pool_members
      ADD CONSTRAINT talent_pool_members_candidate_id_fkey
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
  `);

  // 4. Repair attribution written before the code was fixed. created_by/added_by
  //    are employees(id) columns that the routes used to fill with a users.id.
  //    Any value that is not a real employee is wrong — either it failed the FK
  //    (and the row was never written) or, where the id spaces happened to
  //    overlap, it credits the wrong person. NULL is the honest value.
  await knex.raw(`
    UPDATE talent_pools SET created_by = NULL
     WHERE created_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = talent_pools.created_by)
  `);
  await knex.raw(`
    UPDATE talent_pool_members SET added_by = NULL
     WHERE added_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = talent_pool_members.added_by)
  `);

  // 5. Retire the duplicate. Its contents are now in talent_pool_members and its
  //    two remaining readers in talent.routes.js were the import-time CREATE
  //    TABLE and nothing else.
  await knex.raw(`DROP TABLE IF EXISTS talent_pool_candidates`);
}

export async function down(knex) {
  // Recreate the retired table empty. The memberships themselves stay in
  // talent_pool_members, which is where every endpoint reads them — restoring
  // copies into a second table is what produced the split in the first place.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS talent_pool_candidates (
      pool_id      INTEGER NOT NULL REFERENCES talent_pools(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id)   ON DELETE CASCADE,
      added_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (pool_id, candidate_id)
    )
  `);
  await knex.raw(`
    ALTER TABLE talent_pool_members
      DROP CONSTRAINT IF EXISTS talent_pool_members_pool_id_fkey
  `);
  await knex.raw(`
    ALTER TABLE talent_pool_members
      DROP CONSTRAINT IF EXISTS talent_pool_members_candidate_id_fkey
  `);
}
