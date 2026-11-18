/**
 * Only the server process takes the restricted login (DB-01C3, manual §250).
 *
 * Tools and test suites read DB_USER and DB_PASSWORD, and need the owner's rights. A
 * browser-test server runs on the test database, where the application role has no
 * grants, so it must keep the tools' login.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PULSE_APP_LOGIN_APPLIED = '1'; // this test calls the function itself
const { applyAppLogin } = await import('../config/appLogin.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(here, '../..');
const read = (rel) => readFileSync(path.join(BACKEND, rel), 'utf8').replace(/\r\n/g, '\n');

describe('applyAppLogin', () => {
  it('swaps in the application login', () => {
    const env = { DB_USER: 'owner', DB_PASSWORD: 'owner-pw', APP_DB_USER: 'app', APP_DB_PASSWORD: 'app-pw' };
    expect(applyAppLogin(env)).toBe('APP_DB_USER');
    expect(env).toMatchObject({ DB_USER: 'app', DB_PASSWORD: 'app-pw' });
  });

  it('with nothing set, changes nothing', () => {
    const env = { DB_USER: 'owner', DB_PASSWORD: 'owner-pw' };
    expect(applyAppLogin(env)).toBeNull();
    expect(env).toEqual({ DB_USER: 'owner', DB_PASSWORD: 'owner-pw' });
  });

  it('an empty value counts as not set, which is how a test server opts out', () => {
    const env = { DB_USER: 'owner', DB_PASSWORD: 'owner-pw', APP_DB_USER: '', APP_DB_PASSWORD: '', APP_DATABASE_URL: '' };
    expect(applyAppLogin(env)).toBeNull();
    expect(env.DB_USER).toBe('owner');
  });

  it('a user with no password is refused, and the message repeats no secret', () => {
    const env = { DB_USER: 'owner', DB_PASSWORD: 'owner-secret', APP_DB_USER: 'app' };
    expect(() => applyAppLogin(env)).toThrow(/without APP_DB_PASSWORD/);
    expect(env.DB_USER).toBe('owner');
  });

  it('a hosted URL replaces DATABASE_URL', () => {
    const env = { DATABASE_URL: 'postgresql://owner@h/db', APP_DATABASE_URL: 'postgresql://app@h/db' };
    expect(applyAppLogin(env)).toBe('APP_DATABASE_URL');
    expect(env.DATABASE_URL).toBe('postgresql://app@h/db');
  });
});

describe('who takes the login', () => {
  it('server.js imports it first, before anything can open the pool', () => {
    const first = read('server.js').split('\n').find((l) => /^import\s/.test(l));
    expect(first).toMatch(/^import ["']\.\/src\/config\/appLogin\.js["'];?$/);
  });

  it('nothing else under src/ or scripts/ imports it', () => {
    const src = read('src/config/migrations.js') + read('src/config/db.js') + read('scripts/test-db/setup.mjs');
    expect(src).not.toMatch(/appLogin/);
  });

  it('a server on the test database keeps the tools login', () => {
    expect(read('src/config/appLogin.js')).toMatch(/process\.env\.PULSE_TEST_DB !== '1'/);
    // The test server sets the marker before it loads server.js.
    const start = read('scripts/test-db/start-backend.mjs');
    expect(start.indexOf("process.env.PULSE_TEST_DB = '1'")).toBeGreaterThan(-1);
    expect(start.indexOf("process.env.PULSE_TEST_DB = '1'")).toBeLessThan(start.lastIndexOf('server.js'));
  });

  it('an admin screen cannot overwrite the login through the integration settings', () => {
    const config = read('src/modules/integrations/integrationConfig.js');
    for (const key of ['APP_DB_USER', 'APP_DB_PASSWORD', 'APP_DATABASE_URL']) expect(config).toContain(`'${key}'`);
  });
});
