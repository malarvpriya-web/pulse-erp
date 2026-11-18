/**
 * scripts/db/app-role-grants.mjs — give the application's login what it needs to run,
 * and no way to change the schema (DB-01C3, manual §249). A DBA tool: nothing under
 * src/ imports it.
 *
 * Run it as the role that owns the tables, the one `npm run migrate` logs in as. It lists
 * only what that role owns, so a table whose ownership was moved away on purpose, such
 * as payment_batch_files, is never reopened. A superuser is refused unless it really is
 * the owner, as on a local database, and says so with --owner-is-superuser.
 *
 * The application role gets, in schema public:
 *   tables            SELECT, INSERT, UPDATE, DELETE
 *   views             SELECT
 *   sequences         USAGE, SELECT, UPDATE
 *   functions         EXECUTE, on those the owner wrote (extensions keep their defaults)
 * and the same by default on anything a later migration creates. It gets no CREATE on
 * the schema, and TRUNCATE, REFERENCES and TRIGGER are taken away.
 *
 * Audit tables (APPEND_ONLY_TABLES) are add-only: the application can insert and read,
 * but cannot change or remove what is already recorded, so a compromised application
 * cannot cover its tracks. A foreign key's ON DELETE SET NULL still works, because it runs
 * as the table's owner. Retention or erasure of audit rows runs under the owner's login.
 *
 * Other tables keep broad rights, which are not the final model.
 *
 * Order for a new database: create the two logins, `npm run migrate` as the owner, this
 * tool as the owner, then bank-file-least-privilege.mjs. It is safe to run again.
 *
 *   APP_ROLE_ADMIN_DATABASE_URL=postgresql://owner:...@host/db \
 *     node scripts/db/app-role-grants.mjs --app-role <role> [--owner-is-superuser]
 */
import { pathToFileURL } from 'node:url';

export const APPEND_ONLY_TABLES = Object.freeze([
  'access_denials', 'attendance_audit_logs', 'audit_logs', 'audit_logs_backup', 'audit_trail', 'auth_audit_log',
  'candidate_retention_log', 'document_download_log', 'fnf_settlement_events', 'fnf_settlements', 'intern_audit_events', 'security_events', 'signature_audit_log',
]);

/** One transaction; any refusal changes nothing. Returns what was granted, verified. */
export async function applyAppRoleGrants(client, appRole, { ownerIsSuperuser = false } = {}) {
  const id = (name) => client.escapeIdentifier(name);
  await client.query('BEGIN');
  try {
    const { rows: [me] } = await client.query(
      `SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user`);
    if (me.rolsuper && !ownerIsSuperuser) throw new Error('These credentials are a superuser. Run this as the role that owns the tables.');
    if (me.name === appRole) throw new Error(`"${appRole}" owns the tables. The application must log in as a different role.`);

    const { rows: [app] } = await client.query(
      `SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = $1`, [appRole]);
    if (!app) throw new Error(`Application role "${appRole}" does not exist.`);
    if (app.rolsuper || app.rolcreaterole || app.rolcreatedb || app.rolbypassrls) {
      throw new Error(`Application role "${appRole}" is superuser, CREATEROLE, CREATEDB or BYPASSRLS. Remove that first.`);
    }
    const { rows: [{ member }] } = await client.query(`SELECT pg_has_role($1, current_user, 'MEMBER') AS member`, [appRole]);
    if (member) throw new Error(`Application role "${appRole}" is a member of "${me.name}", so it could act as the owner.`);

    const owned = async (kinds) => (await client.query(
      `SELECT c.oid::regclass::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = ANY($1) AND pg_get_userbyid(c.relowner) = current_user`, [kinds])).rows.map((r) => r.name);
    const tables = await owned(['r', 'p']);
    const views = await owned(['v', 'm']);
    const sequences = await owned(['S']);
    const { rows: functions } = await client.query(
      `SELECT p.oid::regprocedure::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = current_user
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`);

    const role = id(appRole);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC, ${role}`);
    for (const t of tables) {
      await client.query(`REVOKE TRUNCATE, REFERENCES, TRIGGER ON ${t} FROM ${role}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${role}`);
    }
    const appendOnly = tables.filter((t) => APPEND_ONLY_TABLES.includes(t.replace(/^public\./, '').replace(/"/g, '')));
    for (const t of appendOnly) await client.query(`REVOKE UPDATE, DELETE ON ${t} FROM ${role}`);
    for (const v of views) await client.query(`GRANT SELECT ON ${v} TO ${role}`);
    for (const s of sequences) await client.query(`GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${s} TO ${role}`);
    for (const f of functions) await client.query(`GRANT EXECUTE ON FUNCTION ${f.name} TO ${role}`);

    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${role}`);

    const { rows: [p] } = await client.query(
      `SELECT has_schema_privilege($1, 'public', 'CREATE') AS can_create,
              (SELECT COUNT(*)::int FROM unnest($2::text[]) t WHERE NOT (has_table_privilege($1, t, 'SELECT') AND has_table_privilege($1, t, 'INSERT'))) AS short,
              (SELECT COUNT(*)::int FROM unnest($3::text[]) t WHERE has_table_privilege($1, t, 'UPDATE') OR has_table_privilege($1, t, 'DELETE')) AS audit_open,
              (SELECT COUNT(*)::int FROM unnest($2::text[]) t WHERE has_table_privilege($1, t, 'TRUNCATE')) AS can_truncate,
              (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND pg_get_userbyid(c.relowner) = $1) AS app_owns`,
      [appRole, tables, appendOnly]);
    if (p.can_create || p.short || p.audit_open || p.can_truncate || p.app_owns) {
      throw new Error(`The grants did not hold for "${appRole}", possibly through another role it belongs to: ${JSON.stringify(p)}`);
    }

    await client.query('COMMIT');
    return { owner: me.name, tables: tables.length, appendOnly: appendOnly.length, views: views.length, sequences: sequences.length, functions: functions.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--app-role');
  const appRole = at > 0 ? process.argv[at + 1] : null;
  const url = process.env.APP_ROLE_ADMIN_DATABASE_URL;
  if (!appRole || !url) {
    console.error('Usage: APP_ROLE_ADMIN_DATABASE_URL=... node scripts/db/app-role-grants.mjs --app-role <role>');
    process.exit(2);
  }
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    console.log(await applyAppRoleGrants(client, appRole, { ownerIsSuperuser: process.argv.includes('--owner-is-superuser') }));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
