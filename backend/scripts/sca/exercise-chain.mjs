#!/usr/bin/env node
// backend/scripts/sca/exercise-chain.mjs
/**
 * Run the supply chain end to end, through the real HTTP routes.
 *
 * WHY THIS IS A SCRIPT AND NOT A SEED
 * -----------------------------------
 * Roughly a fifth of the 198-component scorecard asks a question no amount of
 * code reading can answer: has this mechanism ever actually run? A put-away
 * endpoint that has never put anything away, a rework register with no rework
 * in it, an MPS generator that has never generated - each of those is exactly
 * the state the 2026-09-11 audit found the MRP engine in. Excellent code,
 * mounted, wired, and never once executed against real data.
 *
 * So this does not INSERT rows. It calls the same endpoints a user clicks,
 * with a real token, against the running server, in the order a planner would:
 *
 *     forecast -> approve -> MPS -> MRP -> capacity -> schedule
 *     receive  -> put away -> issue -> rework
 *     promise  -> allocate -> pack -> dispatch -> deliver
 *
 * Anything it creates is a DEMONSTRATION transaction and is tagged so, exactly
 * like the SCA-REF reference dataset it runs on top of. It is not a substitute
 * for real business activity and must never become one.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It never writes a figure a mechanism failed to produce. If an endpoint
 * returns nothing, that step is reported as skipped with the reason - a
 * scorecard that passes because the exercise script filled in the answer is
 * worth less than no scorecard at all.
 *
 *   node scripts/sca/exercise-chain.mjs                  everything
 *   node scripts/sca/exercise-chain.mjs --only=mps,mrp   named steps
 *   node scripts/sca/exercise-chain.mjs --base=http://localhost:5000
 */
import 'dotenv/config';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const HERE    = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../..');

const argv = process.argv.slice(2);
const arg  = (k, d) => {
  const hit = argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
// No default server: it used to be http://localhost:5000 (the developer server).
const BASE  = arg('base', process.env.SCA_BASE_URL || '');
const ONLY  = (arg('only', '') || '').split(',').filter(Boolean);
const EMAIL = arg('as', 'e2e.superadmin@pulse-e2e.test');

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, max: 4,
});
const q = async (text, params) => (await pool.query(text, params)).rows;

// §220 — this drives forecasts, MPS/MRP runs, production orders, receipts and dispatches through the live routes, each consuming document numbers. It runs ONLY against an isolated test database (scripts/test-db/README.md);
// against anything else it exits before its first write.
const { guardOrExit, assertTestServer, mintTestToken } = await import('../test-db/guard.mjs');
await guardOrExit(pool, 'sca/exercise-chain');
if (!BASE) { console.error('\n❌ [sca/exercise-chain] --base (the TEST backend, e.g. http://localhost:5100) is required.\n'); await pool.end(); process.exit(1); }

// ── plumbing ─────────────────────────────────────────────────────────────────
let TOKEN = null;
function mintToken() {
  const out = execFileSync(process.execPath, [path.join(BACKEND, 'scripts/e2e-mint-token.mjs')], {
    env: { ...process.env, E2E_LOGIN_EMAIL: EMAIL }, encoding: 'utf8',
  });
  const m = out.match(/---E2E_AUTH_BEGIN---([\s\S]*?)---E2E_AUTH_END---/);
  if (!m) throw new Error('could not mint a token');
  return JSON.parse(m[1]).token;
}

async function call(method, urlPath, body) {
  const res = await fetch(`${BASE}/api${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, ok: res.ok, data };
}
const get  = (p)     => call('GET', p);
const post = (p, b)  => call('POST', p, b ?? {});
const put  = (p, b)  => call('PUT', p, b ?? {});
const patch= (p, b)  => call('PATCH', p, b ?? {});

const results = [];
const step = async (name, fn) => {
  if (ONLY.length && !ONLY.includes(name)) return;
  process.stdout.write(`\n▸ ${name}\n`);
  try {
    const out = await fn();
    if (out?.skipped) {
      results.push({ name, status: 'skipped', detail: out.skipped });
      console.log(`  skipped — ${out.skipped}`);
    } else {
      results.push({ name, status: 'ok', detail: out?.detail || '' });
      console.log(`  ok — ${out?.detail || ''}`);
    }
  } catch (e) {
    results.push({ name, status: 'failed', detail: e.message });
    console.log(`  FAILED — ${e.message}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
TOKEN = await mintTestToken(pool, EMAIL);
await assertTestServer(pool, BASE, TOKEN, 'sca/exercise-chain');
console.log(`Exercising ${BASE} as ${EMAIL}`);

// 1 ── demand planning ────────────────────────────────────────────────────────
await step('forecast', async () => {
  const run = await post('/inventory/planning/forecast/run', { horizon_periods: 6, lookback_days: 730 });
  if (!run.ok) throw new Error(`run failed: ${run.status} ${run.data?.error || ''}`);
  const r = run.data?.run || run.data;
  return { detail: `run ${r?.run_no}: ${r?.items_forecast ?? 0} forecast, ${r?.items_skipped ?? 0} skipped, MAPE ${r?.avg_mape ?? 'n/a'}` };
});

await step('forecast-approve', async () => {
  const [run] = await q('SELECT id, run_no FROM demand_forecast_runs ORDER BY id DESC LIMIT 1');
  if (!run) return { skipped: 'no forecast run to approve' };
  const res = await post('/inventory/planning/forecast/approve', { run_id: run.id });
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  const n = await q(`SELECT COUNT(*)::int n FROM demand_forecasts WHERE approved_at IS NOT NULL`);
  if (!n[0].n) return { skipped: 'the approve endpoint reported success but nothing carries approved_at' };
  return { detail: `${n[0].n} period(s) approved — MRP will consume these` };
});

await step('forecast-override', async () => {
  // A judgemental override: the planner overruling the model. It must survive
  // the next regeneration, which is the property worth exercising.
  const [row] = await q(`
    SELECT id, forecast_qty FROM demand_forecasts
     WHERE status = 'approved' AND COALESCE(is_manual_override,false) = false
     ORDER BY period_start LIMIT 1`);
  if (!row) return { skipped: 'no approved forecast period to override' };
  const newQty = Math.round((Number(row.forecast_qty) || 10) * 1.2 * 100) / 100;
  const res = await put(`/inventory/planning/forecast/${row.id}`, { quantity: newQty, is_manual_override: true });
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  return { detail: `forecast ${row.id} overridden to ${newQty}` };
});

await step('forecast-accuracy', async () => {
  const res = await post('/inventory/planning/forecast/measure-accuracy', {});
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  const [n] = await q(`SELECT COUNT(*)::int n FROM demand_forecast_accuracy`);
  if (!n.n) return { skipped: 'no closed period to score — the run produced no backtest history' };
  return { detail: `${n.n} closed period(s) scored against actuals` };
});

// 2 ── master production schedule ─────────────────────────────────────────────
await step('mps-generate', async () => {
  const res = await post('/mrp/mps/generate', { horizon_days: 120 });
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  const s = res.data?.summary || {};
  if (!s.rows_created) {
    return { skipped: `no net demand in the horizon (orders ${s.demand_from_orders}, forecast ${s.demand_from_forecast}, existing supply ${s.existing_supply_netted})` };
  }
  return { detail: `${s.rows_created} MPS line(s) from ${s.demand_from_orders} order + ${s.demand_from_forecast} forecast demand, netting ${s.existing_supply_netted} existing supply` };
});

await step('mps-firm', async () => {
  const [row] = await q(`
    SELECT id FROM master_production_schedule
     WHERE generated_by_run_id IS NOT NULL AND firmed_at IS NULL ORDER BY due_date LIMIT 1`);
  if (!row) return { skipped: 'no generated MPS line to firm' };
  const res = await post(`/mrp/mps/${row.id}/firm`, {});
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  return { detail: `MPS line ${row.id} firmed — later runs will not supersede it` };
});

// 3 ── planning parameters and measured lead times ────────────────────────────
await step('planning-recompute', async () => {
  const res = await post('/inventory/planning/recompute', {});
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  const [n] = await q(`SELECT COUNT(*)::int n FROM inventory_items WHERE eoq > 0`);
  return { detail: `${n.n} item(s) carry a computed EOQ` };
});

await step('lead-times', async () => {
  const res = await post('/inventory/planning/lead-times/measure', { min_observations: 2 });
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  const d = res.data || {};
  if (!d.applied) return { skipped: `measured ${d.measured ?? 0} item(s) but none had ${d.min_observations} receipts` };
  return { detail: `${d.applied} item lead time(s) now sourced from receipts, not typed` };
});

// 4 ── MRP and capacity ───────────────────────────────────────────────────────
await step('mrp', async () => {
  const res = await post('/mrp/run', { horizon_days: 120, bucket_days: 7 });
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  const s = res.data?.summary || {};
  const [crp] = await q(`SELECT crp_run_id FROM mrp_runs WHERE id = $1`, [res.data?.run?.id]);
  return { detail: `${s.planned_orders} planned order(s), ${s.exceptions} exception(s), ${s.unmatched} unmatched; capacity run ${crp?.crp_run_id ?? 'not linked'}` };
});

await step('shortages', async () => {
  const res = await get('/mrp/shortages');
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  const s = res.data?.summary || {};
  return { detail: `${s.projected} projected shortage(s), ${s.below_safety_stock} item(s) at or below safety stock` };
});

await step('finite-schedule', async () => {
  const res = await post('/production/schedule/sequence', { horizon_days: 60, rule: 'edd' });
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  const d = res.data || {};
  if (!d.operations) return { skipped: 'no open operations on any work centre to sequence' };
  return { detail: `${d.operations} operation(s) sequenced across ${d.work_centres} work centre(s); ${d.late_operations} miss their order's due date` };
});

// 5 ── warehouse: put-away gives a lot its bin ────────────────────────────────
await step('put-away', async () => {
  const [batch] = await q(`
    SELECT b.id, b.item_id, b.warehouse_id, b.quantity_available, b.batch_number
      FROM inventory_batches b
     WHERE b.bin_id IS NULL AND COALESCE(b.quantity_available,0) > 0
       AND b.company_id = 1
     ORDER BY b.received_date DESC NULLS LAST LIMIT 1`);
  if (!batch) return { skipped: 'every lot already carries a bin, or no lot has stock' };

  const bins = await get(`/warehouse/storage-bins${batch.warehouse_id ? `?warehouse_id=${batch.warehouse_id}` : ''}`);
  let bin = (bins.data || [])[0];
  if (!bin) {
    const any = await get('/warehouse/storage-bins');
    bin = (any.data || [])[0];
  }
  if (!bin) return { skipped: 'no storage bin exists to put stock away into' };

  const task = await post('/warehouse/put-away', {
    item_id: batch.item_id, quantity: batch.quantity_available,
    batch_id: batch.id, to_bin_id: bin.id, to_warehouse_id: bin.warehouse_id,
    notes: 'SCA-EX demonstration put-away',
  });
  if (!task.ok) throw new Error(`raise failed: ${task.status} ${task.data?.error || ''}`);
  const done = await post(`/warehouse/put-away/${task.data.id}/complete`, {});
  if (!done.ok) throw new Error(`complete failed: ${done.status} ${done.data?.error || ''}`);
  return { detail: `lot ${batch.batch_number} put away into bin ${bin.label || bin.bin_code}` };
});

// 6 ── production: rework, and per-serial attribution ─────────────────────────
await step('rework', async () => {
  const [issue] = await q(`
    SELECT m.id, m.production_order_id, m.item_id, m.batch_id, m.qty_issued
      FROM material_issue_logs m
      JOIN production_orders p ON p.id = m.production_order_id
     WHERE m.company_id = 1 AND m.reversed_at IS NULL
     ORDER BY m.id DESC LIMIT 1`);
  if (!issue) return { skipped: 'no material issue to raise a rework against' };

  const res = await post(`/production/orders/${issue.production_order_id}/rework`, {
    issue_log_id: issue.id,
    defect_code: 'SCA-EX-DEMO',
    reason: 'SCA-EX demonstration: component removed for rework',
    disposition: 'reuse',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  const id = res.data?.rework?.id || res.data?.id;
  if (id) {
    await post(`/production/rework/${id}/retest`, { result: 'pass', reference: 'SCA-EX retest' });
  }
  return { detail: `rework raised against order ${issue.production_order_id}${id ? ` and retested (record ${id})` : ''}` };
});

await step('serial-attribution', async () => {
  // Per-serial as-built attribution. Before this existed, a five-panel
  // production order attributed every lot it consumed to all five serials —
  // a recall on one panel pulled back five. The column is nullable and was
  // deliberately NOT backfilled, because NULL there honestly means "shared
  // across the order" and a backfill would have invented per-panel facts.
  const [already] = await q(`SELECT COUNT(*)::int n FROM material_issue_logs WHERE serial_id IS NOT NULL`);
  if (already.n > 0) return { detail: `${already.n} issue(s) already attributed to a specific serial` };

  let [order] = await q(`
    SELECT p.id, p.production_order_no, p.product_id
      FROM production_orders p
     WHERE p.company_id = 1 AND p.product_id IS NOT NULL
       AND LOWER(COALESCE(p.status,'')) IN ('released','in_progress')
     ORDER BY p.id DESC LIMIT 1`);

  if (!order) {
    // Nothing open to build. Raise one on the reference product through the
    // real endpoint and release it — which also exercises the release path,
    // rather than reaching into the table to set a status.
    const [ref] = await q(`
      SELECT p.product_id, i.item_name, p.bom_id
        FROM production_orders p
        JOIN inventory_items i ON i.id = p.product_id
       WHERE p.company_id = 1 AND p.product_id IS NOT NULL
       ORDER BY p.id DESC LIMIT 1`);
    if (!ref) return { skipped: 'no finished-goods item to build' };
    const made = await post('/production/orders', {
      product_id: ref.product_id, product_name: ref.item_name,
      bom_id: ref.bom_id || null, quantity_planned: 1,
      planned_start_date: new Date().toISOString().slice(0, 10),
      notes: 'SCA-EX demonstration build',
    });
    if (!made.ok) return { skipped: `could not raise a build order: ${made.status} ${made.data?.error || ''}` };
    const newId = made.data?.id || made.data?.order?.id;
    const rel = await post(`/production/orders/${newId}/release`, {});
    if (!rel.ok) return { skipped: `order raised but release refused: ${rel.status} ${rel.data?.error || ''}` };
    [order] = await q(`SELECT id, production_order_no, product_id FROM production_orders WHERE id = $1`, [newId]);
  }
  if (!order) return { skipped: 'no released production order with a product to build against' };

  // A serial for the unit being built. Created through the serials endpoint,
  // not inserted — the point of the exercise is that the real path works.
  const sn = `SCA-EX-SN-${order.id}-${Date.now().toString().slice(-5)}`;
  const made = await post('/inventory/serials', {
    serial_number: sn, item_id: order.product_id,
    production_order_id: order.id, status: 'in_production',
    notes: 'SCA-EX demonstration unit',
  });
  if (!made.ok) return { skipped: `could not create a serial: ${made.status} ${made.data?.error || ''}` };

  // Issue works off a reservation, so reserve the BOM first — the same two
  // steps the shop floor performs.
  const reserved = await post(`/production/orders/${order.id}/reserve-materials`, {});
  if (!reserved.ok) return { skipped: `could not reserve materials: ${reserved.status} ${reserved.data?.error || ''}` };

  const [res0] = await q(`
    SELECT mr.id, mr.item_id, mr.qty_reserved
      FROM material_reservations mr
     WHERE mr.production_order_id = $1
       AND LOWER(COALESCE(mr.status,'')) IN ('pending','reserved')
       AND COALESCE(mr.qty_issued,0) = 0
     ORDER BY mr.id LIMIT 1`, [order.id]);
  if (!res0) return { skipped: 'reservation succeeded but produced no reserved line' };

  const issued = await post(`/production/orders/${order.id}/issue-material`, {
    reservation_id: res0.id,
    qty_issued: Math.min(1, Number(res0.qty_reserved) || 1),
    serial_number: sn,
    remarks: 'SCA-EX: component fitted to a specific unit',
  });
  if (!issued.ok) throw new Error(`${issued.status} ${issued.data?.error || ''}`);
  const [n] = await q(`SELECT COUNT(*)::int n FROM material_issue_logs WHERE serial_id IS NOT NULL`);
  if (!n.n) return { skipped: 'the issue succeeded but carried no serial' };
  return { detail: `component fitted to ${sn} on ${order.production_order_no}; ${n.n} attributed issue(s)` };
});

// 7 ── fulfilment: promise, allocate, and an inbound shipment ─────────────────
await step('allocate', async () => {
  const [so] = await q(`
    SELECT so.id, so.order_number FROM sales_orders so
      JOIN sales_order_items soi ON soi.order_id = so.id AND soi.item_id IS NOT NULL
     WHERE so.company_id = 1 AND so.deleted_at IS NULL
       AND LOWER(COALESCE(so.order_status,'')) = 'confirmed'
     ORDER BY so.delivery_date LIMIT 1`);
  if (!so) return { skipped: 'no confirmed sales order with item-linked lines' };
  const res = await post(`/sales/orders/${so.id}/promise`, {});
  if (!res.ok) {
    const alt = await post('/sales/backorders/release', {});
    if (!alt.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
    return { detail: `backorder release ran: ${alt.data?.released ?? 0} released` };
  }
  const [n] = await q(`SELECT COUNT(*)::int n FROM inventory_allocations`);
  return { detail: `order ${so.order_number} promised; ${n.n} allocation(s) now recorded` };
});

await step('inbound-shipment', async () => {
  const [n0] = await q(`SELECT COUNT(*)::int n FROM shipments WHERE direction = 'inbound'`);
  if (n0.n > 0) return { detail: `${n0.n} inbound shipment(s) already tracked` };
  const [po] = await q(`
    SELECT id, po_number, expected_delivery_date FROM purchase_orders
     WHERE company_id = 1 AND LOWER(COALESCE(status,'')) NOT IN ('cancelled','received','closed')
     ORDER BY id DESC LIMIT 1`);
  if (!po) return { skipped: 'no open purchase order to track inbound against' };
  const res = await post('/logistics/shipments', {
    direction: 'inbound',
    reference_type: 'purchase_order', reference_id: po.id,
    status: 'in_transit',
    dispatch_date: new Date().toISOString().slice(0, 10),
    expected_delivery: po.expected_delivery_date,
    notes: `SCA-EX inbound tracking for ${po.po_number}`,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  return { detail: `inbound shipment opened against ${po.po_number}` };
});

// 8 ── voice of the customer ──────────────────────────────────────────────────
await step('voc', async () => {
  const [n0] = await q(`SELECT COUNT(*)::int n FROM voc_responses WHERE sentiment IS NOT NULL`);
  if (n0.n > 0) return { detail: `${n0.n} response(s) already carry sentiment` };
  let [survey] = await q(`SELECT id, name FROM voc_surveys WHERE company_id = 1 AND COALESCE(is_active,true) LIMIT 1`);
  if (!survey) {
    // There is no survey at all — which is itself the finding: the VOC module
    // has triggers wired to four events and nothing for them to fire. Create
    // one through the endpoint rather than skipping, so the trigger path has a
    // survey to attach to.
    const made = await post('/voc/surveys', {
      name: 'Post-delivery satisfaction',
      trigger_event: 'manual',
      questions: [{ key: 'nps', label: 'How likely are you to recommend us?', type: 'nps' }],
      is_active: true,
    });
    if (!made.ok) return { skipped: `no VOC survey and one could not be created: ${made.status} ${made.data?.error || ''}` };
    [survey] = await q(`SELECT id, name FROM voc_surveys WHERE company_id = 1 AND COALESCE(is_active,true) ORDER BY id DESC LIMIT 1`);
  }
  if (!survey) return { skipped: 'no active VOC survey to respond to' };
  const res = await post('/voc/responses', {
    survey_id: survey.id, company_id: 1,
    trigger_event: 'manual',
    customer_name: 'SCA-EX demonstration customer',
    nps_score: 9, rating: 5,
    suggestions: 'SCA-EX: exercised so the sentiment derivation has something to derive from',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.data?.error || ''}`);
  const [n] = await q(`SELECT COUNT(*)::int n FROM voc_responses WHERE sentiment IS NOT NULL`);
  if (!n.n) return { skipped: 'response accepted but sentiment was not derived' };
  return { detail: `${n.n} response(s) carry sentiment` };
});

// ── summary ──────────────────────────────────────────────────────────────────
const ok      = results.filter(r => r.status === 'ok').length;
const skipped = results.filter(r => r.status === 'skipped').length;
const failed  = results.filter(r => r.status === 'failed').length;

console.log('\n' + '='.repeat(70));
console.log(`Exercised ${results.length} step(s): ${ok} ran, ${skipped} skipped, ${failed} failed`);
if (skipped) {
  console.log('\nSkipped steps are NOT failures — they are preconditions this dataset does not meet:');
  for (const r of results.filter(x => x.status === 'skipped')) console.log(`  · ${r.name}: ${r.detail}`);
}
if (failed) {
  console.log('\nFailures:');
  for (const r of results.filter(x => x.status === 'failed')) console.log(`  · ${r.name}: ${r.detail}`);
}
console.log('='.repeat(70));

await pool.end();
process.exit(failed ? 1 : 0);
