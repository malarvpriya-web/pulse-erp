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
const env = { ...process.env, DB_NAME: process.env.PULSE_TEST_DB_NAME || 'pulse_e2e', PULSE_TEST_DB: '1' };
delete env.DATABASE_URL;
const r = spawnSync(process.execPath, [vitest, 'run', ...process.argv.slice(2)], { cwd: BACKEND, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
