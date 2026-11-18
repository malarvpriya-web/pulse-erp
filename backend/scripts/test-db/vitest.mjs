#!/usr/bin/env node
/**
 * scripts/test-db/vitest.mjs — `npm run test:db [-- vitest args]` (§221).
 *
 * Runs the backend vitest suite against the isolated test database:
 * DB_NAME=<PULSE_TEST_DB_NAME|pulse_e2e>, PULSE_TEST_DB=1, DATABASE_URL
 * REMOVED (so a connection string in the shell cannot redirect it). The
 * suite's globalSetup (scripts/test-db/vitest.globalSetup.mjs) still verifies the
 * marker before any test runs — this wrapper only sets the environment.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vitest = path.join(BACKEND, 'node_modules/vitest/vitest.mjs');   // the bin; not in the package exports map
const env = { ...process.env, DB_NAME: process.env.PULSE_TEST_DB_NAME || 'pulse_e2e', PULSE_TEST_DB: '1',
  // Payroll fixtures use months up to 2031; a test that needs the real date sets its own.
  PULSE_PAYROLL_TODAY: process.env.PULSE_PAYROLL_TODAY || '2099-12-31',
  // HR containment switches start at their shipped default (ON) whatever the
  // developer's backend/.env says (§275: dev turned HR_CONTAINMENT_FNF off).
  // dotenv does not override a variable that is already set, even to ''. A
  // suite that tests a lifted switch sets it to 'off' itself and restores it.
  HR_CONTAINMENT_FNF: '', HR_CONTAINMENT_EXIT_STATUS: '' };
delete env.DATABASE_URL;
const r = spawnSync(process.execPath, [vitest, 'run', ...process.argv.slice(2)], { cwd: BACKEND, env, stdio: 'inherit' });
// A run that dies with no failed test has to say how it died (twice: exit 127, no message).
if (r.status !== 0 || r.signal || r.error) console.error(`[test:db] vitest ended: status=${r.status} signal=${r.signal} error=${r.error?.message ?? 'none'}`);
process.exit(r.status ?? 1);
