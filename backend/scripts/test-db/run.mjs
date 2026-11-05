#!/usr/bin/env node
/**
 * scripts/test-db/run.mjs — run a guarded test tool against the isolated test
 * database, with exactly the environment the guard expects (§220).
 *
 *   node scripts/test-db/run.mjs scripts/procurement-lifecycle-probe.mjs
 *   node scripts/test-db/run.mjs scripts/sca/exercise-chain.mjs --base=http://localhost:5100
 *
 * Sets DB_NAME=<PULSE_TEST_DB_NAME|pulse_e2e>, PULSE_TEST_DB=1, the TEST JWT
 * secret, PROBE_BASE / SCA_BASE_URL / BASE_URL defaults pointing at the test
 * backend (http://localhost:5100), and REMOVES DATABASE_URL. The tool itself
 * still runs the guard — this wrapper only removes the ways to get it wrong.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testJwtSecret } from './guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [script, ...rest] = process.argv.slice(2);
if (!script) { console.error('usage: node scripts/test-db/run.mjs <script> [args…]'); process.exit(2); }
const api = process.env.PULSE_TEST_API || 'http://localhost:5100';
const env = {
  ...process.env,
  DB_NAME: process.env.PULSE_TEST_DB_NAME || 'pulse_e2e',
  PULSE_TEST_DB: '1',
  JWT_SECRET: testJwtSecret(),
  PROBE_BASE: process.env.PROBE_BASE || api,
  SCA_BASE_URL: process.env.SCA_BASE_URL || api,
  BASE_URL: process.env.BASE_URL || `${api}/api/v1`,
};
delete env.DATABASE_URL;
const r = spawnSync(process.execPath, [script, ...rest], { cwd: path.resolve(__dirname, '../..'), env, stdio: 'inherit' });
process.exit(r.status ?? 1);
