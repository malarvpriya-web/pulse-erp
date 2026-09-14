/**
 * audit_logs.reference_id: INTEGER → TEXT.
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * `20260430000001_audit_log_columns` intended this column to be TEXT — its own
 * header says so: "reference_id — primary key of the affected record (stored as
 * TEXT for flexibility)". It wrote:
 *
 *     ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS reference_id TEXT, ...
 *
 * But `reference_id INTEGER` already existed, created by 20260330000000_core_schema.
 * `ADD COLUMN IF NOT EXISTS` skips the column entirely when it is present — it
 * does not reconcile the type, and it does not warn. The column has been INTEGER
 * ever since while every layer above it assumed TEXT: `AuditService.logAudit`
 * even does `String(recordId)` before handing it over.
 *
 * ── What it cost ───────────────────────────────────────────────────────────
 * Every audit write for a uuid-keyed record fails with
 *
 *     22P02  invalid input syntax for type integer: "5956c449-361a-…"
 *
 * and `logAudit` is fire-and-forget — the failure is caught and console.error'd,
 * the HTTP request still returns 201. So those mutations appeared audited, the
 * route code looked correct, and nothing was ever written. Found while adding
 * audit coverage to the CRM pipeline-configuration routes (PART 28): the
 * win/loss reason master, pipeline stages, scoring rules and assignment rules
 * are all uuid-keyed, so 100% of their audit entries were being discarded.
 *
 * This is not CRM-specific. It silently voids audit logging for every uuid-keyed
 * entity in the application.
 *
 * ── The change ─────────────────────────────────────────────────────────────
 * Existing integer values convert to their decimal strings, which is exactly
 * what `String(recordId)` produces for integer PKs today — so old and new rows
 * stay comparable and `findByReference` keeps matching. The composite index
 * (reference_id, reference_type) is rebuilt by the ALTER automatically.
 */

export async function up(knex) {
  const { rows } = await knex.raw(`
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'audit_logs' AND column_name = 'reference_id'
  `);
  if (rows[0]?.data_type === 'text') return; // already correct

  await knex.raw(`
    ALTER TABLE audit_logs
      ALTER COLUMN reference_id TYPE TEXT USING reference_id::text;
  `);
}

export async function down(knex) {
  // Only integer-shaped values can go back. Anything else — the uuid references
  // this migration made storable — would be lost, so they are nulled rather
  // than silently truncated.
  await knex.raw(`
    UPDATE audit_logs SET reference_id = NULL
     WHERE reference_id IS NOT NULL AND reference_id !~ '^[0-9]+$';
  `);
  await knex.raw(`
    ALTER TABLE audit_logs
      ALTER COLUMN reference_id TYPE INTEGER USING reference_id::integer;
  `);
}
