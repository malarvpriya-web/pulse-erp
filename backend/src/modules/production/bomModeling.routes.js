// backend/src/modules/production/bomModeling.routes.js
//
// BOM modeling extensions: phantom flag + co-/by-product outputs. Mounted at /mfg.
import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = Router();
const cidOf = (req) => (req.scope?.company_id != null ? req.scope.company_id : null);
const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;

/* GET /mfg/boms — active BOMs with phantom flag + output count (for the modeling picker) */
router.get('/boms', requirePermission('bom', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { rows } = await pool.query(`
      SELECT h.id, h.bom_number, h.product_id, h.product_name, h.version, h.status,
             COALESCE(h.is_phantom,false) AS is_phantom,
             (SELECT COUNT(*)::int FROM bom_outputs o WHERE o.bom_id = h.id) AS output_count
        FROM bom_headers h
       WHERE ($1::int IS NULL OR h.company_id = $1 OR h.company_id IS NULL)
       ORDER BY h.product_name, h.version DESC LIMIT 1000`, [cid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* PATCH /mfg/boms/:id/phantom { is_phantom } */
router.patch('/boms/:id/phantom', requirePermission('bom', 'edit'), async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE bom_headers SET is_phantom = $2, updated_at = NOW() WHERE id = $1 RETURNING id, product_name, is_phantom`,
      [req.params.id, !!req.body?.is_phantom]);
    if (!row) return res.status(404).json({ error: 'BOM not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /mfg/boms/:id/outputs */
router.get('/boms/:id/outputs', requirePermission('bom', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM bom_outputs WHERE bom_id = $1 ORDER BY output_type, id`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /mfg/boms/:id/outputs { item_id, item_name, uom, output_type, qty_per_parent, cost_share_pct } */
router.post('/boms/:id/outputs', requirePermission('bom', 'edit'), async (req, res) => {
  try {
    const { item_id, item_name, uom, output_type = 'co', qty_per_parent = 1, cost_share_pct = 0, notes } = req.body || {};
    if (!item_name) return res.status(400).json({ error: 'item_name required' });
    if (!['co', 'by'].includes(output_type)) return res.status(400).json({ error: 'output_type must be co or by' });
    const { rows: [row] } = await pool.query(`
      INSERT INTO bom_outputs (bom_id, company_id, item_id, item_name, uom, output_type, qty_per_parent, cost_share_pct, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, cidOf(req), item_id || null, item_name, uom || null, output_type, num(qty_per_parent), num(cost_share_pct), notes || null]);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* DELETE /mfg/outputs/:oid */
router.delete('/outputs/:oid', requirePermission('bom', 'edit'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM bom_outputs WHERE id = $1`, [req.params.oid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
