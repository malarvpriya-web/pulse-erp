import pool from '../config/db.js';

// Auto-calculates and records commission for the salesperson on a confirmed order.
// Called fire-and-forget from the order-confirm endpoint — never throws.
export async function calculateCommission(orderId, companyId) {
  try {
    const orderRes = await pool.query(
      `SELECT order_number, customer_name, total_amount,
              salesperson_id, salesperson_name
       FROM sales_orders
       WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [orderId, companyId]
    );
    if (!orderRes.rows.length) return;
    const o = orderRes.rows[0];
    if (!o.salesperson_id) return;

    // Find the active commission plan assigned to this salesperson
    const planRes = await pool.query(
      `SELECT * FROM commission_plans
       WHERE company_id = $1
         AND rep_id = $2
         AND is_active = true
         AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
       ORDER BY created_at DESC
       LIMIT 1`,
      [companyId, o.salesperson_id]
    );
    if (!planRes.rows.length) return;
    const plan = planRes.rows[0];

    const saleAmount = parseFloat(o.total_amount) || 0;
    let commissionRate   = parseFloat(plan.base_rate_pct) || 0;
    let commissionAmount = 0;

    if (plan.plan_type === 'flat') {
      commissionAmount = commissionRate; // flat amount stored in base_rate_pct
      commissionRate   = 0;
    } else if (plan.plan_type === 'tiered' && Array.isArray(plan.tiered_slabs) && plan.tiered_slabs.length) {
      const ytdRes = await pool.query(
        `SELECT COALESCE(SUM(sale_amount), 0) AS ytd
         FROM commission_entries
         WHERE company_id = $1 AND rep_id = $2
           AND EXTRACT(YEAR FROM earned_date) = EXTRACT(YEAR FROM CURRENT_DATE)
           AND status != 'clawback'`,
        [companyId, o.salesperson_id]
      );
      const ytd   = parseFloat(ytdRes.rows[0].ytd);
      const total = ytd + saleAmount;
      for (const slab of plan.tiered_slabs) {
        if (total >= slab.min_revenue && (!slab.max_revenue || total <= slab.max_revenue)) {
          commissionRate = parseFloat(slab.rate_pct) || 0;
          break;
        }
      }
      commissionAmount = (saleAmount * commissionRate) / 100;
    } else {
      // percentage (default)
      commissionAmount = (saleAmount * commissionRate) / 100;
    }

    // Avoid double-entry: skip if an entry for this order already exists
    const existing = await pool.query(
      `SELECT id FROM commission_entries WHERE company_id = $1 AND order_id = $2 LIMIT 1`,
      [companyId, orderId]
    );
    if (existing.rows.length) return;

    await pool.query(
      `INSERT INTO commission_entries
         (company_id, plan_id, rep_id, rep_name, order_id, order_ref,
          customer_name, sale_amount, commission_rate, commission_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        companyId, plan.id, o.salesperson_id, o.salesperson_name,
        orderId, o.order_number, o.customer_name,
        saleAmount, commissionRate, commissionAmount,
      ]
    );
  } catch {
    // Non-fatal — commission failure must never block order confirmation
  }
}
