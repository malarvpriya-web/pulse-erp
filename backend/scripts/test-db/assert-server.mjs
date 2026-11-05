#!/usr/bin/env node
/**
 * scripts/test-db/assert-server.mjs <apiBase> — exit 0 only if this process
 * is connected to the marked test database AND the server at <apiBase> serves
 * that same database (§220). Used by Playwright before any guarded spec writes.
 */
const { default: pool } = await import('../../src/config/db.js');
const { assertTestDatabase, assertTestServer, mintTestToken } = await import('./guard.mjs');
const api = process.argv[2];
try {
  const db = await assertTestDatabase(pool, 'test-db/assert-server');
  await assertTestServer(pool, api, await mintTestToken(pool), 'test-db/assert-server');
  console.log(`✅ ${api} serves the isolated test database ${db}`);
  await pool.end();
} catch (e) {
  console.error(`\n❌ ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exit(1);
}
