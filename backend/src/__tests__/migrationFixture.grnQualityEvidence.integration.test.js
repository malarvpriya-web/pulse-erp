/**
 * Migration fixture: 20260916000003_quality_and_dispatch_evidence →
 * 20260916000004_iqc_exemption_override (§226).
 *
 * Replaces "preserved the original value of every record it corrected" in
 * traceabilityClosure, which counted the developer database's own corrected
 * GRNs. What the pair promises, read off their SQL:
 *   003  DERIVE a GRN's status from its inspections (any fail → failed, any
 *        conditional → conditional, all pass → passed); WITHDRAW a 'passed' that
 *        has no inspection back to 'pending' (source 'unverified'); return a
 *        serial flagged shipped with no package evidence to 'active'. Every
 *        changed row keeps its prior value AND a note saying why. Then triggers
 *        make both claims impossible to repeat without evidence.
 *   004  a 'not_required' exemption that 003 overrode stays overridden only
 *        when a FAILING inspection justified it (with a note saying so);
 *        otherwise the exemption is restored.
 *
 * Before-state: baseline.sql (2026-09-10, before both) plus the columns the
 * intervening migrations added — 20260915000018 (quality_status_source/_at and
 * grn_quality_status_source_chk), 20260911000013 (packages / package_lines),
 * 20260915000019 (serial_numbers.package_id).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
const { withFixtureDb, captureConsole } = await import('./helpers/migrationFixtureDb.js');
const m003 = await import('../database/migrations/20260916000003_quality_and_dispatch_evidence.js');
const m004 = await import('../database/migrations/20260916000004_iqc_exemption_override.js');

async function beforeState(c) {
  await c.query(`
    CREATE TABLE goods_receipt_notes (
      id SERIAL PRIMARY KEY, grn_number VARCHAR(50), company_id INTEGER,
      received_date DATE DEFAULT CURRENT_DATE,
      deleted_at TIMESTAMP, updated_at TIMESTAMPTZ DEFAULT NOW(),
      quality_status VARCHAR(20) DEFAULT 'not_required',
      CONSTRAINT goods_receipt_notes_quality_status_check CHECK (quality_status IS NULL OR quality_status::text = ANY (ARRAY['not_required','pending','in_progress','passed','failed'])),
      quality_status_source TEXT, quality_status_at TIMESTAMPTZ, quality_status_by INTEGER,
      CONSTRAINT grn_quality_status_source_chk CHECK (quality_status_source IS NULL
               OR quality_status_source = ANY (ARRAY['derived','manual','unverified','not_required'])));
    CREATE TABLE quality_inspections (
      id SERIAL PRIMARY KEY, grn_id INTEGER,
      overall_result VARCHAR(20) DEFAULT 'pass', status VARCHAR(20) DEFAULT 'completed');
    CREATE TABLE serial_numbers (
      id SERIAL PRIMARY KEY, serial_number VARCHAR(100) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'in_stock',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, package_id INTEGER);
    CREATE TABLE packages (id SERIAL PRIMARY KEY);
    CREATE TABLE package_lines (
      id SERIAL PRIMARY KEY, package_id INTEGER REFERENCES packages(id) ON DELETE CASCADE,
      serial_id INTEGER REFERENCES serial_numbers(id) ON DELETE SET NULL, quantity NUMERIC(15,3) NOT NULL);`);
  await c.query(`
    INSERT INTO goods_receipt_notes (id, grn_number, company_id, quality_status, quality_status_source, deleted_at) VALUES
      (1, 'GRN-PASS',      1, 'pending',      NULL,           NULL),   -- one passing inspection
      (2, 'GRN-FAIL',      1, 'passed',       'manual',       NULL),   -- stamped passed; inspection failed
      (3, 'GRN-COND',      1, 'pending',      NULL,           NULL),   -- a conditional verdict
      (4, 'GRN-NOINSP',    1, 'passed',       'manual',       NULL),   -- released with no inspection at all
      (5, 'GRN-PENDING',   1, 'pending',      NULL,           NULL),   -- nothing to say: untouched
      (6, 'GRN-EXEMPTFAIL',1, 'not_required', 'not_required', NULL),   -- exempt, but an inspection failed
      (7, 'GRN-EXEMPTPASS',1, 'not_required', 'not_required', NULL),   -- exempt, inspected, passed
      (8, 'GRN-DELETED',   1, 'passed',       'manual',       '2026-09-01');  -- deleted: out of scope
    INSERT INTO quality_inspections (grn_id, overall_result) VALUES
      (1, 'pass'), (2, 'fail'), (3, 'conditional'), (6, 'pass'), (6, 'fail'), (7, 'pass');
    INSERT INTO packages (id) VALUES (1);
    INSERT INTO serial_numbers (id, serial_number, status) VALUES
      (1, 'SN-NOPKG', 'shipped'), (2, 'SN-PACKED', 'shipped'), (3, 'SN-STOCK', 'in_stock');
    INSERT INTO package_lines (package_id, serial_id, quantity) VALUES (1, 2, 1);
    SELECT setval('goods_receipt_notes_id_seq', 8), setval('serial_numbers_id_seq', 3), setval('packages_id_seq', 1);`);
}
const grns = async (c) => (await c.query(
  `SELECT id, quality_status AS status, quality_status_source AS source,
          quality_status_prior AS prior, quality_status_prior_note AS note
     FROM goods_receipt_notes ORDER BY id`)).rows;
const serials = async (c) => (await c.query(
  `SELECT id, status, status_prior AS prior, status_prior_note AS note FROM serial_numbers ORDER BY id`)).rows;

const WITHDRAWN = 'returned to pending on 2026-09-16: stamped passed with zero inspection records, so the release could not be evidenced';
const OVERRIDDEN = 'exemption overridden on 2026-09-16: marked not_required, but an incoming inspection recorded a FAIL. '
  + 'A failure outranks an exemption — material that failed inspection must not read as releasable because inspecting it was optional.';
const RESTORED = 'exemption restored on 2026-09-16: no failing inspection justified overriding it';

describe('20260916000003 → 000004 — corrections keep the original value and say why', () => {
  it('derives, withdraws and restores exactly as written, and records every prior value', async () => {
    await withFixtureDb('grnqual', async ({ client: c, apply }) => {
      await beforeState(c);
      await captureConsole(async () => { await apply(m003); await apply(m004); });

      expect(await grns(c)).toEqual([
        { id: 1, status: 'passed',       source: 'derived',      prior: 'pending',      note: 'derived from 1 inspection(s) on 2026-09-16' },
        { id: 2, status: 'failed',       source: 'derived',      prior: 'passed',       note: 'derived from 1 inspection(s) on 2026-09-16' },
        { id: 3, status: 'conditional',  source: 'derived',      prior: 'pending',      note: 'derived from 1 inspection(s) on 2026-09-16' },
        { id: 4, status: 'pending',      source: 'unverified',   prior: 'passed',       note: WITHDRAWN },
        { id: 5, status: 'pending',      source: null,           prior: null,           note: null },
        { id: 6, status: 'failed',       source: 'derived',      prior: 'not_required', note: OVERRIDDEN },
        { id: 7, status: 'not_required', source: 'not_required', prior: 'not_required', note: RESTORED },
        { id: 8, status: 'passed',       source: 'manual',       prior: null,           note: null },
      ]);
      // The invariant the live suite keeps: no prior value without its reason.
      expect((await c.query(`SELECT COUNT(*)::int n FROM goods_receipt_notes
                              WHERE quality_status_prior IS NOT NULL AND quality_status_prior_note IS NULL`)).rows[0].n).toBe(0);

      expect(await serials(c)).toEqual([
        { id: 1, status: 'active',   prior: 'shipped', note: 'returned to active on 2026-09-16: flagged shipped with no package line, package or sales order accounting for it' },
        { id: 2, status: 'shipped',  prior: null,      note: null },
        { id: 3, status: 'in_stock', prior: null,      note: null },
      ]);
      expect((await c.query(`SELECT grn_id, conflict FROM v_iqc_status_conflicts ORDER BY grn_id`)).rows)
        .toEqual([{ grn_id: 7, conflict: 'exempt_but_inspected' }]);
    });
  }, 60000);

  it('makes the unsupported claims impossible to repeat, and allows the supported ones', async () => {
    await withFixtureDb('grnqual', async ({ client: c, apply }) => {
      await beforeState(c);
      await captureConsole(async () => { await apply(m003); await apply(m004); });
      const refused = await c.query(`UPDATE goods_receipt_notes SET quality_status = 'passed' WHERE id = 5`).catch((e) => e);
      expect([refused.code, refused.message]).toEqual(['23514', 'GRN GRN-PENDING cannot be released as passed: no incoming inspection has been recorded against it']);
      const failedOnly = await c.query(`UPDATE goods_receipt_notes SET quality_status = 'passed' WHERE id = 2`).catch((e) => e);
      expect(failedOnly.message).toBe('GRN GRN-FAIL cannot be released as passed: none of its 1 inspection(s) recorded a pass');
      await c.query(`INSERT INTO quality_inspections (grn_id, overall_result) VALUES (5, 'pass')`);
      await c.query(`UPDATE goods_receipt_notes SET quality_status = 'passed' WHERE id = 5`);         // now evidenced
      const ship = await c.query(`UPDATE serial_numbers SET status = 'shipped' WHERE id = 3`).catch((e) => e);
      expect(ship.code).toBe('23514');
      await c.query(`INSERT INTO package_lines (package_id, serial_id, quantity) VALUES (1, 3, 1)`);
      await c.query(`UPDATE serial_numbers SET status = 'shipped' WHERE id = 3`);                     // now evidenced
      expect((await c.query(`INSERT INTO goods_receipt_notes (grn_number, quality_status) VALUES ('X', 'conditional') RETURNING quality_status`)).rows[0].quality_status).toBe('conditional');
    });
  }, 60000);

  it('is idempotent as a pair: a re-run changes no status, prior value or note', async () => {
    await withFixtureDb('grnqual', async ({ client: c, apply }) => {
      await beforeState(c);
      await captureConsole(async () => { await apply(m003); await apply(m004); });
      const once = { g: await grns(c), s: await serials(c) };
      await captureConsole(async () => { await apply(m003); await apply(m004); });
      expect({ g: await grns(c), s: await serials(c) }).toEqual(once);
    });
  }, 60000);
});
