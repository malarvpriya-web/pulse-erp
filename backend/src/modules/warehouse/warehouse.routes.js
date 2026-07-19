// backend/src/modules/warehouse/warehouse.routes.js
import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = Router();

/* ── Seed sample warehouse (development only) ── */
const seedData = async () => {
  if (process.env.NODE_ENV === 'production') return;
  try {
    const { rows } = await pool.query('SELECT COUNT(*) as n FROM warehouses');
    if (parseInt(rows[0].n) > 0) return;
    const { rows: [wh] } = await pool.query(
      `INSERT INTO warehouses (name, address, type) VALUES
       ('Main Warehouse — Mumbai', 'Plot 14, MIDC Andheri East, Mumbai 400093', 'main')
       RETURNING id`
    );
    await pool.query(`
      INSERT INTO warehouse_zones (warehouse_id, name, zone_type) VALUES
      ($1, 'Receiving Dock A', 'receiving'),
      ($1, 'Raw Material Storage', 'storage'),
      ($1, 'Finished Goods', 'storage'),
      ($1, 'Quarantine Zone', 'storage'),
      ($1, 'Dispatch Bay', 'dispatch')
    `, [wh.id]);

    const { rows: zones } = await pool.query(
      `SELECT * FROM warehouse_zones WHERE warehouse_id=$1 AND zone_type='storage' LIMIT 1`, [wh.id]
    );
    if (zones.length) {
      const zid = zones[0].id;
      for (let row = 1; row <= 3; row++) {
        for (let shelf = 1; shelf <= 4; shelf++) {
          await pool.query(
            `INSERT INTO bin_locations (zone_id, bin_code, row_no, shelf, level, current_items)
             VALUES ($1,$2,$3,$4,'1',$5)`,
            [zid, `R${row}-S${shelf}-L1`, `R${row}`, `S${shelf}`, '[]']
          );
        }
      }
    }
  } catch { /* ignore */ }
};
setTimeout(seedData, 2500);

/* ── GET /bins ── */
router.get('/bins', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { zone_id } = req.query;
    let q = `
      SELECT b.*, z.name as zone_name, z.zone_type, w.name as warehouse_name
      FROM bin_locations b
      JOIN warehouse_zones z ON z.id = b.zone_id
      JOIN warehouses w ON w.id = z.warehouse_id
      WHERE 1=1
    `;
    const params = [];
    if (zone_id) { params.push(zone_id); q += ` AND b.zone_id=$${params.length}`; }
    q += ' ORDER BY b.row_no, b.shelf, b.level';
    const { rows } = await pool.query(q, params);
    const enriched = rows.map(b => {
      const items = Array.isArray(b.current_items) ? b.current_items : [];
      const totalQty = items.reduce((s, i) => s + (i.qty || 0), 0);
      return { ...b, item_count: items.length, total_qty: totalQty,
               occupancy: totalQty > 0 ? 'partial' : 'empty' };
    });
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /zones ── */
router.get('/zones', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT z.*, w.name as warehouse_name,
        (SELECT COUNT(*) FROM bin_locations WHERE zone_id=z.id) as bin_count
      FROM warehouse_zones z
      JOIN warehouses w ON w.id = z.warehouse_id
      ORDER BY w.name, z.name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /bins/assign ── */
router.post('/bins/assign', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { bin_id, item_name, qty, unit } = req.body;
    const { rows: [bin] } = await pool.query('SELECT * FROM bin_locations WHERE id=$1', [bin_id]);
    if (!bin) return res.status(404).json({ error: 'Bin not found' });
    const items = Array.isArray(bin.current_items) ? [...bin.current_items] : [];
    const existing = items.findIndex(i => i.item === item_name);
    if (existing >= 0) {
      items[existing].qty += parseFloat(qty);
    } else {
      items.push({ item: item_name, qty: parseFloat(qty), unit });
    }
    const { rows } = await pool.query(
      'UPDATE bin_locations SET current_items=$1 WHERE id=$2 RETURNING *',
      [JSON.stringify(items), bin_id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /inward ── */
router.post('/inward', requirePermission('inventory', 'add'), async (req, res) => {
  const { gr_number, supplier, items, bin_id, inspection_required = false } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let warehouseId = null;
    if (bin_id) {
      const { rows: [loc] } = await client.query(
        `SELECT z.warehouse_id FROM bin_locations b
           JOIN warehouse_zones z ON z.id = b.zone_id
         WHERE b.id = $1`, [bin_id]
      );
      warehouseId = loc?.warehouse_id ?? null;
    }

    for (const item of items) {
      if (bin_id) {
        const { rows: [bin] } = await client.query('SELECT current_items FROM bin_locations WHERE id=$1', [bin_id]);
        const existing = Array.isArray(bin?.current_items) ? [...bin.current_items] : [];
        const idx = existing.findIndex(i => i.item === item.name);
        if (idx >= 0) { existing[idx].qty += parseFloat(item.qty); }
        else { existing.push({ item: item.name, qty: parseFloat(item.qty), unit: item.unit }); }
        await client.query('UPDATE bin_locations SET current_items=$1 WHERE id=$2', [JSON.stringify(existing), bin_id]);
      }

      if (!inspection_required && warehouseId) {
        const { rows: [invItem] } = await client.query(
          `SELECT id FROM inventory_items WHERE item_name ILIKE $1 AND deleted_at IS NULL LIMIT 1`,
          [item.name]
        );
        if (invItem) {
          const qty = parseFloat(item.qty);
          const { rows: [bal] } = await client.query(
            `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS balance
               FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2`,
            [invItem.id, warehouseId]
          );
          const newBalance = parseFloat(bal.balance) + qty;
          await client.query(
            `INSERT INTO stock_ledger
               (item_id, warehouse_id, transaction_type, quantity_in, quantity_out,
                balance_qty, rate, value, reference_type, transaction_date, remarks, created_by)
             VALUES ($1, $2, 'inward', $3, 0, $4, 0, 0, 'grn', CURRENT_DATE, $5, $6)`,
            [invItem.id, warehouseId, qty, newBalance,
             `GRN: ${gr_number || 'INWARD'} — ${supplier || ''}`,
             req.user?.userId ?? null]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      gr_number,
      status: inspection_required ? 'pending_inspection' : 'stored',
      message: inspection_required
        ? 'Items held for inspection before bin assignment'
        : 'Items stored in bin',
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── GET /pick-lists ── */
router.get('/pick-lists', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { status } = req.query;
    let q = `
      SELECT p.*,
        COUNT(l.id) as total_lines,
        COUNT(l.id) FILTER (WHERE l.status='completed') as completed_lines
      FROM pick_lists p
      LEFT JOIN pick_list_lines l ON l.pick_list_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (status) { params.push(status); q += ` AND p.status=$${params.length}`; }
    q += ' GROUP BY p.id ORDER BY p.created_at DESC LIMIT 50';
    const { rows } = await pool.query(q, params);
    for (const pl of rows) {
      const { rows: lines } = await pool.query(
        `SELECT * FROM pick_list_lines WHERE pick_list_id=$1`, [pl.id]
      );
      pl.lines = lines;
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /pick-lists ── */
router.post('/pick-lists', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const { sales_order_id, sales_order_ref, lines = [], notes } = req.body;
    const { rows: [pl] } = await pool.query(
      `INSERT INTO pick_lists (sales_order_id, sales_order_ref, notes)
       VALUES ($1,$2,$3) RETURNING *`,
      [sales_order_id, sales_order_ref, notes]
    );
    for (const line of lines) {
      await pool.query(
        `INSERT INTO pick_list_lines
           (pick_list_id, item_id, item_name, bin_location_id, bin_code, required_qty)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [pl.id, line.item_id, line.item_name, line.bin_location_id, line.bin_code, line.required_qty]
      );
    }
    res.status(201).json(pl);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PUT /pick-lists/:id/pick ── */
router.put('/pick-lists/:id/pick', requirePermission('inventory', 'edit'), async (req, res) => {
  const { lines = [] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const line of lines) {
      const pickedQty = parseFloat(line.picked_qty) || 0;

      await client.query(
        `UPDATE pick_list_lines
            SET picked_qty = $1,
                status = CASE WHEN $1 >= required_qty THEN 'completed' ELSE 'partial' END
          WHERE id = $2`,
        [pickedQty, line.line_id]
      );

      if (line.bin_location_id && pickedQty > 0) {
        const { rows: [bin] } = await client.query(
          'SELECT current_items FROM bin_locations WHERE id=$1', [line.bin_location_id]
        );
        if (bin) {
          const binItems = Array.isArray(bin.current_items) ? [...bin.current_items] : [];
          const idx = binItems.findIndex(i => i.item === line.item_name);
          if (idx >= 0) {
            binItems[idx].qty = Math.max(0, binItems[idx].qty - pickedQty);
            if (binItems[idx].qty === 0) binItems.splice(idx, 1);
            await client.query('UPDATE bin_locations SET current_items=$1 WHERE id=$2',
              [JSON.stringify(binItems), line.bin_location_id]);
          }
        }

        if (line.item_id) {
          const { rows: [loc] } = await client.query(
            `SELECT z.warehouse_id FROM bin_locations b
               JOIN warehouse_zones z ON z.id = b.zone_id
             WHERE b.id = $1`, [line.bin_location_id]
          );
          const warehouseId = loc?.warehouse_id ?? null;
          if (warehouseId) {
            const { rows: [bal] } = await client.query(
              `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS balance
                 FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2`,
              [line.item_id, warehouseId]
            );
            const newBalance = Math.max(0, parseFloat(bal.balance) - pickedQty);
            await client.query(
              `INSERT INTO stock_ledger
                 (item_id, warehouse_id, transaction_type, quantity_in, quantity_out,
                  balance_qty, rate, value, reference_type, reference_id,
                  transaction_date, remarks, created_by)
               VALUES ($1, $2, 'dispatch', 0, $3, $4, 0, 0, 'pick_list', $5, CURRENT_DATE, $6, $7)`,
              [line.item_id, warehouseId, pickedQty, newBalance,
               req.params.id, `Pick List ${req.params.id}: ${line.item_name}`,
               req.user?.userId ?? null]
            );
          }
        }
      }
    }

    const { rows: [summary] } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status='completed') AS done, COUNT(*) AS total
         FROM pick_list_lines WHERE pick_list_id = $1`, [req.params.id]
    );
    const newStatus = parseInt(summary.done) === parseInt(summary.total) ? 'completed' : 'in-progress';
    const completedAt = newStatus === 'completed' ? ', completed_at = NOW()' : '';
    await client.query(
      `UPDATE pick_lists SET status = $1${completedAt} WHERE id = $2`,
      [newStatus, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, ...summary });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── POST /dispatch ── */
router.post('/dispatch', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { pick_list_id, courier, tracking_number, carton_count, weight_kg } = req.body;
    await pool.query(
      `UPDATE pick_lists SET status='dispatched', completed_at=NOW() WHERE id=$1`,
      [pick_list_id]
    );
    res.json({ success: true, dispatch_ref: `DSP-${Date.now()}`, courier, tracking_number, carton_count, weight_kg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /cycle-count ── */
router.get('/cycle-count', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT h.*,
        w.name as warehouse_name, z.name as zone_name,
        COUNT(l.id) as total_lines,
        COUNT(l.id) FILTER (WHERE l.status='counted') as counted_lines,
        COALESCE(SUM(ABS(l.variance)),0) as total_variance
      FROM cycle_count_headers h
      LEFT JOIN warehouses w ON w.id = h.warehouse_id
      LEFT JOIN warehouse_zones z ON z.id = h.zone_id
      LEFT JOIN cycle_count_lines l ON l.header_id = h.id
      GROUP BY h.id, w.name, z.name
      ORDER BY h.scheduled_date DESC LIMIT 20
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /cycle-count ── */
router.post('/cycle-count', requirePermission('inventory', 'add'), async (req, res) => {
  const { warehouse_id, zone_id, scheduled_date, counted_by } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let resolvedWarehouseId = warehouse_id || null;
    if (!resolvedWarehouseId && zone_id) {
      const { rows: [zone] } = await client.query(
        `SELECT warehouse_id FROM warehouse_zones WHERE id = $1`, [zone_id]
      );
      resolvedWarehouseId = zone?.warehouse_id ?? null;
    }
    if (!resolvedWarehouseId) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'warehouse_id is required and could not be resolved from zone_id.',
      });
    }

    const { rows: [header] } = await client.query(
      `INSERT INTO cycle_count_headers (warehouse_id, zone_id, scheduled_date, counted_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [resolvedWarehouseId, zone_id, scheduled_date, counted_by]
    );

    const { rows: bins } = await client.query(
      `SELECT * FROM bin_locations WHERE zone_id = $1`, [zone_id]
    );
    for (const bin of bins) {
      const binItems = Array.isArray(bin.current_items) ? bin.current_items : [];
      for (const item of binItems) {
        const { rows: [invItem] } = await client.query(
          `SELECT id FROM inventory_items WHERE item_name ILIKE $1 AND deleted_at IS NULL LIMIT 1`,
          [item.item]
        );
        await client.query(
          `INSERT INTO cycle_count_lines
             (header_id, item_id, item_name, bin_location_id, bin_code, system_qty)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [header.id, invItem?.id ?? null, item.item, bin.id, bin.bin_code, item.qty]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json(header);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── POST /cycle-count/:id/submit ── */
router.post('/cycle-count/:id/submit', requirePermission('inventory', 'approve'), async (req, res) => {
  const { lines = [] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [header] } = await client.query(
      `SELECT warehouse_id, zone_id FROM cycle_count_headers WHERE id = $1`, [req.params.id]
    );
    if (!header) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `Cycle count #${req.params.id} not found` });
    }

    let warehouseId = header.warehouse_id;
    if (!warehouseId && header.zone_id) {
      const { rows: [zone] } = await client.query(
        `SELECT warehouse_id FROM warehouse_zones WHERE id = $1`, [header.zone_id]
      );
      warehouseId = zone?.warehouse_id ?? null;
    }
    if (!warehouseId) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'Cannot apply stock adjustments: this cycle count has no warehouse assigned.',
      });
    }

    // Pre-flight pass
    const variantLines    = [];
    const unresolvedItems = [];

    for (const line of lines) {
      const variance = parseFloat(line.counted_qty) - parseFloat(line.system_qty || 0);
      if (Math.abs(variance) === 0) continue;

      const { rows: [dbLine] } = await client.query(
        `SELECT item_id, item_name FROM cycle_count_lines WHERE id = $1`, [line.line_id]
      );
      let itemId = dbLine?.item_id ?? null;

      if (!itemId && dbLine?.item_name) {
        const { rows: [inv] } = await client.query(
          `SELECT id FROM inventory_items WHERE item_name ILIKE $1 AND deleted_at IS NULL LIMIT 1`,
          [dbLine.item_name]
        );
        itemId = inv?.id ?? null;
      }

      if (!itemId) {
        unresolvedItems.push({ line_id: line.line_id, item_name: dbLine?.item_name || '(unknown)', variance });
      } else {
        variantLines.push({ line, variance, itemId });
      }
    }

    if (unresolvedItems.length > 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'Cannot apply stock adjustments: items below have variances but are not in the item master.',
        unresolved_items: unresolvedItems,
      });
    }

    // Write pass
    for (const line of lines) {
      const variance = parseFloat(line.counted_qty) - parseFloat(line.system_qty || 0);
      await client.query(
        `UPDATE cycle_count_lines SET counted_qty=$1, variance=$2, status='counted' WHERE id=$3`,
        [line.counted_qty, variance, line.line_id]
      );
    }

    for (const { variance, itemId } of variantLines) {
      const absVariance = Math.abs(variance);
      const isPositive  = variance > 0;

      const { rows: [bal] } = await client.query(
        `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS balance
           FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2`,
        [itemId, warehouseId]
      );
      const newBalance = parseFloat(bal.balance) + variance;

      await client.query(
        `INSERT INTO stock_ledger
           (item_id, warehouse_id, transaction_type, quantity_in, quantity_out,
            balance_qty, rate, value, reference_type, reference_id,
            transaction_date, remarks, created_by)
         VALUES ($1,$2,'cycle_count',$3,$4,$5,0,0,'cycle_count',$6,CURRENT_DATE,$7,$8)`,
        [
          itemId, warehouseId,
          isPositive ? absVariance : 0,
          isPositive ? 0 : absVariance,
          newBalance,
          req.params.id,
          `Cycle Count #${req.params.id} variance: ${variance > 0 ? '+' : ''}${variance}`,
          req.user?.userId ?? null,
        ]
      );
    }

    await client.query(
      `UPDATE cycle_count_headers SET status='completed', warehouse_id=$1 WHERE id=$2`,
      [warehouseId, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, lines_counted: lines.length, adjustments_applied: variantLines.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── PUT /bins/:id/clear ── */
router.put('/bins/:id/clear', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE bin_locations SET current_items = '[]' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Bin not found' });
    res.json({ ...rows[0], item_count: 0, total_qty: 0, occupancy: 'empty' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /inward-qc  (GRNs pending quality inspection) ── */
router.get('/inward-qc', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const params = ['pending'];
    let cond = '';
    if (companyId != null) { params.push(companyId); cond = ` AND grn.company_id = $${params.length}`; }
    // goods_receipt_notes has no vendor_id/vendor_name/total_value columns, and
    // grn_items has no item_name/unit_of_measure — the vendor is reached through
    // the PO, item descriptors through the item master, and the GRN value is
    // derived from its own lines.
    const { rows } = await pool.query(`
      SELECT
        grn.id,
        grn.grn_number,
        grn.received_date AS date,
        COALESCE(v.vendor_name, 'Unknown Supplier') AS supplier,
        grn.status,
        COALESCE(SUM(COALESCE(gi.quantity_received, 0) * COALESCE(gi.rate, 0)), 0) AS total_value,
        COALESCE(
          json_agg(
            json_build_object('name', ii.item_name, 'qty', gi.quantity_received, 'unit', ii.unit_of_measure)
          ) FILTER (WHERE gi.id IS NOT NULL),
          '[]'
        ) AS items
      FROM goods_receipt_notes grn
      LEFT JOIN purchase_orders po ON po.id = grn.po_id
      LEFT JOIN vendors v ON v.id = po.supplier_id
      LEFT JOIN grn_items gi ON gi.grn_id = grn.id
      LEFT JOIN inventory_items ii ON ii.id = gi.item_id
      WHERE (grn.status = $1 OR grn.status IS NULL) AND grn.deleted_at IS NULL ${cond}
      GROUP BY grn.id, grn.grn_number, grn.received_date, v.vendor_name, grn.status
      ORDER BY grn.received_date DESC
      LIMIT 50
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PATCH /inward-qc/:id  (update GRN status after QC inspection) ── */
router.patch('/inward-qc/:id', requirePermission('inventory', 'edit'), async (req, res) => {
  const { status } = req.body;
  const valid = ['stored', 'quarantine', 'rejected'];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  try {
    const { rows } = await pool.query(
      `UPDATE goods_receipt_notes SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, grn_number, status`,
      [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'GRN not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /inward-qc/:id/send-to-quality ──
 * Stores hands a received material lot to the Quality department: seeds one
 * pending quality test per GRN line item (Quality then adds more / records
 * results) and flags the GRN as awaiting inspection. Store staff only create
 * the link — pass/fail is recorded in the Quality module. */
router.post('/inward-qc/:id/send-to-quality', requirePermission('inventory', 'edit'), async (req, res) => {
  const grnId = parseInt(req.params.id, 10);
  const companyId = req.scope?.company_id ?? null;
  const userId = req.user?.userId ?? req.user?.id ?? null;
  const { assigned_to } = req.body || {};
  try {
    const grn = await pool.query('SELECT id FROM goods_receipt_notes WHERE id=$1', [grnId]);
    if (!grn.rows.length) return res.status(404).json({ error: 'GRN not found' });
    // item_name lives on the item master — grn_items has no item_name column.
    const items = await pool.query(
      `SELECT gi.item_id, ii.item_name AS item_name
       FROM grn_items gi LEFT JOIN inventory_items ii ON ii.id = gi.item_id WHERE gi.grn_id=$1`, [grnId]);
    const lines = items.rows.length ? items.rows : [{ item_id: null, item_name: 'Received material' }];
    const created = [];
    for (const it of lines) {
      const { rows } = await pool.query(
        `INSERT INTO quality_tests
           (company_id, source_type, source_id, grn_id, item_id, item_name, stage, test_name, assigned_to, created_by)
         VALUES ($1,'grn',$2,$2,$3,$4,'IQC',$5,$6,$7) RETURNING id`,
        [companyId, grnId, it.item_id, it.item_name,
         `Incoming quality check — ${it.item_name || 'material'}`, assigned_to || null, userId]
      );
      created.push(rows[0].id);
    }
    await pool.query(
      `UPDATE goods_receipt_notes SET quality_status='pending', status=COALESCE(NULLIF(status,'stored'),'pending'), updated_at=NOW() WHERE id=$1`,
      [grnId]
    ).catch(() => {});
    res.status(201).json({ success: true, grn_id: grnId, tests_created: created.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /cycle-count/:id/lines ── */
router.get('/cycle-count/:id/lines', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM cycle_count_lines WHERE header_id = $1 ORDER BY bin_code, item_name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PATCH /pick-lists/:id/status ── */
router.patch('/pick-lists/:id/status', requirePermission('inventory', 'edit'), async (req, res) => {
  const { status } = req.body;
  const valid = ['packed', 'dispatched', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  try {
    const { rows } = await pool.query(
      `UPDATE pick_lists SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Pick list not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
