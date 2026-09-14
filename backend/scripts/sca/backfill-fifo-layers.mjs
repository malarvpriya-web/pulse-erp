/**
 * backfill-fifo-layers.mjs
 *
 * Builds FIFO/FEFO cost layers from stock movements that predate layering.
 *
 * postStock() maintains layers going forward, but every movement written before
 * migration 20260911000014 — and everything seeded directly into stock_ledger —
 * has no layer behind it. Without a backfill, FIFO valuation would price only
 * the newest stock and silently under-report everything else, which is a subtler
 * version of the bug it was built to fix.
 *
 * Replays each item's ledger in date order: receipts open a layer, issues
 * deplete the open layers oldest-first. Issues that find no layer to draw from
 * are counted and reported rather than forced — stock that left before anything
 * recorded it arriving is a real historical gap, and inventing a layer to cover
 * it would fabricate a cost.
 *
 * Idempotent: clears and rebuilds layers for the items it touches.
 */

import 'dotenv/config';
import pool from '../../src/config/db.js';

const COMPANY_ID = parseInt(process.argv[process.argv.indexOf('--company') + 1], 10) || null;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;

async function main() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    const { rows: items } = await c.query(`
      SELECT DISTINCT ii.id, ii.item_code, ii.standard_cost
        FROM inventory_items ii
        JOIN stock_ledger sl ON sl.item_id = ii.id
       WHERE ($1::int IS NULL OR ii.company_id = $1) AND ii.deleted_at IS NULL
       ORDER BY ii.id`, [COMPANY_ID]);

    console.log(`\n── Rebuilding FIFO layers for ${items.length} item(s) ──────────────`);

    let layersMade = 0, consumed = 0, uncovered = 0;
    for (const it of items) {
      await c.query(`DELETE FROM inventory_fifo_consumption WHERE item_id = $1`, [it.id]);
      await c.query(`DELETE FROM inventory_fifo_layers WHERE item_id = $1`, [it.id]);

      const { rows: moves } = await c.query(`
        SELECT sl.id, sl.warehouse_id, sl.quantity_in, sl.quantity_out, sl.rate,
               sl.transaction_date, sl.reference_type, sl.reference_id, sl.company_id
          FROM stock_ledger sl WHERE sl.item_id = $1
         ORDER BY sl.transaction_date, sl.id`, [it.id]);

      const open = [];   // FIFO queue of { id, remaining, cost }
      for (const m of moves) {
        const inQty = num(m.quantity_in), outQty = num(m.quantity_out);

        if (inQty > 0) {
          // A receipt with no rate is valued at standard cost rather than zero:
          // a zero-cost layer silently writes inventory value down to nothing.
          const cost = num(m.rate) || num(it.standard_cost) || 0;
          const { rows: [layer] } = await c.query(`
            INSERT INTO inventory_fifo_layers
              (company_id, item_id, warehouse_id, received_date, qty_received, qty_remaining,
               unit_cost, source_type, source_id)
            VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8) RETURNING id`,
            [m.company_id, it.id, m.warehouse_id, m.transaction_date, inQty, cost,
             m.reference_type || 'backfill', m.reference_id]);
          open.push({ id: layer.id, remaining: inQty, cost });
          layersMade++;
          await c.query(`UPDATE stock_ledger SET fifo_layer_id = $2 WHERE id = $1`, [m.id, layer.id]);
        }

        if (outQty > 0) {
          let left = outQty;
          while (left > 0.000001 && open.length) {
            const l = open[0];
            const take = Math.min(l.remaining, left);
            await c.query(`
              UPDATE inventory_fifo_layers
                 SET qty_remaining = qty_remaining - $2,
                     depleted_at = CASE WHEN qty_remaining - $2 <= 0 THEN NOW() ELSE depleted_at END
               WHERE id = $1`, [l.id, take]);
            await c.query(`
              INSERT INTO inventory_fifo_consumption
                (layer_id, company_id, item_id, qty, unit_cost, value, reference_type, reference_id, consumed_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [l.id, m.company_id, it.id, take, l.cost, take * l.cost,
               m.reference_type || 'backfill', m.reference_id, m.transaction_date]);
            l.remaining -= take;
            left -= take;
            consumed++;
            if (l.remaining <= 0.000001) open.shift();
          }
          if (left > 0.000001) uncovered += left;
        }
      }
    }

    const { rows: [summary] } = await c.query(`
      SELECT COUNT(*)::int AS open_layers,
             COALESCE(SUM(qty_remaining),0)::numeric AS qty,
             COALESCE(SUM(qty_remaining * unit_cost),0)::numeric AS value
        FROM inventory_fifo_layers WHERE qty_remaining > 0
          AND ($1::int IS NULL OR company_id = $1)`, [COMPANY_ID]);

    await c.query('COMMIT');
    console.log(`   layers created      : ${layersMade}`);
    console.log(`   consumption records : ${consumed}`);
    console.log(`   uncovered issue qty : ${Math.round(uncovered * 1000) / 1000}` +
                (uncovered > 0 ? '  (issued before any recorded receipt)' : ''));
    console.log(`   open layers         : ${summary.open_layers}`);
    console.log(`   FIFO stock value    : ${Number(summary.value).toLocaleString('en-IN')}`);
    console.log('\n✅ done\n');
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
