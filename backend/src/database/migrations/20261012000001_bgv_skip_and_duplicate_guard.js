/**
 * 20261012000001 — a controlled skip, and a duplicate guard the database enforces.
 *
 * ── 1. Optional checks no longer block closure, so skipping needs a record ───
 * The closure rule changed: only an unresolved REQUIRED check blocks a case.
 * An Optional one does not — HR may skip it. But "skip" cannot mean "leave it
 * Pending forever", because then the case closes with work visibly outstanding
 * and nothing saying why. So skipping is an ACT: it sets the check to Cancelled
 * and records who did it, when, and why.
 *
 * `skip_reason` is its own column, not `remarks`. `remarks` holds what the check
 * FOUND, and for a Discrepancy it is gated behind `bgv_sensitive` — a reason for
 * not doing a check is operational and must stay readable by the HR executive
 * who skipped it. Reusing one field for both would either hide the skip reason
 * from the person who wrote it or leak a finding to someone who may not read it.
 *
 * ── 2. The duplicate guard, as a PARTIAL unique index ───────────────────────
 * Duplicate protection lived only in the bulk endpoint's pre-check. That leaves
 * two holes:
 *
 *   · the single-check endpoint, and any direct API caller, could add a second
 *     active check of the same type by accident;
 *   · two CONCURRENT bulk requests both pass the pre-check (it reads before it
 *     writes) and both insert — the read-then-write race that
 *     [[project_batch01_tenant_idempotency_forensic]] documents, where two
 *     simultaneous converts produced PR5126 AND PR5127.
 *
 * A pre-check cannot close either hole; only the database can.
 *
 * ⚠ PARTIAL, on the ACTIVE statuses only. A blanket unique index on
 * (case_id, check_type) would make legitimate re-verification impossible — and
 * re-verifying after a discrepancy is resolved is ordinary HR work, not an
 * error. Scoping the index to Pending / Initiated / In Progress says exactly
 * what is actually forbidden: TWO OPEN checks of the same type on one case.
 * Once the first is Completed or Cancelled, a new one is allowed.
 *
 * ⚠ LOWER(BTRIM(...)) so 'Identity Verification' and ' identity verification '
 * collide, the same normalisation the agency-name index and the bulk pre-check
 * use. An exact-case index would let a whitespace variant straight through.
 *
 * ── 3. supersedes_check_id — re-verification keeps its history ──────────────
 * A re-verification is a NEW check that points at the one it replaces, so the
 * earlier result and its documents stay exactly where they are and the chain is
 * readable. Nothing is overwritten and nothing is deleted; `POST
 * /bgv/checks/:id/reverify` is the only writer.
 */
export async function up(knex) {
  // ⚠ pg shim, not knex: bindings are $1/$2.
  await knex.raw(`
    ALTER TABLE bgv_checks
      ADD COLUMN IF NOT EXISTS skipped_at          TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS skipped_by          INTEGER,
      ADD COLUMN IF NOT EXISTS skip_reason         TEXT,
      ADD COLUMN IF NOT EXISTS supersedes_check_id INTEGER
        REFERENCES bgv_checks(id) ON DELETE SET NULL
  `);

  /**
   * ⚠ Built CONCURRENTLY? No — deliberately not.
   *
   * CREATE INDEX CONCURRENTLY cannot run inside a transaction, and the migration
   * runner wraps each migration in one. `bgv_checks` is a small table (hundreds
   * of rows, not millions), so a brief lock is the right trade against a
   * migration that cannot be rolled back atomically.
   */
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bgv_checks_one_active_per_type
      ON bgv_checks (case_id, LOWER(BTRIM(check_type)))
      WHERE status IN ('Pending','Initiated','In Progress')
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bgv_checks_supersedes
      ON bgv_checks (supersedes_check_id) WHERE supersedes_check_id IS NOT NULL
  `);

  /**
   * ⚠ Any EXISTING duplicate actives would make the index creation fail, and the
   * migration would abort with a bare constraint error. Reported first so the
   * failure names the rows rather than the index.
   *
   * This runs AFTER the index above on purpose: if the index succeeded there are
   * none, and this is a no-op confirmation. If it failed, the error already said
   * so. Kept as a readable assertion for a future deployment with real volume.
   */
  const { rows: dupes } = await knex.raw(`
    SELECT case_id, LOWER(BTRIM(check_type)) AS t, COUNT(*)::int AS n
      FROM bgv_checks
     WHERE status IN ('Pending','Initiated','In Progress')
     GROUP BY 1, 2 HAVING COUNT(*) > 1`);
  if (dupes.length) {
    throw new Error(
      'Cannot add the duplicate guard: ' + dupes.length +
      ' (case, check type) pair(s) already have more than one ACTIVE check. ' +
      'Resolve or cancel the extras first: ' +
      dupes.map(d => `case ${d.case_id} / ${d.t} (${d.n})`).join('; '));
  }
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_bgv_checks_supersedes`);
  await knex.raw(`DROP INDEX IF EXISTS ux_bgv_checks_one_active_per_type`);
  await knex.raw(`
    ALTER TABLE bgv_checks
      DROP COLUMN IF EXISTS supersedes_check_id,
      DROP COLUMN IF EXISTS skip_reason,
      DROP COLUMN IF EXISTS skipped_by,
      DROP COLUMN IF EXISTS skipped_at
  `);
}
