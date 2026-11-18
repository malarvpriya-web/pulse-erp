/**
 * scripts/db/app-role-grants.mjs under a REAL non-superuser login (DB-01C3, manual §249).
 *
 * What is promised:
 *   - the application role can read and write, and use sequences and owned functions;
 *   - it cannot change the schema, truncate, or take ownership;
 *   - a table a later migration creates reaches it without running the tool again;
 *   - a table whose ownership moved away is not reopened (the bank-file boundary);
 *   - the tool refuses a superuser, and an application role that could escape;
 *   - running it again changes nothing;
 *   - audit tables are add-only, and clearing a link when a parent row goes still works.
 *
 * Scratch databases only (helpers/migrationFixtureDb.js). The login roles are
 * cluster-wide, so they are uniquely named and dropped here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
const { withFixtureDb } = await import('./helpers/migrationFixtureDb.js');
const { applyAppRoleGrants } = await import('../../scripts/db/app-role-grants.mjs');

const refused = async (fn) => { try { await fn(); } catch (e) { return e; } throw new Error('expected a refusal'); };

/** An owner, an application login, and a schema like the real one, owned by the owner. */
async function withRoles(c, fn) {
  const tag = randomBytes(5).toString('hex');
  const owner = `pulse_e2e_grant_owner_${tag}`;
  const app = `pulse_e2e_grant_app_${tag}`;
  const other = `pulse_e2e_grant_other_${tag}`;
  const password = randomBytes(18).toString('hex');
  await c.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER`);
  await c.query(`CREATE ROLE ${app} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await c.query(`CREATE ROLE ${other} NOLOGIN`);
  await c.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${owner}`);
  let login;
  try {
    await c.query(`SET ROLE ${owner}`);
    await c.query(`
      CREATE TABLE things (id serial PRIMARY KEY, name text);
      CREATE TABLE moved_away (id serial PRIMARY KEY, body text);
      CREATE VIEW thing_names AS SELECT name FROM things;
      CREATE FUNCTION add_one(n integer) RETURNS integer LANGUAGE sql AS 'SELECT n + 1';`);
    await c.query(`RESET ROLE`);
    await c.query(`ALTER TABLE moved_away OWNER TO ${other}`);
    await c.query(`INSERT INTO moved_away (body) VALUES ('kept')`);
    await c.query(`SET ROLE ${owner}`);
    const { host, port, database } = c.connectionParameters;
    const connect = async () => {
      login = new pg.Client({ host, port, database, user: app, password, ssl: false });
      await login.connect();
      return login;
    };
    await fn({ owner, app, other, connect });
  } finally {
    if (login) await login.end().catch(() => {});
    await c.query(`RESET ROLE`);
    for (const role of [app, owner, other]) {
      await c.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER`);
      await c.query(`DROP OWNED BY ${role}`);
      await c.query(`DROP ROLE ${role}`);
    }
  }
}

describe('scripts/db/app-role-grants', () => {
  it('lets the application work and refuses every schema change', async () => {
    await withFixtureDb('grnts', async ({ client: c }) => {
      await withRoles(c, async ({ owner, app, connect }) => {
        expect(await applyAppRoleGrants(c, app)).toMatchObject({ owner, tables: 1, views: 1, functions: 1 });
        const db = await connect();

        const { rows: [row] } = await db.query(`INSERT INTO things (name) VALUES ('a') RETURNING id`);
        expect(row.id).toBeGreaterThan(0);
        await db.query(`UPDATE things SET name = 'b' WHERE id = $1`, [row.id]);
        expect((await db.query(`SELECT name FROM thing_names`)).rows).toEqual([{ name: 'b' }]);
        expect((await db.query(`SELECT add_one(1) AS n`)).rows[0].n).toBe(2);
        await db.query(`SELECT nextval(pg_get_serial_sequence('things', 'id'))`);
        await db.query(`SELECT 1 FROM things FOR UPDATE`);
        await db.query(`DELETE FROM things WHERE id = $1`, [row.id]);

        const denied = async (sql) => expect((await refused(() => db.query(sql))).code, sql).toBe('42501');
        await denied(`CREATE TABLE zz_new (id integer)`);
        await denied(`CREATE SEQUENCE zz_seq`);
        await denied(`ALTER TABLE things ADD COLUMN zz integer`);
        await denied(`DROP TABLE things`);
        const refusedTable = 'things';
        await denied(`TRUNCATE ${refusedTable}`);
        await denied(`CREATE INDEX zz_idx ON things (name)`);
        await denied(`CREATE TRIGGER zz BEFORE INSERT ON things FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`);
        await denied(`ALTER TABLE things OWNER TO ${app}`);
        await denied(`SET ROLE ${owner}`);
      });
    });
  }, 60000);

  it('a table a later migration creates reaches the application without running the tool again', async () => {
    await withFixtureDb('grnts', async ({ client: c }) => {
      await withRoles(c, async ({ app, connect }) => {
        await applyAppRoleGrants(c, app);
        await c.query(`CREATE TABLE later (id serial PRIMARY KEY, name text)`);
        const db = await connect();
        const { rows: [row] } = await db.query(`INSERT INTO later (name) VALUES ('new') RETURNING id`);
        expect(row.id).toBe(1);
        const refusedTable = 'later';
        expect((await refused(() => db.query(`TRUNCATE ${refusedTable}`))).code).toBe('42501');
      });
    });
  }, 60000);

  it('does not reopen a table whose ownership moved away, and running it again changes nothing', async () => {
    await withFixtureDb('grnts', async ({ client: c }) => {
      await withRoles(c, async ({ app, connect }) => {
        const first = await applyAppRoleGrants(c, app);
        expect(await applyAppRoleGrants(c, app)).toEqual(first);
        const db = await connect();
        const denied = async (sql) => expect((await refused(() => db.query(sql))).code, sql).toBe('42501');
        await denied(`SELECT * FROM moved_away`);
        await denied(`DELETE FROM moved_away WHERE id = 1`);
        await c.query(`RESET ROLE`);
        expect((await c.query(`SELECT body FROM moved_away`)).rows).toEqual([{ body: 'kept' }]);
      });
    });
  }, 60000);

  it('audit tables are add-only, and deleting a parent still clears the link', async () => {
    await withFixtureDb('grnts', async ({ client: c }) => {
      await withRoles(c, async ({ app, connect }) => {
        await c.query(`
          CREATE TABLE people (id serial PRIMARY KEY);
          CREATE TABLE audit_logs (id serial PRIMARY KEY, person_id integer REFERENCES people(id) ON DELETE SET NULL, note text);
          CREATE TABLE security_events (id serial PRIMARY KEY, note text);`);
        expect(await applyAppRoleGrants(c, app)).toMatchObject({ appendOnly: 2, tables: 4 });
        const db = await connect();

        const { rows: [{ id: person }] } = await db.query(`INSERT INTO people DEFAULT VALUES RETURNING id`);
        const { rows: [{ id }] } = await db.query(`INSERT INTO audit_logs (person_id, note) VALUES ($1, 'kept') RETURNING id`, [person]);
        expect((await db.query(`SELECT note FROM audit_logs WHERE id = $1`, [id])).rows).toEqual([{ note: 'kept' }]);
        await db.query(`INSERT INTO security_events (note) VALUES ('kept')`);

        const denied = async (sql) => expect((await refused(() => db.query(sql))).code, sql).toBe('42501');
        await denied(`UPDATE audit_logs SET note = 'changed' WHERE id = ${id}`);
        await denied(`DELETE FROM audit_logs WHERE id = ${id}`);
        await denied(`UPDATE security_events SET note = 'changed' WHERE id = 1`);
        await denied(`DELETE FROM security_events WHERE id = 1`);
        await denied(`SELECT 1 FROM audit_logs WHERE id = ${id} FOR UPDATE`);
        await denied(`INSERT INTO audit_logs (id, note) VALUES (${id}, 'x') ON CONFLICT (id) DO UPDATE SET note = 'changed'`);

        // The foreign key runs as the owner, so the parent can still go, and the record survives.
        await db.query(`DELETE FROM people WHERE id = $1`, [person]);
        expect((await db.query(`SELECT person_id, note FROM audit_logs WHERE id = $1`, [id])).rows).toEqual([{ person_id: null, note: 'kept' }]);
      });
    });
  }, 60000);

  it('a superuser that owns the tables may run it when it says so, and still does not reopen a moved table', async () => {
    await withFixtureDb('grnts', async ({ client: c }) => {
      await withRoles(c, async ({ app, connect }) => {
        await c.query(`RESET ROLE`);
        await c.query(`CREATE TABLE super_owned (id serial PRIMARY KEY, name text)`);
        await expect(applyAppRoleGrants(c, app)).rejects.toThrow(/are a superuser/);
        const done = await applyAppRoleGrants(c, app, { ownerIsSuperuser: true });
        expect(done.tables).toBeGreaterThan(0);
        const db = await connect();
        await db.query(`INSERT INTO super_owned (name) VALUES ('a')`);
        expect((await refused(() => db.query(`SELECT * FROM moved_away`))).code).toBe('42501');
        expect((await refused(() => db.query(`ALTER TABLE super_owned ADD COLUMN zz integer`))).code).toBe('42501');
        await c.query(`CREATE TABLE super_later (id integer)`);
        await db.query(`INSERT INTO super_later VALUES (1)`);
      });
    });
  }, 60000);

  it('refuses a superuser, the owner itself, and an application role that could escape, changing nothing', async () => {
    await withFixtureDb('grnts', async ({ client: c }) => {
      await withRoles(c, async ({ owner, app, other }) => {
        const before = async () => (await c.query(`SELECT has_table_privilege($1, 'things', 'SELECT') AS can FROM (SELECT 1) x`, [app])).rows[0].can;
        expect(await before()).toBe(false);

        await expect(applyAppRoleGrants(c, owner)).rejects.toThrow(/owns the tables/);
        await expect(applyAppRoleGrants(c, 'pulse_e2e_no_such_role')).rejects.toThrow(/does not exist/);

        await c.query(`RESET ROLE`);
        const { rows: [{ me }] } = await c.query(`SELECT current_user AS me`);
        await expect(applyAppRoleGrants(c, app)).rejects.toThrow(/are a superuser/);
        await expect(applyAppRoleGrants(c, me)).rejects.toThrow(/are a superuser/);

        await c.query(`ALTER ROLE ${other} CREATEDB`);
        await c.query(`SET ROLE ${owner}`);
        await expect(applyAppRoleGrants(c, other)).rejects.toThrow(/superuser, CREATEROLE, CREATEDB or BYPASSRLS/);

        await c.query(`RESET ROLE`);
        await c.query(`ALTER ROLE ${other} NOCREATEDB`);
        await c.query(`GRANT ${owner} TO ${other}`);
        await c.query(`SET ROLE ${owner}`);
        await expect(applyAppRoleGrants(c, other)).rejects.toThrow(/is a member of/);

        expect(await before()).toBe(false);
      });
    });
  }, 60000);
});
