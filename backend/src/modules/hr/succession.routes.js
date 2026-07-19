// backend/src/modules/hr/succession.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();

/* ─── RBAC helpers ─────────────────────────────────────────────────────────── */
const userRole  = req => req.user?.role ?? 'employee';
const isHRPlus  = req => ['hr','super_admin','admin'].includes(userRole(req));
const isMgrPlus = req => ['manager','hr','super_admin','admin'].includes(userRole(req));
function guard(req, res, fn) {
  if (!fn(req)) return res.status(403).json({ message: 'Forbidden' });
}

/* ─── helpers ────────────────────────────────────────────────────────────── */

function scoreToAxis(score) {
  if (score <= 2) return 1;
  if (score <= 3) return 2;
  return 3;
}

const CELL_LABELS = {
  '3_3': 'Stars',                 '3_2': 'High Performers',   '3_1': 'Workhorses',
  '2_3': 'Diamonds in the Rough', '2_2': 'Core Contributors', '2_1': 'Inconsistent Players',
  '1_3': 'Question Marks',        '1_2': 'Underperformers',   '1_1': 'Deadwood',
};

function cidClause(cid, params, alias = '') {
  if (cid == null) return '';
  const col = alias ? `${alias}.company_id` : 'company_id';
  params.push(cid);
  return ` AND ${col} = $${params.length}`;
}

const getCid = (req) => req.scope?.company_id ?? companyOf(req);

// HR-level roles allowed to write succession data
const HR_WRITE_ROLES = new Set(['super_admin','admin','chro','hr_admin','hr_manager']);
const HR_READ_ROLES  = new Set(['super_admin','admin','chro','hr_admin','hr_manager','manager','department_head']);

function requireHRWrite(req, res, next) {
  const role = req.user?.role ?? '';
  if (!HR_WRITE_ROLES.has(role)) {
    return res.status(403).json({ message: 'HR admin access required for this operation' });
  }
  next();
}

function requireHRRead(req, res, next) {
  const role = req.user?.role ?? '';
  if (!HR_READ_ROLES.has(role)) {
    return res.status(403).json({ message: 'Succession data is confidential — HR or Manager access required' });
  }
  next();
}

// CSV helper
function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape  = (v) => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
  };
  return [
    headers.map(escape).join(','),
    ...rows.map(r => headers.map(h => escape(r[h])).join(',')),
  ].join('\n');
}

/* ─── dev-only seed (moved out of startup — only triggers via explicit call) */
if (process.env.NODE_ENV !== 'production' && process.env.RUN_SUCCESSION_SEED === 'true') {
  (async () => {
    try {
      const { rows: cnt } = await pool.query('SELECT COUNT(*) FROM talent_assessments');
      if (parseInt(cnt[0].count) > 0) return;
      const empRes  = await pool.query('SELECT id, company_id FROM employees ORDER BY id LIMIT 12');
      const emps    = empRes.rows;
      if (!emps.length) return;
      const seedCid  = emps[0].company_id ?? null;
      const perfPool = [1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5];
      const potPool  = [1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5];
      const riskPool = ['low','low','low','low','medium','medium','medium','medium','high','high','high','low'];
      const readyPool= ['ready-now','1-2-years','1-2-years','1-2-years','3-5-years','3-5-years',
                        'ready-now','1-2-years','1-2-years','3-5-years','ready-now','1-2-years'];
      for (let i = 0; i < Math.min(emps.length, 12); i++) {
        await pool.query(
          `INSERT INTO talent_assessments
             (employee_id, performance_score, potential_score, flight_risk, readiness, notes, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (employee_id) DO NOTHING`,
          [emps[i].id, perfPool[i], potPool[i], riskPool[i], readyPool[i], 'Auto-generated seed', seedCid]
        );
      }
      await pool.query(
        `INSERT INTO critical_roles (role_title, department, risk_level, reason, company_id) VALUES
         ('Chief Financial Officer', 'Finance',    'high',   'Current holder nearing retirement in 2 years', $1),
         ('Head of Engineering',     'IT',         'high',   'Single point of failure — no deputy', $1),
         ('VP Sales & Marketing',    'Sales',      'medium', 'Frequent competitor poaching attempts', $1),
         ('Production Manager',      'Operations', 'medium', 'Specialised domain knowledge required', $1)`,
        [seedCid]
      );
    } catch (e) { console.error('[succession] seed error:', e.message); }
  })();
}

/* ═══════════════════════════════════════════════════════════════════════════
   TALENT ASSESSMENTS — Full CRUD + history
═══════════════════════════════════════════════════════════════════════════ */

router.get('/assessments', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  const params = [];
  try {
    const { rows } = await pool.query(
      `SELECT ta.id, ta.employee_id, ta.performance_score, ta.potential_score,
              ta.flight_risk, ta.readiness, ta.notes, ta.assessment_date,
              ta.leadership_score, ta.mobility, ta.talent_classification, ta.assessment_period,
              e.name AS employee_name, e.department, e.designation,
              a.name AS assessed_by_name
       FROM talent_assessments ta
       JOIN  employees e ON e.id = ta.employee_id
       LEFT JOIN employees a ON a.id = ta.assessed_by
       WHERE 1=1${cidClause(cid, params, 'ta')}
       ORDER BY ta.potential_score DESC, ta.performance_score DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/assessments', requireHRWrite, async (req, res) => {
  const {
    employee_id, performance_score, potential_score,
    flight_risk = 'low', readiness = '1-2-years', notes,
    leadership_score, mobility = 'flexible', talent_classification, assessment_period,
  } = req.body;
  if (!employee_id || !performance_score || !potential_score)
    return res.status(400).json({ message: 'employee_id, performance_score, potential_score required' });

  const cid        = getCid(req);
  const assessedBy = req.user?.userId ?? null;
  const client     = await pool.connect();
  try {
    await client.query('BEGIN');

    // Snapshot existing assessment into history before overwriting
    await client.query(
      `INSERT INTO talent_assessment_history
         (employee_id, assessed_by, assessment_date, assessment_period, performance_score,
          potential_score, flight_risk, readiness, leadership_score, mobility,
          talent_classification, notes, company_id)
       SELECT employee_id, assessed_by, assessment_date, assessment_period, performance_score,
              potential_score, flight_risk, readiness, leadership_score, mobility,
              talent_classification, notes, company_id
       FROM talent_assessments WHERE employee_id = $1`,
      [employee_id]
    );

    const { rows } = await client.query(
      `INSERT INTO talent_assessments
         (employee_id, assessed_by, performance_score, potential_score,
          flight_risk, readiness, notes, assessment_date, leadership_score,
          mobility, talent_classification, assessment_period, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,$8,$9,$10,$11,$12)
       ON CONFLICT (employee_id) DO UPDATE SET
         performance_score=$3, potential_score=$4, flight_risk=$5,
         readiness=$6, notes=$7, assessed_by=$2, assessment_date=CURRENT_DATE,
         leadership_score=$8, mobility=$9, talent_classification=$10,
         assessment_period=$11
       RETURNING *`,
      [employee_id, assessedBy, performance_score, potential_score, flight_risk,
       readiness, notes, leadership_score || null, mobility,
       talent_classification || null, assessment_period || null, cid]
    );

    // Log perf sync
    await client.query(
      `INSERT INTO succession_perf_sync_log
         (employee_id, source, performance_score, potential_score, synced_by, company_id)
       VALUES ($1,'manual',$2,$3,$4,$5)`,
      [employee_id, performance_score, potential_score, assessedBy, cid]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

router.patch('/assessments/:id', requireHRWrite, async (req, res) => {
  const {
    performance_score, potential_score, flight_risk, readiness, notes,
    leadership_score, mobility, talent_classification, assessment_period,
  } = req.body;
  const cid    = getCid(req);
  const params = [req.params.id, performance_score, potential_score, flight_risk,
                  readiness, notes, leadership_score ?? null, mobility ?? null,
                  talent_classification ?? null, assessment_period ?? null];
  try {
    const { rows } = await pool.query(
      `UPDATE talent_assessments SET
         performance_score    = COALESCE($2, performance_score),
         potential_score      = COALESCE($3, potential_score),
         flight_risk          = COALESCE($4, flight_risk),
         readiness            = COALESCE($5, readiness),
         notes                = COALESCE($6, notes),
         leadership_score     = COALESCE($7, leadership_score),
         mobility             = COALESCE($8, mobility),
         talent_classification= COALESCE($9, talent_classification),
         assessment_period    = COALESCE($10, assessment_period),
         assessment_date      = CURRENT_DATE
       WHERE id = $1${cidClause(cid, params)} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ message: 'Assessment not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/assessments/:id', requireHRWrite, async (req, res) => {
  const cid    = getCid(req);
  const params = [req.params.id];
  try {
    const { rows } = await pool.query(
      `DELETE FROM talent_assessments WHERE id = $1${cidClause(cid, params)} RETURNING id`,
      params
    );
    if (!rows.length) return res.status(404).json({ message: 'Assessment not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Assessment history for an employee
router.get('/assessments/:employeeId/history', requireHRRead, async (req, res) => {
  const cid    = getCid(req);
  const params = [req.params.employeeId];
  try {
    const { rows } = await pool.query(
      `SELECT h.*, e.name AS assessed_by_name
       FROM talent_assessment_history h
       LEFT JOIN employees e ON e.id = h.assessed_by
       WHERE h.employee_id = $1${cidClause(cid, params, 'h')}
       ORDER BY h.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Sync from performance review
router.post('/assessments/sync-from-performance', requireHRWrite, async (req, res) => {
  const { employee_id, performance_score, potential_score } = req.body;
  if (!employee_id || !performance_score)
    return res.status(400).json({ message: 'employee_id and performance_score required' });

  const cid = getCid(req);
  const assessedBy = req.user?.userId ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Snapshot existing
    await client.query(
      `INSERT INTO talent_assessment_history
         (employee_id, assessed_by, assessment_date, performance_score, potential_score,
          flight_risk, readiness, leadership_score, mobility, talent_classification,
          assessment_period, notes, company_id)
       SELECT employee_id, assessed_by, assessment_date, performance_score, potential_score,
              flight_risk, readiness, leadership_score, mobility, talent_classification,
              assessment_period, notes, company_id
       FROM talent_assessments WHERE employee_id = $1`,
      [employee_id]
    );
    const { rows } = await client.query(
      `INSERT INTO talent_assessments
         (employee_id, assessed_by, performance_score, potential_score, assessment_date, company_id)
       VALUES ($1,$2,$3,$4,CURRENT_DATE,$5)
       ON CONFLICT (employee_id) DO UPDATE SET
         performance_score = $3,
         potential_score   = COALESCE($4, talent_assessments.potential_score),
         assessed_by       = $2,
         assessment_date   = CURRENT_DATE
       RETURNING *`,
      [employee_id, assessedBy, performance_score, potential_score || null, cid]
    );
    await client.query(
      `INSERT INTO succession_perf_sync_log
         (employee_id, source, performance_score, potential_score, synced_by, company_id)
       VALUES ($1,'performance_review',$2,$3,$4,$5)`,
      [employee_id, performance_score, potential_score || null, assessedBy, cid]
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   9-BOX MATRIX
═══════════════════════════════════════════════════════════════════════════ */

router.get('/nine-box', requireHRRead, async (req, res) => {
  const cid    = getCid(req);
  const params = [];
  try {
    const { rows } = await pool.query(
      `SELECT ta.id, ta.employee_id, ta.performance_score, ta.potential_score,
              ta.flight_risk, ta.readiness, ta.notes, ta.leadership_score, ta.mobility,
              ta.talent_classification, ta.assessment_period,
              e.name AS employee_name, e.department, e.designation
       FROM talent_assessments ta
       JOIN employees e ON e.id = ta.employee_id
       WHERE 1=1${cidClause(cid, params, 'ta')}`,
      params
    );

    const boxes = {};
    for (let perf = 1; perf <= 3; perf++)
      for (let pot = 1; pot <= 3; pot++) {
        const key = `${perf}_${pot}`;
        boxes[key] = { performance: perf, potential: pot, label: CELL_LABELS[key], employees: [] };
      }
    for (const r of rows) {
      const perf = scoreToAxis(r.performance_score);
      const pot  = scoreToAxis(r.potential_score);
      boxes[`${perf}_${pot}`].employees.push({
        id: r.id, employee_id: r.employee_id, name: r.employee_name,
        department: r.department, designation: r.designation,
        performance_score: r.performance_score, potential_score: r.potential_score,
        flight_risk: r.flight_risk, readiness: r.readiness, notes: r.notes,
        leadership_score: r.leadership_score, mobility: r.mobility,
        talent_classification: r.talent_classification,
      });
    }
    res.json(Object.values(boxes));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   CRITICAL ROLES — Full CRUD (enhanced)
═══════════════════════════════════════════════════════════════════════════ */

router.get('/critical-roles', requireHRRead, async (req, res) => {
  const cid    = getCid(req);
  const params = [];
  try {
    const { rows } = await pool.query(
      `SELECT cr.*,
              e.name AS current_holder_name,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id)::int AS candidate_count,
              EXISTS(SELECT 1 FROM succession_plans sp
                     WHERE sp.critical_role_id=cr.id AND sp.readiness_level='ready-now') AS has_ready_now,
              EXISTS(SELECT 1 FROM succession_plans sp
                     WHERE sp.critical_role_id=cr.id) AS has_any_successor
       FROM critical_roles cr
       LEFT JOIN employees e ON e.id = cr.current_holder_id
       WHERE 1=1${cidClause(cid, params, 'cr')}
       ORDER BY
         CASE cr.risk_level WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
         cr.role_title`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/critical-roles', requireHRWrite, async (req, res) => {
  const {
    role_title, department, current_holder_id, risk_level = 'medium',
    reason, knowledge_domain, vacancy_impact, expected_vacancy_date,
    min_experience_years = 0, required_certifications = [],
  } = req.body;
  if (!role_title) return res.status(400).json({ message: 'role_title required' });
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO critical_roles
         (role_title, department, current_holder_id, risk_level, reason,
          knowledge_domain, vacancy_impact, expected_vacancy_date,
          min_experience_years, required_certifications, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [role_title, department, current_holder_id || null, risk_level, reason,
       knowledge_domain || null, vacancy_impact || null, expected_vacancy_date || null,
       min_experience_years, JSON.stringify(required_certifications), cid]
    );
    // Check zero-successor alert on creation
    await _checkAndCreateAlert(rows[0].id, cid, 0);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/critical-roles/:id', requireHRWrite, async (req, res) => {
  const {
    role_title, department, current_holder_id, risk_level, reason,
    knowledge_domain, vacancy_impact, expected_vacancy_date,
    min_experience_years, required_certifications,
  } = req.body;
  const cid    = getCid(req);
  const params = [req.params.id, role_title, department, current_holder_id || null,
                  risk_level, reason, knowledge_domain ?? null, vacancy_impact ?? null,
                  expected_vacancy_date ?? null, min_experience_years ?? null,
                  required_certifications ? JSON.stringify(required_certifications) : null];
  try {
    const { rows } = await pool.query(
      `UPDATE critical_roles SET
         role_title             = COALESCE($2, role_title),
         department             = COALESCE($3, department),
         current_holder_id      = $4,
         risk_level             = COALESCE($5, risk_level),
         reason                 = COALESCE($6, reason),
         knowledge_domain       = COALESCE($7, knowledge_domain),
         vacancy_impact         = COALESCE($8, vacancy_impact),
         expected_vacancy_date  = COALESCE($9, expected_vacancy_date),
         min_experience_years   = COALESCE($10, min_experience_years),
         required_certifications= COALESCE($11::jsonb, required_certifications),
         updated_at             = NOW()
       WHERE id = $1${cidClause(cid, params)} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ message: 'Critical role not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/critical-roles/:id', requireHRWrite, async (req, res) => {
  const cid    = getCid(req);
  const params = [req.params.id];
  try {
    const { rows } = await pool.query(
      `DELETE FROM critical_roles WHERE id = $1${cidClause(cid, params)} RETURNING id`,
      params
    );
    if (!rows.length) return res.status(404).json({ message: 'Critical role not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── Candidates (succession pipeline) ──────────────────────────────────── */

router.get('/critical-roles/:id/candidates', requireHRRead, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sp.*, e.name AS candidate_name, e.department, e.designation,
              ta.performance_score, ta.potential_score, ta.flight_risk,
              ta.leadership_score, ta.mobility, ta.talent_classification,
              sp.is_emergency_successor, sp.successor_type
       FROM succession_plans sp
       JOIN  employees e ON e.id = sp.candidate_employee_id
       LEFT JOIN talent_assessments ta ON ta.employee_id = sp.candidate_employee_id
       WHERE sp.critical_role_id = $1
       ORDER BY sp.rank`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/critical-roles/:id/candidates', requireHRWrite, async (req, res) => {
  const { candidates = [] } = req.body;
  const cid = getCid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM succession_plans WHERE critical_role_id=$1', [req.params.id]);
    for (const c of candidates) {
      await client.query(
        `INSERT INTO succession_plans
           (critical_role_id, candidate_employee_id, rank, readiness_level,
            development_actions, is_emergency_successor, successor_type, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.params.id, c.candidate_employee_id, c.rank ?? 1,
         c.readiness_level ?? '1-2-years', JSON.stringify(c.development_actions || []),
         c.is_emergency_successor ?? false,
         c.successor_type ?? (c.rank === 1 ? 'primary' : 'secondary'),
         cid]
      );
    }
    await client.query('COMMIT');
    // Check alerts
    await _checkAndCreateAlert(parseInt(req.params.id), cid, candidates.length);
    res.json({ message: 'Candidates updated', count: candidates.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

/* ─── Internal helper: create succession alerts ──────────────────────────── */
async function _checkAndCreateAlert(roleId, cid, candidateCount) {
  try {
    const settingsRes = await pool.query(
      `SELECT zero_successor_alert, single_successor_alert FROM succession_settings
       WHERE company_id = $1`, [cid]
    );
    const settings = settingsRes.rows[0] || { zero_successor_alert: true, single_successor_alert: true };

    if (candidateCount === 0 && settings.zero_successor_alert) {
      await pool.query(
        `INSERT INTO succession_alerts (alert_type, role_id, message, severity, company_id)
         SELECT 'zero_successor',
                $1,
                'Critical role "' || role_title || '" has NO successors defined.',
                'critical', $2
         FROM critical_roles WHERE id = $1`,
        [roleId, cid]
      );
    } else if (candidateCount === 1 && settings.single_successor_alert) {
      await pool.query(
        `INSERT INTO succession_alerts (alert_type, role_id, message, severity, company_id)
         SELECT 'single_successor',
                $1,
                'Critical role "' || role_title || '" has only ONE successor — single point of failure.',
                'warning', $2
         FROM critical_roles WHERE id = $1`,
        [roleId, cid]
      );
    }
  } catch { /* non-fatal */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   LEADERSHIP PIPELINE
═══════════════════════════════════════════════════════════════════════════ */

router.get('/pipeline/levels', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM leadership_pipeline_levels
       WHERE (company_id = $1 OR company_id IS NULL) AND is_active = TRUE
       ORDER BY level_order`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/pipeline/levels', requireHRWrite, async (req, res) => {
  const { level_name, level_order, description, required_experience_yrs, required_competencies } = req.body;
  if (!level_name) return res.status(400).json({ message: 'level_name required' });
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO leadership_pipeline_levels
         (level_name, level_order, description, required_experience_yrs, required_competencies, company_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [level_name, level_order || 0, description || null,
       required_experience_yrs || 0,
       JSON.stringify(required_competencies || []), cid]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/pipeline/levels/:id', requireHRWrite, async (req, res) => {
  const { level_name, level_order, description, required_experience_yrs, is_active } = req.body;
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE leadership_pipeline_levels SET
         level_name             = COALESCE($2, level_name),
         level_order            = COALESCE($3, level_order),
         description            = COALESCE($4, description),
         required_experience_yrs= COALESCE($5, required_experience_yrs),
         is_active              = COALESCE($6, is_active)
       WHERE id = $1 AND (company_id = $7 OR company_id IS NULL) RETURNING *`,
      [req.params.id, level_name || null, level_order ?? null, description ?? null,
       required_experience_yrs ?? null, is_active ?? null, cid]
    );
    if (!rows.length) return res.status(404).json({ message: 'Level not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/pipeline/entries', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT lpe.*,
              e.name AS employee_name, e.department, e.designation,
              cl.level_name AS current_level_name, cl.level_order AS current_level_order,
              tl.level_name AS target_level_name,  tl.level_order AS target_level_order,
              ta.performance_score, ta.potential_score, ta.flight_risk
       FROM leadership_pipeline_entries lpe
       JOIN employees e ON e.id = lpe.employee_id
       LEFT JOIN leadership_pipeline_levels cl ON cl.id = lpe.current_level_id
       LEFT JOIN leadership_pipeline_levels tl ON tl.id = lpe.target_level_id
       LEFT JOIN talent_assessments ta ON ta.employee_id = lpe.employee_id
       WHERE lpe.company_id = $1 AND lpe.status = 'active'
       ORDER BY cl.level_order, e.name`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/pipeline/entries', requireHRWrite, async (req, res) => {
  const {
    employee_id, current_level_id, target_level_id,
    current_since, target_date, readiness, notes,
  } = req.body;
  if (!employee_id || !current_level_id)
    return res.status(400).json({ message: 'employee_id and current_level_id required' });
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO leadership_pipeline_entries
         (employee_id, current_level_id, target_level_id, current_since,
          target_date, readiness, notes, company_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (employee_id, company_id) DO UPDATE SET
         current_level_id = $2, target_level_id = $3,
         current_since = COALESCE($4, leadership_pipeline_entries.current_since),
         target_date = $5, readiness = $6, notes = $7, updated_at = NOW()
       RETURNING *`,
      [employee_id, current_level_id, target_level_id || null,
       current_since || null, target_date || null,
       readiness || '1-2-years', notes || null, cid, req.user?.userId ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/pipeline/entries/:id', requireHRWrite, async (req, res) => {
  const {
    current_level_id, target_level_id, target_date,
    readiness, notes, status,
  } = req.body;
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE leadership_pipeline_entries SET
         current_level_id = COALESCE($2, current_level_id),
         target_level_id  = COALESCE($3, target_level_id),
         target_date      = COALESCE($4, target_date),
         readiness        = COALESCE($5, readiness),
         notes            = COALESCE($6, notes),
         status           = COALESCE($7, status),
         updated_at       = NOW()
       WHERE id = $1 AND company_id = $8 RETURNING *`,
      [req.params.id, current_level_id || null, target_level_id ?? null,
       target_date ?? null, readiness || null, notes ?? null, status || null, cid]
    );
    if (!rows.length) return res.status(404).json({ message: 'Entry not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/pipeline/entries/:id', requireHRWrite, async (req, res) => {
  const cid = getCid(req);
  try {
    await pool.query(
      `DELETE FROM leadership_pipeline_entries WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   DEVELOPMENT PLANS
═══════════════════════════════════════════════════════════════════════════ */

router.get('/development-plans', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  const { employee_id, status } = req.query;
  try {
    const params = [cid];
    let where = `dp.company_id = $1`;
    if (employee_id) { params.push(employee_id); where += ` AND dp.employee_id = $${params.length}`; }
    if (status)      { params.push(status);      where += ` AND dp.status = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT dp.*,
              e.name AS employee_name, e.department, e.designation,
              cr.role_title AS target_role,
              (SELECT COUNT(*) FROM development_actions da WHERE da.plan_id = dp.id)::int AS action_count,
              (SELECT COUNT(*) FROM development_actions da WHERE da.plan_id = dp.id AND da.status='completed')::int AS completed_count,
              (SELECT COUNT(*) FROM mentoring_assignments ma WHERE ma.development_plan_id = dp.id AND ma.status='active')::int AS mentor_count
       FROM development_plans dp
       JOIN employees e ON e.id = dp.employee_id
       LEFT JOIN critical_roles cr ON cr.id = dp.critical_role_id
       WHERE ${where}
       ORDER BY dp.updated_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/development-plans/:id', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const [planRes, actionsRes, mentorsRes] = await Promise.all([
      pool.query(
        `SELECT dp.*, e.name AS employee_name, e.department, e.designation,
                cr.role_title AS target_role, c.name AS created_by_name
         FROM development_plans dp
         JOIN employees e ON e.id = dp.employee_id
         LEFT JOIN critical_roles cr ON cr.id = dp.critical_role_id
         LEFT JOIN employees c ON c.id = dp.created_by
         WHERE dp.id = $1 AND dp.company_id = $2`,
        [req.params.id, cid]
      ),
      pool.query(
        `SELECT da.*, e.name AS owner_name
         FROM development_actions da
         LEFT JOIN employees e ON e.id = da.owner_employee_id
         WHERE da.plan_id = $1
         ORDER BY da.action_order, da.created_at`,
        [req.params.id]
      ),
      pool.query(
        `SELECT ma.*, e.name AS mentor_name, e.designation AS mentor_designation
         FROM mentoring_assignments ma
         JOIN employees e ON e.id = ma.mentor_employee_id
         WHERE ma.development_plan_id = $1`,
        [req.params.id]
      ),
    ]);
    if (!planRes.rows.length) return res.status(404).json({ message: 'Plan not found' });
    res.json({ ...planRes.rows[0], actions: actionsRes.rows, mentors: mentorsRes.rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/development-plans', requireHRWrite, async (req, res) => {
  const {
    employee_id, critical_role_id, plan_title, plan_type = 'succession',
    start_date, target_date, notes,
  } = req.body;
  if (!employee_id || !plan_title)
    return res.status(400).json({ message: 'employee_id and plan_title required' });
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO development_plans
         (employee_id, critical_role_id, plan_title, plan_type,
          start_date, target_date, notes, company_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [employee_id, critical_role_id || null, plan_title, plan_type,
       start_date || null, target_date || null, notes || null, cid,
       req.user?.userId ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/development-plans/:id', requireHRWrite, async (req, res) => {
  const {
    plan_title, status, target_date, completion_date,
    overall_progress, notes,
  } = req.body;
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE development_plans SET
         plan_title       = COALESCE($2, plan_title),
         status           = COALESCE($3, status),
         target_date      = COALESCE($4, target_date),
         completion_date  = COALESCE($5, completion_date),
         overall_progress = COALESCE($6, overall_progress),
         notes            = COALESCE($7, notes),
         updated_at       = NOW()
       WHERE id = $1 AND company_id = $8 RETURNING *`,
      [req.params.id, plan_title || null, status || null, target_date ?? null,
       completion_date ?? null, overall_progress ?? null, notes ?? null, cid]
    );
    if (!rows.length) return res.status(404).json({ message: 'Plan not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/development-plans/:id', requireHRWrite, async (req, res) => {
  const cid = getCid(req);
  try {
    await pool.query(
      `DELETE FROM development_plans WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ── Development Actions (within a plan) ─────────────────────────────────── */

router.post('/development-plans/:id/actions', requireHRWrite, async (req, res) => {
  const {
    action_type = 'task', title, description, due_date,
    owner_employee_id, linked_skill, action_order,
  } = req.body;
  if (!title) return res.status(400).json({ message: 'title required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO development_actions
         (plan_id, action_type, title, description, due_date,
          owner_employee_id, linked_skill, action_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, action_type, title, description || null, due_date || null,
       owner_employee_id || null, linked_skill || null, action_order || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/development-plans/:id/actions/:actionId', requireHRWrite, async (req, res) => {
  const { title, description, due_date, status, completion_date } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE development_actions SET
         title           = COALESCE($2, title),
         description     = COALESCE($3, description),
         due_date        = COALESCE($4, due_date),
         status          = COALESCE($5, status),
         completion_date = COALESCE($6, completion_date),
         updated_at      = NOW()
       WHERE id = $1 AND plan_id = $7 RETURNING *`,
      [req.params.actionId, title || null, description ?? null, due_date ?? null,
       status || null, completion_date ?? null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Action not found' });

    // Recalculate plan overall_progress
    await pool.query(
      `UPDATE development_plans SET
         overall_progress = (
           SELECT ROUND(
             COUNT(*) FILTER (WHERE status='completed') * 100.0 / NULLIF(COUNT(*),0)
           )
           FROM development_actions WHERE plan_id = $1
         ),
         updated_at = NOW()
       WHERE id = $1`,
      [req.params.id]
    );

    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/development-plans/:id/actions/:actionId', requireHRWrite, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM development_actions WHERE id=$1 AND plan_id=$2`,
      [req.params.actionId, req.params.id]
    );
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ── Mentoring Assignments ────────────────────────────────────────────────── */

router.get('/mentoring', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT ma.*,
              mentee.name AS mentee_name, mentee.department AS mentee_department,
              mentor.name AS mentor_name, mentor.designation AS mentor_designation,
              dp.plan_title
       FROM mentoring_assignments ma
       JOIN employees mentee ON mentee.id = ma.mentee_employee_id
       JOIN employees mentor ON mentor.id = ma.mentor_employee_id
       LEFT JOIN development_plans dp ON dp.id = ma.development_plan_id
       WHERE ma.company_id = $1
       ORDER BY ma.status, ma.created_at DESC`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/mentoring', requireHRWrite, async (req, res) => {
  const {
    mentee_employee_id, mentor_employee_id, development_plan_id,
    focus_area, start_date, end_date, notes,
  } = req.body;
  if (!mentee_employee_id || !mentor_employee_id)
    return res.status(400).json({ message: 'mentee_employee_id and mentor_employee_id required' });
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO mentoring_assignments
         (mentee_employee_id, mentor_employee_id, development_plan_id,
          focus_area, start_date, end_date, notes, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [mentee_employee_id, mentor_employee_id, development_plan_id || null,
       focus_area || null, start_date || null, end_date || null, notes || null, cid]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/mentoring/:id', requireHRWrite, async (req, res) => {
  const { status, session_count, next_session_date, end_date, notes } = req.body;
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE mentoring_assignments SET
         status            = COALESCE($2, status),
         session_count     = COALESCE($3, session_count),
         next_session_date = COALESCE($4, next_session_date),
         end_date          = COALESCE($5, end_date),
         notes             = COALESCE($6, notes),
         updated_at        = NOW()
       WHERE id = $1 AND company_id = $7 RETURNING *`,
      [req.params.id, status || null, session_count ?? null,
       next_session_date ?? null, end_date ?? null, notes ?? null, cid]
    );
    if (!rows.length) return res.status(404).json({ message: 'Assignment not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/mentoring/:id', requireHRWrite, async (req, res) => {
  const cid = getCid(req);
  try {
    await pool.query(
      `DELETE FROM mentoring_assignments WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   EMPLOYEE TALENT POOLS (succession-side, employee-based)
═══════════════════════════════════════════════════════════════════════════ */

router.get('/pools', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT etp.*,
              COUNT(DISTINCT epm.employee_id)::int AS member_count,
              creator.name AS created_by_name
       FROM employee_talent_pools etp
       LEFT JOIN employee_pool_members epm ON epm.pool_id = etp.id
       LEFT JOIN employees creator ON creator.id = etp.created_by
       WHERE etp.company_id = $1
       GROUP BY etp.id, creator.name
       ORDER BY etp.pool_type, etp.pool_name`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/pools', requireHRWrite, async (req, res) => {
  const { pool_name, pool_type = 'general', description, department } = req.body;
  if (!pool_name) return res.status(400).json({ message: 'pool_name required' });
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO employee_talent_pools
         (pool_name, pool_type, description, department, company_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [pool_name, pool_type, description || null, department || null, cid,
       req.user?.userId ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/pools/:id', requireHRWrite, async (req, res) => {
  const { pool_name, pool_type, description, department, is_active } = req.body;
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE employee_talent_pools SET
         pool_name   = COALESCE($2, pool_name),
         pool_type   = COALESCE($3, pool_type),
         description = COALESCE($4, description),
         department  = COALESCE($5, department),
         is_active   = COALESCE($6, is_active),
         updated_at  = NOW()
       WHERE id = $1 AND company_id = $7 RETURNING *`,
      [req.params.id, pool_name || null, pool_type || null, description ?? null,
       department ?? null, is_active ?? null, cid]
    );
    if (!rows.length) return res.status(404).json({ message: 'Pool not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/pools/:id', requireHRWrite, async (req, res) => {
  const cid = getCid(req);
  try {
    await pool.query(
      `DELETE FROM employee_pool_members WHERE pool_id=$1`,
      [req.params.id]
    );
    await pool.query(
      `DELETE FROM employee_talent_pools WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/pools/:id/members', requireHRRead, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT epm.*, e.name, e.department, e.designation, e.employee_code,
              ta.performance_score, ta.potential_score, ta.flight_risk, ta.readiness,
              ta.talent_classification, ta.leadership_score
       FROM employee_pool_members epm
       JOIN employees e ON e.id = epm.employee_id
       LEFT JOIN talent_assessments ta ON ta.employee_id = epm.employee_id
       WHERE epm.pool_id = $1
       ORDER BY epm.added_date DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/pools/:id/members', requireHRWrite, async (req, res) => {
  const { employee_id, notes } = req.body;
  if (!employee_id) return res.status(400).json({ message: 'employee_id required' });
  try {
    await pool.query(
      `INSERT INTO employee_pool_members (pool_id, employee_id, notes, added_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT (pool_id, employee_id) DO NOTHING`,
      [req.params.id, employee_id, notes || null, req.user?.userId ?? null]
    );
    res.status(201).json({ message: 'Member added' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/pools/:id/members/:employeeId', requireHRWrite, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM employee_pool_members WHERE pool_id=$1 AND employee_id=$2`,
      [req.params.id, req.params.employeeId]
    );
    res.json({ message: 'Member removed' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SUCCESSION SETTINGS
═══════════════════════════════════════════════════════════════════════════ */

router.get('/settings', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM succession_settings WHERE company_id=$1`, [cid]
    );
    res.json(rows[0] || {
      zero_successor_alert: true, single_successor_alert: true,
      flight_risk_threshold: 'high', review_frequency: 'quarterly',
      notify_roles: ['chro','hr_admin','hr_manager'],
      hiPo_threshold_potential: 4, hiPo_threshold_performance: 3,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/settings', requireHRWrite, async (req, res) => {
  const {
    zero_successor_alert, single_successor_alert, flight_risk_threshold,
    review_frequency, notify_roles, hiPo_threshold_potential, hiPo_threshold_performance,
  } = req.body;
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO succession_settings
         (company_id, zero_successor_alert, single_successor_alert, flight_risk_threshold,
          review_frequency, notify_roles, hiPo_threshold_potential, hiPo_threshold_performance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id) DO UPDATE SET
         zero_successor_alert        = $2,
         single_successor_alert      = $3,
         flight_risk_threshold       = $4,
         review_frequency            = $5,
         notify_roles                = $6,
         hiPo_threshold_potential    = $7,
         hiPo_threshold_performance  = $8,
         updated_at                  = NOW()
       RETURNING *`,
      [cid,
       zero_successor_alert ?? true, single_successor_alert ?? true,
       flight_risk_threshold || 'high', review_frequency || 'quarterly',
       JSON.stringify(notify_roles || ['chro','hr_admin','hr_manager']),
       hiPo_threshold_potential ?? 4, hiPo_threshold_performance ?? 3]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── Alerts ──────────────────────────────────────────────────────────────── */

router.get('/alerts', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT sa.*, cr.role_title, cr.department, cr.risk_level
       FROM succession_alerts sa
       LEFT JOIN critical_roles cr ON cr.id = sa.role_id
       WHERE sa.company_id = $1
       ORDER BY sa.created_at DESC
       LIMIT 50`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/alerts/:id/read', requireHRRead, async (req, res) => {
  try {
    await pool.query(
      `UPDATE succession_alerts SET is_read=TRUE WHERE id=$1`, [req.params.id]
    );
    res.json({ message: 'Marked read' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   DASHBOARD (enhanced)
═══════════════════════════════════════════════════════════════════════════ */

router.get('/dashboard', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  const bench_p = [];  const bench_w  = cidClause(cid, bench_p, 'cr');
  const flight_p = []; const flight_w = cidClause(cid, flight_p, 'ta');
  const ready_p = [];  const ready_w  = cidClause(cid, ready_p, 'sp');
  const top_p = [];    const top_w    = cidClause(cid, top_p, 'ta');
  const pool_p = [];   const pool_w   = cidClause(cid, pool_p, 'lpe');
  const alert_p = [];  const alert_w  = cidClause(cid, alert_p);

  try {
    const [benchRes, flightRes, readyRes, topRes, pipeRes, alertRes, zeroRes, devRes] =
      await Promise.allSettled([
        pool.query(
          `SELECT
             COUNT(*)::int AS total_critical_roles,
             COUNT(CASE WHEN EXISTS(
               SELECT 1 FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND sp.readiness_level='ready-now'
             ) THEN 1 END)::int AS ready_now_count,
             COUNT(CASE WHEN NOT EXISTS(
               SELECT 1 FROM succession_plans sp WHERE sp.critical_role_id=cr.id
             ) THEN 1 END)::int AS zero_successor_count,
             ROUND(100.0 * COUNT(CASE WHEN EXISTS(
               SELECT 1 FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND sp.readiness_level='ready-now'
             ) THEN 1 END) / NULLIF(COUNT(*),0),0) AS bench_strength_pct
           FROM critical_roles cr WHERE 1=1${bench_w}`,
          bench_p
        ),
        pool.query(
          `SELECT flight_risk, COUNT(*)::int AS cnt
           FROM talent_assessments ta WHERE 1=1${flight_w} GROUP BY flight_risk`,
          flight_p
        ),
        pool.query(
          `SELECT readiness_level AS readiness, COUNT(*)::int AS cnt
           FROM succession_plans sp WHERE 1=1${ready_w} GROUP BY readiness_level`,
          ready_p
        ),
        pool.query(
          `SELECT e.name, e.department, e.designation,
                  ta.performance_score, ta.potential_score, ta.flight_risk,
                  ta.readiness, ta.talent_classification, ta.leadership_score
           FROM talent_assessments ta
           JOIN employees e ON e.id = ta.employee_id
           WHERE ta.potential_score >= 4${top_w}
           ORDER BY ta.potential_score DESC, ta.performance_score DESC LIMIT 10`,
          top_p
        ),
        pool.query(
          `SELECT cl.level_name, cl.level_order, COUNT(lpe.id)::int AS headcount
           FROM leadership_pipeline_entries lpe
           JOIN leadership_pipeline_levels cl ON cl.id = lpe.current_level_id
           WHERE lpe.status='active'${pool_w}
           GROUP BY cl.level_name, cl.level_order
           ORDER BY cl.level_order`,
          pool_p
        ),
        pool.query(
          `SELECT COUNT(*)::int AS unread_alerts FROM succession_alerts
           WHERE is_read=FALSE${alert_w}`,
          alert_p
        ),
        pool.query(
          `SELECT cr.role_title, cr.department, cr.risk_level
           FROM critical_roles cr
           WHERE NOT EXISTS(SELECT 1 FROM succession_plans sp WHERE sp.critical_role_id=cr.id)
             ${bench_w.replace('AND cr.company_id', 'AND cr.company_id')}
           ORDER BY CASE cr.risk_level WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
           LIMIT 10`,
          bench_p
        ),
        pool.query(
          `SELECT COUNT(*)::int AS active_plans,
                  ROUND(AVG(overall_progress))::int AS avg_progress
           FROM development_plans WHERE company_id=$1 AND status='active'`,
          [cid]
        ),
      ]);

    const flightMap = {};
    for (const r of (flightRes.value?.rows || [])) flightMap[r.flight_risk] = r.cnt;
    const benchRow  = benchRes.value?.rows[0] || {};

    res.json({
      bench_strength_pct:     parseInt(benchRow.bench_strength_pct || 0),
      total_critical_roles:   parseInt(benchRow.total_critical_roles || 0),
      ready_now_count:        parseInt(benchRow.ready_now_count || 0),
      zero_successor_count:   parseInt(benchRow.zero_successor_count || 0),
      flight_risk:            { low: flightMap.low || 0, medium: flightMap.medium || 0, high: flightMap.high || 0 },
      readiness_summary:      readyRes.value?.rows || [],
      top_high_potential:     topRes.value?.rows || [],
      pipeline_distribution:  pipeRes.value?.rows || [],
      unread_alerts:          parseInt(alertRes.value?.rows[0]?.unread_alerts || 0),
      zero_successor_roles:   zeroRes.value?.rows || [],
      development_summary:    devRes.value?.rows[0] || { active_plans: 0, avg_progress: 0 },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   REPORTS — all with CSV export
═══════════════════════════════════════════════════════════════════════════ */

router.get('/reports/bench-strength', requireHRRead, async (req, res) => {
  const cid    = getCid(req);
  const fmt    = req.query.format || 'json';
  const params = [cid];
  try {
    const { rows } = await pool.query(
      `SELECT cr.role_title, cr.department, cr.risk_level,
              cr.knowledge_domain, cr.expected_vacancy_date,
              e.name AS current_holder,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id)::int AS successor_count,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND sp.readiness_level='ready-now')::int AS ready_now,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND sp.readiness_level='1-2-years')::int AS ready_1_2yr,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND sp.readiness_level='3-5-years')::int AS ready_3_5yr,
              CASE WHEN NOT EXISTS(SELECT 1 FROM succession_plans sp WHERE sp.critical_role_id=cr.id)
                   THEN 'NO SUCCESSOR' ELSE 'Covered' END AS coverage_status
       FROM critical_roles cr LEFT JOIN employees e ON e.id=cr.current_holder_id
       WHERE cr.company_id=$1
       ORDER BY CASE cr.risk_level WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, cr.role_title`,
      params
    );
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="bench_strength.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/reports/talent-risk', requireHRRead, async (req, res) => {
  const cid    = getCid(req);
  const fmt    = req.query.format || 'json';
  try {
    const { rows } = await pool.query(
      `SELECT e.name AS employee_name, e.department, e.designation,
              ta.performance_score, ta.potential_score,
              ta.flight_risk, ta.readiness, ta.talent_classification,
              ta.leadership_score, ta.mobility,
              (SELECT STRING_AGG(cr.role_title, ', ')
               FROM succession_plans sp2
               JOIN critical_roles cr ON cr.id=sp2.critical_role_id
               WHERE sp2.candidate_employee_id=ta.employee_id) AS successor_to_roles,
              ta.assessment_date
       FROM talent_assessments ta
       JOIN employees e ON e.id=ta.employee_id
       WHERE ta.company_id=$1
       ORDER BY CASE ta.flight_risk WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                ta.potential_score DESC`,
      [cid]
    );
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="talent_risk.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/reports/nine-box-summary', requireHRRead, async (req, res) => {
  const cid    = getCid(req);
  const fmt    = req.query.format || 'json';
  try {
    const { rows } = await pool.query(
      `SELECT e.name, e.department, e.designation,
              ta.performance_score, ta.potential_score,
              CASE
                WHEN ta.performance_score>3 AND ta.potential_score>3 THEN 'Stars'
                WHEN ta.performance_score>3 AND ta.potential_score<=3 AND ta.potential_score>2 THEN 'High Performers'
                WHEN ta.performance_score>3 THEN 'Workhorses'
                WHEN ta.performance_score<=2 AND ta.potential_score>3 THEN 'Question Marks'
                WHEN ta.performance_score<=3 AND ta.performance_score>2 AND ta.potential_score>3 THEN 'Diamonds in the Rough'
                WHEN ta.performance_score<=2 AND ta.potential_score<=2 THEN 'Deadwood'
                ELSE 'Core Contributors'
              END AS quadrant,
              ta.flight_risk, ta.readiness, ta.assessment_date
       FROM talent_assessments ta
       JOIN employees e ON e.id=ta.employee_id
       WHERE ta.company_id=$1
       ORDER BY ta.potential_score DESC, ta.performance_score DESC`,
      [cid]
    );
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="nine_box_summary.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/reports/development-progress', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  const fmt = req.query.format || 'json';
  try {
    const { rows } = await pool.query(
      `SELECT e.name AS employee_name, e.department,
              dp.plan_title, dp.status, dp.overall_progress,
              dp.start_date, dp.target_date,
              cr.role_title AS target_role,
              (SELECT COUNT(*) FROM development_actions da WHERE da.plan_id=dp.id)::int AS total_actions,
              (SELECT COUNT(*) FROM development_actions da WHERE da.plan_id=dp.id AND da.status='completed')::int AS completed_actions,
              (SELECT COUNT(*) FROM mentoring_assignments ma WHERE ma.development_plan_id=dp.id AND ma.status='active')::int AS active_mentors
       FROM development_plans dp
       JOIN employees e ON e.id=dp.employee_id
       LEFT JOIN critical_roles cr ON cr.id=dp.critical_role_id
       WHERE dp.company_id=$1
       ORDER BY dp.overall_progress ASC`,
      [cid]
    );
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="development_progress.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/reports/readiness', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  const fmt = req.query.format || 'json';
  try {
    const { rows } = await pool.query(
      `SELECT e.name, e.department, e.designation,
              ta.performance_score, ta.potential_score, ta.leadership_score,
              ta.readiness, ta.talent_classification, ta.mobility,
              ta.assessment_date,
              (SELECT STRING_AGG(cr.role_title, ', ')
               FROM succession_plans sp
               JOIN critical_roles cr ON cr.id=sp.critical_role_id
               WHERE sp.candidate_employee_id=ta.employee_id) AS succession_roles,
              (SELECT COUNT(*) FROM development_plans dp WHERE dp.employee_id=ta.employee_id AND dp.status='active')::int AS active_plans
       FROM talent_assessments ta
       JOIN employees e ON e.id=ta.employee_id
       WHERE ta.company_id=$1
       ORDER BY CASE ta.readiness WHEN 'ready-now' THEN 1 WHEN '1-2-years' THEN 2 WHEN '3-5-years' THEN 3 ELSE 4 END`,
      [cid]
    );
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="readiness_report.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/reports/pipeline', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  const fmt = req.query.format || 'json';
  try {
    const { rows } = await pool.query(
      `SELECT e.name, e.department, e.designation,
              cl.level_name AS current_level, cl.level_order AS current_order,
              tl.level_name AS target_level,
              lpe.current_since, lpe.target_date, lpe.readiness, lpe.status,
              ta.performance_score, ta.potential_score
       FROM leadership_pipeline_entries lpe
       JOIN employees e ON e.id=lpe.employee_id
       LEFT JOIN leadership_pipeline_levels cl ON cl.id=lpe.current_level_id
       LEFT JOIN leadership_pipeline_levels tl ON tl.id=lpe.target_level_id
       LEFT JOIN talent_assessments ta ON ta.employee_id=lpe.employee_id
       WHERE lpe.company_id=$1
       ORDER BY cl.level_order, e.name`,
      [cid]
    );
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="pipeline_report.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
