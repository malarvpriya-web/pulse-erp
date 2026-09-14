/**
 * integration.tcoPortfolio.test.js — the savings board, against the REAL database.
 *
 * WHY THIS EXISTS
 * ---------------
 * `loadTcoPortfolio()` executes cleanly against the current database and returns
 * ZERO for every figure — because there are no closed RFQs, no award decisions,
 * and the one open event's cheapest quote is also its cheapest option. That is
 * the correct answer, and it proves nothing at all: a board that is broken and a
 * board with nothing to show are indistinguishable from the outside.
 *
 * So this suite plants decisions with known arithmetic and asserts the board
 * MOVES to the right numbers. Every defect below was found by writing it:
 *
 *   1. FAN-OUT. `procurement_award_decisions` is joined to nothing, but the
 *      open-opportunity query joined `rfq_items` AND `rfq_quotes` to the same
 *      RFQ. On a one-line, two-quote event `SUM(ri.quantity)` returned 10 for a
 *      5-unit line — every such event priced at double the quantity being
 *      bought. `COUNT(DISTINCT …)` beside it stayed correct, which is exactly
 *      what makes this class of bug survive review.
 *
 *   2. DOUBLE COUNTING. The table is deliberately NOT unique on `rfq_id` — a
 *      re-award is history, not a conflict (integration.tcoAward.test.js asserts
 *      this). Summing the raw table therefore counts a reopened-and-re-awarded
 *      event twice, silently inflating the savings headline.
 *
 * Self-cleaning in both directions, on the same `ZZTCOP_` convention as
 * integration.tcoAward: beforeAll sweeps debris an interrupted run may have
 * left, afterAll removes this run's rows. Debris is not harmless here — a
 * stray RFQ appears in the buyer's live event list.
 *
 * Runner: Vitest | npx vitest run src/__tests__/integration.tcoPortfolio.test.js
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Real DB credentials — setup.js plants a dummy DB_PASSWORD so a unit test can
// never reach a real database by accident; a real-DB suite restores it, and must
// do so BEFORE importing config/db.js, which reads the password at module load.
if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool } = await import('../config/db.js');
const { loadTcoPortfolio } = await import('../modules/procurement/services/tcoPortfolio.service.js');

const TAG = 'ZZTCOP_';
const CO = 1;

async function sweepDebris() {
  await pool.query(
    `DELETE FROM procurement_award_decisions
      WHERE rfq_id IN (SELECT id FROM rfqs WHERE item_description LIKE $1)`, [`${TAG}%`]);
  await pool.query(
    `DELETE FROM rfq_quotes WHERE rfq_id IN (SELECT id FROM rfqs WHERE item_description LIKE $1)`, [`${TAG}%`]);
  await pool.query(
    `DELETE FROM rfq_items WHERE rfq_id IN (SELECT id FROM rfqs WHERE item_description LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM rfqs WHERE item_description LIKE $1`, [`${TAG}%`]);
}

let vendorA, vendorB;

/** An RFQ carrying the tag, so the sweep can always find it. */
async function makeRfq(name, { status = 'closed', quantity = 10 } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO rfqs (rfq_number, item_description, quantity, status, company_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [`${TAG}${name}-${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
     `${TAG}${name}`, quantity, status, CO]);
  return rows[0].id;
}

/**
 * A decision with the three totals the board derives everything from.
 *   available = lowest_price_total − lowest_tco_total
 *   captured  = lowest_price_total − awarded_tco_total
 *   forgone   = awarded_tco_total  − lowest_tco_total  (stored)
 */
async function makeDecision(rfqId, { awarded, lowestTco, lowestPrice, followed, enabled = true, confidence = 80 }) {
  const { rows } = await pool.query(
    `INSERT INTO procurement_award_decisions
       (rfq_id, awarded_vendor_id, quantity, awarded_tco_total,
        lowest_tco_vendor_id, lowest_tco_total, lowest_price_vendor_id, lowest_price_total,
        tco_saving_forgone, followed_recommendation, awarded_confidence, tco_enabled, company_id)
     VALUES ($1,$2,10,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [rfqId, followed ? vendorB : vendorA, awarded,
     vendorB, lowestTco, vendorA, lowestPrice,
     Math.max(0, +(awarded - lowestTco).toFixed(2)), followed, confidence, enabled, CO]);
  return rows[0].id;
}

beforeAll(async () => {
  await sweepDebris();
  const { rows: vs } = await pool.query(
    `SELECT id FROM vendors WHERE deleted_at IS NULL ORDER BY id LIMIT 2`);
  vendorA = vs[0]?.id; vendorB = vs[1]?.id;
});

afterAll(async () => {
  await sweepDebris();
  await pool.end().catch(() => {});
});

describe('an empty board reports absence, not success', () => {
  it('capture_rate_pct is null rather than 100 when nothing was measurable', async () => {
    // The denominator is empty. A rate of 100% here would read as "we captured
    // every available saving" when the truth is "we measured nothing".
    const r = await loadTcoPortfolio({ companyId: CO, from: '1990-01-01', to: '1990-12-31' });
    expect(r.realised.decisions).toBe(0);
    expect(r.realised.capture_rate_pct).toBeNull();
    expect(r.realised.follow_rate_pct).toBeNull();
  });

  it('always ships coverage, so a rate can never be read without its denominator', async () => {
    const r = await loadTcoPortfolio({ companyId: CO });
    expect(r.coverage).toMatchObject({
      closed_events: expect.any(Number),
      measured_events: expect.any(Number),
      measured_pct: expect.any(Number),
    });
    expect(r.coverage.note).toMatch(/unmeasured/i);
  });
});

describe('the board moves to the right numbers', () => {
  it('derives available, captured and forgone from the frozen totals', async () => {
    if (!vendorA || !vendorB) return; // no vendors seeded on this database

    // Awarded the TCO winner: price winner cost 1000, TCO winner cost 850.
    //   available = 1000 − 850 = 150
    //   captured  = 1000 − 850 = 150   (the award IS the TCO winner)
    //   forgone   =  850 − 850 = 0
    const good = await makeRfq('FOLLOWED');
    await makeDecision(good, { awarded: 850, lowestTco: 850, lowestPrice: 1000, followed: true });

    // Awarded the PRICE winner over a better option:
    //   available = 1000 − 850 = 150
    //   captured  = 1000 − 1000 = 0
    //   forgone   = 1000 −  850 = 150
    const miss = await makeRfq('OVERRIDDEN');
    await makeDecision(miss, { awarded: 1000, lowestTco: 850, lowestPrice: 1000, followed: false });

    const r = await loadTcoPortfolio({ companyId: CO });

    expect(r.realised.decisions).toBe(2);
    expect(r.realised.followed).toBe(1);
    expect(r.realised.saving_available).toBeCloseTo(300, 2);
    expect(r.realised.saving_captured).toBeCloseTo(150, 2);
    expect(r.realised.saving_forgone).toBeCloseTo(150, 2);
    expect(r.realised.capture_rate_pct).toBeCloseTo(50, 1);
    expect(r.realised.follow_rate_pct).toBeCloseTo(50, 1);

    // The overridden award is the one a review has to explain.
    const missRow = r.biggest_misses.find((m) => m.rfq_id === miss);
    expect(missRow, 'the overridden award should appear in biggest_misses').toBeTruthy();
    expect(missRow.forgone).toBeCloseTo(150, 2);

    // …and the followed one must NOT, because it left nothing on the table.
    expect(r.biggest_misses.find((m) => m.rfq_id === good)).toBeUndefined();
  });

  it('does not floor a negative capture — awarding worse than the cheapest quote is a real outcome', async () => {
    if (!vendorA || !vendorB) return;

    // Awarded a vendor worse on total cost than BOTH the price and TCO winners.
    //   captured = 1000 − 1200 = −200
    // Flooring this at zero would hide the worst decision on the board inside a
    // column of successes.
    const bad = await makeRfq('WORSE_THAN_PRICE');
    await makeDecision(bad, { awarded: 1200, lowestTco: 850, lowestPrice: 1000, followed: false });

    const r = await loadTcoPortfolio({ companyId: CO });
    const row = r.by_vendor.find((v) => v.captured < 0);
    expect(row, 'a negative capture must survive into the vendor facet').toBeTruthy();
  });

  it('counts a re-awarded event ONCE, taking the latest decision', async () => {
    if (!vendorA || !vendorB) return;

    const rfq = await makeRfq('REAWARDED');

    // First award: took the recommendation.
    await makeDecision(rfq, { awarded: 850, lowestTco: 850, lowestPrice: 1000, followed: true });

    const afterFirst = await loadTcoPortfolio({ companyId: CO });
    const decisionsAfterFirst = afterFirst.realised.decisions;

    // Reopened and re-awarded to the price winner. The table keeps BOTH rows on
    // purpose — but the board must still see one event, with the latest outcome.
    await new Promise((r) => setTimeout(r, 10)); // distinct created_at
    await makeDecision(rfq, { awarded: 1000, lowestTco: 850, lowestPrice: 1000, followed: false });

    const { rows: raw } = await pool.query(
      `SELECT COUNT(*)::INT AS n FROM procurement_award_decisions WHERE rfq_id = $1`, [rfq]);
    expect(raw[0].n, 'the audit trail must keep both decisions').toBe(2);

    const afterSecond = await loadTcoPortfolio({ companyId: CO });

    // The decision COUNT must not move: it is still one event.
    expect(afterSecond.realised.decisions).toBe(decisionsAfterFirst);

    // And the latest decision is the one that counts — the re-award took the
    // price winner, so this event now contributes 150 forgone, not 0.
    const missRow = afterSecond.biggest_misses.find((m) => m.rfq_id === rfq);
    expect(missRow, 'the re-award should now read as a miss').toBeTruthy();
    expect(missRow.forgone).toBeCloseTo(150, 2);
  });

  it('excludes decisions taken with TCO switched off — unmeasured is not zero-saving', async () => {
    if (!vendorA || !vendorB) return;

    const before = await loadTcoPortfolio({ companyId: CO });

    const off = await makeRfq('TCO_OFF');
    await makeDecision(off, { awarded: 900, lowestTco: 900, lowestPrice: 900, followed: true, enabled: false });

    const after = await loadTcoPortfolio({ companyId: CO });

    // The award modal fell back to price; there was no comparison to report.
    // Counting it as a followed recommendation would pad the follow rate.
    expect(after.realised.decisions).toBe(before.realised.decisions);
  });
});

describe('the open-opportunity panel', () => {
  it('does not multiply quantity when an event has several lines AND several quotes', async () => {
    if (!vendorA || !vendorB) return;

    // Two lines of 5 = 10 units, quoted by two vendors. Joining both children
    // to the RFQ yields 4 rows, so a naive SUM(quantity) returns 20.
    //
    // The cheap quote carries freight that makes it the DEARER option on total
    // cost — without that the panel legitimately returns no row (cheapest quote
    // is also cheapest option) and a broken quantity would go unnoticed.
    const rfq = await makeRfq('FANOUT', { status: 'sent', quantity: 10 });
    await pool.query(
      `INSERT INTO rfq_items (rfq_id, item_name, quantity) VALUES ($1,$2,5), ($1,$3,5)`,
      [rfq, `${TAG}LineA`, `${TAG}LineB`]);
    await pool.query(
      `INSERT INTO rfq_quotes (rfq_id, vendor_id, unit_price, total_amount, delivery_days, freight_amount)
       VALUES ($1,$2,90,900,7,400), ($1,$3,100,1000,7,0)`,
      [rfq, vendorA, vendorB]);

    // ── the real assertion: what the SERVICE reports ────────────────────────
    const r = await loadTcoPortfolio({ companyId: CO });
    const row = r.open_opportunity.rows.find((x) => x.rfq_id === rfq);
    expect(row, 'the event should surface as an opportunity').toBeTruthy();

    // 10 units, not 20. This is the fan-out: if the quantity doubles, every
    // cost the engine scales by quantity doubles with it and the saving is
    // reported at twice its true value.
    expect(Number(row.quantity)).toBeCloseTo(10, 2);
    expect(row.quote_count).toBe(2);

    // And the hazard is genuinely present in the data — if the joined form ever
    // stops doubling, this fixture has stopped exercising what it guards.
    const { rows: shapes } = await pool.query(`
      SELECT COALESCE((SELECT SUM(ri.quantity) FROM rfq_items ri
                        WHERE ri.rfq_id = r.id), 0) AS scalar_qty,
             COALESCE(SUM(ri2.quantity), 0)         AS joined_qty
        FROM rfqs r
        LEFT JOIN rfq_items  ri2 ON ri2.rfq_id = r.id
        LEFT JOIN rfq_quotes q   ON q.rfq_id   = r.id
       WHERE r.id = $1
       GROUP BY r.id`, [rfq]);
    expect(Number(shapes[0].scalar_qty)).toBeCloseTo(10, 2);
    expect(Number(shapes[0].joined_qty)).toBeCloseTo(20, 2);
  });

  it('never re-scores an awarded event, and says so', async () => {
    const r = await loadTcoPortfolio({ companyId: CO });
    expect(r.open_opportunity.note).toMatch(/never re-scored/i);
    // Every row in the panel must be an OPEN event.
    for (const row of r.open_opportunity.rows) {
      const { rows } = await pool.query(`SELECT status FROM rfqs WHERE id = $1`, [row.rfq_id]);
      expect(rows[0].status).not.toBe('closed');
    }
  });

  it('reports realised and open separately — they are never summed', async () => {
    const r = await loadTcoPortfolio({ companyId: CO });
    expect(r.realised).toHaveProperty('saving_available');
    expect(r.open_opportunity).toHaveProperty('saving_available');
    // Two distinct readings of two distinct things. A single headline combining
    // a frozen result with a live estimate would be neither.
    expect(r.realised.saving_available).not.toBe(undefined);
    expect(r.open_opportunity.saving_available).not.toBe(undefined);
  });
});
