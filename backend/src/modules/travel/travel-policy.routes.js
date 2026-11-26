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
import { captureBefore } from '../../middlewares/captureBefore.js';
import { policyRuleFor, policyLimitFor, ownEmployeeId, seesAllTravel } from './travelAccess.js';

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

// ── GET /travel-policy/coverage ───────────────────────────────────────────────
// How many active employees a rule actually reaches. Rules are keyed on grade /
// designation / department; on 26 Nov 26 every employee's grade was empty, so
// the six grade rules matched nobody and no claim was ever checked — this lets
// the screen say so instead of looking configured.
router.get('/coverage', async (req, res) => {
  try {
    const { rows: [r] } = await pool.query(`
      SELECT COUNT(*)::int AS employees,
             COUNT(*) FILTER (WHERE NULLIF(TRIM(e.grade), '') IS NOT NULL)::int AS with_grade,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM travel_policy_rules p
                WHERE p.is_active AND p.company_id = e.company_id
                  AND ((p.rule_type = 'grade' AND p.grade = e.grade) OR (p.rule_type = 'role' AND p.role = e.designation)
                    OR (p.rule_type = 'department' AND p.department = e.department))
                  AND (p.effective_from IS NULL OR p.effective_from <= CURRENT_DATE)
                  AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)))::int AS covered
        FROM employees e
       WHERE e.deleted_at IS NULL AND LOWER(e.status) IN ('active','probation','notice')
         AND ($1::int IS NULL OR e.company_id = $1)`, [cid(req)]);
    res.json(r);
  } catch { res.status(500).json({ error: 'Could not work out policy coverage' }); }
});

// ── GET /travel-policy/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows: [rule] } = await pool.query(
      `SELECT * FROM travel_policy_rules WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`, [Number(req.params.id) || 0, cid(req)]);
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
    if (!['grade', 'role', 'department'].includes(rule_type)) return res.status(400).json({ error: 'rule_type must be grade, role or department' });
    if (!req.body[rule_type]) return res.status(400).json({ error: `Choose the ${rule_type} this rule applies to` });

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
// Partial edit inside the caller's company: a field left out keeps its value
// (it used to be blanked to 0 / NULL / 'Sleeper'), and another company's rule
// reads as missing.
const POLICY_COLS = ['rule_name', 'rule_type', 'grade', 'role', 'department',
  'hotel_limit_per_day', 'meal_limit_per_day', 'travel_daily_allowance', 'flight_eligible', 'train_class',
  'local_conveyance_limit', 'miscellaneous_limit', 'max_advance_amount', 'effective_from', 'effective_to', 'is_active'];
const MONEY = new Set(['hotel_limit_per_day', 'meal_limit_per_day', 'travel_daily_allowance',
  'local_conveyance_limit', 'miscellaneous_limit', 'max_advance_amount']);

router.put('/:id', allowRoles('admin', 'super_admin', 'hr'), captureBefore('travel_policy_rules'), async (req, res) => {
  try {
    const { rows: [old] } = await pool.query(
      `SELECT * FROM travel_policy_rules WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [Number(req.params.id) || 0, cid(req)]);
    if (!old) return res.status(404).json({ error: 'Policy rule not found' });
    const b = req.body || {};
    const next = { ...old };
    for (const c of POLICY_COLS) {
      if (b[c] === undefined) continue;
      if (MONEY.has(c)) {
        const n = b[c] === '' || b[c] == null ? 0 : Number(b[c]);
        if (!(n >= 0)) return res.status(400).json({ error: `${c.replace(/_/g, ' ')} cannot be negative` });
        next[c] = n;
      } else if (c === 'flight_eligible' || c === 'is_active') next[c] = !!b[c];
      else next[c] = b[c] === '' ? null : b[c];
    }
    if (!String(next.rule_name || '').trim()) return res.status(400).json({ error: 'rule_name is required' });
    if (!['grade', 'role', 'department'].includes(next.rule_type)) return res.status(400).json({ error: 'rule_type must be grade, role or department' });
    if (!next[next.rule_type]) return res.status(400).json({ error: `Choose the ${next.rule_type} this rule applies to` });
    if (next.effective_from && next.effective_to && String(next.effective_to) < String(next.effective_from)) {
      return res.status(400).json({ error: 'Effective-to cannot be before effective-from' });
    }
    const { rows: [updated] } = await pool.query(`
      UPDATE travel_policy_rules SET
        rule_name=$1, rule_type=$2, grade=$3, role=$4, department=$5,
        hotel_limit_per_day=$6, meal_limit_per_day=$7, travel_daily_allowance=$8,
        flight_eligible=$9, train_class=$10, local_conveyance_limit=$11,
        miscellaneous_limit=$12, max_advance_amount=$13,
        effective_from=$14, effective_to=$15, is_active=$16, updated_at=NOW()
      WHERE id=$17 RETURNING *
    `, [...POLICY_COLS.map(c => next[c]), old.id]);
    logAudit({ userId: uid(req), module: 'travel_policy', recordId: updated.id,
      recordType: 'travel_policy_rule', action: 'update', oldData: old, newData: updated, req });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: 'Could not save the rule' }); }
});

// ── DELETE /travel-policy/:id ─────────────────────────────────────────────────
// HR may delete too — the screen offered HR the button while the route refused.
router.delete('/:id', allowRoles('admin', 'super_admin', 'hr'), captureBefore('travel_policy_rules'), async (req, res) => {
  try {
    const { rows: [gone] } = await pool.query(
      `DELETE FROM travel_policy_rules WHERE id=$1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`,
      [Number(req.params.id) || 0, cid(req)]);
    if (!gone) return res.status(404).json({ error: 'Policy rule not found' });
    logAudit({ userId: uid(req), module: 'travel_policy', recordId: gone.id,
      recordType: 'travel_policy_rule', action: 'delete', oldData: gone, req });
    res.json({ message: 'Policy rule deleted' });
  } catch (err) { res.status(500).json({ error: 'Could not delete the rule' }); }
});

// ── POST /travel-policy/check ─────────────────────────────────────────────────
// The limit an expense is held to. Uses the SAME rule choice as the claim save
// (travelAccess.policyRuleFor) — they used to pick rules in different orders.
// Anyone may check their own; the HR / Finance desks may check anyone's.
router.post('/check', async (req, res) => {
  try {
    const { expense_type, amount, expense_date } = req.body || {};
    const own = await ownEmployeeId(req);
    const empId = seesAllTravel(req) && req.body?.employee_id ? Number(req.body.employee_id) : own;
    if (!empId) return res.json({ within_policy: true, policy_limit: null, rule: null });
    const { rows: [emp] } = await pool.query(
      `SELECT grade, designation, department FROM employees WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`, [empId, cid(req)]);
    const rule = await policyRuleFor(pool, cid(req), emp, /^\d{4}-\d{2}-\d{2}$/.test(String(expense_date || '')) ? expense_date : null);
    if (!rule) {
      return res.json({ within_policy: true, policy_limit: null, rule: null,
        no_rule_reason: emp?.grade ? 'No active travel policy matches your grade, designation or department' : 'Your grade is not set on your employee record, so no travel policy applies' });
    }
    const limit = policyLimitFor(rule, expense_type);
    res.json({
      within_policy: !limit || Number(amount) <= limit,
      policy_limit: limit,
      flight_eligible: rule.flight_eligible,
      train_class: rule.train_class,
      daily_allowance: Number(rule.travel_daily_allowance || 0),
      max_advance_amount: Number(rule.max_advance_amount || 0),
      rule: { id: rule.id, rule_name: rule.rule_name, rule_type: rule.rule_type },
    });
  } catch (err) { res.status(500).json({ error: 'Could not check the policy' }); }
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
