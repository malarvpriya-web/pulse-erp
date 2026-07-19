import { Router } from 'express';
import pool from '../shared/db.js';

const router = Router();

// Extract optional company scope (null = no isolation, backward compat)
const cid = (req) => req.scope?.company_id ?? null;

const safe = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Dashboard ──────────────────────────────────────────────────────────────
router.get('/dashboard', safe(async (req, res) => {
  const companyId = cid(req);
  const [projStats, phaseStats, protoStats, testStats, recentProjects] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::INT                                                      AS total,
        COUNT(*) FILTER (WHERE status = 'concept')::INT                   AS concept,
        COUNT(*) FILTER (WHERE status = 'design')::INT                    AS design,
        COUNT(*) FILTER (WHERE status = 'prototype')::INT                 AS prototype,
        COUNT(*) FILTER (WHERE status = 'testing')::INT                   AS testing,
        COUNT(*) FILTER (WHERE status = 'approved')::INT                  AS approved,
        COUNT(*) FILTER (WHERE status = 'cancelled')::INT                 AS cancelled,
        COALESCE(SUM(budget),0)::NUMERIC                                  AS total_budget,
        COALESCE(SUM(spent),0)::NUMERIC                                   AS total_spent
      FROM eng_rd_projects WHERE deleted_at IS NULL
        AND ($1::int IS NULL OR company_id = $1)
    `, [companyId]),
    pool.query(`
      SELECT dp.phase_name,
        COUNT(*)::INT                                                AS total,
        COUNT(*) FILTER (WHERE dp.status = 'completed')::INT        AS completed,
        COUNT(*) FILTER (WHERE dp.status = 'in_progress')::INT      AS in_progress
      FROM eng_design_phases dp
      JOIN eng_rd_projects p ON p.id = dp.project_id
      WHERE p.deleted_at IS NULL
        AND ($1::int IS NULL OR p.company_id = $1)
      GROUP BY dp.phase_name
      ORDER BY MIN(dp.phase_order)
    `, [companyId]),
    pool.query(`
      SELECT
        COUNT(*)::INT                                                AS total,
        COUNT(*) FILTER (WHERE pt.test_result = 'pass')::INT        AS passed,
        COUNT(*) FILTER (WHERE pt.test_result = 'fail')::INT        AS failed,
        COUNT(*) FILTER (WHERE pt.status = 'building')::INT         AS building
      FROM eng_prototypes pt
      JOIN eng_rd_projects p ON p.id = pt.project_id
      WHERE p.deleted_at IS NULL
        AND ($1::int IS NULL OR p.company_id = $1)
    `, [companyId]),
    pool.query(`
      SELECT
        COUNT(*)::INT                                                AS total,
        COUNT(*) FILTER (WHERE tp.result = 'pass')::INT             AS passed,
        COUNT(*) FILTER (WHERE tp.result = 'fail')::INT             AS failed,
        COUNT(*) FILTER (WHERE tp.status = 'in_progress')::INT      AS in_progress
      FROM eng_test_plans tp
      JOIN eng_rd_projects p ON p.id = tp.project_id
      WHERE p.deleted_at IS NULL
        AND ($1::int IS NULL OR p.company_id = $1)
    `, [companyId]),
    pool.query(`
      SELECT id, code, name, status, priority, manager_name, target_date, budget, spent
      FROM eng_rd_projects
      WHERE deleted_at IS NULL
        AND ($1::int IS NULL OR company_id = $1)
      ORDER BY updated_at DESC
      LIMIT 6
    `, [companyId]),
  ]);

  res.json({
    success: true,
    data: {
      projects:       projStats.rows[0],
      phases:         phaseStats.rows,
      prototypes:     protoStats.rows[0],
      tests:          testStats.rows[0],
      recentProjects: recentProjects.rows,
    },
  });
}));

// ── R&D Projects ───────────────────────────────────────────────────────────
router.get('/rd-projects', safe(async (req, res) => {
  const { status, priority, search } = req.query;
  const companyId = cid(req);
  let where = ['p.deleted_at IS NULL'];
  const params = [companyId];
  where.push(`($1::int IS NULL OR p.company_id = $1)`);
  if (status)   { params.push(status);   where.push(`p.status = $${params.length}`); }
  if (priority) { params.push(priority); where.push(`p.priority = $${params.length}`); }
  if (search)   { params.push(`%${search}%`); where.push(`(p.name ILIKE $${params.length} OR p.code ILIKE $${params.length} OR p.manager_name ILIKE $${params.length})`); }

  const { rows } = await pool.query(`
    SELECT
      p.*,
      (SELECT COUNT(*)::INT FROM eng_design_phases dp WHERE dp.project_id = p.id)               AS phase_count,
      (SELECT COUNT(*)::INT FROM eng_design_phases dp WHERE dp.project_id = p.id AND dp.status = 'completed') AS phases_done,
      (SELECT COUNT(*)::INT FROM eng_prototypes pt WHERE pt.project_id = p.id)                  AS proto_count,
      (SELECT COUNT(*)::INT FROM eng_test_plans tp WHERE tp.project_id = p.id)                  AS test_count,
      (SELECT COUNT(*)::INT FROM eng_test_plans tp WHERE tp.project_id = p.id AND tp.result = 'pass') AS tests_passed
    FROM eng_rd_projects p
    WHERE ${where.join(' AND ')}
    ORDER BY p.created_at DESC
  `, params);

  res.json({ success: true, data: rows });
}));

router.post('/rd-projects', safe(async (req, res) => {
  const {
    name, code, description, category, status = 'concept', priority = 'medium',
    manager_name, team_members, budget, start_date, target_date, tags,
  } = req.body;
  const companyId = cid(req);

  const { rows } = await pool.query(`
    INSERT INTO eng_rd_projects
      (name, code, description, category, status, priority, manager_name, team_members, budget, start_date, target_date, tags, created_by, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING *
  `, [name, code || null, description, category, status, priority, manager_name, team_members, budget || null, start_date || null, target_date || null, tags, req.user?.userId ?? req.user?.id ?? null, companyId]);

  // seed default phases
  const defaultPhases = [
    { name: 'Concept',          order: 1 },
    { name: 'Preliminary Design', order: 2 },
    { name: 'Detailed Design',  order: 3 },
    { name: 'Design Review',    order: 4 },
    { name: 'Approved',         order: 5 },
  ];
  for (const ph of defaultPhases) {
    await pool.query(
      `INSERT INTO eng_design_phases (project_id, phase_name, phase_order) VALUES ($1,$2,$3)`,
      [rows[0].id, ph.name, ph.order]
    );
  }

  res.json({ success: true, data: rows[0] });
}));

router.put('/rd-projects/:id', safe(async (req, res) => {
  const {
    name, code, description, category, status, priority,
    manager_name, team_members, budget, spent, start_date, target_date, completed_date, tags,
  } = req.body;

  const { rows } = await pool.query(`
    UPDATE eng_rd_projects SET
      name=$1, code=$2, description=$3, category=$4, status=$5, priority=$6,
      manager_name=$7, team_members=$8, budget=$9, spent=$10,
      start_date=$11, target_date=$12, completed_date=$13, tags=$14, updated_at=NOW()
    WHERE id=$15 AND deleted_at IS NULL
    RETURNING *
  `, [name, code || null, description, category, status, priority, manager_name, team_members, budget || null, spent || 0, start_date || null, target_date || null, completed_date || null, tags, req.params.id]);

  if (!rows.length) return res.status(404).json({ success: false, message: 'Project not found' });
  res.json({ success: true, data: rows[0] });
}));

router.delete('/rd-projects/:id', safe(async (req, res) => {
  await pool.query(
    `UPDATE eng_rd_projects SET deleted_at=NOW() WHERE id=$1`,
    [req.params.id]
  );
  res.json({ success: true });
}));

// ── Design Phases ──────────────────────────────────────────────────────────
router.get('/rd-projects/:id/phases', safe(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM eng_design_phases WHERE project_id=$1 ORDER BY phase_order, id`,
    [req.params.id]
  );
  res.json({ success: true, data: rows });
}));

router.post('/rd-projects/:id/phases', safe(async (req, res) => {
  const { phase_name, phase_order, description, deliverables, assigned_to, start_date, end_date } = req.body;
  const companyId = cid(req);
  const { rows } = await pool.query(`
    INSERT INTO eng_design_phases (project_id, phase_name, phase_order, description, deliverables, assigned_to, start_date, end_date, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
  `, [req.params.id, phase_name, phase_order || 0, description, deliverables, assigned_to, start_date || null, end_date || null, companyId]);
  res.json({ success: true, data: rows[0] });
}));

router.put('/phases/:id', safe(async (req, res) => {
  const { phase_name, status, description, deliverables, assigned_to, start_date, end_date, completed_date, notes } = req.body;
  const { rows } = await pool.query(`
    UPDATE eng_design_phases SET
      phase_name=$1, status=$2, description=$3, deliverables=$4,
      assigned_to=$5, start_date=$6, end_date=$7, completed_date=$8, notes=$9, updated_at=NOW()
    WHERE id=$10 RETURNING *
  `, [phase_name, status, description, deliverables, assigned_to, start_date || null, end_date || null, completed_date || null, notes, req.params.id]);

  if (!rows.length) return res.status(404).json({ success: false, message: 'Phase not found' });
  res.json({ success: true, data: rows[0] });
}));

// ── Prototypes ─────────────────────────────────────────────────────────────
router.get('/prototypes', safe(async (req, res) => {
  const { project_id } = req.query;
  const companyId = cid(req);
  const params = [companyId];
  let where = [`p.deleted_at IS NULL`, `($1::int IS NULL OR p.company_id = $1)`];
  if (project_id) { params.push(project_id); where.push(`pt.project_id = $${params.length}`); }

  const { rows } = await pool.query(`
    SELECT pt.*, p.name AS project_name, p.code AS project_code
    FROM eng_prototypes pt
    JOIN eng_rd_projects p ON p.id = pt.project_id
    WHERE ${where.join(' AND ')}
    ORDER BY pt.project_id, pt.iteration DESC
  `, params);

  res.json({ success: true, data: rows });
}));

router.post('/prototypes', safe(async (req, res) => {
  const { project_id, title, specs, materials, build_cost, build_date, assigned_to } = req.body;
  const companyId = cid(req);

  const maxIter = await pool.query(
    `SELECT COALESCE(MAX(iteration),0)+1 AS next FROM eng_prototypes WHERE project_id=$1`,
    [project_id]
  );
  const iteration = maxIter.rows[0].next;

  const { rows } = await pool.query(`
    INSERT INTO eng_prototypes (project_id, iteration, title, specs, materials, build_cost, build_date, assigned_to, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
  `, [project_id, iteration, title, specs, materials, build_cost || null, build_date || null, assigned_to, companyId]);

  res.json({ success: true, data: rows[0] });
}));

router.delete('/prototypes/:id', safe(async (req, res) => {
  await pool.query(`DELETE FROM eng_prototypes WHERE id=$1`, [req.params.id]);
  res.json({ success: true });
}));

router.put('/prototypes/:id', safe(async (req, res) => {
  const { title, status, specs, materials, build_cost, build_date, test_date, test_result, test_notes, assigned_to } = req.body;
  const { rows } = await pool.query(`
    UPDATE eng_prototypes SET
      title=$1, status=$2, specs=$3, materials=$4, build_cost=$5,
      build_date=$6, test_date=$7, test_result=$8, test_notes=$9, assigned_to=$10, updated_at=NOW()
    WHERE id=$11 RETURNING *
  `, [title, status, specs, materials, build_cost || null, build_date || null, test_date || null, test_result, test_notes, assigned_to, req.params.id]);

  if (!rows.length) return res.status(404).json({ success: false, message: 'Prototype not found' });
  res.json({ success: true, data: rows[0] });
}));

// ── Test Plans ─────────────────────────────────────────────────────────────
router.get('/test-plans', safe(async (req, res) => {
  const { project_id } = req.query;
  const companyId = cid(req);
  const params = [companyId];
  let where = [`p.deleted_at IS NULL`, `($1::int IS NULL OR p.company_id = $1)`];
  if (project_id) { params.push(project_id); where.push(`tp.project_id = $${params.length}`); }

  const { rows } = await pool.query(`
    SELECT tp.*, p.name AS project_name, p.code AS project_code,
           pt.iteration AS prototype_iteration, pt.title AS prototype_title
    FROM eng_test_plans tp
    JOIN eng_rd_projects p ON p.id = tp.project_id
    LEFT JOIN eng_prototypes pt ON pt.id = tp.prototype_id
    WHERE ${where.join(' AND ')}
    ORDER BY tp.created_at DESC
  `, params);

  res.json({ success: true, data: rows });
}));

router.post('/test-plans', safe(async (req, res) => {
  const {
    project_id, prototype_id, title, description, test_type,
    acceptance_criteria, planned_date, executed_by,
  } = req.body;
  const companyId = cid(req);

  const { rows } = await pool.query(`
    INSERT INTO eng_test_plans
      (project_id, prototype_id, title, description, test_type, acceptance_criteria, planned_date, executed_by, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
  `, [project_id, prototype_id || null, title, description, test_type, acceptance_criteria, planned_date || null, executed_by, companyId]);

  res.json({ success: true, data: rows[0] });
}));

router.put('/test-plans/:id', safe(async (req, res) => {
  const {
    title, description, test_type, acceptance_criteria, status,
    result, findings, executed_by, planned_date, executed_date, prototype_id,
  } = req.body;

  const { rows } = await pool.query(`
    UPDATE eng_test_plans SET
      title=$1, description=$2, test_type=$3, acceptance_criteria=$4, status=$5,
      result=$6, findings=$7, executed_by=$8, planned_date=$9, executed_date=$10,
      prototype_id=$11, updated_at=NOW()
    WHERE id=$12 RETURNING *
  `, [title, description, test_type, acceptance_criteria, status, result, findings, executed_by, planned_date || null, executed_date || null, prototype_id || null, req.params.id]);

  if (!rows.length) return res.status(404).json({ success: false, message: 'Test plan not found' });
  res.json({ success: true, data: rows[0] });
}));

router.delete('/test-plans/:id', safe(async (req, res) => {
  await pool.query(`DELETE FROM eng_test_plans WHERE id=$1`, [req.params.id]);
  res.json({ success: true });
}));

// GET /development now lives in development.routes.js, mounted ahead of this
// router. The version that stood here read a `rd_projects` table that has never
// existed in any migration — it threw 42P01 on every call and was also the only
// unscoped route in this file. See migration 20260717000001.

// ── Engineering Module Settings ───────────────────────────────────────────────
// GET  /engineering/settings/bom-policies  — load saved BOM policy config
// POST /engineering/settings/bom-policies  — save BOM policy config
// GET  /engineering/settings/docs          — load saved document storage config
// POST /engineering/settings/docs          — save document storage config
//
// Stored in company_settings (module = 'bom_policies' | 'engineering_docs').
// company_id=0 is used as a sentinel for single-tenant / no-scope installs.

router.get('/settings/bom-policies', safe(async (req, res) => {
  const companyId = cid(req) ?? 0;
  const { rows } = await pool.query(
    `SELECT settings FROM company_settings WHERE company_id=$1 AND module='bom_policies' LIMIT 1`,
    [companyId]
  );
  res.json(rows[0]?.settings ?? {});
}));

router.post('/settings/bom-policies', safe(async (req, res) => {
  const companyId = cid(req) ?? 0;
  await pool.query(
    `INSERT INTO company_settings (company_id, module, settings, updated_at)
     VALUES ($1, 'bom_policies', $2::JSONB, NOW())
     ON CONFLICT (company_id, module)
     DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
    [companyId, JSON.stringify(req.body)]
  );
  res.json({ success: true });
}));

router.get('/settings/docs', safe(async (req, res) => {
  const companyId = cid(req) ?? 0;
  const { rows } = await pool.query(
    `SELECT settings FROM company_settings WHERE company_id=$1 AND module='engineering_docs' LIMIT 1`,
    [companyId]
  );
  res.json(rows[0]?.settings ?? {});
}));

router.post('/settings/docs', safe(async (req, res) => {
  const companyId = cid(req) ?? 0;
  await pool.query(
    `INSERT INTO company_settings (company_id, module, settings, updated_at)
     VALUES ($1, 'engineering_docs', $2::JSONB, NOW())
     ON CONFLICT (company_id, module)
     DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
    [companyId, JSON.stringify(req.body)]
  );
  res.json({ success: true });
}));

export default router;
