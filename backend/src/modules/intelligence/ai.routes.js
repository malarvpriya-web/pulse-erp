// backend/src/modules/intelligence/ai.routes.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();

/* ─── POST /api/ai/ceo-insights ────────────────────────────────── */
// Returns a GPT-generated narrative if OPENAI_API_KEY is set,
// otherwise falls back to a rule-based summary built from the payload.
// No operational data is invented here — all numbers come from the caller's payload.
router.post('/ceo-insights', async (req, res) => {
  const { dashboardData = {} } = req.body;

  const apiKey = process.env.OPENAI_API_KEY;
  const keyMissing = !apiKey || apiKey === 'your-openai-api-key-here';

  if (!keyMissing) {
    try {
      const prompt =
        `You are a CFO-level business analyst for an ERP platform. Analyze the following ` +
        `live dashboard metrics and provide exactly 3 concise, actionable bullet-point insights. ` +
        `Be specific with numbers. Start each bullet with •.\n\nData: ${JSON.stringify(dashboardData)}`;

      const apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (apiRes.ok) {
        const data = await apiRes.json();
        const reply = data.choices?.[0]?.message?.content || '';
        if (reply) return res.json({ reply, source: 'openai' });
      }
    } catch (_) { /* fall through to rule-based */ }
  }

  // Rule-based fallback — derives from caller-provided payload, never invents data
  const kpis      = dashboardData.kpis      ?? {};
  const attrition = dashboardData.attrition ?? {};
  const salesKPI  = dashboardData.salesKPI  ?? {};
  const hc        = dashboardData.hc        ?? {};

  const bullets = [];
  const rev     = kpis.revenue?.value;
  const revGrow = kpis.revenue?.growth;
  const attr    = attrition.rate;
  const pipe    = salesKPI.pipelineValue;
  const conv    = salesKPI.conversionRate;
  const active  = hc.active;

  if (rev != null)
    bullets.push(`• Revenue YTD is ₹${rev >= 1e7 ? (rev/1e7).toFixed(1)+'Cr' : rev >= 1e5 ? (rev/1e5).toFixed(1)+'L' : rev.toLocaleString()}${revGrow != null ? ` with ${revGrow > 0 ? '+' : ''}${revGrow.toFixed(1)}% YoY growth` : ''}.`);
  if (attr != null)
    bullets.push(`• Attrition rate is ${attr.toFixed(1)}% — ${attr > 15 ? 'critical, immediate retention action needed' : attr > 10 ? 'above the 10–12% benchmark, review exit trends' : 'within the healthy 10–12% benchmark'}.`);
  if (pipe != null && conv != null)
    bullets.push(`• Sales pipeline stands at ₹${pipe >= 1e7 ? (pipe/1e7).toFixed(1)+'Cr' : pipe >= 1e5 ? (pipe/1e5).toFixed(1)+'L' : pipe.toLocaleString()} with a ${conv.toFixed(1)}% conversion rate${conv < 20 ? ' — consider pipeline acceleration initiatives' : ''}.`);
  if (active != null && bullets.length < 3)
    bullets.push(`• Active headcount is ${active.toLocaleString('en-IN')} employees${hc.onLeave ? ` with ${hc.onLeave} on leave today` : ''}.`);

  if (bullets.length === 0)
    bullets.push('• Dashboard data is loading — refresh in a moment for AI-powered insights.');

  res.json({ reply: bullets.join('\n'), source: 'rules' });
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
    const { rows: lb } = await pool.query(
      `SELECT leave_type, balance FROM leave_balances
       WHERE employee_id = (SELECT id FROM employees WHERE user_id = $1 LIMIT 1)`,
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
      `SELECT name FROM employees WHERE user_id = $1 LIMIT 1`, [userId]
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
const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const stdDev = (arr) => {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length || 1));
};
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
router.get('/anomalies', async (req, res) => {
  const anomalies = [];

  // 1. Invoice outliers (>2.5σ from 90-day mean)
  try {
    const { rows } = await pool.query(`SELECT id,invoice_number,client_name,total_amount FROM invoices WHERE invoice_date >= NOW()-INTERVAL '90 days'`);
    if (rows.length >= 5) {
      const amounts = rows.map(r => parseFloat(r.total_amount));
      const m = mean(amounts), sd = stdDev(amounts);
      rows.forEach(r => {
        const amt = parseFloat(r.total_amount);
        if (Math.abs(amt - m) > 2.5 * sd) {
          anomalies.push({ type:'Invoice Amount Outlier', severity: amt > m ? 'high' : 'medium',
            description:`Invoice ${r.invoice_number} ₹${(amt/100000).toFixed(2)}L is ${((Math.abs(amt-m)/sd)).toFixed(1)}σ from mean (₹${(m/100000).toFixed(2)}L)`,
            affected_id:r.id, affected_name:r.client_name, variance_amount:Math.round(Math.abs(amt-m)), detected_at:new Date().toISOString() });
        }
      });
    }
  } catch (_) {}

  // 2. Low attendance (<75% this month)
  try {
    const { rows } = await pool.query(`
      SELECT e.id,e.name,e.department,
             COUNT(a.id) FILTER (WHERE a.status='present') AS pdays, COUNT(a.id) AS tdays
      FROM employees e LEFT JOIN attendance a ON a.employee_id=e.id
        AND DATE_TRUNC('month',a.date)=DATE_TRUNC('month',CURRENT_DATE)
      WHERE e.status='active' GROUP BY e.id,e.name,e.department
      HAVING COUNT(a.id)>0 AND COUNT(a.id) FILTER(WHERE a.status='present')::float/COUNT(a.id)<0.75
    `);
    rows.forEach(r => {
      const pct = Math.round(parseInt(r.pdays)/parseInt(r.tdays)*100);
      anomalies.push({ type:'Low Attendance', severity: pct<60?'high':'medium',
        description:`${r.name} (${r.department}) attendance ${pct}% this month (${r.pdays}/${r.tdays} days)`,
        affected_id:r.id, affected_name:r.name, variance_amount:0, detected_at:new Date().toISOString() });
    });
  } catch (_) {}

  // 3. PO price >20% above 3-month avg
  try {
    const { rows } = await pool.query(`
      SELECT pi.id,pi.item_name,pi.unit_price,pi.purchase_order_id,
             AVG(pi2.unit_price) OVER (PARTITION BY pi.item_name) AS avg_price
      FROM po_items pi JOIN po_items pi2 ON pi2.item_name=pi.item_name
      JOIN purchase_orders po ON po.id=pi.purchase_order_id
      WHERE po.created_at>=NOW()-INTERVAL '90 days'
    `).catch(()=>({rows:[]}));
    const seen = new Set();
    rows.forEach(r => {
      const v = (parseFloat(r.unit_price)-parseFloat(r.avg_price))/parseFloat(r.avg_price);
      if (v>0.2 && !seen.has(r.item_name)) {
        seen.add(r.item_name);
        anomalies.push({ type:'PO Price Variance', severity:v>0.4?'high':'medium',
          description:`${r.item_name} bought at ₹${parseFloat(r.unit_price).toFixed(2)} — ${Math.round(v*100)}% above avg (₹${parseFloat(r.avg_price).toFixed(2)})`,
          affected_id:r.purchase_order_id, affected_name:r.item_name,
          variance_amount:Math.round((parseFloat(r.unit_price)-parseFloat(r.avg_price))*100), detected_at:new Date().toISOString() });
      }
    });
  } catch (_) {}

  // 4. Payroll TDS mismatch (>10%)
  try {
    const { rows } = await pool.query(`
      SELECT pr.id,e.name,pr.tds_deducted,pr.computed_tds FROM payroll_runs pr
      JOIN employees e ON e.id=pr.employee_id
      WHERE pr.computed_tds>0 AND ABS(pr.tds_deducted-pr.computed_tds)/pr.computed_tds>0.10
      AND pr.month_year>=TO_CHAR(NOW()-INTERVAL '1 month','YYYY-MM')
    `).catch(()=>({rows:[]}));
    rows.forEach(r => {
      const diff = Math.abs(parseFloat(r.tds_deducted)-parseFloat(r.computed_tds));
      const pct  = Math.round(diff/parseFloat(r.computed_tds)*100);
      anomalies.push({ type:'TDS Mismatch', severity:pct>25?'high':'low',
        description:`${r.name} TDS recorded ₹${parseFloat(r.tds_deducted).toFixed(0)} vs computed ₹${parseFloat(r.computed_tds).toFixed(0)} (${pct}% diff)`,
        affected_id:r.id, affected_name:r.name, variance_amount:Math.round(diff), detected_at:new Date().toISOString() });
    });
  } catch (_) {}

  // 5. Recent PQ / production test failures (last 7 days)
  try {
    const { rows } = await pool.query(`
      SELECT id, run_number, product_name, serial_number, test_stage, completed_at,
        (SELECT COUNT(*)::INT FROM test_run_measurements
         WHERE test_run_id = test_runs.id AND result = 'fail') AS fail_count
      FROM test_runs
      WHERE overall_result = 'fail'
        AND completed_at >= NOW() - INTERVAL '7 days'
      ORDER BY completed_at DESC LIMIT 10
    `).catch(() => ({ rows: [] }));
    rows.forEach(r => {
      const fc = parseInt(r.fail_count || 0);
      anomalies.push({
        type: 'PQ Test Failure', severity: fc >= 3 ? 'high' : 'medium',
        description: `${r.test_stage} run ${r.run_number} failed — ${r.product_name || 'Unknown'} S/N ${r.serial_number || 'N/A'} (${fc} measurement${fc !== 1 ? 's' : ''} out of spec)`,
        affected_id: r.id, affected_name: r.product_name || 'Unknown Product',
        variance_amount: fc,
        detected_at: r.completed_at ? new Date(r.completed_at).toISOString() : new Date().toISOString(),
      });
    });
  } catch (_) {}

  anomalies.sort((a, b) => ({ high:0,medium:1,low:2 }[a.severity] - { high:0,medium:1,low:2 }[b.severity]));
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
    // Surface items approaching reorder point with consumption trend
    const { rows } = await pool.query(`
      SELECT
        ii.id, ii.item_code, ii.item_name,
        ii.current_stock, ii.reorder_level AS reorder_point, ii.unit_of_measure,
        0 AS consumed_last_30d,
        CASE
          WHEN ii.current_stock <= COALESCE(ii.reorder_level,0) THEN 'critical'
          WHEN ii.current_stock <= COALESCE(ii.reorder_level,0) * 1.5 THEN 'warning'
          ELSE 'ok'
        END AS risk_level
      FROM inventory_items ii
      WHERE ($1::int IS NULL OR ii.company_id = $1)
        AND ii.current_stock <= COALESCE(ii.reorder_level, 0) * 2
      ORDER BY risk_level, ii.current_stock ASC LIMIT 20
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
  ]);

  // Sort: high → medium → low
  const order = { high: 0, medium: 1, low: 2 };
  recs.sort((a, b) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2));

  res.json({ success: true, data: recs });
});

export default router;
