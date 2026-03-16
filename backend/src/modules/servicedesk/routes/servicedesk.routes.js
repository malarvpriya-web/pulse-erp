import express from 'express';
import pool from '../../../config/db.js';

const router = express.Router();

// ── helpers ────────────────────────────────────────────────────────────────────
const safe = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
};

// ── stats ──────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*)                                                      AS total,
        COUNT(*) FILTER (WHERE status = 'Open')                       AS open,
        COUNT(*) FILTER (WHERE status = 'In Progress')                AS in_progress,
        COUNT(*) FILTER (WHERE status = 'Resolved')                   AS resolved,
        COUNT(*) FILTER (WHERE priority = 'High' AND status != 'Resolved') AS high_priority,
        COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())) AS this_month,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS this_week,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE status = 'Resolved') /
          NULLIF(COUNT(*), 0), 1
        )                                                              AS resolution_rate
      FROM support_tickets
    `);

    const byCategory = await pool.query(`
      SELECT category, COUNT(*) AS count
      FROM support_tickets
      GROUP BY category ORDER BY count DESC
    `);

    const byPriority = await pool.query(`
      SELECT priority, COUNT(*) AS count
      FROM support_tickets
      GROUP BY priority
      ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END
    `);

    const byTeam = await pool.query(`
      SELECT team, COUNT(*) AS count,
             COUNT(*) FILTER (WHERE status = 'Open') AS open
      FROM support_tickets
      WHERE team IS NOT NULL
      GROUP BY team ORDER BY count DESC
    `);

    const recent = await pool.query(`
      SELECT * FROM support_tickets
      ORDER BY created_at DESC LIMIT 5
    `);

    const row = stats.rows[0] || {};
    res.json({
      total        : parseInt(row.total         || 0),
      open         : parseInt(row.open          || 0),
      inProgress   : parseInt(row.in_progress   || 0),
      resolved     : parseInt(row.resolved      || 0),
      highPriority : parseInt(row.high_priority || 0),
      thisMonth    : parseInt(row.this_month    || 0),
      thisWeek     : parseInt(row.this_week     || 0),
      resolutionRate: parseFloat(row.resolution_rate || 0),
      byCategory   : byCategory.rows,
      byPriority   : byPriority.rows,
      byTeam       : byTeam.rows,
      recent       : recent.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── list all tickets ────────────────────────────────────────────────────────────
router.get('/tickets', async (req, res) => {
  try {
    const { status, priority, category, team, search, limit = 50, offset = 0 } = req.query;
    let q = `SELECT * FROM support_tickets WHERE 1=1`;
    const params = [];

    if (status)   { params.push(status);   q += ` AND status = $${params.length}`; }
    if (priority) { params.push(priority); q += ` AND priority = $${params.length}`; }
    if (category) { params.push(category); q += ` AND category = $${params.length}`; }
    if (team)     { params.push(team);     q += ` AND team = $${params.length}`; }
    if (search)   { params.push(`%${search}%`); q += ` AND (title ILIKE $${params.length} OR ticket_number ILIKE $${params.length} OR requester_name ILIKE $${params.length})`; }

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    q += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(q, params);

    const countQ = q.replace(/SELECT \*/, 'SELECT COUNT(*)').replace(/ORDER BY.*$/, '').replace(/LIMIT \$\d+ OFFSET \$\d+/, '');
    const count  = await pool.query(countQ, params.slice(0, -2)).catch(() => ({ rows: [{ count: 0 }] }));

    res.json({ tickets: result.rows, total: parseInt(count.rows[0]?.count || 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── my tickets ─────────────────────────────────────────────────────────────────
router.get('/tickets/my', async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email) return res.json({ tickets: [] });
    const result = await pool.query(
      `SELECT * FROM support_tickets WHERE requester_email = $1 ORDER BY created_at DESC`,
      [email]
    );
    res.json({ tickets: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── single ticket ───────────────────────────────────────────────────────────────
router.get('/tickets/:id', async (req, res) => {
  try {
    const ticket = await pool.query(
      `SELECT * FROM support_tickets WHERE id = $1`, [req.params.id]
    );
    if (!ticket.rows[0]) return res.status(404).json({ error: 'Ticket not found' });

    const comments = await pool.query(
      `SELECT * FROM ticket_comments WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({ ...ticket.rows[0], comments: comments.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── create ticket ───────────────────────────────────────────────────────────────
router.post('/tickets', async (req, res) => {
  try {
    const { title, description, category, priority, team, requester_name, requester_email } = req.body;
    const countRes = await pool.query(`SELECT COUNT(*) FROM support_tickets`);
    const num = parseInt(countRes.rows[0].count) + 1;
    const ticket_number = `TKT-${String(num).padStart(4, '0')}`;

    const result = await pool.query(
      `INSERT INTO support_tickets (ticket_number, title, description, category, priority, status, team, requester_name, requester_email)
       VALUES ($1,$2,$3,$4,$5,'Open',$6,$7,$8) RETURNING *`,
      [ticket_number, title, description, category, priority||'Medium', team, requester_name, requester_email]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── update ticket ───────────────────────────────────────────────────────────────
router.put('/tickets/:id', async (req, res) => {
  try {
    const { title, description, status, priority, category, team, assigned_to } = req.body;
    const resolved_at = status === 'Resolved' ? 'NOW()' : 'resolved_at';
    const result = await pool.query(
      `UPDATE support_tickets
       SET title=$1, description=$2, status=$3, priority=$4, category=$5, team=$6,
           assigned_to=$7, resolved_at=CASE WHEN $3='Resolved' THEN NOW() ELSE resolved_at END,
           updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [title, description, status, priority, category, team, assigned_to, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── add comment ─────────────────────────────────────────────────────────────────
router.post('/tickets/:id/comments', async (req, res) => {
  try {
    const { body, is_internal } = req.body;
    const author = req.user?.name || req.user?.email || 'Agent';
    const result = await pool.query(
      `INSERT INTO ticket_comments (ticket_id, author, body, is_internal) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, author, body, is_internal || false]
    );
    // Also update ticket updated_at
    await pool.query(`UPDATE support_tickets SET updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── filter options (categories, teams, priorities) ─────────────────────────────
router.get('/filters', async (req, res) => {
  try {
    const cats   = await safe(`SELECT DISTINCT category FROM support_tickets WHERE category IS NOT NULL ORDER BY category`);
    const teams  = await safe(`SELECT DISTINCT team FROM support_tickets WHERE team IS NOT NULL ORDER BY team`);
    res.json({
      categories : cats.map(r => r.category),
      teams      : teams.map(r => r.team),
      priorities : ['Low', 'Medium', 'High', 'Critical'],
      statuses   : ['Open', 'In Progress', 'Pending', 'Resolved', 'Closed'],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
