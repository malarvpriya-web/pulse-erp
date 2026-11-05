#!/usr/bin/env node
/**
 * scripts/test-db/start-backend.mjs — the backend, pointed at the isolated
 * test database (§220). Used by playwright.testdb.config.ts (webServer) and by
 * hand for the guarded scripts.
 *
 *   node scripts/test-db/start-backend.mjs [--db=pulse_e2e] [--port=5100]
 *
 * Before server.js is imported it sets, explicitly:
 *   DB_NAME=<test db>, PORT=<5100>, PULSE_TEST_DB=1, DATABASE_URL unset,
 *   JWT_SECRET=<the TEST secret> (so its tokens are refused by the developer
 *   server and vice versa)
 * and then runs the guard on the very pool server.js will use. No marker, wrong
 * name, developer DB → exit 1 before the server binds a port. server.js is not
 * modified; dotenv never overrides variables that are already set.
 */
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const db = arg('db', process.env.PULSE_TEST_DB_NAME || 'pulse_e2e');
const port = arg('port', process.env.PULSE_TEST_PORT || '5100');
if (String(port) === '5000') { console.error('❌ the test backend may not use the developer port 5000'); process.exit(1); }

const { testJwtSecret, assertTestDatabase } = await import('./guard.mjs');
delete process.env.DATABASE_URL;
process.env.DB_NAME = db;
process.env.PORT = String(port);
process.env.PULSE_TEST_DB = '1';
process.env.JWT_SECRET = testJwtSecret();

const { default: pool } = await import('../../src/config/db.js');
try {
  const name = await assertTestDatabase(pool, 'test-db/start-backend');
  console.log(`🧪 test backend: database ${name}, port ${port}, test JWT secret`);
} catch (e) {
  console.error(`\n❌ ${e.message}\n`);
  process.exit(1);
}
await import('../../server.js');
