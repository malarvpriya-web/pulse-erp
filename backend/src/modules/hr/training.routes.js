// backend/src/modules/hr/training.routes.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();

/* ── helpers ──────────────────────────────────────────────────── */
const cid   = req => { const n = Number.parseInt(req.scope?.company_id, 10); return Number.isInteger(n) ? n : null; };
const uid   = req => req.user?.userId ?? req.user?.id ?? null;
const role  = req => req.user?.role ?? '';
const HR_ROLES = ['admin','super_admin','hr','hr_manager','hr_exec','HR','Admin','SuperAdmin','L&D Admin','lnd_admin'];
const MGR_ROLES = [...HR_ROLES, 'manager','Manager','department_head'];

function cidWhere(companyId, alias = '') {
  const col = alias ? `${alias}.company_id` : 'company_id';
  return companyId != null ? ` AND (${col} IS NULL OR ${col} = ${companyId})` : '';
}

/* ── GET /programs ──────────────────────────────────────────── */
router.get('/programs', async (req, res) => {
  try {
    const companyId = cid(req);
    const { category, status, is_mandatory } = req.query;
    const params = [];
    let where = `WHERE p.deleted_at IS NULL`;
    if (companyId != null) { params.push(companyId); where += ` AND (p.company_id IS NULL OR p.company_id = $${params.length})`; }
    if (category)     { params.push(category);           where += ` AND p.category = $${params.length}`; }
    if (status)       { params.push(status);             where += ` AND p.status = $${params.length}`; }
    if (is_mandatory) { params.push(is_mandatory === 'true'); where += ` AND p.is_mandatory = $${params.length}`; }

    const { rows } = await pool.query(`
      SELECT p.*,
             t.name  AS trainer_name,
             COUNT(DISTINCT e.id)                                              AS enrolled_count,
             COUNT(DISTINCT CASE WHEN e.status='completed' THEN e.id END)     AS completed_count,
             ROUND(100.0*COUNT(DISTINCT CASE WHEN e.status='completed' THEN e.id END)
                       /NULLIF(COUNT(DISTINCT e.id),0),1)                     AS completion_pct,
             COALESCE(SUM(tc.amount),0)                                       AS total_cost
      FROM   training_programs p
      LEFT JOIN trainers            t  ON t.id = p.trainer_id
      LEFT JOIN training_enrollments e ON e.program_id = p.id
      LEFT JOIN training_costs      tc ON tc.program_id = p.id
      ${where}
      GROUP BY p.id, t.name
      ORDER BY p.scheduled_date DESC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /programs ──────────────────────────────────────────── */
router.post('/programs', async (req, res) => {
  if (!MGR_ROLES.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const {
    title, description, category, trainer, trainer_id, mode = 'offline',
    duration_hours, cost_per_participant, max_participants, scheduled_date,
    is_mandatory = false, target_department, target_role, online_link, venue,
  } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(`
      INSERT INTO training_programs
        (title,description,category,trainer,trainer_id,mode,duration_hours,
         cost_per_participant,max_participants,scheduled_date,is_mandatory,
         target_department,target_role,online_link,venue,company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [title,description,category,trainer,trainer_id||null,mode,
       duration_hours||8,cost_per_participant||0,max_participants||30,
       scheduled_date,is_mandatory,target_department||null,target_role||null,
       online_link||null,venue||null,companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /programs/:id ───────────────────────────────────────── */
router.get('/programs/:id', async (req, res) => {
  try {
    const companyId = cid(req);
    const [progRes, enrollRes, costRes, sessionRes] = await Promise.all([
      pool.query(`SELECT p.*, t.name AS trainer_name
                  FROM training_programs p LEFT JOIN trainers t ON t.id=p.trainer_id
                  WHERE p.id=$1 AND p.deleted_at IS NULL`, [req.params.id]),
      pool.query(`SELECT te.*, e.name AS employee_name, e.department, e.designation
                  FROM training_enrollments te LEFT JOIN employees e ON e.id=te.employee_id
                  WHERE te.program_id=$1 ORDER BY e.name`, [req.params.id]),
      pool.query(`SELECT * FROM training_costs WHERE program_id=$1 ORDER BY cost_type`, [req.params.id]),
      pool.query(`SELECT ts.*, tr.name AS trainer_name FROM training_sessions ts
                  LEFT JOIN trainers tr ON tr.id=ts.trainer_id
                  WHERE ts.program_id=$1 ORDER BY ts.session_date`, [req.params.id]),
    ]);
    if (!progRes.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...progRes.rows[0], enrollments: enrollRes.rows, costs: costRes.rows, sessions: sessionRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /programs/:id ───────────────────────────────────────── */
router.put('/programs/:id', async (req, res) => {
  if (!MGR_ROLES.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const {
    title,description,category,trainer,trainer_id,mode,duration_hours,
    cost_per_participant,max_participants,scheduled_date,status,
    is_mandatory,target_department,target_role,online_link,venue,
  } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE training_programs SET
        title              = COALESCE($1,title),
        description        = COALESCE($2,description),
        category           = COALESCE($3,category),
        trainer            = COALESCE($4,trainer),
        trainer_id         = COALESCE($5,trainer_id),
        mode               = COALESCE($6,mode),
        duration_hours     = COALESCE($7,duration_hours),
        cost_per_participant=COALESCE($8,cost_per_participant),
        max_participants   = COALESCE($9,max_participants),
        scheduled_date     = COALESCE($10,scheduled_date),
        status             = COALESCE($11,status),
        is_mandatory       = COALESCE($12,is_mandatory),
        target_department  = COALESCE($13,target_department),
        target_role        = COALESCE($14,target_role),
        online_link        = COALESCE($15,online_link),
        venue              = COALESCE($16,venue)
      WHERE id=$17 AND deleted_at IS NULL RETURNING *`,
      [title,description,category,trainer,trainer_id||null,mode,duration_hours,
       cost_per_participant,max_participants,scheduled_date,status,
       is_mandatory,target_department,target_role,online_link,venue,req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── DELETE /programs/:id ────────────────────────────────────── */
router.delete('/programs/:id', async (req, res) => {
  if (!HR_ROLES.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { rows } = await pool.query(
      `UPDATE training_programs SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Program archived' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /programs/:id/enroll ───────────────────────────────── */
router.post('/programs/:id/enroll', async (req, res) => {
  const { employee_ids = [] } = req.body;
  if (!employee_ids.length) return res.status(400).json({ error: 'employee_ids required' });
  const companyId = cid(req);
  try {
    let enrolled = 0;
    for (const eid of employee_ids) {
      await pool.query(
        `INSERT INTO training_enrollments (program_id,employee_id,company_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [req.params.id, eid, companyId]
      );
      enrolled++;
    }
    res.json({ enrolled, message: `${enrolled} employee(s) enrolled` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /enrollments/:id/complete ──────────────────────────── */
router.put('/enrollments/:id/complete', async (req, res) => {
  const { score, certificate_url, feedback_rating } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      UPDATE training_enrollments
      SET status='completed', completion_date=CURRENT_DATE,
          score=$1, certificate_url=$2, feedback_rating=$3
      WHERE id=$4 RETURNING *`,
      [score||null, certificate_url||null, feedback_rating||null, req.params.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

    const enrollment = rows[0];

    // Auto-update skill_matrix: mark program category as certified if score >= 70
    if (score && parseFloat(score) >= 70) {
      const progRes = await client.query(
        `SELECT category, title FROM training_programs WHERE id=$1`, [enrollment.program_id]
      );
      if (progRes.rows.length) {
        const { category, title } = progRes.rows[0];
        await client.query(`
          INSERT INTO skill_matrix (employee_id, skill_name, category, proficiency_level, certified, certification_name, expiry_date, company_id)
          VALUES ($1,$2,$3,4,true,$4, CURRENT_DATE + INTERVAL '1 year',$5)
          ON CONFLICT ON CONSTRAINT uq_skill_matrix_emp_skill DO UPDATE SET
            proficiency_level = GREATEST(skill_matrix.proficiency_level, 4),
            certified = true,
            certification_name = EXCLUDED.certification_name,
            expiry_date = EXCLUDED.expiry_date,
            last_assessed = CURRENT_DATE`,
          [enrollment.employee_id, category, category, title, enrollment.company_id]
        );
      }
    }

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* ── GET /employee/:id/history ───────────────────────────────── */
router.get('/employee/:id/history', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT te.*, tp.title, tp.category, tp.trainer, tp.mode,
             tp.duration_hours, tp.scheduled_date, tp.is_mandatory,
             a.title AS assessment_title,
             aa.score_pct AS assessment_score, aa.passed AS assessment_passed
      FROM   training_enrollments te
      JOIN   training_programs tp ON tp.id = te.program_id
      LEFT JOIN assessments a ON a.program_id = tp.id
      LEFT JOIN LATERAL (
        SELECT score_pct, passed FROM assessment_attempts
        WHERE assessment_id = a.id AND employee_id = te.employee_id
        ORDER BY attempt_number DESC LIMIT 1
      ) aa ON true
      WHERE  te.employee_id = $1
      ORDER  BY tp.scheduled_date DESC`, [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /skills ──────────────────────────────────────────────── */
router.get('/skills', async (req, res) => {
  try {
    const { employee_id, category } = req.query;
    const companyId = cid(req);
    let q = `SELECT sm.*, e.name AS employee_name, e.department
             FROM skill_matrix sm LEFT JOIN employees e ON e.id=sm.employee_id WHERE 1=1`;
    const params = [];
    if (employee_id) { params.push(employee_id); q += ` AND sm.employee_id=$${params.length}`; }
    if (category)    { params.push(category);    q += ` AND sm.category=$${params.length}`; }
    if (companyId != null) { params.push(companyId); q += ` AND (sm.company_id IS NULL OR sm.company_id=$${params.length})`; }
    q += ' ORDER BY sm.skill_name, e.name';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /skills ────────────────────────────────────────────── */
router.post('/skills', async (req, res) => {
  const { employee_id, skill_name, category, proficiency_level=1,
          certified=false, certification_name, expiry_date } = req.body;
  if (!employee_id || !skill_name) return res.status(400).json({ error: 'employee_id and skill_name required' });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      INSERT INTO skill_matrix (employee_id,skill_name,category,proficiency_level,certified,certification_name,expiry_date,company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT ON CONSTRAINT uq_skill_matrix_emp_skill DO UPDATE SET
        category=$3, proficiency_level=$4, certified=$5,
        certification_name=$6, expiry_date=$7, last_assessed=CURRENT_DATE
      RETURNING *`,
      [employee_id,skill_name,category||null,proficiency_level,certified,certification_name||null,expiry_date||null,companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /skills/:id ─────────────────────────────────────────── */
router.put('/skills/:id', async (req, res) => {
  const { proficiency_level, certified, certification_name, expiry_date, category } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE skill_matrix SET
        proficiency_level  = COALESCE($1,proficiency_level),
        certified          = COALESCE($2,certified),
        certification_name = COALESCE($3,certification_name),
        expiry_date        = COALESCE($4,expiry_date),
        category           = COALESCE($5,category),
        last_assessed      = CURRENT_DATE
      WHERE id=$6 RETURNING *`,
      [proficiency_level,certified,certification_name,expiry_date,category,req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /skills/matrix ──────────────────────────────────────── */
router.get('/skills/matrix', async (req, res) => {
  try {
    const companyId = cid(req);
    const { department } = req.query;
    let empWhere = `WHERE e.deleted_at IS NULL AND LOWER(e.status) IN ('active','probation')`;
    const empParams = [];
    if (companyId != null) { empParams.push(companyId); empWhere += ` AND e.company_id=$${empParams.length}`; }
    if (department) { empParams.push(department); empWhere += ` AND e.department=$${empParams.length}`; }

    const { rows } = await pool.query(`
      SELECT e.id AS employee_id, e.name AS employee_name, e.department,
             sm.skill_name, sm.proficiency_level, sm.certified, sm.category,
             sm.certification_name, sm.expiry_date
      FROM   employees e
      LEFT JOIN skill_matrix sm ON sm.employee_id=e.id
        AND (sm.company_id IS NULL OR sm.company_id=${companyId ?? 'sm.company_id'})
      ${empWhere}
      ORDER BY e.name, sm.skill_name`, empParams
    );

    const empMap = {};
    const skillSet = new Set();
    for (const r of rows) {
      if (!empMap[r.employee_id]) {
        empMap[r.employee_id] = { employee_id: r.employee_id, employee_name: r.employee_name, department: r.department, skills: {} };
      }
      if (r.skill_name) {
        empMap[r.employee_id].skills[r.skill_name] = {
          proficiency: r.proficiency_level, certified: r.certified,
          category: r.category, cert_name: r.certification_name, expiry: r.expiry_date,
        };
        skillSet.add(r.skill_name);
      }
    }
    const skills    = Array.from(skillSet).sort();
    const employees = Object.values(empMap);
    const gaps = skills.map(skill => {
      const profs = employees.map(e => e.skills[skill]?.proficiency || 0).filter(p => p > 0);
      const avg   = profs.length ? profs.reduce((a, b) => a + b, 0) / profs.length : 0;
      return { skill, avg_proficiency: Math.round(avg * 10) / 10, gap: avg < 3, covered: profs.length, total: employees.length };
    });
    res.json({ employees, skills, gaps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /dashboard ──────────────────────────────────────────── */
router.get('/dashboard', async (req, res) => {
  const companyId = cid(req);
  const sc = companyId != null ? ` AND company_id=${companyId}` : '';
  try {
    const [monthRes,complRes,costRes,trainedRes,gapRes,mandRes,certRes] = await Promise.allSettled([
      pool.query(`SELECT COUNT(*) FROM training_programs WHERE DATE_TRUNC('month',scheduled_date)=DATE_TRUNC('month',CURRENT_DATE) AND deleted_at IS NULL${sc}`),
      pool.query(`SELECT ROUND(100.0*COUNT(CASE WHEN status='completed' THEN 1 END)/NULLIF(COUNT(*),0),1) AS rate FROM training_enrollments WHERE 1=1${sc}`),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM training_costs WHERE 1=1${sc}`),
      pool.query(`SELECT COUNT(DISTINCT employee_id) FROM training_enrollments WHERE status='completed'${sc}`),
      pool.query(`SELECT COUNT(*) FROM (SELECT skill_name FROM skill_matrix WHERE 1=1${sc} GROUP BY skill_name HAVING AVG(proficiency_level)<3) g`),
      pool.query(`SELECT COUNT(*) FROM training_programs WHERE is_mandatory=true AND status!='completed' AND deleted_at IS NULL${sc}`),
      pool.query(`SELECT COUNT(*) FROM skill_matrix WHERE certified=true AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE+30${sc}`),
    ]);
    res.json({
      trainings_this_month:  parseInt(monthRes.value?.rows[0]?.count   || 0),
      completion_rate_pct:   parseFloat(complRes.value?.rows[0]?.rate  || 0),
      total_training_cost:   parseFloat(costRes.value?.rows[0]?.total  || 0),
      employees_trained:     parseInt(trainedRes.value?.rows[0]?.count || 0),
      skill_gap_count:       parseInt(gapRes.value?.rows[0]?.count     || 0),
      mandatory_pending:     parseInt(mandRes.value?.rows[0]?.count    || 0),
      certs_expiring_30d:    parseInt(certRes.value?.rows[0]?.count    || 0),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /certifications/expiring ────────────────────────────── */
router.get('/certifications/expiring', async (req, res) => {
  const companyId = cid(req);
  const days = parseInt(req.query.days || 30);
  const sc   = companyId != null ? ` AND (sm.company_id IS NULL OR sm.company_id=${companyId})` : '';
  try {
    const { rows } = await pool.query(`
      SELECT sm.*, e.name AS employee_name, e.department, e.designation,
             (sm.expiry_date - CURRENT_DATE) AS days_until_expiry
      FROM   skill_matrix sm
      JOIN   employees e ON e.id = sm.employee_id
      WHERE  sm.certified=true AND sm.expiry_date IS NOT NULL
        AND  sm.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1${sc}
      ORDER  BY sm.expiry_date`, [days]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /cost-trend ─────────────────────────────────────────── */
router.get('/cost-trend', async (req, res) => {
  const companyId = cid(req);
  const sc = companyId != null ? ` AND tc.company_id=${companyId}` : '';
  try {
    const { rows } = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', tp.scheduled_date),'Mon YYYY') AS month,
             DATE_TRUNC('month', tp.scheduled_date)                      AS month_date,
             COALESCE(SUM(tc.amount),0)                                  AS cost
      FROM   training_programs tp
      LEFT JOIN training_costs tc ON tc.program_id = tp.id
      WHERE  tp.scheduled_date >= CURRENT_DATE - INTERVAL '12 months'
        AND  tp.deleted_at IS NULL
        ${companyId != null ? ` AND (tp.company_id IS NULL OR tp.company_id=${companyId})` : ''}
      GROUP  BY DATE_TRUNC('month', tp.scheduled_date)
      ORDER  BY month_date`
    );
    res.json(rows.map(r => ({ month: r.month, cost: parseFloat(r.cost) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /cost-by-type ───────────────────────────────────────── */
router.get('/cost-by-type', async (req, res) => {
  const companyId = cid(req);
  const sc = companyId != null ? ` AND company_id=${companyId}` : '';
  try {
    const { rows } = await pool.query(`
      SELECT cost_type AS name, COALESCE(SUM(amount),0) AS value
      FROM   training_costs WHERE 1=1${sc}
      GROUP  BY cost_type ORDER BY value DESC`
    );
    res.json(rows.map(r => ({ name: r.name, value: parseFloat(r.value) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /programs/:id/costs ────────────────────────────────── */
router.post('/programs/:id/costs', async (req, res) => {
  if (!MGR_ROLES.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { cost_type, amount, description } = req.body;
  if (!cost_type || !amount) return res.status(400).json({ error: 'cost_type and amount required' });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      INSERT INTO training_costs (program_id,cost_type,amount,description,company_id)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, cost_type, amount, description||null, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── DELETE /skills/:id ──────────────────────────────────────── */
router.delete('/skills/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM skill_matrix WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Skill deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /mandatory-compliance ───────────────────────────────── */
router.get('/mandatory-compliance', async (req, res) => {
  const companyId = cid(req);
  const sc = companyId != null ? ` AND e.company_id=${companyId}` : '';
  const psc = companyId != null ? ` AND p.company_id=${companyId}` : '';
  try {
    const [progRes, empRes] = await Promise.all([
      pool.query(`SELECT id, title, category, target_department, target_role FROM training_programs
                  WHERE is_mandatory=true AND deleted_at IS NULL${psc}`),
      pool.query(`SELECT id, name, department, designation FROM employees
                  WHERE deleted_at IS NULL AND LOWER(status) IN ('active','probation')${sc}`),
    ]);
    const enrollRes = await pool.query(`
      SELECT te.employee_id, te.program_id, te.status
      FROM   training_enrollments te
      JOIN   training_programs tp ON tp.id=te.program_id
      WHERE  tp.is_mandatory=true AND tp.deleted_at IS NULL`);

    const enrollMap = {};
    for (const e of enrollRes.rows) {
      const key = `${e.employee_id}_${e.program_id}`;
      enrollMap[key] = e.status;
    }

    const report = empRes.rows.map(emp => ({
      employee_id:   emp.id,
      employee_name: emp.name,
      department:    emp.department,
      designation:   emp.designation,
      programs: progRes.rows.map(p => ({
        program_id:   p.id,
        title:        p.title,
        category:     p.category,
        status:       enrollMap[`${emp.id}_${p.id}`] || 'not_enrolled',
      })),
      compliance_pct: progRes.rows.length === 0 ? 100
        : Math.round(100 * progRes.rows.filter(p => enrollMap[`${emp.id}_${p.id}`] === 'completed').length / progRes.rows.length),
    }));

    res.json({ mandatory_programs: progRes.rows.length, employees: report });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
