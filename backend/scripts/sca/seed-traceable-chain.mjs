/**
 * seed-traceable-chain.mjs
 *
 * Builds ONE complete, lot-accurate manufacturing chain so that forward and
 * backward traceability can be demonstrated rather than asserted:
 *
 *   Supplier -> PO -> GRN -> component lot -> issue to production -> sub-assembly
 *   -> panel -> finished product lot -> QC -> carton -> shipment -> customer order
 *
 * The 2026-09-11 SCA audit could not resolve this chain in either direction:
 * material_issue_logs had no batch_id, the trace never recursed past one level,
 * and the finished-goods and customer links returned NULL for every batch tested.
 * The schema and the trace are fixed; this provides the data to prove it.
 *
 * Every row is tagged TRC- in its identifier so the whole chain is removable.
 * Re-running rebuilds it from scratch rather than duplicating.
 */

import 'dotenv/config';
import pool from '../../src/config/db.js';

const CID = 1;
const log = (...a) => console.log(...a);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function main() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // ── Clean any previous run of this chain ────────────────────────────────
    log('\n── Clearing previous traceability chain ──────────────────');
    await c.query(`DELETE FROM package_lines WHERE package_id IN (SELECT id FROM packages WHERE package_no LIKE 'TRC-%')`);
    await c.query(`DELETE FROM packages WHERE package_no LIKE 'TRC-%'`);
    await c.query(`DELETE FROM shipments WHERE dispatch_ref LIKE 'TRC-%'`);
    await c.query(`DELETE FROM pick_list_lines WHERE pick_list_id IN (SELECT id FROM pick_lists WHERE sales_order_ref LIKE 'TRC-%')`);
    await c.query(`DELETE FROM pick_lists WHERE sales_order_ref LIKE 'TRC-%'`);
    await c.query(`DELETE FROM material_issue_logs WHERE production_order_id IN (SELECT id FROM production_orders WHERE production_order_no LIKE 'TRC-%')`);
    await c.query(`DELETE FROM quality_tests WHERE production_order_id IN (SELECT id FROM production_orders WHERE production_order_no LIKE 'TRC-%')`);
    await c.query(`DELETE FROM serial_numbers WHERE serial_number LIKE 'TRC-%'`);
    await c.query(`DELETE FROM inventory_batches WHERE batch_number LIKE 'TRC-%'`);
    await c.query(`DELETE FROM production_orders WHERE production_order_no LIKE 'TRC-%'`);
    await c.query(`DELETE FROM goods_receipt_notes WHERE grn_number LIKE 'TRC-%'`);
    await c.query(`DELETE FROM sales_order_items WHERE order_id IN (SELECT id FROM sales_orders WHERE order_number LIKE 'TRC-%')`);
    await c.query(`DELETE FROM sales_orders WHERE order_number LIKE 'TRC-%'`);

    const itemId = async (code) => (await c.query(`SELECT id FROM inventory_items WHERE item_code = $1`, [code])).rows[0].id;
    const vendorId = async (code) => (await c.query(`SELECT id FROM vendors WHERE vendor_code = $1`, [code])).rows[0].id;
    const bomFor = async (code) =>
      (await c.query(`SELECT bh.id FROM bom_headers bh JOIN inventory_items ii ON ii.id = bh.product_id
                       WHERE ii.item_code = $1 AND bh.status = 'active'`, [code])).rows[0]?.id ?? null;

    // ── 1. Supplier receipts: component lots with a real GRN ────────────────
    log('\n── 1. Supplier -> GRN -> component lots ──────────────────');
    const RECEIPTS = [
      { code: 'CU-BUS-100', sup: 'SUP-CU',  qty: 30,  lot: 'TRC-LOT-CU-001'  },
      { code: 'TB-32',      sup: 'SUP-ELE', qty: 200, lot: 'TRC-LOT-TB-001'  },
      { code: 'RLY-24',     sup: 'SUP-ELE', qty: 60,  lot: 'TRC-LOT-RLY-001' },
      { code: 'CBL-25',     sup: 'SUP-CBL', qty: 300, lot: 'TRC-LOT-CBL-001' },
      { code: 'ENC-800',    sup: 'SUP-ENC', qty: 8,   lot: 'TRC-LOT-ENC-001' },
    ];
    const lotOf = {};
    let n = 0;
    for (const r of RECEIPTS) {
      const iid = await itemId(r.code);
      const vid = await vendorId(r.sup);
      const { rows: [grn] } = await c.query(`
        INSERT INTO goods_receipt_notes
          (grn_number, company_id, received_date, warehouse_id, status, quality_status, notes)
        VALUES ($1,$2,$3,5,'received','passed',$4) RETURNING id, grn_number`,
        [`TRC-GRN-${r.code}`, CID, daysAgo(40), 'SCA traceability chain']);

      // Incoming inspection recorded against the receipt — the QC node that the
      // old trace had nowhere to show.
      await c.query(`
        INSERT INTO quality_tests
          (company_id, source_type, grn_id, item_id, item_name, batch_number, stage,
           test_name, result, status, tested_by_name, tested_at)
        VALUES ($1,'grn',$2,$3,$4,$5,'incoming','Incoming dimensional & visual','pass','completed','R. Iyer, QC',$6)`,
        [CID, grn.id, iid, r.code, r.lot, daysAgo(40)]);

      const { rows: [b] } = await c.query(`
        INSERT INTO inventory_batches
          (item_id, warehouse_id, batch_number, received_date, supplier_id, grn_id,
           quantity_received, quantity_available, quantity_consumed, rate, status, company_id)
        VALUES ($1,5,$2,$3,$4,$5,$6,$6,0,
                (SELECT standard_cost FROM inventory_items WHERE id = $1),'active',$7) RETURNING id`,
        [iid, r.lot, daysAgo(40), vid, grn.id, r.qty, CID]);
      lotOf[r.code] = { batch_id: b.id, lot: r.lot, item_id: iid };
      n++;
    }
    log(`   ${n} component lots received with GRN + incoming QC`);

    // ── 2. Production: sub-assemblies, then the panel ───────────────────────
    log('\n── 2. Production orders consuming identified lots ────────');
    const buildOrder = async ({ no, code, qty, outLot, consumes, wc, startedDaysAgo }) => {
      const iid = await itemId(code);
      const bomId = await bomFor(code);
      const { rows: [po] } = await c.query(`
        INSERT INTO production_orders
          (production_order_no, product_id, product_name, quantity_planned, quantity_completed,
           bom_id, status, priority, planned_start_date, planned_end_date, actual_end_at,
           batch_number, company_id, notes)
        VALUES ($1,$2,(SELECT item_name FROM inventory_items WHERE id=$2),$3,$4,$5,'completed','medium',
                $6,$7,$8,$9,$10,'SCA traceability chain') RETURNING id, production_order_no`,
        [no, iid, qty, qty, bomId, daysAgo(startedDaysAgo), daysAgo(startedDaysAgo - 3),
         daysAgo(startedDaysAgo - 3), outLot, CID]);

      const { rows: [wcRow] } = await c.query(`SELECT id, name FROM work_centres WHERE name = $1`, [wc]);
      const { rows: [op] } = await c.query(`
        INSERT INTO production_operations
          (production_order_id, step_no, operation, work_centre_id, work_centre_name, status,
           quantity_in, quantity_out, started_at, completed_at, assigned_to_name, company_id, quality_status)
        VALUES ($1,10,$2,$3,$4,'completed',$5,$5,$6,$7,$8,$9,'passed') RETURNING id`,
        [po.id, `Build ${code}`, wcRow?.id ?? null, wcRow?.name ?? null, qty,
         daysAgo(startedDaysAgo), daysAgo(startedDaysAgo - 3), 'S. Kulkarni, Operator', CID]);

      // Issue each component FROM AN IDENTIFIED LOT and deplete that lot.
      for (const cons of consumes) {
        const src = lotOf[cons.code];
        const { rows: [ic] } = await c.query(
          `SELECT standard_cost, item_name, unit_of_measure FROM inventory_items WHERE id = $1`, [src.item_id]);
        await c.query(`
          INSERT INTO material_issue_logs
            (company_id, production_order_id, item_id, item_name, batch_id, work_centre_id, operation_id,
             qty_issued, unit, unit_cost, total_cost, issued_by_name, issued_at, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'SCA traceability chain')`,
          [CID, po.id, src.item_id, ic.item_name, src.batch_id, wcRow?.id ?? null, op.id,
           cons.qty, ic.unit_of_measure, ic.standard_cost, ic.standard_cost * cons.qty,
           'S. Kulkarni, Operator', daysAgo(startedDaysAgo)]);
        await c.query(`
          UPDATE inventory_batches
             SET quantity_available = GREATEST(COALESCE(quantity_available,0) - $2, 0),
                 quantity_consumed  = COALESCE(quantity_consumed,0) + $2
           WHERE id = $1`, [src.batch_id, cons.qty]);
      }

      // In-process QC on the order.
      await c.query(`
        INSERT INTO quality_tests
          (company_id, source_type, production_order_id, operation_id, item_id, item_name, batch_number,
           stage, test_name, result, status, tested_by_name, tested_at)
        VALUES ($1,'production',$2,$3,$4,$5,$6,'in_process',$7,'pass','completed','A. Nair, QC',$8)`,
        [CID, po.id, op.id, iid, code, outLot, `In-process check — ${code}`, daysAgo(startedDaysAgo - 2)]);

      // The output lot: this is what makes the next level traceable.
      const { rows: [ob] } = await c.query(`
        INSERT INTO inventory_batches
          (item_id, warehouse_id, batch_number, received_date, quantity_received, quantity_available,
           quantity_consumed, rate, status, company_id, production_order_id)
        VALUES ($1,5,$2,$3,$4,$4,0,(SELECT standard_cost FROM inventory_items WHERE id=$1),'active',$5,$6)
        RETURNING id`,
        [iid, outLot, daysAgo(startedDaysAgo - 3), qty, CID, po.id]);
      lotOf[code] = { batch_id: ob.id, lot: outLot, item_id: iid };
      log(`   ${po.production_order_no.padEnd(18)} ${code.padEnd(11)} qty=${String(qty).padStart(4)} -> lot ${outLot}`);
      return { po_id: po.id, batch_id: ob.id };
    };

    await buildOrder({ no: 'TRC-PO-BA-001', code: 'BA-200', qty: 5, outLot: 'TRC-LOT-BA-001',
      wc: 'Welding Bay', startedDaysAgo: 30,
      consumes: [{ code: 'CU-BUS-100', qty: 15 }, { code: 'TB-32', qty: 30 }] });

    await buildOrder({ no: 'TRC-PO-RM-001', code: 'RM-300', qty: 10, outLot: 'TRC-LOT-RM-001',
      wc: 'Assembly Line B', startedDaysAgo: 28,
      consumes: [{ code: 'RLY-24', qty: 40 }, { code: 'TB-32', qty: 20 }] });

    await buildOrder({ no: 'TRC-PO-CH-001', code: 'CH-400', qty: 5, outLot: 'TRC-LOT-CH-001',
      wc: 'Assembly Line B', startedDaysAgo: 26,
      consumes: [{ code: 'CBL-25', qty: 125 }, { code: 'TB-32', qty: 20 }] });

    const panel = await buildOrder({ no: 'TRC-PO-CP-001', code: 'CP-1000', qty: 5, outLot: 'TRC-LOT-CP-001',
      wc: 'Assembly Line A', startedDaysAgo: 20,
      consumes: [{ code: 'BA-200', qty: 5 }, { code: 'RM-300', qty: 10 },
                 { code: 'CH-400', qty: 5 }, { code: 'ENC-800', qty: 5 }] });

    // Final QC + serials on the finished panels.
    await c.query(`
      INSERT INTO quality_tests
        (company_id, source_type, production_order_id, item_id, item_name, batch_number, stage,
         test_name, result, status, tested_by_name, tested_at)
      VALUES ($1,'production',$2,(SELECT id FROM inventory_items WHERE item_code='CP-1000'),
              'CP-1000','TRC-LOT-CP-001','final','Final routine & dielectric (FAT)','pass','completed','A. Nair, QC',$3)`,
      [CID, panel.po_id, daysAgo(17)]);

    const cpId = await itemId('CP-1000');
    const serialIds = [];
    for (let i = 1; i <= 5; i++) {
      const { rows: [s] } = await c.query(`
        INSERT INTO serial_numbers
          (serial_number, item_id, batch_id, company_id, warehouse_id, status,
           manufactured_date, production_order_id)
        VALUES ($1,$2,$3,$4,1,'shipped',$5,$6) RETURNING id`,
        [`TRC-SN-CP-${String(i).padStart(3, '0')}`, cpId, panel.batch_id, CID, daysAgo(17), panel.po_id]);
      serialIds.push(s.id);
    }
    log(`   final QC passed · 5 serials created`);

    // ── 3. Customer order -> pick -> pack -> ship -> deliver ────────────────
    log('\n── 3. Customer order -> pick -> pack -> ship -> deliver ──');
    const { rows: [so] } = await c.query(`
      INSERT INTO sales_orders
        (order_number, company_id, customer_name, order_date, delivery_date, promised_date,
         order_status, subtotal, total_amount, notes, priority, dispatched_at, delivered_at)
      VALUES ($1,$2,$3,$4,$5,$5,'delivered',$6,$6,'SCA traceability chain','high',$7,$8)
      RETURNING id, order_number, customer_name`,
      [`TRC-SO-9001`, CID, 'Tata Projects Ltd', daysAgo(25), daysAgo(12),
       5 * 232000, daysAgo(15), daysAgo(13)]);
    await c.query(`
      INSERT INTO sales_order_items
        (order_id, item_id, item_code, description, quantity, unit, unit_price, total_amount, fulfilled_qty)
      VALUES ($1,$2,'CP-1000','Control Panel 400A',5,'Nos',232000,$3,5)`,
      [so.id, cpId, 5 * 232000]);

    const { rows: [pl] } = await c.query(`
      INSERT INTO pick_lists (sales_order_id, sales_order_ref, company_id, status, priority, completed_at, notes)
      VALUES ($1,$2,$3,'dispatched','high',$4,'SCA traceability chain') RETURNING id`,
      [so.id, `TRC-${so.order_number}`, CID, daysAgo(15)]);
    await c.query(`
      INSERT INTO pick_list_lines
        (pick_list_id, item_id, item_name, required_qty, picked_qty, status, batch_id)
      VALUES ($1,$2,'Control Panel 400A',5,5,'completed',$3)`,
      [pl.id, cpId, panel.batch_id]);

    const { rows: [pkg] } = await c.query(`
      INSERT INTO packages
        (company_id, package_no, pick_list_id, sales_order_id, package_type, gross_weight_kg,
         status, packed_by_name, packed_at, shipment_id, notes)
      VALUES ($1,'TRC-PKG-000001',$2,$3,'crate',420,'shipped','M. Desai, Stores',$4,NULL,
              'SCA traceability chain') RETURNING id`,
      [CID, pl.id, so.id, daysAgo(15)]);
    // The carton's contents, down to the lot — the last link to the customer.
    await c.query(`
      INSERT INTO package_lines (package_id, company_id, item_id, item_name, batch_id, quantity, uom)
      VALUES ($1,$2,$3,'Control Panel 400A',$4,5,'Nos')`,
      [pkg.id, CID, cpId, panel.batch_id]);

    const { rows: [ship] } = await c.query(`
      INSERT INTO shipments
        (company_id, reference_type, reference_id, sales_order_id, pick_list_id, courier_partner,
         tracking_number, dispatch_ref, package_count, status, direction, dispatch_date,
         expected_delivery, promised_date, actual_delivery, weight_kg, from_address, to_address, dispatched_by_name)
      VALUES ($1,'sales_order',$2,$2,$3,'Safexpress','SFX-88213344','TRC-DSP-000001',1,'delivered','outbound',
              $4,$5,$5,$6,420,'Manifest Electra, MIDC Andheri East, Mumbai',
              'Tata Projects Ltd, Hyderabad','M. Desai, Stores') RETURNING id, dispatch_ref`,
      [CID, so.id, pl.id, daysAgo(15), daysAgo(12), daysAgo(13)]);
    await c.query(`UPDATE packages SET shipment_id = $2 WHERE id = $1`, [pkg.id, ship.id]);

    log(`   ${so.order_number} -> pick list -> carton TRC-PKG-000001 -> ${ship.dispatch_ref} -> ${so.customer_name}`);
    log(`   dispatched ${daysAgo(15)}, promised ${daysAgo(12)}, delivered ${daysAgo(13)} (on time)`);

    await c.query('COMMIT');
    log('\n✅ traceable chain built\n');
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
