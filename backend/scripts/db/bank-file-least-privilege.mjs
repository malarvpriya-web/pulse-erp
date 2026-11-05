/**
 * scripts/db/bank-file-least-privilege.mjs — the privilege boundary for released
 * bank files (PC-02b-0 B-04, manual §238). A DBA tool: nothing under src/ imports
 * it, and it needs superuser credentials the application does not hold.
 *
 * The immutability trigger binds an ordinary role only. A superuser or the table's
 * owner can disable it, and a superuser can also skip it with
 * session_replication_role. So the guarantee needs both of these:
 *   1. the application logs in as a role that is neither superuser nor owner;
 *   2. the table and trigger function belong to a role the application cannot use.
 *
 * This tool does (2) and refuses to pretend about (1): it refuses a superuser,
 * CREATEROLE or BYPASSRLS application role, or one that can use the owner role.
 * The application role ends with SELECT and INSERT on the table, and USAGE on its
 * sequence. Run it AFTER migrations: a later migration of this table then needs
 * the same privileged credentials.
 *
 *   BANK_FILE_ADMIN_DATABASE_URL=postgresql://... \
 *     node scripts/db/bank-file-least-privilege.mjs --app-role <role>
 */
import { pathToFileURL } from 'node:url';

export const DEFAULT_OWNER_ROLE = 'pulse_bank_file_owner';

/** One transaction; any refusal changes nothing. Returns the verified privileges. */
export async function applyBankFileLeastPrivilege(client, appRole, ownerRole = DEFAULT_OWNER_ROLE) {
  const id = (name) => client.escapeIdentifier(name);
  await client.query('BEGIN');
  try {
    const { rows: [me] } = await client.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
    if (!me?.rolsuper) throw new Error('These credentials are not a superuser, so they cannot set this boundary.');

    const { rows: [app] } = await client.query(
      `SELECT rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = $1`, [appRole]);
    if (!app) throw new Error(`Application role "${appRole}" does not exist.`);
    if (app.rolsuper || app.rolcreaterole || app.rolbypassrls) {
      throw new Error(`Application role "${appRole}" is superuser, CREATEROLE or BYPASSRLS; it could bypass any protection. Move the application to an ordinary role first.`);
    }

    const { rows: [owner] } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [ownerRole]);
    if (!owner) await client.query(`CREATE ROLE ${id(ownerRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const { rows: [{ member }] } = await client.query(`SELECT pg_has_role($1, $2, 'MEMBER') AS member`, [appRole, ownerRole]);
    if (member) throw new Error(`Application role "${appRole}" is a member of "${ownerRole}".`);

    await client.query(`GRANT USAGE ON SCHEMA public TO ${id(ownerRole)}`);
    await client.query(`ALTER TABLE payment_batch_files OWNER TO ${id(ownerRole)}`);
    await client.query(`ALTER FUNCTION payment_batch_files_immutable() OWNER TO ${id(ownerRole)}`);
    await client.query(`REVOKE ALL ON payment_batch_files FROM PUBLIC, ${id(appRole)}`);
    await client.query(`GRANT SELECT, INSERT ON payment_batch_files TO ${id(appRole)}`);
    const { rows: [{ seq }] } = await client.query(`SELECT pg_get_serial_sequence('payment_batch_files', 'id') AS seq`);
    await client.query(`REVOKE ALL ON SEQUENCE ${seq} FROM PUBLIC, ${id(appRole)}`);
    await client.query(`GRANT USAGE ON SEQUENCE ${seq} TO ${id(appRole)}`);

    const { rows: [p] } = await client.query(
      `SELECT has_table_privilege($1, 'payment_batch_files', 'SELECT')   AS can_select,
              has_table_privilege($1, 'payment_batch_files', 'INSERT')   AS can_insert,
              has_table_privilege($1, 'payment_batch_files', 'UPDATE')   AS can_update,
              has_table_privilege($1, 'payment_batch_files', 'DELETE')   AS can_delete,
              has_table_privilege($1, 'payment_batch_files', 'TRUNCATE') AS can_truncate,
              has_table_privilege($1, 'payment_batch_files', 'TRIGGER')  AS can_trigger,
              (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'payment_batch_files'::regclass) AS table_owner`,
      [appRole]);
    if (!p.can_select || !p.can_insert || p.can_update || p.can_delete || p.can_truncate || p.can_trigger || p.table_owner === appRole) {
      throw new Error(`The boundary did not hold for "${appRole}", possibly through another role it belongs to: ${JSON.stringify(p)}`);
    }
    await client.query('COMMIT');
    return p;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--app-role');
  const appRole = at > 0 ? process.argv[at + 1] : null;
  const url = process.env.BANK_FILE_ADMIN_DATABASE_URL;
  if (!appRole || !url) {
    console.error('Usage: BANK_FILE_ADMIN_DATABASE_URL=... node scripts/db/bank-file-least-privilege.mjs --app-role <role>');
    process.exit(2);
  }
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    console.log(await applyBankFileLeastPrivilege(client, appRole));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
