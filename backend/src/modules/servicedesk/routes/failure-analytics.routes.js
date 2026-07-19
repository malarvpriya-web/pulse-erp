/**
 * Phase 51 — Failure Analytics Engine
 * Track: zone, customer, product, panel, fault code, root cause, component, resolution
 * Answer: Which zone/product/vendor component fails most? Which engineer resolves fastest?
 */
import express from 'express';
import pool from '../../../config/db.js';
import { verifyToken } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);
const uid = req => req.user?.userId ?? req.user?.id ?? null;

// =============================================================================
// FAILURE RECORDS CRUD
// =============================================================================

// GET /failure-analytics — list failure records
router.get('/', verifyToken, async (req, res) => {
  try {
    const { zone, product_name, fault_code, engineer_id, is_repeat, from_date, to_date } = req.query;
    let q = `
      SELECT sfr.*, ce.equipment_name, ce.equipment_tag, ce.site_location
        FROM service_failure_records sfr
        LEFT JOIN customer_equipment ce ON ce.id = sfr.equipment_id
       WHERE sfr.company_id = $1`;
    const params = [cid(req)];
    if (zone) { params.push(zone); q += ` AND sfr.zone = $${params.length}`; }
    if (product_name) { params.push(`%${product_name}%`); q += ` AND sfr.product_name ILIKE $${params.length}`; }
    if (fault_code) { params.push(fault_code); q += ` AND sfr.fault_code = $${params.length}`; }
    if (engineer_id) { params.push(engineer_id); q += ` AND sfr.engineer_id = $${params.length}`; }
    if (is_repeat === 'true') q += ` AND sfr.is_repeat_failure = true`;
    if (from_date) { params.push(from_date); q += ` AND sfr.failure_date >= $${params.length}`; }
    if (to_date) { params.push(to_date); q += ` AND sfr.failure_date <= $${params.length}`; }
    q += ' ORDER BY sfr.failure_date DESC LIMIT 200';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /failure-analytics — log failure record
router.post('/', verifyToken, async (req, res) => {
  try {
    const {
      ticket_id, equipment_id, customer_name, zone, product_name, model_number,
      fault_code, fault_description, root_cause, root_cause_category, component_failed,
      vendor_component, resolution, resolution_time_hrs, is_repeat_failure, repeat_failure_ref,
      engineer_id, engineer_name, failure_date, resolved_date
    } = req.body;
    if (!product_name && !equipment_id) return res.status(400).json({ error: 'product_name or equipment_id required' });
    const { rows } = await pool.query(
      `INSERT INTO service_failure_records
         (company_id, ticket_id, equipment_id, customer_name, zone, product_name, model_number,
          fault_code, fault_description, root_cause, root_cause_category, component_failed,
          vendor_component, resolution, resolution_time_hrs, is_repeat_failure, repeat_failure_ref,
          engineer_id, engineer_name, failure_date, resolved_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [cid(req), ticket_id, equipment_id, customer_name, zone, product_name, model_number,
       fault_code, fault_description, root_cause, root_cause_category, component_failed,
       vendor_component, resolution, resolution_time_hrs, is_repeat_failure || false,
       repeat_failure_ref, engineer_id, engineer_name, failure_date, resolved_date]
    );
    await logAudit(pool, { userId: uid(req), company_id: cid(req), action: 'CREATE', module: 'FailureAnalytics', record_id: rows[0].id, description: `Failure logged for ${product_name || 'equipment #' + equipment_id}` });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /failure-analytics/:id
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const fields = ['zone','product_name','fault_code','fault_description','root_cause',
      'root_cause_category','component_failed','vendor_component','resolution',
      'resolution_time_hrs','is_repeat_failure','engineer_name','resolved_date'];
    const sets = fields.map((f, i) => `${f} = COALESCE($${i+1}, ${f})`).join(', ');
    const vals = fields.map(f => req.body[f] !== undefined ? req.body[f] : null);
    const { rows } = await pool.query(
      `UPDATE service_failure_records SET ${sets} WHERE id = $${fields.length+1} AND company_id = $${fields.length+2} RETURNING *`,
      [...vals, req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Record not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /failure-analytics/:id
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    await pool.query(`DELETE FROM service_failure_records WHERE id = $1 AND company_id = $2`, [req.params.id, cid(req)]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// ANALYTICS ENDPOINTS
// =============================================================================

// GET /failure-analytics/by-zone — failures by zone
router.get('/analysis/by-zone', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT zone,
             COUNT(*) AS total_failures,
             COUNT(CASE WHEN is_repeat_failure THEN 1 END) AS repeat_failures,
             ROUND(AVG(resolution_time_hrs)::NUMERIC,2) AS avg_resolution_hrs,
             array_agg(DISTINCT product_name) FILTER (WHERE product_name IS NOT NULL) AS products_affected
        FROM service_failure_records
       WHERE company_id = $1 AND zone IS NOT NULL
       GROUP BY zone ORDER BY total_failures DESC
    `, [cid(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /failure-analytics/by-product
router.get('/analysis/by-product', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT product_name, model_number,
             COUNT(*) AS total_failures,
             COUNT(CASE WHEN is_repeat_failure THEN 1 END) AS repeat_failures,
             ROUND(AVG(resolution_time_hrs)::NUMERIC,2) AS avg_resolution_hrs,
             array_agg(DISTINCT fault_code) FILTER (WHERE fault_code IS NOT NULL) AS fault_codes
        FROM service_failure_records
       WHERE company_id = $1 AND product_name IS NOT NULL
       GROUP BY product_name, model_number ORDER BY total_failures DESC LIMIT 20
    `, [cid(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /failure-analytics/by-component — vendor component failures
router.get('/analysis/by-component', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT component_failed, vendor_component,
             COUNT(*) AS failure_count,
             ROUND(AVG(resolution_time_hrs)::NUMERIC,2) AS avg_resolution_hrs,
             array_agg(DISTINCT product_name) FILTER (WHERE product_name IS NOT NULL) AS in_products
        FROM service_failure_records
       WHERE company_id = $1 AND component_failed IS NOT NULL
       GROUP BY component_failed, vendor_component ORDER BY failure_count DESC LIMIT 20
    `, [cid(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /failure-analytics/by-fault-code
router.get('/analysis/by-fault-code', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT fault_code, fault_description,
             COUNT(*) AS frequency,
             COUNT(CASE WHEN is_repeat_failure THEN 1 END) AS repeat_count,
             ROUND(AVG(resolution_time_hrs)::NUMERIC,2) AS avg_resolution_hrs,
             array_agg(DISTINCT root_cause_category) FILTER (WHERE root_cause_category IS NOT NULL) AS root_cause_categories
        FROM service_failure_records
       WHERE company_id = $1 AND fault_code IS NOT NULL
       GROUP BY fault_code, fault_description ORDER BY frequency DESC LIMIT 20
    `, [cid(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /failure-analytics/by-engineer — who resolves fastest
router.get('/analysis/by-engineer', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT engineer_name, engineer_id,
             COUNT(*) AS total_resolved,
             ROUND(AVG(resolution_time_hrs)::NUMERIC,2) AS avg_resolution_hrs,
             MIN(resolution_time_hrs) AS best_resolution_hrs,
             COUNT(CASE WHEN is_repeat_failure THEN 1 END) AS repeat_failures_handled
        FROM service_failure_records
       WHERE company_id = $1 AND engineer_name IS NOT NULL AND resolved_date IS NOT NULL
       GROUP BY engineer_name, engineer_id ORDER BY avg_resolution_hrs ASC NULLS LAST LIMIT 20
    `, [cid(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /failure-analytics/dashboard — management summary
router.get('/dashboard', verifyToken, async (req, res) => {
  try {
    const [kpis, byZone, byProduct, byComponent, trend, repeatTrend] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS total,
               COUNT(CASE WHEN is_repeat_failure THEN 1 END) AS repeat_failures,
               ROUND(AVG(resolution_time_hrs)::NUMERIC,2) AS avg_resolution_hrs,
               COUNT(DISTINCT zone) AS zones_affected,
               COUNT(DISTINCT product_name) AS products_affected
          FROM service_failure_records WHERE company_id = $1
      `, [cid(req)]),
      pool.query(`SELECT zone, COUNT(*) AS cnt FROM service_failure_records WHERE company_id = $1 AND zone IS NOT NULL GROUP BY zone ORDER BY cnt DESC LIMIT 8`, [cid(req)]),
      pool.query(`SELECT product_name, COUNT(*) AS cnt FROM service_failure_records WHERE company_id = $1 AND product_name IS NOT NULL GROUP BY product_name ORDER BY cnt DESC LIMIT 8`, [cid(req)]),
      pool.query(`SELECT component_failed, COUNT(*) AS cnt FROM service_failure_records WHERE company_id = $1 AND component_failed IS NOT NULL GROUP BY component_failed ORDER BY cnt DESC LIMIT 8`, [cid(req)]),
      pool.query(`SELECT TO_CHAR(failure_date,'YYYY-MM') AS month, COUNT(*) AS failures FROM service_failure_records WHERE company_id = $1 AND failure_date >= NOW()-INTERVAL '12 months' GROUP BY month ORDER BY month`, [cid(req)]),
      pool.query(`SELECT TO_CHAR(failure_date,'YYYY-MM') AS month, COUNT(CASE WHEN is_repeat_failure THEN 1 END) AS repeats FROM service_failure_records WHERE company_id = $1 AND failure_date >= NOW()-INTERVAL '12 months' GROUP BY month ORDER BY month`, [cid(req)]),
    ]);
    res.json({
      kpis: kpis.rows[0],
      by_zone: byZone.rows,
      by_product: byProduct.rows,
      by_component: byComponent.rows,
      monthly_trend: trend.rows,
      repeat_trend: repeatTrend.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
