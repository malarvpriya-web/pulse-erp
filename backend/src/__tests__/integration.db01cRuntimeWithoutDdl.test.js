/**
 * DB-01C2 — the runtime no longer needs DDL rights (manual §240, §241).
 *
 *   - the startup check is read-only: it creates no ledger, and refuses pending work;
 *   - the sequence migration keeps an existing value and is safe to repeat;
 *   - both document routes issue numbers with no DDL in the request;
 *   - the partition function creates one month, is idempotent, refuses bad input,
 *     has PUBLIC execution revoked, and is reachable by a real ordinary login,
 *     which cannot create a table itself;
 *   - the job uses that function;
 *   - a failed backup rejects, leaves no file, and supplied credentials are kept.
 *
 * Scratch databases and throwaway companies; all removed afterwards.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
const { default: pool } = await import('../config/db.js');
const { withFixtureDb, captureConsole } = await import('./helpers/migrationFixtureDb.js');
const { readMigrationState, migrationStartupProblem, migrationFiles } = await import('../config/migrations.js');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { buildApp } = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const seqs = await import('../database/migrations/20261105000002_document_number_sequences.js');
const fnMig = await import('../database/migrations/20261105000003_device_telemetry_partition_function.js');
const { default: fulfilmentRoutes } = await import('../modules/sales/fulfilment.routes.js');
const { default: crmRoutes } = await import('../modules/crm/routes/crm.routes.js');

const SRC = resolve(here, '..');
const app = buildApp(['/api/delivery', verifyToken, fulfilmentRoutes], ['/api/crm', verifyToken, crmRoutes]);

describe('the startup check', () => {
  it('on a database with no ledger: reports everything pending, and creates nothing', async () => {
    await withFixtureDb('rtddl', async ({ client: c }) => {
      const state = await readMigrationState(c);
      expect(state.ledger).toBe(false);
      expect(state.missing).toEqual(migrationFiles());
      expect((await c.query(`SELECT to_regclass('schema_migrations') AS t`)).rows[0].t).toBeNull();
      expect(migrationStartupProblem(state)).toMatch(/no migration ledger/);
    });
  }, 60000);

  it('names what is pending, refuses, and tells the operator what to run', async () => {
    await withFixtureDb('rtddl', async ({ client: c }) => {
      await c.query(`CREATE TABLE schema_migrations (id serial PRIMARY KEY, name text NOT NULL UNIQUE, applied_at timestamptz DEFAULT now(), duration_ms int, checksum text, applied_by text)`);
      const files = migrationFiles();
      await c.query(`INSERT INTO schema_migrations (name) SELECT unnest($1::text[])`, [files.slice(0, -2)]);
      const state = await readMigrationState(c);
      expect(state.missing).toEqual(files.slice(-2));
      const problem = migrationStartupProblem(state);
      expect(problem).toContain(files[files.length - 1]);
      expect(problem).toMatch(/2 migration\(s\) have not been applied/);
      expect(problem).toMatch(/npm run migrate/);
    });
  }, 60000);

  it('with nothing pending there is no problem, even with a checksum warning', () => {
    expect(migrationStartupProblem({ ledger: true, missing: [], tamperWarnings: ['  ❌  Checksum mismatch — x'] })).toBeNull();
  });

  it('leaves the connection outside any transaction, and writes are impossible inside the check', async () => {
    await withFixtureDb('rtddl', async ({ client: c }) => {
      await readMigrationState(c);
      const { rows: [r] } = await c.query(`SELECT pg_current_xact_id_if_assigned() IS NULL AS clean`);
      expect(r.clean).toBe(true);
      await expect(c.query(`CREATE TABLE zz_after (id int)`)).resolves.toBeTruthy();
    });
  }, 60000);

  it('server.js checks and never migrates', () => {
    const server = readFileSync(resolve(SRC, '../server.js'), 'utf8');
    expect(server).toMatch(/await assertMigrationsApplied\(\)/);
    expect(server).not.toMatch(/runMigrations/);
    const fn = readFileSync(resolve(SRC, 'config/migrations.js'), 'utf8');
    const state = fn.slice(fn.indexOf('export async function readMigrationState'), fn.indexOf('export async function verifyApplied'));
    expect(state).toMatch(/BEGIN READ ONLY/);
    expect(state).not.toMatch(/ensureTrackingTable/);
  });
});

describe('document-number sequences', () => {
  it('creates absent sequences, keeps an existing value, and repeating changes nothing', async () => {
    await withFixtureDb('rtddl', async ({ client: c, apply }) => {
      await c.query(`CREATE SEQUENCE quotation_number_seq START 23; SELECT nextval('quotation_number_seq');`);
      await captureConsole(() => apply(seqs));
      await captureConsole(() => apply(seqs));
      expect((await c.query(`SELECT nextval('quotation_number_seq') AS n`)).rows[0].n).toBe('24');
      expect((await c.query(`SELECT nextval('delivery_note_number_seq') AS n`)).rows[0].n).toBe('1');
    });
  }, 60000);

  it('no request handler creates either sequence', () => {
    for (const f of ['modules/sales/fulfilment.routes.js', 'modules/crm/routes/crm.routes.js']) {
      expect(readFileSync(resolve(SRC, f), 'utf8')).not.toMatch(/CREATE\s+SEQUENCE/i);
    }
  });

  describe('through the routes', () => {
    const PREFIX = 'ZZRTDDL';
    let co, u;
    const sweep = async (id) => {
      await pool.query(`DELETE FROM delivery_notes WHERE company_id = $1`, [id]);
      await pool.query(`UPDATE opportunities SET quotation_id = NULL WHERE company_id = $1`, [id]);
      await pool.query(`DELETE FROM quotations WHERE company_id = $1`, [id]);
      await pool.query(`DELETE FROM opportunities WHERE company_id = $1`, [id]);
      await pool.query(`DELETE FROM accounts WHERE company_id = $1`, [id]);
      await pool.query(`DELETE FROM parties WHERE company_id = $1`, [id]);
    };
    beforeAll(async () => {
      for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
      co = await createIsolatedCompany(pool, PREFIX);
      u = await addUser(pool, co, { label: 'r_sales', roleCode: 'admin' });
    }, 60000);
    afterAll(async () => { if (co) { await sweep(co.companyId); await dropIsolatedCompany(pool, co.companyId); } });

    it('POST /delivery/deliveries issues a number', async () => {
      const r = await request(app).post('/api/delivery/deliveries').set('Authorization', `Bearer ${u.token()}`)
        .send({ customer_name: 'ZZ Customer', status: 'pending', delivery_date: new Date().toISOString().slice(0, 10) });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.dn_number).toMatch(/^DN-\d{4}-\d{4,}$/);
    });

    it('POST /crm/opportunities/:id/create-quotation issues a number', async () => {
      const letters = randomBytes(6).toString('hex').replace(/\d/g, (n) => 'ghijklmnop'[n]);
      const { rows: [party] } = await pool.query(
        `INSERT INTO parties (party_code, party_type, name, company_id, is_active) VALUES ($1, 'Customer', 'ZZ Customer', $2, true) RETURNING id`,
        [`ZZ-${letters}`, co.companyId]);
      const { rows: [account] } = await pool.query(
        `INSERT INTO accounts (name, company_id, party_id) VALUES ('ZZ Customer', $1, $2) RETURNING id`, [co.companyId, party.id]);
      const { rows: [opp] } = await pool.query(
        `INSERT INTO opportunities (opportunity_name, company_id, account_id, stage, expected_value) VALUES ('ZZ Opp', $1, $2, 'qualification', 1000) RETURNING id`,
        [co.companyId, account.id]);
      const r = await request(app).post(`/api/crm/opportunities/${opp.id}/create-quotation`).set('Authorization', `Bearer ${u.token()}`).send({});
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.quotation.quotation_number).toMatch(/^QT-\d{4}-\d{4,}$/);
    });
  });
});

describe('the partition function', () => {
  const beforeState = `CREATE TABLE device_telemetry (ts timestamptz NOT NULL, v numeric) PARTITION BY RANGE (ts);`;
  const next = () => { const d = new Date(); const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); return [n.getUTCFullYear(), n.getUTCMonth() + 1]; };

  it('creates exactly one month, once', async () => {
    await withFixtureDb('rtddl', async ({ client: c, apply }) => {
      await c.query(beforeState);
      await captureConsole(() => apply(fnMig));
      const [y, m] = next();
      const call = async () => (await c.query(`SELECT ensure_device_telemetry_partition($1, $2) AS r`, [y, m])).rows[0].r;
      expect(await call()).toBe(true);
      expect(await call()).toBe(false);
      const name = `device_telemetry_${y}_${String(m).padStart(2, '0')}`;
      const { rows } = await c.query(`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'device_telemetry'::regclass`);
      expect(rows).toEqual([{ relname: name }]);
    });
  }, 60000);

  it.each([[2026, 13], [2026, 0], [null, 1], [2026, null], [1999, 1], [3000, 1]])('refuses (%s, %s)', async (y, m) => {
    await withFixtureDb('rtddl', async ({ client: c, apply }) => {
      await c.query(beforeState);
      await captureConsole(() => apply(fnMig));
      await expect(c.query(`SELECT ensure_device_telemetry_partition($1::int, $2::int)`, [y, m])).rejects.toMatchObject({ code: '22023' });
    });
  }, 60000);

  it('refuses a month outside the window', async () => {
    await withFixtureDb('rtddl', async ({ client: c, apply }) => {
      await c.query(beforeState);
      await captureConsole(() => apply(fnMig));
      const y = new Date().getUTCFullYear();
      await expect(c.query(`SELECT ensure_device_telemetry_partition($1, 1)`, [y + 5])).rejects.toThrow(/outside the allowed window/);
      await expect(c.query(`SELECT ensure_device_telemetry_partition($1, 1)`, [y - 5])).rejects.toThrow(/outside the allowed window/);
    });
  }, 60000);

  it('is locked down: SECURITY DEFINER, fixed search_path, no PUBLIC execute', async () => {
    await withFixtureDb('rtddl', async ({ client: c, apply }) => {
      await c.query(beforeState);
      await captureConsole(() => apply(fnMig));
      const { rows: [f] } = await c.query(`SELECT prosecdef, proconfig, proacl::text AS acl FROM pg_proc WHERE proname = 'ensure_device_telemetry_partition'`);
      expect(f.prosecdef).toBe(true);
      expect(f.proconfig).toEqual(['search_path=pg_catalog, public']);
      expect(f.acl).not.toMatch(/(^|[{,])=X/);
    });
  }, 60000);

  it('a real ordinary login with EXECUTE can add a month, and still cannot create a table', async () => {
    await withFixtureDb('rtddl', async ({ client: c, apply }) => {
      const tag = randomBytes(5).toString('hex');
      const role = `pulse_e2e_app_${tag}`;
      const password = randomBytes(18).toString('hex');
      await c.query(beforeState);
      await captureConsole(() => apply(fnMig));
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      let app;
      try {
        const { host, port, database } = c.connectionParameters;
        app = new pg.Client({ host, port, database, user: role, password, ssl: false });
        await app.connect();
        const [y, m] = next();
        await expect(app.query(`SELECT ensure_device_telemetry_partition($1, $2)`, [y, m])).rejects.toMatchObject({ code: '42501' });
        await c.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT EXECUTE ON FUNCTION ensure_device_telemetry_partition(integer, integer) TO ${role}`);
        expect((await app.query(`SELECT ensure_device_telemetry_partition($1, $2) AS r`, [y, m])).rows[0].r).toBe(true);
        await expect(app.query(`CREATE TABLE zz_probe (id int)`)).rejects.toMatchObject({ code: '42501' });
        await expect(app.query(`ALTER TABLE device_telemetry ADD COLUMN zz int`)).rejects.toMatchObject({ code: '42501' });
      } finally {
        if (app) await app.end().catch(() => {});
        await c.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER`);
        await c.query(`DROP OWNED BY ${role}`);
        await c.query(`DROP ROLE ${role}`);
      }
    });
  }, 60000);

  it('down removes the function and keeps partitions', async () => {
    await withFixtureDb('rtddl', async ({ client: c, apply }) => {
      await c.query(beforeState);
      await captureConsole(() => apply(fnMig));
      const [y, m] = next();
      await c.query(`SELECT ensure_device_telemetry_partition($1, $2)`, [y, m]);
      const { makeKnexShim } = await import('../config/migrations.js');
      await fnMig.down(makeKnexShim(c));
      expect((await c.query(`SELECT COUNT(*)::int AS n FROM pg_proc WHERE proname = 'ensure_device_telemetry_partition'`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT COUNT(*)::int AS n FROM pg_inherits WHERE inhparent = 'device_telemetry'::regclass`)).rows[0].n).toBe(1);
    });
  }, 60000);

  it('the job calls the function and contains no CREATE TABLE', () => {
    const job = readFileSync(resolve(SRC, 'jobs/iotPartitions.cron.js'), 'utf8');
    expect(job).toMatch(/ensure_device_telemetry_partition\(\$1, \$2\)/);
    expect(job).not.toMatch(/CREATE TABLE \$\{/);
  });
});

describe('backups', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock('child_process'); });

  const withSpawn = async (impl) => {
    vi.resetModules();
    vi.doMock('child_process', async (orig) => ({ ...(await orig()), spawnSync: impl }));
    return import('../jobs/backup.cron.js');
  };

  it('a failed pg_dump rejects, so the job wrapper records a failure, and leaves no file behind', async () => {
    const BK = resolve(SRC, '../backups');
    const before = existsSync(BK) ? readdirSync(BK).sort() : [];
    const { runBackup } = await withSpawn((cmd, args) => {
      if (args[0] === '--version') return { status: 0 };
      return { status: 1, stderr: 'pg_dump: error: permission denied for sequence x' };
    });
    await captureConsole(async () => {
      await expect(runBackup()).rejects.toThrow(/pg_dump failed: pg_dump: error: permission denied/);
      const { runJob } = await import('../jobs/jobRun.js');
      const result = await runJob('backup', runBackup);
      expect(result.ok).toBe(false);
    });
    expect(existsSync(BK) ? readdirSync(BK).sort() : []).toEqual(before);
  });

  it('a missing pg_dump rejects too', async () => {
    const { runBackup } = await withSpawn(() => ({ error: new Error('ENOENT') }));
    await captureConsole(() => expect(runBackup()).rejects.toThrow(/pg_dump not found/));
  });

  it('uses a supplied backup login, and otherwise the application login', async () => {
    const seen = [];
    const { runBackup } = await withSpawn((cmd, args, opts) => {
      if (args[0] !== '--version') seen.push({ user: args[args.indexOf('-U') + 1], pw: opts.env.PGPASSWORD });
      return args[0] === '--version' ? { status: 0 } : { status: 1, stderr: 'stop here' };
    });
    const saved = { u: process.env.BACKUP_DB_USER, p: process.env.BACKUP_DB_PASSWORD };
    process.env.BACKUP_DB_USER = 'zz_backup_login';
    process.env.BACKUP_DB_PASSWORD = 'zz_backup_secret';
    try {
      await captureConsole(() => expect(runBackup()).rejects.toThrow());
      delete process.env.BACKUP_DB_USER; delete process.env.BACKUP_DB_PASSWORD;
      await captureConsole(() => expect(runBackup()).rejects.toThrow());
    } finally {
      if (saved.u === undefined) delete process.env.BACKUP_DB_USER; else process.env.BACKUP_DB_USER = saved.u;
      if (saved.p === undefined) delete process.env.BACKUP_DB_PASSWORD; else process.env.BACKUP_DB_PASSWORD = saved.p;
    }
    expect(seen[0]).toEqual({ user: 'zz_backup_login', pw: 'zz_backup_secret' });
    expect(seen[1].user).not.toBe('zz_backup_login');
    expect(seen[1].pw).not.toBe('zz_backup_secret');
  });

  it('follows DATABASE_URL, with a supplied backup login still taking precedence', async () => {
    const seen = [];
    const { runBackup } = await withSpawn((cmd, args, opts) => {
      if (args[0] !== '--version') seen.push({ host: args[args.indexOf('-h') + 1], db: args[args.indexOf('-d') + 1], user: args[args.indexOf('-U') + 1], pw: opts.env.PGPASSWORD, ssl: opts.env.PGSSLMODE });
      return args[0] === '--version' ? { status: 0 } : { status: 1, stderr: 'stop here' };
    });
    const saved = { url: process.env.DATABASE_URL, u: process.env.BACKUP_DB_USER, p: process.env.BACKUP_DB_PASSWORD };
    process.env.DATABASE_URL = 'postgresql://url_user:url_pw@url-host:6543/url_db?sslmode=require';
    delete process.env.BACKUP_DB_USER; delete process.env.BACKUP_DB_PASSWORD;
    try {
      await captureConsole(() => expect(runBackup()).rejects.toThrow());
      process.env.BACKUP_DB_USER = 'zz_backup_login';
      process.env.BACKUP_DB_PASSWORD = 'zz_backup_secret';
      await captureConsole(() => expect(runBackup()).rejects.toThrow());
    } finally {
      for (const [k, v] of [['DATABASE_URL', saved.url], ['BACKUP_DB_USER', saved.u], ['BACKUP_DB_PASSWORD', saved.p]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    expect(seen[0]).toEqual({ host: 'url-host', db: 'url_db', user: 'url_user', pw: 'url_pw', ssl: 'require' });
    expect(seen[1]).toEqual({ host: 'url-host', db: 'url_db', user: 'zz_backup_login', pw: 'zz_backup_secret', ssl: 'require' });
  });

  it('db-backup.js keeps a credential already in the environment', () => {
    const src = readFileSync(resolve(SRC, '../scripts/db-backup.js'), 'utf8');
    expect(src).toMatch(/if \(process\.env\[k\.trim\(\)\] === undefined\) process\.env\[k\.trim\(\)\] =/);
    expect(src).not.toMatch(/^\s*process\.env\[k\.trim\(\)\] = /m);
  });
});
