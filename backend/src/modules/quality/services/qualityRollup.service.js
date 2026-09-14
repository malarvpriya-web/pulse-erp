/**
 * qualityRollup.service.js — one place that decides a source's quality status,
 * and one place that releases the stock a pass has cleared.
 *
 * WHY THIS IS A SERVICE AND NOT A FUNCTION INSIDE quality.routes.js
 * -----------------------------------------------------------------
 * It used to be private to that router, which meant only the Quality module
 * could reach it — and that is exactly what made a passing inspection recorded
 * in PROCUREMENT release nothing.
 *
 * Three inspection systems write to this database:
 *
 *   quality_tests        Quality module. Completing every test with no failure
 *                        rolls the GRN to 'passed', which releases the held
 *                        stock. The only path that ever did.
 *   quality_inspections  Procurement's own Quality Inspection screen. Recorded
 *                        a verdict and stopped there, so a storekeeper could
 *                        mark a receipt "pass", see it saved, and the goods
 *                        stayed held for inspection indefinitely.
 *   inspection_reports   Quality's checklist screen. Raises an NCR on failure;
 *                        does not release either.
 *
 * The fix chosen was to make Procurement's screen a writer of quality_tests
 * rather than a fourth opinion, so incoming quality has ONE system of record
 * and one release path. This module is what both callers now share.
 *
 * ⚠ Call this AFTER the transaction that wrote the tests has committed. It
 * reads through the pool, not a caller's client, so rows still inside an open
 * transaction are invisible to it and the rollup would compute from a state
 * that does not exist yet.
 */
import pool from '../../shared/db.js';
import grnService from '../../procurement/services/grn.service.js';

/**
 * Recompute a source's overall `quality_status` from its tests, and release the
 * receipt's held stock once every test is done and none failed.
 *
 * @param {{grn_id?: number|string, operation_id?: number|string}} source
 * @returns {Promise<{grn_status: string|null, operation_status: string|null, released: boolean}>}
 */
export async function rollupQualityStatus({ grn_id, operation_id }) {
  const bucket = async (idCol, idVal, table, statusCol) => {
    if (!idVal) return null;
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE result='fail') AS failed,
         COUNT(*) FILTER (WHERE status='completed') AS done,
         COUNT(*) AS total
       FROM quality_tests WHERE ${idCol}=$1`, [idVal]);
    const r = rows[0];
    let status;
    if (parseInt(r.total) === 0)        status = 'not_required';
    else if (parseInt(r.failed) > 0)    status = 'failed';
    else if (parseInt(r.done) === parseInt(r.total)) status = 'passed';
    else if (parseInt(r.done) > 0)      status = 'in_progress';
    else                                status = 'pending';
    await pool.query(`UPDATE ${table} SET ${statusCol}=$1 WHERE id=$2`, [status, idVal]).catch(() => {});
    return status;
  };

  const grnStatus = await bucket('grn_id', grn_id, 'goods_receipt_notes', 'quality_status');
  const opStatus  = await bucket('operation_id', operation_id, 'production_operations', 'quality_status');

  // grn.service withholds accepted stock from the ledger while IQC is pending
  // (see createGRN's holdForIqc) — release it now that every test on this GRN
  // is done and none failed. releaseGrnStock keys its idempotency on the stock
  // ledger, so re-running a rollup that keeps the GRN at 'passed' is a no-op.
  let released = false;
  if (grn_id && grnStatus === 'passed') {
    const result = await grnService.releaseGrnStock(grn_id);
    released = Boolean(result?.released);
  }

  return { grn_status: grnStatus, operation_status: opStatus, released };
}

export default { rollupQualityStatus };
