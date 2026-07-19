/**
 * aiPayroll.service.js
 * AI data service — payroll insights from DB aggregations.
 * Queries payroll_runs + employees tables directly.
 * No mock data. No frontend logic. Pure structured output.
 */
import pool from '../shared/db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true if payroll_runs table exists (may not exist before first run). */
async function payrollRunsExist() {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'payroll_runs' LIMIT 1
  `);
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Payroll Trends — monthly total payroll cost
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns monthly aggregated payroll cost for all recorded runs.
 * Falls back to employee basic_salary aggregation if payroll_runs is empty.
 *
 * @param {number} [months=12] — how many past months to include
 * @returns {Array<{
 *   year: number, month: number, month_label: string,
 *   total_gross: number, total_net: number,
 *   total_pf: number, total_esi: number, total_tds: number,
 *   employee_count: number
 * }>}
 */
export async function getPayrollTrends(months = 12) {
  const exists = await payrollRunsExist();

  if (exists) {
    const { rows } = await pool.query(`
      SELECT
        pr.year,
        pr.month,
        TO_CHAR(TO_DATE(pr.month::TEXT, 'MM'), 'Mon')          AS month_label,
        COUNT(DISTINCT pr.employee_id)::INT                     AS employee_count,
        ROUND(SUM(pr.gross)::NUMERIC, 2)                        AS total_gross,
        ROUND(SUM(pr.net_pay)::NUMERIC, 2)                      AS total_net,
        ROUND(SUM(pr.employee_pf + pr.employer_pf)::NUMERIC, 2) AS total_pf,
        ROUND(SUM(pr.employee_esi + pr.employer_esi)::NUMERIC, 2) AS total_esi,
        ROUND(SUM(pr.tds)::NUMERIC, 2)                          AS total_tds
      FROM payroll_runs pr
      WHERE
        TO_DATE(pr.year::TEXT || '-' || LPAD(pr.month::TEXT, 2, '0') || '-01', 'YYYY-MM-DD')
          >= DATE_TRUNC('month', NOW()) - ($1 || ' months')::INTERVAL
      GROUP BY pr.year, pr.month
      ORDER BY pr.year ASC, pr.month ASC
    `, [months]);

    return rows.map(r => ({
      year:           parseInt(r.year),
      month:          parseInt(r.month),
      month_label:    r.month_label,
      employee_count: r.employee_count,
      total_gross:    parseFloat(r.total_gross  || 0),
      total_net:      parseFloat(r.total_net    || 0),
      total_pf:       parseFloat(r.total_pf     || 0),
      total_esi:      parseFloat(r.total_esi    || 0),
      total_tds:      parseFloat(r.total_tds    || 0),
    }));
  }

  // Fallback: derive from employees.basic_salary for current month only
  const { rows } = await pool.query(`
    SELECT
      EXTRACT(YEAR  FROM NOW())::INT AS year,
      EXTRACT(MONTH FROM NOW())::INT AS month,
      TO_CHAR(NOW(), 'Mon')          AS month_label,
      COUNT(*)::INT                  AS employee_count,
      ROUND(SUM(basic_salary)::NUMERIC, 2) AS total_gross
    FROM employees
    WHERE LOWER(status) IN ('active', 'probation')
  `);

  return rows.map(r => ({
    year:           r.year,
    month:          r.month,
    month_label:    r.month_label,
    employee_count: r.employee_count,
    total_gross:    parseFloat(r.total_gross || 0),
    total_net:      null,
    total_pf:       null,
    total_esi:      null,
    total_tds:      null,
    note:           'payroll_runs table empty — using employee base salary',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Department Cost Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns total salary cost per department.
 * Prefers payroll_runs data (last completed month); falls back to basic_salary.
 *
 * @returns {Array<{
 *   department: string,
 *   employee_count: number,
 *   total_gross: number, total_net: number,
 *   total_pf: number, total_tds: number,
 *   avg_gross_per_employee: number,
 *   source: 'payroll_runs' | 'employees'
 * }>}
 */
export async function getDepartmentCostAnalysis() {
  const exists = await payrollRunsExist();

  if (exists) {
    // Use most recent month that has data
    const { rows: latestRows } = await pool.query(`
      SELECT year, month FROM payroll_runs
      ORDER BY year DESC, month DESC LIMIT 1
    `);

    if (latestRows.length) {
      const { year, month } = latestRows[0];
      const { rows } = await pool.query(`
        SELECT
          e.department,
          COUNT(DISTINCT pr.employee_id)::INT                      AS employee_count,
          ROUND(SUM(pr.gross)::NUMERIC, 2)                         AS total_gross,
          ROUND(SUM(pr.net_pay)::NUMERIC, 2)                       AS total_net,
          ROUND(SUM(pr.employee_pf + pr.employer_pf)::NUMERIC, 2)  AS total_pf,
          ROUND(SUM(pr.tds)::NUMERIC, 2)                           AS total_tds,
          ROUND(AVG(pr.gross)::NUMERIC, 2)                         AS avg_gross_per_employee
        FROM payroll_runs pr
        JOIN employees e ON e.id = pr.employee_id
        WHERE pr.year = $1 AND pr.month = $2
          AND e.department IS NOT NULL
        GROUP BY e.department
        ORDER BY total_gross DESC
      `, [year, month]);

      return rows.map(r => ({
        department:              r.department,
        employee_count:          r.employee_count,
        total_gross:             parseFloat(r.total_gross             || 0),
        total_net:               parseFloat(r.total_net               || 0),
        total_pf:                parseFloat(r.total_pf                || 0),
        total_tds:               parseFloat(r.total_tds               || 0),
        avg_gross_per_employee:  parseFloat(r.avg_gross_per_employee  || 0),
        source:                  'payroll_runs',
        period:                  { year: parseInt(year), month: parseInt(month) },
      }));
    }
  }

  // Fallback: use employees.basic_salary
  const { rows } = await pool.query(`
    SELECT
      department,
      COUNT(*)::INT                          AS employee_count,
      ROUND(SUM(basic_salary)::NUMERIC, 2)   AS total_gross,
      ROUND(AVG(basic_salary)::NUMERIC, 2)   AS avg_gross_per_employee
    FROM employees
    WHERE LOWER(status) IN ('active', 'probation')
      AND department IS NOT NULL
    GROUP BY department
    ORDER BY total_gross DESC
  `);

  return rows.map(r => ({
    department:             r.department,
    employee_count:         r.employee_count,
    total_gross:            parseFloat(r.total_gross            || 0),
    total_net:              null,
    total_pf:               null,
    total_tds:              null,
    avg_gross_per_employee: parseFloat(r.avg_gross_per_employee || 0),
    source:                 'employees',
    note:                   'payroll_runs empty — using employee base salary',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Anomaly Flags — month-over-month spikes > threshold
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects unusual payroll cost spikes month-over-month.
 *
 * @param {number} [threshold=0.20] — fractional spike threshold (default 20%)
 * @returns {Array<{
 *   year: number, month: number, month_label: string,
 *   total_gross: number,
 *   prev_gross: number,
 *   change_pct: number,
 *   anomaly_type: 'spike' | 'drop',
 *   severity: 'low' | 'medium' | 'high',
 *   affected_employees: number
 * }>}
 */
export async function getAnomalyFlags(threshold = 0.20) {
  const exists = await payrollRunsExist();
  if (!exists) return [];

  const { rows } = await pool.query(`
    WITH MonthlyTotals AS (
      SELECT
        year,
        month,
        TO_CHAR(TO_DATE(month::TEXT, 'MM'), 'Mon') AS month_label,
        COUNT(DISTINCT employee_id)::INT          AS employee_count,
        ROUND(SUM(gross)::NUMERIC, 2)             AS total_gross
      FROM payroll_runs
      GROUP BY year, month
    ),
    Comparison AS (
      SELECT
        *,
        LAG(total_gross) OVER (ORDER BY year ASC, month ASC) AS prev_gross,
        LAG(year)  OVER (ORDER BY year ASC, month ASC) AS prev_year,
        LAG(month) OVER (ORDER BY year ASC, month ASC) AS prev_month
      FROM MonthlyTotals
    )
    SELECT
      *,
      ROUND(((total_gross - prev_gross) / NULLIF(prev_gross, 0))::NUMERIC, 4) AS change_pct
    FROM Comparison
    WHERE ABS((total_gross - prev_gross) / NULLIF(prev_gross, 0)) >= $1
    ORDER BY year DESC, month DESC
  `, [threshold]);

  return rows.map(r => {
    const absChange = Math.abs(parseFloat(r.change_pct));
    let severity = 'low';
    if      (absChange >= 0.50) severity = 'high';
    else if (absChange >= 0.35) severity = 'medium';

    return {
      year:               parseInt(r.year),
      month:              parseInt(r.month),
      month_label:        r.month_label,
      total_gross:        parseFloat(r.total_gross),
      prev_gross:         parseFloat(r.prev_gross),
      change_pct:         parseFloat((parseFloat(r.change_pct) * 100).toFixed(2)),
      anomaly_type:       parseFloat(r.change_pct) > 0 ? 'spike' : 'drop',
      severity,
      affected_employees: parseInt(r.employee_count),
      prev_period: {
        year:  parseInt(r.prev_year),
        month: parseInt(r.prev_month),
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Combined AI context bundle (convenience export)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all three datasets in a single call for AI consumption.
 * Each key is independently safe (empty array / null on failure).
 */
export async function getAIPayrollContext({ months = 12, anomalyThreshold = 0.20 } = {}) {
  const [trends, departments, anomalies] = await Promise.allSettled([
    getPayrollTrends(months),
    getDepartmentCostAnalysis(),
    getAnomalyFlags(anomalyThreshold),
  ]);

  return {
    generated_at:   new Date().toISOString(),
    trends:         trends.status      === 'fulfilled' ? trends.value      : [],
    departments:    departments.status === 'fulfilled' ? departments.value : [],
    anomalies:      anomalies.status   === 'fulfilled' ? anomalies.value   : [],
    errors: [
      trends.status      === 'rejected' ? { key: 'trends',      message: trends.reason?.message      } : null,
      departments.status === 'rejected' ? { key: 'departments', message: departments.reason?.message } : null,
      anomalies.status   === 'rejected' ? { key: 'anomalies',   message: anomalies.reason?.message   } : null,
    ].filter(Boolean),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Predictive Layer — Cash Flow Forecasting
// ─────────────────────────────────────────────────────────────────────────────

/** Checks if finance tables exist. */
async function financeTablesExist() {
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_name IN ('invoices', 'bills')
  `);
  return rows.length >= 2;
}

/**
 * Predicts incoming and outgoing cash flow based on invoice and bill due dates.
 * 
 * @param {number} [daysAhead=30] 
 * @returns {Promise<Array<{ date: string, inflow: number, outflow: number, balance: number }>>}
 */
export async function getPredictiveCashFlow(daysAhead = 30) {
  if (!(await financeTablesExist())) return [];

  const { rows: results } = await pool.query(`
    WITH Forecast AS (
      -- Inflow from Pending Invoices
      SELECT 
        due_date, 
        SUM(balance) as inflow, 
        0::NUMERIC as outflow
      FROM invoices
      WHERE status NOT IN ('Paid', 'Cancelled') AND due_date >= CURRENT_DATE
      GROUP BY due_date
      
      UNION ALL
      
      -- Outflow from Supplier Bills
      SELECT 
        due_date, 
        0::NUMERIC as inflow, 
        SUM(balance) as outflow
      FROM bills
      WHERE status NOT IN ('Paid', 'Cancelled') AND due_date >= CURRENT_DATE
      GROUP BY due_date
    )
    SELECT 
      TO_CHAR(due_date, 'YYYY-MM-DD') as date,
      ROUND(SUM(inflow)::NUMERIC, 2) as inflow,
      ROUND(SUM(outflow)::NUMERIC, 2) as outflow,
      ROUND((SUM(inflow) - SUM(outflow))::NUMERIC, 2) as net_daily
    FROM Forecast
    WHERE due_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL
    GROUP BY due_date
    ORDER BY due_date
  `, [daysAhead]);

  return results.map(r => ({
    date:     r.date,
    inflow:   parseFloat(r.inflow  || 0),
    outflow:  parseFloat(r.outflow || 0),
    net:      parseFloat(r.net_daily || 0),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Natural Language ERP Intelligence (LLM Agent Hook)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches grounded ERP context snippets for LLM consumption based on query keywords.
 * Returns a plain-text summary string ready to embed in a system prompt.
 * Every figure comes from the DB — nothing is fabricated.
 */
export async function buildQueryContext(query) {
  const q = query.toLowerCase();
  const sections = [];

  // Payroll context — always included
  try {
    const ctx = await getAIPayrollContext({ months: 3 });
    if (ctx.departments.length) {
      sections.push(
        'DEPARTMENT PAYROLL (latest month):\n' +
        ctx.departments.map(d =>
          `  ${d.department}: gross ₹${(d.total_gross / 100000).toFixed(2)}L, ${d.employee_count} employees`
        ).join('\n')
      );
    }
    if (ctx.anomalies.length) {
      sections.push(
        'PAYROLL ANOMALIES:\n' +
        ctx.anomalies.map(a =>
          `  ${a.month_label} ${a.year}: ${a.anomaly_type} ${Math.abs(a.change_pct).toFixed(1)}%`
        ).join('\n')
      );
    }
  } catch (_) {}

  // Revenue — included when query mentions revenue/sales/invoice/trend
  if (q.includes('revenue') || q.includes('sales') || q.includes('invoice') || q.includes('trend')) {
    try {
      const { rows } = await pool.query(`
        SELECT TO_CHAR(invoice_date,'Mon YYYY') AS month,
               SUM(total_amount)::numeric AS revenue,
               COUNT(*) AS invoice_count
        FROM invoices
        WHERE invoice_date >= NOW() - INTERVAL '6 months'
        GROUP BY TO_CHAR(invoice_date,'Mon YYYY'), DATE_TRUNC('month', invoice_date)
        ORDER BY DATE_TRUNC('month', invoice_date) ASC
      `);
      if (rows.length) {
        sections.push(
          'REVENUE (last 6 months):\n' +
          rows.map(r =>
            `  ${r.month}: ₹${(parseFloat(r.revenue) / 100000).toFixed(2)}L (${r.invoice_count} invoices)`
          ).join('\n')
        );
      }
    } catch (_) {}
  }

  // Inventory — included when query mentions stock/inventory/reorder
  if (q.includes('inventory') || q.includes('stock') || q.includes('reorder') || q.includes('item')) {
    try {
      const { rows } = await pool.query(`
        SELECT name, current_stock, reorder_point, unit_of_measure
        FROM inventory_items
        WHERE current_stock <= reorder_point * 1.5
        ORDER BY current_stock::float / NULLIF(reorder_point, 0) ASC
        LIMIT 10
      `);
      if (rows.length) {
        sections.push(
          'INVENTORY AT RISK:\n' +
          rows.map(r =>
            `  ${r.name}: ${r.current_stock} ${r.unit_of_measure} (reorder at ${r.reorder_point})`
          ).join('\n')
        );
      }
    } catch (_) {}
  }

  // Cash / finance — overdue receivables + payables
  if (q.includes('cash') || q.includes('finance') || q.includes('receivable') || q.includes('payable') || q.includes('overdue')) {
    try {
      const [inv, bill] = await Promise.allSettled([
        pool.query(`SELECT COALESCE(SUM(total_amount),0) AS t, COUNT(*) AS cnt FROM invoices WHERE status NOT IN ('paid','Paid') AND due_date < CURRENT_DATE`),
        pool.query(`SELECT COALESCE(SUM(amount),0) AS t, COUNT(*) AS cnt FROM bills WHERE status NOT IN ('paid','Paid') AND due_date < CURRENT_DATE`),
      ]);
      const recAmt = inv.status === 'fulfilled' ? parseFloat(inv.value.rows[0]?.t || 0) : 0;
      const payAmt = bill.status === 'fulfilled' ? parseFloat(bill.value.rows[0]?.t || 0) : 0;
      sections.push(
        `CASH POSITION:\n  Overdue receivables: ₹${(recAmt / 100000).toFixed(2)}L` +
        `\n  Overdue payables: ₹${(payAmt / 100000).toFixed(2)}L` +
        `\n  Net: ₹${((recAmt - payAmt) / 100000).toFixed(2)}L`
      );
    } catch (_) {}
  }

  // HR / headcount / leave
  if (q.includes('hr') || q.includes('employee') || q.includes('headcount') || q.includes('attrition') || q.includes('leave') || q.includes('staff')) {
    try {
      const [hc, pending] = await Promise.allSettled([
        pool.query(`SELECT department, COUNT(*) AS cnt FROM employees WHERE status='active' GROUP BY department ORDER BY cnt DESC LIMIT 8`),
        pool.query(`SELECT COUNT(*) AS cnt FROM leave_requests WHERE status='pending'`),
      ]);
      if (hc.status === 'fulfilled' && hc.value.rows.length) {
        const total = hc.value.rows.reduce((s, r) => s + parseInt(r.cnt), 0);
        sections.push(
          `HEADCOUNT (active): ${total} total\n` +
          hc.value.rows.map(r => `  ${r.department}: ${r.cnt}`).join('\n')
        );
      }
      if (pending.status === 'fulfilled') {
        sections.push(`PENDING LEAVE REQUESTS: ${pending.value.rows[0]?.cnt || 0}`);
      }
    } catch (_) {}
  }

  return sections.length
    ? sections.join('\n\n')
    : 'No specific ERP data matched this query. Answer from general business knowledge only.';
}

/**
 * Logic to answer natural language queries based on ERP data.
 * This acts as a structured context provider or a direct handler for common BI questions.
 */
export async function queryERPIntelligence(query) {
  const q = query.toLowerCase();

  // Pattern: "Why is [Department] payroll [X]% higher?"
  const payrollMatch = q.match(/why is (.*) payroll (.*) higher/);
  if (payrollMatch) {
    const department = payrollMatch[1].trim();
    const anomalies = await getAnomalyFlags(0.01); // 1% threshold to find details
    
    // Check if we have an anomaly for this dept
    const deptAnalysis = await getDepartmentCostAnalysis();
    const deptData = deptAnalysis.find(d => d.department.toLowerCase() === department);
    
    if (!deptData) return { answer: `I couldn't find data for the ${department} department.` };

    // Analyze cause (e.g., headcount change, salary spikes)
    const { rows: headcount } = await pool.query(`
      SELECT COUNT(*) as count FROM employees 
      WHERE LOWER(department) = $1 AND LOWER(status) = 'active'
    `, [department]);

    return {
      answer: `The ${department} department payroll is currently ${deptData.total_gross.toLocaleString()} with ${deptData.employee_count} employees.`,
      analysis: {
        department: department,
        avg_gross: deptData.avg_gross_per_employee,
        current_headcount: parseInt(headcount[0]?.count || 0),
        reasoning: "Data indicates current month expenditure vs baseline. Further breakdown requires monthly run comparison."
      }
    };
  }

  // Pattern: "Predict cash flow"
  if (q.includes('predict cash flow') || q.includes('cashflow') || q.includes('forecast')) {
    const forecast = await getPredictiveCashFlow(30);
    const totalIn = forecast.reduce((s, r) => s + r.inflow, 0);
    const totalOut = forecast.reduce((s, r) => s + r.outflow, 0);
    
    return {
      answer: `In the next 30 days, we expect an inflow of ${totalIn.toLocaleString()} and an outflow of ${totalOut.toLocaleString()}.`,
      forecast: forecast,
      summary: {
        total_inflow: totalIn,
        total_outflow: totalOut,
        net_position: totalIn - totalOut
      }
    };
  }

  return { answer: "I'm sorry, I don't have enough data to answer that specific query yet. Try asking about 'Engineeing payroll' or 'Cash flow forecast'." };
}
