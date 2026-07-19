/**
 * 20260719000003_access_denials.js
 *
 * Records every authorization denial so the pilot's RBAC hypothesis is testable.
 *
 * Why this table has to exist: `auditLogger` only writes on
 * `statusCode >= 200 && < 300`, so a denied request leaves NO trace anywhere —
 * not in audit_logs, not in security_events, not on disk. The question "did the
 * seeded permission matrix match how people actually work?" cannot be answered
 * from the data we currently keep, because the only evidence of a mismatch is
 * the 403 nobody recorded.
 *
 * Kept separate from audit_logs deliberately. audit_logs answers "what changed";
 * this answers "what was refused". Mixing them makes the common query — show me
 * successful changes — pay for rows it never wants, and denials need columns
 * (module, action, reason code) that a generic audit row does not carry.
 *
 * Retention: this is diagnostic data, not a compliance record. Prune it.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS access_denials (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER,
      roles       TEXT[],            -- roles held AT THE TIME; role grants change
      method      VARCHAR(10),
      path        TEXT,
      module      VARCHAR(64),       -- when the denial came from requirePermission
      action      VARCHAR(32),
      code        VARCHAR(64),       -- PERMISSION_DENIED, NOT_YOUR_REPORT, ...
      status      SMALLINT,
      company_id  INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`);

  // The analysis query is "denials grouped by role+module+action over the pilot
  // window", so index for that shape rather than adding one index per column.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_access_denials_created ON access_denials (created_at DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_access_denials_triage  ON access_denials (module, action, code)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_access_denials_user    ON access_denials (user_id, created_at DESC)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS access_denials`);
}
