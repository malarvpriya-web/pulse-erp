/**
 * integration.tcoAward.test.js — the TCO decision record and the direct-PO
 * advisory, against the REAL database.
 *
 * NOT MOCKED, for the same reason as integration.crmCustomerIntegrity: what is
 * asserted here is a property of the schema and of a real multi-table read. A
 * mocked pool would pass while `procurement_award_decisions` was absent, and an
 * award audit trail that silently writes nothing is worse than none — it looks
 * like coverage.
 *
 * Self-cleaning in both directions: beforeAll sweeps ZZTCO_ debris an
 * interrupted run may have left, afterAll removes this run's rows. Debris here
 * is not harmless — an abandoned RFQ shows up in the buyer's live RFQ list.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Real DB credentials — same convention as integration.crmCustomerIntegrity.
// setup.js deliberately plants a dummy DB_PASSWORD so a unit test can never
// reach a real database by accident; a real-DB suite restores it, and must do
// so BEFORE importing config/db.js, which reads the password at module load.
if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error(
      'Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.'
    );
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool } = await import('../config/db.js');

const TAG = 'ZZTCO_';

const created = { rfqs: [], quotes: [], decisions: [] };

async function sweepDebris() {
  await pool.query(
    `DELETE FROM procurement_award_decisions
      WHERE rfq_id IN (SELECT id FROM rfqs WHERE item_description LIKE $1)`, [`${TAG}%`]
  );
  await pool.query(
    `DELETE FROM rfq_quotes WHERE rfq_id IN (SELECT id FROM rfqs WHERE item_description LIKE $1)`, [`${TAG}%`]
  );
  await pool.query(`DELETE FROM rfq_items WHERE rfq_id IN (SELECT id FROM rfqs WHERE item_description LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM rfqs WHERE item_description LIKE $1`, [`${TAG}%`]);
}

let vendorA, vendorB, itemId;

beforeAll(async () => {
  await sweepDebris();
  const { rows: vs } = await pool.query(
    `SELECT id FROM vendors WHERE deleted_at IS NULL ORDER BY id LIMIT 2`
  );
  vendorA = vs[0]?.id; vendorB = vs[1]?.id;
  const { rows: its } = await pool.query(
    `SELECT id FROM inventory_items WHERE deleted_at IS NULL ORDER BY id LIMIT 1`
  );
  itemId = its[0]?.id;
});

afterAll(async () => {
  await sweepDebris();
});

describe('procurement_award_decisions — the schema an award audit needs', () => {
  it('exists with the columns that make a past award re-justifiable', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'procurement_award_decisions'`
    );
    const cols = new Set(rows.map(r => r.column_name));
    for (const required of [
      'rfq_id', 'awarded_vendor_id', 'awarded_tco_total', 'lowest_tco_vendor_id',
      'tco_saving_forgone', 'followed_recommendation', 'tco_breakdown', 'tco_basis',
      'decided_by_user_id',
    ]) {
      expect(cols, `missing column ${required}`).toContain(required);
    }
  });

  it('is NOT unique on rfq_id — a re-award is history, not a conflict', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'procurement_award_decisions'`
    );
    const uniqueOnRfq = rows.some(r =>
      /UNIQUE/i.test(r.indexdef) && /\(rfq_id\)/.test(r.indexdef));
    expect(uniqueOnRfq).toBe(false);
  });

  it('stores the breakdown as jsonb so it survives a later rate change', async () => {
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name='procurement_award_decisions' AND column_name IN ('tco_breakdown','tco_basis')`
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.data_type).toBe('jsonb');
  });

  it('accepts a full decision row and reads it back intact', async () => {
    if (!vendorA) return;   // no vendors seeded on this database
    const { rows: r } = await pool.query(
      `INSERT INTO rfqs (rfq_number, item_description, quantity, status, company_id)
       VALUES ($1,$2,10,'closed',1) RETURNING id`,
      [`${TAG}RFQ1`, `${TAG}Widget`]
    );
    const rfqId = r[0].id;
    created.rfqs.push(rfqId);

    const breakdown = { tco_total: 1234.56, lines: [{ label: 'Purchase price', amount: 1000, basis: 'quoted' }] };
    const basis = { horizon_months: 12, cost_of_capital_pct: 12 };

    const { rows: d } = await pool.query(
      `INSERT INTO procurement_award_decisions
         (rfq_id, awarded_vendor_id, quantity, awarded_tco_total, lowest_tco_vendor_id,
          lowest_tco_total, tco_saving_forgone, followed_recommendation,
          tco_breakdown, tco_basis, company_id)
       VALUES ($1,$2,10,1234.56,$3,1000.00,234.56,false,$4,$5,1)
       RETURNING id, tco_breakdown, tco_basis, followed_recommendation, tco_saving_forgone`,
      [rfqId, vendorA, vendorB ?? vendorA, JSON.stringify(breakdown), JSON.stringify(basis)]
    );

    expect(d[0].tco_breakdown.tco_total).toBe(1234.56);
    expect(d[0].tco_breakdown.lines[0].basis).toBe('quoted');
    expect(d[0].tco_basis.horizon_months).toBe(12);
    expect(d[0].followed_recommendation).toBe(false);
    // NUMERIC comes back as a string — the figure an auditor reads.
    expect(parseFloat(d[0].tco_saving_forgone)).toBeCloseTo(234.56, 2);
  });

  it('cascades away with its RFQ rather than orphaning the audit row', async () => {
    if (!vendorA) return;
    const { rows: r } = await pool.query(
      `INSERT INTO rfqs (rfq_number, item_description, quantity, status, company_id)
       VALUES ($1,$2,5,'closed',1) RETURNING id`,
      [`${TAG}RFQ2`, `${TAG}Cascade`]
    );
    const rfqId = r[0].id;
    await pool.query(
      `INSERT INTO procurement_award_decisions (rfq_id, awarded_vendor_id, company_id)
       VALUES ($1,$2,1)`, [rfqId, vendorA]
    );
    await pool.query(`DELETE FROM rfqs WHERE id = $1`, [rfqId]);
    const { rows: left } = await pool.query(
      `SELECT 1 FROM procurement_award_decisions WHERE rfq_id = $1`, [rfqId]
    );
    expect(left).toHaveLength(0);
  });

  it('has the partial index the "awards that went against TCO" review reads', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename='procurement_award_decisions'`
    );
    expect(rows.some(r => /followed_recommendation = false/.test(r.indexdef))).toBe(true);
  });
});
