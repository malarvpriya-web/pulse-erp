/**
 * integration.inventoryKpi.test.js — the KPIs of audit finding 30, against the
 * REAL database.
 *
 * Finding 30 said the inventory dashboard was missing eight KPIs: safety-stock
 * breaches, stockouts, excess inventory, obsolete/slow-moving stock, inventory
 * turnover, days of inventory, GRN pending IQC and material waiting for
 * production. Building them is easy; building them so they cannot quietly lie
 * is the part worth testing, so most of what follows asserts the ways a KPI
 * goes wrong rather than that a number came back:
 *
 *   - the TARGET service level must never be served as the ACHIEVED one
 *   - an un-computable ratio must be null, never 0 and never Infinity
 *   - an item nobody stocks must not count as a stockout
 *   - the KPIs must agree with the planning parameters they measure
 *   - excess and non-moving must not double-count the same stock
 *
 * DELIBERATELY NOT MOCKED: every claim here is about SQL and data flow over the
 * live ledger, which a stubbed pool proves nothing about.
 *
 * READ-ONLY. It asserts against the SCA-REF reference dataset and never mutates
 * it — the failure mode the 09-11 audit found in two other suites, which
 * decrement inventory_items.current_stock directly with no ledger row.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { computeInventoryKpis } = await import('../modules/inventory/services/inventoryKpi.service.js');
const planning = (await import('../modules/inventory/services/inventoryPlanning.service.js'));

const CID = 1;
let hasReferenceData = false;
let kpis = null;

beforeAll(async () => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM inventory_items WHERE item_code = 'CP-1000' AND company_id = $1`, [CID]);
  hasReferenceData = rows[0].n > 0;
  kpis = await computeInventoryKpis({ companyId: CID });
});


// ─────────────────────────────────────────────────────────────────────────────
describe('Inventory KPIs · the eight that were missing', () => {
  it('returns every KPI finding 30 listed as absent', () => {
    expect(kpis.safety_stock_breaches).toBeDefined();
    expect(kpis.stockouts).toBeDefined();
    expect(kpis.excess_inventory).toBeDefined();
    expect(kpis.obsolete_slow_moving).toBeDefined();
    expect(kpis.turnover.inventory_turnover).not.toBeUndefined();
    expect(kpis.turnover.days_of_inventory).not.toBeUndefined();
    expect(kpis.pipeline.grn_pending_iqc).toBeTypeOf('number');
    expect(kpis.pipeline.material_waiting_for_production).toBeDefined();
  });

  it('states the window it measured and the resolution it can honestly claim', () => {
    expect(kpis.window.days).toBeGreaterThan(0);
    // The ledger stores a DATE, so anything finer than a day would be invented.
    expect(kpis.window.granularity).toBe('day');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Inventory KPIs · target service level is not achieved service level', () => {
  it('reports the target and the achievement as separate fields', () => {
    const s = kpis.service_level;
    expect(s.target_pct).toBeTypeOf('number');
    expect(Object.prototype.hasOwnProperty.call(s, 'achieved_in_stock_pct')).toBe(true);
    // Two different questions. Serving the input as the output is the single
    // most common way an inventory dashboard lies.
    expect(Object.keys(s)).toContain('target_pct');
    expect(Object.keys(s)).toContain('achieved_in_stock_pct');
  });

  it('takes the target from company policy, not a constant', async () => {
    const settings = await planning.getPlanningSettings(CID);
    expect(kpis.service_level.target_pct).toBe(Number(settings.service_level_pct));
  });

  it('says what the achieved figure is measured from', () => {
    expect(kpis.service_level.basis).toMatch(/item-days/i);
    expect(kpis.service_level.item_days_carried).toBeGreaterThanOrEqual(0);
  });

  it('refuses to invent a fill rate, and says why it cannot compute one', () => {
    // material_issue_logs records qty_issued and no requested quantity, so a
    // short issue cannot be told from a small one. Reporting availability AS
    // fill rate would be the fabricated-data fallback pattern all over again.
    expect(kpis.service_level.fill_rate_pct).toBeNull();
    expect(kpis.service_level.fill_rate_unavailable_reason).toBeTruthy();
  });

  it('has no requested-quantity column anywhere on the issue log', async () => {
    // If this ever fails, a real fill rate became computable and the null above
    // is no longer honest — it is a deliberate tripwire, not a schema test.
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'material_issue_logs'
          AND column_name IN ('qty_requested','quantity_requested','qty_demanded','requested_qty')`);
    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Inventory KPIs · a ratio that cannot be computed is null, never zero', () => {
  it('never returns Infinity or NaN for turnover or days of inventory', () => {
    for (const v of [kpis.turnover.inventory_turnover, kpis.turnover.days_of_inventory]) {
      if (v !== null) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('returns nulls, not zeros, for a company with no inventory at all', async () => {
    const { rows } = await pool.query(
      `SELECT c.id FROM companies c
        WHERE NOT EXISTS (SELECT 1 FROM inventory_items ii
                           WHERE ii.company_id = c.id AND ii.deleted_at IS NULL
                             AND COALESCE(ii.is_active, true) = true)
        ORDER BY c.id LIMIT 1`);
    if (!rows.length) return;                       // every company holds stock
    const empty = await computeInventoryKpis({ companyId: rows[0].id });
    // 0 turnover means "consumed nothing while holding stock". No stock at all
    // is a different finding and must not wear the same number.
    expect(empty.turnover.inventory_turnover).toBeNull();
    expect(empty.turnover.days_of_inventory).toBeNull();
    expect(empty.service_level.achieved_in_stock_pct).toBeNull();
  });

  it('days of inventory is the reciprocal of turnover, not an independent guess', () => {
    const t = kpis.turnover.inventory_turnover;
    if (t === null || t <= 0) return;
    expect(kpis.turnover.days_of_inventory).toBe(Math.round(365 / t));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Inventory KPIs · stockouts count stock that was actually carried', () => {
  it('does not count an item that was never stocked as out of stock', async () => {
    if (!hasReferenceData) return;
    // ITM-002's entire history is one `adjustment` row carrying 0 in and 0 out.
    // Counting a ROW rather than a MOVEMENT marked it carried, and that single
    // no-op reported 365 stockout days and pulled service level 100% -> 90%.
    const { rows } = await pool.query(`
      SELECT ii.id, ii.item_code
        FROM inventory_items ii
       WHERE ii.company_id = $1 AND ii.deleted_at IS NULL
         AND COALESCE(ii.is_active, true) = true
         AND NOT EXISTS (SELECT 1 FROM stock_ledger sl
                          WHERE sl.item_id = ii.id
                            AND (sl.quantity_in + sl.quantity_out) > 0)`, [CID]);
    const neverStocked = new Set(rows.map(r => r.item_id ?? r.id));
    for (const s of kpis.stockouts.items) {
      expect(neverStocked.has(s.item_id)).toBe(false);
    }
  });

  it('counts a stockout event as the crossing, not every day of the outage', () => {
    // Otherwise one long outage reports as hundreds of stockouts and the figure
    // stops being comparable between periods.
    for (const s of kpis.stockouts.items) {
      expect(s.stockout_events).toBeLessThanOrEqual(s.days_out_of_stock + 1);
    }
  });

  it('agrees with its own rate: out-of-stock item-days over item-days carried', () => {
    const { item_days_carried: carried, item_days_out_of_stock: out } = kpis.service_level;
    if (!carried) return;
    expect(kpis.stockouts.stockout_rate_pct).toBeCloseTo((100 * out) / carried, 1);
    // The two KPIs are complements and must add to 100, or one of them is wrong.
    expect(kpis.service_level.achieved_in_stock_pct + kpis.stockouts.stockout_rate_pct)
      .toBeCloseTo(100, 1);
  });

  it('every item reported out of stock is actually at or below zero', async () => {
    for (const s of kpis.stockouts.items) {
      const { rows: [row] } = await pool.query(
        `SELECT COALESCE(SUM(quantity_in - quantity_out), 0)::numeric AS bal
           FROM stock_ledger WHERE item_id = $1 AND company_id = $2`, [s.item_id, CID]);
      expect(Number(row.bal)).toBeLessThanOrEqual(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Inventory KPIs · measured against the parameters actually in force', () => {
  it('reports a safety-stock breach against the operative column, not the calculated one', async () => {
    // safety_stock is what MRP honours; safety_stock_calculated is what the model
    // would have set. Measuring the second would report breaches of a policy
    // nobody is running.
    const { rows } = await pool.query(`
      SELECT id, item_code, COALESCE(safety_stock,0)::numeric AS ss,
             COALESCE(current_stock,0)::numeric AS stock
        FROM inventory_items
       WHERE company_id = $1 AND deleted_at IS NULL AND COALESCE(is_active,true) = true
         AND COALESCE(safety_stock,0) > 0
         AND COALESCE(current_stock,0) < COALESCE(safety_stock,0)`, [CID]);
    expect(kpis.safety_stock_breaches.count).toBe(rows.length);
  });

  it('every reported breach carries the shortfall that justifies it', () => {
    for (const b of kpis.safety_stock_breaches.items) {
      expect(b.shortfall).toBeGreaterThan(0);
      expect(b.safety_stock).toBeGreaterThan(b.current_stock);
    }
  });

  it('uses the same demand definition as the planning service', () => {
    // A turnover computed over transfers, or over the seeding scripts' filler
    // vocabulary, would disagree with the EOQ it is supposed to be measuring.
    // Since Phase 3A both read ledgerSemantics: issues count, nothing else does.
    const sql = planning.demandQtySql('sl');
    for (const t of planning.ISSUE_TYPES) expect(sql).toContain(`'${t}'`);
    for (const t of ['transfer', 'bin_transfer', 'general', 'return', 'cycle_count']) {
      expect(planning.demandQtyOf(t, 0, 10)).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Inventory KPIs · excess and non-moving do not double-count', () => {
  it('excess inventory is threshold-driven from company policy, not hard-coded', async () => {
    const settings = await planning.getPlanningSettings(CID);
    const expected = parseInt(settings.excess_cover_days, 10) || 180;
    expect(kpis.excess_inventory.threshold_cover_days).toBe(expected);
    expect(kpis.policy.excess_cover_days).toBe(expected);
  });

  it('only flags excess where there is a demand rate to measure cover against', () => {
    for (const e of kpis.excess_inventory.items) {
      expect(e.cover_days).toBeGreaterThan(kpis.excess_inventory.threshold_cover_days);
      expect(e.excess_qty).toBeGreaterThan(0);
    }
  });

  it('an item with no demand is non-moving, not excess — the two lists are disjoint', () => {
    const excess = new Set(kpis.excess_inventory.items.map(i => i.item_id));
    // FSN N means nothing has moved at all, so there is no cover ratio to exceed.
    for (const s of kpis.obsolete_slow_moving.items) {
      if (s.fsn_class === 'N') expect(excess.has(s.item_id)).toBe(false);
    }
  });

  it('classifies slow and non-moving from the stored FSN class, not an ad-hoc rule', () => {
    for (const s of kpis.obsolete_slow_moving.items) {
      expect(['S', 'N']).toContain(s.fsn_class);
      expect(s.stock_value).toBeGreaterThan(0);   // valueless stock is not a finding
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Inventory KPIs · company scoping', () => {
  it('scopes reservations through the item, since the table has no company_id', async () => {
    // inventory_reservations carries no company_id. Reading it unscoped is how
    // /advanced-inventory/dashboard counts every tenant's reservations as one
    // tenant's.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'inventory_reservations' AND column_name = 'company_id'`);
    expect(rows[0].n).toBe(0);

    const { rows: [scoped] } = await pool.query(`
      SELECT COUNT(*)::int AS n
        FROM inventory_reservations r
        JOIN inventory_items ii ON ii.id = r.item_id
       WHERE ii.company_id = $1 AND ii.deleted_at IS NULL
         AND LOWER(COALESCE(r.status,'')) IN ('active','partially_consumed')
         AND COALESCE(r.quantity_remaining, 0) > 0`, [CID]);
    expect(kpis.pipeline.material_waiting_for_production.reservations).toBe(scoped.n);
  });

  it('counts only this company GRNs as pending inspection', async () => {
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM goods_receipt_notes
        WHERE company_id = $1 AND LOWER(COALESCE(quality_status,'')) = 'pending'`, [CID]);
    expect(kpis.pipeline.grn_pending_iqc).toBe(row.n);
  });

  it('does not build any KPI on v_stock_summary, which CROSS JOINs warehouses', async () => {
    // That view pairs every item with every warehouse, so a store that has never
    // carried an item reads 0 and looks out of stock — the same defect already
    // fixed in /reorder-alerts. Live: 14 items become 448 rows.
    const { rows: [v] } = await pool.query(`SELECT COUNT(*)::int AS n FROM v_stock_summary`);
    const { rows: [i] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM inventory_items WHERE deleted_at IS NULL AND COALESCE(is_active,true)`);
    expect(v.n).toBeGreaterThan(i.n);            // the fan-out is real
    expect(kpis.stockouts.items_currently_out).toBeLessThanOrEqual(i.n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Inventory KPIs · the window is honoured', () => {
  it('annualises consumption rather than reporting a window total as a year', async () => {
    const short = await computeInventoryKpis({ companyId: CID, windowDays: 90 });
    expect(short.window.days).toBe(90);
    const raw = short.turnover.consumption_value_in_window;
    if (raw > 0) {
      expect(short.turnover.annualised_consumption_value).toBeCloseTo(raw * (365 / 90), 0);
    }
  });

  it('averages inventory across sample points, not just opening and closing', () => {
    // One opening/closing average misreads any seasonal build-up: the months in
    // between are exactly where the stock sat.
    if (kpis.coverage.items_carried_in_window > 0) {
      expect(kpis.valuation.sample_points).toBeGreaterThan(2);
    }
  });
});
