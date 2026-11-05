/**
 * 20261103000001 — interview_schedules.candidate_id, offer_letters.candidate_id
 * and offer_letters.job_opening_id as INTEGER, decided by the column's CURRENT
 * type rather than altered unconditionally. See MODULE_FEATURE_CONNECTION_MANUAL.md §224.
 *
 * These three ALTERs used to run at import time of
 * modules/recruitment/routes/recruitment.routes.js, fire-and-forget, on every
 * boot and in every test worker that loaded the router. Run against a column
 * that is already INTEGER, `ALTER COLUMN … TYPE INTEGER` still takes ACCESS
 * EXCLUSIVE on interview_schedules and then on candidates (to rebuild the
 * candidate_id foreign key). A concurrent DELETE of employees or companies
 * takes the same two tables in the opposite order through its FK actions
 * (candidates.l1/l2_interviewer_id SET NULL, then interview_schedules
 * interviewer_id SET NULL / company_id CASCADE), so the two deadlocked (§223).
 *
 * Here each column is altered only when information_schema says it is not
 * already `integer`:
 *   - table or column absent  → nothing to do (the router's CREATE TABLE
 *                               IF NOT EXISTS creates them INTEGER);
 *   - already integer         → no ALTER, no lock beyond the catalogue read;
 *   - legacy type (uuid/text) → converted with the same USING expression the
 *                               router used, but only after checking that every
 *                               non-blank value is an integer. Anything else
 *                               (a real UUID) is REFUSED with the row count —
 *                               converting it would destroy it, and the old
 *                               fire-and-forget ALTER failed silently there.
 *
 * down() is deliberately a no-op: the UUID typing was the defect (no real
 * candidate or job id could ever be stored), so there is nothing to restore.
 */
const COLUMNS = [
  ['interview_schedules', 'candidate_id'],
  ['offer_letters', 'candidate_id'],
  ['offer_letters', 'job_opening_id'],
];

export async function up(knex) {
  for (const [table, column] of COLUMNS) {
    const { rows: [col] } = await knex.raw(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, [table, column]);
    if (!col || col.data_type === 'integer') continue;

    const { rows: [bad] } = await knex.raw(
      `SELECT COUNT(*)::int AS n FROM ${table}
        WHERE ${column} IS NOT NULL
          AND btrim(${column}::text) <> ''
          AND btrim(${column}::text) !~ '^-?[0-9]+$'`);
    if (bad.n > 0) {
      throw new Error(`${table}.${column} is ${col.data_type} and ${bad.n} row(s) hold a value that is not an integer id; ` +
        `converting would destroy them. Map them to integer ids deliberately, then re-run migrations.`);
    }
    await knex.raw(
      `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE INTEGER USING NULLIF(btrim(${column}::text), '')::integer`);
  }
}

export async function down() {
  // Intentionally empty — see the header: the previous (UUID) typing was the bug.
}
