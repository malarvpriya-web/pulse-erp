// backend/src/modules/sales/routes/commission.routes.js
import { Router } from 'express';
import pool from '../../../config/db.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf } from '../../../shared/scope.js';

const router = Router();

// ── GET /stats — KPI cards ────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const cid = companyOf(req);
    const now = new Date();
    const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const fyStart = `${fyYear}-04-01`; // Indian FY: Apr–Mar, corrected for Jan–Mar

    const [earnedR, pendingR, paidR, plansR] = await Promise.allSettled([
      pool.query(
        `SELECT COALESCE(SUM(commission_amount),0) AS total
         FROM commission_entries
         WHERE company_id=$1 AND status != 'clawback'
           AND earned_date >= $2`,
        [cid, fyStart]
      ),
      pool.query(
        `SELECT COALESCE(SUM(commission_amount),0) AS total
         FROM commission_entries
         WHERE company_id=$1 AND status='pending'`,
        [cid]
      ),
      pool.query(
        `SELECT COALESCE(SUM(net_payout),0) AS total
         FROM commission_payouts
         WHERE company_id=$1 AND status='paid'
           AND payment_date >= $2`,
        [cid, fyStart]
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM commission_plans
         WHERE company_id=$1 AND is_active=true`,
        [cid]
      ),
    ]);

    res.json({
      total_earned:   earnedR.status  === 'fulfilled' ? parseFloat(earnedR.value.rows[0].total)  : 0,
      pending_payout: pendingR.status === 'fulfilled' ? parseFloat(pendingR.value.rows[0].total) : 0,
      paid_ytd:       paidR.status    === 'fulfilled' ? parseFloat(paidR.value.rows[0].total)    : 0,
      active_plans:   plansR.status   === 'fulfilled' ? parseInt(plansR.value.rows[0].total)     : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /plans ────────────────────────────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const cid = companyOf(req);
    const result = await pool.query(
      `SELECT * FROM commission_plans
       WHERE company_id=$1
       ORDER BY is_active DESC, created_at DESC`,
      [cid]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /plans ───────────────────────────────────────────────────────────────
router.post('/plans', async (req, res) => {
  try {
    const cid = companyOf(req);
    const {
      name, rep_id, rep_name, plan_type, base_rate_pct,
      tiered_slabs, applies_to, product_ids,
      effective_from, effective_to, clawback_period_days,
    } = req.body;
    const result = await pool.query(
      `INSERT INTO commission_plans
         (company_id, name, rep_id, rep_name, plan_type, base_rate_pct,
          tiered_slabs, applies_to, product_ids,
          effective_from, effective_to, clawback_period_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        cid, name, rep_id || null, rep_name || null,
        plan_type || 'percentage', base_rate_pct || 0,
        JSON.stringify(tiered_slabs || []),
        applies_to || 'all_products',
        JSON.stringify(product_ids || []),
        effective_from || null, effective_to || null,
        clawback_period_days || 30,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /plans/:id ────────────────────────────────────────────────────────────
router.put('/plans/:id', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { id } = req.params;
    const {
      name, rep_id, rep_name, plan_type, base_rate_pct,
      tiered_slabs, applies_to, product_ids,
      effective_from, effective_to, clawback_period_days, is_active,
    } = req.body;
    const result = await pool.query(
      `UPDATE commission_plans SET
         name=COALESCE($1,name),
         rep_id=COALESCE($2,rep_id),
         rep_name=COALESCE($3,rep_name),
         plan_type=COALESCE($4,plan_type),
         base_rate_pct=COALESCE($5,base_rate_pct),
         tiered_slabs=COALESCE($6,tiered_slabs),
         applies_to=COALESCE($7,applies_to),
         product_ids=COALESCE($8,product_ids),
         effective_from=COALESCE($9,effective_from),
         effective_to=COALESCE($10,effective_to),
         clawback_period_days=COALESCE($11,clawback_period_days),
         is_active=COALESCE($12,is_active)
       WHERE id=$13 AND company_id=$14 RETURNING *`,
      [
        name, rep_id, rep_name, plan_type, base_rate_pct,
        tiered_slabs ? JSON.stringify(tiered_slabs) : null,
        applies_to,
        product_ids ? JSON.stringify(product_ids) : null,
        effective_from, effective_to, clawback_period_days, is_active,
        id, cid,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /plans/:id/assign ────────────────────────────────────────────────────
router.post('/plans/:id/assign', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { id } = req.params;
    const { rep_id, rep_name } = req.body;
    const result = await pool.query(
      `UPDATE commission_plans SET rep_id=$1, rep_name=$2
       WHERE id=$3 AND company_id=$4 RETURNING *`,
      [rep_id, rep_name, id, cid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /plans/:id ─────────────────────────────────────────────────────────
router.delete('/plans/:id', async (req, res) => {
  try {
    const cid = companyOf(req);
    await pool.query(
      `UPDATE commission_plans SET is_active=false
       WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /entries ──────────────────────────────────────────────────────────────
router.get('/entries', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rep_id, status, month } = req.query;
    let query = `SELECT * FROM commission_entries WHERE company_id=$1`;
    const params = [cid];
    let idx = 2;
    if (rep_id) { query += ` AND rep_id=$${idx++}`; params.push(rep_id); }
    if (status) { query += ` AND status=$${idx++}`; params.push(status); }
    if (month)  { query += ` AND TO_CHAR(earned_date,'YYYY-MM')=$${idx++}`; params.push(month); }
    query += ` ORDER BY created_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /compute — calculate commission for a single order ──────────────────
router.post('/compute', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { order_id, rep_id, rep_name, sale_amount, order_ref, customer_name } = req.body;

    const planResult = await pool.query(
      `SELECT * FROM commission_plans
       WHERE company_id=$1 AND rep_id=$2 AND is_active=true
         AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
       ORDER BY created_at DESC LIMIT 1`,
      [cid, rep_id]
    );
    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'No active commission plan found for rep' });
    }
    const plan = planResult.rows[0];
    let commissionRate = parseFloat(plan.base_rate_pct) || 0;
    let breakdown = { plan_type: plan.plan_type, rate_applied: commissionRate };

    if (plan.plan_type === 'tiered' && plan.tiered_slabs?.length > 0) {
      const ytdResult = await pool.query(
        `SELECT COALESCE(SUM(sale_amount),0) AS ytd_revenue
         FROM commission_entries
         WHERE company_id=$1 AND rep_id=$2
           AND EXTRACT(YEAR FROM earned_date)=EXTRACT(YEAR FROM CURRENT_DATE)
           AND status!='clawback'`,
        [cid, rep_id]
      );
      const ytdRevenue = parseFloat(ytdResult.rows[0].ytd_revenue);
      const totalRevenue = ytdRevenue + parseFloat(sale_amount);
      for (const slab of plan.tiered_slabs) {
        if (totalRevenue >= slab.min_revenue && (!slab.max_revenue || totalRevenue <= slab.max_revenue)) {
          commissionRate = parseFloat(slab.rate_pct);
          breakdown = { ...breakdown, ytd_revenue: ytdRevenue, slab_applied: slab };
          break;
        }
      }
    } else if (plan.plan_type === 'flat') {
      const commissionAmount = parseFloat(plan.base_rate_pct) || 0;
      const entry = await pool.query(
        `INSERT INTO commission_entries
           (company_id, plan_id, rep_id, rep_name, order_id, order_ref,
            customer_name, sale_amount, commission_rate, commission_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9) RETURNING *`,
        [cid, plan.id, rep_id, rep_name, order_id, order_ref, customer_name, sale_amount, commissionAmount]
      );
      return res.json({ entry: entry.rows[0], breakdown: { plan_type: 'flat', fixed_amount: commissionAmount } });
    }

    const commissionAmount = (parseFloat(sale_amount) * commissionRate) / 100;
    const entry = await pool.query(
      `INSERT INTO commission_entries
         (company_id, plan_id, rep_id, rep_name, order_id, order_ref,
          customer_name, sale_amount, commission_rate, commission_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [cid, plan.id, rep_id, rep_name, order_id, order_ref, customer_name, sale_amount, commissionRate, commissionAmount]
    );
    res.json({ entry: entry.rows[0], breakdown });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /compute-all-pending ─────────────────────────────────────────────────
router.post('/compute-all-pending', (_req, res) => {
  res.status(501).json({ error: 'Use POST /commissions/compute with a specific order.' });
});

// ── POST /entries/:id/clawback ────────────────────────────────────────────────
router.post('/entries/:id/clawback', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { clawback_reason } = req.body;
    const entry = await pool.query(
      `UPDATE commission_entries SET status='clawback', clawback_reason=$1
       WHERE id=$2 AND company_id=$3 RETURNING *`,
      [clawback_reason, req.params.id, cid]
    );
    if (entry.rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
    await pool.query(
      `UPDATE commission_payouts
       SET deductions = deductions + $1,
           net_payout = GREATEST(0, total_commission - (deductions + $1))
       WHERE company_id=$2 AND rep_id=$3 AND status='draft'
         AND period_from <= CURRENT_DATE AND period_to >= CURRENT_DATE`,
      [entry.rows[0].commission_amount, cid, entry.rows[0].rep_id]
    );
    res.json(entry.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /payouts ──────────────────────────────────────────────────────────────
router.get('/payouts', async (req, res) => {
  try {
    const cid = companyOf(req);
    const result = await pool.query(
      `SELECT * FROM commission_payouts
       WHERE company_id=$1 ORDER BY created_at DESC`,
      [cid]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /payouts ─────────────────────────────────────────────────────────────
router.post('/payouts', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rep_id, period_from, period_to } = req.body;
    const repNameRow = await pool.query(
      `SELECT rep_name FROM commission_plans
       WHERE company_id=$1 AND rep_id=$2 LIMIT 1`,
      [cid, rep_id]
    );
    const name = repNameRow.rows.length > 0 ? repNameRow.rows[0].rep_name : `Rep ${rep_id}`;
    const totals = await pool.query(
      `SELECT COALESCE(SUM(commission_amount),0) AS total
       FROM commission_entries
       WHERE company_id=$1 AND rep_id=$2 AND status IN ('approved','pending')
         AND earned_date BETWEEN $3 AND $4`,
      [cid, rep_id, period_from, period_to]
    );
    const totalCommission = parseFloat(totals.rows[0].total);
    const deductionsResult = await pool.query(
      `SELECT COALESCE(SUM(commission_amount), 0) AS total_deductions
       FROM commission_entries
       WHERE company_id=$1 AND rep_id=$2 AND status='clawback'
         AND earned_date BETWEEN $3 AND $4`,
      [cid, rep_id, period_from, period_to]
    );
    const totalDeductions = parseFloat(deductionsResult.rows[0].total_deductions);
    const netPayout = Math.max(0, totalCommission - totalDeductions);
    const result = await pool.query(
      `INSERT INTO commission_payouts
         (company_id, rep_id, rep_name, period_from, period_to, total_commission, deductions, net_payout)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cid, rep_id, name, period_from, period_to, totalCommission, totalDeductions, netPayout]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /payouts/:id ──────────────────────────────────────────────────────────
router.put('/payouts/:id', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { id } = req.params;
    const { status, payment_date, remarks } = req.body;
    const result = await pool.query(
      `UPDATE commission_payouts
       SET status=COALESCE($1,status),
           payment_date=COALESCE($2,payment_date),
           remarks=COALESCE($3,remarks)
       WHERE id=$4 AND company_id=$5 RETURNING *`,
      [status, payment_date, remarks, id, cid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /payouts/:id/approve ─────────────────────────────────────────────────
router.post('/payouts/:id/approve', async (req, res) => {
  try {
    const cid = companyOf(req);
    const userId = req.user?.userId ?? req.user?.id;
    const result = await pool.query(
      `UPDATE commission_payouts SET status='approved'
       WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id, cid]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Payout not found' });
    logAudit({ userId, module: 'Sales', recordId: parseInt(req.params.id), recordType: 'commission_payout', action: 'approve', newData: { status: 'approved' }, req });
    import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
      notifyWorkflowEvent('approved', { module: 'Commission', recordId: parseInt(req.params.id), submitterId: userId, recipientIds: result.rows[0].rep_id ? [result.rows[0].rep_id] : [] }).catch(() => {});
    }).catch(() => {});
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /statements/:repId ────────────────────────────────────────────────────
router.get('/statements/:repId', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { repId } = req.params;
    const [planR, ytdR, entriesR] = await Promise.allSettled([
      pool.query(
        `SELECT * FROM commission_plans
         WHERE company_id=$1 AND rep_id=$2 AND is_active=true
         ORDER BY created_at DESC LIMIT 1`,
        [cid, repId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(commission_amount),0) AS ytd
         FROM commission_entries
         WHERE company_id=$1 AND rep_id=$2
           AND EXTRACT(YEAR FROM earned_date)=EXTRACT(YEAR FROM CURRENT_DATE)
           AND status!='clawback'`,
        [cid, repId]
      ),
      pool.query(
        `SELECT * FROM commission_entries
         WHERE company_id=$1 AND rep_id=$2
         ORDER BY earned_date DESC`,
        [cid, repId]
      ),
    ]);

    if (planR.status !== 'fulfilled' || planR.value.rows.length === 0) {
      return res.status(404).json({ error: 'No active commission plan found for this rep.' });
    }
    const plan = planR.value.rows[0];
    const ytdTotal = ytdR.status === 'fulfilled' ? parseFloat(ytdR.value.rows[0].ytd) : 0;
    const entries = entriesR.status === 'fulfilled' ? entriesR.value.rows : [];
    const clawbacks = entries.filter(e => e.status === 'clawback');
    const pendingAmount = entries
      .filter(e => e.status === 'pending')
      .reduce((s, e) => s + parseFloat(e.commission_amount), 0);

    const year = new Date().getFullYear();
    const monthlyEarnings = Array.from({ length: 12 }, (_, i) => {
      const month = new Date(year, i, 1).toLocaleString('default', { month: 'short' });
      const amount = entries
        .filter(e => new Date(e.earned_date).getMonth() === i && e.status !== 'clawback')
        .reduce((s, e) => s + parseFloat(e.commission_amount), 0);
      return { month, amount };
    });

    res.json({
      rep_name: plan.rep_name,
      plan,
      ytd_total: ytdTotal,
      pending_amount: pendingAmount,
      monthly_earnings: monthlyEarnings,
      entries,
      clawbacks,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /leaderboard ──────────────────────────────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  try {
    const cid = companyOf(req);
    const result = await pool.query(
      `SELECT rep_id, rep_name,
         SUM(sale_amount)       AS achieved_amount,
         SUM(commission_amount) AS commission_earned,
         COUNT(*)               AS deal_count
       FROM commission_entries
       WHERE company_id=$1 AND status != 'clawback'
         AND EXTRACT(YEAR FROM earned_date)=EXTRACT(YEAR FROM CURRENT_DATE)
       GROUP BY rep_id, rep_name
       ORDER BY commission_earned DESC
       LIMIT 10`,
      [cid]
    );
    res.json(result.rows.map((r, i) => ({
      rank:              i + 1,
      rep_name:          r.rep_name,
      rep_id:            r.rep_id,
      achieved_amount:   parseFloat(r.achieved_amount),
      commission_earned: parseFloat(r.commission_earned),
      deal_count:        parseInt(r.deal_count),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
