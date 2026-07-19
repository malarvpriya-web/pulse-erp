// backend/src/modules/quality/quality.routes.js
import { Router } from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import { verifyToken, allowRoles } from '../../middlewares/auth.middleware.js';

const router = Router();
router.use(verifyToken);

const cid = (req) => req.scope?.company_id ?? null;
const uid = (req) => req.user?.userId ?? req.user?.id ?? null;

// Role guards — quality_inspector can view/create, quality_manager can approve/close/delete
const canView   = allowRoles('admin','super_admin','quality_manager','quality_inspector','manager');
const canCreate = allowRoles('admin','super_admin','quality_manager','quality_inspector','manager');
const canManage = allowRoles('admin','super_admin','quality_manager','manager');
const canAdmin  = allowRoles('admin','super_admin');

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => {
      const v = r[h] == null ? '' : String(r[h]).replace(/"/g, '""');
      return `"${v}"`;
    }).join(','));
  }
  return lines.join('\n');
}

/* ── Seed default checklists including HVDC/STATCOM FAT templates ─────────── */
const seedData = async () => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) as n FROM inspection_checklists');
    if (parseInt(rows[0].n) > 0) return;
    await pool.query(`
      INSERT INTO inspection_checklists (name, type, items) VALUES
      ('Inward Raw Material Check','inward','[
        {"step":1,"criteria":"Check packing condition","measurement_type":"pass_fail"},
        {"step":2,"criteria":"Verify quantity matches PO","measurement_type":"pass_fail"},
        {"step":3,"criteria":"Check certificate of conformity","measurement_type":"pass_fail"},
        {"step":4,"criteria":"Dimensional check (sample)","measurement_type":"numeric","min":9.8,"max":10.2,"unit":"mm"},
        {"step":5,"criteria":"Surface finish / visual defects","measurement_type":"pass_fail"}
      ]'),
      ('In-Process Weld Inspection','in-process','[
        {"step":1,"criteria":"Pre-heat temperature","measurement_type":"numeric","min":150,"max":200,"unit":"C"},
        {"step":2,"criteria":"Weld bead continuity","measurement_type":"pass_fail"},
        {"step":3,"criteria":"Penetration check","measurement_type":"pass_fail"},
        {"step":4,"criteria":"Distortion check","measurement_type":"numeric","min":0,"max":2,"unit":"mm"}
      ]'),
      ('Final Assembly QC','final','[
        {"step":1,"criteria":"Functional test - power on","measurement_type":"pass_fail"},
        {"step":2,"criteria":"Dimensional verification","measurement_type":"pass_fail"},
        {"step":3,"criteria":"Label and marking check","measurement_type":"pass_fail"},
        {"step":4,"criteria":"Packaging integrity","measurement_type":"pass_fail"},
        {"step":5,"criteria":"Load test","measurement_type":"numeric","min":95,"max":105,"unit":"%"}
      ]'),
      ('HVDC Factory Acceptance Test','fat','[
        {"step":1,"criteria":"Visual inspection - cabinet wiring","measurement_type":"pass_fail"},
        {"step":2,"criteria":"Insulation resistance test (>1 GOhm)","measurement_type":"numeric","min":1000,"max":null,"unit":"MOhm"},
        {"step":3,"criteria":"Hi-Pot test (2.5kV AC, 1 min)","measurement_type":"pass_fail"},
        {"step":4,"criteria":"No-load voltage","measurement_type":"numeric","min":99,"max":101,"unit":"% rated"},
        {"step":5,"criteria":"Full-load efficiency","measurement_type":"numeric","min":96,"max":null,"unit":"%"},
        {"step":6,"criteria":"THD measurement","measurement_type":"numeric","min":0,"max":5,"unit":"%"},
        {"step":7,"criteria":"Protection relay test","measurement_type":"pass_fail"},
        {"step":8,"criteria":"SCADA/Modbus communication","measurement_type":"pass_fail"},
        {"step":9,"criteria":"Temperature rise at full load","measurement_type":"numeric","min":0,"max":40,"unit":"C"},
        {"step":10,"criteria":"Emergency stop function","measurement_type":"pass_fail"}
      ]'),
      ('STATCOM Factory Acceptance Test','fat','[
        {"step":1,"criteria":"Control board power-up","measurement_type":"pass_fail"},
        {"step":2,"criteria":"Reactive power output - rated","measurement_type":"numeric","min":98,"max":102,"unit":"% rated"},
        {"step":3,"criteria":"Response time (0-100% step)","measurement_type":"numeric","min":0,"max":20,"unit":"ms"},
        {"step":4,"criteria":"Harmonic compensation verify","measurement_type":"pass_fail"},
        {"step":5,"criteria":"IGBT gate drive check","measurement_type":"pass_fail"},
        {"step":6,"criteria":"Protection: OC/OV/UV","measurement_type":"pass_fail"},
        {"step":7,"criteria":"Fan/cooling system","measurement_type":"pass_fail"},
        {"step":8,"criteria":"Communication interface","measurement_type":"pass_fail"}
      ]')
    `);
  } catch (err) { console.warn('[quality] seed failed:', err.message); }
};
setTimeout(seedData, 2000);

/* ── INSPECTION CHECKLISTS ────────────────────────────────────────────────── */
router.get('/checklists', canView, async (req, res) => {
  try {
    const { type } = req.query;
    const params = [];
    let q = 'SELECT * FROM inspection_checklists WHERE TRUE';
    if (type) { params.push(type); q += ` AND type=$${params.length}`; }
    q += ' ORDER BY name';
    const { rows } = await pool.query(q, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/checklists', canManage, async (req, res) => {
  try {
    const { name, type = 'inward', items = [] } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    const { rows } = await pool.query(
      'INSERT INTO inspection_checklists (name, type, items) VALUES ($1,$2,$3) RETURNING *',
      [name, type, JSON.stringify(items)]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.put('/checklists/:id', canManage, async (req, res) => {
  try {
    const { name, type, items } = req.body;
    const { rows } = await pool.query(
      `UPDATE inspection_checklists SET name=COALESCE($1,name), type=COALESCE($2,type),
       items=COALESCE($3::jsonb,items) WHERE id=$4 RETURNING *`,
      [name, type, items ? JSON.stringify(items) : null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── INSPECTIONS (IQC / IPQC / FQC) ─────────────────────────────────────── */
router.get('/inspect', canView, async (req, res) => {
  try {
    const { status, type, stage, reference_type, grn_id, production_order_id, limit = 50, offset = 0 } = req.query;
    const companyId = cid(req);
    const params = [companyId];
    let q = `SELECT r.*, c.name as checklist_name, c.type as inspection_type, v.name as vendor_name
      FROM inspection_reports r
      LEFT JOIN inspection_checklists c ON c.id = r.checklist_id
      LEFT JOIN goods_receipt_notes g ON g.id = r.grn_id
      LEFT JOIN vendors v ON v.id = g.vendor_id
      WHERE ($1::int IS NULL OR r.company_id = $1)`;
    if (status)              { params.push(status);              q += ` AND r.status=$${params.length}`; }
    if (type || stage)       { params.push(type || stage);       q += ` AND c.type=$${params.length}`; }
    if (reference_type)      { params.push(reference_type);      q += ` AND r.reference_type=$${params.length}`; }
    if (grn_id)              { params.push(grn_id);              q += ` AND r.grn_id=$${params.length}`; }
    if (production_order_id) { params.push(production_order_id); q += ` AND r.reference_id=$${params.length} AND r.reference_type='production_order'`; }
    params.push(parseInt(limit));  q += ` ORDER BY r.inspected_at DESC LIMIT $${params.length}`;
    params.push(parseInt(offset)); q += ` OFFSET $${params.length}`;
    const { rows } = await pool.query(q, params);
    const count = await pool.query(
      'SELECT COUNT(*) FROM inspection_reports WHERE ($1::int IS NULL OR company_id=$1)', [companyId]
    );
    res.json({ success: true, data: rows, total: parseInt(count.rows[0].count) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/inspect/:id', canView, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, c.name as checklist_name, c.type as inspection_type, c.type as stage, c.items as checklist_items
       FROM inspection_reports r LEFT JOIN inspection_checklists c ON c.id = r.checklist_id WHERE r.id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const r = rows[0];
    const checklistItems = r.checklist_items || [];
    const storedResults = r.results || {};
    const items = checklistItems.map((item, idx) => {
      const key = item.step || String(idx);
      const stored = storedResults[key] || {};
      return { id: key, description: item.description || item.step || `Step ${idx+1}`, specification: item.specification || item.criteria || '', result: stored.result ?? '', actual_value: stored.actual_value ?? '', notes: stored.notes ?? '' };
    });
    res.json({ success: true, data: { ...r, items } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.put('/inspect/:id', canCreate, async (req, res) => {
  try {
    const { item_results, overall_result, status } = req.body;
    const existing = await pool.query('SELECT results FROM inspection_reports WHERE id=$1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const merged = existing.rows[0].results || {};
    if (Array.isArray(item_results)) {
      for (const r of item_results) { merged[r.item_id] = { result: r.result, actual_value: r.actual_value, notes: r.notes }; }
    }
    const { rows } = await pool.query(
      `UPDATE inspection_reports
       SET results=$1, status=COALESCE($2,status), overall_result=COALESCE($3,overall_result), updated_at=NOW()
       WHERE id=$4 RETURNING id, status, overall_result, results`,
      [JSON.stringify(merged), status || null, overall_result || null, req.params.id]
    );
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/inspect', canCreate, async (req, res) => {
  try {
    const {
      checklist_id, reference_type, reference_id, grn_id,
      inspector_id, inspector_name, results = {}, remarks, notes,
      stage = 'IQC', reference_number, production_order_id,
    } = req.body;
    if (!checklist_id) return res.status(400).json({ success: false, error: 'checklist_id required' });
    const checklist = await pool.query('SELECT * FROM inspection_checklists WHERE id=$1', [checklist_id]);
    if (!checklist.rows.length) return res.status(404).json({ success: false, error: 'Checklist not found' });
    const items = checklist.rows[0]?.items || [];
    let status = 'pending';
    for (const item of items) {
      const result = results[item.step];
      if (item.measurement_type === 'pass_fail' && result === false) { status = 'fail'; break; }
      if (item.measurement_type === 'numeric') {
        const val = parseFloat(result);
        if (!isNaN(val) && item.min != null && val < item.min) { status = 'fail'; break; }
        if (!isNaN(val) && item.max != null && val > item.max) { status = 'fail'; break; }
      }
    }
    const resolvedRefType = reference_type || (production_order_id ? 'production_order' : null);
    const resolvedRefId   = reference_id   || production_order_id  || null;
    const companyId = cid(req);
    const { rows } = await pool.query(
      `INSERT INTO inspection_reports
         (checklist_id, reference_type, reference_id, grn_id, inspector_id, inspector_name, status, results, remarks, company_id, stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [checklist_id, resolvedRefType, resolvedRefId, grn_id || null, inspector_id, inspector_name, status, JSON.stringify(results), remarks || notes || reference_number || null, companyId, stage]
    );
    logAudit({ userId: uid(req), module: 'quality', recordId: rows[0].id, recordType: 'inspection_report', action: 'create', newData: { reference_type, reference_id, status }, req });
    // Auto-NCR on fail
    let autoNcr = null;
    if (status === 'fail') {
      const settings = await pool.query('SELECT iqc_auto_ncr_on_fail, ncr_auto_number_prefix FROM quality_settings WHERE company_id=$1', [companyId]).catch(() => ({ rows: [] }));
      if (settings.rows[0]?.iqc_auto_ncr_on_fail) {
        const prefix = settings.rows[0]?.ncr_auto_number_prefix || 'NCR';
        const ncrNum = `${prefix}-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`;
        const nr = await pool.query(
          `INSERT INTO ncr_reports (title, description, ncr_number, detected_by, reference_type, reference_id, grn_id, severity, source, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'major','quality',$8) RETURNING *`,
          [`Auto NCR - Inspection Fail (${checklist.rows[0].name})`, remarks || 'Inspection failed', ncrNum, inspector_name, reference_type, reference_id, grn_id || null, companyId]
        );
        autoNcr = nr.rows[0];
      }
    }
    res.status(201).json({ success: true, data: rows[0], auto_ncr: autoNcr });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Alias used by QualityManagement.jsx → Inspection Reports tab
router.get('/reports', canView, async (req, res) => {
  try {
    const { status, type, limit = 50 } = req.query;
    const companyId = cid(req);
    const params = [companyId];
    let q = `SELECT r.*, c.name as checklist_name, c.type as inspection_type FROM inspection_reports r
      LEFT JOIN inspection_checklists c ON c.id = r.checklist_id WHERE ($1::int IS NULL OR r.company_id=$1)`;
    if (status) { params.push(status); q += ` AND r.status=$${params.length}`; }
    if (type)   { params.push(type);   q += ` AND c.type=$${params.length}`; }
    params.push(parseInt(limit)); q += ` ORDER BY r.inspected_at DESC LIMIT $${params.length}`;
    const { rows } = await pool.query(q, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── NCR — UNIFIED (source: quality|procurement|production|service) ──────── */
router.get('/ncr', canView, async (req, res) => {
  try {
    const { status, severity, source, vendor_id, limit = 100, offset = 0, export: doExport } = req.query;
    const companyId = cid(req);
    const params = [companyId];
    let q = `SELECT n.*, e_app.name as approver_name_resolved, v.name as vendor_name,
      (SELECT COUNT(*) FROM capa_actions WHERE ncr_id=n.id) as capa_count,
      (SELECT COUNT(*) FROM capa_actions WHERE ncr_id=n.id AND status='completed') as capa_closed
      FROM ncr_reports n
      LEFT JOIN employees e_app ON e_app.id = n.approver_id
      LEFT JOIN vendors v ON v.id = n.vendor_id
      WHERE ($1::int IS NULL OR n.company_id=$1)`;
    if (status)    { params.push(status);    q += ` AND n.status=$${params.length}`; }
    if (severity)  { params.push(severity);  q += ` AND n.severity=$${params.length}`; }
    if (source)    { params.push(source);    q += ` AND n.source=$${params.length}`; }
    if (vendor_id) { params.push(vendor_id); q += ` AND n.vendor_id=$${params.length}`; }
    q += ' ORDER BY n.created_at DESC';
    if (!doExport) {
      params.push(parseInt(limit));  q += ` LIMIT $${params.length}`;
      params.push(parseInt(offset)); q += ` OFFSET $${params.length}`;
    }
    const { rows } = await pool.query(q, params);
    const now = Date.now();
    const data = rows.map(r => ({
      ...r,
      days_open: r.status !== 'closed' ? Math.floor((now - new Date(r.detected_at || r.created_at)) / 86400000) : null
    }));
    if (doExport === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="ncr_report.csv"');
      return res.send(toCSV(data));
    }
    res.json({ success: true, data, total: data.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/ncr/:id', canView, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.*, e_app.name as approver_name_resolved, v.name as vendor_name,
        (SELECT json_agg(a ORDER BY a.created_at) FROM capa_actions a WHERE a.ncr_id=n.id) as capas
       FROM ncr_reports n
       LEFT JOIN employees e_app ON e_app.id = n.approver_id
       LEFT JOIN vendors v ON v.id = n.vendor_id WHERE n.id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/ncr', canCreate, async (req, res) => {
  try {
    const {
      title, description, detected_by, reference_type, reference_id,
      severity = 'major', source = 'quality', grn_id, vendor_id,
      project_id, type = 'general', containment_action
    } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'title is required' });
    const companyId = cid(req);
    const settings = await pool.query('SELECT ncr_auto_number_prefix FROM quality_settings WHERE company_id=$1', [companyId]).catch(() => ({ rows: [] }));
    const prefix = settings.rows[0]?.ncr_auto_number_prefix || 'NCR';
    const ncr_number = `${prefix}-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`;
    const { rows } = await pool.query(
      `INSERT INTO ncr_reports (title, description, ncr_number, detected_by, reference_type, reference_id, severity, source, grn_id, vendor_id, project_id, type, containment_action, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [title, description, ncr_number, detected_by, reference_type, reference_id, severity, source, grn_id || null, vendor_id || null, project_id || null, type, containment_action || null, companyId]
    );
    logAudit({ userId: uid(req), module: 'quality', recordId: rows[0].id, recordType: 'ncr_report', action: 'create', newData: { ncr_number, title, severity, source }, req });
    if (vendor_id) {
      pool.query(
        `UPDATE vendors SET defect_rate=(SELECT ROUND(COUNT(*)*100.0/GREATEST((SELECT COUNT(*) FROM goods_receipt_notes WHERE vendor_id=$1),1),2) FROM ncr_reports WHERE vendor_id=$1) WHERE id=$1`,
        [vendor_id]
      ).catch(() => {});
    }
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.put('/ncr/:id', canCreate, async (req, res) => {
  try {
    const { rows: [old] } = await pool.query('SELECT * FROM ncr_reports WHERE id=$1', [req.params.id]);
    if (!old) return res.status(404).json({ success: false, error: 'Not found' });
    const { status, root_cause, disposition, description, containment_action, severity, title, type } = req.body;
    const { rows } = await pool.query(
      `UPDATE ncr_reports SET status=COALESCE($1,status), root_cause=COALESCE($2,root_cause), disposition=COALESCE($3,disposition),
       description=COALESCE($4,description), containment_action=COALESCE($5,containment_action),
       severity=COALESCE($6,severity), title=COALESCE($7,title), type=COALESCE($8,type), updated_at=NOW() WHERE id=$9 RETURNING *`,
      [status, root_cause, disposition, description, containment_action, severity, title, type, req.params.id]
    );
    logAudit({ userId: uid(req), module: 'quality', recordId: req.params.id, recordType: 'ncr_report', action: 'update', oldData: { status: old.status }, newData: { status }, req });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// PATCH /ncr/:id/resolve — moves NCR to 'resolved' status
router.patch('/ncr/:id/resolve', canCreate, async (req, res) => {
  try {
    const { resolution } = req.body;
    const { rows } = await pool.query(
      `UPDATE ncr_reports SET status='resolved', resolution=COALESCE($1,resolution),
       resolved_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *`,
      [resolution || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    logAudit({ userId: uid(req), module: 'quality', recordId: req.params.id, recordType: 'ncr_report', action: 'resolve', newData: { status: 'resolved', resolution }, req });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/ncr/:id/approve', canManage, async (req, res) => {
  try {
    const { remarks } = req.body;
    const empRow = await pool.query('SELECT name FROM employees WHERE id=$1', [uid(req)]).catch(() => ({ rows: [] }));
    const approverName = empRow.rows[0]?.name || req.user?.name || 'Unknown';
    const { rows } = await pool.query(
      `UPDATE ncr_reports SET status='under-review', approver_id=$1, approved_at=NOW(), approved_by_name=$2,
       root_cause=COALESCE($3,root_cause), updated_at=NOW() WHERE id=$4 RETURNING *`,
      [uid(req), approverName, remarks, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    logAudit({ userId: uid(req), module: 'quality', recordId: req.params.id, recordType: 'ncr_report', action: 'approve', newData: { approved_by: approverName }, req });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/ncr/:id/close', canManage, async (req, res) => {
  try {
    const { disposition, root_cause } = req.body;
    if (!disposition) return res.status(400).json({ success: false, error: 'disposition required' });
    const capaCheck = await pool.query(
      `SELECT COUNT(*) as open FROM capa_actions WHERE ncr_id=$1 AND status NOT IN ('completed','verified')`,
      [req.params.id]
    );
    if (parseInt(capaCheck.rows[0].open) > 0) {
      return res.status(400).json({ success: false, error: `${capaCheck.rows[0].open} CAPA(s) still open — close all CAPAs first` });
    }
    const { rows } = await pool.query(
      `UPDATE ncr_reports SET status='closed', disposition=$1, root_cause=COALESCE($2,root_cause), updated_at=NOW() WHERE id=$3 RETURNING *`,
      [disposition, root_cause, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    logAudit({ userId: uid(req), module: 'quality', recordId: req.params.id, recordType: 'ncr_report', action: 'close', newData: { disposition }, req });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── CAPA — employee FK, verifier, company scope ─────────────────────────── */
router.get('/capa', canView, async (req, res) => {
  try {
    const { status, ncr_id, overdue, export: doExport } = req.query;
    const companyId = cid(req);
    const params = [companyId];
    let q = `SELECT a.*, n.title as ncr_title, n.ncr_number, n.severity,
      e.name as employee_name, ev.name as verifier_name
      FROM capa_actions a
      LEFT JOIN ncr_reports n ON n.id = a.ncr_id
      LEFT JOIN employees e ON e.id = a.employee_id
      LEFT JOIN employees ev ON ev.id = a.verifier_id
      WHERE ($1::int IS NULL OR a.company_id=$1)`;
    if (status)           { params.push(status); q += ` AND a.status=$${params.length}`; }
    if (ncr_id)           { params.push(ncr_id); q += ` AND a.ncr_id=$${params.length}`; }
    if (overdue === 'true') q += ` AND a.status NOT IN ('completed','verified') AND a.due_date < NOW()`;
    q += ' ORDER BY a.due_date ASC NULLS LAST';
    const { rows } = await pool.query(q, params);
    const now = new Date();
    const data = rows.map(r => ({
      ...r,
      overdue: !['completed','verified'].includes(r.status) && r.due_date && new Date(r.due_date) < now
    }));
    if (doExport === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="capa_report.csv"');
      return res.send(toCSV(data));
    }
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/capa', canCreate, async (req, res) => {
  try {
    const { ncr_id, action_type, description, assigned_to, employee_id, verifier_id, due_date } = req.body;
    if (!ncr_id || !description) return res.status(400).json({ success: false, error: 'ncr_id and description required' });
    const companyId = cid(req);
    const { rows } = await pool.query(
      `INSERT INTO capa_actions (ncr_id, action_type, description, assigned_to, employee_id, verifier_id, due_date, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ncr_id, action_type, description, assigned_to, employee_id || null, verifier_id || null, due_date, companyId]
    );
    if (employee_id) {
      pool.query(
        `INSERT INTO notifications (employee_id, type, title, message, module, link) VALUES ($1,'task','CAPA Assigned',$2,'quality','/quality/capa')`,
        [employee_id, `CAPA assigned: ${String(description).slice(0, 100)}`]
      ).catch(() => {});
    }
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.put('/capa/:id', canCreate, async (req, res) => {
  try {
    const { status, completion_date, effectiveness_rating, description, due_date } = req.body;
    const { rows } = await pool.query(
      `UPDATE capa_actions SET status=COALESCE($1,status), completion_date=COALESCE($2,completion_date),
       effectiveness_rating=COALESCE($3,effectiveness_rating), description=COALESCE($4,description),
       due_date=COALESCE($5,due_date), updated_at=NOW() WHERE id=$6 RETURNING *`,
      [status, completion_date, effectiveness_rating, description, due_date, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/capa/:id/verify', canManage, async (req, res) => {
  try {
    const { effectiveness_rating } = req.body;
    const empRow = await pool.query('SELECT name FROM employees WHERE id=$1', [uid(req)]).catch(() => ({ rows: [] }));
    const verifierName = empRow.rows[0]?.name || req.user?.name || 'Unknown';
    const { rows } = await pool.query(
      `UPDATE capa_actions SET status='verified', verifier_id=$1, verified_at=NOW(), verified_by_name=$2,
       effectiveness_rating=COALESCE($3,effectiveness_rating), updated_at=NOW() WHERE id=$4 RETURNING *`,
      [uid(req), verifierName, effectiveness_rating, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    logAudit({ userId: uid(req), module: 'quality', recordId: req.params.id, recordType: 'capa_action', action: 'verify', newData: { verified_by: verifierName, effectiveness_rating }, req });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── CALIBRATION EQUIPMENT (ISO 9001 §7.1.5) ────────────────────────────── */
router.get('/calibration/equipment', canView, async (req, res) => {
  try {
    const { status, department, due_within_days, export: doExport } = req.query;
    const companyId = cid(req);
    const params = [companyId];
    let q = `SELECT e.*, o.name as owner_name_resolved FROM calibration_equipment e
      LEFT JOIN employees o ON o.id = e.owner_id
      WHERE ($1::int IS NULL OR e.company_id=$1) AND e.deleted_at IS NULL`;
    if (status)     { params.push(status);     q += ` AND e.calibration_status=$${params.length}`; }
    if (department) { params.push(department); q += ` AND e.department=$${params.length}`; }
    if (due_within_days) {
      params.push(parseInt(due_within_days));
      q += ` AND e.next_calibration_date <= (CURRENT_DATE + ($${params.length} || ' days')::INTERVAL)`;
    }
    q += ' ORDER BY e.next_calibration_date ASC NULLS LAST';
    const { rows } = await pool.query(q, params);
    if (doExport === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="calibration_equipment.csv"');
      return res.send(toCSV(rows));
    }
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/calibration/equipment', canManage, async (req, res) => {
  try {
    const { equipment_id, name, description, make, manufacturer, model, serial_number, location, department, category, range_min, range_max, unit, accuracy_class, calibration_frequency_days = 365, owner_id, notes, next_calibration_date } = req.body;
    if (!name || !equipment_id) return res.status(400).json({ success: false, error: 'name and equipment_id required' });
    const companyId = cid(req);
    const { rows } = await pool.query(
      `INSERT INTO calibration_equipment (company_id, equipment_id, name, description, make, model, serial_number, location, department, category, range_min, range_max, unit, accuracy_class, calibration_frequency_days, owner_id, notes, calibration_status, next_calibration_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'due',$18) RETURNING *`,
      [companyId, equipment_id, name, description, make || manufacturer, model, serial_number, location, department, category, range_min || null, range_max || null, unit, accuracy_class, calibration_frequency_days, owner_id || null, notes, next_calibration_date || null]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.put('/calibration/equipment/:id', canManage, async (req, res) => {
  try {
    const f = req.body;
    const { rows } = await pool.query(
      `UPDATE calibration_equipment SET name=COALESCE($1,name), make=COALESCE($2,make), model=COALESCE($3,model),
       serial_number=COALESCE($4,serial_number), location=COALESCE($5,location), department=COALESCE($6,department),
       category=COALESCE($7,category), calibration_frequency_days=COALESCE($8,calibration_frequency_days),
       status=COALESCE($9,status), owner_id=COALESCE($10,owner_id), notes=COALESCE($11,notes), updated_at=NOW()
       WHERE id=$12 AND deleted_at IS NULL RETURNING *`,
      [f.name, f.make, f.model, f.serial_number, f.location, f.department, f.category, f.calibration_frequency_days, f.status, f.owner_id, f.notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/calibration/equipment/:id', canAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE calibration_equipment SET deleted_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── CALIBRATION RECORDS ─────────────────────────────────────────────────── */
router.get('/calibration/records', canView, async (req, res) => {
  try {
    const { equipment_id, result } = req.query;
    const companyId = cid(req);
    const params = [companyId];
    let q = `SELECT r.*, e.name as equipment_name, e.equipment_id as equipment_code, e.serial_number, e.location, e.department
      FROM calibration_records r JOIN calibration_equipment e ON e.id = r.equipment_id WHERE ($1::int IS NULL OR r.company_id=$1)`;
    if (equipment_id) { params.push(equipment_id); q += ` AND r.equipment_id=$${params.length}`; }
    if (result)       { params.push(result);       q += ` AND r.result=$${params.length}`; }
    q += ' ORDER BY r.calibration_date DESC';
    const { rows } = await pool.query(q, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/calibration/records', canCreate, async (req, res) => {
  try {
    const { equipment_id, calibration_date, next_due_date, performed_by, performed_by_id, calibrating_lab, certificate_number, certificate_url, standard_used, traceability, result = 'pass', as_found_condition, as_left_condition, remarks } = req.body;
    if (!equipment_id || !calibration_date) return res.status(400).json({ success: false, error: 'equipment_id and calibration_date required' });
    const companyId = cid(req);
    const { rows } = await pool.query(
      `INSERT INTO calibration_records (company_id, equipment_id, calibration_date, next_due_date, performed_by, performed_by_id, calibrating_lab, certificate_number, certificate_url, standard_used, traceability, result, as_found_condition, as_left_condition, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [companyId, equipment_id, calibration_date, next_due_date || null, performed_by, performed_by_id || null, calibrating_lab, certificate_number, certificate_url, standard_used, traceability, result, as_found_condition, as_left_condition, remarks]
    );
    const newStatus = result === 'pass' ? 'calibrated' : 'expired';
    await pool.query(
      'UPDATE calibration_equipment SET last_calibration_date=$1, next_calibration_date=$2, calibration_status=$3, certificate_number=$4, updated_at=NOW() WHERE id=$5',
      [calibration_date, next_due_date, newStatus, certificate_number, equipment_id]
    );
    logAudit({ userId: uid(req), module: 'quality', recordId: rows[0].id, recordType: 'calibration_record', action: 'create', newData: { equipment_id, result, calibration_date }, req });
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/calibration/due-alerts', canView, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT e.*, o.name as owner_name FROM calibration_equipment e LEFT JOIN employees o ON o.id=e.owner_id
       WHERE ($1::int IS NULL OR e.company_id=$1) AND e.deleted_at IS NULL AND e.status='active'
       AND e.next_calibration_date IS NOT NULL
       AND e.next_calibration_date <= (CURRENT_DATE + ($2 || ' days')::INTERVAL)
       ORDER BY e.next_calibration_date ASC`,
      [companyId, parseInt(days)]
    );
    res.json({ success: true, data: rows, count: rows.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── PUNCH POINTS (FAT/SAT) ──────────────────────────────────────────────── */
router.get('/punch-points', canView, async (req, res) => {
  try {
    const { test_run_id, status } = req.query;
    const companyId = cid(req);
    const params = [companyId];
    let q = `SELECT p.*, e.name as assigned_name FROM punch_points p LEFT JOIN employees e ON e.id=p.assigned_to_id WHERE ($1::int IS NULL OR p.company_id=$1)`;
    if (test_run_id) { params.push(test_run_id); q += ` AND p.test_run_id=$${params.length}`; }
    if (status)      { params.push(status);      q += ` AND p.status=$${params.length}`; }
    q += ' ORDER BY p.created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/punch-points', canCreate, async (req, res) => {
  try {
    const { test_run_id, description, raised_by, assigned_to, assigned_to_id, severity, due_date } = req.body;
    if (!test_run_id || !description) return res.status(400).json({ success: false, error: 'test_run_id and description required' });
    const companyId = cid(req);
    const { rows } = await pool.query(
      `INSERT INTO punch_points (test_run_id, company_id, description, raised_by, assigned_to, assigned_to_id, severity, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [test_run_id, companyId, description, raised_by, assigned_to, assigned_to_id || null, severity || 'minor', due_date || null]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.put('/punch-points/:id', canCreate, async (req, res) => {
  try {
    const { status, remarks } = req.body;
    const extra = status === 'closed' ? ', closed_at=NOW()' : '';
    const { rows } = await pool.query(
      `UPDATE punch_points SET status=$1${extra}, remarks=COALESCE($2,remarks), updated_at=NOW() WHERE id=$3 RETURNING *`,
      [status, remarks, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── TEST RUNS (FAT / SAT) ───────────────────────────────────────────────── */
router.get('/test-runs', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    const { test_type, production_order_id, limit = 50 } = req.query;
    let q = `SELECT tr.*, e.name as created_by_name,
               COALESCE(json_agg(pp.*) FILTER (WHERE pp.id IS NOT NULL), '[]') as punch_points
             FROM test_runs tr
             LEFT JOIN employees e ON e.id=tr.created_by
             LEFT JOIN punch_points pp ON pp.test_run_id=tr.id
             WHERE ($1::int IS NULL OR tr.company_id=$1)`;
    const params = [companyId];
    if (test_type) { params.push(test_type); q += ` AND tr.test_type=$${params.length}`; }
    if (production_order_id) { params.push(production_order_id); q += ` AND tr.production_order_id=$${params.length}`; }
    params.push(parseInt(limit) || 50);
    q += ` GROUP BY tr.id, e.name ORDER BY tr.created_at DESC LIMIT $${params.length}`;
    const { rows } = await pool.query(q, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/test-runs/:id', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT tr.*, COALESCE(json_agg(pp.*) FILTER (WHERE pp.id IS NOT NULL), '[]') as punch_points
       FROM test_runs tr
       LEFT JOIN punch_points pp ON pp.test_run_id=tr.id
       WHERE tr.id=$1 AND ($2::int IS NULL OR tr.company_id=$2)
       GROUP BY tr.id`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/test-runs', canCreate, async (req, res) => {
  try {
    const companyId = cid(req);
    const userId = uid(req);
    const { test_type = 'FAT', title, production_order_id, customer_witness, customer_witness_date, site_location, project_id, notes, template_id } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'title required' });
    const { rows } = await pool.query(
      `INSERT INTO test_runs (company_id, test_type, title, status, production_order_id, customer_witness, customer_witness_date, site_location, project_id, notes, template_id, created_by)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [companyId, test_type, title, production_order_id || null, customer_witness || null, customer_witness_date || null, site_location || null, project_id || null, notes || null, template_id || null, userId]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.put('/test-runs/:id', canCreate, async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, result, measurements, customer_accepted, customer_accepted_at, ncr_id } = req.body;
    const fields = ['updated_at=NOW()'];
    const params = [req.params.id, companyId];
    const add = (val, expr) => { params.push(val); fields.push(`${expr}=$${params.length}`); };
    if (status !== undefined)             add(status, 'status');
    if (result !== undefined)             add(result, 'result');
    if (measurements !== undefined)       add(JSON.stringify(measurements), 'measurements');
    if (customer_accepted !== undefined)  add(customer_accepted, 'customer_accepted');
    if (customer_accepted_at !== undefined) add(customer_accepted_at, 'customer_accepted_at');
    if (ncr_id !== undefined)             add(ncr_id, 'ncr_id');
    if (result === 'passed')              { params.push(false); fields.push(`dispatch_blocked=$${params.length}`); }
    const { rows } = await pool.query(
      `UPDATE test_runs SET ${fields.join(',')} WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── SUPPLIER QUALITY ────────────────────────────────────────────────────── */
router.get('/supplier-quality', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT v.id, v.vendor_name, v.vendor_code,
        COALESCE(v.quality_rating, 0) as quality_rating,
        COALESCE(v.delivery_rating, 0) as delivery_rating,
        COALESCE(v.price_rating, 0) as price_rating,
        COALESCE(v.defect_rate, 0) as defect_rate,
        COUNT(DISTINCT n.id) as total_ncrs,
        COUNT(DISTINCT n.id) FILTER (WHERE n.severity='critical') as critical_ncrs,
        COUNT(DISTINCT n.id) FILTER (WHERE n.status!='closed') as open_ncrs,
        0 as total_grns,
        0 as ppm
       FROM vendors v
       LEFT JOIN ncr_reports n ON n.vendor_id=v.id AND ($1::int IS NULL OR n.company_id=$1)
       WHERE ($1::int IS NULL OR v.company_id=$1)
       GROUP BY v.id, v.vendor_name, v.vendor_code, v.quality_rating, v.delivery_rating, v.price_rating, v.defect_rate
       ORDER BY total_ncrs DESC`,
      [companyId]
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/supplier-quality/:vendorId', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    const { vendorId } = req.params;
    const [vendorRes, ncrsRes, grnsRes] = await Promise.all([
      pool.query('SELECT * FROM vendors WHERE id=$1', [vendorId]),
      pool.query(`SELECT n.*, g.grn_number FROM ncr_reports n LEFT JOIN goods_receipt_notes g ON g.id=n.grn_id WHERE n.vendor_id=$1 AND ($2::int IS NULL OR n.company_id=$2) ORDER BY n.created_at DESC LIMIT 20`, [vendorId, companyId]),
      pool.query(`SELECT g.*, ir.status as inspection_status FROM goods_receipt_notes g LEFT JOIN inspection_reports ir ON ir.grn_id=g.id WHERE g.vendor_id=$1 AND ($2::int IS NULL OR g.company_id=$2) ORDER BY g.created_at DESC LIMIT 20`, [vendorId, companyId]),
    ]);
    if (!vendorRes.rows.length) return res.status(404).json({ success: false, error: 'Vendor not found' });
    res.json({ success: true, data: { vendor: vendorRes.rows[0], ncrs: ncrsRes.rows, grns: grnsRes.rows } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── QUALITY SETTINGS ────────────────────────────────────────────────────── */
router.get('/settings', canManage, async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query('SELECT * FROM quality_settings WHERE company_id=$1', [companyId]);
    const defaults = { require_iqc_before_stock: true, iqc_auto_ncr_on_fail: true, iqc_sampling_plan: 'AQL2.5', ncr_auto_number_prefix: 'NCR', ncr_approval_required: true, ncr_escalate_critical_mins: 60, ncr_containment_required: true, capa_default_due_days: 14, capa_verification_required: true, capa_auto_notify_assignee: true, capa_overdue_notify_days: 2, calibration_alert_days: 30, fat_customer_witness_req: false, fat_punch_point_closure_req: true, fat_dispatch_gate: true, sat_customer_signoff_req: true };
    res.json({ success: true, data: rows[0] || defaults });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.put('/settings', canAdmin, async (req, res) => {
  try {
    const companyId = cid(req);
    const s = req.body;
    const { rows } = await pool.query(
      `INSERT INTO quality_settings (company_id,require_iqc_before_stock,iqc_auto_ncr_on_fail,iqc_sampling_plan,ncr_auto_number_prefix,ncr_approval_required,ncr_escalate_critical_mins,ncr_containment_required,capa_default_due_days,capa_verification_required,capa_auto_notify_assignee,capa_overdue_notify_days,calibration_alert_days,fat_customer_witness_req,fat_punch_point_closure_req,fat_dispatch_gate,sat_customer_signoff_req,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
       ON CONFLICT (company_id) DO UPDATE SET
         require_iqc_before_stock=EXCLUDED.require_iqc_before_stock,iqc_auto_ncr_on_fail=EXCLUDED.iqc_auto_ncr_on_fail,
         iqc_sampling_plan=EXCLUDED.iqc_sampling_plan,ncr_auto_number_prefix=EXCLUDED.ncr_auto_number_prefix,
         ncr_approval_required=EXCLUDED.ncr_approval_required,ncr_escalate_critical_mins=EXCLUDED.ncr_escalate_critical_mins,
         ncr_containment_required=EXCLUDED.ncr_containment_required,capa_default_due_days=EXCLUDED.capa_default_due_days,
         capa_verification_required=EXCLUDED.capa_verification_required,capa_auto_notify_assignee=EXCLUDED.capa_auto_notify_assignee,
         capa_overdue_notify_days=EXCLUDED.capa_overdue_notify_days,calibration_alert_days=EXCLUDED.calibration_alert_days,
         fat_customer_witness_req=EXCLUDED.fat_customer_witness_req,fat_punch_point_closure_req=EXCLUDED.fat_punch_point_closure_req,
         fat_dispatch_gate=EXCLUDED.fat_dispatch_gate,sat_customer_signoff_req=EXCLUDED.sat_customer_signoff_req,updated_at=NOW()
       RETURNING *`,
      [companyId,s.require_iqc_before_stock??true,s.iqc_auto_ncr_on_fail??true,s.iqc_sampling_plan??'AQL2.5',s.ncr_auto_number_prefix??'NCR',s.ncr_approval_required??true,s.ncr_escalate_critical_mins??60,s.ncr_containment_required??true,s.capa_default_due_days??14,s.capa_verification_required??true,s.capa_auto_notify_assignee??true,s.capa_overdue_notify_days??2,s.calibration_alert_days??30,s.fat_customer_witness_req??false,s.fat_punch_point_closure_req??true,s.fat_dispatch_gate??true,s.sat_customer_signoff_req??true]
    );
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── QUALITY DASHBOARD ───────────────────────────────────────────────────── */
router.get('/dashboard', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    const cp = [companyId];
    const [pr, ncrs, capas, cats, insp, cal, punch, recent] = await Promise.allSettled([
      pool.query(`SELECT COUNT(*) FILTER (WHERE status='pass') as passed,COUNT(*) as total FROM inspection_reports WHERE inspected_at>=date_trunc('month',NOW()) AND ($1::int IS NULL OR company_id=$1)`, cp),
      pool.query(`SELECT severity,COUNT(*) as count FROM ncr_reports WHERE status!='closed' AND ($1::int IS NULL OR company_id=$1) GROUP BY severity`, cp),
      pool.query(`SELECT COUNT(*) as count FROM capa_actions WHERE status NOT IN ('completed','verified') AND due_date<NOW() AND ($1::int IS NULL OR company_id=$1)`, cp),
      pool.query(`SELECT COALESCE(type,'general') as category,COUNT(*) as count FROM ncr_reports WHERE created_at>=NOW()-INTERVAL '90 days' AND ($1::int IS NULL OR company_id=$1) GROUP BY type ORDER BY count DESC LIMIT 5`, cp),
      pool.query(`SELECT COUNT(*) as total FROM inspection_reports WHERE ($1::int IS NULL OR company_id=$1)`, cp),
      pool.query(`SELECT COUNT(*) as count FROM calibration_equipment WHERE calibration_status IN ('due','overdue','expired') AND deleted_at IS NULL AND ($1::int IS NULL OR company_id=$1)`, cp),
      pool.query(`SELECT COUNT(*) as count FROM punch_points WHERE status NOT IN ('closed','waived') AND ($1::int IS NULL OR company_id=$1)`, cp),
      pool.query(`SELECT n.ncr_number,n.title,n.severity,n.status,n.created_at,v.name as vendor_name FROM ncr_reports n LEFT JOIN vendors v ON v.id=n.vendor_id WHERE ($1::int IS NULL OR n.company_id=$1) ORDER BY n.created_at DESC LIMIT 5`, cp),
    ]);
    const p = pr.status === 'fulfilled' ? pr.value.rows[0] : { passed: 0, total: 0 };
    const passRatePct = parseInt(p.total) > 0 ? Math.round(parseInt(p.passed) * 100 / parseInt(p.total)) : 0;
    const ncrBySeverity = { critical: 0, major: 0, minor: 0 };
    if (ncrs.status === 'fulfilled') ncrs.value.rows.forEach(r => { ncrBySeverity[r.severity] = parseInt(r.count); });
    res.json({
      pass_rate_pct: passRatePct,
      inspections_this_month: parseInt(p.total),
      open_ncrs_total: Object.values(ncrBySeverity).reduce((a, b) => a + b, 0),
      open_ncrs_by_severity: ncrBySeverity,
      overdue_capas: parseInt(capas.status === 'fulfilled' ? capas.value.rows[0].count : 0),
      top_defect_categories: cats.status === 'fulfilled' ? cats.value.rows : [],
      total_inspections: parseInt(insp.status === 'fulfilled' ? insp.value.rows[0].total : 0),
      calibration_due_count: parseInt(cal.status === 'fulfilled' ? cal.value.rows[0].count : 0),
      open_punch_points: parseInt(punch.status === 'fulfilled' ? punch.value.rows[0].count : 0),
      recent_ncrs: recent.status === 'fulfilled' ? recent.value.rows : [],
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── REPORTS ─────────────────────────────────────────────────────────────── */
router.get('/reports/ncr-trend', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    const { months = 6 } = req.query;
    const { rows } = await pool.query(
      `SELECT to_char(date_trunc('month',created_at),'YYYY-MM') as month,
        COUNT(*) as total,COUNT(*) FILTER (WHERE severity='critical') as critical,
        COUNT(*) FILTER (WHERE severity='major') as major,COUNT(*) FILTER (WHERE status='closed') as closed
       FROM ncr_reports WHERE created_at>=NOW()-($1||' months')::INTERVAL AND ($2::int IS NULL OR company_id=$2)
       GROUP BY date_trunc('month',created_at) ORDER BY 1`,
      [parseInt(months), companyId]
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/reports/inspection-summary', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    const { from, to } = req.query;
    const params = [companyId];
    let where = 'WHERE ($1::int IS NULL OR r.company_id=$1)';
    if (from) { params.push(from); where += ` AND r.inspected_at>=$${params.length}`; }
    if (to)   { params.push(to);   where += ` AND r.inspected_at<=$${params.length}`; }
    const { rows } = await pool.query(
      `SELECT c.type as inspection_type,COUNT(*) as total,COUNT(*) FILTER (WHERE r.status='pass') as passed,
        COUNT(*) FILTER (WHERE r.status='fail') as failed,
        ROUND(COUNT(*) FILTER (WHERE r.status='pass')*100.0/GREATEST(COUNT(*),1),1) as pass_rate
       FROM inspection_reports r JOIN inspection_checklists c ON c.id=r.checklist_id ${where} GROUP BY c.type ORDER BY total DESC`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── QUALITY TESTS (material-in-stores + all production levels) ──────────────
 * Flexible, N-per-source test rows. A "source" is polymorphic: a GRN (material
 * received into Stores) or a production_operation (any level of production).
 * The Quality department decides how many tests to run and records each result;
 * a failing test can auto-raise an NCR and rolls the parent's quality_status up. */

// Evaluate pass/fail from a numeric spec window, else fall back to expected_value
function evaluateTestResult({ actual_value, spec_min, spec_max, expected_value }) {
  if (actual_value == null || actual_value === '') return 'pending';
  const num = parseFloat(actual_value);
  const hasNumericSpec = spec_min != null || spec_max != null;
  if (hasNumericSpec && !Number.isNaN(num)) {
    if (spec_min != null && num < parseFloat(spec_min)) return 'fail';
    if (spec_max != null && num > parseFloat(spec_max)) return 'fail';
    return 'pass';
  }
  if (expected_value != null && String(expected_value).trim() !== '') {
    return String(actual_value).trim().toLowerCase() === String(expected_value).trim().toLowerCase()
      ? 'pass' : 'fail';
  }
  return 'pending'; // recorded but pass/fail decided by inspector via explicit result
}

// Recompute the parent source's overall quality_status from its tests
async function rollupQualityStatus({ grn_id, operation_id }) {
  const bucket = async (idCol, idVal, table, statusCol) => {
    if (!idVal) return;
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE result='fail') AS failed,
         COUNT(*) FILTER (WHERE status='completed') AS done,
         COUNT(*) AS total
       FROM quality_tests WHERE ${idCol}=$1`, [idVal]);
    const r = rows[0];
    let status;
    if (parseInt(r.total) === 0)        status = 'not_required';
    else if (parseInt(r.failed) > 0)    status = 'failed';
    else if (parseInt(r.done) === parseInt(r.total)) status = 'passed';
    else if (parseInt(r.done) > 0)      status = 'in_progress';
    else                                status = 'pending';
    await pool.query(`UPDATE ${table} SET ${statusCol}=$1 WHERE id=$2`, [status, idVal]).catch(() => {});
  };
  await bucket('grn_id', grn_id, 'goods_receipt_notes', 'quality_status');
  await bucket('operation_id', operation_id, 'production_operations', 'quality_status');
}

// GET /quality/tests — list with source filters
router.get('/tests', canView, async (req, res) => {
  try {
    const { source_type, source_id, grn_id, production_order_id, operation_id, status, result, stage, limit = 200 } = req.query;
    const companyId = cid(req);
    const params = [companyId];
    let q = `SELECT t.*, e.name AS assigned_name, g.grn_number, po.production_order_no AS production_order_number
             FROM quality_tests t
             LEFT JOIN employees e ON e.id = t.assigned_to
             LEFT JOIN goods_receipt_notes g ON g.id = t.grn_id
             LEFT JOIN production_orders po ON po.id = t.production_order_id
             WHERE ($1::int IS NULL OR t.company_id=$1)`;
    if (source_type)         { params.push(source_type);         q += ` AND t.source_type=$${params.length}`; }
    if (source_id)           { params.push(source_id);           q += ` AND t.source_id=$${params.length}`; }
    if (grn_id)              { params.push(grn_id);              q += ` AND t.grn_id=$${params.length}`; }
    if (production_order_id) { params.push(production_order_id); q += ` AND t.production_order_id=$${params.length}`; }
    if (operation_id)        { params.push(operation_id);        q += ` AND t.operation_id=$${params.length}`; }
    if (status)              { params.push(status);              q += ` AND t.status=$${params.length}`; }
    if (result)              { params.push(result);              q += ` AND t.result=$${params.length}`; }
    if (stage)               { params.push(stage);               q += ` AND t.stage=$${params.length}`; }
    params.push(parseInt(limit)); q += ` ORDER BY t.created_at DESC LIMIT $${params.length}`;
    const { rows } = await pool.query(q, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /quality/tests/summary — pending/pass/fail counts (Quality dept worklist)
router.get('/tests/summary', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE result='pending') AS pending,
         COUNT(*) FILTER (WHERE result='pass') AS passed,
         COUNT(*) FILTER (WHERE result='fail') AS failed,
         COUNT(*) FILTER (WHERE source_type='grn') AS material_tests,
         COUNT(*) FILTER (WHERE source_type IN ('production_operation','production_order')) AS production_tests
       FROM quality_tests WHERE ($1::int IS NULL OR company_id=$1)`, [companyId]);
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Normalise + insert one test row
async function insertQualityTest(t, companyId, userId) {
  const grn_id = t.grn_id || (t.source_type === 'grn' ? t.source_id : null) || null;
  const operation_id = t.operation_id || (t.source_type === 'production_operation' ? t.source_id : null) || null;
  const { rows } = await pool.query(
    `INSERT INTO quality_tests
       (company_id, source_type, source_id, grn_id, production_order_id, operation_id, item_id, item_name,
        batch_number, stage, test_name, test_method, parameter, spec_min, spec_max, unit, expected_value,
        is_mandatory, assigned_to, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [companyId, t.source_type, t.source_id || grn_id || operation_id || null, grn_id,
     t.production_order_id || null, operation_id, t.item_id || null, t.item_name || null,
     t.batch_number || null, t.stage || 'IQC', t.test_name, t.test_method || null, t.parameter || null,
     t.spec_min ?? null, t.spec_max ?? null, t.unit || null, t.expected_value || null,
     t.is_mandatory !== false, t.assigned_to || null, userId]
  );
  return rows[0];
}

// POST /quality/tests — create one test or a batch { tests: [...] }
router.post('/tests', canCreate, async (req, res) => {
  try {
    const companyId = cid(req);
    const userId = uid(req);
    const list = Array.isArray(req.body.tests) ? req.body.tests : [req.body];
    if (!list.length || list.some(t => !t.test_name || !t.source_type)) {
      return res.status(400).json({ success: false, error: 'each test needs test_name and source_type' });
    }
    const created = [];
    for (const t of list) created.push(await insertQualityTest(t, companyId, userId));
    // Roll parent status to at least 'pending'
    await rollupQualityStatus({ grn_id: created[0].grn_id, operation_id: created[0].operation_id });
    logAudit({ userId, module: 'quality', recordId: created[0].id, recordType: 'quality_test', action: 'create', newData: { count: created.length, source_type: list[0].source_type }, req });
    res.status(201).json({ success: true, data: created });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /quality/tests/from-grn/:grnId — link a stores material lot to Quality by
// seeding one pending test per GRN line item, and flag the GRN for inspection
router.post('/tests/from-grn/:grnId', canCreate, async (req, res) => {
  try {
    const companyId = cid(req);
    const userId = uid(req);
    const grnId = parseInt(req.params.grnId, 10);
    const { assigned_to, tests: customTests } = req.body;
    const grn = await pool.query('SELECT id, grn_number FROM goods_receipt_notes WHERE id=$1', [grnId]);
    if (!grn.rows.length) return res.status(404).json({ success: false, error: 'GRN not found' });
    const items = await pool.query(
      `SELECT gi.item_id, COALESCE(gi.item_name, ii.item_name) AS item_name
       FROM grn_items gi LEFT JOIN inventory_items ii ON ii.id = gi.item_id WHERE gi.grn_id=$1`, [grnId]);
    const created = [];
    if (Array.isArray(customTests) && customTests.length) {
      for (const t of customTests) {
        created.push(await insertQualityTest({ ...t, source_type: 'grn', grn_id: grnId, assigned_to: t.assigned_to || assigned_to }, companyId, userId));
      }
    } else {
      // Default: one incoming-quality check per received item
      const lines = items.rows.length ? items.rows : [{ item_id: null, item_name: 'Received material' }];
      for (const it of lines) {
        created.push(await insertQualityTest({
          source_type: 'grn', grn_id: grnId, item_id: it.item_id, item_name: it.item_name,
          stage: 'IQC', test_name: `Incoming quality check — ${it.item_name || 'material'}`,
          assigned_to,
        }, companyId, userId));
      }
    }
    await pool.query(`UPDATE goods_receipt_notes SET quality_status='pending', updated_at=NOW() WHERE id=$1`, [grnId]).catch(() => {});
    logAudit({ userId, module: 'quality', recordId: grnId, recordType: 'grn', action: 'send_to_quality', newData: { grn_number: grn.rows[0].grn_number, tests: created.length }, req });
    res.status(201).json({ success: true, data: created });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// PUT /quality/tests/:id — record a reading / result; auto-evaluate + auto-NCR on fail
router.put('/tests/:id', canCreate, async (req, res) => {
  try {
    const companyId = cid(req);
    const userId = uid(req);
    const { actual_value, remarks, assigned_to, test_name, parameter, spec_min, spec_max, unit, expected_value, test_method, is_mandatory } = req.body;
    let { result, status } = req.body;
    const cur = await pool.query('SELECT * FROM quality_tests WHERE id=$1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const row = cur.rows[0];
    const effSpecMin = spec_min !== undefined ? spec_min : row.spec_min;
    const effSpecMax = spec_max !== undefined ? spec_max : row.spec_max;
    const effExpected = expected_value !== undefined ? expected_value : row.expected_value;
    // Auto-evaluate result from the reading unless caller set it explicitly
    if (result === undefined && actual_value !== undefined) {
      result = evaluateTestResult({ actual_value, spec_min: effSpecMin, spec_max: effSpecMax, expected_value: effExpected });
    }
    if (status === undefined && result && result !== 'pending') status = 'completed';
    const testedName = (await pool.query('SELECT name FROM employees WHERE id=$1', [userId]).catch(() => ({ rows: [] }))).rows[0]?.name || req.user?.name || null;
    const { rows } = await pool.query(
      `UPDATE quality_tests SET
         actual_value=COALESCE($1,actual_value), result=COALESCE($2,result), status=COALESCE($3,status),
         remarks=COALESCE($4,remarks), assigned_to=COALESCE($5,assigned_to), test_name=COALESCE($6,test_name),
         parameter=COALESCE($7,parameter), spec_min=$8, spec_max=$9, unit=COALESCE($10,unit),
         expected_value=COALESCE($11,expected_value), test_method=COALESCE($12,test_method),
         is_mandatory=COALESCE($13,is_mandatory),
         tested_by=CASE WHEN $2 IS NOT NULL THEN $14 ELSE tested_by END,
         tested_by_name=CASE WHEN $2 IS NOT NULL THEN $15 ELSE tested_by_name END,
         tested_at=CASE WHEN $2 IS NOT NULL AND $2<>'pending' THEN NOW() ELSE tested_at END,
         updated_at=NOW()
       WHERE id=$16 RETURNING *`,
      [actual_value ?? null, result ?? null, status ?? null, remarks ?? null, assigned_to ?? null,
       test_name ?? null, parameter ?? null, effSpecMin ?? null, effSpecMax ?? null, unit ?? null,
       effExpected ?? null, test_method ?? null, is_mandatory ?? null, userId, testedName, req.params.id]
    );
    const updated = rows[0];
    // Auto-NCR on failure (governed by quality_settings)
    let autoNcr = null;
    if (result === 'fail' && row.result !== 'fail') {
      const settings = await pool.query('SELECT iqc_auto_ncr_on_fail, ncr_auto_number_prefix FROM quality_settings WHERE company_id=$1', [companyId]).catch(() => ({ rows: [] }));
      if (settings.rows[0]?.iqc_auto_ncr_on_fail) {
        const prefix = settings.rows[0]?.ncr_auto_number_prefix || 'NCR';
        const ncrNum = `${prefix}-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`;
        const source = updated.source_type === 'grn' ? 'procurement' : 'production';
        const refType = updated.source_type === 'grn' ? 'grn' : 'production_operation';
        const nr = await pool.query(
          `INSERT INTO ncr_reports (title, description, ncr_number, detected_by, reference_type, reference_id, grn_id, severity, source, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'major',$8,$9) RETURNING *`,
          [`Quality test failed — ${updated.test_name}`,
           `Test "${updated.test_name}" failed. Reading: ${actual_value ?? ''} ${updated.unit || ''}. ${remarks || ''}`.trim(),
           ncrNum, testedName, refType, updated.source_id || updated.operation_id, updated.grn_id || null, source, companyId]
        ).catch(() => ({ rows: [] }));
        if (nr.rows[0]) {
          autoNcr = nr.rows[0];
          await pool.query('UPDATE quality_tests SET ncr_id=$1 WHERE id=$2', [autoNcr.id, updated.id]).catch(() => {});
        }
      }
    }
    await rollupQualityStatus({ grn_id: updated.grn_id, operation_id: updated.operation_id });
    logAudit({ userId, module: 'quality', recordId: updated.id, recordType: 'quality_test', action: 'result', newData: { result: updated.result }, req });
    res.json({ success: true, data: updated, auto_ncr: autoNcr });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// DELETE /quality/tests/:id
router.delete('/tests/:id', canManage, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM quality_tests WHERE id=$1 RETURNING grn_id, operation_id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    await rollupQualityStatus({ grn_id: rows[0].grn_id, operation_id: rows[0].operation_id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── TRACEABILITY ────────────────────────────────────────────────────────── */
const TRACEABLE_TYPES = ['fat_report','sat_report','commissioning','serial','service_report','qc'];

router.get('/traceability/:entityType/:entityId/documents', canView, async (req, res) => {
  const { entityType, entityId } = req.params;
  if (!TRACEABLE_TYPES.includes(entityType)) return res.status(400).json({ error: `Unsupported entity type: ${entityType}` });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM document_master WHERE linked_entity_type=$1 AND linked_entity_id=$2 AND deleted_at IS NULL ORDER BY revision DESC',
      [entityType, parseInt(entityId)]
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/traceability/:entityType/:entityId/signatures', canView, async (req, res) => {
  const { entityType, entityId } = req.params;
  if (!TRACEABLE_TYPES.includes(entityType)) return res.status(400).json({ error: `Unsupported entity type: ${entityType}` });
  try {
    const { rows } = await pool.query(
      `SELECT s.*,(SELECT json_agg(al ORDER BY al.occurred_at) FROM signature_audit_log al WHERE al.signing_id=s.id) AS audit_trail
       FROM document_signings s WHERE s.linked_entity_type=$1 AND s.linked_entity_id=$2 ORDER BY s.created_at`,
      [entityType, parseInt(entityId)]
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
