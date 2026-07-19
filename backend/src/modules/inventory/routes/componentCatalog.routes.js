/**
 * componentCatalog.routes.js  (mounted at /inventory/catalog)
 *
 * Component enrichment endpoints:
 *   - Category master CRUD            /categories
 *   - Per-component vendor price book /items/:itemId/vendor-prices , /vendor-prices/:id
 *   - Vendor price-comparison board   /vendor-price-comparison
 *
 * All queries are company-scoped via req.scope.company_id (NULL-scope = see all).
 */
import express from 'express';
import pool from '../../shared/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';

const router = express.Router();

const scopeOf = (req) => req.scope?.company_id ?? null;

// Append `AND <col> = $n` when the request is company-scoped; superadmin (NULL)
// still sees legacy NULL-company rows.
function scopeClause(params, companyId, col) {
  if (companyId == null) return '';
  params.push(companyId);
  return ` AND (${col} = $${params.length} OR ${col} IS NULL)`;
}

// =====================================================
// CATEGORY MASTER
// =====================================================
router.get('/categories', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const params = [];
    let where = 'WHERE c.deleted_at IS NULL';
    where += scopeClause(params, scopeOf(req), 'c.company_id');
    if (req.query.active_only === 'true') where += ' AND c.is_active = TRUE';
    const { rows } = await pool.query(
      `SELECT c.*, p.name AS parent_name,
              (SELECT COUNT(*)::int FROM inventory_items ii
                WHERE ii.category_id = c.id AND ii.deleted_at IS NULL) AS item_count
         FROM item_categories c
         LEFT JOIN item_categories p ON p.id = c.parent_id
         ${where}
         ORDER BY c.name`,
      params
    );
    res.json({ categories: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/categories', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const { name, category_code, parent_id, description } = req.body;
    if (!name || !String(name).trim()) return res.status(422).json({ error: 'Category name is required' });
    const { rows } = await pool.query(
      `INSERT INTO item_categories (name, category_code, parent_id, description, company_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(name).trim(), category_code || null, parent_id || null, description || null, scopeOf(req)]
    );
    logAudit({ userId: req.user?.userId, module: 'inventory', recordId: rows[0].id, recordType: 'item_category', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A category with this name already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/categories/:id', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const { name, category_code, parent_id, description, is_active } = req.body;
    const params = [name ?? null, category_code ?? null, parent_id || null, description ?? null, is_active ?? true, req.params.id];
    let where = 'WHERE id = $6 AND deleted_at IS NULL';
    where += scopeClause(params, scopeOf(req), 'company_id');
    const { rows } = await pool.query(
      `UPDATE item_categories
          SET name = COALESCE($1, name), category_code = $2, parent_id = $3,
              description = $4, is_active = $5, updated_at = NOW()
        ${where} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Category not found' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A category with this name already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/categories/:id', requirePermission('inventory', 'delete'), async (req, res) => {
  try {
    const params = [req.params.id];
    let where = 'WHERE id = $1 AND deleted_at IS NULL';
    where += scopeClause(params, scopeOf(req), 'company_id');
    const { rows } = await pool.query(
      `UPDATE item_categories SET deleted_at = NOW() ${where} RETURNING id`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Category not found' });
    // Detach the components (FK is ON DELETE SET NULL for hard delete; do it explicitly on soft delete)
    await pool.query(`UPDATE inventory_items SET category_id = NULL WHERE category_id = $1`, [req.params.id]);
    res.json({ message: 'Category deleted', id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================
// VENDOR PRICE BOOK  (component × vendor × store)
// =====================================================
const PRICE_SELECT = `
  SELECT ivp.*,
         v.vendor_name,
         v.quality_rating, v.delivery_rating, v.price_rating, v.on_time_pct,
         w.warehouse_name, w.department AS store_department,
         (ivp.unit_price * (1 - COALESCE(ivp.discount_pct,0)/100.0)) AS net_price
    FROM item_vendor_prices ivp
    JOIN vendors v     ON v.id = ivp.vendor_id
    LEFT JOIN warehouses w ON w.id = ivp.warehouse_id`;

router.get('/items/:itemId/vendor-prices', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const params = [req.params.itemId];
    let where = 'WHERE ivp.item_id = $1 AND ivp.deleted_at IS NULL';
    if (req.query.warehouse_id) {
      params.push(req.query.warehouse_id);
      where += ` AND (ivp.warehouse_id = $${params.length} OR ivp.warehouse_id IS NULL)`;
    }
    const { rows } = await pool.query(
      `${PRICE_SELECT} ${where} ORDER BY net_price ASC NULLS LAST, v.vendor_name`,
      params
    );
    res.json({ prices: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/items/:itemId/vendor-prices', requirePermission('inventory', 'add'), async (req, res) => {
  try {
    const b = req.body;
    if (!b.vendor_id) return res.status(422).json({ error: 'Vendor is required' });
    const { rows } = await pool.query(
      `INSERT INTO item_vendor_prices
         (item_id, vendor_id, warehouse_id, unit_price, currency, moq, pack_size,
          discount_pct, tax_pct, lead_time_days, vendor_sku, last_quoted_date,
          valid_until, is_preferred, notes, company_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        req.params.itemId, b.vendor_id, b.warehouse_id || null,
        b.unit_price ?? 0, b.currency || 'INR', b.moq ?? 0, b.pack_size || null,
        b.discount_pct ?? 0, b.tax_pct ?? 0, b.lead_time_days || null,
        b.vendor_sku || null, b.last_quoted_date || null, b.valid_until || null,
        !!b.is_preferred, b.notes || null, scopeOf(req), req.user?.userId ?? null,
      ]
    );
    if (rows[0].is_preferred) await clearOtherPreferred(rows[0]);
    logAudit({ userId: req.user?.userId, module: 'inventory', recordId: rows[0].id, recordType: 'item_vendor_price', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'This vendor already has a price for this component + store' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/vendor-prices/:id', requirePermission('inventory', 'edit'), async (req, res) => {
  try {
    const b = req.body;
    const { rows } = await pool.query(
      `UPDATE item_vendor_prices SET
          vendor_id        = COALESCE($1, vendor_id),
          warehouse_id     = $2,
          unit_price       = COALESCE($3, unit_price),
          currency         = COALESCE($4, currency),
          moq              = COALESCE($5, moq),
          pack_size        = $6,
          discount_pct     = COALESCE($7, discount_pct),
          tax_pct          = COALESCE($8, tax_pct),
          lead_time_days   = $9,
          vendor_sku       = $10,
          last_quoted_date = $11,
          valid_until      = $12,
          is_preferred     = COALESCE($13, is_preferred),
          notes            = $14,
          updated_at       = NOW()
        WHERE id = $15 AND deleted_at IS NULL
        RETURNING *`,
      [
        b.vendor_id || null, b.warehouse_id || null, b.unit_price ?? null,
        b.currency || null, b.moq ?? null, b.pack_size || null,
        b.discount_pct ?? null, b.tax_pct ?? null, b.lead_time_days || null,
        b.vendor_sku || null, b.last_quoted_date || null, b.valid_until || null,
        b.is_preferred ?? null, b.notes || null, req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Price row not found' });
    if (rows[0].is_preferred) await clearOtherPreferred(rows[0]);
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'This vendor already has a price for this component + store' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/vendor-prices/:id', requirePermission('inventory', 'delete'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE item_vendor_prices SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Price row not found' });
    res.json({ message: 'Price removed', id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Only one preferred vendor per (item, store).
async function clearOtherPreferred(row) {
  await pool.query(
    `UPDATE item_vendor_prices
        SET is_preferred = FALSE
      WHERE item_id = $1
        AND COALESCE(warehouse_id, 0) = COALESCE($2, 0)
        AND id <> $3
        AND deleted_at IS NULL`,
    [row.item_id, row.warehouse_id, row.id]
  );
}

// =====================================================
// VENDOR PRICE-COMPARISON DASHBOARD
//   GET /vendor-price-comparison?warehouse_id=&category_id=&abc_class=&search=
// =====================================================
router.get('/vendor-price-comparison', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = scopeOf(req);
    const { warehouse_id, category_id, abc_class, search } = req.query;

    const params = [];
    let itemWhere = 'WHERE ii.deleted_at IS NULL';
    itemWhere += scopeClause(params, companyId, 'ii.company_id');
    if (category_id) { params.push(category_id); itemWhere += ` AND ii.category_id = $${params.length}`; }
    if (abc_class)   { params.push(String(abc_class).toUpperCase()); itemWhere += ` AND ii.abc_class = $${params.length}`; }
    if (search)      { params.push(`%${search}%`); itemWhere += ` AND (ii.item_name ILIKE $${params.length} OR ii.item_code ILIKE $${params.length})`; }

    // Store filter applied to the price rows: a store-specific quote OR an
    // "all stores" (NULL warehouse) quote both count for a selected store.
    let priceJoinCond = 'ivp.item_id = ii.id AND ivp.deleted_at IS NULL';
    if (warehouse_id) {
      params.push(warehouse_id);
      priceJoinCond += ` AND (ivp.warehouse_id = $${params.length} OR ivp.warehouse_id IS NULL)`;
    }

    const netPrice = 'ivp.unit_price * (1 - COALESCE(ivp.discount_pct,0)/100.0)';

    const { rows } = await pool.query(
      `
      SELECT
        ii.id            AS item_id,
        ii.item_code,
        ii.item_name,
        ii.unit_of_measure,
        ii.abc_class,
        ii.standard_cost,
        c.name           AS category_name,
        COUNT(ivp.id)::int                             AS vendor_count,
        MIN(${netPrice})                               AS best_price,
        MAX(${netPrice})                               AS highest_price,
        AVG(${netPrice})                               AS avg_price,
        MIN(${netPrice}) FILTER (WHERE ivp.is_preferred) AS preferred_price
      FROM inventory_items ii
      LEFT JOIN item_categories c ON c.id = ii.category_id AND c.deleted_at IS NULL
      LEFT JOIN item_vendor_prices ivp ON ${priceJoinCond}
      ${itemWhere}
      GROUP BY ii.id, ii.item_code, ii.item_name, ii.unit_of_measure, ii.abc_class, ii.standard_cost, c.name
      ORDER BY ii.item_code
      `,
      params
    );

    // Best-price vendor name per item (separate lightweight pass keeps the group-by
    // simple). Reuse the exact item filters + the store-scoped price join as WHERE
    // clauses — same $-params, same order — so no rebinding is needed.
    const bestVendors = await pool.query(
      `
      SELECT DISTINCT ON (ivp.item_id)
             ivp.item_id, v.vendor_name, (${netPrice}) AS net_price
        FROM item_vendor_prices ivp
        JOIN vendors v ON v.id = ivp.vendor_id
        JOIN inventory_items ii ON ii.id = ivp.item_id
        LEFT JOIN item_categories c ON c.id = ii.category_id AND c.deleted_at IS NULL
        ${itemWhere} AND ${priceJoinCond}
       ORDER BY ivp.item_id, net_price ASC
      `,
      [...params]
    ).catch(() => ({ rows: [] }));
    const bestVendorMap = Object.fromEntries(bestVendors.rows.map(r => [r.item_id, r.vendor_name]));

    const items = rows.map(r => {
      const best = r.best_price != null ? parseFloat(r.best_price) : null;
      const high = r.highest_price != null ? parseFloat(r.highest_price) : null;
      const pref = r.preferred_price != null ? parseFloat(r.preferred_price) : null;
      const spread = best != null && high != null ? +(high - best).toFixed(2) : null;
      const spread_pct = best ? +(((high - best) / best) * 100).toFixed(1) : null;
      // Savings if we switch the preferred vendor down to the cheapest quote.
      const savings_vs_preferred = pref != null && best != null ? +(pref - best).toFixed(2) : null;
      return {
        ...r,
        best_price: best,
        highest_price: high,
        avg_price: r.avg_price != null ? +parseFloat(r.avg_price).toFixed(2) : null,
        preferred_price: pref,
        best_vendor: bestVendorMap[r.item_id] || null,
        spread,
        spread_pct,
        savings_vs_preferred,
      };
    });

    // ── Summary KPIs & breakdowns ──
    const priced = items.filter(i => i.vendor_count > 0);
    const summary = {
      total_components: items.length,
      priced_components: priced.length,
      unpriced_components: items.length - priced.length,
      total_vendor_quotes: items.reduce((s, i) => s + i.vendor_count, 0),
      multi_vendor_components: priced.filter(i => i.vendor_count > 1).length,
      total_potential_savings: +priced.reduce((s, i) => s + Math.max(0, i.savings_vs_preferred || 0), 0).toFixed(2),
      avg_spread_pct: priced.length
        ? +(priced.reduce((s, i) => s + (i.spread_pct || 0), 0) / priced.length).toFixed(1)
        : 0,
    };

    const byAbc = { A: 0, B: 0, C: 0, Unclassified: 0 };
    for (const i of items) byAbc[i.abc_class || 'Unclassified'] = (byAbc[i.abc_class || 'Unclassified'] || 0) + 1;

    const byCategory = {};
    for (const i of items) {
      const k = i.category_name || 'Uncategorized';
      byCategory[k] = byCategory[k] || { category: k, components: 0, vendor_quotes: 0, potential_savings: 0 };
      byCategory[k].components += 1;
      byCategory[k].vendor_quotes += i.vendor_count;
      byCategory[k].potential_savings += Math.max(0, i.savings_vs_preferred || 0);
    }

    res.json({
      summary,
      by_abc: byAbc,
      by_category: Object.values(byCategory)
        .map(c => ({ ...c, potential_savings: +c.potential_savings.toFixed(2) }))
        .sort((a, b) => b.components - a.components),
      items,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
