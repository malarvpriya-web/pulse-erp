// backend/src/modules/payroll/salaryStructure.routes.js
// Mounted at /salary-structures in server.js — all paths here are relative to that prefix.
import express from 'express';
import pool from '../../config/db.js';
import { computePayroll, getMonthName, generateForm16Summary } from './payrollEngine.js';
import { verifyToken, allowRoles } from '../../middlewares/auth.middleware.js';

const router = express.Router();

const HR_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'manager', 'finance_manager'];

/* ─── seed default salary structures if none exist ───────────── */
async function seedSalaryStructures() {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) FROM salary_structures');
    if (parseInt(rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO salary_structures (name, description, is_default, components) VALUES
        ('Standard Structure', 'Default structure for all employees', true,
         '[{"name":"Basic","type":"earning","calculation_type":"percentage_of_ctc","value":40,"is_taxable":true,"is_pf_applicable":true},
           {"name":"HRA","type":"earning","calculation_type":"percentage_of_basic","value":40,"is_taxable":false,"is_pf_applicable":false},
           {"name":"Conveyance","type":"earning","calculation_type":"fixed","value":1600,"is_taxable":false,"is_pf_applicable":false},
           {"name":"Medical","type":"earning","calculation_type":"fixed","value":1250,"is_taxable":false,"is_pf_applicable":false},
           {"name":"Special Allowance","type":"earning","calculation_type":"balancing","value":0,"is_taxable":true,"is_pf_applicable":false},
           {"name":"Employee PF","type":"statutory","calculation_type":"percentage_of_basic","value":12,"is_taxable":false,"is_pf_applicable":true},
           {"name":"Professional Tax","type":"statutory","calculation_type":"fixed","value":200,"is_taxable":false,"is_pf_applicable":false}]'),
        ('Senior Management', 'Structure for senior positions with NPS', false,
         '[{"name":"Basic","type":"earning","calculation_type":"percentage_of_ctc","value":40,"is_taxable":true,"is_pf_applicable":true},
           {"name":"HRA","type":"earning","calculation_type":"percentage_of_basic","value":50,"is_taxable":false,"is_pf_applicable":false},
           {"name":"Conveyance","type":"earning","calculation_type":"fixed","value":3200,"is_taxable":false,"is_pf_applicable":false},
           {"name":"Medical","type":"earning","calculation_type":"fixed","value":2500,"is_taxable":false,"is_pf_applicable":false},
           {"name":"LTA","type":"earning","calculation_type":"percentage_of_basic","value":8.33,"is_taxable":false,"is_pf_applicable":false},
           {"name":"Special Allowance","type":"earning","calculation_type":"balancing","value":0,"is_taxable":true,"is_pf_applicable":false},
           {"name":"Employee PF","type":"statutory","calculation_type":"percentage_of_basic","value":12,"is_taxable":false,"is_pf_applicable":true},
           {"name":"NPS","type":"deduction","calculation_type":"percentage_of_basic","value":10,"is_taxable":false,"is_pf_applicable":false},
           {"name":"Professional Tax","type":"statutory","calculation_type":"fixed","value":200,"is_taxable":false,"is_pf_applicable":false}]'),
        ('Manufacturing / Industrial', 'Structure for factory and field workers with night shift and commissioning pay', false,
         '[{"name":"Basic","type":"earning","calculation_type":"percentage_of_ctc","value":40,"is_taxable":true,"is_pf_applicable":true},
           {"name":"HRA","type":"earning","calculation_type":"percentage_of_basic","value":40,"is_taxable":false,"is_pf_applicable":false},
           {"name":"Conveyance","type":"earning","calculation_type":"fixed","value":1600,"is_taxable":false,"is_pf_applicable":false},
           {"name":"Night Shift Allowance","type":"earning","calculation_type":"fixed","value":200,"is_taxable":true,"is_pf_applicable":false},
           {"name":"Commissioning Allowance","type":"earning","calculation_type":"fixed","value":5000,"is_taxable":true,"is_pf_applicable":false},
           {"name":"Special Allowance","type":"earning","calculation_type":"balancing","value":0,"is_taxable":true,"is_pf_applicable":false},
           {"name":"Employee PF","type":"statutory","calculation_type":"percentage_of_basic","value":12,"is_taxable":false,"is_pf_applicable":true},
           {"name":"Professional Tax","type":"statutory","calculation_type":"fixed","value":200,"is_taxable":false,"is_pf_applicable":false}]')
      `);
    }
  } catch (e) { console.error('[payroll] seed salary structures failed:', e.message); }
}
seedSalaryStructures();

/* ─── helper: build preview ──────────────────────────────────── */
function previewStructure(components, ctc = 50000) {
  let gross = 0; let totalDeductions = 0;
  let basicAmount = 0;
  const lines = [];
  for (const c of components) {
    let amount = 0;
    if (c.calculation_type === 'fixed')
      amount = parseFloat(c.value) || 0;
    else if (c.calculation_type === 'percentage_of_ctc')
      amount = Math.round(ctc * (parseFloat(c.value) || 0) / 100);
    else if (c.calculation_type === 'percentage_of_basic')
      amount = Math.round(basicAmount * (parseFloat(c.value) || 0) / 100);
    else if (c.calculation_type === 'percentage_of_gross')
      amount = Math.round(gross * (parseFloat(c.value) || 0) / 100);
    // 'balancing' resolved in second pass
    if (c.type === 'earning' && c.calculation_type !== 'balancing') gross += amount;
    else if (c.type !== 'earning') totalDeductions += amount;
    if (c.name === 'Basic') basicAmount = amount;
    lines.push({ ...c, computed_amount: amount });
  }
  // Resolve balancing components
  for (const l of lines) {
    if (l.calculation_type === 'balancing' && l.type === 'earning') {
      l.computed_amount = Math.max(0, ctc - gross);
      gross += l.computed_amount;
    }
  }
  return { lines, gross, total_deductions: totalDeductions, net: gross - totalDeductions };
}

/* ─── GET /salary-structures ── alias for double-prefix URL pattern ── */
router.get('/salary-structures', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*,
             jsonb_array_length(s.components) AS component_count
      FROM salary_structures s
      ORDER BY s.is_default DESC, s.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET / ── list all structures ──────────────────────────── */
router.get('/', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*,
             jsonb_array_length(s.components) AS component_count
      FROM salary_structures s
      ORDER BY s.is_default DESC, s.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST / ── create structure ─────────────────────────────── */
router.post('/', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const { name, description, is_default = false, components = [] } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  try {
    if (is_default) await pool.query('UPDATE salary_structures SET is_default=false');
    const { rows } = await pool.query(
      `INSERT INTO salary_structures (name, description, is_default, components)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, description, is_default, JSON.stringify(components)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /assignments ── all employee salary assignments ─────── */
router.get('/assignments', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  try {
    // Scope to company_id if provided (via ?company_id= or req.scope)
    const companyId = req.query.company_id ?? req.scope?.company_id ?? null;
    const params = [];
    let companyFilter = '';
    if (companyId != null) {
      params.push(companyId);
      companyFilter = `AND e.company_id = $${params.length}`;
    }

    const { rows } = await pool.query(`
      SELECT
        a.id,
        a.employee_id,
        a.structure_id,
        a.effective_from,
        a.basic_salary,
        a.special_allowance,
        a.loan_deduction,
        a.advance_deduction,
        a.created_at,
        s.name  AS structure_name,
        s.is_default,
        TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
        e.office_id AS employee_code,
        e.department
      FROM employee_salary_assignments a
      LEFT JOIN salary_structures s ON s.id = a.structure_id
      LEFT JOIN employees e ON e.id = a.employee_id
      WHERE e.id IS NOT NULL ${companyFilter}
      ORDER BY a.effective_from DESC, a.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /:id ── single structure ───────────────────────────── */
router.get('/:id', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM salary_structures WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    const structure = rows[0];
    structure.preview = previewStructure(structure.components || []);
    res.json(structure);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /:id ── update structure ───────────────────────────── */
router.put('/:id', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const { name, description, is_default, components } = req.body;
  try {
    if (is_default) await pool.query('UPDATE salary_structures SET is_default=false WHERE id!=$1', [req.params.id]);
    const { rows } = await pool.query(
      `UPDATE salary_structures SET name=COALESCE($1,name), description=COALESCE($2,description),
       is_default=COALESCE($3,is_default), components=COALESCE($4,components), updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [name, description, is_default, components ? JSON.stringify(components) : null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /:id/assign ── assign structure to employee ─────────── */
router.post('/:id/assign', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const { employee_id, effective_from, basic_salary, special_allowance = 0,
          other_components = {}, loan_deduction = 0, advance_deduction = 0 } = req.body;
  if (!employee_id || !basic_salary) return res.status(400).json({ message: 'employee_id and basic_salary required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO employee_salary_assignments
         (employee_id, structure_id, effective_from, basic_salary, special_allowance,
          other_components, loan_deduction, advance_deduction)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (employee_id, structure_id, effective_from)
       DO UPDATE SET
         basic_salary = EXCLUDED.basic_salary,
         special_allowance = EXCLUDED.special_allowance,
         other_components = EXCLUDED.other_components,
         loan_deduction = EXCLUDED.loan_deduction,
         advance_deduction = EXCLUDED.advance_deduction,
         updated_at = NOW()
       RETURNING *`,
      [employee_id, req.params.id, effective_from || new Date().toISOString().split('T')[0],
       basic_salary, special_allowance, JSON.stringify(other_components), loan_deduction, advance_deduction]
    );
    res.status(201).json(rows[0] || { message: 'Assignment saved' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
