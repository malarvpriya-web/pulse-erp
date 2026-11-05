/**
 * 20260930000013 — a verification check knows whether it APPLIES.
 *
 * ── The defect this fixes ────────────────────────────────────────────────────
 * Every check was equally real, so a check that does not apply to an employee had
 * only two homes: leave it out (and lose the record that it was CONSIDERED and
 * ruled out), or create it and watch it sit Pending forever — counted as
 * outstanding work, blocking case closure, and dragging the progress figure down.
 *
 * A fresher has no previous employer. Employment Verification for them is not
 * "pending", it is "not applicable", and those are different facts. Recording the
 * difference is the whole point: an auditor asking "did you verify their
 * employment?" needs "there was none to verify", not silence.
 *
 * ── The three states ────────────────────────────────────────────────────────
 *   Required        must be resolved. Counted in the progress denominator, and
 *                   blocks case closure while open.
 *   Optional        applies, but is not part of the headline progress figure.
 *                   Still blocks closure while open — it is real work someone
 *                   chose to start.
 *   Not Applicable  does not apply to this employee. NEVER counted as pending,
 *                   NEVER blocks closure, NEVER in the progress denominator.
 *                   Kept as a row precisely so the decision is on the record.
 *
 * ── DEFAULT 'Required', deliberately ────────────────────────────────────────
 * Every existing row becomes Required, which is what they already behaved like:
 * they counted as pending and they blocked closure. So this migration changes no
 * behaviour for existing data — it only gives new rows somewhere else to be.
 *
 * The default also fails SAFE. Had it been 'Optional' or 'Not Applicable', a
 * caller that forgot to send the field would quietly create a check that no
 * progress figure counts and no closure guard notices — a verification that
 * looks done because nothing is looking for it.
 *
 * ── Why not a NULL "unspecified" state ──────────────────────────────────────
 * Because then every consumer has to decide what NULL means, and they would
 * disagree. NOT NULL with a default is one answer in one place.
 */

/** The applicability vocabulary. Mirrored by bgv.routes.js and the frontend. */
export const APPLICABILITY = ['Required', 'Optional', 'Not Applicable'];

/** Applies to this employee — i.e. counts as work. */
export const APPLICABLE = ['Required', 'Optional'];

export async function up(knex) {
  // ⚠ pg shim, not knex: bindings are $1/$2.
  await knex.raw(`
    ALTER TABLE bgv_checks
      ADD COLUMN IF NOT EXISTS applicability VARCHAR(20) NOT NULL DEFAULT 'Required'
  `);

  // ⚠ Added separately and guarded, because ADD CONSTRAINT is not idempotent and
  // a re-run on a database that already has it would abort the migration.
  const { rows: existing } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'bgv_checks_applicability_chk'`);
  if (!existing.length) {
    await knex.raw(`
      ALTER TABLE bgv_checks
        ADD CONSTRAINT bgv_checks_applicability_chk
        CHECK (applicability IN ('Required','Optional','Not Applicable'))
    `);
  }

  // The rollup filters on applicability in every aggregate, and the closure guard
  // filters on it too, so it is worth an index alongside status.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bgv_checks_applicability
      ON bgv_checks (case_id, applicability, status)
  `);

  /**
   * ── One check per type per case, for the CHECKLIST path ──────────────────
   *
   * A partial unique index would be wrong here: repeating a verification is
   * legitimate (a re-check after a discrepancy is resolved), and the brief says
   * duplicates are only forbidden "unless the existing workflow explicitly
   * supports repeated verification".
   *
   * So the constraint lives in the BULK endpoint, which refuses to re-create a
   * type the case already has, while the single-check endpoint still allows a
   * deliberate repeat. Enforcing it in the schema would make the legitimate case
   * impossible; enforcing it nowhere would let the checklist silently double
   * every check on a second click. This index is what makes that check cheap.
   */
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bgv_checks_case_type
      ON bgv_checks (case_id, LOWER(BTRIM(check_type)))
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_bgv_checks_case_type`);
  await knex.raw(`DROP INDEX IF EXISTS idx_bgv_checks_applicability`);
  await knex.raw(`ALTER TABLE bgv_checks DROP CONSTRAINT IF EXISTS bgv_checks_applicability_chk`);
  await knex.raw(`ALTER TABLE bgv_checks DROP COLUMN IF EXISTS applicability`);
}
