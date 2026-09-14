// backend/src/modules/warehouse/warehouse.routes.js
import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { postStock } from '../production/subcontracting.routes.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { companyOf } from '../../shared/scope.js';

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

// ⚠ Same landmine as quality.routes.js: a module-scope timer that writes to the
// database 2.5s after this module is imported, by anything, in any environment.
// Under vitest it fires into a torn-down pool and takes the worker fork with it,
// which vitest reports as "Worker exited unexpectedly" against an innocent file.
// Skipped under test; unref'd so it can never hold a process open on its own.
if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
  setTimeout(seedData, 2500).unref();
}

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


/* ─────────────────────────────────────────────────────────────────────────────
 * ZONE & BIN MASTERS
 *
 * The live audit found both of these readable everywhere and writable nowhere:
 * the only code that had ever inserted a zone or a bin was the development seed
 * block at the top of this file. Renaming a dock or adding a shelf meant editing
 * SQL by hand.
 *
 * Neither table carries company_id, so every route below resolves the tenant by
 * walking up to `warehouses` — zone → warehouse, bin → zone → warehouse — using
 * companyOf(req). Reading req.user.company_id directly fails OPEN across
 * tenants, which for a write route means editing another company's shelf.
 *
 * Deletes here are HARD, unlike a warehouse (which soft-deletes): these tables
 * have no deleted_at, and a zone or bin that is still referenced is refused with
 * a 409 that names the reason rather than being hidden behind a NULL.
 * ────────────────────────────────────────────────────────────────────────────*/

const ZONE_TYPES = ['storage', 'receiving', 'dispatch', 'quarantine', 'staging'];

/**
 * Resolve a zone and prove the caller may touch it.
 * Returns { zone } or { error, status }.
 */
async function loadZoneInScope(zoneId, companyId) {
  const { rows } = await pool.query(
    `SELECT z.*, w.company_id, w.deleted_at AS warehouse_deleted_at
       FROM warehouse_zones z
       JOIN warehouses w ON w.id = z.warehouse_id
      WHERE z.id = $1`,
    [zoneId]
  );
  const zone = rows[0];
  if (!zone) return { error: 'Zone not found', status: 404 };
  if (zone.warehouse_deleted_at) return { error: 'That store has been retired', status: 409 };
  // A scoped caller may only reach their own company's zones. A null companyId
  // is a global (super-admin) scope and skips the check — it is not a missing
  // filter.
  if (companyId != null && zone.company_id !== companyId) {
    return { error: 'Zone not found', status: 404 };
  }
  return { zone };
}

/* ── POST /zones ── create a zone in a store ── */
router.post('/zones', requirePermission('inventory', 'add'), async (req, res) => {
  const { warehouse_id, name, zone_type } = req.body;
  if (!warehouse_id)  return res.status(422).json({ error: 'warehouse_id is required' });
  if (!name?.trim())  return res.status(422).json({ error: 'Zone name is required' });

  const type = (zone_type || 'storage').trim().toLowerCase();
  if (!ZONE_TYPES.includes(type)) {
    return res.status(422).json({ error: `zone_type must be one of: ${ZONE_TYPES.join(', ')}` });
  }

  try {
    const companyId = companyOf(req);
    const { rows: [wh] } = await pool.query(
      `SELECT id, company_id FROM warehouses WHERE id = $1 AND deleted_at IS NULL`,
      [warehouse_id]
    );
    if (!wh) return res.status(404).json({ error: 'Store not found' });
    if (companyId != null && wh.company_id !== companyId) {
      return res.status(404).json({ error: 'Store not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO warehouse_zones (warehouse_id, name, zone_type)
       VALUES ($1, $2, $3) RETURNING *`,
      [wh.id, name.trim(), type]
    );
    res.status(201).json({ ...rows[0], bin_count: 0 });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A zone with that name already exists in this store' });
    }
    res.status(500).json({ error: e.message });
  }
});

/* ── PUT /zones/:id ── rename or retype a zone ── */
router.put('/zones/:id', requirePermission('inventory', 'edit'), captureBefore('warehouse_zones'), async (req, res) => {
  const { name, zone_type } = req.body;
  if (name !== undefined && !name?.trim()) {
    return res.status(422).json({ error: 'Zone name cannot be blank' });
  }
  let type;
  if (zone_type !== undefined) {
    type = String(zone_type).trim().toLowerCase();
    if (!ZONE_TYPES.includes(type)) {
      return res.status(422).json({ error: `zone_type must be one of: ${ZONE_TYPES.join(', ')}` });
    }
  }

  try {
    const { error, status } = await loadZoneInScope(req.params.id, companyOf(req));
    if (error) return res.status(status).json({ error });

    // warehouse_id is deliberately NOT updatable. Moving a zone between stores
    // would carry its bins — and the stock recorded in them — to a different
    // physical building without a single stock-ledger row saying so.
    const sets = [];
    const vals = [];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (name !== undefined)      push('name', name.trim());
    if (zone_type !== undefined) push('zone_type', type);
    if (!sets.length) return res.status(422).json({ error: 'No updatable fields supplied' });

    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE warehouse_zones SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A zone with that name already exists in this store' });
    }
    res.status(500).json({ error: e.message });
  }
});

/* ── DELETE /zones/:id ── */
router.delete('/zones/:id', requirePermission('inventory', 'delete'), async (req, res) => {
  try {
    const { error, status } = await loadZoneInScope(req.params.id, companyOf(req));
    if (error) return res.status(status).json({ error });

    // Both dependents are checked by hand rather than left to the FK, so the
    // caller is told WHICH link is holding the zone instead of getting a 500
    // carrying a constraint name.
    const { rows: [dep] } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM bin_locations       WHERE zone_id = $1)::int AS bins,
              (SELECT COUNT(*) FROM cycle_count_headers WHERE zone_id = $1)::int AS counts`,
      [req.params.id]
    );
    if (dep.bins > 0) {
      return res.status(409).json({
        error: `This zone still has ${dep.bins} bin${dep.bins === 1 ? '' : 's'}. Delete or move them first.`,
      });
    }
    if (dep.counts > 0) {
      return res.status(409).json({
        error: 'This zone is referenced by a cycle count and cannot be deleted.',
      });
    }

    await pool.query('DELETE FROM warehouse_zones WHERE id = $1', [req.params.id]);
    res.json({ success: true, deleted: Number(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /bins ── create a bin in a zone ── */
router.post('/bins', requirePermission('inventory', 'add'), async (req, res) => {
  const { zone_id, bin_code, row_no, shelf, level, max_weight_kg } = req.body;
  if (!zone_id)          return res.status(422).json({ error: 'zone_id is required' });
  if (!bin_code?.trim()) return res.status(422).json({ error: 'Bin code is required' });

  try {
    const { error, status } = await loadZoneInScope(zone_id, companyOf(req));
    if (error) return res.status(status).json({ error });

    const weight = max_weight_kg === undefined || max_weight_kg === '' ? null : Number(max_weight_kg);
    if (weight !== null && (isNaN(weight) || weight < 0)) {
      return res.status(422).json({ error: 'max_weight_kg must be a positive number' });
    }

    // current_items is left at its '[]' default. A bin is created empty and
    // filled through /bins/assign, which is the only path that also keeps the
    // occupancy figures on the read side consistent.
    const { rows } = await pool.query(
      `INSERT INTO bin_locations (zone_id, bin_code, row_no, shelf, level, max_weight_kg)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 500))
       RETURNING *`,
      [
        zone_id,
        bin_code.trim().toUpperCase(),
        row_no?.trim() || null,
        shelf?.trim()  || null,
        level?.trim()  || null,
        weight,
      ]
    );
    res.status(201).json({ ...rows[0], item_count: 0, total_qty: 0, occupancy: 'empty' });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A bin with that code already exists in this zone' });
    }
    res.status(500).json({ error: e.message });
  }
});

/* ── PUT /bins/:id ── edit a bin's identity, never its contents ── */
router.put('/bins/:id', requirePermission('inventory', 'edit'), captureBefore('bin_locations'), async (req, res) => {
  const { bin_code, row_no, shelf, level, max_weight_kg } = req.body;
  if (bin_code !== undefined && !bin_code?.trim()) {
    return res.status(422).json({ error: 'Bin code cannot be blank' });
  }
  try {
    const companyId = companyOf(req);
    const { rows: [bin] } = await pool.query(
      `SELECT b.id, w.company_id
         FROM bin_locations b
         JOIN warehouse_zones z ON z.id = b.zone_id
         JOIN warehouses w      ON w.id = z.warehouse_id
        WHERE b.id = $1`,
      [req.params.id]
    );
    if (!bin) return res.status(404).json({ error: 'Bin not found' });
    if (companyId != null && bin.company_id !== companyId) {
      return res.status(404).json({ error: 'Bin not found' });
    }

    // current_items is absent from this list on purpose: it is the stock record
    // for the bin, and /bins/assign and /bins/:id/clear are the only writers
    // that keep it consistent. zone_id is absent for the same reason a zone
    // cannot change warehouse — moving a full bin is a stock movement.
    const sets = [];
    const vals = [];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (bin_code !== undefined) push('bin_code', bin_code.trim().toUpperCase());
    if (row_no   !== undefined) push('row_no',   row_no?.trim() || null);
    if (shelf    !== undefined) push('shelf',    shelf?.trim()  || null);
    if (level    !== undefined) push('level',    level?.trim()  || null);
    if (max_weight_kg !== undefined) {
      const w = max_weight_kg === '' ? null : Number(max_weight_kg);
      if (w !== null && (isNaN(w) || w < 0)) {
        return res.status(422).json({ error: 'max_weight_kg must be a positive number' });
      }
      push('max_weight_kg', w);
    }
    if (!sets.length) return res.status(422).json({ error: 'No updatable fields supplied' });

    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE bin_locations SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    const items = Array.isArray(rows[0].current_items) ? rows[0].current_items : [];
    const totalQty = items.reduce((s, i) => s + (i.qty || 0), 0);
    res.json({ ...rows[0], item_count: items.length, total_qty: totalQty,
               occupancy: totalQty > 0 ? 'partial' : 'empty' });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A bin with that code already exists in this zone' });
    }
    res.status(500).json({ error: e.message });
  }
});

/* ── DELETE /bins/:id ── */
router.delete('/bins/:id', requirePermission('inventory', 'delete'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { rows: [bin] } = await pool.query(
      `SELECT b.id, b.bin_code, b.current_items, w.company_id
         FROM bin_locations b
         JOIN warehouse_zones z ON z.id = b.zone_id
         JOIN warehouses w      ON w.id = z.warehouse_id
        WHERE b.id = $1`,
      [req.params.id]
    );
    if (!bin) return res.status(404).json({ error: 'Bin not found' });
    if (companyId != null && bin.company_id !== companyId) {
      return res.status(404).json({ error: 'Bin not found' });
    }

    // ⚠ current_items IS the stock record for this shelf. Deleting a bin that
    // still lists stock destroys the only record of where that stock is — the
    // row is not recoverable, since there is no deleted_at on this table.
    const items = Array.isArray(bin.current_items) ? bin.current_items : [];
    const totalQty = items.reduce((s, i) => s + (i.qty || 0), 0);
    if (totalQty > 0) {
      return res.status(409).json({
        error: 'This bin still holds stock. Move or clear its contents before deleting it.',
      });
    }

    const { rows: [dep] } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM pick_list_lines   WHERE bin_location_id = $1)::int AS picks,
              (SELECT COUNT(*) FROM cycle_count_lines WHERE bin_location_id = $1)::int AS counts`,
      [req.params.id]
    );
    if (dep.picks > 0 || dep.counts > 0) {
      return res.status(409).json({
        error: 'This bin appears on a pick list or cycle count and cannot be deleted. Clear it instead.',
      });
    }

    await pool.query('DELETE FROM bin_locations WHERE id = $1', [req.params.id]);
    res.json({ success: true, deleted: Number(req.params.id), bin_code: bin.bin_code });
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
          // Was a hand-rolled stock_ledger insert that never touched
          // inventory_items.current_stock — the column MRP planning and every
          // dashboard reorder KPI read directly — so warehouse-screen receipts
          // silently desynced from what those views showed. Now goes through
          // the same shared helper GRN/production/service-desk all use.
          await postStock(client, {
            itemId: invItem.id,
            warehouseId,
            inQty: parseFloat(item.qty),
            txnType: 'inward',
            refType: 'grn',
            remarks: `GRN: ${gr_number || 'INWARD'} — ${supplier || ''}`,
            createdBy: req.user?.employee_id ?? null,
            companyId: req.scope?.company_id ?? null,
          });
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
    // pick_lists had no company_id at all and this filtered on WHERE 1=1, so
    // every tenant read every other tenant's picking work. The column was added
    // in 20260911000010; NULL means a row predating it, visible only to a global
    // (super-admin) scope, which is how the rest of this codebase treats NULL.
    let q = `
      SELECT p.*,
        COUNT(l.id) as total_lines,
        COUNT(l.id) FILTER (WHERE l.status='completed') as completed_lines
      FROM pick_lists p
      LEFT JOIN pick_list_lines l ON l.pick_list_id = p.id
      WHERE ($1::int IS NULL OR p.company_id = $1)
    `;
    const params = [companyOf(req)];
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
    const { sales_order_id, sales_order_ref, lines = [], notes, priority } = req.body;
    const { rows: [pl] } = await pool.query(
      `INSERT INTO pick_lists (sales_order_id, sales_order_ref, notes, company_id, priority)
       VALUES ($1,$2,$3,$4,COALESCE($5,'normal')) RETURNING *`,
      [sales_order_id, sales_order_ref, notes, companyOf(req), priority || null]
    );
    for (const line of lines) {
      await pool.query(
        `INSERT INTO pick_list_lines
           (pick_list_id, item_id, item_name, bin_location_id, bin_code, required_qty,
            batch_id, sales_order_item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [pl.id, line.item_id, line.item_name, line.bin_location_id, line.bin_code, line.required_qty,
         line.batch_id ?? null, line.sales_order_item_id ?? null]
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
            // Same hand-rolled-vs-shared-helper gap as /inward above — this
            // never updated inventory_items.current_stock either.
            await postStock(client, {
              itemId: line.item_id,
              warehouseId,
              outQty: pickedQty,
              txnType: 'dispatch',
              refType: 'pick_list',
              refId: req.params.id,
              remarks: `Pick List ${req.params.id}: ${line.item_name}`,
              createdBy: req.user?.employee_id ?? null,
              companyId: req.scope?.company_id ?? null,
            });
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

/* ── POST /pack ── build a package from picked lines ──────────────────────────
   Packing did not exist anywhere in the system: there was no package, pack list
   or carton entity, and the carton_count that dispatch accepted was discarded.
   Recording WHICH LOT went into WHICH CARTON is also the last link in the
   traceability chain — it is what lets a batch be traced to the customer who
   received it. */
router.post('/pack', requirePermission('inventory', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { pick_list_id, package_type, gross_weight_kg, length_cm, width_cm, height_cm, lines = [], notes } = req.body || {};
    if (!pick_list_id) return res.status(400).json({ error: 'pick_list_id is required' });
    await client.query('BEGIN');

    const cid = companyOf(req);
    const { rows: [pl] } = await client.query(
      `SELECT * FROM pick_lists WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [pick_list_id, cid]);
    if (!pl) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pick list not found' }); }

    const { rows: [seq] } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(package_no, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n
         FROM packages WHERE ($1::int IS NULL OR company_id = $1)`, [cid]);
    const packageNo = `PKG-${String(seq.n).padStart(6, '0')}`;

    const { rows: [pkg] } = await client.query(`
      INSERT INTO packages
        (company_id, package_no, pick_list_id, sales_order_id, package_type, gross_weight_kg,
         length_cm, width_cm, height_cm, status, packed_by, packed_by_name, packed_at, notes)
      VALUES ($1,$2,$3,$4,COALESCE($5,'carton'),$6,$7,$8,$9,'packed',$10,$11,NOW(),$12) RETURNING *`,
      [cid, packageNo, pl.id, pl.sales_order_id, package_type, gross_weight_kg ?? null,
       length_cm ?? null, width_cm ?? null, height_cm ?? null,
       req.user?.id ?? null, req.user?.name || req.user?.username || null, notes ?? null]);

    // Default to everything picked on this list when no explicit contents given.
    let contents = lines;
    if (!contents.length) {
      const { rows } = await client.query(
        `SELECT id AS pick_list_line_id, item_id, item_name, batch_id, picked_qty AS quantity
           FROM pick_list_lines WHERE pick_list_id = $1 AND COALESCE(picked_qty,0) > 0`, [pl.id]);
      contents = rows;
    }
    for (const l of contents) {
      await client.query(`
        INSERT INTO package_lines
          (package_id, company_id, item_id, item_name, batch_id, serial_id, pick_list_line_id, quantity, uom)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [pkg.id, cid, l.item_id ?? null, l.item_name ?? null, l.batch_id ?? null, l.serial_id ?? null,
         l.pick_list_line_id ?? null, l.quantity ?? 0, l.uom ?? null]);
    }
    await client.query(`UPDATE pick_lists SET status = 'packed' WHERE id = $1`, [pl.id]);

    await client.query('COMMIT');
    const { rows: pkgLines } = await pool.query(`SELECT * FROM package_lines WHERE package_id = $1`, [pkg.id]);
    res.status(201).json({ ...pkg, lines: pkgLines });
  } catch (e) {
    await client.query('ROLLBACK'); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ── POST /dispatch ── pick list → shipment ───────────────────────────────────
   This used to accept courier, tracking_number, carton_count and weight_kg,
   store NONE of them, write no shipment row, and return a DSP-<timestamp>
   reference that was never persisted and could never be looked up again.
   Picking and shipping were two disconnected islands.

   A dispatch now CREATES the shipment, carries the packages onto it, moves the
   order forward, and returns a reference that exists in the database. Final
   inspection gates it: quality_settings.fat_dispatch_gate was a stored setting
   that no dispatch code ever read, so a failed final QC could not stop a
   shipment. */
router.post('/dispatch', requirePermission('inventory', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { pick_list_id, courier, carrier_id, tracking_number, weight_kg,
            expected_delivery, freight_cost, from_address, to_address, notes } = req.body || {};
    if (!pick_list_id) return res.status(400).json({ error: 'pick_list_id is required' });
    await client.query('BEGIN');

    const cid = companyOf(req);
    const { rows: [pl] } = await client.query(
      `SELECT * FROM pick_lists WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [pick_list_id, cid]);
    if (!pl) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pick list not found' }); }
    if (pl.status === 'dispatched') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This pick list has already been dispatched.' });
    }

    // ── Quality gate ────────────────────────────────────────────────────────
    const { rows: [qs] } = await client.query(
      `SELECT fat_dispatch_gate FROM quality_settings WHERE company_id = $1`, [cid]);
    const gateOn = qs ? qs.fat_dispatch_gate !== false : true;
    if (gateOn && pl.sales_order_id) {
      const { rows: [fail] } = await client.query(`
        SELECT COUNT(*)::int AS failed
          FROM quality_tests qt
          JOIN production_orders po ON po.id = qt.production_order_id
         WHERE po.sales_order_id = $1 AND qt.result = 'fail'
           AND COALESCE(qt.status,'') <> 'cancelled'`, [pl.sales_order_id]);
      if (fail && fail.failed > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Dispatch blocked: ${fail.failed} failed quality test(s) on this order. Close them or disable the final-inspection dispatch gate in Quality Settings.`,
          code: 'FAT_GATE',
        });
      }
    }

    const { rows: [seq] } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(dispatch_ref, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n
         FROM shipments WHERE ($1::int IS NULL OR company_id = $1)`, [cid]);
    const dispatchRef = `DSP-${String(seq.n).padStart(6, '0')}`;

    const { rows: pkgs } = await client.query(
      `SELECT id, gross_weight_kg FROM packages WHERE pick_list_id = $1`, [pl.id]);
    const packedWeight = pkgs.reduce((s, p) => s + parseFloat(p.gross_weight_kg || 0), 0);
    const totalWeight = weight_kg ?? (packedWeight > 0 ? packedWeight : null);

    const { rows: [so] } = await client.query(
      `SELECT customer_name, promised_date, delivery_date FROM sales_orders WHERE id = $1`, [pl.sales_order_id]);

    const { rows: [shipment] } = await client.query(`
      INSERT INTO shipments
        (company_id, reference_type, reference_id, sales_order_id, pick_list_id, carrier_id,
         courier_partner, tracking_number, dispatch_ref, package_count, status, direction,
         dispatch_date, expected_delivery, promised_date, weight_kg, freight_cost,
         from_address, to_address, notes, dispatched_by, dispatched_by_name)
      VALUES ($1,'sales_order',$2,$2,$3,$4,$5,$6,$7,$8,'in_transit','outbound',
              CURRENT_DATE,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [cid, pl.sales_order_id, pl.id, carrier_id ?? null, courier ?? null, tracking_number ?? null,
       dispatchRef, pkgs.length, expected_delivery || null,
       so?.promised_date || so?.delivery_date || null, totalWeight, freight_cost ?? null,
       from_address ?? null, to_address ?? null, notes ?? null,
       req.user?.id ?? null, req.user?.name || req.user?.username || null]);

    await client.query(`UPDATE packages SET shipment_id = $2, status = 'shipped' WHERE pick_list_id = $1`,
      [pl.id, shipment.id]);
    await client.query(`UPDATE pick_lists SET status = 'dispatched', completed_at = NOW() WHERE id = $1`, [pl.id]);
    if (pl.sales_order_id) {
      await client.query(
        `UPDATE sales_orders SET order_status = 'dispatched', dispatched_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND LOWER(COALESCE(order_status,'')) NOT IN ('delivered','completed','cancelled')`,
        [pl.sales_order_id]);
    }

    await client.query('COMMIT');
    res.json({ success: true, dispatch_ref: dispatchRef, shipment, packages: pkgs.length });
  } catch (e) {
    await client.query('ROLLBACK'); console.error('[warehouse/dispatch]', e); res.status(500).json({ error: e.message });
  } finally { client.release(); }
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

    // The book quantity is the one this count froze when it was raised, read
    // here from cycle_count_lines and never from the request. It used to be
    // taken from `line.system_qty` in the body — at this pass AND again at the
    // write pass below — which left the caller holding both sides of the
    // subtraction: the one figure a cycle count exists to treat as
    // authoritative. A screen opened an hour before submission also carried a
    // stale book figure, so the adjustment silently absorbed whatever had moved
    // in between.
    //
    // The frozen figure is the right one here rather than a live balance: these
    // lines are BIN-level (system_qty is captured from
    // bin_locations.current_items when the count is raised) while stock_ledger
    // is item x warehouse, so re-deriving from the ledger would compare one
    // bin's count against every bin's stock.
    const { rows: bookLines } = await client.query(
      `SELECT id, item_id, item_name, COALESCE(system_qty, 0) AS system_qty
         FROM cycle_count_lines WHERE header_id = $1`,
      [req.params.id]
    );
    const bookByLineId = new Map(bookLines.map(r => [String(r.id), r]));

    // Pre-flight pass
    const variantLines    = [];
    const unresolvedItems = [];
    const foreignLines    = [];
    const invalidQty      = [];
    const priced          = [];

    for (const line of lines) {
      // A line_id belonging to a different count would otherwise be written by
      // the write pass below, which matched on id alone.
      const book = bookByLineId.get(String(line.line_id));
      if (!book) { foreignLines.push(line.line_id); continue; }

      const counted = parseFloat(line.counted_qty);
      if (!Number.isFinite(counted) || counted < 0) { invalidQty.push(line.line_id); continue; }

      const variance = counted - parseFloat(book.system_qty);
      priced.push({ lineId: book.id, counted, variance });
      if (Math.abs(variance) === 0) continue;

      let itemId = book.item_id ?? null;
      if (!itemId && book.item_name) {
        const { rows: [inv] } = await client.query(
          `SELECT id FROM inventory_items WHERE item_name ILIKE $1 AND deleted_at IS NULL LIMIT 1`,
          [book.item_name]
        );
        itemId = inv?.id ?? null;
      }

      if (!itemId) {
        unresolvedItems.push({ line_id: line.line_id, item_name: book.item_name || '(unknown)', variance });
      } else {
        variantLines.push({ variance, itemId });
      }
    }

    if (foreignLines.length > 0 || invalidQty.length > 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'Cannot apply stock adjustments: some lines do not belong to this cycle count, or carry an invalid counted quantity.',
        foreign_lines: foreignLines,
        invalid_quantities: invalidQty,
      });
    }

    if (unresolvedItems.length > 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'Cannot apply stock adjustments: items below have variances but are not in the item master.',
        unresolved_items: unresolvedItems,
      });
    }

    // Write pass — the variance the pre-flight already computed, not a second
    // recomputation from the request body.
    for (const { lineId, counted, variance } of priced) {
      await client.query(
        `UPDATE cycle_count_lines SET counted_qty=$1, variance=$2, status='counted' WHERE id=$3`,
        [counted, variance, lineId]
      );
    }

    for (const { variance, itemId } of variantLines) {
      const absVariance = Math.abs(variance);
      const isPositive  = variance > 0;

      // Same hand-rolled-vs-shared-helper gap as /inward and pick-list/pick
      // above — this never updated inventory_items.current_stock either.
      await postStock(client, {
        itemId,
        warehouseId,
        inQty: isPositive ? absVariance : 0,
        outQty: isPositive ? 0 : absVariance,
        txnType: 'cycle_count',
        refType: 'cycle_count',
        refId: req.params.id,
        remarks: `Cycle Count #${req.params.id} variance: ${variance > 0 ? '+' : ''}${variance}`,
        createdBy: req.user?.employee_id ?? null,
        companyId: req.scope?.company_id ?? null,
      });
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
router.put('/bins/:id/clear', requirePermission('inventory', 'edit'), captureBefore('bin_locations'), async (req, res) => {
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
router.patch('/inward-qc/:id', requirePermission('inventory', 'edit'), captureBefore('goods_receipt_notes'), async (req, res) => {
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
router.patch('/pick-lists/:id/status', requirePermission('inventory', 'edit'), captureBefore('pick_lists'), async (req, res) => {
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
