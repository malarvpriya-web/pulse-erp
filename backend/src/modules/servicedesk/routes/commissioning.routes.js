/**
 * Phase 51 — Online Commissioning System
 * Full workflow: GPS check-in → checklist → photos → readings → sign-off → certificate → warranty
 */
import express from 'express';
import pool from '../../../config/db.js';
import { verifyToken } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);
const uid = req => req.user?.userId ?? req.user?.id ?? null;

// ── Workflow number generator ─────────────────────────────────────────────────
async function nextWfNo(company_id) {
  const yr = new Date().getFullYear().toString().slice(-2);
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM commissioning_workflows WHERE company_id = $1`,
    [company_id]
  );
  return `CW-${yr}-${String(parseInt(rows[0].cnt, 10) + 1).padStart(4, '0')}`;
}

async function nextCertNo(company_id) {
  const yr = new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM commissioning_workflows WHERE company_id = $1 AND certificate_issued = true`,
    [company_id]
  );
  return `CERT-${yr}-${String(parseInt(rows[0].cnt, 10) + 1).padStart(4, '0')}`;
}

// Default checklist items for new workflows
const DEFAULT_CHECKLIST = [
  { category: 'Pre-Commissioning', item_text: 'Verify equipment matches order specification', is_mandatory: true, sort_order: 1 },
  { category: 'Pre-Commissioning', item_text: 'Inspect physical condition — no transit damage', is_mandatory: true, sort_order: 2 },
  { category: 'Pre-Commissioning', item_text: 'Confirm civil/electrical readiness at site', is_mandatory: true, sort_order: 3 },
  { category: 'Installation', item_text: 'Earthing and grounding verified', is_mandatory: true, sort_order: 4 },
  { category: 'Installation', item_text: 'Cable connections checked and torqued', is_mandatory: true, sort_order: 5 },
  { category: 'Installation', item_text: 'Protection relay settings programmed', is_mandatory: true, sort_order: 6 },
  { category: 'Installation', item_text: 'FAT test results reviewed and matched', is_mandatory: true, sort_order: 7 },
  { category: 'Testing', item_text: 'Insulation resistance test (IR test)', is_mandatory: true, sort_order: 8 },
  { category: 'Testing', item_text: 'No-load energization test', is_mandatory: true, sort_order: 9 },
  { category: 'Testing', item_text: 'Protection relay functional test', is_mandatory: true, sort_order: 10 },
  { category: 'Testing', item_text: 'Load test at rated current', is_mandatory: false, sort_order: 11 },
  { category: 'Testing', item_text: 'Temperature rise measurement', is_mandatory: false, sort_order: 12 },
  { category: 'Handover', item_text: 'Operation manual handed over to customer', is_mandatory: true, sort_order: 13 },
  { category: 'Handover', item_text: 'Spare parts list provided', is_mandatory: false, sort_order: 14 },
  { category: 'Handover', item_text: 'Customer operator training completed', is_mandatory: false, sort_order: 15 },
  { category: 'Handover', item_text: 'SAT report verified', is_mandatory: true, sort_order: 16 },
];

const DEFAULT_READINGS = [
  { parameter: 'Supply Voltage R-Y', unit: 'V', set_value: '415' },
  { parameter: 'Supply Voltage Y-B', unit: 'V', set_value: '415' },
  { parameter: 'Supply Voltage B-R', unit: 'V', set_value: '415' },
  { parameter: 'Load Current R', unit: 'A', set_value: '' },
  { parameter: 'Load Current Y', unit: 'A', set_value: '' },
  { parameter: 'Load Current B', unit: 'A', set_value: '' },
  { parameter: 'IR Test (Phase-Earth)', unit: 'MΩ', set_value: '>100' },
  { parameter: 'Protection Relay Pickup', unit: 'A', set_value: '' },
  { parameter: 'Operating Temperature', unit: '°C', set_value: '<60' },
  { parameter: 'Frequency', unit: 'Hz', set_value: '50' },
];

// =============================================================================
// COMMISSIONING WORKFLOWS CRUD
// =============================================================================

// GET /commissioning — list all workflows
router.get('/', verifyToken, async (req, res) => {
  try {
    const { status, engineer_id, project_id } = req.query;
    let q = `
      SELECT cw.*, ce.equipment_name, ce.equipment_tag, ce.site_location
        FROM commissioning_workflows cw
        LEFT JOIN customer_equipment ce ON ce.id = cw.equipment_id
       WHERE cw.company_id = $1`;
    const params = [cid(req)];
    if (status) { params.push(status); q += ` AND cw.status = $${params.length}`; }
    if (engineer_id) { params.push(engineer_id); q += ` AND cw.engineer_id = $${params.length}`; }
    if (project_id) { params.push(project_id); q += ` AND cw.project_id = $${params.length}`; }
    q += ' ORDER BY cw.scheduled_date DESC, cw.created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /commissioning — create workflow
router.post('/', verifyToken, async (req, res) => {
  try {
    const {
      project_id, equipment_id, customer_name, site_name, site_address,
      engineer_id, engineer_name, fat_reference, sat_reference, scheduled_date, notes
    } = req.body;
    if (!customer_name || !scheduled_date) {
      return res.status(400).json({ error: 'customer_name and scheduled_date are required' });
    }
    const workflow_number = await nextWfNo(cid(req));

    const { rows } = await pool.query(
      `INSERT INTO commissioning_workflows
         (company_id, workflow_number, project_id, equipment_id, customer_name, site_name, site_address,
          engineer_id, engineer_name, fat_reference, sat_reference, scheduled_date, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
       RETURNING *`,
      [cid(req), workflow_number, project_id, equipment_id, customer_name, site_name, site_address,
       engineer_id, engineer_name, fat_reference, sat_reference, scheduled_date, notes]
    );
    const wf = rows[0];

    // Insert default checklist
    for (const item of DEFAULT_CHECKLIST) {
      await pool.query(
        `INSERT INTO commissioning_checklist_items (company_id, workflow_id, category, item_text, is_mandatory, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [cid(req), wf.id, item.category, item.item_text, item.is_mandatory, item.sort_order]
      );
    }

    // Insert default readings
    for (const r of DEFAULT_READINGS) {
      await pool.query(
        `INSERT INTO commissioning_readings (workflow_id, company_id, parameter, unit, set_value)
         VALUES ($1,$2,$3,$4,$5)`,
        [wf.id, cid(req), r.parameter, r.unit, r.set_value]
      );
    }

    await logAudit(pool, { userId: uid(req), company_id: cid(req), action: 'CREATE', module: 'Commissioning', record_id: wf.id, description: `Commissioning workflow created: ${workflow_number}` });
    res.status(201).json(wf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /commissioning/:id — workflow detail with checklist, readings, photos
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cw.*, ce.equipment_name, ce.equipment_tag, ce.model_number, ce.serial_number, ce.site_location
         FROM commissioning_workflows cw
         LEFT JOIN customer_equipment ce ON ce.id = cw.equipment_id
        WHERE cw.id = $1 AND cw.company_id = $2`,
      [req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Workflow not found' });
    const wf = rows[0];

    const [checklist, readings, photos] = await Promise.all([
      pool.query(`SELECT * FROM commissioning_checklist_items WHERE workflow_id = $1 ORDER BY sort_order`, [wf.id]),
      pool.query(`SELECT * FROM commissioning_readings WHERE workflow_id = $1 ORDER BY id`, [wf.id]),
      pool.query(`SELECT * FROM commissioning_photos WHERE workflow_id = $1 ORDER BY created_at`, [wf.id]),
    ]);

    wf.checklist = checklist.rows;
    wf.readings = readings.rows;
    wf.photos = photos.rows;

    // Completion stats
    const total = wf.checklist.length;
    const done = wf.checklist.filter(i => i.is_completed).length;
    const mandatoryTotal = wf.checklist.filter(i => i.is_mandatory).length;
    const mandatoryDone = wf.checklist.filter(i => i.is_mandatory && i.is_completed).length;
    wf.progress = { total, done, mandatory_total: mandatoryTotal, mandatory_done: mandatoryDone, pct: total ? Math.round((done / total) * 100) : 0 };

    res.json(wf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /commissioning/:id — update workflow fields
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { customer_name, site_name, site_address, engineer_id, engineer_name,
            fat_reference, sat_reference, scheduled_date, notes, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE commissioning_workflows
          SET customer_name = COALESCE($1, customer_name),
              site_name = COALESCE($2, site_name),
              site_address = COALESCE($3, site_address),
              engineer_id = COALESCE($4, engineer_id),
              engineer_name = COALESCE($5, engineer_name),
              fat_reference = COALESCE($6, fat_reference),
              sat_reference = COALESCE($7, sat_reference),
              scheduled_date = COALESCE($8, scheduled_date),
              notes = COALESCE($9, notes),
              status = COALESCE($10, status),
              updated_at = NOW()
        WHERE id = $11 AND company_id = $12 RETURNING *`,
      [customer_name, site_name, site_address, engineer_id, engineer_name,
       fat_reference, sat_reference, scheduled_date, notes, status, req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Workflow not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// GPS CHECK-IN / CHECK-OUT
// =============================================================================

// POST /commissioning/:id/checkin
router.post('/:id/checkin', verifyToken, async (req, res) => {
  try {
    const { lat, lng, address } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'GPS coordinates required' });
    const { rows } = await pool.query(
      `UPDATE commissioning_workflows
          SET status = 'in_progress', checkin_time = NOW(),
              checkin_lat = $1, checkin_lng = $2, checkin_address = $3, updated_at = NOW()
        WHERE id = $4 AND company_id = $5 RETURNING *`,
      [lat, lng, address, req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Workflow not found' });
    await logAudit(pool, { userId: uid(req), company_id: cid(req), action: 'UPDATE', module: 'Commissioning', record_id: rows[0].id, description: `Engineer checked in at ${address || `${lat},${lng}`}` });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /commissioning/:id/checkout
router.post('/:id/checkout', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE commissioning_workflows SET checkout_time = NOW(), updated_at = NOW()
        WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Workflow not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// CHECKLIST MANAGEMENT
// =============================================================================

// PUT /commissioning/:id/checklist/:itemId — mark item complete/incomplete
router.put('/:id/checklist/:itemId', verifyToken, async (req, res) => {
  try {
    const { is_completed, remarks } = req.body;
    const { rows } = await pool.query(
      `UPDATE commissioning_checklist_items
          SET is_completed = $1,
              completed_by = $2,
              completed_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
              remarks = COALESCE($3, remarks)
        WHERE id = $4 AND workflow_id = $5
        RETURNING *`,
      [is_completed, req.user?.name || req.user?.email, remarks, req.params.itemId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Checklist item not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /commissioning/:id/checklist — add custom checklist item
router.post('/:id/checklist', verifyToken, async (req, res) => {
  try {
    const { category, item_text, is_mandatory = false, sort_order = 99 } = req.body;
    if (!item_text) return res.status(400).json({ error: 'item_text is required' });
    const { rows } = await pool.query(
      `INSERT INTO commissioning_checklist_items (company_id, workflow_id, category, item_text, is_mandatory, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [cid(req), req.params.id, category, item_text, is_mandatory, sort_order]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// PARAMETER READINGS
// =============================================================================

// PUT /commissioning/:id/readings/:readingId
router.put('/:id/readings/:readingId', verifyToken, async (req, res) => {
  try {
    const { measured_value, status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE commissioning_readings
          SET measured_value = COALESCE($1, measured_value),
              status = COALESCE($2, status),
              notes = COALESCE($3, notes),
              recorded_at = NOW()
        WHERE id = $4 AND workflow_id = $5
        RETURNING *`,
      [measured_value, status, notes, req.params.readingId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reading not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /commissioning/:id/readings — add custom reading
router.post('/:id/readings', verifyToken, async (req, res) => {
  try {
    const { parameter, unit, set_value, measured_value, status, notes } = req.body;
    if (!parameter) return res.status(400).json({ error: 'parameter is required' });
    const { rows } = await pool.query(
      `INSERT INTO commissioning_readings (workflow_id, company_id, parameter, unit, set_value, measured_value, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, cid(req), parameter, unit, set_value, measured_value, status || 'ok', notes]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// PHOTOS
// =============================================================================

// POST /commissioning/:id/photos
router.post('/:id/photos', verifyToken, async (req, res) => {
  try {
    const { caption, file_path, phase } = req.body;
    if (!file_path) return res.status(400).json({ error: 'file_path is required' });
    const { rows } = await pool.query(
      `INSERT INTO commissioning_photos (workflow_id, company_id, caption, file_path, phase, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, cid(req), caption, file_path, phase || 'general', req.user?.name || req.user?.email]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /commissioning/:id/photos/:photoId
router.delete('/:id/photos/:photoId', verifyToken, async (req, res) => {
  try {
    await pool.query(`DELETE FROM commissioning_photos WHERE id = $1 AND workflow_id = $2`, [req.params.photoId, req.params.id]);
    res.json({ message: 'Photo deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// CUSTOMER SIGN-OFF
// =============================================================================

// POST /commissioning/:id/signoff
router.post('/:id/signoff', verifyToken, async (req, res) => {
  try {
    const { customer_sign_name, customer_sign_data, customer_feedback, customer_rating } = req.body;
    if (!customer_sign_name) return res.status(400).json({ error: 'customer_sign_name is required' });

    // Verify all mandatory checklist items are complete
    const { rows: incomplete } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM commissioning_checklist_items
        WHERE workflow_id = $1 AND is_mandatory = true AND is_completed = false`,
      [req.params.id]
    );
    if (parseInt(incomplete[0].cnt) > 0) {
      return res.status(400).json({ error: `${incomplete[0].cnt} mandatory checklist item(s) not completed` });
    }

    const { rows } = await pool.query(
      `UPDATE commissioning_workflows
          SET customer_sign_name = $1, customer_sign_data = $2,
              customer_sign_time = NOW(), customer_feedback = $3,
              customer_rating = $4, status = 'signed_off',
              completed_date = CURRENT_DATE, updated_at = NOW()
        WHERE id = $5 AND company_id = $6 RETURNING *`,
      [customer_sign_name, customer_sign_data, customer_feedback, customer_rating, req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Workflow not found' });
    await logAudit(pool, { userId: uid(req), company_id: cid(req), action: 'UPDATE', module: 'Commissioning', record_id: rows[0].id, description: `Customer sign-off received from ${customer_sign_name}` });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// CERTIFICATE ISSUANCE + WARRANTY ACTIVATION
// =============================================================================

// POST /commissioning/:id/issue-certificate
router.post('/:id/issue-certificate', verifyToken, async (req, res) => {
  try {
    const { rows: wf } = await pool.query(
      `SELECT * FROM commissioning_workflows WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]
    );
    if (!wf.length) return res.status(404).json({ error: 'Workflow not found' });
    if (wf[0].status !== 'signed_off') return res.status(400).json({ error: 'Customer sign-off required before issuing certificate' });
    if (wf[0].certificate_issued) return res.status(400).json({ error: 'Certificate already issued' });

    const cert_number = await nextCertNo(cid(req));
    const { rows } = await pool.query(
      `UPDATE commissioning_workflows
          SET certificate_number = $1, certificate_issued = true, certificate_issued_at = NOW(),
              status = 'completed', updated_at = NOW()
        WHERE id = $2 AND company_id = $3 RETURNING *`,
      [cert_number, req.params.id, cid(req)]
    );

    await logAudit(pool, { userId: uid(req), company_id: cid(req), action: 'UPDATE', module: 'Commissioning', record_id: rows[0].id, description: `Commissioning certificate issued: ${cert_number}` });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /commissioning/:id/activate-warranty
router.post('/:id/activate-warranty', verifyToken, async (req, res) => {
  try {
    const { warranty_months = 12 } = req.body;
    const { rows: wf } = await pool.query(
      `SELECT * FROM commissioning_workflows WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]
    );
    if (!wf.length) return res.status(404).json({ error: 'Workflow not found' });
    if (!wf[0].certificate_issued) return res.status(400).json({ error: 'Certificate must be issued before activating warranty' });

    const { rows } = await pool.query(
      `UPDATE commissioning_workflows
          SET warranty_activated = true, warranty_activated_at = NOW(),
              amc_eligible = true, updated_at = NOW()
        WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, cid(req)]
    );

    // Update equipment warranty dates if linked
    if (wf[0].equipment_id) {
      const expiry = new Date();
      expiry.setMonth(expiry.getMonth() + warranty_months);
      await pool.query(
        `UPDATE customer_equipment
            SET warranty_status = 'active', warranty_expiry = $1,
                last_service_date = CURRENT_DATE, updated_at = NOW()
          WHERE id = $2`,
        [expiry.toISOString().split('T')[0], wf[0].equipment_id]
      );
    }

    await logAudit(pool, { userId: uid(req), company_id: cid(req), action: 'UPDATE', module: 'Commissioning', record_id: rows[0].id, description: `Warranty activated for ${warranty_months} months` });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// ANALYTICS / SUMMARY
// =============================================================================

// GET /commissioning/analytics/summary
router.get('/analytics/summary', verifyToken, async (req, res) => {
  try {
    const [statusBreakdown, engineerStats, monthly] = await Promise.all([
      pool.query(
        `SELECT status, COUNT(*) AS cnt FROM commissioning_workflows WHERE company_id = $1 GROUP BY status`,
        [cid(req)]
      ),
      pool.query(
        `SELECT engineer_name, engineer_id,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                AVG(customer_rating) AS avg_rating
           FROM commissioning_workflows WHERE company_id = $1 AND engineer_name IS NOT NULL
          GROUP BY engineer_name, engineer_id ORDER BY total DESC LIMIT 10`,
        [cid(req)]
      ),
      pool.query(
        `SELECT TO_CHAR(scheduled_date, 'YYYY-MM') AS month, COUNT(*) AS total,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
           FROM commissioning_workflows WHERE company_id = $1 AND scheduled_date >= NOW() - INTERVAL '12 months'
          GROUP BY month ORDER BY month`,
        [cid(req)]
      ),
    ]);
    const statusMap = {};
    statusBreakdown.rows.forEach(r => { statusMap[r.status] = parseInt(r.cnt); });
    res.json({ status_breakdown: statusMap, engineer_stats: engineerStats.rows, monthly: monthly.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /commissioning/templates — checklist templates
router.get('/templates/list', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM commissioning_checklist_templates WHERE company_id = $1 ORDER BY name`,
      [cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /commissioning/templates
router.post('/templates', verifyToken, async (req, res) => {
  try {
    const { name, category, items, is_default } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO commissioning_checklist_templates (company_id, name, category, items, is_default)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [cid(req), name, category, JSON.stringify(items || DEFAULT_CHECKLIST), is_default || false]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
