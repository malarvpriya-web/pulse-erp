/**
 * Scratch PostgreSQL databases for migration fixture tests (§225/§226).
 *
 *   await withFixtureDb('iot', async (db) => {
 *     await db.client.query(`CREATE TABLE ...`);        // the before-state
 *     await db.apply(migrationModule);                   // the REAL migration
 *     ...assertions on db.client...
 *   });
 *
 * Why a separate DATABASE and not a schema: two of the migrations under test
 * (20260915000017 addFk, 20260926000013) look up constraints in pg_constraint by
 * NAME with no schema filter, so inside the shared test database they would see
 * the real constraints and skip their own work. A scratch database contains only
 * the fixture, so nothing can resolve to — or lock — a shared table. That is also
 * what keeps these tests out of the §223 deadlock class.
 *
 * Safety (each one checked, none assumed):
 *   1. The suite's own database is verified with assertTestDatabase first: this
 *      only ever runs on a server that hosts a marked test database.
 *   2. The maintenance connection (database `postgres`) must reach THAT server:
 *      it must see the verified test database in pg_database, and report the
 *      same server address/port. Then CREATE DATABASE.
 *   3. The new database gets the test marker naming itself and is verified with
 *      assertTestDatabase before the caller touches it.
 *   4. Names are unique per process and call: pulse_e2e_mig<tag>h<host>p<pid>t<time>r<rand>,
 *      all [a-z0-9] so they match the guard's TEST_DB_PATTERN.
 *   5. Cleanup is in `finally`, and drops ONLY the exact name this process
 *      created (tracked in memory, re-checked against the naming pattern).
 *   6. Stale databases (a process killed mid-test) are swept only when ALL hold:
 *      same tag and same host tag, the owning pid is no longer alive on this
 *      host, nobody is connected to it, and it carries the marker naming itself.
 *   7. The developer database is never connected to: the only connections made
 *      are to `postgres` and to databases this helper created or verified.
 */
import os from 'node:os';
import crypto from 'node:crypto';
import pg from 'pg';

const { assertTestDatabase, MARKER } = await import('../../../scripts/test-db/guard.mjs');
const { makeKnexShim } = await import('../../config/migrations.js');
const { default: pool } = await import('../../config/db.js');

const PREFIX = 'pulse_e2e_mig';
const NAME_RE = /^pulse_e2e_mig([a-z]+)h([a-z0-9]{4})p(\d+)t[a-z0-9]+r[a-z0-9]+$/;
const HOST_TAG = crypto.createHash('sha1').update(os.hostname()).digest('hex').slice(0, 4);
const created = new Set();

/** Connection settings of the suite's own pool, pointed at another database. */
function connFor(database) {
  const o = pool.options || {};
  if (o.connectionString) {
    const url = new URL(o.connectionString);
    url.pathname = `/${database}`;
    return { connectionString: url.toString(), ssl: o.ssl };
  }
  return { host: o.host, port: o.port, user: o.user, password: o.password, ssl: o.ssl, database };
}

async function connect(database) {
  const c = new pg.Client(connFor(database));
  c.on('error', () => {});               // a FORCE drop terminates it; that is expected
  await c.connect();
  return c;
}

const serverOf = async (q) => (await q.query(
  `SELECT COALESCE(inet_server_addr()::text, 'local') AS addr, current_setting('port') AS port`)).rows[0];

/** Steps 1 + 2: a verified test database, and a maintenance connection to the same server. */
async function verifiedAdmin() {
  const testDb = await assertTestDatabase(pool, 'migration-fixture');
  const admin = await connect('postgres');
  try {
    const [mine, theirs] = await Promise.all([serverOf(pool), serverOf(admin)]);
    const { rows } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [testDb]);
    if (!rows.length || mine.addr !== theirs.addr || mine.port !== theirs.port) {
      throw new Error(`[migration-fixture] refusing: the maintenance connection is not the server hosting ${testDb}`);
    }
    return admin;
  } catch (e) { await admin.end().catch(() => {}); throw e; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Step 6. Returns the names dropped. */
export async function sweepStale(tag) {
  const admin = await verifiedAdmin();
  const dropped = [];
  try {
    const { rows } = await admin.query(
      `SELECT d.datname,
              (SELECT COUNT(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS conns
         FROM pg_database d WHERE d.datname LIKE $1`, [`${PREFIX}${tag}h%`]);
    for (const { datname, conns } of rows) {
      const m = NAME_RE.exec(datname);
      if (!m || m[1] !== tag || m[2] !== HOST_TAG || conns > 0 || pidAlive(Number(m[3]))) continue;
      let ours = false;
      const c = await connect(datname).catch(() => null);
      if (c) {
        ours = await c.query(`SELECT marker, database_name FROM pulse_test_environment WHERE id = 1`)
          .then((r) => r.rows[0]?.marker === MARKER && r.rows[0]?.database_name === datname).catch(() => false);
        await c.end().catch(() => {});
      }
      if (!ours) continue;
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      dropped.push(datname);
    }
  } finally { await admin.end().catch(() => {}); }
  return dropped;
}

async function dropExact(name) {
  if (!created.has(name) || !NAME_RE.test(name)) throw new Error(`[migration-fixture] refusing to drop ${name}: not created by this process`);
  const admin = await verifiedAdmin();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    created.delete(name);
  } finally { await admin.end().catch(() => {}); }
}

/** Does a database of this name exist? (for the cleanup tests) */
export async function databaseExists(name) {
  const admin = await verifiedAdmin();
  try { return (await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])).rows.length === 1; }
  finally { await admin.end().catch(() => {}); }
}

/**
 * Run fn against a brand-new scratch database; always drop it afterwards.
 * fn receives { name, client, apply(migrationModule) }.
 */
export async function withFixtureDb(tag, fn) {
  if (!/^[a-z]{2,8}$/.test(tag)) throw new Error(`fixture tag must be 2-8 lowercase letters, got "${tag}"`);
  await sweepStale(tag);            // leftovers of an interrupted earlier run (step 6)
  const name = `${PREFIX}${tag}h${HOST_TAG}p${process.pid}t${Date.now().toString(36)}r${crypto.randomBytes(3).toString('hex')}`;
  const admin = await verifiedAdmin();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created.add(name);
  } finally { await admin.end().catch(() => {}); }

  let client;
  try {
    client = await connect(name);
    await client.query(`
      CREATE TABLE pulse_test_environment (
        id INTEGER PRIMARY KEY CHECK (id = 1), marker TEXT NOT NULL,
        database_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`INSERT INTO pulse_test_environment (id, marker, database_name) VALUES (1, $1, $2)`, [MARKER, name]);
    await assertTestDatabase(client, 'migration-fixture');

    /** Exactly how config/migrations.js runMigrations() applies one migration. */
    const apply = async (mod) => {
      await client.query('BEGIN');
      try {
        await mod.up(makeKnexShim(client));
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    };
    return await fn({ name, client, apply });
  } finally {
    if (client) await client.end().catch(() => {});
    await dropExact(name);
  }
}

/** Silence a migration's console output, returning what it printed. */
export async function captureConsole(fn) {
  const out = { log: [], warn: [], error: [] };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(out)) console[k] = (...a) => out[k].push(a.join(' '));
  try { await fn(); } finally { Object.assign(console, saved); }
  return out;
}
