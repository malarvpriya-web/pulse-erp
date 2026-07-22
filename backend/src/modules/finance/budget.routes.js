import express from 'express';
import pool from '../../config/db.js';
import { allowRoles, requirePermission } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();
router.use(requirePermission('finance', 'view'));

// 'cfo' was never a row in `roles` (see procurement.authz.js's ROLE_LEVEL,
// which removed it for the same reason) — 'finance_manager' is the real
// seeded senior-finance role that fills the same slot.
const BUDGET_APPROVE_ROLES = ['admin', 'super_admin', 'finance', 'finance_manager', 'manager'];


// ── GET /budgets ──────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { financial_year, department, status } = req.query;
  const companyId = companyOf(req);
  try {

    let query = `
      SELECT b.*,
        COALESCE(SUM(ba.actual_amount), 0) as total_actual,
        b.total_amount - COALESCE(SUM(ba.actual_amount), 0) as variance,
        CASE WHEN b.total_amount > 0
          THEN ROUND((COALESCE(SUM(ba.actual_amount), 0) / b.total_amount * 100)::NUMERIC, 1)
          ELSE 0 END as utilization_pct
      FROM budgets b
      LEFT JOIN budget_actuals ba ON ba.budget_id = b.id AND ba.company_id = b.company_id
      WHERE b.company_id = $1
    `;
    const params = [companyId];
    if (financial_year) { params.push(financial_year); query += ` AND b.financial_year = $${params.length}`; }
    if (department)     { params.push(department);     query += ` AND b.department = $${params.length}`; }
    if (status)         { params.push(status);         query += ` AND b.status = $${params.length}`; }
    query += ' GROUP BY b.id ORDER BY b.created_at DESC';

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /budgets ─────────────────────────────────────────────────────────────
router.post('/', requirePermission('finance', 'add'), async (req, res) => {
  const { name, financial_year, department, budget_type, total_amount, notes, line_items = [] } = req.body;
  const companyId = companyOf(req);
  const client = await pool.connect();
  try {

    const amount = parseFloat(total_amount);
    if (!Number.isFinite(amount)) {
      return res.status(400).json({ error: 'total_amount must be a finite numeric value' });
    }
    if (amount < 0) {
      return res.status(400).json({ error: 'total_amount cannot be negative' });
    }
    await client.query('BEGIN');

    const { rows: [budget] } = await client.query(`
      INSERT INTO budgets (name, financial_year, department, budget_type, total_amount, notes, created_by, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [name, financial_year, department, budget_type || 'annual',
        amount, notes, req.user?.userId ?? req.user?.id, companyId]);

    for (const item of line_items) {
      await client.query(`
        INSERT INTO budget_line_items
          (budget_id, category, sub_category, account_code, description, q1_amount, q2_amount, q3_amount, q4_amount, company_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [budget.id, item.category, item.sub_category, item.account_code,
          item.description, item.q1 || 0, item.q2 || 0, item.q3 || 0, item.q4 || 0, companyId]);
    }

    await client.query('COMMIT');
    return res.status(201).json(budget);
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET /budgets/consolidated — company-wide department view ─────────────────
router.get('/consolidated', async (req, res) => {
  const { financial_year } = req.query;
  const companyId = companyOf(req);
  const fy = financial_year || null;
  try {

    const { rows } = await pool.query(`
      WITH dept_totals AS (
        SELECT
          COALESCE(NULLIF(TRIM(b.department), ''), 'Unassigned') AS department,
          COALESCE(SUM(b.total_amount), 0) AS budgeted,
          COALESCE(SUM(ba.actual_amount), 0) AS actual
        FROM budgets b
        LEFT JOIN budget_actuals ba ON ba.budget_id = b.id AND ba.company_id = b.company_id
        WHERE b.company_id = $1
          AND ($2::varchar IS NULL OR b.financial_year = $2)
        GROUP BY COALESCE(NULLIF(TRIM(b.department), ''), 'Unassigned')
      )
      SELECT
        department,
        budgeted,
        actual,
        budgeted - actual AS variance,
        CASE WHEN budgeted > 0
          THEN ROUND((actual / budgeted * 100)::NUMERIC, 1)
          ELSE 0 END AS utilization_pct,
        CASE
          WHEN budgeted > 0 AND actual > budgeted THEN 'overspent'
          WHEN budgeted > 0 AND (actual / budgeted) >= 0.9 THEN 'high'
          WHEN budgeted > 0 AND (actual / budgeted) >= 0.75 THEN 'medium'
          ELSE 'low'
        END AS overspend_risk
      FROM dept_totals
      ORDER BY
        CASE
          WHEN budgeted > 0 AND actual > budgeted THEN 3
          WHEN budgeted > 0 AND (actual / budgeted) >= 0.9 THEN 2
          WHEN budgeted > 0 AND (actual / budgeted) >= 0.75 THEN 1
          ELSE 0
        END DESC,
        utilization_pct DESC,
        department ASC
    `, [companyId, fy]);

    const totals = rows.reduce((acc, r) => {
      acc.total_budgeted += parseFloat(r.budgeted) || 0;
      acc.total_actual += parseFloat(r.actual) || 0;
      return acc;
    }, { total_budgeted: 0, total_actual: 0 });

    return res.json({
      financial_year: fy,
      by_department: rows,
      total_budgeted: totals.total_budgeted,
      total_actual: totals.total_actual,
      total_variance: totals.total_budgeted - totals.total_actual,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /budgets/variance-analysis — line/category variance view ───────────────
router.get('/variance-analysis', async (req, res) => {
  const { financial_year, department } = req.query;
  const companyId = companyOf(req);
  const fy = financial_year || null;
  const dept = department || null;
  try {

    const { rows } = await pool.query(`
      SELECT
        b.id AS budget_id,
        b.name AS budget_name,
        b.financial_year,
        b.department,
        li.id AS line_item_id,
        li.category,
        li.sub_category,
        li.account_code,
        li.description,
        li.annual_amount AS budget_amount,
        COALESCE(SUM(ba.actual_amount), 0) AS actual_amount
      FROM budget_line_items li
      JOIN budgets b ON b.id = li.budget_id
      LEFT JOIN budget_actuals ba ON ba.line_item_id = li.id AND ba.company_id = b.company_id
      WHERE b.company_id = $1
        AND ($2::varchar IS NULL OR b.financial_year = $2)
        AND ($3::varchar IS NULL OR b.department = $3)
      GROUP BY b.id, b.name, b.financial_year, b.department, li.id
      ORDER BY b.department NULLS LAST, li.category, li.sub_category, li.id
    `, [companyId, fy, dept]);

    const analysis = rows.map((r) => {
      const budgetAmount = parseFloat(r.budget_amount) || 0;
      const actualAmount = parseFloat(r.actual_amount) || 0;
      const varianceAmount = budgetAmount - actualAmount;
      const variancePct = budgetAmount > 0
        ? Math.round(((varianceAmount / budgetAmount) * 100) * 100) / 100
        : 0;

      let rootCauseCategory = 'timing variance';
      if (variancePct < -10) {
        rootCauseCategory = 'volume variance';
      } else if (variancePct < 0) {
        rootCauseCategory = 'price variance';
      } else if (variancePct > 10) {
        rootCauseCategory = 'timing variance';
      }

      return {
        budget_id: r.budget_id,
        budget_name: r.budget_name,
        financial_year: r.financial_year,
        department: r.department,
        line_item_id: r.line_item_id,
        category: r.category,
        sub_category: r.sub_category,
        account_code: r.account_code,
        description: r.description,
        budget_amount: budgetAmount,
        actual_amount: actualAmount,
        variance_amount: varianceAmount,
        variance_pct: variancePct,
        root_cause_category: rootCauseCategory,
        overspend_flag: variancePct < -10,
      };
    });

    return res.json({
      financial_year: fy,
      department: dept,
      rows: analysis,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /budgets/forecast — forecast from recent spend trend ──────────────────
router.get('/forecast', async (req, res) => {
  const { financial_year, department } = req.query;
  const companyId = companyOf(req);
  const now = new Date();
  const defaultFyStartYear = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  const fy = financial_year || `${defaultFyStartYear}-${defaultFyStartYear + 1}`;
  const dept = department || null;

  try {

    const fyMatch = /^(\d{4})-(\d{4})$/.exec(String(fy));
    if (!fyMatch) {
      return res.status(400).json({ error: 'Invalid financial_year format. Expected YYYY-YYYY.' });
    }
    const fyStartYear = parseInt(fyMatch[1], 10);
    const fyEndYear = parseInt(fyMatch[2], 10);
    if (fyEndYear !== fyStartYear + 1) {
      return res.status(400).json({ error: 'Invalid financial_year range. End year must be start year + 1.' });
    }

    const fyStart = new Date(fyStartYear, 3, 1);
    const fyEnd = new Date(fyEndYear, 2, 31);
    const asOfDate = now < fyStart ? fyStart : (now > fyEnd ? fyEnd : now);

    const toSqlDate = (d) => d.toISOString().split('T')[0];
    const fyStartStr = toSqlDate(fyStart);
    const asOfDateStr = toSqlDate(asOfDate);

    const { rows: [budgetRow] } = await pool.query(`
      SELECT COALESCE(SUM(b.total_amount), 0) AS total_budgeted
      FROM budgets b
      WHERE b.company_id = $1
        AND b.financial_year = $2
        AND ($3::varchar IS NULL OR b.department = $3)
    `, [companyId, fy, dept]);
    const totalBudgeted = parseFloat(budgetRow?.total_budgeted) || 0;

    const { rows: [actualRow] } = await pool.query(`
      SELECT COALESCE(SUM(ba.actual_amount), 0) AS actual_to_date
      FROM budget_actuals ba
      JOIN budgets b ON b.id = ba.budget_id
      WHERE b.company_id = $1
        AND b.financial_year = $2
        AND ($3::varchar IS NULL OR b.department = $3)
        AND ba.transaction_date BETWEEN $4::date AND $5::date
    `, [companyId, fy, dept, fyStartStr, asOfDateStr]);
    const actualToDate = parseFloat(actualRow?.actual_to_date) || 0;

    const trendStart = new Date(asOfDate.getFullYear(), asOfDate.getMonth() - 2, 1);
    const trendStartClamped = trendStart < fyStart ? fyStart : trendStart;
    const trendStartStr = toSqlDate(trendStartClamped);

    const { rows: [trendRow] } = await pool.query(`
      SELECT COALESCE(SUM(ba.actual_amount), 0) AS last_3_months_total
      FROM budget_actuals ba
      JOIN budgets b ON b.id = ba.budget_id
      WHERE b.company_id = $1
        AND b.financial_year = $2
        AND ($3::varchar IS NULL OR b.department = $3)
        AND ba.transaction_date BETWEEN $4::date AND $5::date
    `, [companyId, fy, dept, trendStartStr, asOfDateStr]);
    const lastThreeMonthsTotal = parseFloat(trendRow?.last_3_months_total) || 0;
    const last3MonthTrendAverage = Math.round(((lastThreeMonthsTotal / 3) || 0) * 100) / 100;

    const currentMonthStart = new Date(asOfDate.getFullYear(), asOfDate.getMonth(), 1);
    let remainingMonths = 0;
    if (currentMonthStart < fyStart) {
      remainingMonths = 12;
    } else if (currentMonthStart > fyEnd) {
      remainingMonths = 0;
    } else {
      remainingMonths = (fyEnd.getFullYear() - currentMonthStart.getFullYear()) * 12
        + (fyEnd.getMonth() - currentMonthStart.getMonth());
    }

    const projectedRemaining = Math.round((last3MonthTrendAverage * remainingMonths) * 100) / 100;
    const annualForecast = Math.round((actualToDate + projectedRemaining) * 100) / 100;
    const forecastVarianceVsBudget = Math.round((totalBudgeted - annualForecast) * 100) / 100;

    const projected_remaining_months = [];
    for (let i = 1; i <= remainingMonths; i++) {
      const monthDate = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() + i, 1);
      projected_remaining_months.push({
        month: monthDate.toLocaleString('en-IN', { month: 'short', year: 'numeric' }),
        projected_amount: last3MonthTrendAverage,
      });
    }

    return res.json({
      financial_year: fy,
      department: dept,
      as_of_date: asOfDateStr,
      total_budgeted: totalBudgeted,
      actual_to_date: Math.round(actualToDate * 100) / 100,
      last_3_month_trend_average: last3MonthTrendAverage,
      projected_remaining_months,
      projected_remaining_total: projectedRemaining,
      annual_forecast: annualForecast,
      forecast_variance_vs_budget: forecastVarianceVsBudget,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /budgets/approval-workflow — status transitions ──────────────────────
router.post('/approval-workflow', requirePermission('finance', 'edit'), async (req, res) => {
  const { budget_id, status, target_status, action } = req.body;
  const companyId = companyOf(req);
  try {

    if (!budget_id) {
      return res.status(400).json({ error: 'budget_id is required' });
    }

    const actionMap = {
      submit: 'submitted',
      approve: 'approved',
      reject: 'rejected',
      activate: 'active',
      close: 'closed',
    };
    const nextStatus = target_status || status || (action ? actionMap[String(action).toLowerCase()] : null);
    const validStatuses = ['submitted', 'approved', 'rejected', 'active', 'closed'];
    if (!validStatuses.includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid target status. Allowed: submitted, approved, rejected, active, closed.' });
    }

    const { rows: [budget] } = await pool.query(
      'SELECT id, status FROM budgets WHERE id = $1 AND company_id = $2',
      [budget_id, companyId]
    );
    if (!budget) {
      return res.status(404).json({ error: 'Budget not found' });
    }

    const allowedTransitions = {
      draft:     ['submitted'],
      submitted: ['approved', 'rejected'],
      approved:  ['active'],
      active:    ['closed'],
      rejected:  [],
      closed:    [],
    };
    const currentStatus = budget.status;
    if (!allowedTransitions[currentStatus] || !allowedTransitions[currentStatus].includes(nextStatus)) {
      return res.status(400).json({ error: `Invalid transition from '${currentStatus}' to '${nextStatus}'.` });
    }

    const approverId = req.user?.userId ?? req.user?.id ?? null;
    const shouldStampApproval = nextStatus === 'approved' || nextStatus === 'rejected';
    const { rows: [updated] } = await pool.query(`
      UPDATE budgets
      SET
        status = $1,
        approved_by = CASE WHEN $2 THEN $3 ELSE approved_by END,
        approved_at = CASE WHEN $2 THEN NOW() ELSE approved_at END,
        updated_at = NOW()
      WHERE id = $4 AND company_id = $5
      RETURNING *
    `, [nextStatus, shouldStampApproval, approverId, budget_id, companyId]);

    return res.json({
      success: true,
      message: `Budget status updated from '${currentStatus}' to '${nextStatus}'`,
      budget: updated,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /budgets/cashflow-projection — monthly inflow/outflow projection ─────
router.get('/cashflow-projection', async (req, res) => {
  const { financial_year, department, opening_cash_balance, minimum_cash_balance } = req.query;
  const companyId = companyOf(req);
  const now = new Date();
  const defaultFyStartYear = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  const fy = financial_year || `${defaultFyStartYear}-${defaultFyStartYear + 1}`;
  const dept = department || null;
  const openingCash = parseFloat(opening_cash_balance);
  const minimumCash = parseFloat(minimum_cash_balance);

  try {

    if (opening_cash_balance !== undefined && !Number.isFinite(openingCash)) {
      return res.status(400).json({ error: 'opening_cash_balance must be a numeric value when provided' });
    }
    if (minimum_cash_balance !== undefined && !Number.isFinite(minimumCash)) {
      return res.status(400).json({ error: 'minimum_cash_balance must be a numeric value when provided' });
    }

    const fyMatch = /^(\d{4})-(\d{4})$/.exec(String(fy));
    if (!fyMatch) {
      return res.status(400).json({ error: 'Invalid financial_year format. Expected YYYY-YYYY.' });
    }
    const fyStartYear = parseInt(fyMatch[1], 10);
    const fyEndYear = parseInt(fyMatch[2], 10);
    if (fyEndYear !== fyStartYear + 1) {
      return res.status(400).json({ error: 'Invalid financial_year range. End year must be start year + 1.' });
    }

    const fyStart = new Date(fyStartYear, 3, 1);
    const fyEnd = new Date(fyEndYear, 2, 31);
    const asOfDate = now < fyStart ? fyStart : (now > fyEnd ? fyEnd : now);
    const currentMonthIndex = (asOfDate.getFullYear() - fyStartYear) * 12 + asOfDate.getMonth() - 3;

    const { rows: [budgetRow] } = await pool.query(`
      SELECT COALESCE(SUM(total_amount), 0) AS total_budgeted
      FROM budgets
      WHERE company_id = $1
        AND financial_year = $2
        AND ($3::varchar IS NULL OR department = $3)
    `, [companyId, fy, dept]);
    const totalBudgeted = parseFloat(budgetRow?.total_budgeted) || 0;
    const assumedMonthlyInflow = Math.round(((totalBudgeted / 12) || 0) * 100) / 100;

    const { rows: monthlyOutflowRows } = await pool.query(`
      SELECT
        ba.year,
        ba.month,
        COALESCE(SUM(ba.actual_amount), 0) AS outflow
      FROM budget_actuals ba
      JOIN budgets b ON b.id = ba.budget_id
      WHERE b.company_id = $1
        AND b.financial_year = $2
        AND ($3::varchar IS NULL OR b.department = $3)
      GROUP BY ba.year, ba.month
      ORDER BY ba.year, ba.month
    `, [companyId, fy, dept]);

    const outflowByKey = monthlyOutflowRows.reduce((acc, r) => {
      const key = `${parseInt(r.year, 10)}-${parseInt(r.month, 10)}`;
      acc[key] = parseFloat(r.outflow) || 0;
      return acc;
    }, {});

    const last3Outflows = [];
    for (let i = 0; i < 12; i++) {
      const monthDate = new Date(fyStartYear, 3 + i, 1);
      const monthNo = monthDate.getMonth() + 1;
      const yearNo = monthDate.getFullYear();
      const key = `${yearNo}-${monthNo}`;
      const value = outflowByKey[key] || 0;
      if (i <= currentMonthIndex) {
        last3Outflows.push(value);
      }
    }
    const recent3 = last3Outflows.slice(-3);
    const last3MonthAverageOutflow = recent3.length > 0
      ? Math.round((recent3.reduce((s, v) => s + v, 0) / recent3.length) * 100) / 100
      : 0;

    const minCash = Number.isFinite(minimumCash) ? minimumCash : 0;
    let runningCash = Number.isFinite(openingCash) ? openingCash : 0;
    const monthly_projection = [];
    const alerts = [];

    for (let i = 0; i < 12; i++) {
      const monthDate = new Date(fyStartYear, 3 + i, 1);
      const monthNo = monthDate.getMonth() + 1;
      const yearNo = monthDate.getFullYear();
      const key = `${yearNo}-${monthNo}`;
      const monthLabel = monthDate.toLocaleString('en-IN', { month: 'short', year: 'numeric' });

      const isActualMonth = i <= currentMonthIndex;
      const outflow = isActualMonth
        ? (outflowByKey[key] || 0)
        : last3MonthAverageOutflow;
      const outflowSource = isActualMonth ? 'actual' : 'projected_last_3_month_avg';

      const inflow = assumedMonthlyInflow;
      const netMovement = inflow - outflow;
      runningCash = Math.round((runningCash + netMovement) * 100) / 100;

      monthly_projection.push({
        month_index: i + 1,
        month: monthNo,
        year: yearNo,
        month_label: monthLabel,
        inflow: Math.round(inflow * 100) / 100,
        outflow: Math.round(outflow * 100) / 100,
        outflow_source: outflowSource,
        net_movement: Math.round(netMovement * 100) / 100,
        net_cash_position: runningCash,
      });

      if (runningCash < minCash) {
        alerts.push({
          month_label: monthLabel,
          net_cash_position: runningCash,
          minimum_cash_balance: minCash,
          shortfall: Math.round((minCash - runningCash) * 100) / 100,
          severity: runningCash < 0 ? 'critical' : 'warning',
        });
      }
    }

    return res.json({
      financial_year: fy,
      department: dept,
      metadata: {
        as_of_date: asOfDate.toISOString().split('T')[0],
        opening_cash_balance: Number.isFinite(openingCash) ? openingCash : 0,
        minimum_cash_balance: minCash,
        assumptions: [
          'Monthly inflow is assumed as total annual budget divided equally across 12 months due to absence of dedicated sales-forecast table in this module.',
          'Future month outflows are projected using the average of the most recent up-to-3 in-year actual outflow months.',
        ],
        total_budgeted: totalBudgeted,
        last_3_month_average_outflow: last3MonthAverageOutflow,
      },
      monthly_projection,
      alerts,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /budgets/:id/revise — create draft revision from source budget ───────
router.post('/:id/revise', requirePermission('finance', 'edit'), async (req, res) => {
  const { revision_reason } = req.body;
  const sourceBudgetId = req.params.id;
  const companyId = companyOf(req);
  const client = await pool.connect();
  try {

    await client.query('BEGIN');

    const { rows: [sourceBudget] } = await client.query(
      'SELECT * FROM budgets WHERE id = $1 AND company_id = $2',
      [sourceBudgetId, companyId]
    );
    if (!sourceBudget) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Budget not found' });
    }

    const { rows: [revCountRow] } = await client.query(
      `SELECT COUNT(*)::INT AS cnt
       FROM budgets
       WHERE company_id = $1 AND notes ILIKE $2`,
      [companyId, `%Source Budget ID: ${sourceBudgetId}%`]
    );
    const nextRevisionNumber = (parseInt(revCountRow?.cnt, 10) || 0) + 1;
    const revisedName = `${sourceBudget.name} [Rev ${nextRevisionNumber}]`;
    const reasonText = (revision_reason && String(revision_reason).trim()) || 'No reason provided';
    const lineageNote = `Source Budget ID: ${sourceBudgetId} | Revision Reason: ${reasonText}`;
    const revisedNotes = sourceBudget.notes
      ? `${sourceBudget.notes}\n${lineageNote}`
      : lineageNote;

    const { rows: [revisedBudget] } = await client.query(`
      INSERT INTO budgets
        (name, financial_year, department, budget_type, total_amount, status, notes, created_by, company_id)
      VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8)
      RETURNING *
    `, [
      revisedName,
      sourceBudget.financial_year,
      sourceBudget.department,
      sourceBudget.budget_type,
      sourceBudget.total_amount,
      revisedNotes,
      req.user?.userId ?? req.user?.id ?? sourceBudget.created_by ?? null,
      companyId,
    ]);

    const { rows: copiedRows } = await client.query(`
      INSERT INTO budget_line_items
        (budget_id, category, sub_category, account_code, description, q1_amount, q2_amount, q3_amount, q4_amount, company_id)
      SELECT
        $1, category, sub_category, account_code, description, q1_amount, q2_amount, q3_amount, q4_amount, $2
      FROM budget_line_items
      WHERE budget_id = $3
      RETURNING id
    `, [revisedBudget.id, companyId, sourceBudgetId]);

    await client.query('COMMIT');
    return res.status(201).json({
      original_budget_id: parseInt(sourceBudgetId, 10),
      revised_budget_id: revisedBudget.id,
      copied_line_items_count: copiedRows.length,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/:id', async (req, res) => {
  const companyId = companyOf(req);
  try {

    const { rows: [budget] } = await pool.query(
      'SELECT * FROM budgets WHERE id = $1 AND company_id = $2', [req.params.id, companyId]
    );
    if (!budget) return res.status(404).json({ error: 'Budget not found' });

    const { rows: lineItems } = await pool.query(`
      SELECT
        li.*,
        COALESCE(SUM(ba.actual_amount), 0) as actual_total,
        li.annual_amount - COALESCE(SUM(ba.actual_amount), 0) as variance,
        CASE WHEN li.annual_amount > 0
          THEN ROUND((COALESCE(SUM(ba.actual_amount), 0) / li.annual_amount * 100)::NUMERIC, 1)
          ELSE 0 END as utilization_pct
      FROM budget_line_items li
      LEFT JOIN budget_actuals ba ON ba.line_item_id = li.id AND ba.company_id = $2
      WHERE li.budget_id = $1
      GROUP BY li.id
      ORDER BY li.category, li.sub_category
    `, [req.params.id, companyId]);

    return res.json({ ...budget, line_items: lineItems });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /budgets/report/vs-actuals — dashboard summary ────────────────────────────────
router.get('/report/vs-actuals', async (req, res) => {
  const { financial_year, department } = req.query;
  const companyId = companyOf(req);
  const now = new Date();
  const defaultFyStartYear = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  const fy = financial_year || `${defaultFyStartYear}-${defaultFyStartYear + 1}`;

  try {

    const { rows: budgetRows } = await pool.query(`
      SELECT
        b.department,
        b.total_amount as budgeted,
        COALESCE(SUM(ba.actual_amount), 0) as actual,
        b.total_amount - COALESCE(SUM(ba.actual_amount), 0) as variance,
        CASE WHEN b.total_amount > 0
          THEN ROUND((COALESCE(SUM(ba.actual_amount), 0) / b.total_amount * 100)::NUMERIC, 1)
          ELSE 0 END as utilization_pct
      FROM budgets b
      LEFT JOIN budget_actuals ba ON ba.budget_id = b.id AND ba.company_id = b.company_id
      WHERE b.company_id = $1
        AND b.financial_year = $2
        AND b.status != 'draft'
        AND ($3::varchar IS NULL OR b.department = $3)
      GROUP BY b.id, b.department, b.total_amount
      ORDER BY b.department
    `, [companyId, fy, department || null]);

    const { rows: monthlyRows } = await pool.query(`
      SELECT
        month, year,
        SUM(actual_amount) as actual_spent,
        TO_CHAR(TO_DATE(month::text, 'MM'), 'Mon') as month_name
      FROM budget_actuals ba
      JOIN budgets b ON b.id = ba.budget_id
      WHERE b.company_id = $1
        AND b.financial_year = $2
        AND ($3::varchar IS NULL OR ba.department = $3)
      GROUP BY month, year
      ORDER BY year, month
    `, [companyId, fy, department || null]).catch(() => ({ rows: [] }));

    const { rows: categoryRows } = await pool.query(`
      SELECT
        li.category,
        SUM(li.annual_amount) as budgeted,
        COALESCE(SUM(ba.actual_amount), 0) as actual,
        SUM(li.annual_amount) - COALESCE(SUM(ba.actual_amount), 0) as variance
      FROM budget_line_items li
      JOIN budgets b ON b.id = li.budget_id
      LEFT JOIN budget_actuals ba ON ba.line_item_id = li.id AND ba.company_id = b.company_id
      WHERE b.company_id = $1
        AND b.financial_year = $2
        AND b.status != 'draft'
      GROUP BY li.category
      ORDER BY budgeted DESC
    `, [companyId, fy]).catch(() => ({ rows: [] }));

    const alerts = budgetRows.filter(r => parseFloat(r.utilization_pct) > 90).map(r => ({
      department: r.department,
      utilization_pct: r.utilization_pct,
      overspent: parseFloat(r.actual) > parseFloat(r.budgeted),
      variance: r.variance,
      severity: parseFloat(r.utilization_pct) >= 100 ? 'critical' : 'warning',
    }));

    const totalBudgeted = budgetRows.reduce((s, r) => s + parseFloat(r.budgeted), 0);
    const totalActual   = budgetRows.reduce((s, r) => s + parseFloat(r.actual), 0);

    return res.json({
      financial_year: fy,
      summary: {
        total_budgeted: totalBudgeted,
        total_actual:   totalActual,
        total_variance: totalBudgeted - totalActual,
        overall_utilization: totalBudgeted > 0
          ? Math.round(totalActual / totalBudgeted * 100)
          : 0,
      },
      by_department:  budgetRows,
      monthly_trend:  monthlyRows,
      by_category:    categoryRows,
      alerts,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /budgets/actuals — record an actual spend ─────────────────────────────
router.post('/actuals', requirePermission('finance', 'add'), async (req, res) => {
  const {
    budget_id, line_item_id, department, category,
    actual_amount, transaction_date, reference_type,
    reference_id, description,
  } = req.body;
  const companyId = companyOf(req);

  try {

    const amount = parseFloat(actual_amount);
    if (!Number.isFinite(amount)) {
      return res.status(400).json({ error: 'actual_amount must be a finite numeric value' });
    }
    if (amount < 0) {
      return res.status(400).json({ error: 'actual_amount cannot be negative' });
    }
    const txDate = new Date(transaction_date || new Date());

    const { rows: [actual] } = await pool.query(`
      INSERT INTO budget_actuals
        (budget_id, line_item_id, department, category, actual_amount,
         transaction_date, reference_type, reference_id, description, month, year, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      budget_id, line_item_id, department, category,
      amount, txDate,
      reference_type, reference_id, description,
      txDate.getMonth() + 1, txDate.getFullYear(),
      companyId,
    ]);

    if (budget_id && line_item_id) {
      const { rows: [li] } = await pool.query(`
        SELECT li.annual_amount, COALESCE(SUM(ba.actual_amount), 0) as total_actual
        FROM budget_line_items li
        LEFT JOIN budget_actuals ba ON ba.line_item_id = li.id AND ba.company_id = $2
        WHERE li.id = $1 GROUP BY li.id, li.annual_amount
      `, [line_item_id, companyId]);

      if (li && parseFloat(li.annual_amount) > 0) {
        const pct = (parseFloat(li.total_actual) / parseFloat(li.annual_amount)) * 100;
        if (pct >= 80) {
          await pool.query(`
            INSERT INTO budget_alerts
              (budget_id, line_item_id, department, category, alert_type, threshold_pct, current_pct, budgeted, actual, company_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT DO NOTHING
          `, [
            budget_id, line_item_id, department, category,
            pct >= 100 ? 'overspent' : 'warning',
            pct >= 100 ? 100 : 80,
            Math.round(pct),
            parseFloat(li.annual_amount),
            parseFloat(li.total_actual),
            companyId,
          ]).catch(() => {});
        }
      }
    }

    return res.status(201).json(actual);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /budgets/report/alerts — overspend notifications ─────────────────────
router.get('/report/alerts', async (req, res) => {
  const companyId = companyOf(req);
  try {

    const { rows } = await pool.query(`
      SELECT * FROM budget_alerts
      WHERE company_id = $1 AND is_read = FALSE
      ORDER BY current_pct DESC, created_at DESC
      LIMIT 50
    `, [companyId]);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /budgets/:id/approve ─────────────────────────────────────────────────
router.post('/:id/approve', allowRoles(...BUDGET_APPROVE_ROLES), async (req, res) => {
  const companyId = companyOf(req);
  try {
    const actorId = req.user?.userId ?? req.user?.id;
    const { rows: [old] } = await pool.query(
      `SELECT * FROM budgets WHERE id=$1 AND company_id=$2`,
      [req.params.id, companyId]
    );
    if (!old) return res.status(404).json({ error: 'Budget not found' });

    await pool.query(`
      UPDATE budgets SET status='approved', approved_by=$1, approved_at=NOW()
      WHERE id=$2 AND company_id=$3
    `, [actorId, req.params.id, companyId]);

    logAudit({
      userId: actorId,
      module: 'budgets',
      recordId: req.params.id,
      recordType: 'budget',
      action: 'approve',
      oldData: old,
      newData: { ...old, status: 'approved', approved_by: actorId },
      req,
    });

    return res.json({ success: true, message: 'Budget approved' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /budgets/sync-actuals ────────────────────────────────────────────────
// Syncs budget_actuals from posted journal entries grouped by department/cost_center.
// Replaces manually-entered actuals with real GL data for the given financial_year.
router.post('/sync-actuals', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const { financial_year } = req.body;
    if (!financial_year) return res.status(400).json({ error: 'financial_year is required (e.g. "2025-26")' });

    const companyId = companyOf(req);
    // Derive FY date range
    const [startYearStr] = financial_year.split('-');
    const startYear = parseInt(startYearStr, 10);
    const fyStart = `${startYear}-04-01`;
    const fyEnd   = `${startYear + 1}-03-31`;

    // Sum posted expense journal lines by department (cost_centre field)
    const { rows: glActuals } = await pool.query(
      `SELECT
         COALESCE(jl.cost_centre, 'General') AS department,
         SUM(jl.debit - jl.credit) AS actual_amount
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN chart_of_accounts coa ON coa.id = jl.account_id
       WHERE je.status = 'posted'
         AND je.entry_date BETWEEN $1 AND $2
         AND coa.account_type = 'Expense'
         ${companyId ? 'AND je.company_id = $3' : ''}
       GROUP BY COALESCE(jl.cost_centre, 'General')`,
      companyId ? [fyStart, fyEnd, companyId] : [fyStart, fyEnd]
    );

    // Get all active budgets for this FY
    const { rows: budgets } = await pool.query(
      `SELECT id, department FROM budgets WHERE financial_year = $1 ${companyId ? 'AND company_id = $2' : ''}`,
      companyId ? [financial_year, companyId] : [financial_year]
    );

    const glMap = glActuals.reduce((m, r) => { m[r.department] = parseFloat(r.actual_amount) || 0; return m; }, {});
    let synced = 0;

    for (const budget of budgets) {
      const actualAmount = glMap[budget.department] || glMap['General'] || 0;
      if (actualAmount <= 0) continue;

      // Upsert: delete existing GL-synced actuals for this budget+FY, then insert
      await pool.query(
        `DELETE FROM budget_actuals WHERE budget_id = $1 AND source = 'gl_sync'`,
        [budget.id]
      );
      await pool.query(
        `INSERT INTO budget_actuals (budget_id, actual_amount, recorded_date, source, company_id)
         VALUES ($1, $2, $3, 'gl_sync', $4)`,
        [budget.id, actualAmount, fyEnd, companyId]
      );
      synced++;
    }

    res.json({
      success: true,
      financial_year,
      budgets_synced: synced,
      departments_with_gl_data: glActuals.length,
      message: `Synced actuals from GL for ${synced} budget(s) in FY ${financial_year}`,
    });
  } catch (err) {
    console.error('[POST /budgets/sync-actuals]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /budgets/:id — edit draft budget ─────────────────────────────────────
router.put('/:id', requirePermission('finance', 'edit'), async (req, res) => {
  const { name, department, budget_type, total_amount, notes } = req.body;
  const companyId = companyOf(req);
  try {
    const { rows: [existing] } = await pool.query(
      'SELECT id, status FROM budgets WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!existing) return res.status(404).json({ error: 'Budget not found' });
    if (existing.status !== 'draft') return res.status(400).json({ error: 'Only draft budgets can be edited' });

    const amount = total_amount !== undefined ? parseFloat(total_amount) : undefined;
    if (amount !== undefined && !Number.isFinite(amount)) {
      return res.status(400).json({ error: 'total_amount must be a finite numeric value' });
    }

    const { rows: [updated] } = await pool.query(`
      UPDATE budgets SET
        name         = COALESCE($1, name),
        department   = COALESCE($2, department),
        budget_type  = COALESCE($3, budget_type),
        total_amount = COALESCE($4, total_amount),
        notes        = COALESCE($5, notes),
        updated_at   = NOW()
      WHERE id = $6 AND company_id = $7
      RETURNING *
    `, [name ?? null, department ?? null, budget_type ?? null,
        Number.isFinite(amount) ? amount : null,
        notes !== undefined ? notes : null,
        req.params.id, companyId]);

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /budgets/:id — delete draft budget ─────────────────────────────────
router.delete('/:id', requirePermission('finance', 'delete'), async (req, res) => {
  const companyId = companyOf(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [existing] } = await client.query(
      'SELECT id, status FROM budgets WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Budget not found' });
    }
    if (existing.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only draft budgets can be deleted' });
    }
    await client.query('DELETE FROM budget_actuals     WHERE budget_id = $1', [req.params.id]);
    await client.query('DELETE FROM budget_line_items  WHERE budget_id = $1', [req.params.id]);
    await client.query('DELETE FROM budget_alerts      WHERE budget_id = $1', [req.params.id]);
    await client.query('DELETE FROM budgets            WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    await client.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;
