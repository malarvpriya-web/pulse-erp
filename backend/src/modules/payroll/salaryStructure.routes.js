// backend/src/modules/payroll/salaryStructure.routes.js
// Mounted at /salary-structures in server.js — all paths here are relative to that prefix.
import express from 'express';
import pool from '../../config/db.js';
import { computeEarningsFromComponents } from './payrollEngine.js';
import { companyOf } from '../../shared/scope.js';
import { normalizePayrollSettings } from './payrollSettings.js';
import { computeCtc, createProposal, approveProposal, rejectProposal, listProposals, ProposalError } from './salaryProposals.service.js';
import { verifyToken, requirePermission } from '../../middlewares/auth.middleware.js';
import { captureBefore } from '../../middlewares/captureBefore.js';

const router = express.Router();

// PC-01 (04 Nov 26): the permission matrix decides, never a role list here.
// The list this replaced gave manager, hr_exec and finance_manager salary
// structures, assignments and proposals although the matrix grants them none.
//   payroll:view  read structures, assignments, proposals; CTC preview (no write)
//   payroll:add   create / copy a structure
//   payroll:edit  edit a structure, assign a salary revision, draft a proposal
//   salary_proposals:approve  approve / reject a proposal (D1)
const perm = (action) => requirePermission('payroll', action);

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
    // Statutory components (PF, PT, ESI) are NOT priced by the structure: they
    // come from Payroll Settings and the statutory rules in force. Pricing them
    // here showed PT on every preview while Payroll Settings had PT switched off.
    else if (c.type === 'deduction') totalDeductions += amount;
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

/* ─── Structures are company-aware ──────────────────────────────
 * company_id NULL = a SHARED TEMPLATE every company can use; anything else
 * belongs to one company. A company sees templates + its own structures, can
 * copy a template into its own, and can edit only its own. Editing a shared
 * template changes pay in every company, so only a super admin may do it —
 * before this, any company's HR could edit (and re-default) the structures
 * every other company's payroll uses. */
const isSuperAdmin = (req) => (req.user?.roles?.length ? req.user.roles : [req.user?.role])
  .map(r => String(r || '').toLowerCase()).includes('super_admin');

async function listStructures(req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, jsonb_array_length(s.components) AS component_count, (s.company_id IS NULL) AS shared
        FROM salary_structures s
       WHERE s.company_id IS NULL OR s.company_id = $1
       ORDER BY (s.company_id IS NULL), s.is_default DESC, s.name`, [companyOf(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
}

/* ─── GET /salary-structures ── alias for double-prefix URL pattern ── */
router.get('/salary-structures', verifyToken, perm('view'), listStructures);

/* ─── GET / ── templates + this company's structures ─────────── */
router.get('/', verifyToken, perm('view'), listStructures);

/* ─── POST / ── create a structure (this company's; shared only for super admin) ── */
router.post('/', verifyToken, perm('add'), async (req, res) => {
  const { name, description, is_default = false, components = [], scope = 'company' } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  const cid = companyOf(req);
  const shared = scope === 'shared';
  if (shared && !isSuperAdmin(req)) return res.status(403).json({ message: 'Only a super admin can create a shared template' });
  if (!shared && cid == null) return res.status(400).json({ message: 'Company context required' });
  try {
    if (is_default) {
      await pool.query(`UPDATE salary_structures SET is_default = false WHERE company_id IS NOT DISTINCT FROM $1`, [shared ? null : cid]);
    }
    const { rows } = await pool.query(
      `INSERT INTO salary_structures (name, description, is_default, components, company_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, description, is_default, JSON.stringify(components), shared ? null : cid]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /:id/copy ── copy a template into this company ─────── */
router.post('/:id/copy', verifyToken, perm('add'), async (req, res) => {
  const cid = companyOf(req);
  if (cid == null) return res.status(400).json({ message: 'Company context required' });
  try {
    const { rows: [src] } = await pool.query(
      `SELECT * FROM salary_structures WHERE id = $1 AND (company_id IS NULL OR company_id = $2)`, [req.params.id, cid]);
    if (!src) return res.status(404).json({ message: 'Not found' });
    const { rows } = await pool.query(
      `INSERT INTO salary_structures (name, description, is_default, components, company_id, template_id)
       VALUES ($1,$2,false,$3,$4,$5) RETURNING *`,
      [req.body?.name || `${src.name} (company copy)`, src.description, JSON.stringify(src.components), cid, src.company_id == null ? src.id : src.template_id]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── CTC (PAYROLL_DATA_FLOW_AUDIT.md Part 4) ─────────────────────
 * POST /ctc-preview          figures for an annual CTC or a monthly Basic (no write)
 * GET  /proposals            this company's salary proposals
 * POST /proposals            draft a CTC-driven revision (ctc_mode must be ON)
 * POST /proposals/:id/approve | /reject   salary_proposals:approve (D1)     */
const proposalError = (res, e) => (e instanceof ProposalError
  ? res.status(e.status).json({ message: e.message, ...e.extra })
  : res.status(500).json({ message: e.message }));

router.post('/ctc-preview', verifyToken, perm('view'), async (req, res) => {
  try {
    const { structure_id = null, employee_id = null, effective_from, annual_ctc = null, basic_monthly = null } = req.body || {};
    res.json(await computeCtc({ company_id: companyOf(req), structure_id, employee_id, effective_from, annual_ctc, basic_monthly }));
  } catch (e) { proposalError(res, e); }
});

router.get('/proposals', verifyToken, perm('view'), async (req, res) => {
  try { res.json(await listProposals({ company_id: companyOf(req), status: req.query.status || null })); }
  catch (e) { proposalError(res, e); }
});

router.post('/proposals', verifyToken, perm('edit'), async (req, res) => {
  try {
    const { employee_id, structure_id = null, effective_from, annual_ctc = null, basic_monthly = null } = req.body || {};
    const r = await createProposal({ company_id: companyOf(req), employee_id, structure_id, effective_from, annual_ctc, basic_monthly,
      source_type: 'manual', userId: req.user?.userId ?? null, req });
    res.status(201).json(r);
  } catch (e) { proposalError(res, e); }
});

router.post('/proposals/:id/approve', verifyToken, requirePermission('salary_proposals', 'approve'), async (req, res) => {
  try { res.json(await approveProposal({ company_id: companyOf(req), id: Number(req.params.id), userId: req.user?.userId ?? null, note: req.body?.note ?? null, req })); }
  catch (e) { proposalError(res, e); }
});

router.post('/proposals/:id/reject', verifyToken, requirePermission('salary_proposals', 'approve'), async (req, res) => {
  try { res.json(await rejectProposal({ company_id: companyOf(req), id: Number(req.params.id), userId: req.user?.userId ?? null, note: req.body?.note ?? null, req })); }
  catch (e) { proposalError(res, e); }
});

/* ─── GET /assignments ── every employee + the revision in force today ─── */
// One row per employee of the caller's company — INCLUDING employees with no
// salary revision. This used to list only employees who already had a row in
// employee_salary_assignments, so the 28 employees without one could never be
// given a salary from this screen (Assign / Bulk Assign act on these rows).
// `gross_estimate` is the payroll engine's full-month gross for that Basic and
// structure — it replaces the frontend's `basic * 1.4167`, which showed
// ₹30,000 → ₹42,501 while payroll would compute ₹75,000.
router.get('/assignments', verifyToken, perm('view'), async (req, res) => {
  // companyOf only: the old `req.query.company_id ?? req.scope` let any HR user
  // read another tenant's salaries by adding ?company_id=.
  const companyId = companyOf(req);
  if (companyId == null) return res.status(400).json({ message: 'Company context required' });
  try {
    // The revision in force on the DATABASE's date (UTC is a day behind 00:00–05:30 IST).
    const today = (await pool.query('SELECT CURRENT_DATE::text AS d')).rows[0].d;
    const { rows } = await pool.query(`
      SELECT e.id AS employee_id, e.office_id AS employee_code, e.department, e.status AS employee_status,
             TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
             a.id, a.structure_id, a.effective_from, a.basic_salary, a.special_allowance,
             a.loan_deduction, a.advance_deduction, a.created_at,
             a.entry_mode, a.annual_ctc, a.ctc_policy_version, a.breakdown,
             (SELECT COUNT(*)::int FROM salary_revision_proposals p WHERE p.employee_id = e.id AND p.status = 'draft') AS draft_proposals,
             COALESCE(s.name, ds.name) AS structure_name, COALESCE(s.components, ds.components) AS components,
             (a.structure_id IS NULL) AS uses_default_structure,
             (SELECT COUNT(*)::int FROM employee_salary_assignments f WHERE f.employee_id = e.id AND f.effective_from > $2::date) AS future_revisions,
             (SELECT pr.status FROM payroll_runs pr WHERE pr.employee_id = e.id AND pr.is_test = false
               ORDER BY pr.year DESC, pr.month DESC LIMIT 1) AS last_payslip_status
        FROM employees e
        LEFT JOIN LATERAL (
          SELECT * FROM employee_salary_assignments x
           WHERE x.employee_id = e.id AND x.effective_from <= $2::date
           ORDER BY x.effective_from DESC, x.created_at DESC LIMIT 1
        ) a ON true
        LEFT JOIN salary_structures s ON s.id = a.structure_id
        LEFT JOIN LATERAL (SELECT name, components FROM salary_structures
                            WHERE is_default AND (company_id = e.company_id OR company_id IS NULL)
                            ORDER BY company_id NULLS LAST, id LIMIT 1) ds ON true
       WHERE e.company_id = $1 AND e.deleted_at IS NULL
         AND LOWER(e.status) IN ('active', 'probation', 'notice')
       ORDER BY e.first_name`, [companyId, today]);
    res.json(rows.map(({ components, breakdown, ...r }) => {
      let gross_estimate = null;
      // An approved CTC revision is paid from its stored breakdown.
      if (breakdown?.monthly?.gross != null) gross_estimate = Number(breakdown.monthly.gross);
      else if (Number(r.basic_salary) > 0 && Array.isArray(components) && components.length) {
        gross_estimate = Math.round(computeEarningsFromComponents(components, Number(r.basic_salary)).gross);
      }
      return { ...r, has_revision: r.id != null, gross_estimate };
    }));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /:id ── single structure (template or this company's) ─ */
router.get('/:id', verifyToken, perm('view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM salary_structures WHERE id = $1 AND (company_id IS NULL OR company_id = $2)', [req.params.id, companyOf(req)]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    const structure = rows[0];
    structure.preview = previewStructure(structure.components || []);
    res.json(structure);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /:id ── update a structure the caller may edit ─────── */
router.put('/:id', verifyToken, perm('edit'), captureBefore('salary_structures'), async (req, res) => {
  const { name, description, is_default, components } = req.body;
  const cid = companyOf(req);
  try {
    const { rows: [cur] } = await pool.query('SELECT id, company_id FROM salary_structures WHERE id = $1', [req.params.id]);
    if (!cur || (cur.company_id != null && cur.company_id !== cid)) return res.status(404).json({ message: 'Not found' });
    if (cur.company_id == null && !isSuperAdmin(req)) {
      return res.status(403).json({ message: 'This is a shared template used by every company. Copy it into your company (POST /salary-structures/:id/copy) and edit the copy.' });
    }
    if (is_default) {
      await pool.query('UPDATE salary_structures SET is_default = false WHERE id <> $1 AND company_id IS NOT DISTINCT FROM $2', [req.params.id, cur.company_id]);
    }
    const { rows } = await pool.query(
      `UPDATE salary_structures SET name=COALESCE($1,name), description=COALESCE($2,description),
       is_default=COALESCE($3,is_default), components=COALESCE($4,components), updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [name, description, is_default, components ? JSON.stringify(components) : null, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /:id/assign ── record a salary revision ──────────────── */
// basic_salary is MONTHLY. A figure above ₹5,00,000/month must be confirmed:
// EMP038's ₹7,50,000 was paid as a monthly Basic (₹18,75,000 gross in one
// month) — it reads like an annual figure typed into a monthly field.
const HIGH_MONTHLY_BASIC = 500000;
router.post('/:id/assign', verifyToken, perm('edit'), async (req, res) => {
  const { employee_id, effective_from, basic_salary, special_allowance = 0,
          other_components = {}, loan_deduction = 0, advance_deduction = 0, confirm_high_basic = false } = req.body;
  const basic = parseFloat(basic_salary);
  if (!employee_id || !(basic > 0)) return res.status(400).json({ message: 'employee_id and a monthly basic_salary > 0 are required' });
  if (basic > HIGH_MONTHLY_BASIC && !confirm_high_basic) {
    return res.status(422).json({
      code: 'CONFIRM_HIGH_BASIC',
      message: `Basic is entered PER MONTH. ₹${basic.toLocaleString('en-IN')} a month is ₹${(basic * 12).toLocaleString('en-IN')} a year of Basic alone. If this is an annual figure, enter ₹${Math.round(basic / 12).toLocaleString('en-IN')}. Resubmit with confirmation to keep it.`,
    });
  }
  const cid = companyOf(req);
  try {
    const { rows: own } = await pool.query('SELECT 1 FROM employees WHERE id = $1 AND company_id = $2', [employee_id, cid]);
    if (!own.length) return res.status(404).json({ message: 'Employee not found' });
    // In CTC mode every salary change goes through a proposal and an approver;
    // a direct revision here would bypass that.
    const { rows: cfg } = await pool.query("SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'payroll' LIMIT 1", [cid]);
    if (normalizePayrollSettings(cfg[0]?.settings || {}).settings.ctc_mode) {
      return res.status(409).json({ code: 'CTC_MODE', message: 'CTC-driven salary entry is on for this company — prepare a salary proposal (POST /salary-structures/proposals) instead of a direct revision' });
    }
    const { rows: st } = await pool.query('SELECT 1 FROM salary_structures WHERE id = $1 AND (company_id IS NULL OR company_id = $2)', [req.params.id, cid]);
    if (!st.length) return res.status(404).json({ message: 'Salary structure not found' });
    const eff = effective_from || new Date().toISOString().split('T')[0];
    // A revision dated inside an approved payroll month would silently differ
    // from what was paid — the difference belongs in arrears.
    const { rows: locked } = await pool.query(
      `SELECT month, year FROM payroll_runs
        WHERE employee_id = $1 AND status IN ('approved','paid') AND period_end >= $2::date
        ORDER BY year DESC, month DESC LIMIT 1`, [employee_id, eff]);
    if (locked.length && !req.body.allow_retro) {
      return res.status(409).json({ code: 'RETRO_REVISION', message: `Payroll is already approved for ${locked[0].month}/${locked[0].year}. Date the revision after it and raise arrears for the earlier months, or resubmit with allow_retro to record history only.` });
    }
    // Upsert on (employee_id, effective_from) — see migration 20260930000002:
    // re-assigning on a date that already has a row CORRECTS that revision.
    const { rows } = await pool.query(
      `INSERT INTO employee_salary_assignments
         (employee_id, structure_id, effective_from, basic_salary, special_allowance,
          other_components, loan_deduction, advance_deduction)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (employee_id, effective_from)
       DO UPDATE SET structure_id = EXCLUDED.structure_id, basic_salary = EXCLUDED.basic_salary,
         special_allowance = EXCLUDED.special_allowance, other_components = EXCLUDED.other_components,
         loan_deduction = EXCLUDED.loan_deduction, advance_deduction = EXCLUDED.advance_deduction, updated_at = NOW()
       RETURNING *`,
      [employee_id, req.params.id, eff, basic, special_allowance, JSON.stringify(other_components), loan_deduction, advance_deduction]
    );
    // Keep the denormalised copy in step when this revision is the one in force.
    await pool.query(
      `UPDATE employees e SET basic_salary = a.basic_salary
         FROM (SELECT basic_salary FROM employee_salary_assignments
                WHERE employee_id = $1 AND effective_from <= CURRENT_DATE
                ORDER BY effective_from DESC, created_at DESC LIMIT 1) a
        WHERE e.id = $1 AND e.company_id = $2`, [employee_id, cid]);
    res.status(201).json(rows[0] || { message: 'Assignment saved' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
