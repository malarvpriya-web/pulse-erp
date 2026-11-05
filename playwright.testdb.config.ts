/**
 * playwright.testdb.config.ts — browser specs that WRITE numbered documents,
 * run against the ISOLATED TEST DATABASE only (§220).
 *
 *   cd backend && node scripts/test-db/setup.mjs          # once (creates pulse_e2e)
 *   npx playwright test -c playwright.testdb.config.ts     # from Pulse/
 *
 * Playwright starts its OWN servers and never reuses a running one:
 *   backend  :5100  scripts/test-db/start-backend.mjs (guarded: refuses to bind
 *                   unless connected to the marked test DB; own JWT secret)
 *   frontend :5174  Vite with VITE_API_URL=http://localhost:5100/api
 * The developer servers (:5000 / :5173) are never contacted: every base URL
 * here is explicit, the guarded spec refuses :5000/:5173, and a token signed
 * with the test secret is rejected by the developer backend anyway.
 */
import { defineConfig } from '@playwright/test';
import path from 'node:path';

const TEST_DB = process.env.PULSE_TEST_DB_NAME || 'pulse_e2e';
const API = 'http://localhost:5100';
const FRONT = 'http://localhost:5174';
const AUTH_FILE = 'tests/.auth/testdb-user.json';
const TEST_JWT_SECRET = process.env.PULSE_TEST_JWT_SECRET || 'pulse-e2e-test-database-only-signing-key-0001';

// The environment every child (servers, mint script, guards) inherits.
Object.assign(process.env, {
  PULSE_TEST_DB: '1',
  DB_NAME: TEST_DB,
  JWT_SECRET: TEST_JWT_SECRET,
  PULSE_API_BASE: API,
  PULSE_FRONT_BASE: FRONT,
  PULSE_AUTH_FILE: AUTH_FILE,
  E2E_LOGIN_EMAIL: 'e2e.superadmin@pulse-e2e.test',
});
delete process.env.DATABASE_URL;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: FRONT, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    {
      command: 'node scripts/test-db/start-backend.mjs',
      cwd: path.resolve(__dirname, 'backend'),
      url: `${API}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...process.env } as Record<string, string>,
    },
    {
      command: 'npx vite --port 5174 --strictPort',
      cwd: path.resolve(__dirname, 'frontend'),
      url: FRONT,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...process.env, VITE_API_URL: `${API}/api` } as Record<string, string>,
    },
  ],
  projects: [
    { name: 'testdb-setup', testMatch: '**/auth.setup.ts' },
    {
      name: 'procurement-hardening',
      testMatch: '**/03-crud/procurement-hardening.spec.ts',
      dependencies: ['testdb-setup'],
      use: { storageState: AUTH_FILE },
    },
    {
      name: 'db-consistency',
      testMatch: '**/06-db-consistency.spec.ts',
      dependencies: ['testdb-setup'],
      use: { storageState: AUTH_FILE },
    },
  ],
});
