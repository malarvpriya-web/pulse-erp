/**
 * anomaly-fixture.mjs — prove the anomaly detectors actually fire.
 *
 * `/ai/anomalies` returning `count: 0` is indistinguishable from a detector that
 * throws on every run and swallows the error — which is exactly what four of the
 * five were doing before the schema audit (`po_items`, `payroll_runs.tds_deducted`
 * and `invoices.client_name` have never existed). A green "no anomalies" is only
 * meaningful once the same code has been shown to go red on a real one.
 *
 * This plants a deliberate outlier, asserts the detector reports it, removes it,
 * and asserts the count returns to the baseline. Every row is marked ZZANOM.
 *
 *   node scripts/audit/anomaly-fixture.mjs
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKEND = path.resolve(import.meta.dirname, '..', '..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const pool = (await import(pathToFileURL(path.join(BACKEND, 'src/config/db.js')).href)).default;
const { detectAnomalies } = await import(
  pathToFileURL(path.join(BACKEND, 'src/modules/intelligence/anomalyDetector.js')).href);

const MARK = 'ZZANOM';
const CID = Number(process.env.ANOM_COMPANY_ID || 1);

const cleanup = async () => {
  await pool.query(`DELETE FROM invoices WHERE invoice_number LIKE '${MARK}%'`).catch(() => {});
};

const result = { steps: [] };
try {
  await cleanup();

  // ── 1. Baseline ────────────────────────────────────────────────────────────
  const before = await detectAnomalies(CID);
  result.steps.push({ step: 'baseline', count: before.length });

  // ── 2. Insufficient data ───────────────────────────────────────────────────
  // The invoice detector needs >= 5 invoices in the 90-day window before it will
  // compute a standard deviation at all. This database holds 3, so the detector
  // is correctly inert — that is Phase 11's "insufficient data" case, and it is
  // asserted rather than assumed, because an inert detector and a broken one
  // both report zero.
  const windowSize = async () => (await pool.query(
    `SELECT COUNT(*)::int AS n FROM invoices
      WHERE invoice_date >= NOW() - INTERVAL '90 days' AND company_id = $1`, [CID])).rows[0].n;

  const startingWindow = await windowSize();
  result.steps.push({
    step: 'insufficient_data',
    invoices_in_90d: startingWindow,
    detector_minimum: 5,
    detector_inert: startingWindow < 5,
    count: before.length,
  });

  // ── 3. Enough ordinary data, still no anomaly ──────────────────────────────
  // Six invoices clustered tightly around one value: the detector now has a
  // population to work with and must still stay quiet. This separates "quiet
  // because it cannot run" from "quiet because nothing is unusual".
  const NORMAL = 100000;
  for (let i = 0; i < 6; i++) {
    await pool.query(
      `INSERT INTO invoices (invoice_number, total_amount, status, invoice_date, company_id)
       VALUES ($1, $2, 'Sent', CURRENT_DATE - 5, $3)`,
      [`${MARK}-NORMAL-${i}`, NORMAL + i * 500, CID]);
  }
  const populated = await detectAnomalies(CID);
  // Assert on the fixture's OWN rows, not the total count. Introducing a tight
  // cluster legitimately makes a pre-existing invoice stand out from it — that
  // is the detector working, not failing — so a total-count comparison would
  // report a correct detection as a regression.
  const flaggedNormals = populated.filter(
    (a) => /ZZANOM-NORMAL/.test(String(a.description || '')));
  result.steps.push({
    step: 'no_anomaly',
    invoices_in_90d: await windowSize(),
    count: populated.length,
    fixture_rows_flagged: flaggedNormals.length,
    quiet_about_fixture: flaggedNormals.length === 0,
  });

  // ── 4. Plant a known anomaly ───────────────────────────────────────────────
  // Two orders of magnitude above the cluster, so it clears 2.5 sigma by
  // construction rather than by luck of the current data.
  const outlier = NORMAL * 100;
  await pool.query(
    `INSERT INTO invoices (invoice_number, total_amount, status, invoice_date, company_id)
     VALUES ($1, $2, 'Sent', CURRENT_DATE - 1, $3)`,
    [`${MARK}-OUTLIER-1`, outlier, CID]);

  const during = await detectAnomalies(CID);
  const hit = during.find((a) => String(a.description || '').includes(`${MARK}-OUTLIER-1`));
  result.steps.push({
    step: 'known_anomaly',
    planted_amount: outlier,
    count: during.length,
    detected: Boolean(hit),
    detector: hit?.type ?? null,
    severity: hit?.severity ?? null,
    // Evidence the insight is traceable back to a record, not narrated text.
    has_affected_id: hit ? hit.affected_id != null : null,
    has_variance: hit ? hit.variance_amount != null : null,
    description: hit?.description ?? null,
  });

  // ── 5. Remove everything; the detector must go quiet again ────────────────
  await cleanup();
  const after = await detectAnomalies(CID);
  result.steps.push({ step: 'restored', count: after.length });

  result.pass = Boolean(hit)                       // the planted outlier is found
    && hit.affected_id != null                     // traceable to a record
    && hit.variance_amount != null                 // carries its magnitude
    && flaggedNormals.length === 0                 // ordinary rows stay unflagged
    && startingWindow < 5                          // the insufficient-data guard held
    && after.length === before.length;             // removing it restores the baseline
} finally {
  await cleanup();
}

console.log('---REPORT_BEGIN---');
console.log(JSON.stringify(result));
console.log('---REPORT_END---');
if (!process.argv.includes('--json')) {
  console.error('');
  for (const s of result.steps) console.error(JSON.stringify(s));
  console.error(`\nanomaly detector round-trip: ${result.pass ? 'PASS' : 'FAIL'}`);
}
await pool.end();
process.exit(result.pass ? 0 : 1);
