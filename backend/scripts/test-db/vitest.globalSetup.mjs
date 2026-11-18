/**
 * Vitest globalSetup — the backend suite runs ONLY against an isolated, marked
 * test database (§221). It runs once, in the main process, BEFORE any test
 * file is loaded; a refusal aborts the whole run with no test executed.
 *
 * The check is the same assertTestDatabase() every guarded writing tool runs
 * (scripts/test-db/guard.mjs): PULSE_TEST_DB=1, a pulse_e2e[_x] name, not the
 * developer DB named in backend/.env, and a marker row naming THIS database.
 * It connects through src/config/db.js — the very configuration every worker
 * inherits (DATABASE_URL, else DB_HOST/DB_NAME/...) — so what is verified here
 * is what the tests will use. There is no fallback: `npm test` without the
 * test-database environment refuses. Use `npm run test:db`.
 *
 * Kept OUT of src/__tests__ on purpose: it ends its own (main-process) pool,
 * and sharedPoolLifecycle.contract forbids pool.end() in that folder, where it
 * would close a worker's shared pool.
 */
export default async function assertSuiteDatabase() {
  const { assertTestDatabase } = await import('./guard.mjs');
  const { default: pool } = await import('../../src/config/db.js');
  try {
    const db = await assertTestDatabase(pool, 'vitest');
    console.log(`[vitest] test database verified: ${db}`);
  } finally {
    await pool.end().catch(() => {});
  }
  // Teardown: the fixture cheques helpers/testApp.js stores for JSON bank saves (§267).
  // Inline (not imported from testApp.js) so the main process opens no pool.
  return async () => {
    const { readdirSync, rmSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../uploads/', import.meta.url));
    try {
      for (const f of readdirSync(dir)) if (f.endsWith('_zz_test_bank_proof.pdf')) rmSync(dir + f, { force: true });
    } catch { /* no upload dir */ }
  };
}
