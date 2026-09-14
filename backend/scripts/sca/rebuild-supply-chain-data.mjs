/**
 * rebuild-supply-chain-data.mjs
 *
 * Removes the fabricated planning rows the 2026-09-11 SCA audit identified, then
 * builds a coherent manufacturing dataset that the planning engines can actually
 * run on.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * The audit found every MRP run in history reporting planned_order_count = 0
 * while the MRP screens displayed rows. Those rows were seeded fiction: item
 * codes MPO-08208 / MTP-08328 / ME-08168, exception types "Standard" and
 * "Routine" that the engine cannot emit, all inserted in one timestamp, attached
 * to runs whose own headers said zero. Fixing the wiring without removing that
 * data would leave no way to tell a working engine from a decorated one.
 *
 * WHAT IT SEEDS, AND WHY THAT IS NOT THE SAME MISTAKE
 * --------------------------------------------------
 * The difference between this and what it replaces is coherence and intent.
 * The fabricated rows existed to make dashboards look populated: they had no
 * referential integrity, contradicted their own parents, and could not be
 * reproduced or removed. This builds a REFERENCE DATASET for company 1
 * (Manifest Electra, an electrical panel manufacturer) in which every row is
 * consistent with every other: a three-level BOM whose components exist, demand
 * history that adds up, receipts that match purchase orders, lots that trace to
 * the order that consumed them.
 *
 * Every row it writes is tagged `SCA-REF` in a notes/remarks field and every
 * generated code carries a recognisable prefix, so the whole dataset can be
 * found and removed. It is idempotent: re-running updates rather than duplicates.
 *
 * THE PRODUCT FAMILY mirrors the traceability chain the audit was asked to prove
 *   Component -> Assembly -> Panel/Module -> Finished product -> Customer
 *
 *   CP-1000  Control Panel 400A                (finished good)
 *     BA-200 Busbar Assembly 400A              (sub-assembly)
 *       CU-BUS-100  Copper Busbar 100A         x3
 *       TB-32       Terminal Block 32A         x6
 *     RM-300 Relay Module 24V                  (sub-assembly)   x2
 *       RLY-24      Relay 24V DC               x4
 *       TB-32       Terminal Block 32A         x2
 *     CH-400 Cable Harness Set                 (sub-assembly)
 *       CBL-25      Control Cable 2.5sqmm      x25 m
 *       TB-32       Terminal Block 32A         x4
 *     ENC-800 Enclosure 800x600                x1
 *
 * Demand history is generated from a FIXED seed so the dataset is reproducible:
 * a rerun produces the same numbers, which is what makes a forecast accuracy
 * figure meaningful rather than a lottery.
 *
 * Usage:  node scripts/sca/rebuild-supply-chain-data.mjs [--purge-only] [--company 1]
 */

import 'dotenv/config';
import pool from '../../src/config/db.js';

const args = process.argv.slice(2);
const PURGE_ONLY = args.includes('--purge-only');
const COMPANY_ID = parseInt(args[args.indexOf('--company') + 1], 10) || 1;
const TAG = 'SCA-REF';

const log = (...a) => console.log(...a);

/** Deterministic PRNG — a reproducible dataset beats a realistic-looking one. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260911);

const monthStart = (monthsAgo) => {
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() - monthsAgo);
  return d;
};
const iso = (d) => d.toISOString().slice(0, 10);
// Month keys must be built from LOCAL parts: east of UTC, toISOString() on a
// local-midnight 1st returns the previous month's last day, which then fails to
// match SQL's date_trunc('month', ...).
const monthKeyOf = (monthsAgo) => {
  const n = new Date();
  const f = new Date(n.getFullYear(), n.getMonth() - monthsAgo, 1);
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-01`;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. PURGE
// ─────────────────────────────────────────────────────────────────────────────
async function purge(c) {
  log('\n── Purging fabricated rows ────────────────────────────────');

  // The filler vocabulary the seeding scripts left in enumerated columns. These
  // are not valid values for any of these fields in application code.
  const FILLER = `('Standard','General','Primary','Routine')`;

  const steps = [
    ['mrp_time_phased  (synthetic MTP- item codes)',
     `DELETE FROM mrp_time_phased WHERE item_code LIKE 'MTP-%'`],
    ['mrp_exceptions   (synthetic ME- codes / filler types)',
     `DELETE FROM mrp_exceptions WHERE item_code LIKE 'ME-%' OR exception_type IN ${FILLER}`],
    ['mrp_planned_orders (synthetic MPO- codes)',
     `DELETE FROM mrp_planned_orders WHERE item_code LIKE 'MPO-%'`],
    ['mrp_runs         (runs left with no output at all)',
     `DELETE FROM mrp_runs r WHERE NOT EXISTS (SELECT 1 FROM mrp_planned_orders p WHERE p.run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM mrp_time_phased t WHERE t.run_id = r.id)`],
    ['crp_load         (from seeded CR-*-SEED* runs)',
     `DELETE FROM crp_load WHERE run_id IN (SELECT id FROM crp_runs WHERE run_no LIKE 'CR-%SEED%')`],
    ['crp_runs         (CR-*-SEED*)',
     `DELETE FROM crp_runs WHERE run_no LIKE 'CR-%SEED%'`],
    ['stock_ledger     (filler transaction types, qty_in = qty_out)',
     `DELETE FROM stock_ledger WHERE transaction_type IN ${FILLER}`],
    ['sales_order_items (synthetic SOI- codes and filler descriptions)',
     `DELETE FROM sales_order_items WHERE item_code LIKE 'SOI-%'
        OR description LIKE 'ZZTEST_%'
        OR description IN (
          'Completed on schedule with no deviations recorded.',
          'Reviewed and found acceptable against the agreed specification.',
          'Verified against the reference document and approved for release.',
          'Pending confirmation from the site team before dispatch.',
          'Minor observation logged; corrective action already applied.')`],
    ['sales_orders     (leaked ZZTEST fixtures)',
     `DELETE FROM sales_orders WHERE order_number LIKE 'ZZTEST%' OR customer_name LIKE 'ZZTEST%'`],
    ['production_orders (PO-*-SEED*)',
     `DELETE FROM production_orders WHERE production_order_no LIKE '%SEED%'`],
    // Allocations and reservations commit stock, so fabricated ones make MRP
    // plan around inventory nobody is actually holding. These rows carry
    // 'SEED purpose N', a street address in allocation_type, and the filler
    // vocabulary in reference_type — none of which any code path writes.
    ['inventory_allocations (SEED purpose / filler reference types)',
     `DELETE FROM inventory_allocations
       WHERE purpose LIKE 'SEED purpose%' OR reference_type IN ${FILLER}`],
    ['material_reservations (item_name contradicting the item it points at)',
     `DELETE FROM material_reservations mr
       WHERE EXISTS (SELECT 1 FROM inventory_items ii
                      WHERE ii.id = mr.item_id AND ii.item_name <> mr.item_name)`],
    ['demand_forecasts (fully-consumed seeded rows with no run)',
     `DELETE FROM demand_forecasts WHERE run_id IS NULL AND COALESCE(consumed_qty,0) >= COALESCE(quantity,0)
        AND COALESCE(quantity,0) > 0`],
    // Service-desk / Voice-of-Customer fiction. voc_responses carried
    // 'SEED trigger event N' where the enum is commissioning|service_visit|
    // amc_visit|project_closure|manual, and nps_score 1-5 where the scale is
    // 0-10 — every seeded response banded as a detractor, so the headline NPS
    // read -100. `tickets` is a dead duplicate of support_tickets with no write
    // path at all.
    ['voc_responses (SEED trigger/sentiment/classification)',
     `DELETE FROM voc_responses
       WHERE trigger_event LIKE 'SEED %' OR sentiment LIKE 'SEED %' OR classification LIKE 'SEED %'`],
    ['voc_surveys (SEED rows)',
     `DELETE FROM voc_surveys WHERE name LIKE 'SEED %' OR trigger_event LIKE 'SEED %'`],
    ['amc_contracts (AC-*-SEED*)',
     `DELETE FROM amc_contracts WHERE contract_number LIKE '%SEED%'`],
    ['warranty_claims (WC-*-SEED*)',
     `DELETE FROM warranty_claims WHERE claim_number LIKE '%SEED%'`],
    ['tickets (dead duplicate of support_tickets, no write path)',
     `DELETE FROM tickets WHERE ticket_number LIKE '%SEED%'`],
    ['master_production_schedule (fully-produced seeded rows)',
     `DELETE FROM master_production_schedule WHERE COALESCE(quantity_produced,0) >= COALESCE(quantity,0)
        AND COALESCE(quantity,0) > 0 AND source_forecast_id IS NULL AND source_order_id IS NULL`],
  ];

  for (const [label, sql] of steps) {
    const r = await c.query(sql);
    log(`   ${String(r.rowCount).padStart(5)}  ${label}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. MASTER DATA
// ─────────────────────────────────────────────────────────────────────────────
const SUPPLIERS = [
  { code: 'SUP-CU',  name: 'Bharat Copper & Alloys',      lead: 21, city: 'Pune' },
  { code: 'SUP-ELE', name: 'Siemens Components India',    lead: 14, city: 'Chennai' },
  { code: 'SUP-CBL', name: 'Polycab Wires Ltd',           lead: 10, city: 'Mumbai' },
  { code: 'SUP-ENC', name: 'Rittal Enclosure Systems',    lead: 28, city: 'Bengaluru' },
];

const ITEMS = [
  // code, name, type, uom, make/buy, lead, std cost, supplier code
  { code: 'CP-1000',    name: 'Control Panel 400A',        type: 'Finished Good', uom: 'Nos', mb: 'make', lead: 10, cost: 185000, sup: null },
  { code: 'BA-200',     name: 'Busbar Assembly 400A',      type: 'Sub Assembly',  uom: 'Nos', mb: 'make', lead: 4,  cost: 42000,  sup: null },
  { code: 'RM-300',     name: 'Relay Module 24V',          type: 'Sub Assembly',  uom: 'Nos', mb: 'make', lead: 3,  cost: 12500,  sup: null },
  { code: 'CH-400',     name: 'Cable Harness Set',         type: 'Sub Assembly',  uom: 'Nos', mb: 'make', lead: 3,  cost: 8800,   sup: null },
  { code: 'CU-BUS-100', name: 'Copper Busbar 100A',        type: 'Raw Material',  uom: 'Nos', mb: 'buy',  lead: 21, cost: 9800,   sup: 'SUP-CU'  },
  { code: 'TB-32',      name: 'Terminal Block 32A',        type: 'Component',     uom: 'Nos', mb: 'buy',  lead: 14, cost: 185,    sup: 'SUP-ELE' },
  { code: 'RLY-24',     name: 'Relay 24V DC',              type: 'Component',     uom: 'Nos', mb: 'buy',  lead: 14, cost: 2450,   sup: 'SUP-ELE' },
  { code: 'CBL-25',     name: 'Control Cable 2.5 sqmm',    type: 'Raw Material',  uom: 'Mtr', mb: 'buy',  lead: 10, cost: 96,     sup: 'SUP-CBL' },
  { code: 'ENC-800',    name: 'Enclosure 800x600x250',     type: 'Component',     uom: 'Nos', mb: 'buy',  lead: 28, cost: 24500,  sup: 'SUP-ENC' },
];

const BOMS = [
  { parent: 'CP-1000', lines: [
      { child: 'BA-200',  qty: 1 }, { child: 'RM-300', qty: 2 },
      { child: 'CH-400',  qty: 1 }, { child: 'ENC-800', qty: 1 }] },
  { parent: 'BA-200', lines: [
      { child: 'CU-BUS-100', qty: 3 }, { child: 'TB-32', qty: 6 }] },
  { parent: 'RM-300', lines: [
      { child: 'RLY-24', qty: 4 }, { child: 'TB-32', qty: 2 }] },
  { parent: 'CH-400', lines: [
      { child: 'CBL-25', qty: 25 }, { child: 'TB-32', qty: 4 }] },
];

const ROUTINGS = {
  'CP-1000': [['Assembly Line A', 'Final panel assembly', 4.0, 1.0], ['Quality Lab', 'Routine & dielectric test', 1.0, 0.25], ['Packaging Station', 'Crate & label', 0.5, 0.2]],
  'BA-200':  [['Cutting Section', 'Busbar cut to length', 0.5, 0.3], ['Welding Bay', 'Braze & tin joints', 1.5, 0.5]],
  'RM-300':  [['Assembly Line B', 'Relay module build', 0.75, 0.2]],
  'CH-400':  [['Cutting Section', 'Cable cut & strip', 0.3, 0.2], ['Assembly Line B', 'Harness crimp & loom', 0.5, 0.2]],
};

async function upsertSuppliers(c) {
  const map = new Map();
  for (const s of SUPPLIERS) {
    const { rows } = await c.query(
      `SELECT id FROM vendors WHERE vendor_code = $1 AND company_id = $2 AND deleted_at IS NULL`, [s.code, COMPANY_ID]);
    if (rows[0]) { map.set(s.code, rows[0].id); continue; }
    const { rows: [v] } = await c.query(`
      INSERT INTO vendors (vendor_code, vendor_name, company_id, status, lead_time_days, city, vendor_type, category)
      VALUES ($1,$2,$3,'active',$4,$5,'Supplier',$6) RETURNING id`,
      [s.code, s.name, COMPANY_ID, s.lead, s.city, `${TAG} component supplier`]);
    map.set(s.code, v.id);
  }
  log(`   suppliers: ${map.size}`);
  return map;
}

async function upsertItems(c, supplierMap) {
  const map = new Map();
  for (const it of ITEMS) {
    const vendorId = it.sup ? supplierMap.get(it.sup) : null;
    const { rows } = await c.query(`SELECT id FROM inventory_items WHERE item_code = $1`, [it.code]);
    if (rows[0]) {
      await c.query(`
        UPDATE inventory_items
           SET item_name=$2, item_type=$3, unit_of_measure=$4, make_or_buy=$5, lead_time_days=$6,
               standard_cost=$7, preferred_vendor_id=$8, company_id=$9, is_active=true, deleted_at=NULL,
               lot_sizing_rule=COALESCE(lot_sizing_rule,'lot_for_lot'), description=$10
         WHERE id=$1`,
        [rows[0].id, it.name, it.type, it.uom, it.mb, it.lead, it.cost, vendorId, COMPANY_ID, `${TAG} reference item`]);
      map.set(it.code, rows[0].id);
      continue;
    }
    const { rows: [row] } = await c.query(`
      INSERT INTO inventory_items
        (item_code, item_name, item_type, unit_of_measure, make_or_buy, lead_time_days, standard_cost,
         preferred_vendor_id, company_id, current_stock, reorder_level, safety_stock, is_active,
         lot_sizing_rule, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,0,true,'lot_for_lot',$10) RETURNING id`,
      [it.code, it.name, it.type, it.uom, it.mb, it.lead, it.cost, vendorId, COMPANY_ID, `${TAG} reference item`]);
    map.set(it.code, row.id);
  }
  log(`   items: ${map.size}`);
  return map;
}

async function buildBoms(c, itemMap) {
  let headers = 0, lines = 0;
  for (const bom of BOMS) {
    const productId = itemMap.get(bom.parent);
    const { rows: existing } = await c.query(
      `SELECT id FROM bom_headers WHERE product_id = $1 AND company_id = $2 AND status = 'active'`,
      [productId, COMPANY_ID]);

    let bomId;
    if (existing[0]) {
      bomId = existing[0].id;
      await c.query(`DELETE FROM bom_lines WHERE bom_id = $1`, [bomId]);
    } else {
      const { rows: [h] } = await c.query(`
        INSERT INTO bom_headers (product_id, product_code, product_name, bom_number, version, status, is_active, company_id, notes)
        VALUES ($1,$2,$3,$4,'1.0','active',true,$5,$6) RETURNING id`,
        [productId, bom.parent, ITEMS.find(i => i.code === bom.parent).name,
         `BOM-${bom.parent}`, COMPANY_ID, `${TAG} reference BOM`]);
      bomId = h.id;
      headers++;
    }

    for (const l of bom.lines) {
      const childId = itemMap.get(l.child);
      const child = ITEMS.find(i => i.code === l.child);
      await c.query(`
        INSERT INTO bom_lines (bom_id, component_id, component_name, qty, unit, unit_cost, level, company_id)
        VALUES ($1,$2,$3,$4,$5,$6,1,$7)`,
        [bomId, childId, child.name, l.qty, child.uom, child.cost, COMPANY_ID]);
      lines++;
    }

    // Routing steps drive CRP; without them a make order consumes no capacity.
    const steps = ROUTINGS[bom.parent] || [];
    await c.query(`DELETE FROM routing_steps WHERE bom_id = $1`, [bomId]);
    let seq = 10;
    for (const [wcName, opName, stdHrs, setupHrs] of steps) {
      const { rows: [wc] } = await c.query(
        `SELECT id FROM work_centres WHERE name = $1 AND ($2::int IS NULL OR company_id = $2) LIMIT 1`,
        [wcName, COMPANY_ID]);
      if (!wc) continue;
      await c.query(`
        INSERT INTO routing_steps (bom_id, step_no, step_number, operation, description, work_centre_id, std_time_hrs, setup_time_hrs, est_hours)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [bomId, seq, seq, opName, opName, wc.id, stdHrs, setupHrs, stdHrs]);
      seq += 10;
    }
  }
  log(`   BOMs: ${BOMS.length} (${headers} created), lines: ${lines}`);
}

async function setWorkCentreCapacity(c) {
  // Machine + labour capacity. Previously every work centre sat at the defaults
  // (8h, 100% efficiency, 1 machine) and labour was not modelled at all.
  const caps = {
    'Cutting Section':   { hrs: 8,  eff: 85, mach: 2, ops: 2, opHrs: 8, labEff: 90 },
    'Welding Bay':       { hrs: 8,  eff: 80, mach: 2, ops: 3, opHrs: 8, labEff: 85 },
    'Assembly Line A':   { hrs: 16, eff: 90, mach: 1, ops: 6, opHrs: 8, labEff: 92 },
    'Assembly Line B':   { hrs: 16, eff: 90, mach: 1, ops: 4, opHrs: 8, labEff: 92 },
    'Quality Lab':       { hrs: 8,  eff: 95, mach: 1, ops: 2, opHrs: 8, labEff: 95 },
    'Packaging Station': { hrs: 8,  eff: 88, mach: 1, ops: 2, opHrs: 8, labEff: 90 },
  };
  let n = 0;
  for (const [name, k] of Object.entries(caps)) {
    const r = await c.query(`
      UPDATE work_centres
         SET capacity_hours_per_day=$2, efficiency_pct=$3, num_machines=$4,
             num_operators=$5, labour_hours_per_operator=$6, labour_efficiency_pct=$7,
             working_days_per_week=COALESCE(working_days_per_week,5)
       WHERE name=$1 AND ($8::int IS NULL OR company_id=$8)`,
      [name, k.hrs, k.eff, k.mach, k.ops, k.opHrs, k.labEff, COMPANY_ID]);
    n += r.rowCount;
  }
  log(`   work centres updated: ${n}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. HISTORY — 24 months of demand and consumption
// ─────────────────────────────────────────────────────────────────────────────

/** Panel demand: a gentle upward trend, a Q3 seasonal lift, and real noise. */
function demandForMonth(monthsAgo) {
  const t = 24 - monthsAgo;                       // 0..24, increasing with time
  const base = 8 + t * 0.22;                      // trend
  const month = monthStart(monthsAgo).getMonth(); // 0-11
  const seasonal = [0.85, 0.9, 1.0, 1.05, 1.1, 1.15, 1.25, 1.3, 1.2, 1.05, 0.95, 0.85][month];
  const noise = 0.85 + rnd() * 0.3;
  return Math.max(1, Math.round(base * seasonal * noise));
}

async function seedHistory(c, itemMap) {
  const cpId = itemMap.get('CP-1000');
  let orders = 0, ledger = 0;

  // Existing reference orders are cleared so a rerun does not double the history.
  await c.query(`DELETE FROM sales_order_items WHERE order_id IN
                   (SELECT id FROM sales_orders WHERE order_number LIKE 'SO-REF-%')`);
  await c.query(`DELETE FROM sales_orders WHERE order_number LIKE 'SO-REF-%'`);
  // Movement rows only. The opening position is written by seedOpeningStock,
  // which runs immediately before this, and a bare `LIKE '${TAG}%'` sweep deleted
  // those nine rows one line after they were inserted. That is why every
  // item/warehouse balance came out at exactly zero: the paired history nets
  // to nil by design, and the opening stock it was meant to sit on top of was
  // already gone by the time the first movement was written.
  await c.query(
    `DELETE FROM stock_ledger WHERE remarks LIKE $1 AND transaction_type <> 'opening'`,
    [`${TAG}%`]);

  const customers = ['Tata Projects Ltd', 'L&T Construction', 'Adani Infra', 'BHEL Bhopal', 'Siemens Energy'];

  for (let m = 24; m >= 1; m--) {
    const qty = demandForMonth(m);
    const d = monthStart(m);
    d.setDate(3 + Math.floor(rnd() * 20));
    const customer = customers[Math.floor(rnd() * customers.length)];
    const unitPrice = 232000;

    const { rows: [so] } = await c.query(`
      INSERT INTO sales_orders
        (order_number, company_id, customer_name, order_date, delivery_date, promised_date,
         order_status, subtotal, total_amount, notes, priority, delivered_at)
      VALUES ($1,$2,$3,$4,$5,$5,'completed',$6,$6,$7,'normal',$8) RETURNING id`,
      [`SO-REF-${iso(d).replace(/-/g, '')}-${m}`, COMPANY_ID, customer, iso(d),
       iso(new Date(d.getTime() + 30 * 86400000)), qty * unitPrice,
       `${TAG} historical demand`,
       // Most deliveries hit the promise; a realistic minority slip, so on-time
       // delivery is a measurement rather than a constant 100%.
       iso(new Date(d.getTime() + (rnd() < 0.82 ? 27 : 36) * 86400000))]);

    await c.query(`
      INSERT INTO sales_order_items
        (order_id, item_id, item_code, description, quantity, unit, unit_price, total_amount, fulfilled_qty)
      VALUES ($1,$2,'CP-1000','Control Panel 400A',$3,'Nos',$4,$5,$3)`,
      [so.id, cpId, qty, unitPrice, qty * unitPrice]);
    orders++;

    // A month of manufacturing, posted in the order it physically happens, so
    // the ledger BALANCES. Recording only the outward movements is how a ledger
    // ends up saying an item is 270 units short of zero — which is exactly what
    // the first run of this script produced, and what MRP then faithfully tried
    // to replenish.
    const mov = async (itemCode, whId, type, inQty, outQty, refType, refId, dayOffset, note) => {
      const item = ITEMS.find(i => i.code === itemCode);
      await c.query(`
        INSERT INTO stock_ledger
          (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, balance_qty, rate, value,
           reference_type, reference_id, transaction_date, remarks, company_id)
        VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12)`,
        [itemMap.get(itemCode), whId, type, inQty, outQty, item.cost,
         (inQty + outQty) * item.cost, refType, refId,
         iso(new Date(d.getTime() + dayOffset * 86400000)), `${TAG} ${note}`, COMPANY_ID]);
      ledger++;
    };

    const perPanel = { 'CU-BUS-100': 3, 'TB-32': 12, 'RLY-24': 8, 'CBL-25': 25, 'ENC-800': 1 };
    const perSub   = { 'BA-200': 1, 'RM-300': 2, 'CH-400': 1 };

    // 1. Components received against purchase orders …
    for (const [code, per] of Object.entries(perPanel)) await mov(code, 5, 'receipt', qty * per, 0, 'grn', null, 2, 'component receipt');
    // 2. … then issued to the sub-assembly and panel builds …
    for (const [code, per] of Object.entries(perPanel)) await mov(code, 5, 'consumption', 0, qty * per, 'production', null, 8, 'component consumption');
    // 3. … sub-assemblies produced and consumed into the panel …
    for (const [code, per] of Object.entries(perSub)) {
      await mov(code, 5, 'production_receipt', qty * per, 0, 'production', null, 12, 'sub-assembly built');
      await mov(code, 5, 'consumption',        0, qty * per, 'production', null, 16, 'sub-assembly consumed');
    }
    // 4. … the finished panel booked into the main warehouse …
    await mov('CP-1000', 1, 'production_receipt', qty, 0, 'production', null, 20, 'panel completed');
    // 5. … and dispatched to the customer.
    await mov('CP-1000', 1, 'dispatch', 0, qty, 'sales_order', so.id, 27, 'panel dispatch');
  }
  log(`   historical sales orders: ${orders}, ledger movements: ${ledger}`);
}

/** Opening stock so netting has an on-hand position that reconciles. */
async function seedOpeningStock(c, itemMap) {
  // Clear only what this function writes, so a rerun replaces rather than
  // doubles the opening position. seedHistory used to do this clearing as a
  // side effect of its broader sweep; now that it leaves opening rows alone,
  // this has to own them.
  await c.query(
    `DELETE FROM stock_ledger WHERE remarks LIKE $1 AND transaction_type = 'opening'`,
    [`${TAG}%`]);
  const opening = {
    'CP-1000': 2, 'BA-200': 3, 'RM-300': 8, 'CH-400': 4,
    'CU-BUS-100': 40, 'TB-32': 260, 'RLY-24': 70, 'CBL-25': 900, 'ENC-800': 6,
  };
  const d = iso(monthStart(25));
  for (const [code, qty] of Object.entries(opening)) {
    const item = ITEMS.find(i => i.code === code);
    const id = itemMap.get(code);
    await c.query(`
      INSERT INTO stock_ledger
        (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, balance_qty, rate, value,
         reference_type, transaction_date, remarks, company_id)
      VALUES ($1,5,'opening',$2,0,$2,$3,$4,'opening',$5,$6,$7)`,
      [id, qty, item.cost, qty * item.cost, d, `${TAG} opening stock`, COMPANY_ID]);
  }
  log(`   opening stock rows: ${Object.keys(opening).length}`);
}

/**
 * Reconcile inventory_items.current_stock to the ledger.
 *
 * The audit found these two 100% divergent — every item's ledger balance was 0
 * while current_stock read 10006 / 12 / 8 / 15 / 3 — because seeding scripts and
 * two integration tests wrote current_stock directly, with no ledger row. The
 * ledger is the record of what happened, so it wins.
 */
async function reconcileStock(c) {
  const { rowCount } = await c.query(`
    UPDATE inventory_items ii
       SET current_stock = COALESCE(l.bal, 0), updated_at = NOW()
      FROM (SELECT item_id, SUM(quantity_in - quantity_out) AS bal
              FROM stock_ledger GROUP BY item_id) l
     WHERE l.item_id = ii.id AND ii.current_stock IS DISTINCT FROM COALESCE(l.bal, 0)`);
  // An item with no ledger history at all holds no stock — saying otherwise is
  // the fiction this whole exercise removes.
  const { rowCount: zeroed } = await c.query(`
    UPDATE inventory_items ii SET current_stock = 0
     WHERE NOT EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.item_id = ii.id)
       AND COALESCE(ii.current_stock,0) <> 0`);
  log(`   stock reconciled to ledger: ${rowCount} adjusted, ${zeroed} zeroed`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. OPEN SUPPLY AND DEMAND — what MRP will actually plan against
// ─────────────────────────────────────────────────────────────────────────────
async function seedOpenTransactions(c, itemMap, supplierMap) {
  await c.query(`DELETE FROM purchase_order_items WHERE po_id IN
                   (SELECT id FROM purchase_orders WHERE po_number LIKE 'PO-REF-%')`);
  await c.query(`DELETE FROM purchase_orders WHERE po_number LIKE 'PO-REF-%'`);
  await c.query(`DELETE FROM sales_order_items WHERE order_id IN
                   (SELECT id FROM sales_orders WHERE order_number LIKE 'SO-OPEN-%')`);
  await c.query(`DELETE FROM sales_orders WHERE order_number LIKE 'SO-OPEN-%'`);

  // Open purchase orders — dated scheduled receipts. Every existing PO was
  // 'received' with a NULL expected_delivery_date, so MRP saw no supply at all.
  const openPOs = [
    { code: 'TB-32',      qty: 400, days: 8,  sup: 'SUP-ELE' },
    { code: 'RLY-24',     qty: 120, days: 12, sup: 'SUP-ELE' },
    { code: 'CU-BUS-100', qty: 60,  days: 18, sup: 'SUP-CU'  },
  ];
  let poCount = 0;
  for (const p of openPOs) {
    const item = ITEMS.find(i => i.code === p.code);
    const due = new Date(Date.now() + p.days * 86400000);
    const { rows: [po] } = await c.query(`
      INSERT INTO purchase_orders
        (po_number, company_id, supplier_id, order_date, expected_delivery_date,
         status, subtotal, total_amount, notes)
      VALUES ($1,$2,$3,CURRENT_DATE,$4,'approved',$5,$5,$6) RETURNING id`,
      [`PO-REF-${p.code}`, COMPANY_ID, supplierMap.get(p.sup), iso(due),
       p.qty * item.cost, `${TAG} open supply`]);
    await c.query(`
      INSERT INTO purchase_order_items (po_id, item_id, quantity, received_qty, received_quantity, rate, total_amount)
      VALUES ($1,$2,$3,0,0,$4,$5)`,
      [po.id, itemMap.get(p.code), p.qty, item.cost, p.qty * item.cost]);
    poCount++;
  }

  // Open customer demand — future-dated, unfulfilled, with a real item_id. This
  // is the demand that could never reach MRP before, because sales_order_items
  // had no item column and the engine string-matched a filler description.
  const openSOs = [
    { qty: 14, days: 35, cust: 'Tata Projects Ltd', priority: 'high' },
    { qty: 9,  days: 52, cust: 'L&T Construction',  priority: 'normal' },
    { qty: 11, days: 70, cust: 'Adani Infra',       priority: 'normal' },
  ];
  let soCount = 0;
  for (const [i, s] of openSOs.entries()) {
    const due = new Date(Date.now() + s.days * 86400000);
    const { rows: [so] } = await c.query(`
      INSERT INTO sales_orders
        (order_number, company_id, customer_name, order_date, delivery_date, promised_date,
         order_status, subtotal, total_amount, notes, priority)
      VALUES ($1,$2,$3,CURRENT_DATE,$4,$4,'confirmed',$5,$5,$6,$7) RETURNING id`,
      [`SO-OPEN-${1001 + i}`, COMPANY_ID, s.cust, iso(due), s.qty * 232000,
       `${TAG} open demand`, s.priority]);
    await c.query(`
      INSERT INTO sales_order_items
        (order_id, item_id, item_code, description, quantity, unit, unit_price, total_amount, fulfilled_qty)
      VALUES ($1,$2,'CP-1000','Control Panel 400A',$3,'Nos',232000,$4,0)`,
      [so.id, itemMap.get('CP-1000'), s.qty, s.qty * 232000]);
    soCount++;
  }
  log(`   open purchase orders: ${poCount}, open sales orders: ${soCount}`);
}


/**
 * A demand driver with real history, so causal forecasting has something to fit.
 *
 * For a panel builder the genuine leading indicator is enquiry/pipeline value:
 * an enquiry this quarter is a shipped panel a few months later. This builds
 * that series for the reference dataset — deliberately as a LEADING indicator
 * (it is the demand three months ahead, plus noise), because a driver that
 * merely mirrors current demand teaches the regression nothing a moving average
 * does not already know.
 *
 * The noise matters: a driver that predicts demand perfectly would fit with
 * R-squared 1.0 and prove nothing about whether the regression works.
 */
async function seedDemandDrivers(c, itemMap) {
  const LAG = 3;
  const { rows: [drv] } = await c.query(`
    INSERT INTO forecast_drivers
      (company_id, driver_code, driver_name, description, source_type, unit, lag_periods, is_active)
    VALUES ($1,'PANEL_ENQUIRY_IDX','Panel enquiry index',
            $2,'manual','INR lakh',$3,true)
    ON CONFLICT (company_id, driver_code) DO UPDATE
      SET driver_name = EXCLUDED.driver_name, lag_periods = EXCLUDED.lag_periods,
          description = EXCLUDED.description
    RETURNING id`,
    [COMPANY_ID,
     `${TAG} enquiry value for control panels; leads shipped demand by ${LAG} months`,
     LAG]);

  await c.query(`DELETE FROM forecast_driver_values WHERE driver_id = $1`, [drv.id]);

  // The driver at month m explains demand at month m - LAG, so the value stored
  // against month m is built from the demand LAG months later.
  let n = 0;
  for (let m = 27; m >= 0; m--) {
    const demandLater = demandForMonth(Math.max(0, m - LAG));
    const value = Math.round(demandLater * 2.32 * (0.88 + rnd() * 0.24) * 100) / 100;
    const d = monthStart(m);
    await c.query(`
      INSERT INTO forecast_driver_values (driver_id, company_id, period_start, value, is_actual)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (driver_id, period_start) DO UPDATE SET value = EXCLUDED.value`,
      [drv.id, COMPANY_ID, monthKeyOf(m), value, m > 0]);
    n++;
  }

  // Future periods: the lag means the next LAG months are already determined by
  // enquiries already received — which is precisely why a lagged driver is
  // useful for forecasting at all.
  for (let h = 1; h <= 6; h++) {
    const d = monthStart(-h);
    const demandLater = demandForMonth(0);
    const value = Math.round(demandLater * 2.32 * (0.9 + rnd() * 0.2) * 100) / 100;
    await c.query(`
      INSERT INTO forecast_driver_values (driver_id, company_id, period_start, value, is_actual)
      VALUES ($1,$2,$3,$4,false)
      ON CONFLICT (driver_id, period_start) DO UPDATE SET value = EXCLUDED.value`,
      [drv.id, COMPANY_ID, monthKeyOf(-h), value]);
    n++;
  }

  await c.query(`
    INSERT INTO item_demand_drivers (company_id, item_id, driver_id)
    VALUES ($1,$2,$3) ON CONFLICT (item_id, driver_id) DO NOTHING`,
    [COMPANY_ID, itemMap.get('CP-1000'), drv.id]);

  log(`   demand driver PANEL_ENQUIRY_IDX: ${n} period(s), attached to CP-1000`);
}


/**
 * Dispatched-but-not-yet-delivered shipments across several cities.
 *
 * Two things need these to be demonstrable rather than theoretical: outbound
 * in-transit stock (which otherwise reads zero), and route planning, which
 * cannot optimise a tour with nothing to route. The cities are chosen to span a
 * real delivery region so the optimiser has a tour worth improving.
 */
async function seedOutboundShipments(c, itemMap) {
  await c.query(`DELETE FROM route_stops WHERE route_id IN (SELECT id FROM delivery_routes WHERE route_no LIKE 'RT-%')`);
  await c.query(`DELETE FROM delivery_routes WHERE route_no LIKE 'RT-%'`);
  await c.query(`DELETE FROM package_lines WHERE package_id IN (SELECT id FROM packages WHERE package_no LIKE 'PKG-REF-%')`);
  await c.query(`DELETE FROM packages WHERE package_no LIKE 'PKG-REF-%'`);
  await c.query(`DELETE FROM shipments WHERE dispatch_ref LIKE 'DSP-REF-%'`);
  await c.query(`DELETE FROM sales_order_items WHERE order_id IN (SELECT id FROM sales_orders WHERE order_number LIKE 'SO-TRANSIT-%')`);
  await c.query(`DELETE FROM sales_orders WHERE order_number LIKE 'SO-TRANSIT-%'`);

  const drops = [
    { cust: 'Tata Projects Ltd',  city: 'Pune',      qty: 3, days: 2 },
    { cust: 'L&T Construction',   city: 'Nashik',    qty: 2, days: 3 },
    { cust: 'Adani Infra',        city: 'Ahmedabad', qty: 4, days: 5 },
    { cust: 'Siemens Energy',     city: 'Vadodara',  qty: 2, days: 4 },
    { cust: 'BHEL Bhopal',        city: 'Indore',    qty: 3, days: 6 },
  ];
  const cpId = itemMap.get('CP-1000');
  let n = 0;
  for (const [i, d] of drops.entries()) {
    const promised = new Date(Date.now() + d.days * 86400000);
    const { rows: [so] } = await c.query(`
      INSERT INTO sales_orders
        (order_number, company_id, customer_name, order_date, delivery_date, promised_date,
         order_status, subtotal, total_amount, notes, priority, dispatched_at)
      VALUES ($1,$2,$3,CURRENT_DATE - 2,$4,$4,'dispatched',$5,$5,$6,$7,NOW() - INTERVAL '1 day')
      RETURNING id, order_number`,
      [`SO-TRANSIT-${2001 + i}`, COMPANY_ID, d.cust, iso(promised),
       d.qty * 232000, `${TAG} in-transit delivery`, i === 0 ? 'high' : 'normal']);
    await c.query(`
      INSERT INTO sales_order_items
        (order_id, item_id, item_code, description, quantity, unit, unit_price, total_amount, fulfilled_qty)
      VALUES ($1,$2,'CP-1000','Control Panel 400A',$3,'Nos',232000,$4,$3)`,
      [so.id, cpId, d.qty, d.qty * 232000]);

    const { rows: [pkg] } = await c.query(`
      INSERT INTO packages
        (company_id, package_no, sales_order_id, package_type, gross_weight_kg, status,
         packed_by_name, packed_at, notes)
      VALUES ($1,$2,$3,'crate',$4,'shipped','M. Desai, Stores',NOW() - INTERVAL '1 day',$5)
      RETURNING id`,
      [COMPANY_ID, `PKG-REF-${String(i + 1).padStart(4, '0')}`, so.id, d.qty * 84, `${TAG} in-transit`]);
    await c.query(`
      INSERT INTO package_lines (package_id, company_id, item_id, item_name, quantity, uom)
      VALUES ($1,$2,$3,'Control Panel 400A',$4,'Nos')`,
      [pkg.id, COMPANY_ID, cpId, d.qty]);

    const { rows: [sh] } = await c.query(`
      INSERT INTO shipments
        (company_id, reference_type, reference_id, sales_order_id, courier_partner, tracking_number,
         dispatch_ref, package_count, status, direction, dispatch_date, expected_delivery,
         promised_date, weight_kg, from_address, to_address, dispatched_by_name)
      VALUES ($1,'sales_order',$2,$2,'Safexpress',$3,$4,1,'in_transit','outbound',
              CURRENT_DATE - 1,$5,$5,$6,
              'Manifest Electra, MIDC Andheri East, Mumbai',$7,'M. Desai, Stores')
      RETURNING id`,
      [COMPANY_ID, so.id, `SFX-${900000 + i}`, `DSP-REF-${String(i + 1).padStart(4, '0')}`,
       iso(promised), d.qty * 84, `${d.cust}, ${d.city}`]);
    await c.query(`UPDATE packages SET shipment_id = $2 WHERE id = $1`, [pkg.id, sh.id]);
    n++;
  }
  log(`   in-transit outbound shipments: ${n} (Pune, Nashik, Ahmedabad, Vadodara, Indore)`);
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await purge(c);

    if (!PURGE_ONLY) {
      log('\n── Building reference dataset ─────────────────────────────');
      const supplierMap = await upsertSuppliers(c);
      const itemMap     = await upsertItems(c, supplierMap);
      await buildBoms(c, itemMap);
      await setWorkCentreCapacity(c);
      await seedOpeningStock(c, itemMap);
      await seedHistory(c, itemMap);
      await seedOpenTransactions(c, itemMap, supplierMap);
      await seedDemandDrivers(c, itemMap);
      await seedOutboundShipments(c, itemMap);
      await reconcileStock(c);
    }

    await c.query('COMMIT');
    log('\n✅ done\n');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('\n❌ rolled back:', e.message, '\n', e.stack);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

main();
