/**
 * travel-policy.routes.js
 * Phase 47 — Travel Policy Engine
 *
 * Configures expense limits per grade / role / department.
 * Admin-only for CRUD; all authenticated users can do policy-check.
 */
import express from 'express';
import pool from '../shared/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();
const uid = req => req.user?.userId ?? req.user?.id ?? null;
const cid = req => companyOf(req);

// ── GET /travel-policy ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rule_type, is_active } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`company_id=$${idx++}`); params.push(companyId); }
    if (rule_type) { conditions.push(`rule_type=$${idx++}`); params.push(rule_type); }
    if (is_active !== undefined) { conditions.push(`is_active=$${idx++}`); params.push(is_active === 'true'); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM travel_policy_rules ${where} ORDER BY rule_type, grade, role, department`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /travel-policy/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows: [rule] } = await pool.query(
      `SELECT * FROM travel_policy_rules WHERE id=$1`, [req.params.id]);
    if (!rule) return res.status(404).json({ error: 'Policy rule not found' });
    res.json(rule);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /travel-policy ───────────────────────────────────────────────────────
router.post('/', allowRoles('admin', 'super_admin', 'hr'), async (req, res) => {
  try {
    const {
      rule_name, rule_type = 'grade',
      grade, role, department,
      hotel_limit_per_day, meal_limit_per_day, travel_daily_allowance,
      flight_eligible, train_class, local_conveyance_limit,
      miscellaneous_limit, max_advance_amount,
      effective_from, effective_to,
    } = req.body;

    if (!rule_name) return res.status(400).json({ error: 'rule_name is required' });

    const actorId = uid(req);
    const companyId = cid(req);

    const { rows: [rule] } = await pool.query(`
      INSERT INTO travel_policy_rules
        (rule_name, rule_type, grade, role, department,
         hotel_limit_per_day, meal_limit_per_day, travel_daily_allowance,
         flight_eligible, train_class, local_conveyance_limit,
         miscellaneous_limit, max_advance_amount,
         effective_from, effective_to, is_active, company_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,$16,$17)
      RETURNING *
    `, [rule_name, rule_type, grade||null, role||null, department||null,
        Number(hotel_limit_per_day)||0, Number(meal_limit_per_day)||0,
        Number(travel_daily_allowance)||0,
        flight_eligible||false, train_class||'Sleeper',
        Number(local_conveyance_limit)||0, Number(miscellaneous_limit)||0,
        Number(max_advance_amount)||0,
        effective_from||null, effective_to||null,
        companyId, actorId]);

    logAudit({ userId: actorId, module: 'travel_policy', recordId: rule.id,
      recordType: 'travel_policy_rule', action: 'create', newData: rule });
    res.status(201).json(rule);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /travel-policy/:id ────────────────────────────────────────────────────
router.put('/:id', allowRoles('admin', 'super_admin', 'hr'), async (req, res) => {
  try {
    const {
      rule_name, rule_type, grade, role, department,
      hotel_limit_per_day, meal_limit_per_day, travel_daily_allowance,
      flight_eligible, train_class, local_conveyance_limit,
      miscellaneous_limit, max_advance_amount,
      effective_from, effective_to, is_active,
    } = req.body;

    const actorId = uid(req);
    const { rows: [updated] } = await pool.query(`
      UPDATE travel_policy_rules SET
        rule_name=$1, rule_type=$2, grade=$3, role=$4, department=$5,
        hotel_limit_per_day=$6, meal_limit_per_day=$7, travel_daily_allowance=$8,
        flight_eligible=$9, train_class=$10, local_conveyance_limit=$11,
        miscellaneous_limit=$12, max_advance_amount=$13,
        effective_from=$14, effective_to=$15, is_active=$16, updated_at=NOW()
      WHERE id=$17 RETURNING *
    `, [rule_name, rule_type, grade||null, role||null, department||null,
        Number(hotel_limit_per_day)||0, Number(meal_limit_per_day)||0,
        Number(travel_daily_allowance)||0,
        flight_eligible||false, train_class||'Sleeper',
        Number(local_conveyance_limit)||0, Number(miscellaneous_limit)||0,
        Number(max_advance_amount)||0,
        effective_from||null, effective_to||null,
        is_active !== undefined ? is_active : true,
        req.params.id]);

    if (!updated) return res.status(404).json({ error: 'Policy rule not found' });
    logAudit({ userId: actorId, module: 'travel_policy', recordId: updated.id,
      recordType: 'travel_policy_rule', action: 'update', newData: updated });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /travel-policy/:id ─────────────────────────────────────────────────
router.delete('/:id', allowRoles('admin', 'super_admin'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM travel_policy_rules WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Policy rule deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /travel-policy/check ─────────────────────────────────────────────────
// Check if a specific expense is within policy for the given employee
router.post('/check', async (req, res) => {
  try {
    const { employee_id, expense_type, amount } = req.body;
    const companyId = cid(req);
    if (!employee_id) return res.json({ within_policy: true, policy_limit: null });

    const { rows: [emp] } = await pool.query(
      `SELECT grade, designation, department FROM employees WHERE id=$1`, [employee_id]);
    if (!emp) return res.json({ within_policy: true, policy_limit: null });

    const { rows: [rule] } = await pool.query(`
      SELECT * FROM travel_policy_rules
      WHERE is_active=TRUE AND company_id=$1
        AND (grade=$2 OR role=$3 OR department=$4)
      ORDER BY
        CASE rule_type WHEN 'grade' THEN 1 WHEN 'role' THEN 2 ELSE 3 END
      LIMIT 1
    `, [companyId, emp.grade||'', emp.designation||'', emp.department||'']);

    if (!rule) return res.json({ within_policy: true, policy_limit: null, rule: null });

    let limit = null;
    if (expense_type === 'Accommodation') limit = parseFloat(rule.hotel_limit_per_day);
    else if (expense_type === 'Food') limit = parseFloat(rule.meal_limit_per_day);
    else if (expense_type === 'Travel') limit = parseFloat(rule.local_conveyance_limit);
    else limit = parseFloat(rule.miscellaneous_limit);

    const withinPolicy = !limit || limit === 0 || Number(amount) <= limit;
    res.json({
      within_policy: withinPolicy,
      policy_limit: limit,
      flight_eligible: rule.flight_eligible,
      train_class: rule.train_class,
      daily_allowance: parseFloat(rule.travel_daily_allowance),
      rule,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /travel-policy/summary/grades ─────────────────────────────────────────
router.get('/summary/grades', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(`
      SELECT rule_type, grade, role, department,
             hotel_limit_per_day, meal_limit_per_day, travel_daily_allowance,
             flight_eligible, train_class
      FROM travel_policy_rules
      WHERE is_active=TRUE AND company_id=$1
      ORDER BY rule_type, grade, role, department
    `, [companyId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
