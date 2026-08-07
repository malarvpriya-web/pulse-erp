// backend/src/modules/intelligence/ai.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { narrateKpis } from './kpiNarrator.js';
import { detectAnomalies } from './anomalyDetector.js';
import { getSalesDashboard, getServiceDashboard } from '../crm/customerHealth.service.js';
import { scoreProjectHealth, narrateProjectHealth } from './projectHealthNarrator.js';
import { narrateTicketThread } from './ticketThreadNarrator.js';

const router = express.Router();

/* ─── POST /api/ai/ceo-insights ────────────────────────────────── */
// Returns a GPT-generated narrative if OPENAI_API_KEY is set,
// otherwise falls back to a rule-based summary built from the payload.
// No operational data is invented here — all numbers come from the caller's payload.
// Narration logic lives in kpiNarrator.js so kpiDigest.cron.js can reuse it.
router.post('/ceo-insights', async (req, res) => {
  const { dashboardData = {} } = req.body;
  const result = await narrateKpis(dashboardData);
  res.json(result);
});

/* ─── LLM proxy: in-memory rate limiter ────────────────────────── */
const _rl = new Map(); // userId -> { date: 'YYYY-MM-DD', count: number }
const RL_MAX = 20;

function getRLEntry(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = _rl.get(userId) ?? { date: today, count: 0 };
  if (entry.date !== today) { entry.date = today; entry.count = 0; }
  return entry;
}

/* ─── POST /api/ai/llm-chat ─────────────────────────────────────── */
router.post('/llm-chat', async (req, res) => {
  const { userId, role } = req.user;
  const { messages = [] } = req.body;

  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array is required.' });

  const entry = getRLEntry(userId);
  if (entry.count >= RL_MAX) {
    return res.status(429).json({ error: `Daily limit of ${RL_MAX} messages reached. Try again tomorrow.`, remaining: 0 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your-openai-api-key-here') {
    return res.status(503).json({ error: 'AI service is not configured. Ask your admin to add OPENAI_API_KEY to the backend .env.' });
  }

  let erpContext = '';
  try {
    // employees has no user_id column — this subquery always returned zero
    // rows, so leave-balance context never appeared in the AI chat. users
    // already has employee_id directly, no need to go via employees at all.
    const { rows: lb } = await pool.query(
      `SELECT leave_type, balance FROM leave_balances
       WHERE employee_id = (SELECT employee_id FROM users WHERE id = $1 LIMIT 1)`,
      [userId]
    ).catch(() => ({ rows: [] }));

    if (lb.length) {
      erpContext += `\n\nUser leave balances: ${lb.map(r => `${r.leave_type} — ${r.balance} days`).join(', ')}.`;
    }

    if (['admin', 'hr', 'manager'].includes(role)) {
      const { rows: pa } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM leave_requests WHERE status = 'pending'`
      ).catch(() => ({ rows: [{ cnt: 0 }] }));
      const cnt = parseInt(pa[0]?.cnt || 0);
      if (cnt > 0) erpContext += `\nPending leave approvals: ${cnt}.`;
    }

    const { rows: emp } = await pool.query(
      `SELECT name FROM employees WHERE id = (SELECT employee_id FROM users WHERE id = $1) LIMIT 1`, [userId]
    ).catch(() => ({ rows: [] }));
    if (emp.length) erpContext += `\nCurrent user name: ${emp[0].name}.`;
  } catch (_) {}

  const systemPrompt =
    `You are Pulse, an AI assistant for Pulse ERP at Manifest Technologies. ` +
    `Help employees with HR, finance, inventory, and project questions. ` +
    `Be concise and helpful. When asked to navigate somewhere, name the exact ERP module or page. ` +
    `Current user role: ${role || 'employee'}.` +
    erpContext;

  try {
    const apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.slice(-20),
        ],
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `OpenAI API error ${apiRes.status}`);
    }

    const data = await apiRes.json();
    const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';

    entry.count += 1;
    _rl.set(userId, entry);

    res.json({ reply, remaining: RL_MAX - entry.count });
  } catch (err) {
    res.status(500).json({ error: err.message || 'AI request failed.' });
  }
});

/* ─── POST /api/ai/feedback ─────────────────────────────────────── */
router.post('/feedback', (req, res) => {
  const { feedback, messageIndex } = req.body;
  if (!['up', 'down'].includes(feedback))
    return res.status(400).json({ error: 'feedback must be "up" or "down".' });
  console.log(`[AI feedback] user=${req.user.userId} msg=${messageIndex} vote=${feedback}`);
  res.json({ success: true });
});

/* ─── helpers ──────────────────────────────────────────────────── */
const linReg = (points) => {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.[1] || 0 };
  const sumX  = points.reduce((s, [x])    => s + x,     0);
  const sumY  = points.reduce((s, [, y])  => s + y,     0);
  const sumXY = points.reduce((s, [x, y]) => s + x * y, 0);
  const sumX2 = points.reduce((s, [x])    => s + x * x, 0);
  const slope     = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX ** 2);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
};

/* ─── POST /api/ai/chat ─────────────────────────────────────────── */
// STRICT: never falls back to fabricated operational data.
// If DB returns empty, surface that fact explicitly.
router.post('/chat', async (req, res) => {
  const { message = '' } = req.body;
  const q = message.toLowerCase();

  try {
    // Leave / absence
    if (q.includes('leave') || q.includes('absent') || q.includes('holiday')) {
      const { rows } = await pool.query(`
        SELECT e.name, l.leave_type, l.start_date, l.end_date, l.status
        FROM leave_requests l
        JOIN employees e ON e.id = l.employee_id
        WHERE l.status = 'approved' AND l.start_date >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY l.start_date DESC LIMIT 20
      `).catch(() => ({ rows: [] }));
      if (!rows.length)
        return res.json({ answer: 'No approved leave records found in the last 7 days.', data: [], chart_type: 'table', query_used: 'leave_requests JOIN employees' });
      return res.json({ answer: `${rows.length} employee(s) on approved leave this week.`, data: rows, chart_type: 'table', query_used: 'leave_requests JOIN employees' });
    }

    // Cash / finance
    if (q.includes('cash') || q.includes('finance') || q.includes('balance')) {
      const [invRes, billRes] = await Promise.allSettled([
        pool.query(`SELECT SUM(total_amount) as t FROM invoices WHERE status != 'paid'`),
        pool.query(`SELECT SUM(amount) as t FROM bills WHERE status != 'paid'`),
      ]);
      const recVal = invRes.status === 'fulfilled' ? parseFloat(invRes.value.rows[0]?.t ?? 0) : null;
      const payVal = billRes.status === 'fulfilled' ? parseFloat(billRes.value.rows[0]?.t ?? 0) : null;
      if (recVal === null && payVal === null)
        return res.json({ answer: 'Cash position data unavailable — finance tables could not be queried.', data: [], chart_type: 'number', query_used: 'invoices + bills SUM' });
      const rec = recVal ?? 0, pay = payVal ?? 0;
      const data = [
        { label: 'Receivable',   value: rec },
        { label: 'Payable',      value: pay },
        { label: 'Net Position', value: rec - pay },
      ];
      return res.json({ answer: `Net cash ₹${((rec - pay)/100000).toFixed(2)}L. Receivables ₹${(rec/100000).toFixed(2)}L, Payables ₹${(pay/100000).toFixed(2)}L.`, data, chart_type: 'bar', query_used: 'invoices + bills SUM' });
    }

    // Inventory / stock
    if (q.includes('stock') || q.includes('inventory') || q.includes('low stock') || q.includes('item')) {
      const { rows } = await pool.query(`
        SELECT name, current_stock, reorder_point, unit
        FROM inventory_items WHERE current_stock <= reorder_point
        ORDER BY (current_stock::float / NULLIF(reorder_point,0)) ASC LIMIT 15
      `).catch(() => ({ rows: [] }));
      if (!rows.length)
        return res.json({ answer: 'No items below reorder point currently.', data: [], chart_type: 'table', query_used: 'inventory_items WHERE stock <= reorder_point' });
      return res.json({ answer: `${rows.length} item(s) below reorder point.`, data: rows, chart_type: 'table', query_used: 'inventory_items WHERE stock <= reorder_point' });
    }

    // Employee / headcount
    if (q.includes('employee') || q.includes('staff') || q.includes('headcount')) {
      const { rows } = await pool.query(
        `SELECT department, COUNT(*) as count FROM employees WHERE status='active' GROUP BY department ORDER BY count DESC`
      ).catch(() => ({ rows: [] }));
      if (!rows.length)
        return res.json({ answer: 'No active employee records found.', data: [], chart_type: 'bar', query_used: 'employees GROUP BY department' });
      const total = rows.reduce((s, r) => s + parseInt(r.count), 0);
      return res.json({ answer: `Total ${total} active employees across ${rows.length} departments.`, data: rows, chart_type: 'bar', query_used: 'employees GROUP BY department' });
    }

    // Overdue invoices
    if (q.includes('overdue') || q.includes('due') || q.includes('unpaid')) {
      const { rows } = await pool.query(`
        SELECT client_name, invoice_number, total_amount, due_date,
               CURRENT_DATE - due_date AS days_overdue
        FROM invoices WHERE status != 'paid' AND due_date < CURRENT_DATE
        ORDER BY days_overdue DESC LIMIT 15
      `).catch(() => ({ rows: [] }));
      if (!rows.length)
        return res.json({ answer: 'No overdue invoices found.', data: [], chart_type: 'table', query_used: 'invoices WHERE due_date < NOW()' });
      const total = rows.reduce((s, r) => s + parseFloat(r.total_amount || 0), 0);
      return res.json({ answer: `${rows.length} overdue invoices totalling ₹${(total/100000).toFixed(2)}L.`, data: rows, chart_type: 'table', query_used: 'invoices WHERE due_date < NOW()' });
    }

    // Revenue / sales
    if (q.includes('revenue') || q.includes('sales') || q.includes('target')) {
      const { rows } = await pool.query(`
        SELECT TO_CHAR(invoice_date,'Mon YY') as month, SUM(total_amount) as revenue
        FROM invoices WHERE invoice_date >= NOW() - INTERVAL '6 months'
        GROUP BY TO_CHAR(invoice_date,'Mon YY'), DATE_TRUNC('month',invoice_date)
        ORDER BY DATE_TRUNC('month',invoice_date) ASC
      `).catch(() => ({ rows: [] }));
      if (!rows.length)
        return res.json({ answer: 'No revenue data found for the last 6 months.', data: [], chart_type: 'line', query_used: 'invoices GROUP BY month' });
      return res.json({ answer: `Revenue trend for last 6 months. Latest: ₹${(parseFloat(rows[rows.length-1]?.revenue||0)/100000).toFixed(2)}L.`, data: rows, chart_type: 'line', query_used: 'invoices GROUP BY month' });
    }

    // Approvals
    if (q.includes('approval') || q.includes('pending') || q.includes('waiting')) {
      const [leavePending, poPending] = await Promise.allSettled([
        pool.query(`SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest FROM leave_requests WHERE status = 'pending'`),
        pool.query(`SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest FROM purchase_orders WHERE status IN ('pending','draft')`),
      ]);
      const data = [];
      if (leavePending.status === 'fulfilled') {
        const row = leavePending.value.rows[0];
        const cnt = parseInt(row?.cnt || 0);
        if (cnt > 0) data.push({ type: 'Leave Request', count: cnt, oldest_days: row?.oldest ? Math.floor((Date.now() - new Date(row.oldest)) / 86400000) : 0 });
      }
      if (poPending.status === 'fulfilled') {
        const row = poPending.value.rows[0];
        const cnt = parseInt(row?.cnt || 0);
        if (cnt > 0) data.push({ type: 'Purchase Order', count: cnt, oldest_days: row?.oldest ? Math.floor((Date.now() - new Date(row.oldest)) / 86400000) : 0 });
      }
      if (!data.length)
        return res.json({ answer: 'No pending approvals found.', data: [], chart_type: 'table', query_used: 'leave_requests + purchase_orders pending' });
      const total = data.reduce((s, r) => s + r.count, 0);
      return res.json({ answer: `${total} item(s) pending approval across ${data.length} category(s).`, data, chart_type: 'table', query_used: 'leave_requests + purchase_orders pending' });
    }

    // Payroll
    if (q.includes('payroll') || q.includes('salary') || q.includes('payslip')) {
      const { rows } = await pool.query(`
        SELECT
          COALESCE(SUM(gross_salary), 0)  AS gross,
          COALESCE(SUM(pf_amount), 0)     AS pf,
          COALESCE(SUM(tds_deducted), 0)  AS tds,
          COALESCE(SUM(net_salary), 0)    AS net
        FROM payroll_runs
        WHERE month_year = TO_CHAR(NOW() - INTERVAL '1 month', 'YYYY-MM')
      `).catch(() => ({ rows: [] }));
      if (!rows.length || (parseFloat(rows[0]?.gross || 0) === 0))
        return res.json({ answer: 'No payroll data found for last month.', data: [], chart_type: 'bar', query_used: 'payroll_runs aggregate' });
      const r = rows[0];
      const data = [
        { label: 'Gross Payroll',   value: parseFloat(r.gross) },
        { label: 'PF Contribution', value: parseFloat(r.pf) },
        { label: 'TDS Deducted',    value: parseFloat(r.tds) },
        { label: 'Net Disbursed',   value: parseFloat(r.net) },
      ];
      return res.json({ answer: `Last month: Gross ₹${(r.gross/100000).toFixed(2)}L, PF ₹${(r.pf/100000).toFixed(2)}L, TDS ₹${(r.tds/100000).toFixed(2)}L, Net ₹${(r.net/100000).toFixed(2)}L.`, data, chart_type: 'bar', query_used: 'payroll_runs aggregate' });
    }

    // Default
    return res.json({
      answer: 'I can help with: leave status, cash position, inventory, employee headcount, overdue invoices, revenue trends, payroll, and pending approvals.',
      data: [],
      chart_type: 'number',
      query_used: 'none — no keyword match',
    });
  } catch (err) {
    res.json({ answer: 'Database query failed.', data: [], chart_type: 'number', query_used: 'error: ' + err.message });
  }
});

/* ─── GET /api/ai/anomalies ─────────────────────────────────────── */
// Detection logic lives in anomalyDetector.js so anomalyDetection.cron.js
// can reuse it and push flagged anomalies to the relevant role daily,
// instead of only surfacing them when someone opens this endpoint.
router.get('/anomalies', async (req, res) => {
  const anomalies = await detectAnomalies();
  res.json({ success:true, data:anomalies, count:anomalies.length });
});

/* ─── GET /api/ai/predictions ─────────────────────────────────────── */
// STRICT: predictions are derived from real DB history only.
// When insufficient history exists, returns honest uncertainty markers.
router.get('/predictions', async (req, res) => {
  const predictions = {};

  // Revenue forecast — requires at least 2 months of history
  try {
    const { rows } = await pool.query(`
      SELECT DATE_TRUNC('month',invoice_date) as month, SUM(total_amount) as revenue
      FROM invoices WHERE invoice_date>=NOW()-INTERVAL '6 months' GROUP BY 1 ORDER BY 1 ASC
    `);
    if (rows.length < 2) {
      predictions.revenue_forecast = {
        title: 'Revenue Forecast — Next 3 Months',
        historical: rows.map(r => ({ month: new Date(r.month).toLocaleDateString('en-IN',{month:'short',year:'2-digit'}), revenue: parseFloat(r.revenue) })),
        forecast: [],
        insufficient_history: true,
        note: `Only ${rows.length} month(s) of data — need at least 2 months for a forecast.`,
        updated_at: new Date().toISOString(),
      };
    } else {
      const pts = rows.map((r,i) => [i, parseFloat(r.revenue)]);
      const { slope, intercept } = linReg(pts);
      const base = pts.length;
      const hist = rows.map(r => ({ month: new Date(r.month).toLocaleDateString('en-IN',{month:'short',year:'2-digit'}), revenue: parseFloat(r.revenue) }));
      // Project 3 months ahead from the last known month
      const lastMonth = new Date(rows[rows.length-1].month);
      const forecastMonths = [1,2,3].map(i => {
        const d = new Date(lastMonth);
        d.setMonth(d.getMonth() + i);
        return d.toLocaleDateString('en-IN',{month:'long',year:'numeric'});
      });
      predictions.revenue_forecast = {
        title: 'Revenue Forecast — Next 3 Months',
        historical: hist,
        forecast: forecastMonths.map((m,i) => ({
          month: m,
          predicted: Math.max(0, Math.round(intercept + slope*(base+i))),
          low:  Math.max(0, Math.round((intercept + slope*(base+i)) * 0.88)),
          high: Math.max(0, Math.round((intercept + slope*(base+i)) * 1.12)),
        })),
        trend: slope > 0 ? 'increasing' : 'decreasing',
        updated_at: new Date().toISOString(),
      };
    }
  } catch (err) {
    predictions.revenue_forecast = {
      title: 'Revenue Forecast — Next 3 Months',
      historical: [], forecast: [],
      error: 'query_failed', note: err.message,
      updated_at: new Date().toISOString(),
    };
  }

  // Attrition risk by department (new joiners < 2 years)
  try {
    const { rows } = await pool.query(`
      SELECT department, COUNT(*) AS total,
             COUNT(*) FILTER(WHERE EXTRACT(YEAR FROM AGE(date_of_joining))<2) AS at_risk_count
      FROM employees WHERE status='active' GROUP BY department ORDER BY at_risk_count::float/NULLIF(COUNT(*),0) DESC
    `);
    predictions.attrition_risk = {
      title: 'Attrition Risk by Department',
      data: rows.length ? rows.map(r => ({ department: r.department, total: parseInt(r.total), at_risk: parseInt(r.at_risk_count), risk_pct: Math.round(parseInt(r.at_risk_count)/parseInt(r.total)*100) })) : [],
      no_data: rows.length === 0,
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    predictions.attrition_risk = { title: 'Attrition Risk by Department', data: [], error: 'query_failed', note: err.message, updated_at: new Date().toISOString() };
  }

  // Stockout risk — items below 1.5× reorder point
  try {
    const { rows } = await pool.query(
      `SELECT name, current_stock, reorder_point, unit FROM inventory_items WHERE current_stock < reorder_point*1.5 ORDER BY current_stock::float/NULLIF(reorder_point,0) ASC LIMIT 8`
    );
    predictions.stockout_risk = {
      title: 'Inventory Stockout Risk',
      data: rows,
      no_data: rows.length === 0,
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    predictions.stockout_risk = { title: 'Inventory Stockout Risk', data: [], error: 'query_failed', note: err.message, updated_at: new Date().toISOString() };
  }

  // Lead conversion prospects — scored by stage + deal value
  try {
    const { rows } = await pool.query(`
      SELECT id, company_name, deal_value, stage,
             CASE stage WHEN 'Negotiation' THEN 72 WHEN 'Proposal Sent' THEN 55 WHEN 'Demo Done' THEN 45 WHEN 'Qualified' THEN 30 ELSE 15 END
             + CASE WHEN deal_value>1000000 THEN 10 ELSE 5 END AS score
      FROM leads WHERE status NOT IN('lost','won') ORDER BY score DESC LIMIT 5
    `);
    predictions.lead_conversion = {
      title: 'Top Lead Conversion Prospects',
      data: rows.map(r => ({ ...r, score: parseInt(r.score) })),
      no_data: rows.length === 0,
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    predictions.lead_conversion = { title: 'Top Lead Conversion Prospects', data: [], error: 'query_failed', note: err.message, updated_at: new Date().toISOString() };
  }

  res.json({ success: true, data: predictions, generated_at: new Date().toISOString() });
});

/* ─── POST /api/ai/nav-search ──────────────────────────────── */
// Backend proxy for SmartSearch navigation intent — keeps OPENAI_API_KEY server-side.
const NAV_ROUTES = 'Payroll,AllLeaves,InvoicesNew,EmployeesData,AllTickets,ProjectsDashboard,AttendanceDashboard,PurchaseOrders,TravelRequests,AllComplaints,CandidatePipeline,StockSummary,ApprovalCenter,FinanceDashboardNew,MyTimesheet,PerformanceReviews,SalesDashboard,Campaigns,OrgChart,Announcements';
router.post('/nav-search', async (req, res) => {
  const { query = '' } = req.body;
  if (!query.trim()) return res.json({ page: null, label: 'No match' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your-openai-api-key-here') {
    return res.status(503).json({ error: 'AI service not configured.' });
  }

  try {
    const apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 60,
        messages: [{
          role: 'user',
          content: `You are an ERP navigation assistant. The user typed: "${query.slice(0, 200)}".
Reply with ONLY a JSON object: {"page":"<RouteKey>","label":"<friendly name>"}.
Available routes: ${NAV_ROUTES}.
If no match, reply: {"page":null,"label":"No match"}.`,
        }],
      }),
    });
    if (!apiRes.ok) throw new Error(`OpenAI ${apiRes.status}`);
    const data = await apiRes.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '{"page":null,"label":"No match"}';
    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch {
    res.json({ page: null, label: 'No match' });
  }
});

/* ─── GET /api/ai/smart-search ─────────────────────────────────── */
// STRICT: returns empty results when no DB matches found — never fabricates.
router.get('/smart-search', async (req, res) => {
  const { q = '' } = req.query;
  if (!q.trim()) return res.json({ success: true, results: {}, total_hits: 0, query: q });
  const term = `%${q.trim()}%`;
  const companyId = req.scope?.company_id ?? null;
  const results = {};
  await Promise.all([
    pool.query(`SELECT id,first_name || ' ' || last_name AS name,department,designation FROM employees WHERE (first_name ILIKE $1 OR last_name ILIKE $1 OR designation ILIKE $1 OR department ILIKE $1) AND ($2::int IS NULL OR company_id = $2) LIMIT 5`,[term, companyId]).then(({rows})=>{ if(rows.length) results.employees=rows; }).catch(()=>{}),
    pool.query(`SELECT id,invoice_number,party_name AS client_name,total_amount,status FROM invoices WHERE (invoice_number ILIKE $1 OR party_name ILIKE $1) AND ($2::int IS NULL OR company_id = $2) LIMIT 5`,[term, companyId]).then(({rows})=>{ if(rows.length) results.invoices=rows; }).catch(()=>{}),
    pool.query(`SELECT id,project_name,status,manager_name FROM projects WHERE (project_name ILIKE $1 OR manager_name ILIKE $1) AND ($2::int IS NULL OR company_id = $2) LIMIT 5`,[term, companyId]).then(({rows})=>{ if(rows.length) results.projects=rows; }).catch(()=>{}),
    pool.query(`SELECT id,company_name,stage,deal_value FROM leads WHERE company_name ILIKE $1 AND ($2::int IS NULL OR company_id = $2) LIMIT 5`,[term, companyId]).then(({rows})=>{ if(rows.length) results.leads=rows; }).catch(()=>{}),
    pool.query(`SELECT id,item_name AS name,category,current_stock,unit_of_measure AS unit FROM inventory_items WHERE (item_name ILIKE $1 OR category ILIKE $1) AND ($2::int IS NULL OR company_id = $2) LIMIT 5`,[term, companyId]).then(({rows})=>{ if(rows.length) results.inventory=rows; }).catch(()=>{}),
  ]);
  const total = Object.values(results).filter(Array.isArray).reduce((s,a)=>s+a.length,0);
  res.json({ success: true, results, total_hits: total, query: q });
});

/* ─── GET /api/ai/predict/attrition ────────────────────────────────────────── */
router.get('/predict/attrition', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    // Derive attrition risk from actual employee data: tenure, department, recent exits
    const { rows } = await pool.query(`
      SELECT
        department,
        COUNT(*) FILTER (WHERE status NOT IN ('resigned','terminated')) AS active,
        COUNT(*) FILTER (WHERE status IN ('resigned','terminated')
          AND EXTRACT(MONTH FROM AGE(NOW(), updated_at)) <= 3) AS exits_last_90d,
        ROUND(
          COUNT(*) FILTER (WHERE status IN ('resigned','terminated') AND EXTRACT(MONTH FROM AGE(NOW(), updated_at)) <= 3)::numeric
          / NULLIF(COUNT(*),0) * 100, 1
        ) AS attrition_pct
      FROM employees
      WHERE ($1::int IS NULL OR company_id = $1)
      GROUP BY department ORDER BY attrition_pct DESC NULLS LAST LIMIT 10
    `, [cid]);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── GET /api/ai/predict/sales ────────────────────────────────────────────── */
router.get('/predict/sales', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    // Simple moving-average forecast from actual sales orders
    const { rows } = await pool.query(`
      SELECT
        DATE_TRUNC('week', order_date)::date AS week,
        COUNT(*) AS order_count,
        COALESCE(SUM(total_amount),0) AS revenue
      FROM sales_orders
      WHERE order_date >= NOW() - INTERVAL '${days} days'
        AND ($1::int IS NULL OR company_id = $1)
      GROUP BY 1 ORDER BY 1
    `, [cid]);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── GET /api/ai/predict/inventory ────────────────────────────────────────── */
router.get('/predict/inventory', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    // Surface items approaching reorder point, weighted by actual consumption
    // velocity from stock_ledger (quantity_out over the last 30 days) rather
    // than a static current_stock-vs-reorder_level bucket. Mirrors the ROP
    // formula the EOQ Planner uses (dailyDemand * leadTimeDays + safetyStock,
    // see computeEoqMetrics in inventory.routes.js) so both endpoints agree
    // on what "at risk" means. Items with no recent movement fall back to the
    // old static threshold since there's no velocity to project from.
    const { rows } = await pool.query(`
      WITH consumption AS (
        SELECT item_id, SUM(quantity_out) AS consumed_last_30d
        FROM stock_ledger
        WHERE transaction_date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY item_id
      ), scored AS (
        SELECT
          ii.id, ii.item_code, ii.item_name,
          ii.current_stock, ii.reorder_level AS reorder_point, ii.unit_of_measure,
          COALESCE(c.consumed_last_30d, 0) AS consumed_last_30d,
          ROUND(COALESCE(c.consumed_last_30d, 0) / 30.0, 2) AS avg_daily_consumption,
          CASE WHEN COALESCE(c.consumed_last_30d, 0) > 0
            THEN ROUND(ii.current_stock / (c.consumed_last_30d / 30.0), 1)
            ELSE NULL END AS days_of_cover,
          CASE
            WHEN COALESCE(c.consumed_last_30d, 0) > 0 THEN
              CASE
                WHEN ii.current_stock <= (c.consumed_last_30d / 30.0) * COALESCE(ii.lead_time_days, 7) + COALESCE(ii.safety_stock, 0)
                  THEN 'critical'
                WHEN ii.current_stock <= (c.consumed_last_30d / 30.0) * COALESCE(ii.lead_time_days, 7) * 2 + COALESCE(ii.safety_stock, 0)
                  THEN 'warning'
                ELSE 'ok'
              END
            ELSE
              CASE
                WHEN ii.current_stock <= COALESCE(ii.reorder_level, 0) THEN 'critical'
                WHEN ii.current_stock <= COALESCE(ii.reorder_level, 0) * 1.5 THEN 'warning'
                ELSE 'ok'
              END
          END AS risk_level
        FROM inventory_items ii
        LEFT JOIN consumption c ON c.item_id = ii.id
        WHERE ($1::int IS NULL OR ii.company_id = $1)
          AND ii.deleted_at IS NULL
          AND (
            ii.current_stock <= COALESCE(ii.reorder_level, 0) * 2
            OR (
              COALESCE(c.consumed_last_30d, 0) > 0
              AND ii.current_stock <= (c.consumed_last_30d / 30.0) * COALESCE(ii.lead_time_days, 7) * 2 + COALESCE(ii.safety_stock, 0)
            )
          )
      )
      SELECT * FROM scored
      ORDER BY CASE risk_level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, current_stock ASC
      LIMIT 20
    `, [cid]);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── Device-failure prediction (IoT predictive maintenance) ───────────────────
 * A DB-grounded heuristic risk score, in the same spirit as the other /predict/*
 * endpoints — no ML, no invented data. Every point in the score traces to a live
 * signal: open/critical alerts, connection health, breach frequency, an upward
 * trend in a "rising-is-bad" metric (regr_slope over 14 days), and warranty/AMC
 * status. Reads the Phase 1-3 telemetry tables. */

const RISING_BAD = ['thd_i', 'thd_v', 'temp']; // metrics where an upward trend signals degradation

function scoreDevice(d, slopesByMetric) {
  const drivers = [];
  const add = (points, factor) => { if (points > 0) drivers.push({ factor, points: Math.round(points) }); };

  if (d.critical_open > 0) add(40, `${d.critical_open} critical alert(s) open`);
  add(Math.min(d.open_alerts - d.critical_open, 2) * 10, 'unresolved warnings');
  if (d.connection_state === 'offline') add(25, 'device offline');
  else if (d.connection_state === 'stale') add(12, 'telemetry stale');
  else if (d.connection_state === 'never') add(5, 'never reported');
  add(Math.min(d.alerts_30d, 4) * 5, `${d.alerts_30d} alert(s) in last 30 days`);

  // Upward trend in a degradation metric — scale the per-day slope relative to
  // the metric's own magnitude, cap the contribution at 20.
  let trend = null;
  for (const m of RISING_BAD) {
    const s = slopesByMetric.get(`${d.id}:${m}`);
    if (!s || !(s.slopePerDay > 0) || !s.latest) continue;
    const pctPerDay = (s.slopePerDay / Math.abs(s.latest)) * 100;
    const pts = Math.min(pctPerDay * 4, 20);
    if (pts >= 1 && (!trend || pts > trend.pts)) trend = { metric: m, pts, pctPerDay, ...s };
  }
  if (trend) add(trend.pts, `${trend.metric} rising ~${trend.pctPerDay.toFixed(1)}%/day`);

  if (d.warranty_status && d.warranty_status !== 'active') add(10, `warranty ${d.warranty_status}`);
  if (!d.amc_status || d.amc_status === 'none') add(5, 'no AMC cover');

  const score = Math.min(100, drivers.reduce((s, x) => s + x.points, 0));
  const band = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
  drivers.sort((a, b) => b.points - a.points);

  const recommendation =
    d.critical_open > 0        ? 'Dispatch a service engineer — critical condition active'
    : d.connection_state === 'offline' ? 'Check site connectivity / power — device is dark'
    : trend                    ? `Schedule an inspection — ${trend.metric} trending up`
    : band === 'medium'        ? 'Monitor closely; review at next AMC visit'
    : 'No action needed';

  return { score, band, drivers, recommendation, trend: trend ? { metric: trend.metric, slope_per_day: trend.slopePerDay } : null };
}

async function loadSlopes(cid, equipmentId = null) {
  const params = [cid, RISING_BAD];
  let where = `ts > NOW() - INTERVAL '14 days' AND metric = ANY($2) AND ($1::int IS NULL OR company_id = $1)`;
  if (equipmentId != null) { params.push(equipmentId); where += ` AND equipment_id = $3`; }
  const { rows } = await pool.query(`
    SELECT equipment_id, metric,
           regr_slope(value, EXTRACT(EPOCH FROM ts)) AS slope_per_sec,
           COUNT(*) AS n,
           (ARRAY_AGG(value ORDER BY ts DESC))[1] AS latest
      FROM device_telemetry
     WHERE ${where}
     GROUP BY equipment_id, metric
    HAVING COUNT(*) >= 5`, params);
  const map = new Map();
  for (const r of rows) {
    map.set(`${r.equipment_id}:${r.metric}`, {
      slopePerDay: Number(r.slope_per_sec) * 86400,
      latest: Number(r.latest),
      n: Number(r.n),
    });
  }
  return map;
}

async function loadDevices(cid, equipmentId = null) {
  const params = [cid];
  let extra = '';
  if (equipmentId != null) { params.push(equipmentId); extra = ` AND ce.id = $2`; }
  const { rows } = await pool.query(`
    SELECT ce.id, ce.equipment_name, ce.model_number, ce.serial_number,
           ce.connection_state, ce.last_seen_at, ce.warranty_status, ce.amc_status,
           COALESCE(oa.open_alerts, 0)::int   AS open_alerts,
           COALESCE(oa.critical_open, 0)::int AS critical_open,
           COALESCE(r30.alerts_30d, 0)::int   AS alerts_30d
      FROM customer_equipment ce
      LEFT JOIN (SELECT equipment_id, COUNT(*) AS open_alerts,
                        COUNT(*) FILTER (WHERE severity = 'critical') AS critical_open
                   FROM device_alerts WHERE state <> 'resolved' GROUP BY equipment_id) oa ON oa.equipment_id = ce.id
      LEFT JOIN (SELECT equipment_id, COUNT(*) AS alerts_30d
                   FROM device_alerts WHERE opened_at > NOW() - INTERVAL '30 days' GROUP BY equipment_id) r30 ON r30.equipment_id = ce.id
     WHERE ce.device_uid IS NOT NULL AND ($1::int IS NULL OR ce.company_id = $1)${extra}`, params);
  return rows;
}

/* ─── GET /api/ai/predict/device-failure — fleet risk ranking ──────────────────*/
router.get('/predict/device-failure', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const [devices, slopes] = await Promise.all([loadDevices(cid), loadSlopes(cid)]);
    const scored = devices
      .map((d) => {
        const r = scoreDevice(d, slopes);
        return {
          equipment_id: d.id, equipment_name: d.equipment_name, model_number: d.model_number,
          connection_state: d.connection_state, open_alerts: d.open_alerts,
          risk_score: r.score, risk_band: r.band, top_driver: r.drivers[0]?.factor || null,
          recommendation: r.recommendation,
        };
      })
      .sort((a, b) => b.risk_score - a.risk_score);
    const summary = {
      total: scored.length,
      high: scored.filter((s) => s.risk_band === 'high').length,
      medium: scored.filter((s) => s.risk_band === 'medium').length,
    };
    res.json({ success: true, summary, data: scored });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── GET /api/ai/predict/device-failure/:id — one device, with drivers ────────*/
router.get('/predict/device-failure/:id', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const [devices, slopes] = await Promise.all([
      loadDevices(cid, req.params.id), loadSlopes(cid, req.params.id),
    ]);
    if (!devices.length) return res.status(404).json({ error: 'device not found' });
    const d = devices[0];
    const r = scoreDevice(d, slopes);

    // Per-metric trend + projected time to cross a configured threshold, if any.
    const { rows: rules } = await pool.query(
      `SELECT metric, threshold FROM device_alert_rules
        WHERE is_active = TRUE AND operator IN ('>','>=') AND threshold IS NOT NULL
          AND (equipment_id = $1 OR equipment_id IS NULL)
          AND ($2::int IS NULL OR company_id = $2)`,
      [d.id, cid]);
    const threshBy = new Map(rules.map((x) => [x.metric, Number(x.threshold)]));
    const trends = RISING_BAD.map((m) => {
      const s = slopes.get(`${d.id}:${m}`);
      if (!s) return null;
      const thr = threshBy.get(m);
      const daysToThreshold = (thr != null && s.slopePerDay > 0 && s.latest < thr)
        ? Math.round((thr - s.latest) / s.slopePerDay) : null;
      return { metric: m, latest: s.latest, slope_per_day: Number(s.slopePerDay.toFixed(4)), threshold: thr ?? null, days_to_threshold: daysToThreshold };
    }).filter(Boolean);

    res.json({ success: true, data: {
      equipment_id: d.id, equipment_name: d.equipment_name,
      risk_score: r.score, risk_band: r.band, recommendation: r.recommendation,
      drivers: r.drivers, trends,
    } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── Lead / opportunity prioritization (Automation Opportunity Audit §27.2) ────
 * Same transparent driver-based scoring spirit as scoreDevice() above — no ML,
 * every point traces to a live column: expected revenue (value × probability),
 * pipeline stage, closing-date urgency, days since last touched, and whether a
 * next step is even defined. CRM has pipeline data but no "work these first"
 * ranking today; this is that ranking. */

const STAGE_WEIGHT = { negotiation: 20, proposal: 15, qualification: 8, prospecting: 3 };

function scoreOpportunity(o, now) {
  const drivers = [];
  const add = (points, factor) => { if (points > 0) drivers.push({ factor, points: Math.round(points) }); };

  const expectedRevenue = (parseFloat(o.expected_value) || 0) * (parseInt(o.probability_percentage) || 0) / 100;
  if (expectedRevenue > 500000) add(25, `₹${(expectedRevenue / 100000).toFixed(1)}L expected revenue`);
  else if (expectedRevenue > 150000) add(15, `₹${(expectedRevenue / 100000).toFixed(1)}L expected revenue`);
  else if (expectedRevenue > 0) add(8, `₹${(expectedRevenue / 100000).toFixed(1)}L expected revenue`);

  const stageWeight = STAGE_WEIGHT[(o.stage || '').toLowerCase()] || 0;
  if (stageWeight) add(stageWeight, `${o.stage} stage`);

  if (o.expected_closing_date) {
    const daysToClose = Math.floor((new Date(o.expected_closing_date) - now) / 86400000);
    if (daysToClose < 0) add(Math.min(30, 15 + Math.min(-daysToClose, 60) / 4), `closing date passed ${-daysToClose}d ago`);
    else if (daysToClose <= 14) add(20, `closing in ${daysToClose}d`);
  }

  const daysSinceUpdate = Math.floor((now - new Date(o.updated_at)) / 86400000);
  const neverTouched = new Date(o.updated_at).getTime() === new Date(o.created_at).getTime();
  if (neverTouched && daysSinceUpdate > 14) add(15, `no activity in ${daysSinceUpdate}d — never updated since creation`);
  else if (daysSinceUpdate > 30) add(10, `no activity in ${daysSinceUpdate}d`);

  if (!o.next_step) add(10, 'no next step defined');

  const score = Math.min(100, drivers.reduce((s, x) => s + x.points, 0));
  const band = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
  drivers.sort((a, b) => b.points - a.points);

  const top = drivers[0]?.factor || '';
  const recommendation =
    top.startsWith('closing date passed') ? 'Re-engage immediately — closing date has passed with no update'
    : top.startsWith('no activity')       ? 'Log a follow-up — this deal has gone stale'
    : top.startsWith('closing in')        ? 'Prioritize this week — closing date approaching'
    : band === 'high'                     ? 'High-value deal — prioritize outreach'
    : 'Monitor at next pipeline review';

  return { score, band, drivers, recommendation };
}

/* ─── GET /api/ai/predict/lead-priority — ranked "work these first" queue ──────*/
router.get('/predict/lead-priority', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { rows } = await pool.query(`
      SELECT id, opportunity_name, stage, expected_value, probability_percentage,
             expected_closing_date, assigned_to, created_at, updated_at, next_step
      FROM opportunities
      WHERE deleted_at IS NULL
        AND LOWER(stage) NOT IN ('closed_won', 'closed_lost')
        AND ($1::int IS NULL OR company_id = $1)
    `, [cid]);

    const now = new Date();
    const scored = rows
      .map((o) => {
        const r = scoreOpportunity(o, now);
        return {
          opportunity_id: o.id, opportunity_name: o.opportunity_name, stage: o.stage,
          expected_value: parseFloat(o.expected_value) || 0,
          probability_percentage: o.probability_percentage,
          expected_closing_date: o.expected_closing_date, assigned_to: o.assigned_to,
          priority_score: r.score, priority_band: r.band,
          top_driver: r.drivers[0]?.factor || null, recommendation: r.recommendation,
          drivers: r.drivers,
        };
      })
      .sort((a, b) => b.priority_score - a.priority_score);

    const summary = {
      total: scored.length,
      high: scored.filter((s) => s.priority_band === 'high').length,
      medium: scored.filter((s) => s.priority_band === 'medium').length,
    };
    res.json({ success: true, summary, data: scored });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── GET /api/ai/predict/project-health/:id — one-paragraph project health ────
 * Automation Opportunity Audit §27.2. Deliberately self-contained off `projects`'
 * own always-populated columns (see projectHealthNarrator.js header) rather than
 * project_cost_summary (empty) or project360.routes.js's engine (3 of ~28 source
 * queries reference tables that don't exist). Same driver-based risk score as
 * scoreDevice()/scoreOpportunity() above, plus a GPT-optional/rule-based
 * narrative on top, same discipline as ceo-insights. */
router.get('/predict/project-health/:id', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { rows } = await pool.query(
      `SELECT id, project_name, status, budget_amount, budget, actual_cost,
              progress_percentage, start_date, end_date
       FROM projects
       WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'project not found' });
    const project = rows[0];

    const scoreResult = scoreProjectHealth(project);
    const { reply, source } = await narrateProjectHealth(project, scoreResult);

    res.json({ success: true, data: {
      project_id: project.id, project_name: project.project_name,
      risk_score: scoreResult.score, risk_band: scoreResult.band,
      drivers: scoreResult.drivers, narrative: reply, narrative_source: source,
    } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── Quality defect-rate prediction (Automation Opportunity Audit §27.2) ──────
 * "This batch's defect rate is trending toward the NCR threshold before it's
 * inspected." Same transparent driver-based convention as scoreDevice() above:
 * every point traces to a live quality_tests/production_orders signal — the
 * fail rate of tests already recorded on an open batch, scrap rate so far, and
 * how this item's fail rate compares to its own historical baseline across
 * completed batches. No NCR-per-batch driver here — ncr_reports.reference_id
 * is a loosely-typed polymorphic column with no reliable production_order
 * linkage in this codebase (confirmed live: every existing row has it NULL),
 * so a join on it would be an unverifiable assumption, not a real signal.
 *
 * Note: quality_tests is empty in this pilot's dev DB (module unused so far),
 * so this correctly returns zero risk rows today — the query itself was
 * verified separately against synthetic data (see manual writeup) since real
 * data can't exercise it yet. */

function scoreBatchDefectRisk(b) {
  const drivers = [];
  const add = (points, factor) => { if (points > 0) drivers.push({ factor, points: Math.round(points) }); };

  const testsTotal = parseInt(b.tests_total) || 0;
  const testsFailed = parseInt(b.tests_failed) || 0;
  if (testsTotal > 0) {
    const failRate = testsFailed / testsTotal;
    if (failRate > 0.5) add(40, `${Math.round(failRate * 100)}% of tests so far have failed`);
    else if (failRate > 0.25) add(25, `${Math.round(failRate * 100)}% of tests so far have failed`);
    else if (failRate > 0.1) add(12, `${Math.round(failRate * 100)}% of tests so far have failed`);
  }

  const planned = parseFloat(b.quantity_planned) || 0;
  const scrapped = parseFloat(b.quantity_scrapped) || 0;
  if (planned > 0 && scrapped > 0) {
    const scrapRate = scrapped / planned;
    if (scrapRate > 0.2) add(20, `${Math.round(scrapRate * 100)}% scrap rate so far`);
    else if (scrapRate > 0.05) add(10, `${Math.round(scrapRate * 100)}% scrap rate so far`);
  }

  const histTotal = parseInt(b.hist_tests_total) || 0;
  const histFailed = parseInt(b.hist_tests_failed) || 0;
  if (histTotal >= 3) {
    const histFailRate = histFailed / histTotal;
    if (histFailRate > 0.3) add(15, `${b.product_name} has a ${Math.round(histFailRate * 100)}% historical fail rate across past batches`);
  }

  const score = Math.min(100, drivers.reduce((s, x) => s + x.points, 0));
  const band = score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low';
  drivers.sort((a, b2) => b2.points - a.points);
  return { score, band, drivers };
}

/* ─── GET /api/ai/predict/quality-risk — open-batch defect risk ranking ────────*/
router.get('/predict/quality-risk', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { rows } = await pool.query(`
      WITH open_batches AS (
        SELECT po.id, po.production_order_no, po.product_name,
               po.quantity_planned, po.quantity_scrapped,
               COUNT(qt.id) FILTER (WHERE qt.result IN ('pass', 'fail')) AS tests_total,
               COUNT(qt.id) FILTER (WHERE qt.result = 'fail')            AS tests_failed
        FROM production_orders po
        LEFT JOIN quality_tests qt ON qt.production_order_id = po.id
        WHERE po.status NOT IN ('completed', 'cancelled')
          AND ($1::int IS NULL OR po.company_id = $1)
        GROUP BY po.id, po.production_order_no, po.product_name, po.quantity_planned, po.quantity_scrapped
      ),
      item_history AS (
        SELECT po.product_name,
               COUNT(qt.id) FILTER (WHERE qt.result IN ('pass', 'fail')) AS hist_tests_total,
               COUNT(qt.id) FILTER (WHERE qt.result = 'fail')            AS hist_tests_failed
        FROM quality_tests qt
        JOIN production_orders po ON po.id = qt.production_order_id
        WHERE po.status = 'completed'
          AND ($1::int IS NULL OR po.company_id = $1)
        GROUP BY po.product_name
      )
      SELECT ob.*, ih.hist_tests_total, ih.hist_tests_failed
      FROM open_batches ob
      LEFT JOIN item_history ih ON ih.product_name = ob.product_name
    `, [cid]);

    const scored = rows
      .map((b) => {
        const r = scoreBatchDefectRisk(b);
        return {
          production_order_id: b.id, production_order_no: b.production_order_no,
          product_name: b.product_name, tests_total: parseInt(b.tests_total) || 0,
          tests_failed: parseInt(b.tests_failed) || 0,
          risk_score: r.score, risk_band: r.band,
          top_driver: r.drivers[0]?.factor || null, drivers: r.drivers,
        };
      })
      .filter((b) => b.risk_score > 0)
      .sort((a, b) => b.risk_score - a.risk_score);

    const summary = {
      total_open_batches: rows.length,
      flagged: scored.length,
      high: scored.filter((s) => s.risk_band === 'high').length,
      medium: scored.filter((s) => s.risk_band === 'medium').length,
    };
    res.json({ success: true, summary, data: scored });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── GET /api/ai/predict/ticket-summary/:id — Service Desk handoff summary ────
 * Automation Opportunity Audit §27.2. See ticketThreadNarrator.js header for
 * why the rule-based fallback surfaces the real thread rather than attempting
 * to compress it. */
router.get('/predict/ticket-summary/:id', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { rows: ticketRows } = await pool.query(
      `SELECT id, ticket_number, title, description, priority, status,
              sla_breached, created_at, resolved_at
       FROM support_tickets
       WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]
    );
    if (!ticketRows.length) return res.status(404).json({ error: 'ticket not found' });
    const ticket = ticketRows[0];

    const { rows: comments } = await pool.query(
      `SELECT id, author, body, is_internal, created_at
       FROM ticket_comments
       WHERE ticket_id = $1
       ORDER BY created_at ASC`,
      [ticket.id]
    );

    const { reply, source } = await narrateTicketThread(ticket, comments);

    res.json({ success: true, data: {
      ticket_id: ticket.id, ticket_number: ticket.ticket_number,
      comment_count: comments.length, summary: reply, summary_source: source,
    } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── GET /api/ai/prescriptive ──────────────────────────────────────────────── */
// Generates ranked, DB-grounded prescriptive recommendations.
// Never invents data — each rec is derived from a live query result.
router.get('/prescriptive', async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  const recs = [];

  await Promise.allSettled([

    // 1. Inventory stockouts
    pool.query(`
      SELECT name, current_stock, reorder_point
      FROM inventory_items
      WHERE current_stock <= reorder_point
        AND ($1::int IS NULL OR company_id = $1)
      ORDER BY current_stock::float / NULLIF(reorder_point,0) ASC
      LIMIT 5
    `, [cid]).then(({ rows }) => {
      if (!rows.length) return;
      recs.push({
        category: 'Inventory', iconKey: 'package', priority: 'high',
        action: `Reorder ${rows.length} item(s) at or below reorder point`,
        rationale: rows.map(r => `${r.name} (${r.current_stock}/${r.reorder_point})`).join(', '),
        impact: 'Prevent production stoppages and lost sales',
      });
    }),

    // 2. Overdue receivables
    pool.query(`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount),0) AS total
      FROM invoices
      WHERE status NOT IN ('paid','Paid','cancelled','Cancelled')
        AND due_date < CURRENT_DATE
        AND ($1::int IS NULL OR company_id = $1)
    `, [cid]).then(({ rows }) => {
      const cnt = parseInt(rows[0]?.cnt || 0);
      if (!cnt) return;
      const amt = parseFloat(rows[0]?.total || 0);
      recs.push({
        category: 'Finance', iconKey: 'dollar', priority: cnt > 5 ? 'high' : 'medium',
        action: `Follow up on ${cnt} overdue invoice(s)`,
        rationale: `₹${(amt / 100000).toFixed(2)}L in overdue receivables pending collection`,
        impact: 'Improve cash flow and reduce bad debt exposure',
      });
    }),

    // 3. Revenue decline vs prior month
    pool.query(`
      SELECT
        SUM(CASE WHEN invoice_date >= DATE_TRUNC('month', CURRENT_DATE) THEN total_amount ELSE 0 END) AS curr,
        SUM(CASE WHEN invoice_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
                  AND invoice_date < DATE_TRUNC('month', CURRENT_DATE) THEN total_amount ELSE 0 END) AS prev
      FROM invoices
      WHERE invoice_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
        AND ($1::int IS NULL OR company_id = $1)
    `, [cid]).then(({ rows }) => {
      const curr = parseFloat(rows[0]?.curr || 0);
      const prev = parseFloat(rows[0]?.prev || 0);
      if (!prev || curr >= prev * 0.9) return;
      const pct = Math.round((1 - curr / prev) * 100);
      recs.push({
        category: 'Revenue', iconKey: 'trending', priority: pct > 20 ? 'high' : 'medium',
        action: `Investigate ${pct}% revenue decline vs last month`,
        rationale: `Current month ₹${(curr / 100000).toFixed(1)}L vs prior ₹${(prev / 100000).toFixed(1)}L`,
        impact: 'Identify and reverse negative revenue trend before quarter-end',
      });
    }),

    // 4. High attrition risk departments
    pool.query(`
      SELECT department,
        COUNT(*) FILTER (WHERE date_of_joining >= NOW() - INTERVAL '2 years') AS at_risk,
        COUNT(*) AS total
      FROM employees
      WHERE status = 'active'
        AND ($1::int IS NULL OR company_id = $1)
      GROUP BY department
      HAVING COUNT(*) FILTER (WHERE date_of_joining >= NOW() - INTERVAL '2 years')::float / NULLIF(COUNT(*),0) > 0.5
         AND COUNT(*) >= 3
      ORDER BY at_risk DESC
      LIMIT 3
    `, [cid]).then(({ rows }) => {
      if (!rows.length) return;
      recs.push({
        category: 'HR', iconKey: 'users', priority: 'medium',
        action: `Review retention for ${rows.map(r => r.department).join(', ')}`,
        rationale: `>50% of employees in these departments have <2 years tenure (higher flight risk)`,
        impact: 'Reduce recruitment and ramp-up costs (~3–6x salary per replacement)',
      });
    }),

    // 5. Stale pending leave approvals
    pool.query(`
      SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest
      FROM leave_requests WHERE status = 'pending'
    `).then(({ rows }) => {
      const cnt = parseInt(rows[0]?.cnt || 0);
      if (!cnt) return;
      const ageDays = rows[0]?.oldest
        ? Math.floor((Date.now() - new Date(rows[0].oldest)) / 86400000) : 0;
      recs.push({
        category: 'HR', iconKey: 'calendar', priority: ageDays > 3 ? 'high' : 'medium',
        action: `Process ${cnt} pending leave request(s)`,
        rationale: `Oldest pending request is ${ageDays} day(s) old`,
        impact: 'Maintain compliance and employee satisfaction',
      });
    }),

    // 6. Pending purchase orders (cash exposure)
    pool.query(`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount),0) AS total
      FROM purchase_orders
      WHERE status IN ('pending','draft','approved')
    `).then(({ rows }) => {
      const cnt = parseInt(rows[0]?.cnt || 0);
      if (cnt < 3) return;
      const amt = parseFloat(rows[0]?.total || 0);
      recs.push({
        category: 'Finance', iconKey: 'dollar', priority: 'medium',
        action: `Review ${cnt} open purchase order(s) for cash planning`,
        rationale: `₹${(amt / 100000).toFixed(2)}L in committed but unprocessed spend`,
        impact: 'Improve procurement visibility and cash flow forecasting',
      });
    }),

    // 7. Sales — customer accounts flagged by health score (churn risk)
    getSalesDashboard(cid).then((d) => {
      const atRisk = d?.at_risk || [];
      const needsAttention = d?.needs_attention || [];
      const flagged = [...atRisk, ...needsAttention];
      if (!flagged.length) return;
      const names = flagged.slice(0, 5).map(c => c.customer_name).filter(Boolean).join(', ');
      recs.push({
        category: 'Sales', iconKey: 'users', priority: atRisk.length ? 'high' : 'medium',
        action: `Review ${flagged.length} customer account(s) flagged by health score`,
        rationale: `${atRisk.length} critical, ${needsAttention.length} watchlist — ${names}`,
        impact: 'Prevent churn and protect renewal revenue',
      });
    }),

    // 8. Service — customers with critical open escalations
    getServiceDashboard(cid).then((d) => {
      const esc = d?.open_escalations || [];
      if (!esc.length) return;
      const names = esc.slice(0, 5).map(c => c.customer_name).filter(Boolean).join(', ');
      recs.push({
        category: 'Service', iconKey: 'alert', priority: 'high',
        action: `Resolve critical escalations for ${esc.length} customer(s)`,
        rationale: `Open critical ticket(s) at: ${names}`,
        impact: 'Prevent SLA breaches and customer churn',
      });
    }),

    // 9. Procurement — vendors with a history of late delivery who currently
    // have open PO(s), i.e. forward-looking delay risk rather than a PO
    // that's already overdue (deliveryFollowup.cron.js already covers that).
    // "Expected" delivery falls back to order_date + vendor.lead_time_days
    // when a PO never got an explicit expected_delivery_date (common in this
    // pilot's data) — the same lead-time field the EOQ Planner already uses,
    // not a new assumption.
    pool.query(`
      WITH po_expected AS (
        SELECT po.id, po.supplier_id, po.status,
          COALESCE(po.expected_delivery_date, po.order_date + (v.lead_time_days || ' days')::interval) AS implied_expected_date
        FROM purchase_orders po
        JOIN vendors v ON v.id = po.supplier_id
        WHERE po.deleted_at IS NULL AND ($1::int IS NULL OR po.company_id = $1)
      ),
      vendor_history AS (
        SELECT pe.supplier_id AS vendor_id,
          COUNT(*) AS delivered_pos,
          COUNT(*) FILTER (WHERE grn.received_date::date > pe.implied_expected_date::date) AS late_pos
        FROM po_expected pe
        JOIN goods_receipt_notes grn ON grn.po_id = pe.id AND grn.deleted_at IS NULL
        GROUP BY pe.supplier_id
        HAVING COUNT(*) >= 2
      ),
      open_at_risk AS (
        SELECT pe.supplier_id, COUNT(*) AS open_pos
        FROM po_expected pe
        WHERE pe.status NOT IN ('received', 'cancelled')
        GROUP BY pe.supplier_id
      )
      SELECT v.vendor_name, vh.delivered_pos, vh.late_pos,
        ROUND(vh.late_pos::numeric / vh.delivered_pos * 100) AS late_pct,
        oar.open_pos
      FROM vendor_history vh
      JOIN vendors v ON v.id = vh.vendor_id
      JOIN open_at_risk oar ON oar.supplier_id = vh.vendor_id
      WHERE (vh.late_pos::numeric / vh.delivered_pos) >= 0.34
      ORDER BY late_pct DESC
      LIMIT 5
    `, [cid]).then(({ rows }) => {
      if (!rows.length) return;
      const openTotal = rows.reduce((s, r) => s + parseInt(r.open_pos), 0);
      const names = rows.map(r => `${r.vendor_name} (${r.late_pct}% late historically)`).join(', ');
      recs.push({
        category: 'Procurement', iconKey: 'truck', priority: 'medium',
        action: `Plan buffer time for ${openTotal} open PO(s) with high-delay-risk vendors`,
        rationale: names,
        impact: 'Avoid production/project delays caused by vendors with a track record of late delivery',
      });
    }),
  ]);

  // Sort: high → medium → low
  const order = { high: 0, medium: 1, low: 2 };
  recs.sort((a, b) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2));

  res.json({ success: true, data: recs });
});

export default router;
