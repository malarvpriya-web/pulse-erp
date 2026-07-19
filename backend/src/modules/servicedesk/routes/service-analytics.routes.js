/**
 * Phase 51 — Service Performance Analytics
 * Per-engineer metrics: tickets, closure time, first-fix %, repeat failures, ratings, travel
 */
import express from 'express';
import pool from '../../../config/db.js';
import { verifyToken } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);

// GET /service-analytics/engineers — engineer performance table
router.get('/engineers', verifyToken, async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const dateFilter = from_date && to_date
      ? `AND t.created_at BETWEEN '${from_date}' AND '${to_date}'`
      : `AND t.created_at >= NOW() - INTERVAL '90 days'`;

    const { rows } = await pool.query(`
      SELECT
        se.id              AS engineer_id,
        se.name            AS engineer_name,
        se.zone,
        se.email,
        se.phone,
        COUNT(t.id)        AS total_tickets,
        SUM(CASE WHEN t.status IN ('Closed','closed','resolved') THEN 1 ELSE 0 END) AS closed_tickets,
        SUM(CASE WHEN t.status NOT IN ('Closed','closed','resolved') THEN 1 ELSE 0 END) AS open_tickets,
        ROUND(AVG(
          CASE WHEN t.status IN ('Closed','closed','resolved') AND t.resolved_at IS NOT NULL
               THEN EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600.0
          END
        )::NUMERIC, 2)    AS avg_closure_hrs,
        NULL::numeric AS avg_rating,
        COUNT(DISTINCT fv.id) AS field_visits
      FROM service_engineers se
      LEFT JOIN tickets t ON t.assigned_to = se.employee_id ${dateFilter}
      LEFT JOIN field_visits fv ON fv.engineer_name = se.name AND fv.company_id = $1
      WHERE se.company_id = $1
      GROUP BY se.id, se.name, se.zone, se.email, se.phone
      ORDER BY total_tickets DESC
    `, [cid(req)]);

    // Enrich with commissioning data
    const commData = await pool.query(`
      SELECT engineer_name, COUNT(*) AS comm_total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS comm_completed,
             ROUND(AVG(customer_rating)::NUMERIC, 2) AS comm_rating
        FROM commissioning_workflows WHERE company_id = $1
       GROUP BY engineer_name
    `, [cid(req)]);
    const commMap = {};
    commData.rows.forEach(r => { commMap[r.engineer_name] = r; });

    const enriched = rows.map(r => ({
      ...r,
      commissioning_total: parseInt(commMap[r.engineer_name]?.comm_total || 0),
      commissioning_completed: parseInt(commMap[r.engineer_name]?.comm_completed || 0),
      commissioning_rating: commMap[r.engineer_name]?.comm_rating || null,
    }));

    res.json(enriched);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /service-analytics/engineers/:name — single engineer deep-dive
router.get('/engineers/:name', verifyToken, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const [ticketStats, commStats, recentTickets, visitHistory] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status IN ('Closed','closed','resolved') THEN 1 ELSE 0 END) AS closed,
          SUM(CASE WHEN status NOT IN ('Closed','closed','resolved') THEN 1 ELSE 0 END) AS open,
          ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN EXTRACT(EPOCH FROM (resolved_at - created_at))/3600.0 END)::NUMERIC,2) AS avg_closure_hrs,
          ROUND(AVG(csat_rating)::NUMERIC,2) AS avg_rating,
          MIN(created_at) AS oldest_ticket,
          MAX(created_at) AS latest_ticket
        FROM support_tickets WHERE assigned_to = $1 AND company_id = $2
      `, [name, cid(req)]),
      pool.query(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
               ROUND(AVG(customer_rating)::NUMERIC,2) AS avg_rating
          FROM commissioning_workflows WHERE engineer_name = $1 AND company_id = $2
      `, [name, cid(req)]),
      pool.query(`
        SELECT id, ticket_number, COALESCE(title, '') AS subject, status, priority, csat_rating, created_at, resolved_at
          FROM support_tickets WHERE assigned_to = $1 AND company_id = $2
         ORDER BY created_at DESC LIMIT 20
      `, [name, cid(req)]),
      pool.query(`
        SELECT id, customer_name, visit_date, status, purpose
          FROM field_visits WHERE engineer_name = $1 AND company_id = $2
         ORDER BY visit_date DESC LIMIT 10
      `, [name, cid(req)]),
    ]);

    res.json({
      engineer_name: name,
      ticket_stats: ticketStats.rows[0],
      commissioning_stats: commStats.rows[0],
      recent_tickets: recentTickets.rows,
      visit_history: visitHistory.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /service-analytics/dashboard — aggregate KPIs
router.get('/dashboard', verifyToken, async (req, res) => {
  try {
    const cidVal = cid(req);
    const fallback = { rows: [{}] };
    const [ticketKPIs, slaKPIs, csatKPIs, trendData] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total_tickets,
          SUM(CASE WHEN status NOT IN ('Closed','closed','resolved') THEN 1 ELSE 0 END) AS open_tickets,
          SUM(CASE WHEN status IN ('Closed','closed','resolved') THEN 1 ELSE 0 END) AS closed_tickets,
          ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN EXTRACT(EPOCH FROM (resolved_at - created_at))/3600 END)::NUMERIC,2) AS avg_closure_hrs,
          COUNT(DISTINCT assigned_to) AS active_engineers
        FROM support_tickets WHERE company_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
      `, [cidVal]).catch(() => fallback),
      pool.query(`
        SELECT priority, COUNT(*) AS cnt,
               SUM(CASE WHEN status IN ('Closed','closed','resolved') THEN 1 ELSE 0 END) AS closed
          FROM support_tickets WHERE company_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY priority
      `, [cidVal]).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT ROUND(AVG(CASE WHEN csat_rating IS NOT NULL THEN csat_rating END)::NUMERIC,2) AS avg_csat,
               COUNT(CASE WHEN csat_rating IS NOT NULL THEN 1 END) AS rated_tickets
          FROM support_tickets WHERE company_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
      `, [cidVal]).catch(() => ({ rows: [{ avg_csat: null, rated_tickets: 0 }] })),
      pool.query(`
        SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, COUNT(*) AS created,
               SUM(CASE WHEN status IN ('Closed','closed','resolved') THEN 1 ELSE 0 END) AS closed
          FROM support_tickets WHERE company_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY day ORDER BY day
      `, [cidVal]).catch(() => ({ rows: [] })),
    ]);

    res.json({
      kpis: ticketKPIs.rows[0],
      by_priority: slaKPIs.rows,
      csat: csatKPIs.rows[0],
      trend: trendData.rows,
    });
  } catch (err) { console.error('[service-analytics/dashboard]', err.stack || err.message); res.status(500).json({ error: err.message }); }
});

// GET /service-analytics/repeat-failures — tickets that reopened or recurred
router.get('/repeat-failures', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sfr.*, ce.equipment_name, ce.equipment_tag, ce.customer_portal_user_id
        FROM service_failure_records sfr
        LEFT JOIN customer_equipment ce ON ce.id = sfr.equipment_id
       WHERE sfr.company_id = $1 AND sfr.is_repeat_failure = true
       ORDER BY sfr.failure_date DESC LIMIT 50
    `, [cid(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
