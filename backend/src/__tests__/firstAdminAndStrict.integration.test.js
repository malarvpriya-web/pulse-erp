/**
 * The first production login, and what post-deploy --strict treats as a warning
 * (DB-01, manual §252). Scratch databases only (helpers/migrationFixtureDb.js).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
const { withFixtureDb } = await import('./helpers/migrationFixtureDb.js');
const { createFirstAdmin } = await import('../../scripts/db/create-first-admin.mjs');
const { backfillMissingChecksums } = await import('../config/migrations.js');
const { baselineManifestNames } = await import('../config/baselineManifest.js');

const BACKEND = resolve(here, '../..');
const read = (rel) => readFileSync(resolve(BACKEND, rel), 'utf8').replace(/\r\n/g, '\n');

const SCHEMA = `
  CREATE TABLE companies (id integer PRIMARY KEY);
  CREATE TABLE roles (id serial PRIMARY KEY, code text);
  CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text, name text, role text,
    is_active boolean DEFAULT true, company_id integer, must_change_password boolean DEFAULT false);
  CREATE TABLE user_scope (user_id integer, company_id integer, is_primary boolean);
  CREATE TABLE user_roles (user_id integer, role_id integer, company_id integer, is_primary boolean, created_by integer, UNIQUE (user_id, role_id));
  CREATE TABLE audit_logs (id serial PRIMARY KEY, user_id integer, module_name text, action_type text, reference_id text,
    reference_type text, new_data_json jsonb, company_id integer);
  INSERT INTO companies VALUES (1);
  INSERT INTO roles (code) VALUES ('super_admin'), ('admin'), ('employee');`;
const GOOD = { email: ' First.Admin@Company.com ', name: 'First Admin', passwordHash: '$2a$10$hash-not-a-password' };
const count = async (c, t) => (await c.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;

describe('create-first-admin', () => {
  it('creates one super_admin who must change the password, with scope, role and an audit row', async () => {
    await withFixtureDb('fadm', async ({ client: c }) => {
      await c.query(SCHEMA);
      const user = await createFirstAdmin(c, GOOD);
      expect(user.email).toBe('first.admin@company.com');
      const { rows: [u] } = await c.query(`SELECT * FROM users`);
      expect(u).toMatchObject({ role: 'super_admin', is_active: true, must_change_password: true, company_id: 1, password_hash: GOOD.passwordHash });
      expect((await c.query(`SELECT company_id, is_primary FROM user_scope`)).rows).toEqual([{ company_id: 1, is_primary: true }]);
      expect((await c.query(`SELECT r.code, ur.is_primary FROM user_roles ur JOIN roles r ON r.id = ur.role_id`)).rows).toEqual([{ code: 'super_admin', is_primary: true }]);
      const { rows: [a] } = await c.query(`SELECT action_type, new_data_json FROM audit_logs`);
      expect(a.action_type).toBe('first_admin_created');
      expect(JSON.stringify(a.new_data_json)).not.toContain('hash');
    });
  }, 60000);

  it('refuses a second run, so it cannot add a backdoor account, and changes nothing', async () => {
    await withFixtureDb('fadm', async ({ client: c }) => {
      await c.query(SCHEMA);
      await createFirstAdmin(c, GOOD);
      await expect(createFirstAdmin(c, { ...GOOD, email: 'second@company.com' })).rejects.toThrow(/already exists/);
      expect(await count(c, 'users')).toBe(1);
      expect(await count(c, 'audit_logs')).toBe(1);
    });
  }, 60000);

  it('an admin held only through user_roles counts; an inactive one or a plain employee does not', async () => {
    await withFixtureDb('fadm', async ({ client: c }) => {
      await c.query(SCHEMA);
      await c.query(`INSERT INTO users (email, role, is_active) VALUES ('old@x.io', 'admin', false), ('staff@x.io', 'employee', true)`);
      await createFirstAdmin(c, GOOD);
      expect(await count(c, 'users')).toBe(3);
    });
    await withFixtureDb('fadm', async ({ client: c }) => {
      await c.query(SCHEMA);
      await c.query(`INSERT INTO users (email, role, is_active) VALUES ('held@x.io', 'employee', true)`);
      await c.query(`INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE r.code = 'admin'`);
      await expect(createFirstAdmin(c, GOOD)).rejects.toThrow(/already exists/);
    });
  }, 60000);

  it('refuses bad input and a missing company, with the database unchanged', async () => {
    await withFixtureDb('fadm', async ({ client: c }) => {
      await c.query(SCHEMA);
      await expect(createFirstAdmin(c, { ...GOOD, email: 'not-an-email' })).rejects.toThrow(/valid email/);
      await expect(createFirstAdmin(c, { ...GOOD, name: '  ' })).rejects.toThrow(/NAME is required/);
      await expect(createFirstAdmin(c, { ...GOOD, passwordHash: '' })).rejects.toThrow(/hash is required/);
      await expect(createFirstAdmin(c, { ...GOOD, companyId: 999 })).rejects.toThrow(/does not exist/);
      expect(await count(c, 'users')).toBe(0);
    });
  }, 60000);

  it('holds no default password: the script generates one per run and prints it only once', () => {
    const src = read('scripts/db/create-first-admin.mjs');
    expect(src).toMatch(/randomBytes\(18\)/);
    expect(src).not.toMatch(/Welcome@|Pulse@|password\s*[:=]\s*['"`][^'"`]+['"`]/);
    expect(src.match(/console\.log\([^\n]*\$\{password\}/g)).toHaveLength(1);
  });
});

describe('backfillMissingChecksums', () => {
  const FILE = '20261105000004_startup_schema_into_migrations.js';
  const sum = createHash('sha256')
    .update(readFileSync(resolve(BACKEND, 'src/database/migrations', FILE), 'utf8').replace(/\r\n/g, '\n')).digest('hex');

  it('stamps only an unstamped row whose file exists, and never overwrites a stored checksum', async () => {
    await withFixtureDb('fadm', async ({ client: c }) => {
      await c.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text)`);
      await c.query(`INSERT INTO schema_migrations VALUES ($1, NULL), ('gone_from_disk.js', NULL), ('20261105000003_device_telemetry_partition_function.js', 'kept-as-is')`, [FILE]);
      expect(await backfillMissingChecksums(c)).toEqual({ stamped: [FILE], noFile: ['gone_from_disk.js'] });
      const { rows } = await c.query(`SELECT name, checksum FROM schema_migrations ORDER BY name`);
      expect(Object.fromEntries(rows.map((r) => [r.name, r.checksum]))).toEqual({
        [FILE]: sum, 'gone_from_disk.js': null, '20261105000003_device_telemetry_partition_function.js': 'kept-as-is',
      });
    });
  }, 60000);
});

describe('post-deploy --strict', () => {
  it('a migration absorbed into the baseline is accounted for; an unexplained one still warns', () => {
    const names = baselineManifestNames();
    expect(names.has('20260530000003_payroll_settings.js')).toBe(true);
    expect(names.has('zz_not_a_real_migration.js')).toBe(false);
    for (const file of ['scripts/post-deploy.js', 'scripts/pre-deploy.js']) {
      const src = read(file);
      expect(src).toMatch(/baselineManifestNames\(\)\.has\(name\)/);
      expect(src).toMatch(/warn\(`  ⚠️   Applied migration missing from disk: \$\{name\}`\)/);
    }
  });

  it('an unstamped row with a file on disk still warns, and names the command that fixes it', () => {
    const src = read('scripts/post-deploy.js');
    expect(src).toMatch(/npm run migrate:backfill-checksums/);
    expect(src).not.toMatch(/checksums are set on new applications only/);
    expect(read('package.json')).toMatch(/"migrate:backfill-checksums"/);
  });

  it('--strict still fails on any warning that remains', () => {
    expect(read('scripts/post-deploy.js')).toMatch(/errors\.length > 0 \|\| \(strict && warnings\.length > 0\)/);
  });
});
