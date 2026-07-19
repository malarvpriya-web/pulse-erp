/**
 * assets.routes.js — Unified Asset Management (Manifest OS gap).
 *
 * Assets are fragmented across three unlinked tables:
 *   fixed_assets              — Finance's depreciating fixed assets
 *   assets_register           — Maintenance's serviceable assets
 *   employee_asset_allocations— HR's laptops/SIMs issued to staff
 *
 * This is a READ-ONLY consolidation layer, not a merge: it normalises all three
 * into one register and, where the same physical unit appears in more than one
 * source (matched on serial_number), presents it as a single asset with multiple
 * facets (financial / maintenance / allocation). Nothing is migrated or written,
 * so Finance depreciation and Maintenance logging keep working untouched.
 *
 *   GET /assets/unified                  the merged register (source-tagged, deduped by serial)
 *   GET /assets/unified/:source/:id       lifecycle detail: acquisition→financial→maintenance→allocation→disposal
 *   GET /assets/summary                   dashboard KPIs
 */

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = Router();
const cid = (req) => req.scope?.company_id ?? null;
const perm = (a) => requirePermission('assets', a);

// Normalised UNION across the three silos. $1 = company scope (NULL = all).
const UNIFIED_SQL = `
  SELECT 'finance'::text AS source, id AS ref_id, asset_code AS code, name, category,
         serial_number, status, location, department, purchase_date,
         current_book_value AS value, warranty_expiry, NULL::text AS assigned_to, company_id
    FROM fixed_assets
   WHERE ($1::int IS NULL OR company_id = $1)
  UNION ALL
  SELECT 'maintenance', id, asset_code, name, category,
         serial_number, status, location, department, purchase_date,
         current_value, warranty_expiry, NULL, company_id
    FROM assets_register
   WHERE ($1::int IS NULL OR company_id = $1)
  UNION ALL
  SELECT 'hr', a.id, a.asset_tag, a.asset_name, a.asset_type,
         a.serial_number, a.status, NULL, NULL, a.allocated_date,
         NULL::numeric, NULL::date, COALESCE(e.name, a.employee_id::text), a.company_id
    FROM employee_asset_allocations a
    LEFT JOIN employees e ON e.id = a.employee_id
   WHERE ($1::int IS NULL OR a.company_id = $1)`;

const SOURCE_LABEL = { finance: 'Fixed Asset', maintenance: 'Serviceable', hr: 'Allocated' };

/** Collapse rows sharing a serial_number into one asset with multiple facets. */
function mergeBySerial(rows) {
  const bySerial = new Map();
  const out = [];
  for (const r of rows) {
    const key = r.serial_number ? `sn:${String(r.serial_number).trim().toLowerCase()}` : null;
    const facet = {
      source: r.source, source_label: SOURCE_LABEL[r.source], ref_id: r.ref_id,
      value: r.value != null ? Number(r.value) : null, assigned_to: r.assigned_to,
    };
    if (key && bySerial.has(key)) {
      const a = bySerial.get(key);
      a.facets.push(facet);
      a.sources.push(r.source);
      // prefer the richest non-null field across facets
      a.value = a.value ?? facet.value;
      a.assigned_to = a.assigned_to || r.assigned_to;
      a.warranty_expiry = a.warranty_expiry || r.warranty_expiry;
      continue;
    }
    const asset = {
      key: key || `${r.source}:${r.ref_id}`,
      code: r.code, name: r.name, category: r.category, serial_number: r.serial_number,
      status: r.status, location: r.location, department: r.department,
      purchase_date: r.purchase_date, value: facet.value, warranty_expiry: r.warranty_expiry,
      assigned_to: r.assigned_to, sources: [r.source], facets: [facet],
    };
    out.push(asset);
    if (key) bySerial.set(key, asset);
  }
  return out;
}

// ── GET /assets/unified ───────────────────────────────────────────────────────
router.get('/unified', perm('view'), async (req, res) => {
  try {
    const { source, search, status } = req.query;
    const { rows } = await pool.query(UNIFIED_SQL, [cid(req)]);
    let assets = mergeBySerial(rows);
    if (source) assets = assets.filter((a) => a.sources.includes(source));
    if (status) assets = assets.filter((a) => (a.status || '').toLowerCase() === String(status).toLowerCase());
    if (search) {
      const q = String(search).toLowerCase();
      assets = assets.filter((a) =>
        [a.code, a.name, a.serial_number, a.category].some((v) => v && String(v).toLowerCase().includes(q)));
    }
    assets.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json(assets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /assets/unified/:source/:id ───────────────────────────────────────────
router.get('/unified/:source/:id', perm('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { source, id } = req.params;
    const table = { finance: 'fixed_assets', maintenance: 'assets_register', hr: 'employee_asset_allocations' }[source];
    if (!table) return res.status(400).json({ error: 'invalid source' });

    const base = (await pool.query(
      `SELECT * FROM ${table} WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [id, companyId])).rows[0];
    if (!base) return res.status(404).json({ error: 'asset not found' });
    const serial = base.serial_number || null;

    // Cross-source facets by serial.
    const [fin, maint, alloc] = await Promise.all([
      serial ? pool.query(`SELECT * FROM fixed_assets WHERE serial_number = $1 AND ($2::int IS NULL OR company_id = $2)`, [serial, companyId]) : { rows: [] },
      serial ? pool.query(`SELECT * FROM assets_register WHERE serial_number = $1 AND ($2::int IS NULL OR company_id = $2)`, [serial, companyId]) : { rows: [] },
      serial ? pool.query(`SELECT a.*, e.name AS employee_name FROM employee_asset_allocations a LEFT JOIN employees e ON e.id = a.employee_id WHERE a.serial_number = $1 AND ($2::int IS NULL OR a.company_id = $2)`, [serial, companyId]) : { rows: [] },
    ]);

    const finRow = fin.rows[0] || (source === 'finance' ? base : null);
    const maintRow = maint.rows[0] || (source === 'maintenance' ? base : null);

    // Depreciation + maintenance logs are keyed on the MATCHED source rows, not
    // the primary one — so a finance-primary asset still shows its maintenance
    // history (and vice-versa) when the two are linked by serial.
    const [deprec, mlogs] = await Promise.all([
      pool.query(`SELECT * FROM asset_depreciation_log WHERE asset_id = $1 ORDER BY financial_year`, [finRow?.id ?? -1]),
      pool.query(`SELECT * FROM maintenance_logs WHERE asset_id = $1 ORDER BY COALESCE(start_time, created_at) DESC LIMIT 50`, [maintRow?.id ?? -1]),
    ]);

    // Build a lifecycle timeline from whatever facets exist.
    const timeline = [];
    const pd = base.purchase_date || finRow?.purchase_date || maintRow?.purchase_date;
    if (pd) timeline.push({ phase: 'Acquisition', date: pd, detail: `Purchased${finRow?.vendor ? ` from ${finRow.vendor}` : ''}${(finRow?.purchase_cost || maintRow?.purchase_cost) ? ` · ₹${Number(finRow?.purchase_cost || maintRow?.purchase_cost).toLocaleString('en-IN')}` : ''}` });
    for (const a of alloc.rows) {
      if (a.allocated_date) timeline.push({ phase: 'Assignment', date: a.allocated_date, detail: `Allocated to ${a.employee_name || a.employee_id || 'employee'}` });
      if (a.return_date) timeline.push({ phase: 'Return', date: a.return_date, detail: `Returned to ${a.returned_to || 'store'}` });
    }
    for (const m of mlogs.rows) {
      timeline.push({ phase: 'Maintenance', date: m.start_time || m.created_at, detail: `${m.log_type || 'service'}: ${m.description || m.resolution_notes || '—'}` });
    }
    const st = (base.status || '').toLowerCase();
    if (['disposed', 'retired', 'scrapped'].includes(st)) timeline.push({ phase: 'Disposal', date: base.updated_at || base.created_at, detail: `Status: ${base.status}` });
    timeline.sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({
      source, ref_id: Number(id), serial_number: serial,
      base,
      financial: finRow ? {
        purchase_cost: finRow.purchase_cost, current_book_value: finRow.current_book_value,
        accumulated_depreciation: finRow.accumulated_depreciation, method: finRow.depreciation_method,
        salvage_value: finRow.salvage_value, useful_life_years: finRow.useful_life_years,
        depreciation: deprec.rows,
      } : null,
      maintenance: maintRow ? { current_value: maintRow.current_value, logs: mlogs.rows } : null,
      allocations: alloc.rows,
      timeline,
      facets: {
        has_financial: !!finRow, has_maintenance: !!maintRow, is_allocated: alloc.rows.some((a) => a.status === 'allocated' || !a.return_date),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /assets/summary ───────────────────────────────────────────────────────
router.get('/summary', perm('view'), async (req, res) => {
  try {
    const p = [cid(req)];
    const scope = `($1::int IS NULL OR company_id = $1)`;
    const [fa, ar, hr] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int n, COALESCE(SUM(current_book_value),0)::float book_value,
                         COUNT(*) FILTER (WHERE warranty_expiry IS NOT NULL AND warranty_expiry >= CURRENT_DATE AND warranty_expiry < CURRENT_DATE + INTERVAL '90 days')::int warranty_soon,
                         COUNT(*) FILTER (WHERE LOWER(status) IN ('disposed','retired','scrapped'))::int disposed
                    FROM fixed_assets WHERE ${scope}`, p),
      pool.query(`SELECT COUNT(*)::int n,
                         COUNT(*) FILTER (WHERE LOWER(status) IN ('under_maintenance','maintenance','breakdown'))::int under_maintenance
                    FROM assets_register WHERE ${scope}`, p),
      pool.query(`SELECT COUNT(*) FILTER (WHERE return_date IS NULL)::int allocated FROM employee_asset_allocations WHERE ${scope}`, p),
    ]);
    res.json({
      fixed_assets: fa.rows[0].n, serviceable: ar.rows[0].n, allocated: hr.rows[0].allocated,
      total_book_value: fa.rows[0].book_value,
      under_maintenance: ar.rows[0].under_maintenance,
      warranty_expiring: fa.rows[0].warranty_soon,
      disposed: fa.rows[0].disposed,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
