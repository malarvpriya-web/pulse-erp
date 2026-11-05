/**
 * ⚠⚠ DO NOT ADD `import pool from '../../config/db.js'` AT THE TOP OF THIS FILE.
 *
 * config/db.js constructs its Pool at module-eval time, capturing DB_PASSWORD as
 * it stands right then. setup.js sets DB_PASSWORD to the placeholder
 * 'test-db-password' before anything imports, so the real-DB suites read
 * backend/.env themselves and fix the variable BEFORE reaching for the pool —
 * which is why they load it with `await import(...)` after that block rather
 * than with a static import.
 *
 * A static import here is hoisted above that block in every suite that imports
 * this helper, so the pool is built with the placeholder and the whole file dies
 * with `password authentication failed for user "postgres"` — reported as the
 * file failing with its tests SKIPPED, not as a red test. Measured, not
 * theorised: it took out procurementLifecycle and procurementReverification
 * (39 tests) the first time this helper was written.
 *
 * Resolving it per call is free — after the first call the module is already in
 * the registry and `import()` returns the same instance.
 */
const db = () => import('../../config/db.js').then(m => m.default);

/**
 * Serialised access to `quality_settings.require_iqc_before_stock`.
 *
 * THE FAULT THIS EXISTS TO CLOSE (2026-09-15):
 *
 *   FAIL integration.procurementReverification > D8 > releases the held stock
 *   AssertionError: fixture drift: the receipt was not held for IQC:
 *     expected 'not_required' to be 'pending'
 *
 * It was not fixture drift. `require_iqc_before_stock` is a LIVE policy row for
 * company 1, and TWO suites use company 1:
 *
 *   - integration.procurementLifecycle  MUTATES it (5 windows, 4 of them false)
 *     to exercise both branches of the receipt path
 *   - integration.procurementReverification  READS it, needing `true`, because
 *     its D8 fixture builds a receipt that must be held for inspection
 *
 * vitest.config.js runs 4 workers and files in PARALLEL against the ONE real
 * database, so those two files overlap in wall-clock time. When reverification's
 * `heldReceipt()` posted its GRN inside a `withIqc(false)` window, the receipt
 * was created `not_required` and the assert fired. The lifecycle suite already
 * restores the value per test rather than per file — that comment reasons
 * carefully about a run being INTERRUPTED, but a sequential restore does nothing
 * about a CONCURRENT reader. The window is small, which is exactly why this
 * presented as a suite that passed in isolation and failed about 1 run in 5.
 *
 * ⚠ Do not "fix" this by asserting the ambient value, or by setting the policy
 * without the lock. Both suites must hold the SAME lock for the whole window in
 * which they depend on the value — setting it is not enough when the other suite
 * is free to set it back one statement later.
 *
 * The lock is a session-level advisory lock on a dedicated connection, not
 * `pg_advisory_xact_lock` as used in src/ (employee.service.js, recruitment
 * repository): a window here spans several HTTP requests, each running its own
 * transaction on its own pooled connection, so there is no single transaction to
 * scope it to. Session scope means the release is ours to guarantee — hence the
 * finally, and the client release in the same finally.
 */
const IQC_POLICY_LOCK_KEY = 88101;

/**
 * Run `fn` with `require_iqc_before_stock` pinned to `required` for `companyId`,
 * excluding any other suite that also uses this helper, and put the previous
 * value back whatever happens.
 *
 * @param {boolean} required   the policy value the body needs
 * @param {number}  companyId  the company whose policy row is being pinned
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withIqcPolicy(required, companyId, fn) {
  const pool = await db();
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [IQC_POLICY_LOCK_KEY]);

    const { rows: [before] } = await pool.query(
      'SELECT require_iqc_before_stock AS v FROM quality_settings WHERE company_id = $1', [companyId]);
    await setIqcPolicy(required, companyId);
    try {
      return await fn();
    } finally {
      // No row to restore means this company has no policy row and the receipt
      // path is taking its documented default — leave it that way.
      if (before) await setIqcPolicy(before.v, companyId);
    }
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [IQC_POLICY_LOCK_KEY]).catch(() => {});
    lock.release();
  }
}

export const setIqcPolicy = async (required, companyId) =>
  (await db()).query('UPDATE quality_settings SET require_iqc_before_stock = $1 WHERE company_id = $2',
    [required, companyId]);
