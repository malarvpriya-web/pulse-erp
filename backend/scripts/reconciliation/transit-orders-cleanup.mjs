#!/usr/bin/env node
/**
 * transit-orders-cleanup.mjs — scoped removal of the five SO-TRANSIT demo
 * orders (Phase 3I, stage 2). Prepared; run only with approval.
 *
 *   node scripts/reconciliation/transit-orders-cleanup.mjs dry-run
 *   node scripts/reconciliation/transit-orders-cleanup.mjs backup  --out B
 *   node scripts/reconciliation/transit-orders-cleanup.mjs execute --backup B \
 *        --approved-by "<name>" --confirm REMOVE-5-SO-TRANSIT-DEMO-ORDERS [--log L]
 *
 * The records: SO-TRANSIT-2001…2005 (company 1), written by
 * scripts/sca/rebuild-supply-chain-data.mjs (seedOutboundShipments) to demo
 * in-transit logistics. Each has one order line, one package (PKG-REF-…) with
 * one line, one shipment (DSP-REF-…) and one route stop on RT-000001 — and NO
 * stock movement, invoice, return, reservation or audit trail. They are
 * removed whole, or not at all; nothing else is touched:
 *   - the route RT-000001 stays (it has 3 other stops); only these 5 stops go
 *   - no stock movement is created or removed (none exists for them)
 * Every row is backed up first; execute re-checks, under row locks, that each
 * order is still exactly that shape (same ids, no stock, no invoice, no
 * return, no pick list, no other dependants) and aborts otherwise. One
 * audit_logs row per order records the removal.
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '../../.env'), quiet: true });
const [mode, ...rest] = process.argv.slice(2);
const arg = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const need = (k) => { const v = arg(k); if (!v) { console.error(`--${k} is required`); process.exit(2); } return v; };
const CONFIRM = 'REMOVE-5-SO-TRANSIT-DEMO-ORDERS';
const COMPANY = 1;
const NUMBERS = ['SO-TRANSIT-2001', 'SO-TRANSIT-2002', 'SO-TRANSIT-2003', 'SO-TRANSIT-2004', 'SO-TRANSIT-2005'];

async function collect(db, { lock = false } = {}) {
  const L = lock ? 'FOR UPDATE' : '';
  const orders = (await db.query(`SELECT * FROM sales_orders WHERE company_id = $1 AND order_number = ANY($2) ORDER BY id ${L}`, [COMPANY, NUMBERS])).rows;
  const so = orders.map(o => o.id);
  const items = (await db.query(`SELECT * FROM sales_order_items WHERE order_id = ANY($1) ORDER BY id ${L}`, [so])).rows;
  const shipments = (await db.query(`SELECT * FROM shipments WHERE sales_order_id = ANY($1) ORDER BY id ${L}`, [so])).rows;
  const sh = shipments.map(s => s.id);
  const packages = (await db.query(`SELECT * FROM packages WHERE sales_order_id = ANY($1) OR shipment_id = ANY($2) ORDER BY id ${L}`, [so, sh])).rows;
  const pk = packages.map(p => p.id);
  const packageLines = (await db.query(`SELECT * FROM package_lines WHERE package_id = ANY($1) ORDER BY id ${L}`, [pk])).rows;
  const routeStops = (await db.query(`SELECT * FROM route_stops WHERE sales_order_id = ANY($1) OR shipment_id = ANY($2) ORDER BY id ${L}`, [so, sh])).rows;
  // What must NOT exist for the removal to be safe.
  const blockers = {};
  const count = async (k, sql, p) => { const n = Number((await db.query(sql, p)).rows[0].n); if (n) blockers[k] = n; };
  await count('stock_ledger', `SELECT COUNT(*) n FROM stock_ledger WHERE (reference_type = 'sales_order' AND reference_id = ANY($1)) OR (reference_type IN ('shipment','dispatch') AND reference_id = ANY($2))`, [so, sh]);
  await count('invoices', `SELECT COUNT(*) n FROM invoices WHERE sales_order_id = ANY($1)`, [so]);
  await count('sales_returns', `SELECT COUNT(*) n FROM sales_returns WHERE sales_order_id = ANY($1) OR shipment_id = ANY($2)`, [so, sh]);
  await count('pick_lists', `SELECT COUNT(*) n FROM pick_lists WHERE sales_order_id = ANY($1)`, [so]);
  await count('serials_on_packages', `SELECT COUNT(*) n FROM serial_numbers WHERE package_id = ANY($1) OR shipment_id = ANY($2)`, [pk, sh]);
  await count('production_orders', `SELECT COUNT(*) n FROM production_orders WHERE sales_order_id = ANY($1)`, [so]);
  // Any other FK row pointing at these orders / shipments / packages.
  for (const [tbl, ids, known] of [['sales_orders', so, ['sales_order_items', 'packages', 'shipments']],
                                   ['shipments', sh, ['packages', 'route_stops']], ['packages', pk, ['package_lines']]]) {
    const { rows: fks } = await db.query(`SELECT k.conrelid::regclass::text t, a.attname col FROM pg_constraint k
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1] WHERE k.contype='f' AND k.confrelid = $1::regclass`, [tbl]);
    for (const f of fks) {
      if (known.includes(f.t)) continue;
      await count(`${f.t}.${f.col}`, `SELECT COUNT(*) n FROM ${f.t} WHERE "${f.col}" = ANY($1)`, [ids]);
    }
  }
  const shapeOk = orders.length === 5 && items.length === 5 && shipments.length === 5 && packages.length === 5
    && packageLines.length === 5 && routeStops.length === 5 && orders.every(o => String(o.notes || '').includes('SCA-REF'));
  return { orders, items, shipments, packages, packageLines, routeStops, blockers, safe: shapeOk && !Object.keys(blockers).length, shapeOk };
}
const tables = ['orders', 'items', 'shipments', 'packages', 'packageLines', 'routeStops'];
const checksum = (d) => createHash('sha256').update(JSON.stringify(tables.map(t => d[t]))).digest('hex');
const summary = (d) => Object.fromEntries(tables.map(t => [t, d[t].map(r => r.id)]));

const client = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
                               user: process.env.DB_USER, password: process.env.DB_PASSWORD });
await client.connect();
let code = 0;
try {
  if (mode === 'dry-run' || mode === 'backup') {
    await client.query('BEGIN READ ONLY');
    const d = await collect(client);
    if (mode === 'backup') {
      writeFileSync(need('out'), JSON.stringify({ format: 'pulse-transit-orders-backup/1', taken_at: new Date().toISOString(),
        checksum: checksum(d), ...Object.fromEntries(tables.map(t => [t, d[t]])) }, null, 1));
    }
    console.log(JSON.stringify({ mode: mode === 'dry-run' ? 'dry-run — nothing removed' : `backup written to ${arg('out')}`,
      safe: d.safe, shape_ok: d.shapeOk, blockers: d.blockers, would_remove: summary(d), checksum: checksum(d),
      untouched: 'route RT-000001 itself and its other stops; all stock, invoices and other orders', confirm_phrase: CONFIRM }, null, 2));
    code = d.safe ? 0 : 1;
    await client.query('ROLLBACK');
  } else if (mode === 'execute') {
    if (need('confirm') !== CONFIRM) throw new Error(`confirmation phrase must be ${CONFIRM}`);
    const approvedBy = need('approved-by');
    const bk = JSON.parse(readFileSync(need('backup'), 'utf8'));
    await client.query('BEGIN');
    const d = await collect(client, { lock: true });
    if (!d.safe) throw Object.assign(new Error('the orders are no longer exactly the demo shape; nothing removed'), { blockers: d.blockers });
    if (checksum(d) !== bk.checksum) throw new Error('live rows differ from the backup; nothing removed');
    const del = async (sql, ids, n) => { const r = await client.query(sql, [ids]); if (r.rowCount !== n) throw new Error(`${sql}: ${r.rowCount} ≠ ${n}`); };
    await del(`DELETE FROM route_stops WHERE id = ANY($1)`, d.routeStops.map(r => r.id), 5);
    await del(`DELETE FROM package_lines WHERE id = ANY($1)`, d.packageLines.map(r => r.id), 5);
    await del(`DELETE FROM packages WHERE id = ANY($1)`, d.packages.map(r => r.id), 5);
    await del(`DELETE FROM shipments WHERE id = ANY($1)`, d.shipments.map(r => r.id), 5);
    await del(`DELETE FROM sales_order_items WHERE id = ANY($1)`, d.items.map(r => r.id), 5);
    await del(`DELETE FROM sales_orders WHERE id = ANY($1)`, d.orders.map(r => r.id), 5);
    for (const o of d.orders) {
      await client.query(`INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, old_data_json, new_data_json, company_id)
        VALUES (NULL, 'sales', 'demo_record_removed', $1, 'sales_order', $2, $3, $4)`,
        [String(o.id), JSON.stringify(o), JSON.stringify({ approved_by: approvedBy, backup_checksum: bk.checksum, reason: 'SCA-REF in-transit demo order with no stock movement (Phase 3I)' }), COMPANY]);
    }
    await client.query('COMMIT');
    const result = { approved_by: approvedBy, executed_at: new Date().toISOString(), removed: summary(d), backup_checksum: bk.checksum };
    if (arg('log')) writeFileSync(arg('log'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error('mode must be dry-run | backup | execute'); code = 2;
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message, e.blockers || ''); code = 1;
} finally {
  await client.end();
}
process.exit(code);
