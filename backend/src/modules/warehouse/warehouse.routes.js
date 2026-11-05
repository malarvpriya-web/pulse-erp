// backend/src/modules/warehouse/warehouse.routes.js
import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { postStock } from '../production/subcontracting.routes.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { companyOf } from '../../shared/scope.js';
import { logAudit } from '../../services/AuditService.js';
import { respondError } from '../../shared/pgErrors.js';
import { WorkflowError, lockPickList, applyPicks, cancelPickList, packPickList, unpackPickList, dispatchPickList, diagnosePickListPostings } from './pickListWorkflow.service.js';

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
    // Bins go into `warehouse_bins`, which requires a tenant. On a genuinely
    // fresh database there may not be one yet — in which case the stores and
    // zones are still seeded and the bins are skipped, rather than a company
    // being invented so an insert can succeed.
    const { rows: [co] } = await pool.query('SELECT id FROM companies ORDER BY id LIMIT 1');
    if (zones.length && co) {
      const zid = zones[0].id;
      for (let row = 1; row <= 3; row++) {
        for (let shelf = 1; shelf <= 4; shelf++) {
          await pool.query(
            `INSERT INTO warehouse_bins
               (company_id, warehouse_id, zone_id, bin_code, row_code, shelf_code, level_code,
                status, current_items)
             VALUES ($1,$2,$3,$4,$5,$6,'1','active','[]'::jsonb)
             ON CONFLICT (company_id, warehouse_id, bin_code) DO NOTHING`,
            [co.id, wh.id, zid, `R${row}-S${shelf}-L1`, `R${row}`, `S${shelf}`]
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

/* ── GET /bins ──
 *
 * Reads `warehouse_bins`, the canonical bin table, after the cutover in
 * 20260916000001. This route used to read `bin_locations`, which had no
 * company_id at all — so `WHERE 1=1` was not sloppiness, it was the only filter
 * available, and every tenant's bins were listed to every caller. The canonical
 * table carries the tenant, so the listing is scoped.
 *
 * `contents` is DERIVED from the lots actually in the bin. `current_items` is
 * the legacy hand-maintained blob, carried across so nothing disappears from
 * the screen, and reported alongside rather than instead of — the same
 * separation current_stock needed before it was derived from the ledger. Where
 * the two disagree, the derived figure is the one with a foreign key behind it.
 */
router.get('/bins', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { zone_id } = req.query;
    const params = [cid];
    let q = `
      SELECT b.id, b.bin_code, b.row_code, b.shelf_code, b.level_code,
             b.zone_id, b.warehouse_id, b.company_id, b.capacity, b.current_qty,
             b.max_weight_kg, b.status, b.item_id, b.current_items,
             b.legacy_bin_location_id,
             -- kept under their old names so existing callers do not break
             b.row_code  AS row_no,
             b.shelf_code AS shelf,
             b.level_code AS level,
             z.name AS zone_name, z.zone_type,
             w.name AS warehouse_name,
             COALESCE((
               SELECT json_agg(json_build_object(
                        'batch_id', ib.id, 'batch_number', ib.batch_number,
                        'item_id', ib.item_id, 'item', i.item_name,
                        'item_code', i.item_code,
                        'qty', ib.quantity_available, 'unit', i.unit_of_measure)
                      ORDER BY ib.received_date NULLS LAST)
                 FROM inventory_batches ib
                 LEFT JOIN inventory_items i ON i.id = ib.item_id
                WHERE ib.bin_id = b.id AND COALESCE(ib.quantity_available,0) > 0
             ), '[]'::json) AS contents
        FROM warehouse_bins b
        LEFT JOIN warehouse_zones z ON z.id = b.zone_id
        LEFT JOIN warehouses w      ON w.id = b.warehouse_id
       WHERE ($1::int IS NULL OR b.company_id = $1)
    `;
    if (zone_id) { params.push(zone_id); q += ` AND b.zone_id = $${params.length}`; }
    q += ' ORDER BY w.name, b.row_code, b.shelf_code, b.bin_code';

    const { rows } = await pool.query(q, params);
    const enriched = rows.map(b => {
      const lots = Array.isArray(b.contents) ? b.contents : [];
      const legacy = Array.isArray(b.current_items) ? b.current_items : [];
      const lotQty = lots.reduce((s, l) => s + (Number(l.qty) || 0), 0);
      const totalQty = lots.length ? lotQty : legacy.reduce((s, i) => s + (Number(i.qty) || 0), 0);
      return {
        ...b,
        item_count: lots.length || legacy.length,
        total_qty: totalQty,
        lot_qty: lotQty,
        contents_source: lots.length ? 'lots' : (legacy.length ? 'legacy_current_items' : 'empty'),
        occupancy: totalQty > 0 ? 'partial' : 'empty',
      };
    });
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /zones ── */
router.get('/zones', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT z.*, w.name as warehouse_name,
        (SELECT COUNT(*) FROM warehouse_bins WHERE zone_id=z.id) as bin_count
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
      `SELECT (SELECT COUNT(*) FROM warehouse_bins      WHERE zone_id = $1)::int AS bins,
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

    // A bin is created empty and filled by a put-away, which is the only path
    // that also writes the lot's location. `warehouse_bins` requires the tenant
    // and the store, both resolved from the zone rather than taken from the
    // request — a bin that names a different company's store is a location that
    // reads as real and is not.
    const { rows: [zoneStore] } = await pool.query(
      `SELECT w.id AS warehouse_id, w.company_id
         FROM warehouse_zones z JOIN warehouses w ON w.id = z.warehouse_id
        WHERE z.id = $1`, [zone_id]);
    if (!zoneStore) return res.status(404).json({ error: 'Zone is not attached to a store' });

    const { rows } = await pool.query(
      `INSERT INTO warehouse_bins
         (company_id, warehouse_id, zone_id, bin_code, row_code, shelf_code, level_code,
          max_weight_kg, status, current_items)
       VALUES ($1, $2, $3, $4, COALESCE($5,'-'), COALESCE($6,'-'), $7, COALESCE($8, 500), 'active', '[]'::jsonb)
       RETURNING *, row_code AS row_no, shelf_code AS shelf, level_code AS level`,
      [
        zoneStore.company_id,
        zoneStore.warehouse_id,
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
router.put('/bins/:id', requirePermission('inventory', 'edit'), captureBefore('warehouse_bins'), async (req, res) => {
  const { bin_code, row_no, shelf, level, max_weight_kg } = req.body;
  if (bin_code !== undefined && !bin_code?.trim()) {
    return res.status(422).json({ error: 'Bin code cannot be blank' });
  }
  try {
    const companyId = companyOf(req);
    const { rows: [bin] } = await pool.query(
      `SELECT b.id, b.company_id
         FROM warehouse_bins b
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
    // Canonical column names. The API keeps the old field names, so the
    // warehouse screen's payload is unchanged by the merge.
    if (row_no   !== undefined) push('row_code',   row_no?.trim() || '-');
    if (shelf    !== undefined) push('shelf_code', shelf?.trim()  || '-');
    if (level    !== undefined) push('level_code', level?.trim()  || null);
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
      `UPDATE warehouse_bins SET ${sets.join(', ')} WHERE id = $${vals.length}
         RETURNING *, row_code AS row_no, shelf_code AS shelf, level_code AS level`,
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
      `SELECT b.id, b.bin_code, b.current_items, b.company_id,
              (SELECT COALESCE(SUM(ib.quantity_available),0)
                 FROM inventory_batches ib WHERE ib.bin_id = b.id) AS lot_qty
         FROM warehouse_bins b
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
    // Both records are consulted: the lots actually assigned to this bin, and
    // the legacy blob carried over by the merge. Either being non-empty blocks
    // the delete — trusting only whichever one happens to be maintained is how
    // the other one's stock gets destroyed.
    const items = Array.isArray(bin.current_items) ? bin.current_items : [];
    const totalQty = items.reduce((s, i) => s + (i.qty || 0), 0) + Number(bin.lot_qty || 0);
    if (totalQty > 0) {
      return res.status(409).json({
        error: 'This bin still holds stock. Move or clear its contents before deleting it.',
      });
    }

    const { rows: [dep] } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM pick_list_lines   WHERE bin_id = $1)::int AS picks,
              (SELECT COUNT(*) FROM cycle_count_lines WHERE bin_id = $1)::int AS counts`,
      [req.params.id]
    );
    if (dep.picks > 0 || dep.counts > 0) {
      return res.status(409).json({
        error: 'This bin appears on a pick list or cycle count and cannot be deleted. Clear it instead.',
      });
    }

    await pool.query('DELETE FROM warehouse_bins WHERE id = $1', [req.params.id]);
    res.json({ success: true, deleted: Number(req.params.id), bin_code: bin.bin_code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /bins/assign ── */
router.post('/bins/assign', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { bin_id, item_name, qty, unit } = req.body;
    const { rows: [bin] } = await pool.query('SELECT * FROM warehouse_bins WHERE id=$1', [bin_id]);
    if (!bin) return res.status(404).json({ error: 'Bin not found' });
    const items = Array.isArray(bin.current_items) ? [...bin.current_items] : [];
    const existing = items.findIndex(i => i.item === item_name);
    if (existing >= 0) {
      items[existing].qty += parseFloat(qty);
    } else {
      items.push({ item: item_name, qty: parseFloat(qty), unit });
    }
    const { rows } = await pool.query(
      'UPDATE warehouse_bins SET current_items=$1 WHERE id=$2 RETURNING *',
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
        `SELECT b.warehouse_id FROM warehouse_bins b
           JOIN warehouse_zones z ON z.id = b.zone_id
         WHERE b.id = $1`, [bin_id]
      );
      warehouseId = loc?.warehouse_id ?? null;
    }

    for (const item of items) {
      if (bin_id) {
        const { rows: [bin] } = await client.query('SELECT current_items FROM warehouse_bins WHERE id=$1', [bin_id]);
        const existing = Array.isArray(bin?.current_items) ? [...bin.current_items] : [];
        const idx = existing.findIndex(i => i.item === item.name);
        if (idx >= 0) { existing[idx].qty += parseFloat(item.qty); }
        else { existing.push({ item: item.name, qty: parseFloat(item.qty), unit: item.unit }); }
        await client.query('UPDATE warehouse_bins SET current_items=$1 WHERE id=$2', [JSON.stringify(existing), bin_id]);
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
/* ── GET /pick-lists/stock-reconciliation ──
   READ-ONLY. Compares each pick list with the stock the ledger attributes to
   it — the evidence for remediating lists over-posted by the pre-2026-10-22
   pick route or cancelled without their stock returned. Writes nothing (runs
   in a READ ONLY transaction); ?all=1 includes the rows that agree. */
router.get('/pick-lists/stock-reconciliation', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    res.json(await diagnosePickListPostings(pool, companyOf(req), { includeOk: req.query.all === '1' }));
  } catch (e) { respondError(res, e); }
});

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

/* ── POST /pick-lists ──
   The sales order, every item and every bin must be the caller's own. They
   used to be taken on trust, so a pick list could name another company's order
   (and pack / dispatch would then stamp that order and its serials) or another
   company's item (and picking it would post that item's stock under this
   company). Header and lines are one transaction: a bad line no longer leaves
   a half-built list behind. */
router.post('/pick-lists', requirePermission('inventory', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { sales_order_id, sales_order_ref, lines = [], notes, priority } = req.body || {};
    const cid = companyOf(req);
    await client.query('BEGIN');
    if (sales_order_id != null && sales_order_id !== '') {
      // FOR SHARE: a concurrent order cancellation (which holds FOR UPDATE)
      // either finishes first — and this sees 'cancelled' — or waits for this
      // list to exist, and then refuses because it does.
      const { rows: [so] } = await client.query(
        `SELECT id, order_status FROM sales_orders WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
          FOR SHARE`,
        [sales_order_id, cid]);
      if (!so) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sales order not found' }); }
      if (String(so.order_status || '').toLowerCase() === 'cancelled') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'A cancelled order cannot be picked.', code: 'ORDER_CANCELLED' });
      }
    }
    for (const line of lines) {
      if (line.item_id != null) {
        const { rows: [it] } = await client.query(
          `SELECT id FROM inventory_items WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
          [line.item_id, cid]);
        if (!it) { await client.query('ROLLBACK'); return res.status(404).json({ error: `Item ${line.item_id} not found` }); }
      }
      if (line.bin_location_id != null) {
        const { rows: [bin] } = await client.query(
          `SELECT id FROM warehouse_bins WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
          [line.bin_location_id, cid]);
        if (!bin) { await client.query('ROLLBACK'); return res.status(404).json({ error: `Bin ${line.bin_location_id} not found` }); }
      }
    }
    const { rows: [pl] } = await client.query(
      `INSERT INTO pick_lists (sales_order_id, sales_order_ref, notes, company_id, priority)
       VALUES ($1,$2,$3,$4,COALESCE($5,'normal')) RETURNING *`,
      [sales_order_id || null, sales_order_ref, notes, cid, priority || null]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO pick_list_lines
           (pick_list_id, item_id, item_name, bin_location_id, bin_code, required_qty,
            batch_id, sales_order_item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [pl.id, line.item_id, line.item_name, line.bin_location_id, line.bin_code, line.required_qty,
         line.batch_id ?? null, line.sales_order_item_id ?? null]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(pl);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    respondError(res, e);
  } finally {
    client.release();
  }
});

/**
 * Run one pick-list workflow step: lock the caller's list, do the step, commit,
 * and only then answer. A WorkflowError is the step refusing (4xx, nothing
 * written); anything else rolls back and is a 500.
 */
async function runPickListStep(req, res, listId, step, { audit = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pl = await lockPickList(client, listId, companyOf(req));
    const result = await step(client, pl);
    await client.query('COMMIT');
    if (audit) {
      logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'inventory', recordId: pl.id,
                 recordType: 'pick_list', action: audit, oldData: pl, newData: result, req,
                 company_id: pl.company_id });
    }
    return { pl, result };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e instanceof WorkflowError) {
      res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.blockers ? { blockers: e.blockers } : {}) });
    } else {
      console.error('[warehouse/pick-list]', e);
      respondError(res, e);
    }
    return null;
  } finally {
    client.release();
  }
}

/* ── PUT /pick-lists/:id/pick ──
   Stock leaves the warehouse HERE, once — packing and dispatch move none. The
   ledger is reconciled to the pick list rather than posted per request (see
   pickListWorkflow.service.js): this used to post the full picked quantity on
   every call while storing picked_qty as an absolute value, so the Warehouse
   screen — which re-submits every line on each Save — deducted (and counted as
   demand) the same units again and again. */
router.put('/pick-lists/:id/pick', requirePermission('inventory', 'edit'), async (req, res) => {
  const { lines = [] } = req.body || {};
  const done = await runPickListStep(req, res, req.params.id,
    (client, pl) => applyPicks(client, pl, lines, req));
  if (done) res.json({ success: true, ...done.result.summary });
});

/* ── POST /pack ── build a package from picked lines ──────────────────────────
   Packing did not exist anywhere in the system: there was no package, pack list
   or carton entity, and the carton_count that dispatch accepted was discarded.
   Recording WHICH LOT went into WHICH CARTON is also the last link in the
   traceability chain — it is what lets a batch be traced to the customer who
   received it. The step itself lives in pickListWorkflow.service.js. */
router.post('/pack', requirePermission('inventory', 'edit'), async (req, res) => {
  const { pick_list_id } = req.body || {};
  if (!pick_list_id) return res.status(400).json({ error: 'pick_list_id is required' });
  const done = await runPickListStep(req, res, pick_list_id,
    (client, pl) => packPickList(client, pl, req.body, req));
  if (!done) return;
  const { rows: pkgLines } = await pool.query(`SELECT * FROM package_lines WHERE package_id = $1`, [done.result.id]);
  // A retry with nothing left to pack created nothing: 200 with the package it already has.
  res.status(done.result.already_packed ? 200 : 201).json({ ...done.result, lines: pkgLines });
});

/* ── POST /pick-lists/:id/unpack ── undo the packs of a packed list ──────────
   Restores each packed serial to the exact state packing recorded and keeps the
   packages as 'unpacked' history; moves no stock. Refused (409, nothing
   written) when that state cannot be restored exactly — see unpackPickList.
   A packed list can only be cancelled after this. */
router.post('/pick-lists/:id/unpack', requirePermission('inventory', 'edit'), async (req, res) => {
  const done = await runPickListStep(req, res, req.params.id,
    (client, pl) => unpackPickList(client, pl, req), { audit: 'unpack' });
  if (done) res.json({ success: true, ...done.result });
});

/* ── POST /dispatch ── pick list → shipment ───────────────────────────────────
   This used to accept courier, tracking_number, carton_count and weight_kg,
   store NONE of them, write no shipment row, and return a DSP-<timestamp>
   reference that was never persisted and could never be looked up again.
   A dispatch now CREATES the shipment, carries the packages onto it, moves the
   order forward, and returns a reference that exists in the database — behind
   the final-inspection gate (pickListWorkflow.service.js). */
router.post('/dispatch', requirePermission('inventory', 'edit'), async (req, res) => {
  const { pick_list_id } = req.body || {};
  if (!pick_list_id) return res.status(400).json({ error: 'pick_list_id is required' });
  const done = await runPickListStep(req, res, pick_list_id,
    (client, pl) => dispatchPickList(client, pl, req.body, req));
  if (done) res.json({ success: true, ...done.result });
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
      `SELECT * FROM warehouse_bins WHERE zone_id = $1`, [zone_id]
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
    // warehouse_bins.current_items when the count is raised) while stock_ledger
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
router.put('/bins/:id/clear', requirePermission('inventory', 'edit'), captureBefore('warehouse_bins'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE warehouse_bins SET current_items = '[]'::jsonb WHERE id = $1 RETURNING *`,
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
/* ── PATCH /pick-lists/:id/status ──
   This wrote any of 'packed' / 'dispatched' / 'cancelled' straight onto the
   row, for any company's list: a list could be dispatched with no shipment and
   no quality gate, packed with no package, or cancelled with its picked stock
   still out. Each status now runs the same workflow step its own route runs:

     packed      the default pack (one package of everything picked) — what the
                 Warehouse screen's "Mark packed" means; already packed = no-op
     dispatched  the full dispatch: quality gate, shipment, order update
     cancelled   returns every unit the list still has out, then cancels;
                 already cancelled = no-op */
router.patch('/pick-lists/:id/status', requirePermission('inventory', 'edit'), async (req, res) => {
  const { status } = req.body || {};
  const valid = ['packed', 'dispatched', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  const step = {
    packed: async (client, pl) => {
      if (String(pl.status).toLowerCase() === 'packed') return { status: 'packed', already: true };
      const pkg = await packPickList(client, pl, {}, req);
      return { status: 'packed', package_id: pkg.id, package_no: pkg.package_no };
    },
    dispatched: (client, pl) => dispatchPickList(client, pl, req.body, req),
    cancelled: (client, pl) => cancelPickList(client, pl, req),
  }[status];
  const done = await runPickListStep(req, res, req.params.id, step, { audit: `status:${status}` });
  if (!done) return;
  const { rows: [row] } = await pool.query(`SELECT * FROM pick_lists WHERE id = $1`, [done.pl.id]);
  res.json({ ...row, workflow: done.result });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT-AWAY
// ─────────────────────────────────────────────────────────────────────────────
/*
 * Receipt created stock in a WAREHOUSE. Nothing recorded moving it to a BIN.
 *
 * That is why `inventory_batches.bin_id` was NULL on every row and why the
 * traceability answer to "where is this lot" stopped at the building: Pulse had
 * a bin master, a bin column on the batch, and no operation that ever wrote one.
 *
 * A put-away task is that operation. Raising it is a decision (which bin);
 * completing it is a movement, so it writes the ledger through the same shared
 * helper every other movement uses rather than touching quantities directly.
 */

/* GET /warehouse/storage-bins — bins in put-away shape.
 *
 * Pulse used to have TWO bin tables: `bin_locations` behind GET /warehouse/bins,
 * and `warehouse_bins`, which `inventory_batches.bin_id`, `stock_ledger`'s bin
 * columns and genealogy all reference. The bins a user could see were therefore
 * not the bins the system stored against, and a put-away had no way to offer a
 * valid destination.
 *
 * They are now one table. `bin_locations` was materialised into
 * `warehouse_bins` by 20260915000017 and retired by 20260916000001, and every
 * reader in this file was repointed in the same change.
 *
 * This route stays because it answers a different question from GET /bins: it
 * lists bins flat, with free capacity and lot counts, which is what choosing a
 * put-away destination needs. GET /bins remains zone-shaped for the warehouse
 * map.
 */
router.get('/storage-bins', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(`
      SELECT b.*, w.name AS warehouse_name, i.item_code, i.item_name,
             (SELECT COUNT(*)::int FROM inventory_batches ib WHERE ib.bin_id = b.id) AS batch_count
        FROM warehouse_bins b
        LEFT JOIN warehouses      w ON w.id = b.warehouse_id
        LEFT JOIN inventory_items i ON i.id = b.item_id
       WHERE ($1::int IS NULL OR b.company_id = $1)
         AND ($2::int IS NULL OR b.warehouse_id = $2)
       ORDER BY w.name, b.row_code, b.shelf_code, b.bin_code`,
      [cid, req.query.warehouse_id ? Number(req.query.warehouse_id) : null]);
    res.json(rows.map(b => ({
      ...b,
      label: [b.row_code, b.shelf_code, b.bin_code].filter(Boolean).join(' / '),
      free_capacity: b.capacity != null ? Number(b.capacity) - Number(b.current_qty || 0) : null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /warehouse/put-away?status= */
router.get('/put-away', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const vals = [cid];
    let where = `($1::int IS NULL OR t.company_id = $1)`;
    if (req.query.status) { vals.push(req.query.status); where += ` AND LOWER(t.status) = LOWER($${vals.length})`; }
    const { rows } = await pool.query(`
      SELECT t.*, i.item_code, i.item_name, b.batch_number,
             w.name AS to_warehouse_name,
             bin.bin_code, bin.row_code, bin.shelf_code
        FROM put_away_tasks t
        LEFT JOIN inventory_items   i   ON i.id = t.item_id
        LEFT JOIN inventory_batches b   ON b.id = t.batch_id
        LEFT JOIN warehouses        w   ON w.id = t.to_warehouse_id
        LEFT JOIN warehouse_bins    bin ON bin.id = t.to_bin_id
       WHERE ${where}
       ORDER BY t.status, t.created_at DESC
       LIMIT 500`, vals);
    res.json({ tasks: rows, open: rows.filter(r => r.status === 'open').length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /warehouse/put-away — raise a task for received stock */
router.post('/put-away', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { batch_id, item_id, quantity, to_warehouse_id, to_bin_id, grn_id, mhe_id, notes } = req.body || {};
    if (!item_id || !quantity) return res.status(400).json({ error: 'item_id and quantity required' });

    // A bin belongs to a warehouse; putting stock in another warehouse's bin is
    // the kind of mistake that makes a location column worse than no column.
    if (to_bin_id) {
      const { rows: [bin] } = await pool.query(
        `SELECT warehouse_id FROM warehouse_bins WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
        [to_bin_id, cid]);
      if (!bin) return res.status(404).json({ error: 'Bin not found' });
      if (to_warehouse_id && Number(bin.warehouse_id) !== Number(to_warehouse_id)) {
        return res.status(422).json({ error: 'Bin does not belong to the destination warehouse' });
      }
    }

    const { rows: [seq] } = await pool.query(
      `SELECT COALESCE(MAX(id),0) + 1 AS n FROM put_away_tasks`);
    const { rows: [row] } = await pool.query(`
      INSERT INTO put_away_tasks
        (company_id, task_no, grn_id, batch_id, item_id, quantity,
         from_warehouse_id, to_warehouse_id, to_bin_id, mhe_id, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11) RETURNING *`,
      [cid, `PA-${String(seq.n).padStart(6, '0')}`, grn_id || null, batch_id || null,
       item_id, quantity, req.body?.from_warehouse_id || null, to_warehouse_id || null,
       to_bin_id || null, mhe_id || null, notes || null]);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /warehouse/put-away/:id/complete — perform the move */
router.post('/put-away/:id/complete', requirePermission('inventory', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const cid = companyOf(req);
    const a = { id: req.user?.userId || req.user?.id || null, name: req.user?.name || req.user?.email || 'System' };
    await client.query('BEGIN');

    const { rows: [task] } = await client.query(
      `SELECT * FROM put_away_tasks WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [req.params.id, cid]);
    if (!task) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Task not found' }); }
    if (task.status === 'done') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Task already completed' }); }

    const binId = req.body?.to_bin_id || task.to_bin_id;
    if (!binId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'to_bin_id required to complete a put-away' }); }

    // The batch is the thing that has a location. Writing it here is what makes
    // "store / location" answerable on the trace.
    if (task.batch_id) {
      await client.query(
        `UPDATE inventory_batches SET bin_id = $2, updated_at = NOW()
          WHERE id = $1 AND ($3::int IS NULL OR company_id = $3)`, [task.batch_id, binId, cid]);
    }
    await client.query(
      `UPDATE warehouse_bins SET current_qty = COALESCE(current_qty,0) + $2, item_id = COALESCE(item_id, $3)
        WHERE id = $1`, [binId, task.quantity, task.item_id]);

    // A put-away moves stock WITHIN a warehouse: the ledger records the bin
    // change, not a quantity change, so total on-hand is untouched. Posting an
    // in and an out here would double the movement history for no gain.
    await client.query(`
      INSERT INTO stock_ledger
        (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, balance_qty,
         reference_type, reference_id, transaction_date, remarks, created_by, company_id,
         batch_id, to_bin_id)
      VALUES ($1,$2,'put_away',0,0,
              COALESCE((SELECT SUM(COALESCE(quantity_in,0) - COALESCE(quantity_out,0))
                          FROM stock_ledger WHERE item_id = $1), 0),
              'put_away_task',$3,CURRENT_DATE,$4,$5,$6,$7,$8)`,
      [task.item_id, task.to_warehouse_id, task.id,
       `Put away ${task.quantity} to bin ${binId}`, req.user?.employee_id ?? null, cid,
       task.batch_id || null, binId]);

    const { rows: [done] } = await client.query(`
      UPDATE put_away_tasks
         SET status = 'done', to_bin_id = $2, completed_at = NOW(),
             put_away_by = $3, put_away_by_name = $4
       WHERE id = $1 RETURNING *`, [task.id, binId, a.id, a.name]);

    // Releasing the equipment is part of finishing the job, not a separate
    // chore someone has to remember.
    if (task.mhe_id) {
      await client.query(
        `UPDATE mhe_equipment SET status = 'available' WHERE id = $1`,
        [task.mhe_id]).catch(() => {});
    }

    await client.query('COMMIT');
    res.json({ success: true, task: done });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

export default router;
