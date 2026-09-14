/**
 * procurement_award_decisions — what an RFQ award was actually decided on.
 *
 * §128 gave buyers a total cost of ownership to award against. It did not
 * record the answer, and a TCO is only reproducible while the rates behind it
 * stay put. `procurement_settings.cost_of_capital_pct` is one input away from
 * changing at any time, and the moment it does, every past award becomes
 * un-re-justifiable: nobody can show what the comparison said on the day.
 *
 * One row per award, capturing three things a later reader needs:
 *
 *   1. WHAT WON — the awarded vendor's TCO, and its full line breakdown frozen
 *      as jsonb. Frozen, not recomputed: recomputing under today's rates
 *      answers a different question than the one the buyer answered.
 *   2. WHAT ELSE WAS ON THE TABLE — the lowest-TCO vendor and the lowest-price
 *      vendor. When the award went to neither, `tco_saving_forgone` is the
 *      money the decision cost, which is the number an auditor asks for.
 *   3. THE BASIS — every rate in force at that moment, also frozen.
 *
 * `followed_recommendation = false` is NOT an error flag. Awarding against the
 * lowest TCO is often right: a strategic second source, a qualification
 * constraint, a customer-mandated vendor. The point is that it becomes a
 * recorded, explainable decision instead of an invisible one.
 *
 * ⚠ `decided_by_user_id` is named for its id space on purpose. `purchase_orders
 * .created_by` and `purchase_requests.approved_by` both FK **employees(id)**
 * while the JWT carries a **users.id**, and mixing the two is the single most
 * repeated defect in this codebase (four recorded instances). A column whose
 * name states which id it holds cannot be got wrong by the next writer.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS procurement_award_decisions (
      id                     SERIAL PRIMARY KEY,
      rfq_id                 INTEGER     NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      quote_id               INTEGER     REFERENCES rfq_quotes(id) ON DELETE SET NULL,
      awarded_vendor_id      INTEGER     NOT NULL REFERENCES vendors(id),
      po_id                  INTEGER     REFERENCES purchase_orders(id) ON DELETE SET NULL,

      -- The compared quantity every figure below is denominated in. Without it
      -- a total is meaningless, because per-order costs do not scale linearly.
      quantity               NUMERIC(16,3),

      -- What won.
      awarded_unit_price     NUMERIC(16,4),
      awarded_tco_total      NUMERIC(18,2),
      awarded_tco_per_unit   NUMERIC(16,4),
      awarded_confidence     INTEGER,

      -- What else was on the table.
      lowest_tco_vendor_id   INTEGER     REFERENCES vendors(id),
      lowest_tco_total       NUMERIC(18,2),
      lowest_price_vendor_id INTEGER     REFERENCES vendors(id),
      lowest_price_total     NUMERIC(18,2),

      -- Positive when the award did not go to the lowest-TCO vendor: the money
      -- the decision cost, at the rates in force on the day.
      tco_saving_forgone     NUMERIC(18,2),
      followed_recommendation BOOLEAN,

      -- Frozen, not recomputed. Recomputing under today's rates answers a
      -- different question than the one the buyer answered.
      tco_breakdown          JSONB,
      tco_basis              JSONB,

      -- Set when TCO was switched off for the company at award time, so a row
      -- with null figures is distinguishable from one that failed to compute.
      tco_enabled            BOOLEAN     NOT NULL DEFAULT TRUE,

      decided_by_user_id     INTEGER     REFERENCES users(id),
      company_id             INTEGER,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // An RFQ can legitimately be re-awarded (the winner withdraws, a quote is
  // revised), and the history of that is exactly what this table is for — so
  // this is NOT unique on rfq_id. Reads take the latest row per RFQ.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_award_decisions_rfq
      ON procurement_award_decisions (rfq_id, created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_award_decisions_vendor
      ON procurement_award_decisions (awarded_vendor_id)
  `);
  // "Show me every award that went against the TCO recommendation" — the
  // review query this table exists to answer. Partial, because the rows that
  // followed the recommendation are the uninteresting majority.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_award_decisions_overridden
      ON procurement_award_decisions (company_id, created_at DESC)
      WHERE followed_recommendation = false
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS procurement_award_decisions');
}
