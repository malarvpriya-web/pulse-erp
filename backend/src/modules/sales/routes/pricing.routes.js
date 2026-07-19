// backend/src/modules/sales/routes/pricing.routes.js
import { Router } from 'express';
import pool from '../../../config/db.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf } from '../../../shared/scope.js';

const router = Router();

// ── Price Lists ──────────────────────────────────────────────────────────────

// GET /price-lists/stats
router.get('/price-lists/stats', async (req, res) => {
  const cid = companyOf(req);
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*)::int                                                         AS total,
         COUNT(*) FILTER (WHERE is_active = true)::int                        AS active,
         (SELECT name FROM price_lists WHERE company_id=$1 AND is_default=true LIMIT 1) AS default_name
       FROM price_lists
       WHERE company_id = $1`,
      [cid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /price-lists
router.get('/price-lists', async (req, res) => {
  const cid = companyOf(req);
  try {
    const result = await pool.query(
      `SELECT pl.*, COUNT(pli.id)::int AS item_count
       FROM price_lists pl
       LEFT JOIN price_list_items pli ON pli.price_list_id = pl.id
       WHERE pl.company_id = $1
       GROUP BY pl.id
       ORDER BY pl.is_default DESC, pl.name`,
      [cid]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /price-lists
router.post('/price-lists', async (req, res) => {
  const cid = companyOf(req);
  const uid = req.user?.userId ?? req.user?.id;
  try {
    const { name, currency, applicable_to, customer_ids, valid_from, valid_to, is_default } = req.body;
    if (is_default) {
      await pool.query(`UPDATE price_lists SET is_default = false WHERE company_id = $1 AND is_default = true`, [cid]);
    }
    const result = await pool.query(
      `INSERT INTO price_lists (company_id, name, currency, applicable_to, customer_ids, valid_from, valid_to, is_default, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [cid, name, currency || 'INR', applicable_to || 'all', JSON.stringify(customer_ids || []), valid_from || null, valid_to || null, is_default || false, uid || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /price-lists/:id
router.put('/price-lists/:id', async (req, res) => {
  const cid = companyOf(req);
  try {
    const { id } = req.params;
    const { name, currency, applicable_to, customer_ids, valid_from, valid_to, is_default, is_active } = req.body;
    if (is_default) {
      await pool.query(`UPDATE price_lists SET is_default = false WHERE company_id = $1 AND id != $2`, [cid, id]);
    }
    const result = await pool.query(
      `UPDATE price_lists
       SET name=COALESCE($1,name), currency=COALESCE($2,currency),
           applicable_to=COALESCE($3,applicable_to),
           customer_ids=COALESCE($4,customer_ids),
           valid_from=COALESCE($5,valid_from), valid_to=COALESCE($6,valid_to),
           is_default=COALESCE($7,is_default), is_active=COALESCE($8,is_active)
       WHERE id=$9 AND company_id=$10 RETURNING *`,
      [name, currency, applicable_to,
       customer_ids != null ? JSON.stringify(customer_ids) : null,
       valid_from || null, valid_to || null, is_default, is_active, id, cid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /price-lists/:id
router.delete('/price-lists/:id', async (req, res) => {
  const cid = companyOf(req);
  try {
    await pool.query(`DELETE FROM price_lists WHERE id=$1 AND company_id=$2`, [req.params.id, cid]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /price-lists/:id/items
router.get('/price-lists/:id/items', async (req, res) => {
  const cid = companyOf(req);
  try {
    const { id } = req.params;
    // verify ownership before returning items
    const owns = await pool.query(`SELECT 1 FROM price_lists WHERE id=$1 AND company_id=$2`, [id, cid]);
    if (!owns.rows.length) return res.status(404).json({ error: 'Not found' });
    const result = await pool.query(`SELECT * FROM price_list_items WHERE price_list_id=$1 ORDER BY id`, [id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /price-lists/:id/items
router.post('/price-lists/:id/items', async (req, res) => {
  const cid = companyOf(req);
  const changedBy = req.user?.name || req.user?.email || 'system';
  try {
    const { id } = req.params;
    const owns = await pool.query(`SELECT 1 FROM price_lists WHERE id=$1 AND company_id=$2`, [id, cid]);
    if (!owns.rows.length) return res.status(404).json({ error: 'Not found' });

    const items = req.body;
    const existing = await pool.query(
      `SELECT item_id, base_price, original_price FROM price_list_items WHERE price_list_id = $1`,
      [id]
    );
    const prevMap = {};
    for (const row of existing.rows) prevMap[row.item_id] = row;

    await pool.query(`DELETE FROM price_list_items WHERE price_list_id = $1`, [id]);

    const inserted = [];
    for (const item of items) {
      if (!item.item_id) continue;
      const prev = prevMap[item.item_id];
      const originalPrice = prev
        ? (parseFloat(prev.original_price) || parseFloat(prev.base_price))
        : parseFloat(item.base_price);

      const r = await pool.query(
        `INSERT INTO price_list_items (price_list_id, item_id, item_name, base_price, min_price, uom, original_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, item.item_id, item.item_name, item.base_price, item.min_price, item.uom || 'Nos', originalPrice]
      );
      inserted.push(r.rows[0]);

      const oldPrice = prev ? parseFloat(prev.base_price) : null;
      const newPrice = parseFloat(item.base_price);
      if (oldPrice !== null && oldPrice !== newPrice) {
        await pool.query(
          `INSERT INTO price_change_log (company_id, price_list_id, item_id, item_name, old_price, new_price, changed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [cid, id, item.item_id, item.item_name, oldPrice, newPrice, changedBy]
        ).catch(() => null);
      }
    }
    res.json(inserted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Compute ──────────────────────────────────────────────────────────────────

// GET /compute
router.get('/compute', async (req, res) => {
  const cid = companyOf(req);
  try {
    const { customer_id, items: itemsParam } = req.query;
    const items = itemsParam ? JSON.parse(itemsParam) : [];

    let priceListId = null;
    if (customer_id) {
      const specific = await pool.query(
        `SELECT id FROM price_lists WHERE company_id=$1 AND is_active=true AND customer_ids @> $2::jsonb ORDER BY id LIMIT 1`,
        [cid, JSON.stringify([parseInt(customer_id)])]
      );
      if (specific.rows.length > 0) priceListId = specific.rows[0].id;
    }
    if (!priceListId) {
      const def = await pool.query(
        `SELECT id FROM price_lists WHERE company_id=$1 AND is_default=true AND is_active=true LIMIT 1`,
        [cid]
      );
      if (def.rows.length > 0) priceListId = def.rows[0].id;
    }

    const today = new Date().toISOString().split('T')[0];
    const discountRules = await pool.query(
      `SELECT * FROM discount_rules WHERE company_id=$1 AND is_active=true
       AND (valid_from IS NULL OR valid_from <= $2) AND (valid_to IS NULL OR valid_to >= $2)`,
      [cid, today]
    );
    const activePromos = await pool.query(
      `SELECT * FROM promotions WHERE company_id=$1 AND is_active=true
       AND (valid_from IS NULL OR valid_from <= $2) AND (valid_to IS NULL OR valid_to >= $2)`,
      [cid, today]
    );

    const lines = [];
    let subtotal = 0;
    let totalDiscount = 0;
    const appliedPromotions = [];

    for (const item of items) {
      let unitPrice = 0;
      let itemName = item.item_id;

      if (priceListId) {
        const pli = await pool.query(
          `SELECT * FROM price_list_items WHERE price_list_id=$1 AND item_id=$2 LIMIT 1`,
          [priceListId, item.item_id]
        );
        if (pli.rows.length > 0) {
          unitPrice = parseFloat(pli.rows[0].base_price);
          itemName = pli.rows[0].item_name;
        }
      }

      const lineValue = unitPrice * item.qty;
      let discountPct = 0;

      for (const rule of discountRules.rows) {
        if (lineValue >= parseFloat(rule.min_order_value) && item.qty >= rule.min_quantity) {
          if (rule.type === 'percentage') {
            discountPct = Math.max(discountPct, parseFloat(rule.discount_value));
          } else if (rule.type === 'tiered' && rule.tiered_slabs && rule.tiered_slabs.length > 0) {
            for (const slab of rule.tiered_slabs) {
              if (item.qty >= slab.min_qty && (!slab.max_qty || item.qty <= slab.max_qty)) {
                discountPct = Math.max(discountPct, parseFloat(slab.discount_pct));
              }
            }
          }
        }
      }

      for (const promo of activePromos.rows) {
        if (promo.type === 'seasonal' || promo.type === 'bogo') {
          discountPct = Math.max(discountPct, parseFloat(promo.discount_value || 0));
          if (!appliedPromotions.find(p => p.id === promo.id)) {
            appliedPromotions.push({ id: promo.id, name: promo.name, type: promo.type });
          }
        }
      }

      const discountAmount = (lineValue * discountPct) / 100;
      const finalPrice = unitPrice * (1 - discountPct / 100);
      const lineTotal = lineValue - discountAmount;

      subtotal += lineValue;
      totalDiscount += discountAmount;

      lines.push({ item_id: item.item_id, item_name: itemName, qty: item.qty, unit_price: unitPrice, discount_pct: discountPct, discount_amount: discountAmount, final_price: finalPrice, line_total: lineTotal });
    }

    const grandTotal = subtotal - totalDiscount;
    const savingsPct = subtotal > 0 ? ((totalDiscount / subtotal) * 100).toFixed(2) : 0;
    res.json({ lines, subtotal, total_discount: totalDiscount, grand_total: grandTotal, savings_pct: parseFloat(savingsPct), applied_promotions: appliedPromotions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Discount Rules ───────────────────────────────────────────────────────────

// GET /discount-rules
router.get('/discount-rules', async (req, res) => {
  const cid = companyOf(req);
  try {
    const result = await pool.query(
      `SELECT * FROM discount_rules WHERE company_id=$1 ORDER BY created_at DESC`,
      [cid]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /discount-rules
router.post('/discount-rules', async (req, res) => {
  const cid = companyOf(req);
  const uid = req.user?.userId ?? req.user?.id;
  try {
    const { name, type, applies_to, min_order_value, min_quantity, discount_value, tiered_slabs, valid_from, valid_to, requires_approval, approval_threshold_pct } = req.body;
    const result = await pool.query(
      `INSERT INTO discount_rules (company_id, name, type, applies_to, min_order_value, min_quantity, discount_value, tiered_slabs, valid_from, valid_to, requires_approval, approval_threshold_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [cid, name, type || 'percentage', applies_to || 'all', min_order_value || 0, min_quantity || 1, discount_value, JSON.stringify(tiered_slabs || []), valid_from || null, valid_to || null, requires_approval || false, approval_threshold_pct || 10]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /discount-rules/:id
router.put('/discount-rules/:id', async (req, res) => {
  const cid = companyOf(req);
  try {
    const { id } = req.params;
    const { name, type, applies_to, min_order_value, min_quantity, discount_value, tiered_slabs, valid_from, valid_to, requires_approval, approval_threshold_pct, is_active } = req.body;
    const result = await pool.query(
      `UPDATE discount_rules
       SET name=COALESCE($1,name), type=COALESCE($2,type), applies_to=COALESCE($3,applies_to),
           min_order_value=COALESCE($4,min_order_value), min_quantity=COALESCE($5,min_quantity),
           discount_value=COALESCE($6,discount_value),
           tiered_slabs=COALESCE($7,tiered_slabs), valid_from=COALESCE($8,valid_from),
           valid_to=COALESCE($9,valid_to), requires_approval=COALESCE($10,requires_approval),
           approval_threshold_pct=COALESCE($11,approval_threshold_pct), is_active=COALESCE($12,is_active)
       WHERE id=$13 AND company_id=$14 RETURNING *`,
      [name, type, applies_to, min_order_value, min_quantity, discount_value,
       tiered_slabs != null ? JSON.stringify(tiered_slabs) : null,
       valid_from || null, valid_to || null, requires_approval, approval_threshold_pct, is_active, id, cid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /discount-rules/:id
router.delete('/discount-rules/:id', async (req, res) => {
  const cid = companyOf(req);
  try {
    await pool.query(`UPDATE discount_rules SET is_active=false WHERE id=$1 AND company_id=$2`, [req.params.id, cid]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Discount Approvals ───────────────────────────────────────────────────────

// POST /discount-rules/request-approval
router.post('/discount-rules/request-approval', async (req, res) => {
  const cid = companyOf(req);
  try {
    const { discount_rule_id, lead_id, order_id, requested_discount_pct, requested_by, order_value } = req.body;
    const result = await pool.query(
      `INSERT INTO discount_approvals (company_id, discount_rule_id, lead_id, order_id, requested_discount_pct, requested_by, status, order_value)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING *`,
      [cid, discount_rule_id, lead_id, order_id, requested_discount_pct, requested_by, order_value || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /discount-approvals
router.get('/discount-approvals', async (req, res) => {
  const cid = companyOf(req);
  try {
    const result = await pool.query(
      `SELECT da.*, dr.name AS rule_name, dr.discount_value AS rule_discount_value
       FROM discount_approvals da
       LEFT JOIN discount_rules dr ON dr.id = da.discount_rule_id
       WHERE da.company_id = $1
       ORDER BY da.requested_at DESC`,
      [cid]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /discount-approvals/:id
router.put('/discount-approvals/:id', async (req, res) => {
  const cid = companyOf(req);
  try {
    const { id } = req.params;
    const { status, reason, approved_by } = req.body;
    const result = await pool.query(
      `UPDATE discount_approvals
       SET status=$1, reason=$2, approved_by=$3,
           approved_at=CASE WHEN $1='approved' THEN NOW() ELSE approved_at END
       WHERE id=$4 AND company_id=$5 RETURNING *`,
      [status, reason, approved_by, id, cid]
    );
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Sales', recordId: id, recordType: 'discount_approval', action: 'approve', newData: result.rows[0], req });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Promotions ───────────────────────────────────────────────────────────────

// GET /promotions
router.get('/promotions', async (req, res) => {
  const cid = companyOf(req);
  try {
    const result = await pool.query(
      `SELECT * FROM promotions WHERE company_id=$1 ORDER BY created_at DESC`,
      [cid]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /promotions
router.post('/promotions', async (req, res) => {
  const cid = companyOf(req);
  try {
    const { name, type, conditions, discount_value, valid_from, valid_to, max_usage } = req.body;
    const result = await pool.query(
      `INSERT INTO promotions (company_id, name, type, conditions, discount_value, valid_from, valid_to, max_usage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cid, name, type, JSON.stringify(conditions || {}), discount_value, valid_from || null, valid_to || null, max_usage || 1000]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /promotions/:id
router.put('/promotions/:id', async (req, res) => {
  const cid = companyOf(req);
  try {
    const { id } = req.params;
    const { name, type, conditions, discount_value, valid_from, valid_to, max_usage, is_active } = req.body;
    const result = await pool.query(
      `UPDATE promotions
       SET name=COALESCE($1,name), type=COALESCE($2,type),
           conditions=COALESCE($3,conditions), discount_value=COALESCE($4,discount_value),
           valid_from=COALESCE($5,valid_from), valid_to=COALESCE($6,valid_to),
           max_usage=COALESCE($7,max_usage), is_active=COALESCE($8,is_active)
       WHERE id=$9 AND company_id=$10 RETURNING *`,
      [name, type, conditions != null ? JSON.stringify(conditions) : null,
       discount_value, valid_from || null, valid_to || null, max_usage, is_active, id, cid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /promotions/:id
router.delete('/promotions/:id', async (req, res) => {
  const cid = companyOf(req);
  try {
    await pool.query(`UPDATE promotions SET is_active=false WHERE id=$1 AND company_id=$2`, [req.params.id, cid]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Analytics ────────────────────────────────────────────────────────────────

// GET /analytics
router.get('/analytics', async (req, res) => {
  const cid = companyOf(req);
  try {
    const [pendingR, approvedR, totalR, avgDiscR, topItemsR, monthlyR] = await Promise.allSettled([
      pool.query(`SELECT COUNT(*)::int AS cnt FROM discount_approvals WHERE company_id=$1 AND status='pending'`, [cid]),
      pool.query(`SELECT COUNT(*)::int AS cnt FROM discount_approvals WHERE company_id=$1 AND status='approved'`, [cid]),
      pool.query(`SELECT COUNT(*)::int AS cnt FROM discount_approvals WHERE company_id=$1`, [cid]),
      pool.query(`SELECT ROUND(COALESCE(AVG(requested_discount_pct),0)::numeric,1) AS avg_pct FROM discount_approvals WHERE company_id=$1 AND status='approved'`, [cid]),
      pool.query(`
        SELECT item_name,
               ROUND(ABS(AVG((new_price - old_price) / NULLIF(old_price,0)) * 100)::numeric, 1) AS avg_discount_pct,
               COUNT(*)::int AS count
        FROM price_change_log WHERE company_id=$1
        GROUP BY item_name
        ORDER BY count DESC, avg_discount_pct DESC LIMIT 5`, [cid]),
      pool.query(`
        SELECT COALESCE(SUM(COALESCE(order_value,0) * requested_discount_pct / 100), 0)::numeric AS impact
        FROM discount_approvals
        WHERE company_id=$1 AND DATE_TRUNC('month', requested_at) = DATE_TRUNC('month', NOW())`, [cid])
    ]);

    const pending       = pendingR.status   === 'fulfilled' ? pendingR.value.rows[0].cnt              : 0;
    const approved      = approvedR.status  === 'fulfilled' ? approvedR.value.rows[0].cnt             : 0;
    const total         = totalR.status     === 'fulfilled' ? totalR.value.rows[0].cnt                : 0;
    const avgDiscount   = avgDiscR.status   === 'fulfilled' ? parseFloat(avgDiscR.value.rows[0].avg_pct) || 0 : 0;
    const topItems      = topItemsR.status  === 'fulfilled' ? topItemsR.value.rows                    : [];
    const monthlyImpact = monthlyR.status   === 'fulfilled' ? parseFloat(monthlyR.value.rows[0].impact) || 0  : 0;
    const approvalRate  = total > 0 ? Math.round((approved / total) * 100) : 0;

    res.json({ avg_discount_pct: avgDiscount, pending_approvals: pending, monthly_discount_impact: monthlyImpact, top_discounted_items: topItems, approval_rate: approvalRate });
  } catch (err) {
    res.json({ avg_discount_pct: 0, pending_approvals: 0, monthly_discount_impact: 0, top_discounted_items: [], approval_rate: 0 });
  }
});

// ── Price Change Log ─────────────────────────────────────────────────────────

// GET /price-change-log
router.get('/price-change-log', async (req, res) => {
  const cid = companyOf(req);
  try {
    const { price_list_id } = req.query;
    const params = [cid];
    let extraWhere = '';
    if (price_list_id) {
      params.push(parseInt(price_list_id));
      extraWhere = `AND pcl.price_list_id = $2`;
    }
    const result = await pool.query(
      `SELECT pcl.*, pl.name AS price_list_name
       FROM price_change_log pcl
       LEFT JOIN price_lists pl ON pl.id = pcl.price_list_id
       WHERE pcl.company_id = $1 ${extraWhere}
       ORDER BY pcl.changed_at DESC
       LIMIT 500`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
